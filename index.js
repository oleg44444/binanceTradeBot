require('dotenv').config();

const fetchOHLCV = require('./data/fetchOHLCV');
const {
  checkBuySignal,
  checkSellSignal,
  calculateAllIndicators,
  calculateStopsAndTP
} = require('./strategy/strategy');
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
const SIGNAL_COOLDOWN = 60000; // 1 хвилина між сигналами

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
    // 1. Завантажуємо свічки
    const candles = await fetchOHLCV(config.symbol, config.timeframe);
    if (!candles || candles.length < 50) {
      logger.warn('⚠️ Недостатньо даних для аналізу');
      return;
    }

    // 2. Жива ціна з ticker
    let livePrice = null;
    try {
      const ticker = await binance.fetchTicker(config.symbol);
      livePrice = ticker.last;
      logger.debug(`📡 Жива ціна: ${livePrice}`);
    } catch (e) {
      logger.warn(`⚠️ fetchTicker не вдався, використовуємо ціну свічки: ${e.message}`);
    }

    // 3. Розраховуємо всі індикатори
    const indicators = calculateAllIndicators(candles, config.strategy || {}, livePrice);
    if (!indicators.isValid) {
      logger.debug(`Індикатори не готові: ${indicators.reason}`);
      return;
    }

    // 4. Перевіряємо сигнали
    const buyData  = checkBuySignal(indicators);
    const sellData = checkSellSignal(indicators);

    const buySignal  = buyData.signal;
    const sellSignal = sellData.signal;

    // 5. Cooldown
    const now = Date.now();
    if (now - lastSignalTime < SIGNAL_COOLDOWN) {
      logger.debug('⏳ Cooldown активний');
      return;
    }

    // 6. Отримуємо актуальний стан позиції
    const activePosition = trading.getActivePosition();

    // ── BUY сигнал ──────────────────────────────────────────────────────────
    if (buySignal && !sellSignal) {

      // 🔒 Якщо вже є LONG — ігноруємо (Pine: alertLong вимагає pos_size <= 0)
      if (activePosition.isOpen && activePosition.side === 'long') {
        logger.debug('ℹ️ Позиція LONG вже відкрита, сигнал ігнорується');
        logger.cycleStatus(await trading.getAccountBalance(), activePosition);
        return;
      }

      logger.signalDetected(true, {
        currentPrice: indicators.currentClose,
        waveChangeUp: indicators.waves.waveChangeUp,
        waveLow:      indicators.waves.lastWaveLow,
        waveHigh:     indicators.waves.lastWaveHigh
      });

      // Закриваємо протилежну позицію (SHORT → закрити)
      if (activePosition.isOpen && activePosition.side === 'short') {
        logger.info('🔄 Закриваємо SHORT перед LONG');
        await trading.closePosition();
      }

      const stops = calculateStopsAndTP(
        indicators.currentClose,
        indicators.atr,
        'long',
        indicators.multipliers
      );

      // Виконуємо вхід
      await handleTradeSignal('buy', indicators.currentClose, config.tradeAmount, stops);

      // Логуємо відкриття ТІЛЬКИ після успішного виконання
      logger.tradeOpen('buy', config.tradeAmount, config.symbol, indicators.currentClose, stops);
      lastSignalTime = now;
    }
    // ── SELL сигнал ─────────────────────────────────────────────────────────
    else if (sellSignal && !buySignal) {

      // 🔒 Якщо вже є SHORT — ігноруємо (Pine: alertShort вимагає pos_size >= 0)
      if (activePosition.isOpen && activePosition.side === 'short') {
        logger.debug('ℹ️ Позиція SHORT вже відкрита, сигнал ігнорується');
        logger.cycleStatus(await trading.getAccountBalance(), activePosition);
        return;
      }

      logger.signalDetected(false, {
        currentPrice:   indicators.currentClose,
        waveChangeDown: indicators.waves.waveChangeDown,
        waveLow:        indicators.waves.lastWaveLow,
        waveHigh:       indicators.waves.lastWaveHigh
      });

      // Закриваємо протилежну позицію (LONG → закрити)
      if (activePosition.isOpen && activePosition.side === 'long') {
        logger.info('🔄 Закриваємо LONG перед SHORT');
        await trading.closePosition();
      }

      const stops = calculateStopsAndTP(
        indicators.currentClose,
        indicators.atr,
        'short',
        indicators.multipliers
      );

      await handleTradeSignal('sell', indicators.currentClose, config.tradeAmount, stops);

      logger.tradeOpen('sell', config.tradeAmount, config.symbol, indicators.currentClose, stops);
      lastSignalTime = now;
    }

    // 7. Статус циклу — використовуємо СВІЖИЙ стан після всіх дій
    const freshBalance    = await trading.getAccountBalance();
    const freshPosition   = trading.getActivePosition();
    logger.cycleStatus(freshBalance, freshPosition);

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
    console.log(`💾 Логування: INFO`);
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