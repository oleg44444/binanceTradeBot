function ema(values, period) {
    const k = 2 / (period + 1);
    let emaArray = [values[0]];
    for (let i = 1; i < values.length; i++) {
      emaArray.push(values[i] * k + emaArray[i - 1] * (1 - k));
    }
    return emaArray;
  }
  
  function calculateMACD(prices, fast = 12, slow = 26, signal = 9) {
    const emaFast = ema(prices, fast);
    const emaSlow = ema(prices, slow);
    const macdLine = emaFast.map((val, i) => val - (emaSlow[i] || 0));
    const signalLine = ema(macdLine, signal);
    const histogram = macdLine.map((v, i) => v - (signalLine[i] || 0));
  
    return { macdLine, signalLine, histogram };
  }
  
  module.exports = { calculateMACD };
  