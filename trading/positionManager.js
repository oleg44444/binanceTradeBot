const { closePosition, openNewPosition, getActivePosition, executeOrder } = require('./executeOrder');

async function handleTradeSignal(type, price, amount) {
  const active = await getActivePosition();

  const isSameDirection = active.isOpen && active.side === (type === 'buy' ? 'long' : 'short');

  if (isSameDirection) {
    console.log(`➕ Докупка в ту ж сторону (${type.toUpperCase()})`);
    await executeOrder({ type, price });
    return;
  }

  if (active.isOpen) {
    console.log(`🔁 Закриваємо протилежну позицію (${active.side})`);
    await closePosition();
  }

  console.log(`🟢 Відкриваємо нову позицію (${type}) по ціні ${price}`);
  await openNewPosition(type, amount);
}

module.exports = {
  handleTradeSignal
};
