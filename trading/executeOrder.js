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
  breakEvenReached: false,
  trailingActivated: false,
  trailingInterval: null,
  lastTrailingUpdate: 0
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
      if (event.o.x === 'FILLED' || event.o.x === 'LIQUIDATED') {
        console.log('🔵 Подія виконання або ліквідації:', event.o.s);
        await syncPositionWithExchange();
        await checkAndAutoClosePositionIfNeeded();
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
    console.log(`🔌 Вебсокет закрито: ${code} - ${reason}`);
    reconnectWebSocket();
  });

  setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      console.log('🔌 Вебсокет неактивний, перепідключення...');
      reconnectWebSocket();
    }
  }, 10000);
}

const RISK_PARAMS = {
  initial: {
    STOP_LOSS: 0.35,
    TAKE_PROFIT: 1.05,
    TRAILING_ACTIVATION: 0.64,
    TRAILING_STOP: 0.2
  },
  aggressive: {
    STOP_LOSS: 0.25,
    TAKE_PROFIT: 0.84,
    TRAILING_ACTIVATION: 0.4,
    TRAILING_STOP: 0.12
  },
  breakEven: {
    STOP_LOSS: 0.14,
    TAKE_PROFIT: 0.7,
    TRAILING_ACTIVATION: 0.32,
    TRAILING_STOP: 0.088
  }
};

const BREAK_EVEN_LEVEL = 1.05;
const MIN_PROFIT_FOR_BREAKEVEN = 0.5;
const COMMISSION_RATE = 0.0004;
const ORDER_UPDATE_INTERVAL = 30000; // 30 сек
const POSITION_CHECK_INTERVAL = 30000;
const MIN_STOP_DISTANCE_PERCENT = 0.3;
const ORDER_RETRY_LIMIT = 3;

let accountBalance = 0;

async function safeExchangeCall(fn, ...args) {
  try {
    if (typeof fn !== 'function') throw new Error(`Invalid function call: ${typeof fn}`);
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
    console.log('✅ Підключення до біржі активне');
    return true;
  } catch (error) {
    console.error('🔴 Помилка підключення до біржі:', error.message);
    return false;
  }
}

async function getCurrentBalanceSafe() {
  try {
    if (!await checkExchangeConnection()) throw new Error('Відсутнє підключення до біржі');
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
    } else {
      console.warn('⚠️ Неочікувана структура балансу:', typeof balance);
    }

    accountBalance = Number(usdtBalance) || 0;
    return accountBalance;
  } catch (error) {
    console.error('🔴 Помилка отримання балансу:', error.message);
    telegram.sendError('balance_fetch', error);
    return accountBalance;
  }
}

async function initAccountBalance() {
  try {
    accountBalance = await getCurrentBalanceSafe();
    console.log(`💰 Ініціалізовано баланс: ${accountBalance} USDT`);

    if (accountBalance === 0) {
      console.warn('⚠️ Увага: баланс USDT дорівнює 0. Перевірте підключення до API.');
    }

    return accountBalance;
  } catch (error) {
    console.error('🔴 Критична помилка балансу:', error.message);
    telegram.sendError('balance_init_fatal', error);
    process.exit(1);
  }
}

function generatePositionId() {
  return `POS_${Date.now()}`;
}

function generateOrderId() {
  return `OID_${Date.now()}_${uuidv4().substring(0, 8)}`;
}

function getCurrentRiskParams() {
  if (activePosition.breakEvenReached) {
    return RISK_PARAMS.breakEven;
  }
  return activePosition.trailingActivated
    ? RISK_PARAMS.aggressive
    : RISK_PARAMS.initial;
}

function calculateCurrentProfit(currentPrice) {
  if (!validateActivePosition() || !currentPrice || !activePosition.entryPrice) return 0;

  const isLong = activePosition.type === 'buy';
  const priceDifference = isLong
    ? (currentPrice - activePosition.entryPrice)
    : (activePosition.entryPrice - currentPrice);

  const rawProfitPercent = (priceDifference / activePosition.entryPrice) * 100;
  const commission = COMMISSION_RATE * 2 * 100;
  const effectiveProfit = rawProfitPercent - commission;

  return Math.max(0, effectiveProfit);
}

