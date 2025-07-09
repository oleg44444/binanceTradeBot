function calculateRSI(prices, period = 14) {
  if (prices.length < period + 1) return [];

  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    let diff = prices[i] - prices[i - 1];
    diff >= 0 ? gains += diff : losses -= diff;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;
  let rsiArray = [100 - (100 / (1 + avgGain / avgLoss))];

  for (let i = period + 1; i < prices.length; i++) {
    let diff = prices[i] - prices[i - 1];
    let gain = diff > 0 ? diff : 0;
    let loss = diff < 0 ? -diff : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    let rs = avgGain / avgLoss;
    rsiArray.push(100 - 100 / (1 + rs));
  }

  return rsiArray;
}

module.exports = { calculateRSI };
