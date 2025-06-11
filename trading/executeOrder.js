const binance = require('../utils/binanceClient');
const config = require('../config/config');
const { v4: uuidv4 } = require('uuid');
const telegram = require('../utils/telegramNotifier');
const WebSocket = require('ws');

// Вебсокет для відстеження закриття позицій
let ws = new WebSocket('wss://fstream.binance.com/ws/!forceOrder@arr');

function setupWebSocketHandlers() {
  // Обробник повідомлень WebSocket
  ws.on('message', async (data) => {
    try {
      const event = JSON.parse(data);
      if (event.o.x === 'FILLED') {
        console.log('🔵 Ордер виконано:', event.o.s);
        
        // Затримка для обробки змін на біржі
        await new Promise(resolve => setTimeout(resolve, 2000));
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
      ws = new WebSocket('wss://fstream.binance.com/ws/!forceOrder@arr');
      setupWebSocketHandlers();
    }, 5000);
  });
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
const ORDER_RETRY_LIMIT = 3; // Максимальна кількість спроб оновити ордери

let accountBalance = 0;

async function initAccountBalance() {
  try {
    const balance = await binance.fetchBalance();
    accountBalance = balance.total?.USDT || balance.total?.usdt || 0;
    console.log(`💰 Початковий баланс: ${accountBalance} USDT`);
    return accountBalance;
  } catch (error) {
    console.error('🔴 Помилка отримання балансу:', error.message);
    telegram.sendError('balance_init', error);
    return 0;
  }
}

initAccountBalance();

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
  if (!activePosition.id || !activePosition.entryPrice) return 0;
  
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
    const balance = await binance.fetchBalance();
    accountBalance = balance.total?.USDT || balance.total?.usdt || 0;
    return accountBalance;
  } catch (error) {
    console.error('🔴 Помилка отримання балансу:', error.message);
    telegram.sendError('balance_fetch', error);
    return accountBalance;
  }
}

async function cancelPositionOrders() {
  if (!activePosition.id) return;
  try {
    await binance.cancelAllOrders(config.symbol);
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
  
  activePosition.id = null;
  activePosition.type = null;
  activePosition.totalAmount = 0;
  activePosition.entryPrice = 0;
  activePosition.breakEvenReached = false;
  activePosition.trailingActivated = false;
  activePosition.lastTrailingUpdate = 0;
  
  console.log('🧹 Активну позицію очищено');
}

// Синхронізація з біржею
async function syncPositionWithExchange() {
  try {
    const position = await binance.getPosition(config.symbol);
    const hasPosition = position && Math.abs(Number(position.contracts)) > 0;
    
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
    } else {
      if (activePosition.id) {
        console.log('🔄 Позиція закрита на біржі. Очищаємо стан...');
        clearActivePosition();
      }
    }
    
    return hasPosition;
  } catch (error) {
    console.error('🔴 Помилка синхронізації з біржею:', error.message);
    return false;
  }
}

async function closePosition(type, symbol) {
  try {
    if (!activePosition.id) {
      const hasRealPosition = await syncPositionWithExchange();
      if (!hasRealPosition) {
        console.log('🔴 Немає активної позиції для закриття');
        return false;
      }
    }
    
    const prevBalance = await getCurrentBalance();
    console.log(`🔵 Закриття ${type.toUpperCase()} позиції (${activePosition.totalAmount} ${symbol.replace('/USDT', '')})`);
    
    const closeOrder = await binance.createMarketOrder(
      symbol,
      type,
      activePosition.totalAmount,
      { newClientOrderId: generateOrderId() }
    );
    
    const closePrice = parseFloat(closeOrder.average);
    const profitPercent = calculateCurrentProfit(closePrice);
    const newBalance = await getCurrentBalance();
    const profitAmount = newBalance - prevBalance;
    
    // Відправляємо звіт про закриття
    await telegram.sendPositionClosed(
      closePrice, 
      profitPercent, 
      profitAmount, 
      newBalance
    );
    
    // Очищаємо активну позицію
    clearActivePosition();
    
    // Перевірка реального стану через 2 секунди
    setTimeout(async () => {
      await syncPositionWithExchange();
    }, 2000);
    
    return true;
  } catch (error) {
    console.error('🔴 Помилка закриття позиції:', error.message);
    telegram.sendError('close_position', error);
    
    // Примусова синхронізація після помилки
    await syncPositionWithExchange();
    
    return false;
  }
}

async function checkPositionStatus() {
  try {
    // Синхронізуємо з реальним станом на біржі
    const hasRealPosition = await syncPositionWithExchange();
    
    if (!hasRealPosition && activePosition.id) {
      console.log('🟢 Позиція закрита на біржі, але не в боті. Очищаємо...');
      clearActivePosition();
    }
  } catch (error) {
    console.error('🔴 Помилка перевірки:', error.message);
    telegram.sendError('position_check', error);
  }
}

