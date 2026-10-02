/**
 * Бектест стратегій з папки strategy/ на історії Binance Futures (публічні дані, ключі не потрібні).
 *
 *   node backtest/backtest.js                       # стратегія з config.strategy
 *   node backtest/backtest.js --strategy=waveClassic
 *   node backtest/backtest.js --compare             # усі стратегії на однакових даних
 *   node backtest/backtest.js --days=180 --tf=1h --csv
 *
 * Модель виконання (максимально близька до бота):
 *  • сигнал рахується на закритій свічці, вхід — по open наступної (як бот входить одразу після закриття);
 *  • SL / TP / трейлінг перевіряються по high/low свічки; якщо SL і TP в одній свічці — вважаємо, що спрацював SL;
 *  • якщо трейлінг активувався в цій свічці, вважаємо, що ціна могла одразу відкотитись до нового SL (песимістично);
 *  • комісія та проковзування — з config.backtest; розмір позиції та ліміти ризику — ті самі, що в боті.
 */
const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const { getStrategy, listStrategies, buildStops } = require('../strategy');
const RiskManager = require('../trading/riskManager');

// ─── Симуляція ───────────────────────────────────────────────────────────────

function simulate(candles, strategy, opts = {}) {
  const {
    startEquity = 1000,
    feePercent = 0.05,
    slippagePercent = 0.02,
    leverage = 20,
    riskCfg = {},
    reverseOnSignal = true,
    window = 500
  } = opts;

  const fee = feePercent / 100;
  const slip = slippagePercent / 100;
  const rm = new RiskManager(riskCfg);          // без збереження на диск

  let equity = startEquity;
  let peak = equity;
  let maxDD = 0;
  let pos = null;
  let pending = null;
  let blockedByRisk = 0;
  const trades = [];

  const dir = (side) => (side === 'buy' ? 1 : -1);

  function closePos(price, reason, time) {
    const d = dir(pos.side);
    const exit = price * (1 - d * slip);
    const gross = d * (exit - pos.entry) * pos.qty;
    const fees = pos.feeIn + exit * pos.qty * fee;
    const pnl = gross - fees;
    equity += pnl;

    trades.push({
      side: pos.side === 'buy' ? 'LONG' : 'SHORT',
      openTime: pos.openTime,
      closeTime: time,
      entry: pos.entry,
      exit,
      qty: pos.qty,
      pnl,
      r: pos.riskAmount > 0 ? pnl / pos.riskAmount : 0,
      reason,
      bars: Math.round((time - pos.openTime) / pos.tfMs)
    });

    rm.recordResult(pnl, equity, time);
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, (peak - equity) / peak);
    pos = null;
  }

  function openPos(p, openPrice, time, tfMs) {
    const gate = rm.canTrade(equity, time);
    if (!gate.ok) { blockedByRisk++; return; }

    const d = dir(p.side);
    const entry = openPrice * (1 + d * slip);
    const { qty: rawQty } = rm.calcQty({ equity, price: entry, slDistance: p.levels.slDist, leverage });
    const qty = Math.floor(rawQty * 1000) / 1000;
    if (!(qty > 0) || equity <= 0) return;

    const stops = buildStops(entry, p.side, p.levels);
    pos = {
      side: p.side,
      entry,
      qty,
      sl: stops.stopLoss,
      tp: stops.takeProfit,
      act: stops.trailingActivationDistance,
      offset: stops.trailingStopDistance,
      trailOn: false,
      extreme: entry,
      openTime: time,
      tfMs,
      feeIn: entry * qty * fee,
      riskAmount: qty * p.levels.slDist
    };
  }

  function manageBar(bar) {
    const [t, o, h, l] = bar;
    const d = dir(pos.side);

    // 1) стоп / тейк по рівнях, що діяли на початок свічки
    const stopHit = d > 0 ? l <= pos.sl : h >= pos.sl;
    const tpHit   = d > 0 ? h >= pos.tp : l <= pos.tp;
    if (stopHit) {
      const fill = d > 0 ? Math.min(o, pos.sl) : Math.max(o, pos.sl);
      return closePos(fill, pos.trailOn ? 'TRAIL' : 'SL', t);
    }
    if (tpHit) return closePos(pos.tp, 'TP', t);

    // 2) трейлінг: активація та підтягування стопа по екстремуму свічки
    const actLevel = pos.entry + d * pos.act;
    if (!pos.trailOn && (d > 0 ? h >= actLevel : l <= actLevel)) pos.trailOn = true;

    if (pos.trailOn) {
      pos.extreme = d > 0 ? Math.max(pos.extreme, h) : Math.min(pos.extreme, l);
      const newSl = pos.extreme - d * pos.offset;
      if (d * (newSl - pos.sl) > 0) {
        pos.sl = newSl;
        const hit = d > 0 ? l <= pos.sl : h >= pos.sl;
        if (hit) return closePos(pos.sl, 'TRAIL', t);   // песимістично
      }
    }
  }

  const tfMs = opts.tfMs || (candles.length > 1 ? candles[1][0] - candles[0][0] : 900000);
  const warm = strategy.minCandles;

  for (let b = warm; b < candles.length; b++) {
    const bar = candles[b];

    // 1) виконуємо сигнал попередньої закритої свічки по open цієї
    if (pending) {
      const p = pending;
      pending = null;
      if (pos && pos.side !== p.side && reverseOnSignal) closePos(bar[1], 'REVERSE', bar[0]);
      if (!pos) openPos(p, bar[1], bar[0], tfMs);
    }

    // 2) ведемо позицію всередині свічки
    if (pos) manageBar(bar);

    // 3) сигнал на закритті свічки
    const from = Math.max(0, b + 1 - window);
    const analysis = strategy.analyze(candles.slice(from, b + 1));
    if (analysis.ready && analysis.signal) {
      const wantSide = analysis.signal;
      if (!(pos && pos.side === wantSide)) {
        pending = { side: wantSide, levels: analysis.levels };
      }
    }
  }

  if (pos) {
    const last = candles[candles.length - 1];
    closePos(last[4], 'END', last[0]);
  }

  return { trades, equity, maxDD, blockedByRisk, startEquity, candlesUsed: candles.length - warm };
}

