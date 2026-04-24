const config = require('../config/config');
const { v4: uuidv4 } = require('uuid');
const telegram = require('../utils/telegramNotifier');
const WebSocket = require('ws');

const binanceClientPromise = require('../utils/binanceClient');
let binance;

let ws;
const tradingInterface = {
  executeOrder: null,
  getAccountBalance: null,
  closePosition: null
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
  highestPrice: 0,  // Для LONG - максимальна ціна
  lowestPrice: 0    // Для SHORT - мінімальна ціна
};

function validateActivePosition() {
  return activePosition.id &&
    activePosition.totalAmount > 0 &&
    activePosition.entryPrice > 0;
}

function setupWebSocketHandlers() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    console.log('🔌 Вебсокет вже активний');
    return;
  }

  console.log('🔌 Ініціалізація вебсокета...');
  ws = new WebSocket('wss://fstream.binance.com/ws/!forceOrder@arr');

  const reconnectWebSocket = () => {
    console.log('🔌 Перепідключення вебсокета...');
    setTimeout(() => {
      ws = new WebSocket('wss://fstream.binance.com/ws/!forceOrder@arr');
      setupWebSocketHandlers();
    }, 5000);
  };

  ws.on('open', () => {
    console.log('🔌 Вебсокет успішно підключено');
  });

  ws.on('message', async (data) => {
    try {
      const event = JSON.parse(data);
      if (event.o && (event.o.x === 'FILLED' || event.o.x === 'LIQUIDATED')) {
        console.log('🔵 Подія виконання/ліквідації:', event.o.s);
        await syncPositionWithExchange();
      }
    } catch (error) {
      console.error('🔴 Помилка вебсокета:', error.message);
    }
  });

  ws.on('error', (error) => {
    console.error('🔴 Вебсокет помилка:', error.message);
    reconnectWebSocket();
  });

  ws.on('close', (code, reason) => {
    console.log(`🔌 Вебсокет закрито: ${code}`);
    reconnectWebSocket();
  });

  setInterval(() => {
    if (ws && ws.readyState !== WebSocket.OPEN) {
      console.log('🔌 Вебсокет неактивний, перепідключення...');
      reconnectWebSocket();
    }
  }, 10000);
}

let accountBalance = 0;

async function safeExchangeCall(fn, ...args) {
  try {
    if (typeof fn !== 'function') throw new Error(`Invalid function: ${typeof fn}`);
    return await fn(...args);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('🔴 API Error:', errorMessage);

    if (errorMessage.includes('API-key')) {
      console.error('🛑 Invalid API keys');
      process.exit(1);
    }

    throw error;
  }
}

async function checkExchangeConnection() {
  if (!binance) {
    console.error('🔴 Бібліотека Binance не ініціалізована');
    return false;
  }
  try {
    await safeExchangeCall(() => binance.fetchTime());
    return true;
  } catch (error) {
    console.error('🔴 Помилка підключення:', error.message);
    return false;
  }
}

async function getCurrentBalanceSafe() {
  try {
    if (!await checkExchangeConnection()) throw new Error('Немає підключення');
    const balance = await safeExchangeCall(() => binance.fetchBalance());

    let usdtBalance = 0;
    if (balance && typeof balance === 'object') {
      usdtBalance = balance.total?.USDT ||
        balance.USDT?.total ||
        balance.total?.usdt ||
        balance.usdt?.total ||
        balance.free?.USDT ||
        balance.USDT?.free ||
        balance.free?.usdt ||
        balance.usdt?.free ||
        0;
    }

    accountBalance = Number(usdtBalance) || 0;
    return accountBalance;
  } catch (error) {
    console.error('🔴 Помилка отримання балансу:', error.message);
    return accountBalance;
  }
}

async function initAccountBalance() {
  try {
    accountBalance = await getCurrentBalanceSafe();
    console.log(`💰 Ініціалізовано баланс: ${accountBalance} USDT`);
    return accountBalance;
  } catch (error) {
    console.error('🔴 Критична помилка балансу:', error.message);
    process.exit(1);
  }
}

