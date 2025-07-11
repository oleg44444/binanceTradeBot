const { calculateEMA } = require('../indicators/ema');
const { calculateRSI } = require('../indicators/rsi');

function checkBuySignal(closes) {
  const ema = calculateEMA(closes, 200);
  const rsi = calculateRSI(closes, 14);
  const last = closes.length - 1;

  const inUptrend = closes[last] > ema[last];
  const oversold = rsi[last] < 30;

  return inUptrend && oversold;
}

function checkSellSignal(closes) {
  const ema = calculateEMA(closes, 200);
  const rsi = calculateRSI(closes, 14);
  const last = closes.length - 1;

  const inDowntrend = closes[last] < ema[last];
  const overbought = rsi[last] > 70;

  return inDowntrend && overbought;
}

module.exports = {
  checkBuySignal,
  checkSellSignal
};
