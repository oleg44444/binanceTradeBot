require('dotenv').config();

const fetchOHLCV = require('./data/fetchOHLCV');
const { calculateAllIndicators, checkBuySignal, checkSellSignal, calculateStopsAndTP } = require('./strategy/strategy');
const config = require('./config/config');
const binanceClientPromise = require('./utils/binanceClient');
const { initializeTradingModule } = require('./trading/executeOrder');
const { handleTradeSignal } = require('./trading/positionManager');

let binance;
let trading;
let isRunning = false;
let lastSignalTime = 0;
const SIGNAL_COOLDOWN = 60000; // 1 хвилина

process.on('uncaughtException', (error) => {
  console.error('🔴 Невідловлена помилка:', error.message);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('🔴 Невідловлена відмова:', reason);
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\n🔴 Бот зупинено');
  process.exit(0);
});

async function initializeBot() {
  try {
    console.log('🚀 Запуск бота...');
    binance = await binanceClientPromise();
    console.log('✅ Binance клієнт підключено');

    await binance.setMarginType(config.symbol, 'ISOLATED');
    await binance.setLeverage(config.leverage || 20, config.symbol);
    console.log(`✅ Налаштовано плече: ${config.leverage || 20}x`);

    trading = await initializeTradingModule(binance);
    await trading.syncPositionWithExchange?.();
    const balance = await trading.getAccountBalance();
    console.log(`💰 Початковий баланс: ${balance.toFixed(2)} USDT`);

    return true;
  } catch (error) {
    console.error('🔴 Помилка ініціалізації:', error.message);
    throw error;
  }
}

/**
 * Основний цикл торгівлі - розрахунок індикаторів за TradingView логікою
 */
