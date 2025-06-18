// executeOrder.js - Fixed version
const config = require('../config/config');
const { v4: uuidv4 } = require('uuid');
const telegram = require('../utils/telegramNotifier');
const WebSocket = require('ws');

// Import binance client properly
let binance = null;
const binancePromise = require('../utils/binanceClient');

// Initialize binance client
async function initializeBinanceClient() {
  if (!binance) {
    try {
      binance = await binancePromise;
      console.log('✅ Binance client initialized successfully');
    } catch (error) {
      console.error('🔴 Failed to initialize Binance client:', error.message);
      throw error;
    }
  }
  return binance;
}

// Ensure binance client is available before any operation
async function ensureBinanceClient() {
  if (!binance) {
    await initializeBinanceClient();
  }
  return binance;
}

// Вебсокет для відстеження закриття позицій
let ws = new WebSocket('wss://fstream.binance.com/ws/!forceOrder@arr');

function setupWebSocketHandlers() {
  // Обробник повідомлень WebSocket
  ws.on('message', async (data) => {
    try {
      const event = JSON.parse(data);
      if (event.o && (event.o.x === 'FILLED' || event.o.x === 'LIQUIDATED')) {
        console.log('🔵 Подія виконання:', event.o.s);
        await syncPositionWithExchange();
      }
    } catch (error) {
      console.error('🔴 Помилка вебсокета:', error);
    }
  });

  ws.on('error', (error) => {
    console.error('🔴 Вебсокет помилка:', error.message);
  });

  ws.on('close', (code, reason) => {
    console.log(`🔌 Вебсокет закрито: ${code} - ${reason}`);
    // Автоматичне перепідключення
    setTimeout(() => {
      console.log('🔌 Перепідключення вебсокета...');
      ws = new WebSocket('wss://fstream.binance.com/ws/!forceOrder@arr');
      setupWebSocketHandlers();
    }, 5000);
  });
  
  // Періодична перевірка з'єднання
  setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      console.log('🔌 Вебсокет неактивний, перепідключення...');
      ws = new WebSocket('wss://fstream.binance.com/ws/!forceOrder@arr');
      setupWebSocketHandlers();
    }
  }, 10000);
}

setupWebSocketHandlers();

// Параметри ризику
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
const ORDER_UPDATE_INTERVAL = 90000;
const POSITION_CHECK_INTERVAL = 30000;
const MIN_STOP_DISTANCE_PERCENT = 0.2;
const ORDER_RETRY_LIMIT = 3;

let accountBalance = 0;

async function initAccountBalance() {
  try {
    const client = await ensureBinanceClient();
    const balance = await safeExchangeCall(() => client.fetchBalance());
    accountBalance = balance.total?.USDT || balance.total?.usdt || 0;
    console.log(`💰 Початковий баланс: ${accountBalance} USDT`);
    return accountBalance;
  } catch (error) {
    console.error('🔴 Помилка отримання балансу:', error.message);
    if (telegram && telegram.sendError) {
      telegram.sendError('balance_init', error);
    }
    return 0;
  }
}

// Initialize balance after binance client is ready
binancePromise.then(() => {
  initAccountBalance();
}).catch(error => {
  console.error('🔴 Failed to initialize account balance:', error.message);
});

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
  if (!validateActivePosition()) return 0;
  
  const isLong = activePosition.type === 'buy';
  const priceDifference = isLong 
    ? (currentPrice - activePosition.entryPrice)
    : (activePosition.entryPrice - currentPrice);
  
  const rawProfitPercent = (priceDifference / activePosition.entryPrice) * 100;
  const effectiveProfit = rawProfitPercent - (COMMISSION_RATE * 100);
  
  return Math.max(0, effectiveProfit);
}

async function getCurrentBalance() {
  try {
    const client = await ensureBinanceClient();
    const balance = await safeExchangeCall(() => client.fetchBalance());
    accountBalance = balance.total?.USDT || balance.total?.usdt || 0;
    return accountBalance;
  } catch (error) {
    console.error('🔴 Помилка отримання балансу:', error.message);
    if (telegram && telegram.sendError) {
      telegram.sendError('balance_fetch', error);
    }
    return accountBalance;
  }
}

async function cancelPositionOrders() {
  if (!activePosition.id) return;
  try {
    const client = await ensureBinanceClient();
    await safeExchangeCall(() => client.cancelAllOrders(config.symbol));
    console.log('🗑️ Всі ордери скасовані');
    if (telegram && telegram.sendMessage) {
      telegram.sendMessage(`Скасовано ордери для ${config.symbol}`);
    }
  } catch (error) {
    console.error('🔴 Помилка скасування:', error.message);
    if (telegram && telegram.sendError) {
      telegram.sendError('cancel_orders', error);
    }
  }
}

