require('dotenv').config();

const fetchOHLCV = require('./data/fetchOHLCV');
const { checkBuySignal, checkSellSignal } = require('./strategy/strategy');
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
    const balance = await trading.getAccountBalance();
    console.log(`💰 Початковий баланс: ${balance.toFixed(2)} USDT`);

    return true;
  } catch (error) {
    console.error('🔴 Помилка ініціалізації:', error.message);
    throw error;
  }
}

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

    const closes = candles.map(c => c.close);
    const currentPrice = closes.at(-1);
    console.log(`📊 Поточна ціна: ${currentPrice}`);

    const buySignal = checkBuySignal(closes);
    const sellSignal = checkSellSignal(closes);
    console.log(`🔍 Buy Signal: ${buySignal ? '✅' : '❌'}`);
    console.log(`🔍 Sell Signal: ${sellSignal ? '✅' : '❌'}`);

    const now = Date.now();
    if (now - lastSignalTime < SIGNAL_COOLDOWN) {
      console.log('⏳ Cooldown активний, пропускаємо сигнали');
      return;
    }

    const balance = await trading.getAccountBalance();
    const activePosition = trading.getActivePosition();

    if (buySignal && !sellSignal) {
      console.log('🟢 Сигнал на покупку!');

      if (activePosition.isOpen && activePosition.side === 'short') {
        console.log('🔄 Закриваємо SHORT позицію');
        await trading.closePosition();
      }

      console.log(`💰 Відкриваємо BUY на ${config.tradeAmount} (${config.symbol})`);
      await handleTradeSignal('buy', currentPrice, config.tradeAmount);
      lastSignalTime = now;
    } else if (sellSignal && !buySignal) {
      console.log('🔴 Сигнал на продаж!');

      if (activePosition.isOpen && activePosition.side === 'long') {
        console.log('🔄 Закриваємо LONG позицію');
        await trading.closePosition();
      }

      console.log(`💰 Відкриваємо SELL на ${config.tradeAmount} (${config.symbol})`);
      await handleTradeSignal('sell', currentPrice, config.tradeAmount);
      lastSignalTime = now;
    }

    if (activePosition.isOpen) {
      console.log(`📊 Активна позиція: ${activePosition.side} ${activePosition.size} @ ${activePosition.entryPrice}`);
    } else {
      console.log('📊 Позицій немає');
    }
  } catch (error) {
    console.error('🔴 Помилка циклу торгівлі:', error.message);
  }
}

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
