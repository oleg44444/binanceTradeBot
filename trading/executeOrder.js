const config = require('../config/config');
const telegram = require('../utils/telegramNotifier');
const stateStore = require('../utils/stateStore');
const binanceClientPromise = require('../utils/binanceClient');

let binance;
let onPositionClosed = null;

const tradingInterface = {
  executeOrder: null,
  getAccountBalance: null,
  closePosition: null,
  getActivePosition: null,
  syncPositionWithExchange: null,
  setPositionClosedHandler: null
};

let activePosition = {
  id: null,
  type: null,
  totalAmount: 0,
  entryPrice: 0,
  stopLoss: 0,
  takeProfit: 0,
  trailingStopDistance: 0,
  trailingActivationDistance: 0,
  trailingActivated: false,
  trailingInterval: null,
  highestPrice: 0,
  lowestPrice: 0,
  openedAt: 0
};

// Прапорці, щоб синхронізація/трейлінг не заважали відкриттю, закриттю та оновленню ордерів
let isOpeningPosition = false;
let isClosingPosition = false;
let syncInProgress = false;
let safetyOrdersBusy = false;
let safetyOrdersDirty = false;
let syncMonitorInterval = null;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── Helpers ────────────────────────────────────────────────────────────────

function validateActivePosition() {
  return !!(activePosition.id &&
    activePosition.totalAmount > 0 &&
    activePosition.entryPrice > 0);
}

function generatePositionId() {
  return `POS_${Date.now()}`;
}

async function safeExchangeCall(fn) {
  try {
    return await fn();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('🔴 API Error:', msg);
    throw error;
  }
}

/**
 * ccxt повертає символ у вигляді 'ETH/USDT:USDT', а в конфігу 'ETHUSDT'.
 * Шукаємо позицію по info.symbol (id біржі) або по нормалізованому символу.
 */