async function runTradingCycle() {
  if (!isRunning) return;

  try {
    console.log('\n=== 📊 Цикл аналізу ===');
    console.log(`🕐 Час: ${new Date().toLocaleString()}`);

    // Завантажуємо свічки
    const candles = await fetchOHLCV(config.symbol, config.timeframe);
    if (!candles || candles.length < 50) {
      console.warn('⚠️ Недостатньо даних для аналізу');
      return;
    }

    const currentPrice = candles[candles.length - 1][4];
    console.log(`📊 Поточна ціна: ${currentPrice}`);

    // Розраховуємо всі індикатори (ATR, Wave patterns, MACD)
    const indicators = calculateAllIndicators(candles);
    
    if (!indicators.isValid) {
      console.warn('⚠️', indicators.error || 'Індикатори не розраховані');
      return;
    }

    // Розраховуємо ATR та параметри позиції
    const atr = indicators.atr;
    console.log(`📈 ATR: ${atr.toFixed(4)}`);
    console.log(`📊 Wave Length: ${indicators.waveLengthDynamic}`);
    console.log(`🌊 Wave High: ${indicators.waves.waveHigh.toFixed(2)}, Wave Low: ${indicators.waves.waveLow.toFixed(2)}`);

    // Розраховуємо MACD значення
    const macdLine = indicators.macd.macdLine[indicators.macd.macdLine.length - 1];
    const signalLine = indicators.macd.signalLine[indicators.macd.signalLine.length - 1];
    const macdHistogram = macdLine - signalLine;
    console.log(`📊 MACD: ${macdLine?.toFixed(6) || 'N/A'}, Signal: ${signalLine?.toFixed(6) || 'N/A'}, Hist: ${macdHistogram?.toFixed(6) || 'N/A'}`);

    // Перевіряємо сигнали
    const buySignalInfo = checkBuySignal(indicators);
    const sellSignalInfo = checkSellSignal(indicators);
    
    console.log(`🔍 BUY Signal: ${buySignalInfo.signal ? '✅' : '❌'}`);
    if (buySignalInfo.signal === false && !buySignalInfo.reason) {
      console.log(`   - Wave Up: ${buySignalInfo.waveUpCondition ? '✅' : '❌'} (${buySignalInfo.waveChangeUp.toFixed(6)})`);
      console.log(`   - MACD Crossover: ${buySignalInfo.macdCrossoverCondition ? '✅' : '❌'}`);
      console.log(`   - Price Confirm: ${buySignalInfo.priceConfirm ? '✅' : '❌'}`);
    }
    
    console.log(`🔍 SELL Signal: ${sellSignalInfo.signal ? '✅' : '❌'}`);
    if (sellSignalInfo.signal === false && !sellSignalInfo.reason) {
      console.log(`   - Wave Down: ${sellSignalInfo.waveDownCondition ? '✅' : '❌'} (${sellSignalInfo.waveChangeDown.toFixed(6)})`);
      console.log(`   - MACD Crossunder: ${sellSignalInfo.macdCrossunderCondition ? '✅' : '❌'}`);
      console.log(`   - Price Confirm: ${sellSignalInfo.priceConfirm ? '✅' : '❌'}`);
    }

    // Перевіряємо cooldown
    const now = Date.now();
    if (now - lastSignalTime < SIGNAL_COOLDOWN) {
      console.log(`⏳ Cooldown активний (${Math.ceil((SIGNAL_COOLDOWN - (now - lastSignalTime)) / 1000)}s)`);
    } else {
      const balance = await trading.getAccountBalance();
      const activePosition = trading.getActivePosition();

      // Сигнал на BUY
      if (buySignalInfo.signal && !sellSignalInfo.signal) {
        console.log('🟢 ===== СИГНАЛ НА ПОКУПКУ (LONG) =====');

        if (activePosition.isOpen && activePosition.side === 'short') {
          console.log('🔄 Закриваємо SHORT позицію');
          await trading.closePosition();
        }

        // Розраховуємо стопи
        const stops = calculateStopsAndTP(currentPrice, atr, 'long');
        console.log(`📍 Entry: ${currentPrice.toFixed(2)}, SL: ${stops.stopLoss.toFixed(2)}, TP: ${stops.takeProfit.toFixed(2)}`);
        console.log(`💰 Відкриваємо BUY на ${config.tradeAmount} ${config.symbol}`);
        
        await handleTradeSignal('buy', currentPrice, config.tradeAmount, stops);
        lastSignalTime = now;
      } 
      // Сигнал на SELL
      else if (sellSignalInfo.signal && !buySignalInfo.signal) {
        console.log('🔴 ===== СИГНАЛ НА ПРОДАЖ (SHORT) =====');

        if (activePosition.isOpen && activePosition.side === 'long') {
          console.log('🔄 Закриваємо LONG позицію');
          await trading.closePosition();
        }

        // Розраховуємо стопи
        const stops = calculateStopsAndTP(currentPrice, atr, 'short');
        console.log(`📍 Entry: ${currentPrice.toFixed(2)}, SL: ${stops.stopLoss.toFixed(2)}, TP: ${stops.takeProfit.toFixed(2)}`);
        console.log(`💰 Відкриваємо SELL на ${config.tradeAmount} ${config.symbol}`);
        
        await handleTradeSignal('sell', currentPrice, config.tradeAmount, stops);
        lastSignalTime = now;
      }

      // Показуємо активну позицію
      if (activePosition.isOpen) {
        console.log(`📊 Активна позиція: ${activePosition.side.toUpperCase()} ${activePosition.size} @ ${activePosition.entryPrice.toFixed(2)}`);
      } else {
        console.log('📊 Позицій немає - очікуємо сигналу');
      }
    }
  } catch (error) {
    console.error('🔴 Помилка циклу торгівлі:', error.message);
  }
}

async function startBot() {
  try {
    await initializeBot();
    isRunning = true;

    console.log(`\n🎯 Бот запущено для ${config.symbol} (${config.timeframe})`);
    console.log(`⏰ Інтервал оновлення: ${config.updateInterval}ms`);
    console.log(`📌 Стратегія: Wave Pattern + MACD (TradingView)\n`);

    const runLoop = async () => {
      if (isRunning) {
        await runTradingCycle();
        setTimeout(runLoop, config.updateInterval);
      }
    };

    runLoop();
  } catch (error) {
    console.error('🔴 Фатальна помилка:', error.message);
    process.exit(1);
  }
}

startBot();
