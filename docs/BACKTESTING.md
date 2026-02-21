# Backtesting

## Engine Overview
The engine executes user strategy code in a VM sandbox over historical candle data.

Strategy runtime context:
- `data` (current candle)
- `portfolio`
- `cash`
- `executeOrder(side, quantity, price, symbol?)`

## Returned Metrics
- `totalReturn`
- `sharpeRatio`
- `maxDrawdown`
- `winRate`
- `totalTrades`
- `totalFeesPaid`
- `slippageBps`
- `latencyMs`
- `equity[]`

## Execution Models
Backtests support optional simulation knobs (request body or env defaults):
- `fee_bps`
- `fee_fixed`
- `slippage_bps`
- `latency_ms`

## Current Behavior Notes
- Historical candles are synthetic by default.
- Unit tests can inject deterministic candle arrays.
- Strategy syntax/runtime errors fail the current run.

## Known Limitations
- Tick-level data is not implemented yet.
- Full portfolio/multi-asset backtests are partial (single-candle stream).
- No market impact model yet.

## Production Hardening Recommendations
- Replace synthetic data with provider feed.
- Add deterministic replay mode from persisted candles.
- Add portfolio-level risk and exposure constraints.
- Add benchmark comparison and transaction cost profiles.
