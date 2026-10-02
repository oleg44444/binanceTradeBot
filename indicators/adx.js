/**
 * ADX / +DI / -DI (Wilder). Аналог Pine ta.dmi(len, len).
 * Повертає { adx, plusDI, minusDI } — масиви довжини highs.length з null на початку.
 */
function calculateADX(highs, lows, closes, len = 14) {
  const n = closes.length;
  const adx     = new Array(n).fill(null);
  const plusDI  = new Array(n).fill(null);
  const minusDI = new Array(n).fill(null);
  if (n < len * 2 + 1) return { adx, plusDI, minusDI };

  const tr = new Array(n).fill(0);
  const pdm = new Array(n).fill(0);
  const mdm = new Array(n).fill(0);

  for (let i = 1; i < n; i++) {
    const upMove   = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    pdm[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    mdm[i] = downMove > upMove && downMove > 0 ? downMove : 0;
    tr[i]  = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
  }

  // Згладжування за Вайлдером (початок = сума перших len значень)
  let trS = 0, pS = 0, mS = 0;
  for (let i = 1; i <= len; i++) { trS += tr[i]; pS += pdm[i]; mS += mdm[i]; }

  const dx = new Array(n).fill(null);
  const calcDI = (i) => {
    const p = trS === 0 ? 0 : (100 * pS) / trS;
    const m = trS === 0 ? 0 : (100 * mS) / trS;
    plusDI[i]  = p;
    minusDI[i] = m;
    dx[i] = p + m === 0 ? 0 : (100 * Math.abs(p - m)) / (p + m);
  };
  calcDI(len);

  for (let i = len + 1; i < n; i++) {
    trS = trS - trS / len + tr[i];
    pS  = pS  - pS  / len + pdm[i];
    mS  = mS  - mS  / len + mdm[i];
    calcDI(i);
  }

  // ADX = згладжений DX
  const first = len * 2 - 1;
  let sum = 0;
  for (let i = len; i <= first; i++) sum += dx[i];
  adx[first] = sum / len;
  for (let i = first + 1; i < n; i++) {
    adx[i] = (adx[i - 1] * (len - 1) + dx[i]) / len;
  }

  return { adx, plusDI, minusDI };
}

module.exports = { calculateADX };
