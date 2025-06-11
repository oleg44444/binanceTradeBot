const binance = require('../utils/binanceClient');

module.exports = async function fetchOHLCV(symbol, timeframe = '5m') {
  const ohlcv = await binance.fetchOHLCV(symbol, timeframe, undefined, 100);
  return ohlcv.map(candle => ({
    timestamp: candle[0],
    open: candle[1],
    high: candle[2],
    low: candle[3],
    close: candle[4],
    volume: candle[5],
  }));
};