// ─── Статистика ──────────────────────────────────────────────────────────────

function computeStats(result, candles, warm) {
  const { trades, equity, startEquity, maxDD } = result;
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const net = equity - startEquity;

  const reasons = {};
  for (const t of trades) reasons[t.reason] = (reasons[t.reason] || 0) + 1;

  const first = candles[warm]?.[4];
  const last = candles[candles.length - 1][4];

  return {
    trades: trades.length,
    longs: trades.filter(t => t.side === 'LONG').length,
    shorts: trades.filter(t => t.side === 'SHORT').length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
    net,
    returnPct: (net / startEquity) * 100,
    maxDDPct: maxDD * 100,
    avgWin: wins.length ? grossWin / wins.length : 0,
    avgLoss: losses.length ? -grossLoss / losses.length : 0,
    expectancy: trades.length ? net / trades.length : 0,
    avgR: trades.length ? trades.reduce((s, t) => s + t.r, 0) / trades.length : 0,
    avgBars: trades.length ? trades.reduce((s, t) => s + t.bars, 0) / trades.length : 0,
    reasons,
    blockedByRisk: result.blockedByRisk,
    buyHoldPct: first ? ((last - first) / first) * 100 : 0
  };
}

function printStats(id, s) {
  const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '∞');
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`📊 ${id}`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`Угод: ${s.trades} (LONG ${s.longs} / SHORT ${s.shorts}), пропущено ризик-лімітами: ${s.blockedByRisk}`);
  console.log(`Win rate: ${f(s.winRate, 1)}%   Profit factor: ${f(s.profitFactor)}`);
  console.log(`Чистий PnL: ${s.net >= 0 ? '+' : ''}${f(s.net)} USDT (${f(s.returnPct)}%)   Макс. просадка: ${f(s.maxDDPct)}%`);
  console.log(`Сер. виграш: ${f(s.avgWin)}   Сер. збиток: ${f(s.avgLoss)}   Матсподівання/угоду: ${f(s.expectancy)} USDT (${f(s.avgR)} R)`);
  console.log(`Сер. тривалість: ${f(s.avgBars, 1)} свічок   Виходи: ${Object.entries(s.reasons).map(([k, v]) => `${k}=${v}`).join(', ') || '—'}`);
  console.log(`Для порівняння, buy&hold за період: ${f(s.buyHoldPct)}%`);
  if (s.trades < 50) console.log('⚠️  Менше 50 угод — статистика ненадійна. Збільште --days або спробуйте інший таймфрейм.');
}

