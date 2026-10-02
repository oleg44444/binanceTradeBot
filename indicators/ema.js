/**
 * EMA (експоненційна ковзна середня), стартове значення = SMA перших `period` свічок.
 * Повертає масив тієї ж довжини, що й prices (null для недостатніх даних).
 */
function calculateEMA(prices, period) {
  const ema = new Array(prices.length).fill(null);
  if (prices.length < period) return ema;

  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += prices[i];
  ema[period - 1] = sum / period;

  for (let i = period; i < prices.length; i++) {
    ema[i] = prices[i] * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

module.exports = { calculateEMA };
