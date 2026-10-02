const binanceClientPromise = require('../utils/binanceClient');

/**
 * Завантажує ОСТАННІ `limit` свічок.
 * Раніше тут передавався `since = now - 7d` разом з `limit`, через що Binance віддавав
 * ПЕРШІ 250 свічок від since (дані ~4 доби тому), а не поточні. Тепер since не передається.
 *
 * Повертає масив [[time, open, high, low, close, volume], ...]; остання свічка — ще формується.
 */
async function fetchOHLCV(symbol, timeframe, limit = 500) {
  const binance = await binanceClientPromise();
  try {
    const candles = await binance.fetchOHLCV(symbol, timeframe, undefined, limit);

    if (!candles || candles.length === 0) {
      throw new Error('Не отримано даних свічок');
    }
    return candles;
  } catch (error) {
    console.error(`🔴 Помилка завантаження свічок: ${error.message}`);
    throw error;
  }
}

module.exports = fetchOHLCV;