function saveCsv(id, trades) {
  const file = path.join(__dirname, `trades_${id}.csv`);
  const rows = ['side,open,close,entry,exit,qty,pnl,r,reason,bars'];
  for (const t of trades) {
    rows.push([
      t.side, new Date(t.openTime).toISOString(), new Date(t.closeTime).toISOString(),
      t.entry.toFixed(4), t.exit.toFixed(4), t.qty, t.pnl.toFixed(4), t.r.toFixed(3), t.reason, t.bars
    ].join(','));
  }
  fs.writeFileSync(file, rows.join('\n'));
  console.log(`💾 Угоди збережено: ${file}`);
}

// ─── Завантаження історії ────────────────────────────────────────────────────

function toCcxtSymbol(symbol) {
  if (symbol.includes('/')) return symbol;
  return symbol.endsWith('USDT') ? `${symbol.slice(0, -4)}/USDT:USDT` : symbol;
}

async function fetchHistory(symbol, timeframe, days, warmBars) {
  const ccxt = require('ccxt');
  const ex = new ccxt.binance({ enableRateLimit: true, options: { defaultType: 'future' } });
  await ex.loadMarkets();
  const sym = toCcxtSymbol(symbol);
  const tfMs = ex.parseTimeframe(timeframe) * 1000;

  const end = Date.now();
  let since = end - days * 86400000 - warmBars * tfMs;
  const all = [];

  console.log(`📥 Завантаження ${sym} ${timeframe} за ${days} днів (+${warmBars} свічок прогріву)...`);
  while (since < end) {
    const batch = await ex.fetchOHLCV(sym, timeframe, since, 1000);
    if (!batch.length) break;
    all.push(...batch);
    const lastTs = batch[batch.length - 1][0];
    if (lastTs + tfMs <= since) break;
    since = lastTs + tfMs;
    if (batch.length < 2) break;
  }

  // унікальні, відсортовані, без свічки, що ще формується
  const map = new Map(all.map(c => [c[0], c]));
  const candles = [...map.values()].sort((a, b) => a[0] - b[0]);
  if (candles.length && candles[candles.length - 1][0] + tfMs > Date.now()) candles.pop();
  console.log(`✅ Свічок: ${candles.length} (${new Date(candles[0][0]).toLocaleDateString('uk-UA')} → ${new Date(candles.at(-1)[0]).toLocaleDateString('uk-UA')})`);
  return { candles, tfMs };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = {};
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) args[m[1]] = m[2] === undefined ? true : m[2];
  }
  return args;
}

async function main() {
  const args = parseArgs();
  const symbol = args.symbol || config.symbol;
  const timeframe = args.tf || config.timeframe;
  const days = Number(args.days) || config.backtest.days;

  const names = args.compare ? listStrategies() : [args.strategy || config.strategy];
  const strategies = names.map(n => getStrategy(n, config.strategies?.[n]));
  const warmBars = Math.max(...strategies.map(s => s.minCandles)) + 10;

  const { candles, tfMs } = await fetchHistory(symbol, timeframe, days, warmBars);

  const summary = [];
  for (const strategy of strategies) {
    const result = simulate(candles, strategy, {
      startEquity: config.backtest.startEquity,
      feePercent: config.backtest.feePercent,
      slippagePercent: config.backtest.slippagePercent,
      leverage: config.leverage,
      riskCfg: config.risk,
      reverseOnSignal: config.position.reverseOnSignal,
      window: config.candlesLimit,
      tfMs
    });
    const stats = computeStats(result, candles, strategy.minCandles);
    printStats(strategy.id, stats);
    if (args.csv) saveCsv(strategy.id, result.trades);
    summary.push({ id: strategy.id, ...stats });
  }

  if (summary.length > 1) {
    console.log(`\n${'═'.repeat(60)}\n📋 ПОРІВНЯННЯ\n${'═'.repeat(60)}`);
    console.table(summary.map(s => ({
      стратегія: s.id,
      угод: s.trades,
      'win%': Number(s.winRate.toFixed(1)),
      PF: Number.isFinite(s.profitFactor) ? Number(s.profitFactor.toFixed(2)) : '∞',
      'PnL%': Number(s.returnPct.toFixed(2)),
      'maxDD%': Number(s.maxDDPct.toFixed(2))
    })));
  }
}

module.exports = { simulate, computeStats };

if (require.main === module) {
  main().catch(err => { console.error('🔴 Помилка бектесту:', err.message); process.exit(1); });
}
