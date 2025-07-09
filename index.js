require('dotenv').config();
const fetchOHLCV = require('./data/fetchOHLCV');
const { calculateATR } = require('./indicators/atr');
const { calculateMACD } = require('./indicators/macd');
const { checkBuySignal, checkSellSignal } = require('./strategy/signalCheck');
const config = require('./config/config');
const binanceClientPromise = require('./utils/binanceClient');
const { initializeTradingModule } = require('./trading/executeOrder');
const { handleTradeSignal } = require('./trading/positionManager');

// Глобальні змінні
let binance;
let trading;
let isRunning = false;
let lastSignalTime = 0;
const SIGNAL_COOLDOWN = 60000;

// Обробка помилок
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

// Ініціалізація
async function initializeBot() {
  try {
    console.log('🚀 Запуск бота...');
    binance = await binanceClientPromise();
    console.log('✅ Binance клієнт підключено');

    try {
      await binance.setMarginType(config.symbol, 'ISOLATED');
      await binance.setLeverage(config.leverage || 20, config.symbol);
      console.log(`✅ Налаштовано плече: ${config.leverage || 20}x`);
    } catch (err) {
      console.warn('⚠️ Помилка налаштування маржі або плеча:', err.message);
    }

    trading = await initializeTradingModule(binance);
    console.log('✅ Модуль торгівлі готовий');

    const balance = await trading.getAccountBalance();
    console.log(`💰 Початковий баланс: ${balance.toFixed(2)} USDT`);
    return true;
  } catch (error) {
    console.error('🔴 Помилка ініціалізації:', error.message);
    throw error;
  }
}

// Головний цикл
async function runTradingCycle() {
  if (!isRunning) return;

  try {
    console.log('\n--- Цикл аналізу ---');
    console.log(`🕐 Час: ${new Date().toLocaleString()}`);

    const candles = await fetchOHLCV(config.symbol, config.timeframe);
    if (!candles || candles.length < 50) {
      console.warn('⚠️ Недостатньо даних для аналізу');
      return;
    }

    const currentPrice = candles.at(-1).close;
    console.log(`📊 Поточна ціна: ${currentPrice}`);

    const atrValues = calculateATR(candles, 14);
    const macdData = calculateMACD(candles);
    if (!atrValues || !macdData || atrValues.length === 0) {
      console.warn('⚠️ Помилка розрахунку індикаторів');
      return;
    }

    const currentATR = atrValues.at(-1);
    const currentMACD = macdData.macd.at(-1);
    const currentSignal = macdData.signal.at(-1);

    console.log(`📈 ATR: ${currentATR?.toFixed(6)}`);
    console.log(`📉 MACD: ${currentMACD?.toFixed(6)}`);
    console.log(`📊 Signal: ${currentSignal?.toFixed(6)}`);

    const buySignal = checkBuySignal(candles, atrValues, macdData);
    const sellSignal = checkSellSignal(candles, atrValues, macdData);
    console.log(`🔍 Buy Signal: ${buySignal ? '✅' : '❌'}`);
    console.log(`🔍 Sell Signal: ${sellSignal ? '✅' : '❌'}`);

    const now = Date.now();
    if (now - lastSignalTime < SIGNAL_COOLDOWN) {
      console.log('⏳ Cooldown активний, пропускаємо сигнали');
      return;
    }

    const balance = await trading.getAccountBalance();
    const activePosition = trading.getActivePosition();

    // BUY
    if (buySignal && !sellSignal) {
      console.log('🟢 Сигнал на покупку!');

      if (activePosition.isOpen && activePosition.side === 'short') {
        console.log('🔄 Закриваємо SHORT позицію');
        await trading.closePosition();
      }

      console.log(`💰 Відкриваємо BUY на ${config.tradeAmount} (${config.symbol})`);
      await handleTradeSignal('buy', currentPrice, config.tradeAmount);

      lastSignalTime = now;
    }

    // SELL
    else if (sellSignal && !buySignal) {
      console.log('🔴 Сигнал на продаж!');

      if (activePosition.isOpen && activePosition.side === 'long') {
        console.log('🔄 Закриваємо LONG позицію');
        await trading.closePosition();
      }

      console.log(`💰 Відкриваємо SELL на ${config.tradeAmount} (${config.symbol})`);
      await handleTradeSignal('sell', currentPrice, config.tradeAmount);

      lastSignalTime = now;
    }

    // Статус активної позиції
    if (activePosition.isOpen) {
      console.log(`📊 Активна позиція: ${activePosition.side} ${activePosition.size} @ ${activePosition.entryPrice}`);
    } else {
      console.log('📊 Позицій немає');
    }

  } catch (error) {
    console.error('🔴 Помилка циклу торгівлі:', error.message);
  }
}

// Запуск
async function startBot() {
  try {
    await initializeBot();
    isRunning = true;
    console.log(`🎯 Бот запущено для ${config.symbol} (${config.timeframe})`);
    console.log(`⏰ Інтервал оновлення: ${config.updateInterval}ms`);

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