async function cancelPositionOrders() {
  if (!activePosition.id) return;
  try {
    await safeExchangeCall(() => binance.cancelAllOrders(config.symbol));
    console.log('🗑️ Всі ордери скасовані');
    telegram.sendMessage(`Скасовано ордери для ${config.symbol}`);
  } catch (error) {
    console.error('🔴 Помилка скасування:', error.message);
    telegram.sendError('cancel_orders', error);
  }
}

function clearActivePosition() {
  if (activePosition.trailingInterval) {
    clearInterval(activePosition.trailingInterval);
    activePosition.trailingInterval = null;
  }

  binance.cancelAllOrders(config.symbol).catch(() => { });

  activePosition = {
    id: null,
    type: null,
    totalAmount: 0,
    entryPrice: 0,
    breakEvenReached: false,
    trailingActivated: false,
    trailingInterval: null,
    lastTrailingUpdate: 0
  };

  console.log('🧹 Активну позицію очищено');
}

async function syncPositionWithExchange() {
  if (!binance) {
    console.error('🔴 Бібліотека Binance не ініціалізована');
    return false;
  }

  try {
    const positions = await safeExchangeCall(() => binance.fetchPositions());

    if (!positions || !Array.isArray(positions)) {
      console.log('🟡 Не вдалося отримати позиції з біржі');
      return false;
    }

    const cleanSymbol = config.symbol.replace('/', '');
    const position = positions.find(pos =>
      pos.symbol === cleanSymbol &&
      pos.contracts &&
      Math.abs(Number(pos.contracts)) > 0
    );

    const hasPosition = position && Math.abs(Number(position.contracts)) > 0.001;

    if (!hasPosition && activePosition.id) {
      console.log('🔄 Позиція закрита на біржі. Очищаємо стан...');
      clearActivePosition();
      return false;
    }

    if (hasPosition) {
      if (!activePosition.id) {
        console.log('🔄 Виявлено активну позицію на біржі. Синхронізація...');
        activePosition.id = generatePositionId();
        activePosition.type = position.side && position.side.toLowerCase() === 'long' ? 'buy' : 'sell';
        activePosition.totalAmount = Math.abs(Number(position.contracts));
        activePosition.entryPrice = Number(position.entryPrice || position.markPrice);

        if (activePosition.trailingInterval) clearInterval(activePosition.trailingInterval);
        activePosition.trailingInterval = setInterval(async () => {
          await checkPositionStatus();
          await updateBreakEvenStop(config.symbol);
          await updateTrailingStop(config.symbol);
          await checkAndAutoClosePositionIfNeeded();
        }, POSITION_CHECK_INTERVAL);

        console.log('🔄 Синхронізовано активну позицію з біржі:', {
          side: activePosition.type,
          amount: activePosition.totalAmount,
          entry: activePosition.entryPrice
        });
        await updateSafetyOrders();
      } else {
        activePosition.totalAmount = Math.abs(Number(position.contracts));
        activePosition.entryPrice = Number(position.entryPrice || position.markPrice);
      }
    }

    return hasPosition;
  } catch (error) {
    console.error('🔴 Помилка синхронізації позиції:', error.message);
    telegram.sendError('sync_position', error);
    return false;
  }
}

