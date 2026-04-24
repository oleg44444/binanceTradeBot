const logger = require('../utils/logger');
const { openNewPosition, closePosition } = require('./executeOrder');

/**
 * Обробка торгового сигналу
 * @param {string} type - 'buy' або 'sell'
 * @param {number} price - поточна ціна входу
 * @param {number} amount - розмір позиції
 * @param {object} stops - {stopLoss, takeProfit, trailingStopDistance}
 */
async function handleTradeSignal(type, price, amount, stops) {
  try {
    logger.debug(`Обробка сигналу: ${type} @ ${price.toFixed(4)}, SL=${stops.stopLoss.toFixed(4)}, TP=${stops.takeProfit.toFixed(4)}`);

    // ✅ Передаємо стопи в openNewPosition
    await openNewPosition(type, amount, price, stops);

  } catch (error) {
    logger.error('Помилка обробки сигналу', error);
    throw error;
  }
}

module.exports = {
  handleTradeSignal
};
