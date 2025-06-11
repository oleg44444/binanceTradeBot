function calculateATR(data, period) {
    let tr = [];
  
    for (let i = 1; i < data.length; i++) {
      const high = data[i].high;
      const low = data[i].low;
      const prevClose = data[i - 1].close;
      tr.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
    }
  
    let atr = [];
    for (let i = period; i < tr.length; i++) {
      const slice = tr.slice(i - period, i);
      const avg = slice.reduce((a, b) => a + b, 0) / period;
      atr.push(avg);
    }
  
    return atr;
  }
  
  module.exports = { calculateATR };
  