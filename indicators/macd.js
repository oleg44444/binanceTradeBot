/**
 * Розрахунок MACD (Moving Average Convergence Divergence)
 * Відповідає Pine Script: ta.macd(close, fast, slow, signal)
 *
 * @param {number[]} closes - Масив цін закриття
 * @param {number} fast - Період швидкої EMA (12)
 * @param {number} slow - Період повільної EMA (26)
 * @param {number} signal - Період сигнальної лінії (9)
 * @returns {object} - { macdLine: number[], signalLine: number[], histogram: number[], isValid: boolean }
 *   Усі масиви мають довжину closes.length, містять null для недостатніх даних.
 */
function calculateMACD(closes, fast = 12, slow = 26, signal = 9) {
  const emaFast = calculateEMA(closes, fast);
  const emaSlow = calculateEMA(closes, slow);

  // MACD Line (довжина = closes.length)
  const macdLine = new Array(closes.length).fill(null);
  for (let i = 0; i < closes.length; i++) {
    if (emaFast[i] !== null && emaSlow[i] !== null) {
      macdLine[i] = emaFast[i] - emaSlow[i];
    }
  }

  // Signal Line (EMA від macdLine, довжина = closes.length)
  const signalLine = calculateEMAFull(macdLine, signal);

  // Histogram (довжина = closes.length)
  const histogram = new Array(closes.length).fill(null);
  for (let i = 0; i < closes.length; i++) {
    if (macdLine[i] !== null && signalLine[i] !== null) {
      histogram[i] = macdLine[i] - signalLine[i];
    }
  }

  const isValid = macdLine.some(v => v !== null) && signalLine.some(v => v !== null);
  return { macdLine, signalLine, histogram, isValid };
}

/**
 * Розрахунок EMA (класична, з експоненційним згладжуванням)
 * Повертає масив тієї ж довжини, що й prices, з null для недостатніх даних.
 */
function calculateEMA(prices, period) {
  const k = 2 / (period + 1);
  const ema = new Array(prices.length).fill(null);

  if (prices.length < period) return ema;

  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += prices[i];
  }
  ema[period - 1] = sum / period;

  for (let i = period; i < prices.length; i++) {
    ema[i] = prices[i] * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

/**
 * EMA на масиві, де можуть бути null.
 * Використовує SMA перших period валідних значень як стартове,
 * потім продовжує EMA, пропускаючи null (значення EMA не змінюється).
 * Повертає масив тієї ж довжини.
 */
function calculateEMAFull(values, period) {
  const len = values.length;
  const result = new Array(len).fill(null);

  // Знаходимо перші period валідних значень
  const validIndices = [];
  for (let i = 0; i < len; i++) {
    if (values[i] !== null) validIndices.push(i);
    if (validIndices.length === period) break;
  }

  if (validIndices.length < period) return result; // недостатньо даних

  // Початкове значення – SMA перших period валідних значень
  let sum = 0;
  for (let idx of validIndices) {
    sum += values[idx];
  }
  const startIdx = validIndices[validIndices.length - 1];
  result[startIdx] = sum / period;

  const k = 2 / (period + 1);
  let prevEma = result[startIdx];
  let prevValidIdx = startIdx;

  for (let i = startIdx + 1; i < len; i++) {
    if (values[i] !== null) {
      prevEma = values[i] * k + prevEma * (1 - k);
      result[i] = prevEma;
      prevValidIdx = i;
    } else {
      result[i] = null; // залишаємо null, але можна було б продублювати попереднє – але Pine так не робить
    }
  }

  // Заповнюємо до startIdx – null
  for (let i = 0; i < startIdx; i++) {
    result[i] = null;
  }

  return result;
}

/**
 * Перевірка MACD crossover (MACD перетинає сигнальну лінію знизу вгору)
 * macdLine та signalLine – масиви однакової довжини
 */
function isMACDCrossover(macdLine, signalLine) {
  if (macdLine.length < 2 || signalLine.length < 2) return false;

  const prevM = macdLine[macdLine.length - 2];
  const currM = macdLine[macdLine.length - 1];
  const prevS = signalLine[signalLine.length - 2];
  const currS = signalLine[signalLine.length - 1];

  if ([prevM, currM, prevS, currS].some(v => v === null)) return false;
  return prevM <= prevS && currM > currS;
}

/**
 * Перевірка MACD crossunder (MACD перетинає сигнальну лінію зверху вниз)
 */
function isMACDCrossunder(macdLine, signalLine) {
  if (macdLine.length < 2 || signalLine.length < 2) return false;

  const prevM = macdLine[macdLine.length - 2];
  const currM = macdLine[macdLine.length - 1];
  const prevS = signalLine[signalLine.length - 2];
  const currS = signalLine[signalLine.length - 1];

  if ([prevM, currM, prevS, currS].some(v => v === null)) return false;
  return prevM >= prevS && currM < currS;
}

module.exports = {
  calculateMACD,
  isMACDCrossover,
  isMACDCrossunder
};