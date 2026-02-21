# Load Testing

A basic k6 smoke profile is included at `tests/load/k6-smoke.js`.

## Run
```bash
k6 run tests/load/k6-smoke.js
```

With custom target and load:
```bash
BASE_URL=http://localhost:3001 VUS=50 DURATION=2m k6 run tests/load/k6-smoke.js
```

## What It Covers
- `/health`
- `/api/orderbook/AAPL`

Use this as a baseline and extend with authenticated flows (`/auth/login`, `/api/backtest`, `/api/orders`) in a staging environment.
