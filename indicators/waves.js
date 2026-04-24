/**
 * Аналіз хвильових патернів
 * Визначає локальні максимуми та мінімуми дл�� ідентифікації сигналів
 */

/**
 * Розрахунок локальних максимумів і мінімумів
 * @param {number[]} highs - Масив найвищих цін
 * @param {number[]} lows - Масив найнищих цін
 * @param {number} waveLength - Період для розрахунку (динамічний або фіксований)
 * @returns {object} - {waveHigh, waveLow}
 */
function calculateWavePatterns(highs, lows, waveLength = 12) {
    const length = highs.length;
    
    if (length < waveLength) {
      return {
        waveHigh: null,
        waveLow: null,
        waveHighIndex: -1,
        waveLowIndex: -1
      };
    }
    
    // Отримуємо локальний максимум за останні N свічок
    let waveHigh = highs[length - waveLength];
    let waveHighIndex = length - waveLength;
    
    for (let i = length - waveLength; i < length; i++) {
      if (highs[i] > waveHigh) {
        waveHigh = highs[i];
        waveHighIndex = i;
      }
    }
    
    // Отримуємо локальний мінімум за останні N свічок
    let waveLow = lows[length - waveLength];
    let waveLowIndex = length - waveLength;
    
    for (let i = length - waveLength; i < length; i++) {
      if (lows[i] < waveLow) {
        waveLow = lows[i];
        waveLowIndex = i;
      }
    }
    
    return {
      waveHigh,
      waveLow,
      waveHighIndex,
      waveLowIndex
    };
  }
  
  /**
   * Розрахунок динамічної довжини хвилі на основі ATR
   * @param {number} atr - Поточне значення ATR
   * @param {number} minWaveLength - Мінімальна довжина (за замовчуванням 8)
   * @param {number} maxWaveLength - Максимальна довжина (за замовчуванням 21)
   * @returns {number} - Розраховується довжина хвилі
   */
  function calculateDynamicWaveLength(atr, minWaveLength = 8, maxWaveLength = 21) {
    if (!atr || atr === null) {
      return minWaveLength;
    }
    
    // Динамічна довжина = ATR * 10, але обмежена min/max
    const waveLengthRaw = atr * 10;
    const waveLengthDynamic = Math.round(
      Math.min(Math.max(waveLengthRaw, minWaveLength), maxWaveLength)
    );
    
    return waveLengthDynamic > 0 ? waveLengthDynamic : minWaveLength;
  }
  
  /**
   * Розрахунок зміни хвилі (%) для виявлення сигналів
   * @param {number} currentPrice - Поточна ціна
   * @param {number} waveLow - Локальний мінімум
   * @param {number} waveHigh - Локальний максимум
   * @returns {object} - {waveChangeUp, waveChangeDown}
   */
  function calculateWaveChange(currentPrice, waveLow, waveHigh) {
    const waveChangeUp = waveLow !== 0 ? (currentPrice - waveLow) / waveLow : 0;
    const waveChangeDown = waveHigh !== 0 ? (waveHigh - currentPrice) / waveHigh : 0;
    
    return {
      waveChangeUp,
      waveChangeDown
    };
  }
  
  module.exports = {
    calculateWavePatterns,
    calculateDynamicWaveLength,
    calculateWaveChange
  };
  