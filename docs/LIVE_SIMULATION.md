# Live Simulation

## Feed Model
- Backend broadcasts synthetic prices every second
- WebSocket message shape:
```json
{
  "type": "price_update",
  "prices": { "AAPL": 150.1, "GOOGL": 141.0, "MSFT": 381.2, "AMZN": 175.5 },
  "timestamp": "2026-02-19T23:00:00.000Z"
}
```

## Dashboard Behavior
- Connects to `ws://<host>` or `wss://<host>`
- Updates stat cards in near-real-time
- Appends rolling log window

## Production Hardening
- Persist ticks to time-series storage
- Add reconnect/backoff logic and heartbeats
- Add symbol subscriptions per client
