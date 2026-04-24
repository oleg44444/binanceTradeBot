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
    console.log('📍 handleTradeSignal викликаний');
    console.log(`   Тип: ${type}, Ціна: ${price}, Кількість: ${amount}`);
    console.log(`   Стопи: SL=${stops.stopLoss.toFixed(4)}, TP=${stops.takeProfit.toFixed(4)}`);

    // ✅ Передаємо стопи в openNewPosition
    await openNewPosition(type, amount, price, stops);

  } catch (error) {
    console.error('🔴 Помилка обробки сигналу:', error.message);
    throw error;
  }
}

module.exports = {
  handleTradeSignal
};
