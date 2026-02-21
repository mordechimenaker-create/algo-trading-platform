# API Documentation

Base URL (local): `http://localhost:3001`

- OpenAPI JSON: `GET /openapi.json`
- Swagger UI: `GET /docs`
- Prometheus metrics: `GET /metrics`

Authentication: Bearer access JWT in `Authorization` header.

## Auth
### `POST /api/auth/signup`
Create user account and return access+refresh tokens.

### `POST /api/auth/login`
Login and return access+refresh tokens.

### `POST /api/auth/refresh`
Rotate refresh token and issue a new access token.

Request:
```json
{
  "refresh_token": "..."
}
```

### `POST /api/auth/logout`
Revoke refresh session(s).

### `GET /api/auth/me`
Return current user profile, effective plan, and monthly usage counters.

## Billing
### `POST /api/billing/checkout-session`
Create Stripe checkout session for paid plans.

### `POST /api/billing/portal-session`
Create Stripe billing portal session.

### `POST /api/billing/webhook`
Stripe webhook endpoint (raw body + signature verification).

### `POST /api/billing/subscribe`
Free downgrade path.

### `GET /api/billing/status`
Read billing/subscription status + grace period + usage counters.

### `GET /api/usage/me`
Current monthly usage usage-units and remaining quota.

## Strategies
### `POST /api/strategies`
Create strategy.

### `GET /api/strategies`
List current user strategies.

### `GET /api/strategies/:id`
Get one strategy (owned by current user).

### `PUT /api/strategies/:id`
Update strategy.

### `DELETE /api/strategies/:id`
Delete strategy.

## Backtesting
### `POST /api/backtest`
Run backtest for strategy owned by user.

Request:
```json
{
  "strategy_id": 1,
  "days": 30,
  "fee_bps": 2,
  "fee_fixed": 0,
  "slippage_bps": 3,
  "latency_ms": 25
}
```

### `GET /api/backtests/:strategy_id`
List recent backtest results for strategy.

## Orders
### `POST /api/orders`
Create simulated order.

### `GET /api/orders`
List current user orders.

## Market / Health
### `GET /api/orderbook/:symbol`
Return synthetic orderbook snapshot.

### `GET /health`
Health probe endpoint.

## Error Semantics
- `401` unauthenticated/invalid token
- `403` forbidden or plan/usage limit hit
- `404` resource not found (or not owned)
- `429` rate limit exceeded
- `500` server failure
