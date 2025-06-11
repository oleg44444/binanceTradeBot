function checkBuySignal(data, atrArray, macd) {
  const i = data.length - 1;
  const close = data[i].close;
  const low = Math.min(...data.slice(-20).map(c => c.low));
  const waveChangeUp = (data[i].high - low) / low;
  const lastCandle = data[data.length - 1];
  const macdLine = macd.macdLine[macd.macdLine.length - 1];
  const signalLine = macd.signalLine[macd.signalLine.length - 1];
  const prevMacd = macd.macdLine[macd.macdLine.length - 2];
  const prevSignal = macd.signalLine[macd.signalLine.length - 2];

  console.log('🔍 Перевірка BUY умови:', { 
    waveChangeUp, 
    macdLine, 
    signalLine, 
    prevMacd, 
    prevSignal, 
    close, 
    low
  });

  return (
    waveChangeUp > 0.003 &&
    macdLine > signalLine &&
    prevMacd <= prevSignal &&
    close > low &&
    lastCandle.close > lastCandle.open
  );
}

function checkSellSignal(data, atrArray, macd) {
  const i = data.length - 1;
  const high = Math.max(...data.slice(-20).map(c => c.high));
  const waveChangeDown = (high - data[i].low) / high;
  const lastCandle = data[data.length - 1];
  const macdLine = macd.macdLine[macd.macdLine.length - 1];
  const signalLine = macd.signalLine[macd.signalLine.length - 1];
  const prevMacd = macd.macdLine[macd.macdLine.length - 2];
  const prevSignal = macd.signalLine[macd.signalLine.length - 2];

  console.log('🔍 Перевірка SELL умови:', { 
    waveChangeDown, 
    macdLine, 
    signalLine, 
    prevMacd, 
    prevSignal
  });

  return (
    waveChangeDown > 0.003 &&
    macdLine < signalLine &&
    prevMacd >= prevSignal &&
    data[i].close < high
  );
}

module.exports = { checkBuySignal, checkSellSignal };