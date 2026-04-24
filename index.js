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
    console.log('🚀 Запуск бота TradingView Strategy...');
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

async function runTradingCycle() {
  if (!isRunning) return;

  try {
    console.log('\n' + '='.repeat(60));
    console.log('📊 === ЦИКЛ АНАЛІЗУ ===');
    console.log(`🕐 Час: ${new Date().toLocaleString('uk-UA')}`);
    console.log('='.repeat(60));

    // Завантажуємо свічки
    const candles = await fetchOHLCV(config.symbol, config.timeframe);
    if (!candles || candles.length < 50) {
      console.warn('⚠️ Недостатньо даних для аналізу');
      return;
    }

    const closes = candles.map(c => c[4]);
    const currentPrice = closes[closes.length - 1];
    console.log(`\n💹 Поточна ціна: ${currentPrice.toFixed(4)} ${config.symbol}`);

    // Отримуємо конфігурацію стратегії
    const strategyConfig = config.strategy || {};

    // Перевіряємо сигнали
    const buyResult = checkBuySignal(candles, strategyConfig);
    const sellResult = checkSellSignal(candles, strategyConfig);

    const buySignal = buyResult.signal;
    const sellSignal = sellResult.signal;

    // Перевіряємо cooldown
    const now = Date.now();
    if (now - lastSignalTime < SIGNAL_COOLDOWN) {
      console.log(`⏳ Cooldown активний (${Math.ceil((SIGNAL_COOLDOWN - (now - lastSignalTime)) / 1000)}s)`);
      return;
    }

    const balance = await trading.getAccountBalance();
    const activePosition = trading.getActivePosition();

    console.log(`\n💰 Баланс: ${balance.toFixed(2)} USDT`);
    console.log(`📊 Активна позиція: ${activePosition.isOpen ? activePosition.side.toUpperCase() : 'НЕМАЄ'}`);

    // Обробляємо BUY сигнал
    if (buySignal && !sellSignal) {
      console.log('\n🟢 ===== СИГНАЛ НА ПОКУПКУ (LONG) =====');

      if (activePosition.isOpen && activePosition.side === 'short') {
        console.log('🔄 Закриваємо SHORT позицію перед LONG');
        await trading.closePosition();
        await new Promise(r => setTimeout(r, 1000)); // Затримка для обробки
      }

      // Розраховуємо стопи та тейки на основі ATR
      const details = buyResult.details;
      if (details.currentATR) {
        const atrMultiplierSL = strategyConfig.atrMultiplierSL || 1.0;
        const atrMultiplierTP = strategyConfig.atrMultiplierTP || 5.0;

        const stopLoss = currentPrice - (details.currentATR * atrMultiplierSL);
        const takeProfit = currentPrice + (details.currentATR * atrMultiplierTP);

        console.log(`📍 Entry: ${currentPrice.toFixed(4)}`);
        console.log(`🛑 Stop Loss: ${stopLoss.toFixed(4)}`);
        console.log(`🎯 Take Profit: ${takeProfit.toFixed(4)}`);
        console.log(`⚡ ATR: ${details.currentATR.toFixed(4)}, Wave Length: ${details.waveLength}`);
      }

      console.log(`💰 Відкриваємо BUY на ${config.tradeAmount} ${config.symbol}`);
      await handleTradeSignal('buy', currentPrice, config.tradeAmount);
      lastSignalTime = now;

    } else if (sellSignal && !buySignal) {
      console.log('\n🔴 ===== СИГНАЛ НА ПРОДАЖ (SHORT) =====');

      if (activePosition.isOpen && activePosition.side === 'long') {
        console.log('🔄 Закриваємо LONG позицію перед SHORT');
        await trading.closePosition();
        await new Promise(r => setTimeout(r, 1000)); // Затримка для обробки
      }

      // Розраховуємо стопи та тейки на основі ATR
      const details = sellResult.details;
      if (details.currentATR) {
        const atrMultiplierSL = strategyConfig.atrMultiplierSL || 1.0;
        const atrMultiplierTP = strategyConfig.atrMultiplierTP || 5.0;

        const stopLoss = currentPrice + (details.currentATR * atrMultiplierSL);
        const takeProfit = currentPrice - (details.currentATR * atrMultiplierTP);

        console.log(`📍 Entry: ${currentPrice.toFixed(4)}`);
        console.log(`🛑 Stop Loss: ${stopLoss.toFixed(4)}`);
        console.log(`🎯 Take Profit: ${takeProfit.toFixed(4)}`);
        console.log(`⚡ ATR: ${details.currentATR.toFixed(4)}, Wave Length: ${details.waveLength}`);
      }

      console.log(`💰 Відкриваємо SELL на ${config.tradeAmount} ${config.symbol}`);
      await handleTradeSignal('sell', currentPrice, config.tradeAmount);
      lastSignalTime = now;

    } else {
      console.log('\n⏸️ Без сигналів');

      if (activePosition.isOpen) {
        console.log(`📊 Активна позиція: ${activePosition.side.toUpperCase()} ${activePosition.size} @ ${activePosition.entryPrice.toFixed(4)}`);
        const profit = activePosition.side === 'long'
          ? (currentPrice - activePosition.entryPrice) / activePosition.entryPrice * 100
          : (activePosition.entryPrice - currentPrice) / activePosition.entryPrice * 100;
        console.log(`📈 P&L: ${profit > 0 ? '🟢' : '🔴'} ${profit.toFixed(2)}%`);
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

    console.log(`\n${'='.repeat(60)}`);
    console.log(`🎯 БОТ ЗАПУЩЕНО`);
    console.log(`📍 Сигнал: ${config.symbol} (${config.timeframe})`);
    console.log(`⏰ Інтервал оновлення: ${config.updateInterval}ms`);
    console.log(`${'='.repeat(60)}\n`);

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
