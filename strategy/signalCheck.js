function checkBuySignal(data, atrArray, macd) {
  try {
    // Validate inputs
    if (!data || !Array.isArray(data) || data.length < 2) {
      console.warn('⚠️ checkBuySignal: Invalid data array');
      return false;
    }

    // Debug MACD object structure
    console.log('🔍 MACD object structure:', {
      type: typeof macd,
      keys: macd ? Object.keys(macd) : 'null',
      macdExists: macd?.macd ? 'yes' : 'no',
      signalExists: macd?.signal ? 'yes' : 'no',
      histogramExists: macd?.histogram ? 'yes' : 'no'
    });

    if (!macd || typeof macd !== 'object') {
      console.warn('⚠️ checkBuySignal: MACD is not an object');
      return false;
    }

    // Handle MACD object structure - тепер перевіряємо правильні властивості
    let macdArray, signalArray;
    
    if (macd.macd && Array.isArray(macd.macd)) {
      macdArray = macd.macd;
      signalArray = macd.signal;
      console.log('📊 Using macd.macd and macd.signal arrays');
    } else {
      console.warn('⚠️ checkBuySignal: Cannot find MACD arrays in object');
      return false;
    }

    if (!Array.isArray(macdArray) || !Array.isArray(signalArray)) {
      console.warn('⚠️ checkBuySignal: MACD arrays are not valid arrays');
      return false;
    }

    if (macdArray.length < 2 || signalArray.length < 2) {
      console.warn('⚠️ checkBuySignal: Insufficient MACD data');
      return false;
    }

    // Перетворюємо дані свічок в правильний формат
    const formattedData = data.map(candle => {
      if (Array.isArray(candle)) {
        // Формат: [timestamp, open, high, low, close, volume]
        return {
          timestamp: candle[0],
          open: candle[1],
          high: candle[2],
          low: candle[3],
          close: candle[4],
          volume: candle[5]
        };
      }
      return candle; // Вже в об'єктному форматі
    });

    const i = formattedData.length - 1;
    const close = formattedData[i].close;
    const low = Math.min(...formattedData.slice(-20).map(c => c.low));
    const waveChangeUp = (formattedData[i].high - low) / low;
    const lastCandle = formattedData[formattedData.length - 1];
    
    // Use the detected MACD arrays
    const macdLine = macdArray[macdArray.length - 1];
    const signalLine = signalArray[signalArray.length - 1];
    const prevMacd = macdArray[macdArray.length - 2];
    const prevSignal = signalArray[signalArray.length - 2];

    console.log('🔍 Перевірка BUY умови:', { 
      waveChangeUp: waveChangeUp.toFixed(6), 
      macdLine: macdLine?.toFixed(6), 
      signalLine: signalLine?.toFixed(6), 
      prevMacd: prevMacd?.toFixed(6), 
      prevSignal: prevSignal?.toFixed(6), 
      close, 
      low,
      candleGreen: lastCandle.close > lastCandle.open
    });

    const buyConditions = {
      waveUp: waveChangeUp > 0.003,
      macdAboveSignal: macdLine > signalLine,
      macdCrossedUp: prevMacd <= prevSignal,
      priceAboveLow: close > low,
      greenCandle: lastCandle.close > lastCandle.open
    };

    console.log('📊 BUY условия:', buyConditions);

    return (
      buyConditions.waveUp &&
      buyConditions.macdAboveSignal &&
      buyConditions.macdCrossedUp &&
      buyConditions.priceAboveLow &&
      buyConditions.greenCandle
    );

  } catch (error) {
    console.error('🔴 checkBuySignal error:', error.message);
    return false;
  }
}

function checkSellSignal(data, atrArray, macd) {
  try {
    // Validate inputs
    if (!data || !Array.isArray(data) || data.length < 2) {
      console.warn('⚠️ checkSellSignal: Invalid data array');
      return false;
    }

    // Debug MACD object structure
    console.log('🔍 MACD object structure (SELL):', {
      type: typeof macd,
      keys: macd ? Object.keys(macd) : 'null',
      macdExists: macd?.macd ? 'yes' : 'no',
      signalExists: macd?.signal ? 'yes' : 'no',
      histogramExists: macd?.histogram ? 'yes' : 'no'
    });

    if (!macd || typeof macd !== 'object') {
      console.warn('⚠️ checkSellSignal: MACD is not an object');
      return false;
    }

    // Handle MACD object structure
    let macdArray, signalArray;
    
    if (macd.macd && Array.isArray(macd.macd)) {
      macdArray = macd.macd;
      signalArray = macd.signal;
      console.log('📊 Using macd.macd and macd.signal arrays');
    } else {
      console.warn('⚠️ checkSellSignal: Cannot find MACD arrays in object');
      return false;
    }

    if (!Array.isArray(macdArray) || !Array.isArray(signalArray)) {
      console.warn('⚠️ checkSellSignal: MACD arrays are not valid arrays');
      return false;
    }

    if (macdArray.length < 2 || signalArray.length < 2) {
      console.warn('⚠️ checkSellSignal: Insufficient MACD data');
      return false;
    }

    // Перетворюємо дані свічок в правильний формат
    const formattedData = data.map(candle => {
      if (Array.isArray(candle)) {
        // Формат: [timestamp, open, high, low, close, volume]
        return {
          timestamp: candle[0],
          open: candle[1],
          high: candle[2],
          low: candle[3],
          close: candle[4],
          volume: candle[5]
        };
      }
      return candle; // Вже в об'єктному форматі
    });

    const i = formattedData.length - 1;
    const high = Math.max(...formattedData.slice(-20).map(c => c.high));
    const waveChangeDown = (high - formattedData[i].low) / high;
    const lastCandle = formattedData[formattedData.length - 1];
    
    // Use the detected MACD arrays
    const macdLine = macdArray[macdArray.length - 1];
    const signalLine = signalArray[signalArray.length - 1];
    const prevMacd = macdArray[macdArray.length - 2];
    const prevSignal = signalArray[signalArray.length - 2];

    console.log('🔍 Перевірка SELL умови:', { 
      waveChangeDown: waveChangeDown.toFixed(6), 
      macdLine: macdLine?.toFixed(6), 
      signalLine: signalLine?.toFixed(6), 
      prevMacd: prevMacd?.toFixed(6), 
      prevSignal: prevSignal?.toFixed(6),
      close: formattedData[i].close,
      high,
      redCandle: lastCandle.close < lastCandle.open
    });

    const sellConditions = {
      waveDown: waveChangeDown > 0.003,
      macdBelowSignal: macdLine < signalLine,
      macdCrossedDown: prevMacd >= prevSignal,
      priceBelowHigh: formattedData[i].close < high,
      redCandle: lastCandle.close < lastCandle.open
    };

    console.log('📊 SELL условия:', sellConditions);

    return (
      sellConditions.waveDown &&
      sellConditions.macdBelowSignal &&
      sellConditions.macdCrossedDown &&
      sellConditions.priceBelowHigh &&
      sellConditions.redCandle
    );

  } catch (error) {
    console.error('🔴 checkSellSignal error:', error.message);
    return false;
  }
}

module.exports = { checkBuySignal, checkSellSignal };