/**
 * Розрахунок ATR (Average True Range)
 * Показує волатильність ринку
 * @param {number[]} highs - Масив найвищих цін
 * @param {number[]} lows - Масив найнищих цін
 * @param {number[]} closes - Масив цін закриття
 * @param {number} period - Період ATR (за замовчуванням 14)
 * @returns {number[]} - Масив значень ATR
 */
function calculateATR(highs, lows, closes, period = 14) {
  if (highs.length < period || lows.length < period || closes.length < period) {
    return Array(closes.length).fill(null);
  }
  
  // Розрахунок True Range
  const trueRanges = [];
  for (let i = 0; i < closes.length; i++) {
    let tr;
    
    if (i === 0) {
      tr = highs[i] - lows[i];
    } else {
      const hl = highs[i] - lows[i];
      const hc = Math.abs(highs[i] - closes[i - 1]);
      const lc = Math.abs(lows[i] - closes[i - 1]);
      tr = Math.max(hl, hc, lc);
    }
    
    trueRanges.push(tr);
  }
  
  // Розрахунок ATR як EMA(TR, period)
  const atr = Array(closes.length).fill(null);
  
  // Перша значення = SMA
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += trueRanges[i];
  }
  atr[period - 1] = sum / period;
  
  // Наступні значення = EMA
  const k = 1 / period;
  for (let i = period; i < trueRanges.length; i++) {
    atr[i] = atr[i - 1] * (1 - k) + trueRanges[i] * k;
  }
  
  return atr;
}

/**
 * Отримати останнє значення ATR
 */
function getLastATR(atr) {
  for (let i = atr.length - 1; i >= 0; i--) {
    if (atr[i] !== null) {
      return atr[i];
    }
  }
  return null;
}

module.exports = {
  calculateATR,
  getLastATR
};
