'use strict';

require('dotenv').config();
const fetchOHLCV = require('./data/fetchOHLCV');
const { calculateATR } = require('./indicators/atr');
const { calculateMACD } = require('./indicators/macd');
const { checkBuySignal, checkSellSignal } = require('./strategy/signalCheck');
const { executeOrder } = require('./trading/executeOrder');
const config = require('./config/config');
const binance = require('./utils/binanceClient');
const WebSocket = require('ws');
const { checkPositionStatus } = require('./trading/executeOrder');

// Обробники невідловлених помилок
process.on('uncaughtException', (error) => {
  console.error('Невідловлена помилка:', error.message);
  console.error(error.stack);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('Невідловлена відмова:', reason);
});

// Вебсокет для відстеження закриття позицій
const ws = new WebSocket('wss://fstream.binance.com/ws/!forceOrder@arr');

ws.on('message', (data) => {
  try {
    const event = JSON.parse(data);
    if (event.o.x === 'FILLED') {
      console.log('🔵 Ордер виконано:', event.o.s);
      checkPositionStatus();
    }
  } catch (error) {
    console.error('🔴 Помилка вебсокета:', error);
  }
});

ws.on('error', (error) => {
  console.error('🔴 Вебсокет помилка:', error.message);
});

let requestCount = 0;
const MAX_REQUESTS_PER_MINUTE = config.maxRequestsPerMinute || 50;

async function safeRequest(fn) {
  if (requestCount >= MAX_REQUESTS_PER_MINUTE) {
    console.log('⏳ Досягнуто ліміт API. Пауза 60с...');
    await new Promise(resolve => setTimeout(resolve, 60000));
    requestCount = 0;
  }
  requestCount++;
  return await fn();
}

if (!config.updateInterval) {
  console.error('❌ Вкажіть updateInterval у config/config.js');
  process.exit(1);
}

process.on('SIGINT', () => {
  console.log('\n🔴 Бот зупинено вручну');
  process.exit();
});

// Функція для встановлення плеча з повторними спробами
async function setLeverageWithRetry(symbol, leverage, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await binance.setLeverage(leverage, symbol);
      console.log(`✅ Встановлено плече ${leverage}x для ${symbol}`);
      return true;
    } catch (error) {
      console.error(`🔴 Помилка встановлення плеча (спроба ${attempt}):`, error.message);
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 2000)); // Пауза 2 секунди
      }
    }
  }
  throw new Error(`Не вдалося встановити плече після ${maxRetries} спроб`);
}

// Ініціалізація бота: встановлення маржі та плеча
async function initializeBot() {
  try {
    // Встановлення типу маржі
    await binance.setMarginMode('ISOLATED', config.symbol);
    console.log(`ℹ️ Тип маржі встановлено на ISOLATED для ${config.symbol}`);
    
    // Встановлення плеча з повторними спробами
    await setLeverageWithRetry(config.symbol, config.leverage || 20);
    
    // Отримання балансу
    const balance = await binance.fetchBalance();
    console.log('💰 Initial balance:', balance.USDT);
    
    return true;
  } catch (error) {
    console.error('🔴 Критична помилка ініціалізації:', error);
    throw error;
  }
}

async function runBot() {
  try {
    await safeRequest(async () => {
      const serverTime = await binance.fetchTime();
      const serverDate = new Date(serverTime);
      
      console.log('\n--- Оновлення даних ---');
      console.log(`Запит №${requestCount}/${MAX_REQUESTS_PER_MINUTE}`);
      console.log(`Час біржі (UTC): ${serverDate.toISOString()}`);

      // Отримання даних свічок
      let candles;
      try {
        candles = await fetchOHLCV(config.symbol, config.timeframe);
      } catch (err) {
        throw new Error(`Помилка завантаження свічок: ${err.message}`);
      }

      // Сувора перевірка даних
      if (!Array.isArray(candles) || candles.length === 0) {
        throw new Error('Немає даних OHLCV');
      }
      console.log(`✅ Отримано ${candles.length} свічок`);

      // Розрахунок індикаторів з перевіркою вхідних даних
      let atr, macd;
      try {
        atr = calculateATR(candles, 14);
        macd = calculateMACD(candles.map(c => c.close));
      } catch (indicatorError) {
        throw new Error(`Помилка індикаторів: ${indicatorError.message}`);
      }

      // Перевірка сигналів
      let buySignal = false, sellSignal = false;
      try {
        // Додано перевірку наявності необхідних даних
        if (candles && atr && macd) {
          buySignal = checkBuySignal(candles, atr, macd);
          sellSignal = checkSellSignal(candles, atr, macd);
        } else {
          console.error('🚨 Недостатньо даних для перевірки сигналів');
        }
      } catch (signalError) {
        console.error('🚨 Помилка перевірки сигналів:', signalError.message);
      }

      console.log('--- Сигнали ---');
      console.log('Buy Signal:', buySignal);
      console.log('Sell Signal:', sellSignal);

      if (buySignal) {
        console.log('🟢 Сигнал на КУПІВЛЮ');
        await executeOrder('buy', config.symbol, config.tradeAmount);
        await handlePostOrderPause();
      } else if (sellSignal) {
        console.log('🔴 Сигнал на ПРОДАЖ');
        await executeOrder('sell', config.symbol, config.tradeAmount);
        await handlePostOrderPause();
      } else {
        console.log('⏸️ Сигналів немає');
      }
    });
  } catch (error) {
    console.error('❌ Помилка в циклі оновлення:', error.message);
    console.error(error.stack); // Додатковий стек помилок для діагностики
  } finally {
    setTimeout(runBot, config.updateInterval);
  }
}

async function handlePostOrderPause() {
  console.log('⏳ Пауза 10 секунд...');
  await new Promise(resolve => setTimeout(resolve, 10000));
  requestCount += 2;  // Компенсація за додаткові запити
}

// Головна функція запуску
async function main() {
  try {
    console.log('🟢 Telegram сповіщення увімкнено');
    console.log('🚀 Бот запущено');
    
    // Ініціалізація бота
    await initializeBot();
    
    // Запуск основного циклу
    runBot();
  } catch (error) {
    console.error('🔴 Фатальна помилка при запуску бота:', error);
    process.exit(1);
  }
}

main();