async function createProtectedOrder(symbol, type, side, amount, price, params, maxAttempts = 3) {
  let attempt = 0;
  while (attempt < maxAttempts) {
    try {
      return await binance.createOrder(symbol, type, side, amount, price, params);
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
      
      // Затримка перед повторною спробою
      await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
    }
  }
}

async function updateBreakEvenStop(symbol) {
  try {
    if (!activePosition.id || activePosition.breakEvenReached) return;
    
    const ticker = await binance.fetchTicker(symbol);
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
    if (!activePosition.id || !activePosition.entryPrice) return;
    
    const now = Date.now();
    if (now - activePosition.lastTrailingUpdate < ORDER_UPDATE_INTERVAL) return;

    const ticker = await binance.fetchTicker(symbol);
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
  if (!activePosition.id) return;
  
  try {
    console.log(`🛡️ Оновлення ордерів (спроба ${attempt}) для суми: ${activePosition.totalAmount}`);
    
    const riskParams = getCurrentRiskParams();
    const [tpPrice, slPrice] = calculatePrices(
      activePosition.type, 
      activePosition.entryPrice,
      riskParams
    );

    const ticker = await binance.fetchTicker(config.symbol);
    const currentPrice = ticker.last;
    
    const minStopDistance = currentPrice * (MIN_STOP_DISTANCE_PERCENT / 100);
    const isLong = activePosition.type === 'buy';
    
    const safeSlPrice = isLong 
      ? Math.min(slPrice, currentPrice - minStopDistance)
      : Math.max(slPrice, currentPrice + minStopDistance);
    
    await cancelPositionOrders();
    
    // Перевірка актуальності позиції перед створенням ордерів
    if (activePosition.totalAmount <= 0) {
      console.log('🟡 Сума позиції нульова, оновлення ордерів пропущено');
      return;
    }
    
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

    console.log(`🛡️ Оновлено ордери: TP ${tpPrice.toFixed(2)}, SL ${safeSlPrice.toFixed(2)}`);
    await telegram.sendMessage(`🛡️ Оновлено ордери: TP ${tpPrice.toFixed(2)}, SL ${safeSlPrice.toFixed(2)}`);
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
    const balance = await getCurrentBalance();
    
    // Синхронізуємо стан перед виконанням операції
    await syncPositionWithExchange();
    
    if (activePosition.id && activePosition.type !== type) {
      console.log(`🔄 Сигнал зміни напрямку: ${activePosition.type.toUpperCase()} → ${type.toUpperCase()}`);
      await telegram.sendMessage(`🔄 Зміна напряму: ${activePosition.type.toUpperCase()} → ${type.toUpperCase()}`);
      
      const closeType = activePosition.type === 'buy' ? 'sell' : 'buy';
      if (!await closePosition(closeType, symbol)) {
        console.log('🟠 Повторна спроба закриття...');
        await telegram.sendMessage('🟠 Повторна спроба закриття позиції');
        await new Promise(resolve => setTimeout(resolve, 2000));
        await closePosition(closeType, symbol);
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    activePosition.trailingActivated = false;
    const riskParams = getCurrentRiskParams();
    
    if (activePosition.id && activePosition.type === type) {
      const order = await binance.createMarketOrder(
        symbol,
        type,
        amount,
        { newClientOrderId: generateOrderId() }
      );
      
      const orderPrice = parseFloat(order.average);
      const totalCost = (activePosition.entryPrice * activePosition.totalAmount) + 
                       (orderPrice * amount);
      activePosition.totalAmount += amount;
      activePosition.entryPrice = totalCost / activePosition.totalAmount;
      activePosition.breakEvenReached = false;
      
      console.log(`🔵 Додано ${amount} ${symbol.replace('/USDT', '')} по ${orderPrice}. Нова сума: ${activePosition.totalAmount}`);
      await telegram.sendMessage(`🔵 Додано ${amount} ${symbol.replace('/USDT', '')} по ${orderPrice}. Загальна сума: ${activePosition.totalAmount}`);
      
      // Оновлюємо ордери на всю суму позиції
      await updateSafetyOrders();
      return;
    }

    await cancelPositionOrders();
    activePosition.id = generatePositionId();
    activePosition.type = type;
    activePosition.totalAmount = amount;
    activePosition.breakEvenReached = false;
    activePosition.trailingActivated = false;

    const order = await binance.createMarketOrder(
      symbol,
      type,
      amount,
      { newClientOrderId: generateOrderId() }
    );
    
    activePosition.entryPrice = parseFloat(order.average);
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

module.exports = { 
  executeOrder, 
  checkPositionStatus,
  getActivePosition: () => activePosition,
  getAccountBalance: () => accountBalance,
  createProtectedOrder,
  syncPositionWithExchange
};