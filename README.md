# binanceTradeBot

Бот для Binance USDⓈ-M Futures (Demo Trading або реальний акаунт) зі змінними стратегіями.

## Запуск
```
npm install
npm install ccxt@latest      # потрібна свіжа версія (Demo Trading, нові умовні ордери)
node index.js                # живий/демо бот
node backtest/backtest.js    # бектест стратегії з config.strategy
node backtest/backtest.js --compare --days=365 --csv
```
Потрібен Node.js ≥ 20.19 (або 22). У `.env`: `BINANCE_API_KEY`, `BINANCE_API_SECRET`
(для Demo — ключі з demo.binance.com), `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
`BINANCE_DEMO=false` — реальний акаунт.

## Ціль оптимізації

Поточні `waveClassic` і `waveImproved` налаштовані на підвищений win-rate: сигнали фільтруються через хвилю, EMA-тренд, ADX/DI, MACD, RSI, волатильність і свічку. Значення **70% win-rate не гарантується** без перевірки на конкретному активі/таймфреймі; для оцінки використовуйте щонайменше 365 днів і враховуйте комісію та slippage. Підвищення win-rate також не означає автоматично вищу чисту прибутковість.

Рекомендований запуск:
```
node backtest/backtest.js --compare --days=365 --csv
```

## Структура
```
config/config.js        вибір стратегії (strategy), її параметри, ризик, бектест
strategy/index.js       реєстр стратегій + buildStops()
strategy/waveImproved.js  покращена хвильова стратегія
strategy/waveClassic.js   оригінальна (для порівняння)
indicators/             ATR, MACD, EMA, ADX
trading/riskManager.js  розмір від ризику, денний ліміт, пауза після серії збитків
trading/executeOrder.js ордери, SL/TP на біржі, трейлінг, синхронізація, PnL
backtest/backtest.js    бектест на історії Binance
state/                  збережена позиція та лічильники ризику (створюється ботом)
```

## Як додати свою стратегію
1. Створіть `strategy/myStrategy.js`, що експортує
   `{ id, title, defaults, minCandles(params), analyze(closedCandles, params) }`.
   `analyze` повертає `{ ready, signal: 'buy'|'sell'|null, price, atr, levels, checks }`
   (`levels` = `{ slDist, tpDist, trailActivationDist, trailOffsetDist }` у цінових одиницях).
2. Додайте її в `strategy/index.js` (REGISTRY).
3. У `config.js`: `strategy: 'myStrategy'` і блок `strategies.myStrategy`.

Бектест і живий бот використовують один і той самий код стратегії та ризик-менеджера.
