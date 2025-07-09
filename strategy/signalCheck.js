function checkBuySignal(data, atrArray, macd) {
  try {
    if (!data || !Array.isArray(data) || data.length < 2) {
      console.warn('⚠️ checkBuySignal: Invalid data array');
      return false;
    }

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

    let macdArray, signalArray;
    if (macd.macd && Array.isArray(macd.macd)) {
      macdArray = macd.macd;
      signalArray = macd.signal;
    } else {
      console.warn('⚠️ checkBuySignal: Cannot find MACD arrays in object');
      return false;
    }

    if (!Array.isArray(macdArray) || !Array.isArray(signalArray)) return false;
    if (macdArray.length < 2 || signalArray.length < 2) return false;

    const formattedData = data.map(candle =>
      Array.isArray(candle)
        ? { timestamp: candle[0], open: candle[1], high: candle[2], low: candle[3], close: candle[4], volume: candle[5] }
        : candle
    );

    const i = formattedData.length - 1;
    const close = formattedData[i].close;
    const low = Math.min(...formattedData.slice(-20).map(c => c.low));
    const waveChangeUp = (formattedData[i].high - low) / low;
    const lastCandle = formattedData[i];

    const macdLine = macdArray[macdArray.length - 1];
    const signalLine = signalArray[signalArray.length - 1];
    const prevMacd = macdArray[macdArray.length - 2];
    const prevSignal = signalArray[signalArray.length - 2];

    const buyConditions = {
      waveUp: waveChangeUp > 0.003,
      macdAboveSignal: macdLine > signalLine,
      macdCrossedUp: prevMacd <= prevSignal,
      priceAboveLow: close > low,
      greenCandle: lastCandle.close > lastCandle.open
    };

    console.log('📊 BUY умови:', {
      ...buyConditions,
      close, low, macdLine, signalLine, prevMacd, prevSignal
    });

    return (
      buyConditions.waveUp &&
      buyConditions.macdAboveSignal &&
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
    if (!data || !Array.isArray(data) || data.length < 2) {
      console.warn('⚠️ checkSellSignal: Invalid data array');
      return false;
    }

    console.log('🔍 MACD object structure (SELL):', {
      type: typeof macd,
      keys: macd ? Object.keys(macd) : 'null',
      macdExists: macd?.macd ? 'yes' : 'no',
      signalExists: macd?.signal ? 'yes' : 'no',
      histogramExists: macd?.histogram ? 'yes' : 'no'
    });

    if (!macd || typeof macd !== 'object') return false;

    let macdArray, signalArray;
    if (macd.macd && Array.isArray(macd.macd)) {
      macdArray = macd.macd;
      signalArray = macd.signal;
    } else {
      console.warn('⚠️ checkSellSignal: Cannot find MACD arrays in object');
      return false;
    }

    if (!Array.isArray(macdArray) || !Array.isArray(signalArray)) return false;
    if (macdArray.length < 2 || signalArray.length < 2) return false;

    const formattedData = data.map(candle =>
      Array.isArray(candle)
        ? { timestamp: candle[0], open: candle[1], high: candle[2], low: candle[3], close: candle[4], volume: candle[5] }
        : candle
    );

    const i = formattedData.length - 1;
    const close = formattedData[i].close;
    const high = Math.max(...formattedData.slice(-20).map(c => c.high));
    const waveChangeDown = (high - formattedData[i].low) / high;
    const lastCandle = formattedData[i];

    const macdLine = macdArray[macdArray.length - 1];
    const signalLine = signalArray[signalArray.length - 1];
    const prevMacd = macdArray[macdArray.length - 2];
    const prevSignal = signalArray[signalArray.length - 2];

    const sellConditions = {
      waveDown: waveChangeDown > 0.003,
      macdBelowSignal: macdLine < signalLine,
      macdCrossedDown: prevMacd >= prevSignal,
      priceBelowHigh: close < high,
      redCandle: lastCandle.close < lastCandle.open
    };

    console.log('📊 SELL умови:', {
      ...sellConditions,
      close, high, macdLine, signalLine, prevMacd, prevSignal
    });

    return (
      sellConditions.waveDown &&
      sellConditions.macdBelowSignal &&
      sellConditions.priceBelowHigh &&
      sellConditions.redCandle
    );

  } catch (error) {
    console.error('🔴 checkSellSignal error:', error.message);
    return false;
  }
}

module.exports = { checkBuySignal, checkSellSignal };
