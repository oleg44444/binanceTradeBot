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
        console.log('🔵 Подія виконання:', event.o.s);
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
const ORDER_UPDATE_INTERVAL = 30000; // Змінено на 30 секунд
const POSITION_CHECK_INTERVAL = 30000;
const MIN_STOP_DISTANCE_PERCENT = 0.3; // Збільшено до 0.3%
const ORDER_RETRY_LIMIT = 3;
const RECONNECT_DELAY = 5000;

let accountBalance = 0;

async function safeExchangeCall(fn, ...args) {
  try {
    if (typeof fn !== 'function') {
      throw new Error(`Invalid function call: ${typeof fn}`);
    }
    
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
    const serverTime = await safeExchangeCall(() => binance.fetchTime());
    console.log('✅ Підключення до біржі активне');
    return true;
  } catch (error) {
    console.error('🔴 Помилка підключення до біржі:', error.message);
    return false;
  }
}

async function getCurrentBalanceSafe() {
  try {
    if (!await checkExchangeConnection()) {
      throw new Error('Відсутнє підключення до біржі');
    }

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
  
  binance.cancelAllOrders(config.symbol).catch(() => {});
  
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
    console.error('🔴 Помилка синхронізації з біржею:', error.message);
    setTimeout(() => syncPositionWithExchange(), 10000);
    return false;
  }
}

async function closePosition(symbol) {
  try {
    await syncPositionWithExchange();
    
    if (!validateActivePosition()) {
      console.log('🔴 Немає активної позиції для закриття');
      return false;
    }
    
    const prevBalance = await getCurrentBalanceSafe();
    const realPosition = await safeExchangeCall(() => binance.fetchPosition(config.symbol));
    
    if (!realPosition || Math.abs(Number(realPosition.contracts)) <= 0.001) {
      console.log('🟡 Реальна позиція на біржі не знайдена');
      clearActivePosition();
      return false;
    }
    
    const realAmount = Math.abs(Number(realPosition.contracts));
    const closeType = realPosition.side.toLowerCase() === 'long' ? 'sell' : 'buy';
    
    console.log(`🔵 Закриття позиції: ${realPosition.side} ${realAmount} ${symbol.replace('/USDT', '')}`);
    
    const closeOrder = await safeExchangeCall(() =>
      binance.createMarketOrder(
        symbol,
        closeType,
        realAmount,
        { 
          newClientOrderId: generateOrderId(),
          reduceOnly: true
        }
      )
    );
    
    const closePrice = parseFloat(closeOrder.average);
    const profitPercent = calculateCurrentProfit(closePrice);
    const newBalance = await getCurrentBalanceSafe();
    const profitAmount = newBalance - prevBalance;
    
    await telegram.sendPositionClosed(
      closePrice, 
      profitPercent, 
      profitAmount, 
      newBalance
    );
    
    console.log(`✅ Позиція закрита: ${realAmount} по ${closePrice}`);
    clearActivePosition();
    
    setTimeout(async () => {
      await syncPositionWithExchange();
    }, 2000);
    
    return true;
  } catch (error) {
    console.error('🔴 Помилка закриття позиції:', error.message);
    telegram.sendError('close_position', error);
    await syncPositionWithExchange();
    return false;
  }
}

async function checkPositionStatus() {
  try {
    await syncPositionWithExchange();
  } catch (error) {
    console.error('🔴 Помилка перевірки:', error.message);
    telegram.sendError('position_check', error);
  }
}

async function createProtectedOrder(symbol, type, side, amount, price, params, maxAttempts = 3) {
  let attempt = 0;
  while (attempt < maxAttempts) {
    try {
      console.log(`🔵 Створення ордера: ${symbol} ${type} ${side} ${amount} @ ${price || 'market'}`);
      return await safeExchangeCall(() => 
        binance.createOrder(symbol, type, side, amount, price, params)
      );
    } catch (error) {
      attempt++;
      if (error.code === -2021) {
        console.log('🟡 Ордер не було розміщено (небезпечна ціна)');
        return null;
      }
      
      console.error(`🔴 Помилка створення ордера (спроба ${attempt}/${maxAttempts}):`, error.message);
      
      if (attempt >= maxAttempts) {
        throw error;
      }
      
      await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
    }
  }
}