function generatePositionId() {
  return `POS_${Date.now()}`;
}

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
        await safeExchangeCall(() =>
          binance.cancelOrder(order.id, config.symbol)
        );
        console.log(`✅ Ордер скасовано: ${order.id}`);
      } catch (err) {
        console.warn(`⚠️ Не вдалося скасувати ордер ${order.id}`);
      }
    }
  } catch (error) {
    console.error('🔴 Помилка скасування ордерів:', error.message);
  }
}

async function syncPositionWithExchange() {
  if (!binance) {
    console.error('🔴 Бібліотека Binance не ініціалізована');
    return false;
  }

  try {
    const positions = await safeExchangeCall(() => binance.fetchPositions());

    if (!positions || !Array.isArray(positions)) {
      console.log('🟡 Не вдалося отримати позиції');
      return false;
    }

    const cleanSymbol = config.symbol.replace('/', '');
    const position = positions.find(pos =>
      pos.symbol === cleanSymbol &&
      pos.contracts &&
      Math.abs(Number(pos.contracts)) > 0.001
    );

    const hasPosition = !!position;

    if (!hasPosition && activePosition.id) {
      console.log('🔄 Позиція закрита на біржі');
      await cancelPositionOrders();
      clearActivePosition();
      return false;
    }

    if (hasPosition && !activePosition.id) {
      const newType = position.side === 'long' ? 'buy' : 'sell';
      const newAmount = Math.abs(Number(position.contracts));
      const newEntryPrice = Number(position.entryPrice || position.markPrice);

      console.log('🔄 Синхронізація активної позиції з біржі');

      activePosition.id = generatePositionId();
      activePosition.type = newType;
      activePosition.totalAmount = newAmount;
      activePosition.entryPrice = newEntryPrice;

      if (activePosition.type === 'buy') {
        activePosition.highestPrice = newEntryPrice;
      } else {
        activePosition.lowestPrice = newEntryPrice;
      }

      if (activePosition.trailingInterval) clearInterval(activePosition.trailingInterval);
      activePosition.trailingInterval = setInterval(async () => {
        await updateTrailingStop();
      }, 5000);

      console.log('✅ Позицію синхронізовано');
    }

    return hasPosition;
  } catch (error) {
    console.error('🔴 Помилка синхроні��ації:', error.message);
    return false;
  }
}

