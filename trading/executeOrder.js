const config = require('../config/config');
const telegram = require('../utils/telegramNotifier');
const WebSocket = require('ws');
const binanceClientPromise = require('../utils/binanceClient');
const https = require('https');
const crypto = require('crypto');
const querystring = require('querystring');

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
        setTimeout(async () => {
          await syncPositionWithExchange();
        }, 3000);
      }
    } catch {}
  });

  setInterval(() => {
    if (ws && ws.readyState !== WebSocket.OPEN) reconnect();
  }, 10000);
}

// ─── Orders ─────────────────────────────────────────────────────────────────

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
 * Прямий підписаний POST-запит на /fapi/v1/order для стоп-маркет/тейк-профіт.
 * Замінює binance.fapiPrivatePostOrder, щоб уникнути помилок CCXT.
 */
async function privatePostOrder(orderParams) {
  const apiKey = binance.apiKey;
  const secret = binance.secret;

  const bodyParams = {
    symbol: orderParams.symbol,
    side: orderParams.side,
    type: orderParams.type,
    quantity: String(orderParams.quantity),
    stopPrice: String(orderParams.stopPrice),
    reduceOnly: 'true',
    workingType: 'MARK_PRICE',
    timestamp: Date.now(),
    recvWindow: 5000
  };

  const queryString = querystring.stringify(bodyParams);
  const signature = crypto.createHmac('sha256', secret).update(queryString).digest('hex');
  const finalQuery = queryString + '&signature=' + signature;

  const options = {
    hostname: 'fapi.binance.com',
    path: '/fapi/v1/order?' + finalQuery,
    method: 'POST',
    headers: {
      'X-MBX-APIKEY': apiKey,
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode === 200) {
            resolve(json);
          } else {
            reject(new Error(`Order error: ${json.msg || data}`));
          }
        } catch (e) {
          reject(new Error(`Parse error: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Створення/оновлення Stop-Loss та Take-Profit ордерів.
 */
async function updateSafetyOrders() {
  if (!validateActivePosition()) return;

  const MAX_RETRIES = 2;
  let attempt = 0;

  const placeOrders = async () => {
    try {
      await cancelPositionOrders();

      const isBuy     = activePosition.type === 'buy';
      const closeSide = isBuy ? 'SELL' : 'BUY';
      const symbol    = config.symbol.replace('/', '');   // SOLUSDT
      const qty       = activePosition.totalAmount;

      console.log('🛡️ Створюємо ордери безпеки:');
      console.log(`   SL: ${activePosition.stopLoss.toFixed(4)}`);
      console.log(`   TP: ${activePosition.takeProfit.toFixed(4)}`);

      // TAKE_PROFIT_MARKET
      await privatePostOrder({
        symbol,
        side: closeSide,
        type: 'TAKE_PROFIT_MARKET',
        quantity: qty,
        stopPrice: activePosition.takeProfit.toFixed(4)
      });
      console.log(`✅ TP ордер створено: ${activePosition.takeProfit.toFixed(4)}`);

      // STOP_MARKET
      await privatePostOrder({
        symbol,
        side: closeSide,
        type: 'STOP_MARKET',
        quantity: qty,
        stopPrice: activePosition.stopLoss.toFixed(4)
      });
      console.log(`✅ SL ордер створено: ${activePosition.stopLoss.toFixed(4)}`);

      telegram.sendMessage(
        `📍 TP/SL оновлено:\nSL: ${activePosition.stopLoss.toFixed(4)}\nTP: ${activePosition.takeProfit.toFixed(4)}`
      );

      return true;
    } catch (error) {
      console.error(`🔴 Помилка створення ордерів TP/SL (спроба ${attempt + 1}):`, error.message);
      return false;
    }
  };

  let success = await placeOrders();
  attempt++;

  while (!success && attempt <= MAX_RETRIES) {
    console.log('🔄 Повторна спроба через 5 секунд...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    success = await placeOrders();
    attempt++;
  }

  if (!success) {
    console.error('⛔ Не вдалося створити TP/SL після повторів. Перевірте API-ключі та права.');
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

    if (!activePosition.trailingActivated) {
      const profitPercent = isBuy
        ? (currentPrice - entry) / entry
        : (entry - currentPrice) / entry;
      const activationPercent = trailDist / entry;

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

      activePosition.trailingActivated = false;

      if (activePosition.type === 'buy') {
        activePosition.highestPrice = activePosition.entryPrice;
        activePosition.lowestPrice  = 0;
      } else {
        activePosition.lowestPrice  = activePosition.entryPrice;
        activePosition.highestPrice = 0;
      }

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

async function openNewPosition(type, amount = config.tradeAmount, entryPrice = null, stops = {}) {
  try {
    if (!await checkExchangeConnection()) throw new Error('Немає підключення');

    if (validateActivePosition()) {
      console.log(`⛔ Позиція вже є в пам'яті (${activePosition.type}), нову не відкриваємо`);
      return;
    }

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

    const realEntry = order?.average || order?.fills?.[0]?.price;
    if (!realEntry || isNaN(realEntry)) {
      const ticker = await safeExchangeCall(() => binance.fetchTicker(config.symbol));
      entryPrice = ticker.last;
    } else {
      entryPrice = Number(realEntry);
    }

    activePosition.id                   = generatePositionId();
    activePosition.type                 = type;
    activePosition.totalAmount          = amount;
    activePosition.entryPrice           = entryPrice;
    activePosition.stopLoss             = Number(stops.stopLoss)             || entryPrice * (type === 'buy' ? 0.97 : 1.03);
    activePosition.takeProfit           = Number(stops.takeProfit)           || entryPrice * (type === 'buy' ? 1.03 : 0.97);
    activePosition.trailingStopDistance = Number(stops.trailingStopDistance) || entryPrice * 0.005;
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
    console.log(`   Трейлінг дистанція: ${activePosition.trailingStopDistance.toFixed(4)}`);

    await updateSafetyOrders();

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
    takeProfit: activePosition.takeProfit,
    trailingActivated: activePosition.trailingActivated
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