function findPosition(positions) {
  if (!Array.isArray(positions)) return null;
  const clean = config.symbol.replace('/', '');
  return positions.find(p => {
    const idMatch = p.info?.symbol === clean;
    const normalized = String(p.symbol || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
    const symbolMatch = normalized === clean || normalized === clean + 'USDT';
    return (idMatch || symbolMatch) && Math.abs(Number(p.contracts)) > 0;
  }) || null;
}

async function checkExchangeConnection() {
  if (!binance) return false;
  try {
    await safeExchangeCall(() => binance.fetchTime());
    return true;
  } catch {
    return false;
  }
}

// ─── Balance ────────────────────────────────────────────────────────────────

let accountBalance = 0;

async function getCurrentBalanceSafe() {
  try {
    const balance = await safeExchangeCall(() => binance.fetchBalance());
    const usdt = balance.total?.USDT || balance.USDT?.total ||
                 balance.free?.USDT  || balance.USDT?.free  || 0;
    accountBalance = Number(usdt) || 0;
    return accountBalance;
  } catch {
    return accountBalance;
  }
}

async function initAccountBalance() {
  accountBalance = await getCurrentBalanceSafe();
  console.log(`💰 Ініціалізовано баланс: ${accountBalance} USDT`);
  return accountBalance;
}

// ─── Збереження стану ───────────────────────────────────────────────────────

function persistPosition() {
  if (!validateActivePosition()) {
    stateStore.write('position', null);
    return;
  }
  const { trailingInterval, ...rest } = activePosition;
  stateStore.write('position', rest);
}

/** Колбек, який викликається після закриття позиції: ({ pnl, snapshot, reason, exitPrice }) */
function setPositionClosedHandler(fn) {
  onPositionClosed = fn;
}

// ─── Orders ─────────────────────────────────────────────────────────────────

/**
 * Скасовує всі відкриті ордери по символу, включно з умовними (SL/TP).
 * Після міграції Binance умовні ордери (STOP_MARKET / TAKE_PROFIT_MARKET)
 * живуть окремо від звичайних, тому скасовуємо обидва типи.
 */
async function cancelPositionOrders() {
  if (!binance || !config.symbol) return;

  const attempts = [
    { label: 'звичайні', fn: () => binance.cancelAllOrders(config.symbol) },
    { label: 'умовні',   fn: () => binance.cancelAllOrders(config.symbol, { trigger: true, stop: true }) }
  ];

  let cancelled = false;
  for (const { label, fn } of attempts) {
    try {
      await fn();
      cancelled = true;
    } catch (error) {
      const msg = error?.message || String(error);
      // "No open orders" / "Unknown order" — це нормально
      if (!/no open orders|unknown order|-2011/i.test(msg)) {
        console.warn(`⚠️ Не вдалося скасувати ${label} ордери: ${msg}`);
      }
    }
  }

  if (!cancelled) console.log('ℹ️ Немає відкритих ордерів');
}

/**
 * Створює один умовний ордер закриття (SL або TP) через ccxt.
 * ccxt сам підписує запит, використовує правильний хост (mainnet/testnet)
 * та правильний ендпоінт Binance для умовних ордерів.
 */
async function placeProtectiveOrder(kind, closeSide, qty, triggerPrice) {
  const amount = binance.amountToPrecision(config.symbol, qty);
  const price  = binance.priceToPrecision(config.symbol, triggerPrice);
  const side   = closeSide.toLowerCase();

  const baseParams = { reduceOnly: true, workingType: 'MARK_PRICE' };
  const unifiedParams = kind === 'SL'
    ? { ...baseParams, stopLossPrice: price }
    : { ...baseParams, takeProfitPrice: price };

  try {
    return await safeExchangeCall(() =>
      binance.createOrder(config.symbol, 'market', side, amount, undefined, unifiedParams)
    );
  } catch (error) {
    // Запасний варіант: явний тип ордера
    console.warn(`⚠️ ${kind}: уніфікований запит не пройшов (${error.message}), пробуємо явний тип...`);
    const type = kind === 'SL' ? 'STOP_MARKET' : 'TAKE_PROFIT_MARKET';
    return await safeExchangeCall(() =>
      binance.createOrder(config.symbol, type, side, amount, undefined, {
        ...baseParams,
        stopPrice: price
      })
    );
  }
}

/**
 * Створення/оновлення Stop-Loss та Take-Profit ордерів.
 */
async function updateSafetyOrders() {
  if (!validateActivePosition()) return;

  // Не запускаємо два оновлення одночасно (трейлінг тікає кожні 5 сек)
  if (safetyOrdersBusy) {
    safetyOrdersDirty = true;
    return;
  }
  safetyOrdersBusy = true;

  try {
    do {
      safetyOrdersDirty = false;
      await runSafetyOrdersUpdate();
    } while (safetyOrdersDirty && validateActivePosition());
  } finally {
    safetyOrdersBusy = false;
  }
}

async function runSafetyOrdersUpdate() {
  const MAX_RETRIES = 2;

  const placeOrders = async () => {
    try {
      await cancelPositionOrders();

      const isBuy     = activePosition.type === 'buy';
      const closeSide = isBuy ? 'SELL' : 'BUY';
      const qty       = activePosition.totalAmount;

      console.log('🛡️ Створюємо ордери безпеки:');
      console.log(`   SL: ${activePosition.stopLoss.toFixed(4)}`);
      console.log(`   TP: ${activePosition.takeProfit.toFixed(4)}`);

      await placeProtectiveOrder('TP', closeSide, qty, activePosition.takeProfit);
      console.log(`✅ TP ордер створено: ${activePosition.takeProfit.toFixed(4)}`);

      await placeProtectiveOrder('SL', closeSide, qty, activePosition.stopLoss);
      console.log(`✅ SL ордер створено: ${activePosition.stopLoss.toFixed(4)}`);

      telegram.sendMessage(
        `📍 TP/SL оновлено:\nSL: ${activePosition.stopLoss.toFixed(4)}\nTP: ${activePosition.takeProfit.toFixed(4)}`,
        false
      );

      return true;
    } catch (error) {
      console.error(`🔴 Помилка створення ордерів TP/SL (спроба ${attempt + 1}):`, error.message);
      lastSafetyError = error;
      return false;
    }
  };

  let attempt = 0;
  let lastSafetyError = null;
  let success = await placeOrders();
  attempt++;

  while (!success && attempt <= MAX_RETRIES) {
    console.log('🔄 Повторна спроба через 5 секунд...');
    await sleep(5000);
    success = await placeOrders();
    attempt++;
  }

  if (!success) {
    console.error('⛔ Не вдалося створити TP/SL після повторів. Перевірте API-ключі, права та IP-whitelist.');
    telegram.sendMessage(
      `⛔ Не вдалося виставити TP/SL на біржі (${config.symbol})!\n` +
      `Позиція може бути без захисту.\n` +
      `Причина: ${lastSafetyError?.message || 'невідомо'}`,
      false
    );
  }
}

// ─── Trailing Stop ──────────────────────────────────────────────────────────

async function updateTrailingStop() {
  if (!validateActivePosition()) return;

  try {
    const ticker       = await safeExchangeCall(() => binance.fetchTicker(config.symbol));
    const currentPrice = ticker.last;
    if (!currentPrice) return;

    const isBuy   = activePosition.type === 'buy';
    const entry   = activePosition.entryPrice;
    const trailDist = activePosition.trailingStopDistance;
    const activationDist = activePosition.trailingActivationDistance || trailDist;

    if (trailDist <= 0) return;

    if (!activePosition.trailingActivated) {
      const profitPercent = isBuy
        ? (currentPrice - entry) / entry
        : (entry - currentPrice) / entry;
      const activationPercent = activationDist / entry;

      if (profitPercent >= activationPercent) {
        activePosition.trailingActivated = true;
        console.log(`🔓 Трейлінг-стоп активовано (прибуток: ${(profitPercent * 100).toFixed(3)}%)`);
      } else {
        return;
      }
    }

    if (isBuy) {
      if (currentPrice > activePosition.highestPrice) {
        activePosition.highestPrice = currentPrice;
        const newSL = activePosition.highestPrice - trailDist;
        if (newSL > activePosition.stopLoss) {
          activePosition.stopLoss = newSL;
          console.log(`🔄 Трейлінг SL оновлено: ${newSL.toFixed(4)}`);
          persistPosition();
          await updateSafetyOrders();
        }
      }
    } else {
      if (currentPrice < activePosition.lowestPrice || activePosition.lowestPrice === 0) {
        activePosition.lowestPrice = currentPrice;
        const newSL = activePosition.lowestPrice + trailDist;
        if (newSL < activePosition.stopLoss || activePosition.stopLoss === 0) {
          activePosition.stopLoss = newSL;
          console.log(`🔄 Трейлінг SL оновлено: ${newSL.toFixed(4)}`);
          persistPosition();
          await updateSafetyOrders();
        }
      }
    }
  } catch (error) {
    console.error('🔴 Помилка трейлінг-стопу:', error.message);
  }
}

// ─── Position management ────────────────────────────────────────────────────

function clearActivePosition() {
  if (activePosition.trailingInterval) {
    clearInterval(activePosition.trailingInterval);
  }
  activePosition = {
    id: null, type: null, totalAmount: 0, entryPrice: 0,
    stopLoss: 0, takeProfit: 0, trailingStopDistance: 0, trailingActivationDistance: 0,
    trailingActivated: false, trailingInterval: null,
    highestPrice: 0, lowestPrice: 0, openedAt: 0
  };
  persistPosition();
  console.log('🧹 Позицію очищено');
}

/**
 * Рахує реальний результат закритої позиції по угодах біржі:
 * сума realizedPnl мінус комісії. Якщо угод не знайдено — оцінка по ціні.
 */
async function calcRealizedPnl(snapshot) {
  const closeSide = snapshot.type === 'buy' ? 'sell' : 'buy';
  const since = (snapshot.openedAt || Date.now() - 60 * 60 * 1000) - 5000;

  for (let attempt = 0; attempt < 4; attempt++) {
    // Біржі потрібен час, щоб угоди з'явились в історії
    await sleep(attempt === 0 ? 1500 : 2000);
    try {
      const trades = await binance.fetchMyTrades(config.symbol, since, 200);
      if (!trades || trades.length === 0) continue;

      let realized = 0, fees = 0, closeQty = 0, closeNotional = 0;
      for (const t of trades) {
        realized += Number(t.info?.realizedPnl || 0);
        const feeCur = t.fee?.currency;
        if (t.fee && (!feeCur || feeCur === 'USDT')) fees += Number(t.fee.cost || 0);
        if (t.side === closeSide) {
          closeQty      += Number(t.amount);
          closeNotional += Number(t.amount) * Number(t.price);
        }
      }

      if (closeQty > 0) {
        return {
          pnl: realized - fees,
          exitPrice: closeNotional / closeQty,
          source: 'exchange'
        };
      }
    } catch (error) {
      console.warn(`⚠️ Не вдалося отримати угоди (спроба ${attempt + 1}): ${error.message}`);
    }
  }

  // Запасний варіант: оцінка по поточній ціні
  try {
    const ticker = await binance.fetchTicker(config.symbol);
    const exit = Number(ticker.last);
    const diff = snapshot.type === 'buy' ? exit - snapshot.entryPrice : snapshot.entryPrice - exit;
    return { pnl: diff * snapshot.totalAmount, exitPrice: exit, source: 'estimate' };
  } catch {
    return { pnl: 0, exitPrice: 0, source: 'unknown' };
  }
}

/**
 * Відправляє в Telegram підсумок закритої позиції.
 * Формат: "Позиція закрита (ETHUSDT) Профіт (+10.00$)"
 */
async function reportClosedPosition(snapshot, reason = '') {
  try {
    const { pnl, exitPrice, source } = await calcRealizedPnl(snapshot);
    const sign   = pnl >= 0 ? '+' : '-';
    const label  = pnl >= 0 ? 'Профіт' : 'Збиток';
    const icon   = pnl >= 0 ? '✅' : '❌';
    const amount = Math.abs(pnl).toFixed(2);

    let text = `${icon} Позиція закрита (${config.symbol})\n${label} (${sign}${amount}$)`;
    if (exitPrice) {
      text += `\nВхід: ${snapshot.entryPrice.toFixed(2)} → Вихід: ${exitPrice.toFixed(2)}`;
    }
    if (reason) text += `\nПричина: ${reason}`;
    if (source !== 'exchange') text += `\n(орієнтовний розрахунок)`;

    console.log(`📬 ${text.replace(/\n/g, ' | ')}`);
    await telegram.sendMessage(text, false);

    if (onPositionClosed) {
      try {
        await onPositionClosed({ pnl, snapshot, reason, exitPrice });
      } catch (e) {
        console.error('🔴 Помилка обробника закриття:', e.message);
      }
    }

    try { await getCurrentBalanceSafe(); } catch {}
  } catch (error) {
    console.error('🔴 Помилка формування звіту про закриття:', error.message);
    telegram.sendMessage(`✅ Позиція закрита (${config.symbol})`, false);
  }
}

async function syncPositionWithExchange() {
  if (!binance) return false;
  // Під час відкриття/закриття стан змінюється самим ботом — не втручаємось
  if (isOpeningPosition || isClosingPosition || syncInProgress) {
    return validateActivePosition();
  }

  syncInProgress = true;
  try {
    const positions = await safeExchangeCall(() => binance.fetchPositions([config.symbol]));
    if (!positions || !Array.isArray(positions)) return false;

    const position    = findPosition(positions);
    const hasPosition = !!position;

    // Позиція зникла на біржі (спрацював TP/SL або ліквідація)
    if (!hasPosition && activePosition.id) {
      console.log('🔄 Позиція закрита на біржі');
      const snapshot = { ...activePosition };
      clearActivePosition();
      await cancelPositionOrders();
      await reportClosedPosition(snapshot, 'спрацював TP/SL');
      return false;
    }

    // Позиції на біржі немає, а збережений стан лишився → закрилась, поки бот не працював
    if (!hasPosition && !activePosition.id) {
      const stale = stateStore.read('position');
      if (stale) {
        stateStore.write('position', null);
        console.log('ℹ️ Збережена позиція вже закрита на біржі (ймовірно, спрацював SL/TP поки бот був вимкнений)');
        telegram.sendMessage(`ℹ️ Позиція ${config.symbol} була закрита, поки бот не працював (SL/TP на біржі).`, false);
      }
    }

    if (hasPosition && !activePosition.id) {
      console.log('🔄 Синхронізація позиції з біржі');
      activePosition.id          = generatePositionId();
      activePosition.type        = position.side === 'long' ? 'buy' : 'sell';
      activePosition.totalAmount = Math.abs(Number(position.contracts));
      activePosition.entryPrice  = Number(position.entryPrice || position.markPrice);
      activePosition.openedAt    = Date.now();
      activePosition.trailingActivated = false;

      const isBuy = activePosition.type === 'buy';
      const entry = activePosition.entryPrice;
      const saved = stateStore.read('position');
      const sameAsSaved = saved && saved.type === activePosition.type &&
        Math.abs(saved.totalAmount - activePosition.totalAmount) / activePosition.totalAmount < 0.01;

      if (sameAsSaved) {
        // Відновлюємо точні рівні та стан трейлінгу
        activePosition.stopLoss    = saved.stopLoss;
        activePosition.takeProfit  = saved.takeProfit;
        activePosition.trailingStopDistance       = saved.trailingStopDistance;
        activePosition.trailingActivationDistance = saved.trailingActivationDistance;
        activePosition.trailingActivated = !!saved.trailingActivated;
        activePosition.highestPrice = saved.highestPrice || 0;
        activePosition.lowestPrice  = saved.lowestPrice  || 0;
        activePosition.openedAt     = saved.openedAt || activePosition.openedAt;
        console.log('♻️ Відновлено SL/TP/трейлінг зі збереженого стану');
      } else {
        // Невідома позиція — захищаємо її рівнями з config.recovery
        const rec = config.recovery || { slPercent: 1.5, tpPercent: 3, trailPercent: 0.7 };
        activePosition.stopLoss   = entry * (isBuy ? 1 - rec.slPercent / 100 : 1 + rec.slPercent / 100);
        activePosition.takeProfit = entry * (isBuy ? 1 + rec.tpPercent / 100 : 1 - rec.tpPercent / 100);
        activePosition.trailingStopDistance       = entry * rec.trailPercent / 100;
        activePosition.trailingActivationDistance = entry * rec.trailPercent / 100;
        activePosition.highestPrice = isBuy ? entry : 0;
        activePosition.lowestPrice  = isBuy ? 0 : entry;
        console.log(`🛡️ Невідома позиція: виставляємо захист (SL ${rec.slPercent}%, TP ${rec.tpPercent}%)`);
      }

      persistPosition();

      if (activePosition.trailingInterval) clearInterval(activePosition.trailingInterval);
      activePosition.trailingInterval = setInterval(updateTrailingStop, 5000);

      await updateSafetyOrders();
      console.log('✅ Позицію синхронізовано');
    }

    return hasPosition;
  } catch (error) {
    console.error('🔴 Помилка синхронізації:', error.message);
    return false;
  } finally {
    syncInProgress = false;
  }
}

/** Періодична перевірка: чи не закрилась позиція по TP/SL на біржі. */
function startSyncMonitor() {
  if (syncMonitorInterval) clearInterval(syncMonitorInterval);
  syncMonitorInterval = setInterval(() => {
    if (activePosition.id) syncPositionWithExchange();
  }, 10000);
}

async function closePosition() {
  if (!validateActivePosition()) return;
  isClosingPosition = true;
  try {
    const oppositeSide = activePosition.type === 'buy' ? 'sell' : 'buy';
    const snapshot = { ...activePosition };
    console.log(`🛑 Закриваємо позицію: ${activePosition.type} ${activePosition.totalAmount}`);
    await cancelPositionOrders();
    await safeExchangeCall(() =>
      binance.createOrder(config.symbol, 'market', oppositeSide, activePosition.totalAmount, undefined, { reduceOnly: true })
    );

    for (let i = 0; i < 10; i++) {
      const positions = await binance.fetchPositions([config.symbol]);
      if (!findPosition(positions)) {
        console.log('✅ Позиція закрита');
        break;
      }
      await sleep(1000);
    }

    clearActivePosition();
    await cancelPositionOrders();
    await reportClosedPosition(snapshot, 'закрито ботом');
  } catch (error) {
    console.error('🔴 Помилка закриття позиції:', error.message);
    telegram.sendError('закриття позиції', error);
  } finally {
    isClosingPosition = false;
  }
}

async function openNewPosition(type, amount = config.tradeAmount, entryPrice = null, stops = {}) {
  try {
    if (!await checkExchangeConnection()) throw new Error('Немає підключення');

    if (validateActivePosition()) {
      console.log(`⛔ Позиція вже є в пам'яті (${activePosition.type}), нову не відкриваємо`);
      return;
    }

    const positions   = await binance.fetchPositions([config.symbol]);
    const existingPos = findPosition(positions);
    if (existingPos) {
      console.log(`⚠️ Позиція вже існує на біржі, синхронізуємо...`);
      await syncPositionWithExchange();
      return;
    }

    const balance   = await binance.fetchBalance({ type: 'future' });
    const available = balance.total?.USDT || 0;
    if (available < 10) {
      console.log(`❌ Недостатньо маржі: ${available} USDT`);
      return;
    }

    isOpeningPosition = true;
    const openedAt = Date.now();

    console.log(`🟢 Відкриваємо позицію: ${type} ${amount} ${config.symbol}`);
    const order = await safeExchangeCall(() =>
      binance.createOrder(config.symbol, 'market', type, amount)
    );

    const realEntry = order?.average || order?.fills?.[0]?.price;
    if (!realEntry || isNaN(realEntry)) {
      const ticker = await safeExchangeCall(() => binance.fetchTicker(config.symbol));
      entryPrice = ticker.last;
    } else {
      entryPrice = Number(realEntry);
    }

    activePosition.id                   = generatePositionId();
    activePosition.type                 = type;
    activePosition.totalAmount          = Number(order?.filled) || Number(amount);
    activePosition.entryPrice           = entryPrice;
    activePosition.openedAt             = openedAt;
    activePosition.stopLoss             = Number(stops.stopLoss)             || entryPrice * (type === 'buy' ? 0.97 : 1.03);
    activePosition.takeProfit           = Number(stops.takeProfit)           || entryPrice * (type === 'buy' ? 1.03 : 0.97);
    activePosition.trailingStopDistance = Number(stops.trailingStopDistance) || entryPrice * 0.005;
    activePosition.trailingActivationDistance = Number(stops.trailingActivationDistance) || activePosition.trailingStopDistance;
    activePosition.trailingActivated    = false;

    if (type === 'buy') {
      activePosition.highestPrice = entryPrice;
      activePosition.lowestPrice  = 0;
    } else {
      activePosition.lowestPrice  = entryPrice;
      activePosition.highestPrice = 0;
    }

    console.log(`📊 Позиція відкрита:`);
    console.log(`   Тип: ${type}`);
    console.log(`   Кількість: ${amount}`);
    console.log(`   Ціна входу: ${entryPrice.toFixed(4)}`);
    console.log(`   Stop Loss: ${activePosition.stopLoss.toFixed(4)}`);
    console.log(`   Take Profit: ${activePosition.takeProfit.toFixed(4)}`);
    console.log(`   Трейлінг: активація ${activePosition.trailingActivationDistance.toFixed(4)}, відступ ${activePosition.trailingStopDistance.toFixed(4)}`);

    persistPosition();
    await updateSafetyOrders();

    if (activePosition.trailingInterval) clearInterval(activePosition.trailingInterval);
    activePosition.trailingInterval = setInterval(updateTrailingStop, 5000);

    telegram.sendMessage(
      `🟢 Нова позиція ${type.toUpperCase()}:\n` +
      `Ціна входу: ${entryPrice.toFixed(4)}\n` +
      `SL: ${activePosition.stopLoss.toFixed(4)}\n` +
      `TP: ${activePosition.takeProfit.toFixed(4)}\n` +
      `Кількість: ${activePosition.totalAmount}\n` +
      `Трейлінг: активація ${activePosition.trailingActivationDistance.toFixed(2)}, відступ ${activePosition.trailingStopDistance.toFixed(2)}`,
      false
    );

  } catch (error) {
    console.error('🔴 Помилка відкриття позиції:', error.message);
  } finally {
    isOpeningPosition = false;
  }
}

function getActivePosition() {
  return {
    isOpen:     validateActivePosition(),
    side:       activePosition.type === 'buy' ? 'long' : activePosition.type === 'sell' ? 'short' : null,
    size:       activePosition.totalAmount,
    entryPrice: activePosition.entryPrice,
    stopLoss:   activePosition.stopLoss,
    takeProfit: activePosition.takeProfit,
    trailingActivated: activePosition.trailingActivated
  };
}

async function executeOrder(signal) {
  if (!binance) {
    binance = await binanceClientPromise();
    await initAccountBalance();
  }
  const { type } = signal;
  if (!type) { console.warn('⚠️ Невалідний сигнал'); return; }
  if (validateActivePosition()) { console.log('⛔ Позиція вже є, DCA вимкнено'); return; }

  const ticker = await safeExchangeCall(() => binance.fetchTicker(config.symbol));
  const price  = ticker.last;
  if (!price || isNaN(price)) { console.warn('❌ Невалідна ціна'); return; }

  await openNewPosition(type, config.tradeAmount, price);
}

// ─── Init ────────────────────────────────────────────────────────────────────

async function initializeTradingModule(providedBinance = null) {
  console.log('🚀 Ініціалізація модуля торгівлі...');
  binance = providedBinance || await binanceClientPromise();
  console.log(`🌐 Binance Futures API: ${binance.urls?.api?.fapiPrivate || 'невідомо'}`);

  await initAccountBalance();
  await syncPositionWithExchange();
  startSyncMonitor();

  tradingInterface.executeOrder            = executeOrder;
  tradingInterface.getAccountBalance       = getCurrentBalanceSafe;
  tradingInterface.closePosition           = closePosition;
  tradingInterface.getActivePosition       = getActivePosition;
  tradingInterface.syncPositionWithExchange = syncPositionWithExchange;
  tradingInterface.setPositionClosedHandler = setPositionClosedHandler;

  console.log('✅ Модуль торгівлі ініціалізовано');
  return tradingInterface;
}

module.exports = {
  initializeTradingModule,
  closePosition,
  syncPositionWithExchange,
  getCurrentBalanceSafe,
  updateSafetyOrders,
  updateTrailingStop,
  getActivePosition,
  openNewPosition,
  executeOrder,
  setPositionClosedHandler
};