function clearActivePosition() {
  if (activePosition.trailingInterval) {
    clearInterval(activePosition.trailingInterval);
    activePosition.trailingInterval = null;
  }

  binance?.cancelAllOrders(config.symbol).catch(() => {});

  activePosition = {
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

  console.log('🧹 Позицію очищено');
}

/**
 * ✅ Оновлення ордерів TP/SL з розрахованими стопами
 */
async function updateSafetyOrders() {
  if (!validateActivePosition()) return;

  try {
    await cancelPositionOrders();

    const isBuy = activePosition.type === 'buy';
    const amount = activePosition.totalAmount;

    console.log(`🛡️ Створюємо ордери безпеки:`);
    console.log(`   SL: ${activePosition.stopLoss.toFixed(4)}`);
    console.log(`   TP: ${activePosition.takeProfit.toFixed(4)}`);

    // ✅ Створюємо TAKE_PROFIT ордер
    const tpOrder = await safeExchangeCall(() =>
      binance.createOrder(
        config.symbol,
        'TAKE_PROFIT_MARKET',
        isBuy ? 'sell' : 'buy',
        amount,
        null,
        { stopPrice: activePosition.takeProfit }
      )
    );

    console.log(`✅ TP ордер створено: ${activePosition.takeProfit.toFixed(4)}`);

    // ✅ Створюємо STOP_LOSS ордер
    const slOrder = await safeExchangeCall(() =>
      binance.createOrder(
        config.symbol,
        'STOP_MARKET',
        isBuy ? 'sell' : 'buy',
        amount,
        null,
        { stopPrice: activePosition.stopLoss }
      )
    );

    console.log(`✅ SL ордер створено: ${activePosition.stopLoss.toFixed(4)}`);

    telegram.sendMessage(
      `📍 TP/SL оновлено:\nSL: ${activePosition.stopLoss.toFixed(4)}\nTP: ${activePosition.takeProfit.toFixed(4)}`
    );

  } catch (error) {
    console.error('🔴 Помилка створення ордерів:', error.message);
  }
}

/**
 * ✅ Трейлінг-стоп логіка
 */
async function updateTrailingStop() {
  if (!validateActivePosition()) return;

  try {
    const ticker = await safeExchangeCall(() => binance.fetchTicker(config.symbol));
    const currentPrice = ticker.last;

    if (!currentPrice) return;

    const isBuy = activePosition.type === 'buy';

    // LONG: відстежуємо максимальну ціну
    if (isBuy) {
      if (currentPrice > activePosition.highestPrice) {
        activePosition.highestPrice = currentPrice;

        // ✅ Переміщуємо стоп вгору
        const newStopLoss = activePosition.highestPrice - activePosition.trailingStopDistance;
        if (newStopLoss > activePosition.stopLoss) {
          activePosition.stopLoss = newStopLoss;
          console.log(`🔄 Трейлінг SL оновлено: ${newStopLoss.toFixed(4)}`);
          await updateSafetyOrders();
        }
      }
    }
    // SHORT: відстежуємо мінімальну ціну
    else {
      if (currentPrice < activePosition.lowestPrice || activePosition.lowestPrice === 0) {
        activePosition.lowestPrice = currentPrice;

        // ✅ Переміщуємо стоп вниз
        const newStopLoss = activePosition.lowestPrice + activePosition.trailingStopDistance;
        if (newStopLoss < activePosition.stopLoss) {
          activePosition.stopLoss = newStopLoss;
          console.log(`🔄 Трейлінг SL оновлено: ${newStopLoss.toFixed(4)}`);
          await updateSafetyOrders();
        }
      }
    }
  } catch (error) {
    console.error('🔴 Помилка оновлення трейлінг-стопу:', error.message);
  }
}

async function closePosition() {
  if (!validateActivePosition()) return;

  try {
    console.log(`🛑 Закриваємо позицію: ${activePosition.type} ${activePosition.totalAmount} ${config.symbol}`);
    const oppositeSide = activePosition.type === 'buy' ? 'sell' : 'buy';

    await cancelPositionOrders();

    await safeExchangeCall(() =>
      binance.createOrder(config.symbol, 'MARKET', oppositeSide, activePosition.totalAmount)
    );

    let retries = 10;
    while (retries-- > 0) {
      const positions = await binance.fetchPositions([config.symbol]);
      const pos = positions.find(p => p.symbol.includes(config.symbol.split('/')[0]));
      const positionAmt = parseFloat(pos?.contracts || 0);

      if (Math.abs(positionAmt) < 0.001) {
        console.log('✅ Позиція закрита');
        break;
      }

      await new Promise(res => setTimeout(res, 1000));
    }

    await cancelPositionOrders();
    clearActivePosition();
    await syncPositionWithExchange();

    telegram.sendMessage(`✅ Позиція закрита (${config.symbol})`);

  } catch (error) {
    console.error('🔴 Помилка закриття позиції:', error.message);
  }
}

/**
 * ✅ Відкриття нової позиції зі стопами та трейлінг-стопом
 * @param {string} type - 'buy' або 'sell'
 * @param {number} amount - розмір позиції
 * @param {number} entryPrice - ціна входу
 * @param {object} stops - {stopLoss, takeProfit, trailingStopDistance}
 */
async function openNewPosition(type, amount = config.tradeAmount, entryPrice = null, stops = {}) {
  try {
    if (!await checkExchangeConnection()) throw new Error('Немає підключення до біржі');

    // Перевіряємо існуючи позиції
    const positions = await binance.fetchPositions([config.symbol]);
    const pos = positions.find(p => p.symbol.includes(config.symbol.split('/')[0]));
    const currentContracts = parseFloat(pos?.contracts || 0);

    if (Math.abs(currentContracts) > 0.001) {
      console.log(`⚠️ Позиція вже існує (${currentContracts}), нову не відкриваємо`);
      return;
    }

    // Отримуємо баланс
    const balance = await binance.fetchBalance({ type: 'future' });
    const available = balance.total?.USDT || 0;

    if (available < 10) {
      console.log(`❌ Не��остатньо маржі: ${available} USDT`);
      return;
    }

    console.log(`🟢 Відкриваємо позицію: ${type} ${amount} ${config.symbol}`);
    
    const order = await safeExchangeCall(() =>
      binance.createOrder(config.symbol, 'market', type, amount)
    );

    const actualEntryPrice = entryPrice || order?.average || order?.fills?.[0]?.price;
    if (!actualEntryPrice || isNaN(actualEntryPrice)) {
      const ticker = await safeExchangeCall(() => binance.fetchTicker(config.symbol));
      entryPrice = ticker.last;
    } else {
      entryPrice = actualEntryPrice;
    }

    // ✅ Зберігаємо активну позицію з розрахованими стопами
    activePosition.id = generatePositionId();
    activePosition.type = type;
    activePosition.totalAmount = amount;
    activePosition.entryPrice = Number(entryPrice);

    // ✅ Встановлюємо стопи та трейлінг-стоп
    activePosition.stopLoss = Number(stops.stopLoss) || entryPrice * 0.97;
    activePosition.takeProfit = Number(stops.takeProfit) || entryPrice * 1.03;
    activePosition.trailingStopDistance = Number(stops.trailingStopDistance) || entryPrice * 0.01;

    if (type === 'buy') {
      activePosition.highestPrice = entryPrice;
      activePosition.lowestPrice = 0;
    } else {
      activePosition.lowestPrice = entryPrice;
      activePosition.highestPrice = 0;
    }

    console.log(`📊 Позиція відкрита:`);
    console.log(`   Тип: ${type}`);
    console.log(`   Кількість: ${amount}`);
    console.log(`   Ціна входу: ${entryPrice.toFixed(4)}`);
    console.log(`   Stop Loss: ${activePosition.stopLoss.toFixed(4)}`);
    console.log(`   Take Profit: ${activePosition.takeProfit.toFixed(4)}`);
    console.log(`   Трейлінг дистанція: ${activePosition.trailingStopDistance.toFixed(4)}`);

    // ✅ Створюємо ордери TP/SL з розрахованими стопами
    await updateSafetyOrders();

    // ✅ Запускаємо трейлінг-стоп моніторинг
    if (activePosition.trailingInterval) clearInterval(activePosition.trailingInterval);
    activePosition.trailingInterval = setInterval(async () => {
      await updateTrailingStop();
    }, 5000);

    telegram.sendMessage(
      `🟢 Нова позиція ${type.toUpperCase()}:\n` +
      `Цена входу: ${entryPrice.toFixed(4)}\n` +
      `SL: ${activePosition.stopLoss.toFixed(4)}\n` +
      `TP: ${activePosition.takeProfit.toFixed(4)}\n` +
      `Трейлінг: ${activePosition.trailingStopDistance.toFixed(4)}`
    );

  } catch (error) {
    console.error('🔴 Помилка відкриття позиції:', error.message);
  }
}

async function initializeTradingModule(providedBinance = null) {
  try {
    console.log('🚀 Ініціалізація модуля торгівлі...');

    const originalBinance = providedBinance || await binanceClientPromise();
    binance = originalBinance;

    await initAccountBalance();
    setupWebSocketHandlers();
    await syncPositionWithExchange();

    tradingInterface.executeOrder = executeOrder;
    tradingInterface.getAccountBalance = getCurrentBalanceSafe;
    tradingInterface.closePosition = closePosition;
    tradingInterface.getActivePosition = getActivePosition;
    tradingInterface.syncPositionWithExchange = syncPositionWithExchange;

    console.log('✅ Модуль торгівлі ініціалізовано');
    return tradingInterface;
  } catch (error) {
    console.error('🔴 Помилка ініціалізації модуля:', error);
    process.exit(1);
  }
}

function getActivePosition() {
  return {
    isOpen: validateActivePosition(),
    side: activePosition.type === 'buy' ? 'long' : activePosition.type === 'sell' ? 'short' : null,
    size: activePosition.totalAmount,
    entryPrice: activePosition.entryPrice,
    stopLoss: activePosition.stopLoss,
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

  const ticker = await safeExchangeCall(() => binance.fetchTicker(config.symbol));
  const price = ticker.last;

  if (!price || isNaN(price)) {
    console.warn('❌ Невалідна ціна');
    return;
  }

  if (!type) {
    console.warn('⚠️ Невалідний сигнал');
    return;
  }

  // ❌ DCA вимкнено - бот НЕ буде докуповувати
  if (validateActivePosition()) {
    console.log('⛔ Позиція вже існує - нову не відкриваємо, DCA вимкнено');
    return;
  }

  await openNewPosition(type, config.tradeAmount, price);
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
