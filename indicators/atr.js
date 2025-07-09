function calculateATR(data, period = 14) {
  const tr = [];

  for (let i = 1; i < data.length; i++) {
    const high = data[i].high;
    const low = data[i].low;
    const prevClose = data[i - 1].close;

    if (
      typeof high !== 'number' ||
      typeof low !== 'number' ||
      typeof prevClose !== 'number'
    ) {
      console.warn(`[ATR] Пропущено TR через неправильні дані на індексі ${i}`);
      tr.push(NaN);
      continue;
    }

    const trueRange = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );

    tr.push(trueRange);
  }

  const atr = [];

  for (let i = period; i < tr.length; i++) {
    const slice = tr.slice(i - period, i);

    if (slice.some(val => typeof val !== 'number' || isNaN(val))) {
      console.warn(`[ATR] Пропущено ATR на індексі ${i} через NaN у TR`);
      atr.push(NaN);
      continue;
    }

    const avg = slice.reduce((a, b) => a + b, 0) / period;
    atr.push(avg);
  }

  console.log(`[ATR] TR довжина: ${tr.length}, ATR довжина: ${atr.length}`);
  console.log(`[ATR] Останні ATR:`, atr.slice(-3));

  return atr;
}

module.exports = { calculateATR };
