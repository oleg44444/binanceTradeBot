/**
 * Розрахунок MACD (Moving Average Convergence Divergence)
 * @param {number[]} closes - Масив цін закриття
 * @param {number} fast - Період швидкої EMA (за замовчуванням 12)
 * @param {number} slow - Період повільної EMA (за замовчуванням 26)
 * @param {number} signal - Період сигнальної лінії (за замовчуванням 9)
 * @returns {object} - {macdLine, signalLine, histogram, isValid}
 */
function calculateMACD(closes, fast = 12, slow = 26, signal = 9) {
  const emaFast = calculateEMA(closes, fast);
  const emaSlow = calculateEMA(closes, slow);
  
  // MACD Line = Fast EMA - Slow EMA
  const macdLine = [];
  for (let i = 0; i < closes.length; i++) {
    if (emaFast[i] !== null && emaSlow[i] !== null) {
      macdLine[i] = emaFast[i] - emaSlow[i];
    } else {
      macdLine[i] = null;
    }
  }
  
  // Signal Line = EMA(MACD, signal)
  const validMacd = macdLine.filter(x => x !== null);
  const signalLine = calculateEMA(validMacd, signal);
  
  // Histogram = MACD - Signal
  const histogram = [];
  for (let i = 0; i < validMacd.length; i++) {
    if (signalLine[i] !== null) {
      histogram[i] = validMacd[i] - signalLine[i];
    } else {
      histogram[i] = null;
    }
  }
  
  return {
    macdLine: validMacd,
    signalLine,
    histogram,
    isValid: validMacd.length > 0
  };
}

/**
 * Розрахунок EMA
 */
function calculateEMA(prices, period) {
  const k = 2 / (period + 1);
  const emaArray = Array(prices.length).fill(null);
  
  if (prices.length < period) return emaArray;
  
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  emaArray[period - 1] = ema;
  
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
    emaArray[i] = ema;
  }
  
  return emaArray;
}

/**
 * Перевірка MACD crossover (MACD перетинає сигнальну лінію знизу)
 */
function isMACDCrossover(macdLine, signalLine) {
  if (macdLine.length < 2 || signalLine.length < 2) return false;
  
  const prev = macdLine[macdLine.length - 2];
  const curr = macdLine[macdLine.length - 1];
  const prevSignal = signalLine[signalLine.length - 2];
  const currSignal = signalLine[signalLine.length - 1];
  
  if (prev === null || curr === null || prevSignal === null || currSignal === null) {
    return false;
  }
  
  // MACD перешкодив сигнальну лінію знизу (попереджуючи)
  return prev <= prevSignal && curr > currSignal;
}

/**
 * Перевірка MACD crossunder (MACD перетинає сигнальну лінію зверху)
 */
function isMACDCrossunder(macdLine, signalLine) {
  if (macdLine.length < 2 || signalLine.length < 2) return false;
  
  const prev = macdLine[macdLine.length - 2];
  const curr = macdLine[macdLine.length - 1];
  const prevSignal = signalLine[signalLine.length - 2];
  const currSignal = signalLine[signalLine.length - 1];
  
  if (prev === null || curr === null || prevSignal === null || currSignal === null) {
    return false;
  }
  
  // MACD перешкодив сигнальну лінію зверху (понижуючи)
  return prev >= prevSignal && curr < currSignal;
}

module.exports = {
  calculateMACD,
  isMACDCrossover,
  isMACDCrossunder
};
