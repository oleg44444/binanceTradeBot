/**
 * Логгер для бота з контролем рівня деталізації
 */

const LOG_LEVELS = {
  ERROR: 'ERROR',
  WARN: 'WARN',
  INFO: 'INFO',
  DEBUG: 'DEBUG'
};

// Поточний рівень логування (за замовчуванням INFO)
let currentLogLevel = LOG_LEVELS.INFO;

// Відстежування останніх логів для уникнення дублювання
const logHistory = new Map();
const LOG_HISTORY_TIMEOUT = 60000; // 1 хвилина

function getLogLevelValue(level) {
  const levels = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };
  return levels[level] || 2;
}

function shouldLog(level) {
  return getLogLevelValue(level) <= getLogLevelValue(currentLogLevel);
}

function isDuplicate(key) {
  if (logHistory.has(key)) {
    const lastTime = logHistory.get(key);
    if (Date.now() - lastTime < LOG_HISTORY_TIMEOUT) {
      return true;
    }
  }
  logHistory.set(key, Date.now());
  return false;
}

function formatTime() {
  return new Date().toLocaleTimeString('uk-UA');
}

function error(message, error = null) {
  if (!shouldLog(LOG_LEVELS.ERROR)) return;
  
  console.error(`\n🔴 [${formatTime()}] ERROR: ${message}`);
  if (error) {
    console.error(`   ${error.message}\n`);
  }
}

function warn(message) {
  if (!shouldLog(LOG_LEVELS.WARN)) return;
  
  const key = `warn:${message}`;
  if (!isDuplicate(key)) {
    console.warn(`⚠️  [${formatTime()}] ${message}`);
  }
}

function info(message) {
  if (!shouldLog(LOG_LEVELS.INFO)) return;
  
  const key = `info:${message}`;
  if (!isDuplicate(key)) {
    console.log(`ℹ️  [${formatTime()}] ${message}`);
  }
}

function debug(message) {
  if (!shouldLog(LOG_LEVELS.DEBUG)) return;
  
  console.log(`🔧 [${formatTime()}] ${message}`);
}

// Спеціальні логи (не блокуються дублюванням)
function tradeOpen(side, amount, symbol, price, stops) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🟢 ПОЗИЦІЯ ВІДКРИТА`);
  console.log(`${'='.repeat(60)}`);
  console.log(`📊 Тип: ${side.toUpperCase()}`);
  console.log(`📈 Кількість: ${amount} ${symbol}`);
  console.log(`💹 Ціна входу: ${price.toFixed(4)}`);
  console.log(`🛑 Стоп-Лосс: ${stops.stopLoss.toFixed(4)}`);
  console.log(`🎯 Тейк-Профіт: ${stops.takeProfit.toFixed(4)}`);
  console.log(`📍 Трейлінг дистанція: ${stops.trailingStopDistance.toFixed(4)}`);
  console.log(`${'='.repeat(60)}\n`);
}

function tradeClose(side, pnl, pnlPercent) {
  const icon = pnl >= 0 ? '✅' : '❌';
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🛑 ПОЗИЦІЯ ЗАКРИТА ${icon}`);
  console.log(`${'='.repeat(60)}`);
  console.log(`📊 Тип: ${side.toUpperCase()}`);
  console.log(`💰 Прибуток/Збиток: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USDT (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%)`);
  console.log(`${'='.repeat(60)}\n`);
}

function trailingStop(oldStop, newStop, currentPrice) {
  console.log(`🔄 Трейлінг SL: ${oldStop.toFixed(4)} → ${newStop.toFixed(4)} (ціна: ${currentPrice.toFixed(4)})`);
}

function breakEvenActivated(entry) {
  console.log(`✅ Break-Even активовано на рівні ${entry.toFixed(4)}`);
}

function signalDetected(buySignal, details) {
  if (!details) return;
  
  const type = buySignal ? '🟢 BUY' : '🔴 SELL';
  console.log(`\n${'='.repeat(60)}`);
  console.log(`${type} СИГНАЛ ВИЯВЛЕНО`);
  console.log(`${'='.repeat(60)}`);
  console.log(`💹 Поточна ціна: ${details.currentPrice.toFixed(4)}`);
  
  if (buySignal) {
    console.log(`🌊 Wave Up: ${(details.waveChangeUp * 100).toFixed(3)}% ✅`);
    console.log(`📈 MACD Crossover: ✅`);
    console.log(`📊 Ціна > Wave Low: ${details.currentPrice.toFixed(4)} > ${details.waveLow.toFixed(4)} ✅`);
  } else {
    console.log(`🌊 Wave Down: ${(details.waveChangeDown * 100).toFixed(3)}% ✅`);
    console.log(`📉 MACD Crossunder: ✅`);
    console.log(`📊 Ціна < Wave High: ${details.currentPrice.toFixed(4)} < ${details.waveHigh.toFixed(4)} ✅`);
  }
  console.log(`${'='.repeat(60)}\n`);
}

function cycleStatus(balance, activePosition) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`📊 СТАТУС ЦИКЛУ [${formatTime()}]`);
  console.log(`${'='.repeat(60)}`);
  console.log(`💰 Баланс: ${balance.toFixed(2)} USDT`);
  
  if (activePosition.isOpen) {
    const side = activePosition.side.toUpperCase();
    console.log(`📌 Позиція: ${side} ${activePosition.size} @ ${activePosition.entryPrice.toFixed(4)}`);
  } else {
    console.log(`📌 Позиція: ❌ Відсутня`);
  }
  console.log(`${'='.repeat(60)}\n`);
}

function setLogLevel(level) {
  if (LOG_LEVELS[level]) {
    currentLogLevel = level;
    info(`Рівень логування встановлено: ${level}`);
  }
}

module.exports = {
  setLogLevel,
  error,
  warn,
  info,
  debug,
  tradeOpen,
  tradeClose,
  trailingStop,
  breakEvenActivated,
  signalDetected,
  cycleStatus,
  LOG_LEVELS
};
