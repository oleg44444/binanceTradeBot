/**
 * Розрахунок локальних хвиль (wave analysis)
 * Знаходить локальні максимуми та мінімуми за останні N свічок
 */

function calculateWavePatterns(candles, waveLengthDynamic = 8) {
    if (candles.length < waveLengthDynamic) {
      return {
        isValid: false,
        waveHigh: null,
        waveLow: null,
        waveChangeUp: 0,
        waveChangeDown: 0,
        lastWaveHigh: null,
        lastWaveLow: null
      };
    }
  
    const highs = candles.map(c => c[1]);
    const lows = candles.map(c => c[2]);
    
    // Локальний максимум - найвища ��очка за останні N свічок
    const waveHigh = Math.max(...highs.slice(-waveLengthDynamic));
    
    // Локальний мінімум - найнижча точка за останні N свічок
    const waveLow = Math.min(...lows.slice(-waveLengthDynamic));
    
    // Останній максимум та мінімум
    const currentHigh = highs[highs.length - 1];
    const currentLow = lows[lows.length - 1];
    
    // Відсоток зміни від хвильового мінімуму до поточної ціни
    const waveChangeUp = waveLow > 0 ? (currentHigh - waveLow) / waveLow : 0;
    
    // Відсоток зміни від поточної ціни до хвильового максимуму
    const waveChangeDown = waveHigh > 0 ? (waveHigh - currentLow) / waveHigh : 0;
    
    return {
      isValid: true,
      waveHigh,
      waveLow,
      waveChangeUp,
      waveChangeDown,
      currentHigh,
      currentLow
    };
  }
  
  /**
   * Динамічна довжина хвилі на основі ATR
   * @param {number} atr - Поточне значення ATR
   * @param {number} minWaveLength - Мінімальна довжина хвилі
   * @param {number} maxWaveLength - Максимальна довжина хвилі
   */
  function calculateDynamicWaveLength(atr, minWaveLength = 8, maxWaveLength = 21) {
    if (atr === null || atr === undefined) {
      return minWaveLength;
    }
    
    const waveLengthRaw = atr * 10;
    return Math.round(Math.min(Math.max(waveLengthRaw, minWaveLength), maxWaveLength));
  }
  
  module.exports = {
    calculateWavePatterns,
    calculateDynamicWaveLength
  };
  