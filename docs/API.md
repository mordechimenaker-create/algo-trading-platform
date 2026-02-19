# API Documentation

Base URL (local): `http://localhost:3001`

Authentication: Bearer JWT in `Authorization` header.

## Auth
### `POST /api/auth/signup`
Create user account.

Request:
```json
{
  "username": "alice",
  "email": "alice@example.com",
  "password": "password123"
}
```

### `POST /api/auth/login`
Login and receive JWT.

### `GET /api/auth/me`
Return current user profile and billing fields.

## Billing
### `POST /api/billing/checkout-session`
Create Stripe checkout session for paid plans.

Request:
```json
{
  "plan": "pro",
  "success_url": "https://yourdomain.com/?billing=success",
  "cancel_url": "https://yourdomain.com/?billing=cancel"
}
```

### `POST /api/billing/portal-session`
Create Stripe billing portal session.

### `POST /api/billing/webhook`
Stripe webhook endpoint (raw body + signature verification).

### `POST /api/billing/subscribe`
Free downgrade path.

### `GET /api/billing/status`
Read billing/subscription status for current user.

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
  "days": 30
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
- `403` forbidden or plan limit hit
- `404` resource not found (or not owned)
- `500` server failure
