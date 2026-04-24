const config = require('../config/config');
const telegram = require('../utils/telegramNotifier');
const WebSocket = require('ws');
const binanceClientPromise = require('../utils/binanceClient');

let binance;
let ws;

const tradingInterface = {
  executeOrder: null,
  getAccountBalance: null,
  closePosition: null,
  getActivePosition: null,
  syncPositionWithExchange: null
};

let activePosition = {
  id: null,
  type: null,
  totalAmount: 0,
  entryPrice: 0,
  stopLoss: 0,
  takeProfit: 0,
  trailingStopDistance: 0,
  trailingActivated: false,
  trailingInterval: null,
  highestPrice: 0,
  lowestPrice: 0
};

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
    if (msg.includes('API-key')) {
      console.error('🛑 Invalid API keys');
      process.exit(1);
    }
    throw error;
  }
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

// ─── WebSocket ──────────────────────────────────────────────────────────────

function setupWebSocketHandlers() {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  console.log('🔌 Ініціалізація вебсокета...');
  ws = new WebSocket('wss://fstream.binance.com/ws/!forceOrder@arr');

  const reconnect = () => {
    setTimeout(() => {
      ws = new WebSocket('wss://fstream.binance.com/ws/!forceOrder@arr');
      setupWebSocketHandlers();
    }, 5000);
  };

  ws.on('open',    () => console.log('🔌 Вебсокет успішно підключено'));
  ws.on('error',   (e) => { console.error('🔴 Вебсокет помилка:', e.message); reconnect(); });
  ws.on('close',   (c) => { console.log(`🔌 Вебсокет закрито: ${c}`); reconnect(); });
  ws.on('message', async (data) => {
    try {
      const event = JSON.parse(data);
      if (event.o && (event.o.x === 'FILLED' || event.o.x === 'LIQUIDATED')) {
        await syncPositionWithExchange();
      }
    } catch {}
  });

  setInterval(() => {
    if (ws && ws.readyState !== WebSocket.OPEN) reconnect();
  }, 10000);
}

// ─── Orders ─────────────────────────────────────────────────────────────────

/**
 * Скасовує всі відкриті ордери по символу.
 */
async function cancelPositionOrders() {
  if (!binance || !config.symbol) return;
  try {
    const openOrders = await safeExchangeCall(() =>
      binance.fetchOpenOrders(config.symbol)
    );
    if (!openOrders || openOrders.length === 0) {
      console.log('ℹ️ Немає відкритих ордерів');
      return;
    }
    console.log(`🔁 Скасовуємо ${openOrders.length} ордерів...`);
    for (const order of openOrders) {
      try {
        await safeExchangeCall(() => binance.cancelOrder(order.id, config.symbol));
        console.log(`✅ Ордер скасовано: ${order.id}`);
      } catch {
        console.warn(`⚠️ Не вдалося скасувати ордер ${order.id}`);
      }
    }
  } catch (error) {
    console.error('🔴 Помилка скасування ордерів:', error.message);
  }
}

/**
 * Розміщує STOP_MARKET і TAKE_PROFIT_MARKET через прямий виклик
 * fapiPrivatePostOrder — єдиний надійний спосіб в ccxt для Binance Futures.
 *
 * Документація Binance:
 *   POST /fapi/v1/order
 *   type: STOP_MARKET        → обов'язкові: stopPrice, reduceOnly
 *   type: TAKE_PROFIT_MARKET → обов'язкові: stopPrice, reduceOnly
 */
async function updateSafetyOrders() {
  if (!validateActivePosition()) return;

  try {
    await cancelPositionOrders();

    const isBuy     = activePosition.type === 'buy';
    const closeSide = isBuy ? 'SELL' : 'BUY';
    const symbol    = config.symbol.replace('/', ''); // "SOLUSDT"
    const qty       = String(activePosition.totalAmount);

    console.log('🛡️ Створюємо ордери безпеки:');
    console.log(`   SL: ${activePosition.stopLoss.toFixed(4)}`);
    console.log(`   TP: ${activePosition.takeProfit.toFixed(4)}`);

    // ── TAKE_PROFIT_MARKET ────────────────────────────────────────────────
    await safeExchangeCall(() =>
      binance.fapiPrivatePostOrder({
        symbol,
        side:          closeSide,
        type:          'TAKE_PROFIT_MARKET',
        stopPrice:     activePosition.takeProfit.toFixed(4),
        quantity:      qty,
        reduceOnly:    'true',
        workingType:   'MARK_PRICE',
        timeInForce:   'GTC'
      })
    );
    console.log(`✅ TP ордер створено: ${activePosition.takeProfit.toFixed(4)}`);

    // ── STOP_MARKET ───────────────────────────────────────────────────────
    await safeExchangeCall(() =>
      binance.fapiPrivatePostOrder({
        symbol,
        side:          closeSide,
        type:          'STOP_MARKET',
        stopPrice:     activePosition.stopLoss.toFixed(4),
        quantity:      qty,
        reduceOnly:    'true',
        workingType:   'MARK_PRICE',
        timeInForce:   'GTC'
      })
    );
    console.log(`✅ SL ордер створено: ${activePosition.stopLoss.toFixed(4)}`);

    telegram.sendMessage(
      `📍 TP/SL оновлено:\nSL: ${activePosition.stopLoss.toFixed(4)}\nTP: ${activePosition.takeProfit.toFixed(4)}`
    );

  } catch (error) {
    // Не кидаємо далі — позиція відкрита, SL/TP можна виправити вручну
    console.error('🔴 Помилка створення ордерів TP/SL:', error.message);
  }
}