async function updateSafetyOrders() {
  if (!validateActivePosition()) return;

  try {
    await cancelPositionOrders();

    const params = getCurrentRiskParams();

    const currentTicker = await safeExchangeCall(() => binance.fetchTicker(config.symbol));
    const currentPrice = currentTicker.last;

    const MIN_STOP_DISTANCE_PERCENT = 0.1;

    function adjustStopPrice(stopPrice, currentPrice, isBuy) {
      if (isBuy) {
        const minAllowed = currentPrice * (1 - MIN_STOP_DISTANCE_PERCENT / 100);
        if (stopPrice >= currentPrice) return minAllowed;
      } else {
        const maxAllowed = currentPrice * (1 + MIN_STOP_DISTANCE_PERCENT / 100);
        if (stopPrice <= currentPrice) return maxAllowed;
      }
      return stopPrice;
    }

    const slRaw = activePosition.type === 'buy'
      ? activePosition.entryPrice * (1 - params.STOP_LOSS / 100)
      : activePosition.entryPrice * (1 + params.STOP_LOSS / 100);

    const tpRaw = activePosition.type === 'buy'
      ? activePosition.entryPrice * (1 + params.TAKE_PROFIT / 100)
      : activePosition.entryPrice * (1 - params.TAKE_PROFIT / 100);

    const slPrice = adjustStopPrice(slRaw, currentPrice, activePosition.type === 'buy');
    const tpPrice = adjustStopPrice(tpRaw, currentPrice, activePosition.type !== 'buy');

    const amount = activePosition.totalAmount;

    console.log(`🛡️ Створення ордерів безпеки: TP: ${tpPrice.toFixed(4)}, SL: ${slPrice.toFixed(4)}`);

    const tpOrder = await safeExchangeCall(() => binance.createOrder(
      config.symbol,
      'TAKE_PROFIT_MARKET',
      activePosition.type === 'buy' ? 'sell' : 'buy',
      amount,
      null,
      { stopPrice: tpPrice }
    ));

    const slOrder = await safeExchangeCall(() => binance.createOrder(
      config.symbol,
      'STOP_MARKET',
      activePosition.type === 'buy' ? 'sell' : 'buy',
      amount,
      null,
      { stopPrice: slPrice }
    ));

    console.log('✅ Ордери безпеки створено');
    telegram.sendMessage(`Ордери безпеки створено: TP ${tpPrice.toFixed(4)}, SL ${slPrice.toFixed(4)}`);

  } catch (error) {
    console.error('🔴 Помилка створення ордерів безпеки:', error.message);
    telegram.sendError('create_safety_orders', error);
  }
}

async function checkPositionStatus() {
  console.log('🔍 Вхід у checkPositionStatus()', activePosition);
  if (!validateActivePosition() || !activePosition.entryPrice) return;

  try {
    const ticker = await safeExchangeCall(() => binance.fetchTicker(config.symbol));
    const currentPrice = 
      ticker.last || 
      ticker.close || 
      parseFloat(ticker.info?.lastPrice) || 
      ticker.ask || 
      ticker.bid;

    if (!currentPrice || isNaN(currentPrice)) {
      console.error('❌ Поточна ціна не отримана або некоректна:', currentPrice);
      return;
    }

    const profit = calculateCurrentProfit(currentPrice);
    console.log(`📈 Поточний прибуток: ${profit.toFixed(2)}% (ціна: ${currentPrice}, вхід: ${activePosition.entryPrice})`);

    let updated = false;

    // 📌 Зберігаємо поточні параметри ДО оновлення прапорів
    const currentParams = getCurrentRiskParams();
    console.log(`🔧 Поточні risk-параметри:`, currentParams);

    // ✅ Брейк-івен
    if (!activePosition.breakEvenReached && profit >= BREAK_EVEN_LEVEL) {
      activePosition.breakEvenReached = true;
      console.log('✅ Рівень беззбитковості досягнуто');
      updated = true;
    }

    // ✅ Трейлінг-стоп
    if (!activePosition.trailingActivated && profit >= currentParams.TRAILING_ACTIVATION) {
      activePosition.trailingActivated = true;
      console.log('🚀 Трейлінг-стоп активовано');
      updated = true;
    }

    // 🔄 Після оновлення флагів — отримуємо нові параметри та оновлюємо ордери
    if (updated) {
      const newParams = getCurrentRiskParams();
      console.log(`🔁 Оновлені параметри:`, newParams);
      await updateSafetyOrders();
    }

  } catch (error) {
    console.error('🔴 Помилка перевірки статусу позиції:', error.message, error.stack);
    telegram.sendError('check_position_status', error);
  }
}



async function updateBreakEvenStop(symbol) {
  if (!validateActivePosition()) return;

  // Тут можна логіку зміни стопу при break even — за потребою
}