async function updateBreakEvenStop(symbol) {
  try {
    if (!validateActivePosition() || activePosition.breakEvenReached) return;
    
    const ticker = await safeExchangeCall(() => binance.fetchTicker(symbol));
    const currentPrice = ticker.last;
    const profitPercent = calculateCurrentProfit(currentPrice);
    
    if (profitPercent < MIN_PROFIT_FOR_BREAKEVEN) return;
    
    if (profitPercent >= BREAK_EVEN_LEVEL) {
      console.log(`🔵 Досягнуто рівень безубитку (${BREAK_EVEN_LEVEL}%): ${profitPercent.toFixed(2)}%`);
      await telegram.sendMessage(`🔵 Досягнуто безубиток: ${profitPercent.toFixed(2)}%`);
      
      await new Promise(resolve => setTimeout(resolve, 3000));
      await cancelPositionOrders();
      
      const stopPrice = binance.priceToPrecision(symbol, activePosition.entryPrice);
      const isLong = activePosition.type === 'buy';
      const minStopDistance = currentPrice * (MIN_STOP_DISTANCE_PERCENT / 100);
      const safeStopPrice = isLong 
        ? Math.min(stopPrice, currentPrice - minStopDistance)
        : Math.max(stopPrice, currentPrice + minStopDistance);
      
      await createProtectedOrder(
        symbol,
        'STOP_MARKET',
        activePosition.type === 'buy' ? 'sell' : 'buy',
        activePosition.totalAmount,
        undefined,
        {
          stopPrice: safeStopPrice,
          reduceOnly: true,
          newClientOrderId: generateOrderId()
        }
      );
      
      activePosition.breakEvenReached = true;
      activePosition.trailingActivated = true;
      
      console.log('🟢 Стоп переміщено на беззбитковість');
      await telegram.sendMessage('🟢 Стоп переміщено на беззбитковість');
      await updateSafetyOrders();
    }
  } catch (error) {
    console.error('🔴 Помилка безубитковості:', error.message);
    telegram.sendError('break_even_stop', error);
  }
}

async function updateTrailingStop(symbol) {
  try {
    if (!validateActivePosition() || !activePosition.entryPrice) return;
    
    const now = Date.now();
    if (now - activePosition.lastTrailingUpdate < ORDER_UPDATE_INTERVAL) return;

    const ticker = await safeExchangeCall(() => binance.fetchTicker(symbol));
    const currentPrice = ticker.last;
    const isLong = activePosition.type === 'buy';
    const riskParams = getCurrentRiskParams();
    const profitPercent = calculateCurrentProfit(currentPrice);
    
    const activationPrice = activePosition.entryPrice * 
      (1 + (isLong ? riskParams.TRAILING_ACTIVATION/100 : -riskParams.TRAILING_ACTIVATION/100));

    if ((isLong && currentPrice > activationPrice) || (!isLong && currentPrice < activationPrice)) {
      const dynamicTrailingStop = Math.max(
        0.08,
        riskParams.TRAILING_STOP - (profitPercent * 0.03)
      );
      
      const newStop = isLong 
        ? currentPrice * (1 - dynamicTrailingStop/100)
        : currentPrice * (1 + dynamicTrailingStop/100);

      const minStopDistance = currentPrice * (MIN_STOP_DISTANCE_PERCENT / 100);
      const safeNewStop = isLong 
        ? Math.min(newStop, currentPrice - minStopDistance)
        : Math.max(newStop, currentPrice + minStopDistance);
      
      await cancelPositionOrders();
      
      await createProtectedOrder(
        symbol,
        'STOP_MARKET',
        isLong ? 'sell' : 'buy',
        activePosition.totalAmount,
        undefined,
        {
          stopPrice: binance.priceToPrecision(symbol, safeNewStop),
          reduceOnly: true,
          newClientOrderId: generateOrderId()
        }
      );
      
      const profitReduction = Math.min(0.4, profitPercent * 0.05);
      const dynamicTakeProfit = riskParams.TAKE_PROFIT * (1 - profitReduction);
      
      const tpPrice = isLong 
        ? activePosition.entryPrice * (1 + dynamicTakeProfit/100)
        : activePosition.entryPrice * (1 - dynamicTakeProfit/100);
      
      await createProtectedOrder(
        symbol,
        'TAKE_PROFIT_MARKET',
        isLong ? 'sell' : 'buy',
        activePosition.totalAmount,
        undefined,
        {
          stopPrice: binance.priceToPrecision(symbol, tpPrice),
          reduceOnly: true,
          newClientOrderId: generateOrderId()
        }
      );
      
      activePosition.trailingActivated = true;
      activePosition.lastTrailingUpdate = now;
      
      console.log(`🔄 Трейлінг-стоп активовано: ${safeNewStop.toFixed(2)}`);
      await telegram.sendPositionUpdated(safeNewStop, tpPrice, profitPercent);
    }
  } catch (error) {
    console.error('🔴 Помилка трейлінгу:', error.message);
    telegram.sendError('trailing_stop', error);
  }
}

