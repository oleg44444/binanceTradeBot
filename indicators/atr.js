/**
 * Розрахунок ATR (Average True Range)
 * @param {array} candles - Масив свічок [open, high, low, close, volume]
 * @param {number} period - Період ATR (за замовчуванням 14)
 * @returns {number[]} - Масив значень ATR
 */
function calculateATR(candles, period = 14) {
  if (candles.length < period) {
    return Array(candles.length).fill(null);
  }

  const trueRanges = [];
  
  // Розраховуємо True Range для кожної свічки
  for (let i = 0; i < candles.length; i++) {
    const [open, high, low, close] = [
      candles[i][0],
      candles[i][1],
      candles[i][2],
      candles[i][3]
    ];
    
    let tr;
    if (i === 0) {
      tr = high - low;
    } else {
      const prevClose = candles[i - 1][3];
      const tr1 = high - low;
      const tr2 = Math.abs(high - prevClose);
      const tr3 = Math.abs(low - prevClose);
      tr = Math.max(tr1, tr2, tr3);
    }
    
    trueRanges.push(tr);
  }
  
  const atr = Array(candles.length).fill(null);
  
  // Перша ATR - проста середня
  let atrValue = 0;
  for (let i = 0; i < period; i++) {
    atrValue += trueRanges[i];
  }
  atrValue /= period;
  atr[period - 1] = atrValue;
  
  // Наступні ATR - згладжена середня (Wilder's smoothing)
  for (let i = period; i < candles.length; i++) {
    atrValue = (atrValue * (period - 1) + trueRanges[i]) / period;
    atr[i] = atrValue;
  }
  
  return atr;
}

module.exports = {
  calculateATR
};