async function updateTrailingStop(symbol) {
  if (!validateActivePosition()) return;

  // Логіка оновлення трейлінг стопу — по інтервалу

  try {
    const ticker = await safeExchangeCall(() => binance.fetchTicker(symbol));
    const currentPrice = ticker.last;

    if (!activePosition.trailingActivated) return;

    const params = getCurrentRiskParams();

    let newStopPrice;

    if (activePosition.type === 'buy') {
      newStopPrice = currentPrice * (1 - params.TRAILING_STOP / 100);
      if (newStopPrice > activePosition.entryPrice) {
        // Оновити ордер стопа тут, якщо новий стоп вище старого
        // Логіка скасування старого і створення нового
        await updateSafetyOrders();
      }
    } else {
      newStopPrice = currentPrice * (1 + params.TRAILING_STOP / 100);
      if (newStopPrice < activePosition.entryPrice) {
        await updateSafetyOrders();
      }
    }

  } catch (error) {
    console.error('🔴 Помилка оновлення трейлінг-стопу:', error.message);
    telegram.sendError('update_trailing_stop', error);
  }
}

async function checkAndAutoClosePositionIfNeeded() {
  if (!validateActivePosition()) return;

  try {
    const ticker = await safeExchangeCall(() => binance.fetchTicker(config.symbol));
    const currentPrice = ticker.last;

    const profit = calculateCurrentProfit(currentPrice);

    if (profit < -RISK_PARAMS.initial.STOP_LOSS) {
      console.log('⚠️ Прибуток менший за стоп-лосс, закриваємо позицію');
      telegram.sendMessage('Закриваю позицію через досягнення стоп-лоссу');
      await closePosition();
    }
  } catch (error) {
    console.error('🔴 Помилка при автоматичному закритті позиції:', error.message);
    telegram.sendError('auto_close_position', error);
  }
}

async function closePosition() {
  if (!validateActivePosition()) return;

  try {
    console.log(`🛑 Закриваємо позицію: ${activePosition.type} ${activePosition.totalAmount} ${config.symbol}`);
    const oppositeSide = activePosition.type === 'buy' ? 'sell' : 'buy';

    await cancelPositionOrders();

    await safeExchangeCall(() => binance.createOrder(
      config.symbol,
      'MARKET',
      oppositeSide,
      activePosition.totalAmount
    ));

    clearActivePosition();

    telegram.sendMessage('Позиція успішно закрита');
  } catch (error) {
    console.error('🔴 Помилка закриття позиції:', error.message);
    telegram.sendError('close_position', error);
  }
}

async function openNewPosition(type, amount = config.tradeAmount) {
  try {
    if (!await checkExchangeConnection()) throw new Error('Відсутнє підключення до біржі');

    if (validateActivePosition()) {
  const isSameDirection =
    (activePosition.type === 'buy' && type === 'buy') ||
    (activePosition.type === 'sell' && type === 'sell');

  if (isSameDirection) {
    console.log('➕ Докупка в ту ж сторону...');
    const ticker = await safeExchangeCall(() => binance.fetchTicker(config.symbol));
    const price = ticker.last;

    const additionalAmount = config.tradeAmount;

    const totalCost = activePosition.entryPrice * activePosition.totalAmount;
    const additionalCost = price * additionalAmount;
    const newTotalAmount = activePosition.totalAmount + additionalAmount;

    const newAverage = (totalCost + additionalCost) / newTotalAmount;

    activePosition.entryPrice = newAverage;
    activePosition.totalAmount = newTotalAmount;

    await safeExchangeCall(() =>
      binance.createOrder(config.symbol, 'MARKET', type, additionalAmount)
    );

    await updateSafetyOrders();

    telegram.sendMessage(`📉 Докупка SHORT: ${additionalAmount} по ${price}, нова середня: ${newAverage.toFixed(2)}`);
    return;
  } else {
    console.log('🔁 Сигнал протилежний. Закриваємо позицію...');
    await closePosition();
  }
}

    console.log(`🔵 Відкриваємо нову позицію: ${type} ${amount} ${config.symbol}`);

    const order = await safeExchangeCall(() =>
      binance.createOrder(config.symbol, 'MARKET', type, amount)
    );

    // 🧠 Автоматичне визначення entryPrice
    let entryPrice = order?.average || order?.fills?.[0]?.price;

    if (!entryPrice || isNaN(entryPrice)) {
      const ticker = await safeExchangeCall(() => binance.fetchTicker(config.symbol));
      entryPrice = ticker.last;
      console.log(`📌 Ціна входу з ринку (fallback): ${entryPrice}`);
    } else {
      console.log(`📌 Ціна входу з ордера: ${entryPrice}`);
    }

    activePosition.id = generatePositionId();
    activePosition.type = type;
    activePosition.totalAmount = amount;
    activePosition.entryPrice = Number(entryPrice);
    activePosition.breakEvenReached = false;
    activePosition.trailingActivated = false;

    await updateSafetyOrders();

    telegram.sendMessage(`🟢 Нова позиція: ${type} ${amount} ${config.symbol} за ціною ${entryPrice}`);

  } catch (error) {
    console.error('🔴 Помилка відкриття позиції:', error.message);
    telegram.sendError('open_position', error);
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

    console.log('✅ Інтерфейс торгівлі ініціалізовано');
    return tradingInterface;
  } catch (error) {
    console.error('🔴 Критична помилка ініціалізації модуля торгівлі:', error);
    telegram.sendError('module_init_fatal', error);
    process.exit(1);
  }
}