function clearActivePosition() {
  if (activePosition.trailingInterval) {
    clearInterval(activePosition.trailingInterval);
    activePosition.trailingInterval = null;
  }
  
  // Скасування всіх ордерів перед очищенням
  ensureBinanceClient().then(client => {
    client.cancelAllOrders(config.symbol).catch(() => {});
  }).catch(() => {});
  
  // Повне скидання стану
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

// Синхронізація з біржею
async function syncPositionWithExchange() {
  try {
    const client = await ensureBinanceClient();
    const position = await safeExchangeCall(() => client.fetchPosition(config.symbol));
    const hasPosition = position && Math.abs(Number(position.contracts)) > 0;
    
    // Якщо позиція на біржі відсутня, але в нас є активна - очищаємо
    if (!hasPosition && activePosition.id) {
      console.log('🔄 Позиція закрита на біржі. Очищаємо стан...');
      clearActivePosition();
      return false;
    }
    
    // Синхронізація стану позиції
    if (hasPosition) {
      if (!activePosition.id) {
        console.log('🔄 Виявлено активну позицію на біржі. Синхронізація...');
        activePosition.id = generatePositionId();
        activePosition.type = position.side.toLowerCase();
        activePosition.totalAmount = Math.abs(Number(position.contracts));
        activePosition.entryPrice = Number(position.entryPrice);
        
        // Запускаємо моніторинг
        if (activePosition.trailingInterval) clearInterval(activePosition.trailingInterval);
        activePosition.trailingInterval = setInterval(async () => {
          await checkPositionStatus();
          await updateBreakEvenStop(config.symbol);
          await updateTrailingStop(config.symbol);
        }, POSITION_CHECK_INTERVAL);
        
        console.log('🔄 Синхронізовано активну позицію з біржі');
        await updateSafetyOrders();
      } else {
        // Оновити існуючу позицію
        activePosition.totalAmount = Math.abs(Number(position.contracts));
        activePosition.entryPrice = Number(position.entryPrice);
      }
    }
    
    return hasPosition;
  } catch (error) {
    console.error('🔴 Помилка синхронізації з біржею:', error.message);
    // Повторна спроба синхронізації через 5 секунд
    setTimeout(syncPositionWithExchange, 5000);
    return false;
  }
}

async function safeExchangeCall(fn, maxRetries = 3) {
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      console.error(`🔴 Помилка виклику API (спроба ${attempt}/${maxRetries}):`, error.message);
      
      // Автоматична синхронізація при помилках, пов'язаних з позицією
      if (error.message.includes('position') || error.message.includes('balance')) {
        await syncPositionWithExchange().catch(() => {});
      }
      
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
      }
    }
  }
  
  throw lastError;
}

