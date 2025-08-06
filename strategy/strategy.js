const { calculateEMA } = require('../indicators/ema');
const { calculateRSI } = require('../indicators/rsi');

function checkBuySignal(closes) {
  const ema = calculateEMA(closes, 200);
  const rsi = calculateRSI(closes, 14);
  const last = closes.length - 1;

  // Перевірка на наявність достатніх даних
  if (ema[last] === null || rsi[last] === null) {
    console.log('❌ Недостатньо даних для сигналу BUY');
    return false;
  }

  console.log('EMA:', ema[last].toFixed(2), 'RSI:', rsi[last].toFixed(2), 'Close:', closes[last]);

  const inUptrend = closes[last] > ema[last];
  const oversold = rsi[last] < 70;

  return inUptrend && oversold;
}

function checkSellSignal(closes) {
  const ema = calculateEMA(closes, 200);
  const rsi = calculateRSI(closes, 14);
  const last = closes.length - 1;

  if (ema[last] === null || rsi[last] === null) {
    console.log('❌ Недостатньо даних для сигналу SELL');
    return false;
  }

  const inDowntrend = closes[last] < ema[last];
  
  const overbought = rsi[last] > 30;

  return inDowntrend && overbought;
}

module.exports = {
  checkBuySignal,
  checkSellSignal,
};