async function executeOrder(signal) {
  if (!binance) {
    binance = await binanceClientPromise();
    setupWebSocketHandlers();
    await initAccountBalance();
  }

  const { type } = signal;
  const amount = config.tradeAmount; // ✅ беремо фіксовану кількість з config

  if (!type || !amount) {
    console.warn('⚠️ Некоректний сигнал для виконання');
    return;
  }

  const ticker = await safeExchangeCall(() => binance.fetchTicker(config.symbol));
  const price = ticker.last;

  if (!price || isNaN(price)) {
    console.warn('❌ Невалідна ціна при виконанні ордера:', price);
    return;
  }

  if (validateActivePosition()) {
    const isSameDirection =
      (activePosition.type === 'buy' && type === 'buy') ||
      (activePosition.type === 'sell' && type === 'sell');

    if (isSameDirection) {
      console.log('➕ Докупка до існуючої позиції...');

      const totalCost = activePosition.entryPrice * activePosition.totalAmount;
      const additionalCost = price * amount;
      const newTotalAmount = activePosition.totalAmount + amount;
      const newAveragePrice = (totalCost + additionalCost) / newTotalAmount;

      // 🔄 оновлюємо позицію
      activePosition.entryPrice = newAveragePrice;
      activePosition.totalAmount = newTotalAmount;

      // 🟢 виконуємо ринковий ордер
      await safeExchangeCall(() =>
        binance.createOrder(config.symbol, 'MARKET', type, amount)
      );

      // 🔁 оновлення SL/TP
      await updateSafetyOrders();

      telegram.sendMessage(`➕ Докупка ${amount} ${config.symbol} по ${price.toFixed(2)}. Нова ціна входу: ${newAveragePrice.toFixed(4)}`);
      return;
    } else {
      console.log('🔁 Сигнал протилежний активній позиції, закриваємо...');
      await closePosition();
    }
  }

  console.log(`🟢 Відкриваємо нову позицію: ${type} ${amount} ${config.symbol}`);

  const order = await safeExchangeCall(() =>
    binance.createOrder(config.symbol, 'MARKET', type, amount)
  );

  // 💡 ціна входу
  const entryPrice = parseFloat(order?.fills?.[0]?.price) || price;

  activePosition.id = generatePositionId();
  activePosition.type = type;
  activePosition.totalAmount = amount;
  activePosition.entryPrice = entryPrice;
  activePosition.breakEvenReached = false;
  activePosition.trailingActivated = false;

  await updateSafetyOrders();

  telegram.sendMessage(`🟢 Нова позиція: ${type} ${amount} ${config.symbol} по ціні ${entryPrice.toFixed(4)}`);
}


function getActivePosition() {
  return {
    isOpen: validateActivePosition(),
    side: activePosition.type === 'buy' ? 'long' : activePosition.type === 'sell' ? 'short' : null,
    size: activePosition.totalAmount,
    entryPrice: activePosition.entryPrice
  };
}

// Експортуємо функцію для зовнішнього виклику
module.exports = {
  initializeTradingModule,
  closePosition,
  syncPositionWithExchange,
  getCurrentBalanceSafe,
  updateSafetyOrders,
  checkPositionStatus,
  updateTrailingStop,
  getActivePosition,
  openNewPosition,
};