async function updateSafetyOrders(attempt = 1) {
  console.log('🛡️ Оновлення ордерів безпеки...');
  if (!activePosition || activePosition.totalAmount <= 0) {
    console.log('🟡 Немає активної позиції, оновлення ордерів пропущено');
    return;
  }
  
  if (attempt > ORDER_RETRY_LIMIT) {
    console.error(`🔴 Досягнуто ліміт спроб оновлення ордерів (${ORDER_RETRY_LIMIT})`);
    telegram.sendError('order_update_limit_reached', new Error(`Досягнуто ліміт спроб: ${ORDER_RETRY_LIMIT}`));
    return;
  }
  
  try {
    await syncPositionWithExchange();
    
    if (!validateActivePosition()) {
      console.log('🟡 Позиція зникла після синхронізації, оновлення пропущено');
      return;
    }
    
    console.log(`🛡️ Оновлення ордерів (спроба ${attempt}) для суми: ${activePosition.totalAmount}`);
    
    await new Promise(resolve => setTimeout(resolve, 500));
    
    const riskParams = getCurrentRiskParams();
    const [tpPrice, slPrice] = calculatePrices(
      activePosition.type, 
      activePosition.entryPrice,
      riskParams
    );

    const ticker = await safeExchangeCall(() => binance.fetchTicker(config.symbol));
    const currentPrice = ticker.last;
    const minStopDistance = currentPrice * (MIN_STOP_DISTANCE_PERCENT / 100);
    const isLong = activePosition.type === 'buy';
    
    const safeSlPrice = isLong 
      ? Math.min(slPrice, currentPrice - minStopDistance)
      : Math.max(slPrice, currentPrice + minStopDistance);
    
    await cancelPositionOrders();
    
    console.log(`🔵 Створення TP ордера: ${tpPrice}`);
    await createProtectedOrder(
      config.symbol,
      'TAKE_PROFIT_MARKET',
      activePosition.type === 'buy' ? 'sell' : 'buy',
      activePosition.totalAmount,
      undefined,
      {
        stopPrice: binance.priceToPrecision(config.symbol, tpPrice),
        reduceOnly: true,
        newClientOrderId: generateOrderId()
      }
    );

    console.log(`🔵 Створення SL ордера: ${safeSlPrice}`);
    await createProtectedOrder(
      config.symbol,
      'STOP_MARKET',
      activePosition.type === 'buy' ? 'sell' : 'buy',
      activePosition.totalAmount,
      undefined,
      {
        stopPrice: binance.priceToPrecision(config.symbol, safeSlPrice),
        reduceOnly: true,
        newClientOrderId: generateOrderId()
      }
    );

    console.log(`🛡️ Оновлено ордери на ${activePosition.totalAmount}: TP ${tpPrice.toFixed(2)}, SL ${safeSlPrice.toFixed(2)}`);
    await telegram.sendMessage(`🛡️ Оновлено ордери на ${activePosition.totalAmount}: TP ${tpPrice.toFixed(2)}, SL ${safeSlPrice.toFixed(2)}`);
  } catch (error) {
    console.error(`🔴 Помилка оновлення ордерів (спроба ${attempt}):`, error.message);
    
    if (attempt < ORDER_RETRY_LIMIT) {
      console.log(`🔄 Повторна спроба оновити ордери через 5 секунд...`);
      setTimeout(() => updateSafetyOrders(attempt + 1), 5000);
    } else {
      telegram.sendError('update_orders_failed', error);
    }
  }
}

function calculatePrices(type, entryPrice, riskParams) {
  const minDistance = 0.1;
  
  return type === 'buy' 
    ? [
        entryPrice * (1 + Math.max(riskParams.TAKE_PROFIT, minDistance)/100),
        entryPrice * (1 - Math.max(riskParams.STOP_LOSS, minDistance)/100)
      ]
    : [
        entryPrice * (1 - Math.max(riskParams.TAKE_PROFIT, minDistance)/100),
        entryPrice * (1 + Math.max(riskParams.STOP_LOSS, minDistance)/100)
      ];
}

