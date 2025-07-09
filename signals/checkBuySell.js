function checkEntrySignal({ ema200, rsi, close }) {
  const lastPrice = close[close.length - 1];
  const lastEMA = ema200[ema200.length - 1];
  const lastRSI = rsi[rsi.length - 1];

  const inUptrend = lastPrice > lastEMA;
  const inDowntrend = lastPrice < lastEMA;

  const long = inUptrend && lastRSI < 30;
  const short = inDowntrend && lastRSI > 70;

  return { long, short };
}

module.exports = { checkEntrySignal };