// ─── Trailing Stop ──────────────────────────────────────────────────────────

async function updateTrailingStop() {
  if (!validateActivePosition()) return;

  try {
    const ticker       = await safeExchangeCall(() => binance.fetchTicker(config.symbol));
    const currentPrice = ticker.last;
    if (!currentPrice) return;

    const isBuy = activePosition.type === 'buy';

    if (isBuy) {
      if (currentPrice > activePosition.highestPrice) {
        activePosition.highestPrice = currentPrice;
        const newSL = activePosition.highestPrice - activePosition.trailingStopDistance;
        if (newSL > activePosition.stopLoss) {
          activePosition.stopLoss = newSL;
          console.log(`🔄 Трейлінг SL оновлено: ${newSL.toFixed(4)}`);
          await updateSafetyOrders();
        }
      }
    } else {
      if (currentPrice < activePosition.lowestPrice || activePosition.lowestPrice === 0) {
        activePosition.lowestPrice = currentPrice;
        const newSL = activePosition.lowestPrice + activePosition.trailingStopDistance;
        if (newSL < activePosition.stopLoss || activePosition.stopLoss === 0) {
          activePosition.stopLoss = newSL;
          console.log(`🔄 Трейлінг SL оновлено: ${newSL.toFixed(4)}`);
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
  binance?.cancelAllOrders(config.symbol).catch(() => {});
  activePosition = {
    id: null, type: null, totalAmount: 0, entryPrice: 0,
    stopLoss: 0, takeProfit: 0, trailingStopDistance: 0,
    trailingActivated: false, trailingInterval: null,
    highestPrice: 0, lowestPrice: 0
  };
  console.log('🧹 Позицію очищено');
}

async function syncPositionWithExchange() {
  if (!binance) return false;
  try {
    const positions = await safeExchangeCall(() => binance.fetchPositions());
    if (!positions || !Array.isArray(positions)) return false;

    const cleanSymbol = config.symbol.replace('/', '');
    const position    = positions.find(pos =>
      pos.symbol === cleanSymbol && Math.abs(Number(pos.contracts)) > 0.001
    );
    const hasPosition = !!position;

    if (!hasPosition && activePosition.id) {
      console.log('🔄 Позиція закрита на біржі');
      await cancelPositionOrders();
      clearActivePosition();
      return false;
    }

    if (hasPosition && !activePosition.id) {
      console.log('🔄 Синхронізація позиції з біржі');
      activePosition.id          = generatePositionId();
      activePosition.type        = position.side === 'long' ? 'buy' : 'sell';
      activePosition.totalAmount = Math.abs(Number(position.contracts));
      activePosition.entryPrice  = Number(position.entryPrice || position.markPrice);

      if (activePosition.type === 'buy') activePosition.highestPrice = activePosition.entryPrice;
      else                               activePosition.lowestPrice  = activePosition.entryPrice;

      if (activePosition.trailingInterval) clearInterval(activePosition.trailingInterval);
      activePosition.trailingInterval = setInterval(updateTrailingStop, 5000);
      console.log('✅ Позицію синхронізовано');
    }

    return hasPosition;
  } catch (error) {
    console.error('🔴 Помилка синхронізації:', error.message);
    return false;
  }
}

async function closePosition() {
  if (!validateActivePosition()) return;
  try {
    const oppositeSide = activePosition.type === 'buy' ? 'sell' : 'buy';
    console.log(`🛑 Закриваємо позицію: ${activePosition.type} ${activePosition.totalAmount}`);
    await cancelPositionOrders();
    await safeExchangeCall(() =>
      binance.createOrder(config.symbol, 'MARKET', oppositeSide, activePosition.totalAmount)
    );

    // Чекаємо підтвердження закриття
    for (let i = 0; i < 10; i++) {
      const positions = await binance.fetchPositions([config.symbol]);
      const pos = positions.find(p => p.symbol.includes(config.symbol.replace('/', '')));
      if (Math.abs(parseFloat(pos?.contracts || 0)) < 0.001) {
        console.log('✅ Позиція закрита');
        break;
      }
      await new Promise(r => setTimeout(r, 1000));
    }

    clearActivePosition();
    await syncPositionWithExchange();
    telegram.sendMessage(`✅ Позиція закрита (${config.symbol})`);
  } catch (error) {
    console.error('🔴 Помилка закриття позиції:', error.message);
  }
}

/**
 * Відкриття нової позиції.
 * @param {string} type   - 'buy' | 'sell'
 * @param {number} amount
 * @param {number} entryPrice
 * @param {object} stops  - {stopLoss, takeProfit, trailingStopDistance}
 */
async function openNewPosition(type, amount = config.tradeAmount, entryPrice = null, stops = {}) {
  try {
    if (!await checkExchangeConnection()) throw new Error('Немає підключення');

    // Перевірка локального стану
    if (validateActivePosition()) {
      console.log(`⛔ Позиція вже є в пам'яті (${activePosition.type}), нову не відкриваємо`);
      return;
    }

    // Перевірка на біржі
    const positions       = await binance.fetchPositions([config.symbol]);
    const existingPos     = positions.find(p =>
      p.symbol.includes(config.symbol.replace('/', '')) &&
      Math.abs(Number(p.contracts || 0)) > 0.001
    );
    if (existingPos) {
      console.log(`⚠️ Позиція вже існує на біржі, синхронізуємо...`);
      await syncPositionWithExchange();
      return;
    }

    // Перевірка балансу
    const balance   = await binance.fetchBalance({ type: 'future' });
    const available = balance.total?.USDT || 0;
    if (available < 10) {
      console.log(`❌ Недостатньо маржі: ${available} USDT`);
      return;
    }

    console.log(`🟢 Відкриваємо позицію: ${type} ${amount} ${config.symbol}`);
    const order = await safeExchangeCall(() =>
      binance.createOrder(config.symbol, 'market', type, amount)
    );

    // Отримуємо реальну ціну входу
    const realEntry = order?.average || order?.fills?.[0]?.price;
    if (!realEntry || isNaN(realEntry)) {
      const ticker = await safeExchangeCall(() => binance.fetchTicker(config.symbol));
      entryPrice = ticker.last;
    } else {
      entryPrice = Number(realEntry);
    }

    // Зберігаємо позицію в пам'яті
    activePosition.id                  = generatePositionId();
    activePosition.type                = type;
    activePosition.totalAmount         = amount;
    activePosition.entryPrice          = entryPrice;
    activePosition.stopLoss            = Number(stops.stopLoss)             || entryPrice * (type === 'buy' ? 0.97 : 1.03);
    activePosition.takeProfit          = Number(stops.takeProfit)           || entryPrice * (type === 'buy' ? 1.03 : 0.97);
    activePosition.trailingStopDistance = Number(stops.trailingStopDistance) || entryPrice * 0.005;

    if (type === 'buy') { activePosition.highestPrice = entryPrice; activePosition.lowestPrice = 0; }
    else                { activePosition.lowestPrice  = entryPrice; activePosition.highestPrice = 0; }

    console.log(`📊 Позиція відкрита:`);
    console.log(`   Тип: ${type}`);
    console.log(`   Кількість: ${amount}`);
    console.log(`   Ціна входу: ${entryPrice.toFixed(4)}`);
    console.log(`   Stop Loss: ${activePosition.stopLoss.toFixed(4)}`);
    console.log(`   Take Profit: ${activePosition.takeProfit.toFixed(4)}`);
    console.log(`   Трейлінг дистанція: ${activePosition.trailingStopDistance.toFixed(4)}`);

    // Встановлюємо TP/SL
    await updateSafetyOrders();

    // Запускаємо трейлінг
    if (activePosition.trailingInterval) clearInterval(activePosition.trailingInterval);
    activePosition.trailingInterval = setInterval(updateTrailingStop, 5000);

    telegram.sendMessage(
      `🟢 Нова позиція ${type.toUpperCase()}:\n` +
      `Ціна входу: ${entryPrice.toFixed(4)}\n` +
      `SL: ${activePosition.stopLoss.toFixed(4)}\n` +
      `TP: ${activePosition.takeProfit.toFixed(4)}\n` +
      `Трейлінг: ${activePosition.trailingStopDistance.toFixed(4)}`
    );

  } catch (error) {
    console.error('🔴 Помилка відкриття позиції:', error.message);
  }
}

function getActivePosition() {
  return {
    isOpen:     validateActivePosition(),
    side:       activePosition.type === 'buy' ? 'long' : activePosition.type === 'sell' ? 'short' : null,
    size:       activePosition.totalAmount,
    entryPrice: activePosition.entryPrice,
    stopLoss:   activePosition.stopLoss,
    takeProfit: activePosition.takeProfit
  };
}

async function executeOrder(signal) {
  if (!binance) {
    binance = await binanceClientPromise();
    setupWebSocketHandlers();
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

  await initAccountBalance();
  setupWebSocketHandlers();
  await syncPositionWithExchange();

  tradingInterface.executeOrder            = executeOrder;
  tradingInterface.getAccountBalance       = getCurrentBalanceSafe;
  tradingInterface.closePosition           = closePosition;
  tradingInterface.getActivePosition       = getActivePosition;
  tradingInterface.syncPositionWithExchange = syncPositionWithExchange;

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
  executeOrder
};