async function closePosition(symbol) {
  try {
    await syncPositionWithExchange();
    
    if (!validateActivePosition()) {
      console.log('🔴 Немає активної позиції для закриття');
      return false;
    }
    
    const prevBalance = await getCurrentBalance();
    const client = await ensureBinanceClient();
    const realPosition = await safeExchangeCall(() => client.fetchPosition(config.symbol));
    
    if (!realPosition || Math.abs(Number(realPosition.contracts)) <= 0) {
      console.log('🟡 Реальна позиція на біржі не знайдена');
      clearActivePosition();
      return false;
    }
    
    const realAmount = Math.abs(Number(realPosition.contracts));
    const closeType = realPosition.side.toLowerCase() === 'long' ? 'sell' : 'buy';
    
    console.log(`🔵 Закриття позиції: ${realPosition.side} ${realAmount} ${symbol.replace('/USDT', '')}`);
    
    const closeOrder = await safeExchangeCall(() =>
      client.createMarketOrder(
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
    const newBalance = await getCurrentBalance();
    const profitAmount = newBalance - prevBalance;
    
    if (telegram && telegram.sendPositionClosed) {
      await telegram.sendPositionClosed(
        closePrice, 
        profitPercent, 
        profitAmount, 
        newBalance
      );
    }
    
    console.log(`✅ Позиція закрита: ${realAmount} по ${closePrice}`);
    clearActivePosition();
    
    setTimeout(async () => {
      await syncPositionWithExchange();
    }, 2000);
    
    return true;
  } catch (error) {
    console.error('🔴 Помилка закриття позиції:', error.message);
    if (telegram && telegram.sendError) {
      telegram.sendError('close_position', error);
    }
    await syncPositionWithExchange();
    return false;
  }
}

async function checkPositionStatus() {
  try {
    await syncPositionWithExchange();
  } catch (error) {
    console.error('🔴 Помилка перевірки:', error.message);
    if (telegram && telegram.sendError) {
      telegram.sendError('position_check', error);
    }
  }
}

async function createProtectedOrder(symbol, type, side, amount, price, params, maxAttempts = 3) {
  let attempt = 0;
  while (attempt < maxAttempts) {
    try {
      const client = await ensureBinanceClient();
      return await safeExchangeCall(() =>
        client.createOrder(symbol, type, side, amount, price, params)
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
    
    const client = await ensureBinanceClient();
    const ticker = await safeExchangeCall(() => client.fetchTicker(symbol));
    const currentPrice = ticker.last;
    const profitPercent = calculateCurrentProfit(currentPrice);
    
    if (profitPercent < MIN_PROFIT_FOR_BREAKEVEN) return;
    
    if (profitPercent >= BREAK_EVEN_LEVEL) {
      console.log(`🔵 Досягнуто рівень безубитку (${BREAK_EVEN_LEVEL}%): ${profitPercent.toFixed(2)}%`);
      if (telegram && telegram.sendMessage) {
        await telegram.sendMessage(`🔵 Досягнуто безубиток: ${profitPercent.toFixed(2)}%`);
      }
      
      await new Promise(resolve => setTimeout(resolve, 3000));
      await cancelPositionOrders();
      
      const stopPrice = client.priceToPrecision(symbol, activePosition.entryPrice);
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
      if (telegram && telegram.sendMessage) {
        await telegram.sendMessage('🟢 Стоп переміщено на беззбитковість');
      }
      await updateSafetyOrders();
    }
  } catch (error) {
    console.error('🔴 Помилка безубитковості:', error.message);
    if (telegram && telegram.sendError) {
      telegram.sendError('break_even_stop', error);
    }
  }
}

async function updateTrailingStop(symbol) {
  try {
    if (!validateActivePosition() || !activePosition.entryPrice) return;
    
    const now = Date.now();
    if (now - activePosition.lastTrailingUpdate < ORDER_UPDATE_INTERVAL) return;

    const client = await ensureBinanceClient();
    const ticker = await safeExchangeCall(() => client.fetchTicker(symbol));
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
          stopPrice: client.priceToPrecision(symbol, safeNewStop),
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
          stopPrice: client.priceToPrecision(symbol, tpPrice),
          reduceOnly: true,
          newClientOrderId: generateOrderId()
        }
      );
      
      activePosition.trailingActivated = true;
      activePosition.lastTrailingUpdate = now;
      
      console.log(`🔄 Трейлінг-стоп активовано: ${safeNewStop.toFixed(2)}`);
      if (telegram && telegram.sendPositionUpdated) {
        await telegram.sendPositionUpdated(safeNewStop, tpPrice, profitPercent);
      }
    }
  } catch (error) {
    console.error('🔴 Помилка трейлінгу:', error.message);
    if (telegram && telegram.sendError) {
      telegram.sendError('trailing_stop', error);
    }
  }
}

async function updateSafetyOrders(attempt = 1) {
  // Перевірка наявності активної позиції
  if (!validateActivePosition()) {
    console.log('🟡 Немає активної позиції, оновлення ордерів пропущено');
    return;
  }
  
  try {
    await syncPositionWithExchange();
    
    // Повторна перевірка після синхронізації
    if (!validateActivePosition()) {
      console.log('🟡 Позиція зникла після синхронізації, оновлення пропущено');
      return;
    }
    
    console.log(`🛡️ Оновлення ордерів (спроба ${attempt}) для суми: ${activePosition.totalAmount}`);
    
    const riskParams = getCurrentRiskParams();
    const [tpPrice, slPrice] = calculatePrices(
      activePosition.type, 
      activePosition.entryPrice,
      riskParams
    );

    const client = await ensureBinanceClient();
    const ticker = await safeExchangeCall(() => client.fetchTicker(config.symbol));
    const currentPrice = ticker.last;
    const minStopDistance = currentPrice * (MIN_STOP_DISTANCE_PERCENT / 100);
    const isLong = activePosition.type === 'buy';
    
    const safeSlPrice = isLong 
      ? Math.min(slPrice, currentPrice - minStopDistance)
      : Math.max(slPrice, currentPrice + minStopDistance);
    
    await cancelPositionOrders();
    
    // Створення TP ордера
    await createProtectedOrder(
      config.symbol,
      'TAKE_PROFIT_MARKET',
      activePosition.type === 'buy' ? 'sell' : 'buy',
      activePosition.totalAmount,
      undefined,
      {
        stopPrice: client.priceToPrecision(config.symbol, tpPrice),
        reduceOnly: true,
        newClientOrderId: generateOrderId()
      }
    );

    // Створення SL ордера
    await createProtectedOrder(
      config.symbol,
      'STOP_MARKET',
      activePosition.type === 'buy' ? 'sell' : 'buy',
      activePosition.totalAmount,
      undefined,
      {
        stopPrice: client.priceToPrecision(config.symbol, safeSlPrice),
        reduceOnly: true,
        newClientOrderId: generateOrderId()
      }
    );

    console.log(`🛡️ Оновлено ордери на ${activePosition.totalAmount}: TP ${tpPrice.toFixed(2)}, SL ${safeSlPrice.toFixed(2)}`);
    if (telegram && telegram.sendMessage) {
      await telegram.sendMessage(`🛡️ Оновлено ордери на ${activePosition.totalAmount}: TP ${tpPrice.toFixed(2)}, SL ${safeSlPrice.toFixed(2)}`);
    }
  } catch (error) {
    console.error(`🔴 Помилка оновлення ордерів (спроба ${attempt}):`, error.message);
    
    if (attempt < ORDER_RETRY_LIMIT) {
      console.log(`🔄 Повторна спроба оновити ордери через 5 секунд...`);
      setTimeout(() => updateSafetyOrders(attempt + 1), 5000);
    } else {
      if (telegram && telegram.sendError) {
        telegram.sendError('update_orders_failed', error);
      }
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
    const balance = await getCurrentBalance();
    await syncPositionWithExchange();
    
    // Закриття позиції при зміні напрямку
    if (validateActivePosition() && activePosition.type !== type) {
      console.log(`🔄 Сигнал зміни напрямку: ${activePosition.type.toUpperCase()} → ${type.toUpperCase()}`);
      if (telegram && telegram.sendMessage) {
        await telegram.sendMessage(`🔄 Зміна напряму: ${activePosition.type.toUpperCase()} → ${type.toUpperCase()}`);
      }
      
      if (!await closePosition(symbol)) {
        console.log('🟠 Повторна спроба закриття...');
        if (telegram && telegram.sendMessage) {
          await telegram.sendMessage('🟠 Повторна спроба закриття позиції');
        }
        await new Promise(resolve => setTimeout(resolve, 2000));
        await closePosition(symbol);
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // Додавання до існуючої позиції
    if (validateActivePosition() && activePosition.type === type) {
      const client = await ensureBinanceClient();
      const order = await safeExchangeCall(() =>
        client.createMarketOrder(
          symbol,
          type,
          amount,
          { newClientOrderId: generateOrderId() }
        )
      );
      
      const orderPrice = parseFloat(order.average);
      const totalCost = (activePosition.entryPrice * activePosition.totalAmount) + 
                       (orderPrice * amount);
      activePosition.totalAmount += amount;
      activePosition.entryPrice = totalCost / activePosition.totalAmount;
      activePosition.breakEvenReached = false;
      
      console.log(`🔵 Додано ${amount} ${symbol.replace('/USDT', '')} по ${orderPrice}. Нова сума: ${activePosition.totalAmount}`);
      if (telegram && telegram.sendMessage) {
        await telegram.sendMessage(`🔵 Додано ${amount} ${symbol.replace('/USDT', '')} по ${orderPrice}. Загальна сума: ${activePosition.totalAmount}`);
      }
      
      await updateSafetyOrders();
      return;
    }

    // Відкриття нової позиції
    await cancelPositionOrders();
    activePosition.id = generatePositionId();
    activePosition.type = type;
    activePosition.totalAmount = amount;
    activePosition.breakEvenReached = false;
    activePosition.trailingActivated = false;

    const client = await ensureBinanceClient();
    const order = await safeExchangeCall(() =>
      client.createMarketOrder(
        symbol,
        type,
        amount,
        { newClientOrderId: generateOrderId() }
      )
    );
    
    activePosition.entryPrice = parseFloat(order.average);
    const riskParams = getCurrentRiskParams();
    const [tpPrice, slPrice] = calculatePrices(
      type, 
      activePosition.entryPrice,
      riskParams
    );
    
    if (telegram && telegram.sendPositionOpened) {
      await telegram.sendPositionOpened(
        type,
        symbol,
        amount,
        activePosition.entryPrice,
        tpPrice,
        slPrice,
        balance
      );
    }
    
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
    if (telegram && telegram.sendError) {
      telegram.sendError('execute_order', error);
    }
    setTimeout(() => executeOrder(type, symbol, amount), 10000);
  }
}

// Додаткове логування стану
setInterval(() => {
  console.log('🕒 Стан позиції:', {
    id: activePosition.id,
    amount: activePosition.totalAmount,
    type: activePosition.type,
    entry: activePosition.entryPrice,
    breakEven: activePosition.breakEvenReached,
    trailing: activePosition.trailingActivated
  });
  
  console.log('🔌 Стан вебсокета:', ws.readyState === WebSocket.OPEN ? 'Підключено' : 'Відключено');
}, 30000);

module.exports = { 
  executeOrder, 
  checkPositionStatus,
  getActivePosition: () => active}