async function executeOrder(type, symbol, amount) {
  try {
    const balance = await getCurrentBalanceSafe();
    await syncPositionWithExchange();
    
    if (validateActivePosition() && activePosition.type !== type) {
      console.log(`🔄 Сигнал зміни напрямку: ${activePosition.type.toUpperCase()} → ${type.toUpperCase()}`);
      await telegram.sendMessage(`🔄 Зміна напряму: ${activePosition.type.toUpperCase()} → ${type.toUpperCase()}`);
      
      if (!await closePosition(symbol)) {
        console.log('🟠 Повторна спроба закриття...');
        await telegram.sendMessage('🟠 Повторна спроба закриття позиції');
        await new Promise(resolve => setTimeout(resolve, 2000));
        await closePosition(symbol);
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    if (validateActivePosition() && activePosition.type === type) {
      const order = await safeExchangeCall(() =>
        binance.createMarketOrder(
          symbol,
          type,
          amount,
          { newClientOrderId: generateOrderId() }
        )
      );
      
      const orderPrice = parseFloat(order.average || order.price || order.lastTradePrice);
      if (isNaN(orderPrice)) {
        throw new Error(`Не вдалося отримати ціну ордера: ${JSON.stringify(order)}`);
      }
      const totalCost = (activePosition.entryPrice * activePosition.totalAmount) + 
                       (orderPrice * amount);
      activePosition.totalAmount += amount;
      activePosition.entryPrice = totalCost / activePosition.totalAmount;
      activePosition.breakEvenReached = false;
      
      console.log(`🔵 Додано ${amount} ${symbol.replace('/USDT', '')} по ${orderPrice}. Нова сума: ${activePosition.totalAmount}`);
      await telegram.sendMessage(`🔵 Додано ${amount} ${symbol.replace('/USDT', '')} по ${orderPrice}. Загальна сума: ${activePosition.totalAmount}`);
      
      await new Promise(resolve => setTimeout(resolve, 1000));
      await updateSafetyOrders();
      return;
    }

    await cancelPositionOrders();
    activePosition.id = generatePositionId();
    activePosition.type = type;
    activePosition.totalAmount = amount;
    activePosition.breakEvenReached = false;
    activePosition.trailingActivated = false;

    const order = await safeExchangeCall(() =>
      binance.createMarketOrder(
        symbol,
        type,
        amount,
        { newClientOrderId: generateOrderId() }
      )
    );
    
    const orderPrice = parseFloat(order.average || order.price || order.lastTradePrice);
    if (isNaN(orderPrice)) {
      throw new Error(`Не вдалося отримати ціну ордера: ${JSON.stringify(order)}`);
    }
    activePosition.entryPrice = orderPrice;
    const riskParams = getCurrentRiskParams();
    const [tpPrice, slPrice] = calculatePrices(
      type, 
      activePosition.entryPrice,
      riskParams
    );
    
    await telegram.sendPositionOpened(
      type,
      symbol,
      amount,
      activePosition.entryPrice,
      tpPrice,
      slPrice,
      balance
    );
    
    await new Promise(resolve => setTimeout(resolve, 1000));
    await updateSafetyOrders();

    if (activePosition.trailingInterval) clearInterval(activePosition.trailingInterval);
    
    activePosition.trailingInterval = setInterval(async () => {
      await checkPositionStatus();
      await updateBreakEvenStop(symbol);
      await updateTrailingStop(symbol);
    }, POSITION_CHECK_INTERVAL);

  } catch (error) {
    console.error('🔴 Помилка виконання ордера:', error.message);
    telegram.sendError('execute_order', error);
    setTimeout(() => executeOrder(type, symbol, amount), 10000);
  }
}

setInterval(() => {
  console.log('🕒 Стан позиції:', {
    id: activePosition.id,
    amount: activePosition.totalAmount,
    type: activePosition.type,
    entry: activePosition.entryPrice,
    breakEven: activePosition.breakEvenReached,
    trailing: activePosition.trailingActivated
  });
  
  if (ws) {
    console.log('🔌 Стан вебсокета:', ws.readyState === WebSocket.OPEN ? 'Підключено' : 'Відключено');
  } else {
    console.log('🔌 Вебсокет не ініціалізований');
  }
}, 30000);

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

    console.log('✅ Інтерфейс торгівлі ініціалізовано');
    return tradingInterface;
  } catch (error) {
    console.error('🔴 Критична помилка ініціалізації модуля торгівлі:', error);
    telegram.sendError('module_init_fatal', error);
    process.exit(1);
  }
}

module.exports = {
  initializeTradingModule
};