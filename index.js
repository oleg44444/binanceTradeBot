require('dotenv').config();
const fetchOHLCV = require('./data/fetchOHLCV');
const { calculateATR } = require('./indicators/atr');
const { calculateMACD } = require('./indicators/macd');
const { checkBuySignal, checkSellSignal } = require('./strategy/signalCheck');
const config = require('./config/config');
const binanceClientPromise = require('./utils/binanceClient');

process.on('uncaughtException', (error) => {
  console.error('Невідловлена помилка:', error.message);
  console.error(error.stack);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('Невідловлена відмова:', reason);
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

async function setLeverageWithRetry(binance, symbol, leverage, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await binance.setLeverage(leverage, symbol);
      return true;
    } catch (error) {
      console.error(`🔴 Помилка встановлення плеча (спроба ${attempt}):`, error.message);
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }
  throw new Error(`Не вдалося встановити плече після ${maxRetries} спроб`);
}

async function initializeBot(binance) {
  try {
    console.log('🚀 Початок ініціалізації бота...');
    
    try {
      await binance.setMarginType(config.symbol, 'ISOLATED');
      console.log(`ℹ️ Тип маржі встановлено на ISOLATED для ${config.symbol}`);
    } catch (marginError) {
      console.warn('🟠 Попередження при встановленні типу маржі:', marginError.message);
    }
    
    await setLeverageWithRetry(binance, config.symbol, config.leverage || 20);
    
    let usdtBalance = 0;
    try {
      const balance = await binance.fetchBalance();
      usdtBalance = balance.total?.USDT || 
                    balance.USDT?.total || 
                    balance.total?.usdt || 
                    balance.usdt?.total || 
                    0;
    } catch (balanceError) {
      console.error('🔴 Помилка отримання балансу:', balanceError.message);
    }
    
    console.log('💰 Початковий баланс:', usdtBalance);
    console.log('✅ Ініціалізація завершена успішно');
    return true;
  } catch (error) {
    console.error('🔴 Критична помилка ініціалізації:', error);
    throw error;
  }
}

async function runBot(binance, trading) {
  try {
    await safeRequest(async () => {
      let serverDate;
      try {
        const serverTime = await binance.fetchTime();
        serverDate = new Date(serverTime).toISOString();
      } catch (timeError) {
        console.error('⚠️ Using local time:', timeError.message);
        serverDate = new Date().toISOString();
      }
      
      console.log('\n--- Data Update ---');
      console.log(`Request #${requestCount}/${MAX_REQUESTS_PER_MINUTE}`);
      console.log(`Exchange Time (UTC): ${serverDate}`);

      let candles;
      try {
        candles = await fetchOHLCV(config.symbol, config.timeframe);
      } catch (err) {
        throw new Error(`Candle loading error: ${err.message}`);
      }

      if (!Array.isArray(candles) || candles.length < 50) {
        throw new Error(`Insufficient OHLCV data (${candles?.length || 0} items)`);
      }

      const currentPrice = Array.isArray(candles[candles.length - 1]) 
        ? candles[candles.length - 1][4]
        : candles[candles.length - 1].close;
      
      console.log(`📊 Current Price: ${currentPrice}`);

      const atrPeriod = 14;
      let currentATR = 0;
      let atrValues = [];
      
      try {
        atrValues = calculateATR(candles, atrPeriod);
        if (Array.isArray(atrValues) && atrValues.length > 0) {
          currentATR = atrValues[atrValues.length - 1] || 0;
          console.log(`📈 ATR: ${currentATR?.toFixed(6)} (${atrValues.length} values)`);
        } else {
          console.warn('⚠️ ATR calculation returned empty array');
          currentATR = 0;
        }
      } catch (atrError) {
        console.error('⚠️ ATR calculation error:', atrError.message);
        currentATR = 0;
      }
      
      let macdData = null;
      let currentMacd = 0;
      let currentSignal = 0;
      let currentHistogram = 0;
      
      try {
        macdData = calculateMACD(candles);
        
        if (macdData && 
            Array.isArray(macdData.macd) && 
            Array.isArray(macdData.signal) && 
            Array.isArray(macdData.histogram) &&
            macdData.macd.length > 0 && 
            macdData.signal.length > 0 &&
            macdData.histogram.length > 0) {
          
          currentMacd = macdData.macd[macdData.macd.length - 1] || 0;
          currentSignal = macdData.signal[macdData.signal.length - 1] || 0;
          currentHistogram = macdData.histogram[macdData.histogram.length - 1] || 0;
          
          console.log(`📉 MACD: ${currentMacd?.toFixed(6)}`);
          console.log(`📊 Signal: ${currentSignal?.toFixed(6)}`);
          console.log(`📊 Histogram: ${currentHistogram?.toFixed(6)}`);
        } else {
          console.warn('⚠️ MACD data structure is invalid or empty');
          macdData = {
            macd: [0],
            signal: [0],
            histogram: [0]
          };
        }
      } catch (macdError) {
        console.error('⚠️ MACD calculation error:', macdError.message);
        macdData = {
          macd: [0],
          signal: [0],
          histogram: [0]
        };
      }
      
      let buySignal = false;
      let sellSignal = false;
      
      try {
        if (macdData && 
            macdData.macd.length > 0 && 
            macdData.signal.length > 0 &&
            atrValues.length > 0 &&
            currentPrice > 0) {
          
          buySignal = checkBuySignal(candles, atrValues, macdData);
          sellSignal = checkSellSignal(candles, atrValues, macdData);
          
          console.log(`🔍 Buy Signal: ${buySignal ? '✅ YES' : '❌ NO'}`);
          console.log(`🔍 Sell Signal: ${sellSignal ? '✅ YES' : '❌ NO'}`);
        } else {
          console.warn('⚠️ Insufficient data for signal checking');
          console.log(`🔍 Buy Signal: ❌ NO (insufficient data)`);
          console.log(`🔍 Sell Signal: ❌ NO (insufficient data)`);
        }
      } catch (signalError) {
        console.error('⚠️ Signal checking error:', signalError.message);
        buySignal = false;
        sellSignal = false;
        console.log(`🔍 Buy Signal: ❌ NO (error)`);
        console.log(`🔍 Sell Signal: ❌ NO (error)`);
      }
      
      if (buySignal && !sellSignal) {
        console.log('🟢 Buy signal received!');
        
        try {
          const balance = await trading.getAccountBalance();
          const riskPercent = config.riskPercent || 2;
          const leverage = config.leverage || 20;
          const positionSize = (balance * riskPercent / 100) * leverage;
          const quantity = positionSize / currentPrice;
          
          console.log(`💰 Position size: ${quantity.toFixed(6)} ${config.symbol}`);
          console.log(`💰 Position value: ${positionSize.toFixed(2)} USDT`);
          
          await trading.executeOrder('buy', config.symbol, quantity);
          await handlePostOrderPause();
        } catch (orderError) {
          console.error('🔴 Buy order execution error:', orderError.message);
        }
        
      } else if (sellSignal && !buySignal) {
        console.log('🔴 Sell signal received!');
        
        try {
          const balance = await trading.getAccountBalance();
          const riskPercent = config.riskPercent || 2;
          const leverage = config.leverage || 20;
          const positionSize = (balance * riskPercent / 100) * leverage;
          const quantity = positionSize / currentPrice;
          
          console.log(`💰 Position size: ${quantity.toFixed(6)} ${config.symbol}`);
          console.log(`💰 Position value: ${positionSize.toFixed(2)} USDT`);
          
          await trading.executeOrder('sell', config.symbol, quantity);
          await handlePostOrderPause();
        } catch (orderError) {
          console.error('🔴 Sell order execution error:', orderError.message);
        }
      }
      
      console.log(`📊 Data Summary:`);
      console.log(`   Candles: ${candles.length}`);
      console.log(`   ATR values: ${atrValues.length}`);
      console.log(`   MACD values: ${macdData?.macd?.length || 0}`);
      console.log(`   Current price: ${currentPrice}`);
      console.log(`   Current ATR: ${currentATR?.toFixed(6)}`);
      console.log(`   MACD trend: ${currentMacd > currentSignal ? '📈 Bullish' : '📉 Bearish'}`);
    });
  } catch (error) {
    console.error('❌ Update cycle error:', error.message);
    console.error('❌ Error stack:', error.stack);
  } finally {
    setTimeout(() => runBot(binance, trading), config.updateInterval);
  }
}

async function handlePostOrderPause() {
  console.log('⏳ Пауза 10 секунд...');
  await new Promise(resolve => setTimeout(resolve, 10000));
  requestCount += 2;
}

async function main() {
  try {
    console.log('🚀 Бот запущено');
    
    const binance = await binanceClientPromise(); 
    console.log('✅ Binance клієнт готовий до роботи');
    
    await initializeBot(binance);
    
    const tradingModule = require('./trading/executeOrder');
    
    const trading = await tradingModule.initializeTradingModule();
    
    console.log('✅ Модуль торгівлі готовий до роботи');
    
    runBot(binance, trading);
  } catch (error) {
    console.error('🔴 Фатальна помилка при запуску бота:', error);
    process.exit(1);
  }
}

main();