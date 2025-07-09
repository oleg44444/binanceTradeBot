const { closePosition, openNewPosition, getActivePosition } = require('./executeOrder');

async function handleTradeSignal(type, price, amount) {
  const active = getActivePosition();

  // Якщо вже є позиція в тому ж напрямку — докупка
  if (active.isOpen && active.side === (type === 'buy' ? 'long' : 'short')) {
    console.log(`➕ Докупка в ту ж сторону (${type.toUpperCase()})`);
    await openNewPosition(type, amount);
    return;
  }

  // Якщо є протилежна позиція — закриваємо
  if (active.isOpen) {
    console.log(`🔁 Закриваємо протилежну позицію (${active.side})`);
    await closePosition();
  }

  // Відкриваємо нову позицію
  console.log(`🟢 Відкриваємо нову позицію (${type}) по ціні ${price}`);
  await openNewPosition(type, amount);
}

module.exports = {
  handleTradeSignal
};
