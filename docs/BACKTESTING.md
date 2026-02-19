# Backtesting

## Engine Overview
The engine executes user strategy code over generated historical candle data.

Execution signature inside strategy:
```js
(data, portfolio, cash, executeOrder) => { ... }
```

## Returned Metrics
- `totalReturn`
- `sharpeRatio`
- `maxDrawdown`
- `winRate`
- `totalTrades`
- `equity[]`

## Current Behavior Notes
- Historical candles are synthetic (randomized)
- Strategy execution uses `new Function(...)`
- Execution errors end loop for current run

## Production Hardening Recommendations
- Replace synthetic data with broker/data-provider feed
- Sandbox strategy runtime
- Add deterministic replay mode
- Add slippage/fees/latency models
