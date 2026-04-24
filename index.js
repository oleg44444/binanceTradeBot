require('dotenv').config();

const fetchOHLCV = require('./data/fetchOHLCV');
const { checkBuySignal, checkSellSignal, calculateAllIndicators, calculateStopsAndTP } = require('./strategy/strategy');
const config = require('./config/config');
const binanceClientPromise = require('./utils/binanceClient');
const { initializeTradingModule } = require('./trading/executeOrder');
const { syncPositionWithExchange } = require('./trading/executeOrder');
const { handleTradeSignal } = require('./trading/positionManager');
const logger = require('./utils/logger');

let binance;
let trading;
let isRunning = false;
let lastSignalTime = 0;
const SIGNAL_COOLDOWN = 60000; // 1 хвилина

// Встановлення рівня логування
logger.setLogLevel('INFO');

process.on('uncaughtException', (error) => {
  logger.error('Невідловлена помилка', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Невідловлена відмова', reason);
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\n🔴 Бот зупинено');
  process.exit(0);
});

async function initializeBot() {
  try {
    logger.info('🚀 Запуск бота...');
    binance = await binanceClientPromise();
    logger.info('✅ Binance клієнт підключено');

    await binance.setMarginType(config.symbol, 'ISOLATED');
    await binance.setLeverage(config.leverage || 20, config.symbol);
    logger.info(`✅ Налаштовано плече: ${config.leverage || 20}x`);

    trading = await initializeTradingModule(binance);
    await trading.syncPositionWithExchange?.();
    const balance = await trading.getAccountBalance();
    logger.info(`💰 Початковий баланс: ${balance.toFixed(2)} USDT`);

    return true;
  } catch (error) {
    logger.error('Помилка ініціалізації', error);
    throw error;
  }
}

async function runTradingCycle() {
  if (!isRunning) return;

  try {
    const candles = await fetchOHLCV(config.symbol, config.timeframe);
    if (!candles || candles.length < 50) {
      logger.warn('⚠️ Недостатньо даних для аналізу');
      return;
    }

    // Розраховуємо всі індикатори
    const indicators = calculateAllIndicators(candles);
    if (!indicators.isValid) {
      logger.debug('Індикатори не готові');
      return;
    }

    // Перевіряємо сигнали
    const buySignalData = checkBuySignal(indicators);
    const sellSignalData = checkSellSignal(indicators);
    
    const buySignal = buySignalData.signal;
    const sellSignal = sellSignalData.signal;

    const now = Date.now();
    if (now - lastSignalTime < SIGNAL_COOLDOWN) {
      logger.debug('⏳ Cooldown активний, пропускаємо сигнали');
      return;
    }

    const balance = await trading.getAccountBalance();
    const activePosition = trading.getActivePosition();

    // Виявлено BUY сигнал
    if (buySignal && !sellSignal) {
      logger.signalDetected(true, {
        currentPrice: indicators.currentPrice,
        waveChangeUp: indicators.waves.waveChangeUp,
        waveLow: indicators.waves.waveLow,
        waveHigh: indicators.waves.waveHigh
      });

      if (activePosition.isOpen && activePosition.side === 'short') {
        logger.info('🔄 Закриваємо SHORT позицію');
        await trading.closePosition();
      }

      // Розраховуємо стопи
      const stops = calculateStopsAndTP(indicators.currentPrice, indicators.atr, 'long');
      
      logger.tradeOpen('buy', config.tradeAmount, config.symbol, indicators.currentPrice, stops);
      await handleTradeSignal('buy', indicators.currentPrice, config.tradeAmount, stops);
      lastSignalTime = now;
    } 
    // Виявлено SELL сигнал
    else if (sellSignal && !buySignal) {
      logger.signalDetected(false, {
        currentPrice: indicators.currentPrice,
        waveChangeDown: indicators.waves.waveChangeDown,
        waveLow: indicators.waves.waveLow,
        waveHigh: indicators.waves.waveHigh
      });

      if (activePosition.isOpen && activePosition.side === 'long') {
        logger.info('🔄 Закриваємо LONG позицію');
        await trading.closePosition();
      }

      // Розраховуємо стопи
      const stops = calculateStopsAndTP(indicators.currentPrice, indicators.atr, 'short');
      
      logger.tradeOpen('sell', config.tradeAmount, config.symbol, indicators.currentPrice, stops);
      await handleTradeSignal('sell', indicators.currentPrice, config.tradeAmount, stops);
      lastSignalTime = now;
    }

    // Виводимо статус циклу
    logger.cycleStatus(balance, activePosition);

  } catch (error) {
    logger.error('Помилка циклу торгівлі', error);
  }
}

async function startBot() {
  try {
    await initializeBot();
    isRunning = true;

    console.log(`\n${'='.repeat(60)}`);
    console.log(`🎯 БОТ ЗАПУЩЕНО`);
    console.log(`${'='.repeat(60)}`);
    console.log(`📍 Сигнал: ${config.symbol} (${config.timeframe})`);
    console.log(`⏰ Інтервал оновлення: ${config.updateInterval}ms`);
    console.log(`💾 Логування: INFO (тільки важливе)`);
    console.log(`${'='.repeat(60)}\n`);

    const runLoop = async () => {
      if (isRunning) {
        await runTradingCycle();
        setTimeout(runLoop, config.updateInterval);
      }
    };

    runLoop();
  } catch (error) {
    logger.error('Фатальна помилка', error);
    process.exit(1);
  }
}

startBot();
