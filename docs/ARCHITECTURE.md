# Architecture

## Components
- `frontend` (Nginx static host)
  - serves `dashboard.html`
  - proxies `/api` and `/health` to backend
- `backend` (Node.js + Express)
  - auth, billing, strategy APIs, backtesting, orders
  - refresh token rotation + rate limiting + usage enforcement
  - WebSocket for live prices
  - OpenAPI (`/openapi.json`), Swagger UI (`/docs`), metrics (`/metrics`)
- `postgres`
  - users, strategies, backtest_results, orders
  - refresh_tokens, usage_events
- `redis`
  - cache/realtime support (current pub/sub placeholder)

## Data Ownership Model
- Every protected endpoint uses JWT and `req.user.id`
- Strategy/backtest/order queries are user-scoped
- Billing state is persisted on `users` table via Stripe webhooks
- Refresh tokens are stored hashed in `refresh_tokens`

## Billing and Quota Flow
1. User logs in and requests plan checkout.
2. Backend creates Stripe Checkout Session.
3. Stripe webhook updates persisted subscription state.
4. Effective plan is derived from active status and grace period.
5. Hard limits enforced:
- strategy count per plan
- backtests per day per plan
- monthly usage-units for backtests/orders

## Trading/Backtest Flow
1. User creates strategy code.
2. Strategy stored in DB (owned by user).
3. Backtest executes over OHLC candles with optional:
- fees
- slippage
- latency
4. Metrics and equity curve are returned and persisted.

## Security Controls
- Access + refresh JWT model with refresh rotation
- In-memory rate limiting by endpoint class (auth/private/public)
- Input validation for strategy/order payloads
- Stripe webhook signature verification
- Security headers for browser clients

## Observability
- `GET /health` for liveness
- `GET /metrics` for Prometheus scraping
- Route/status counters in-process

## Scale Roadmap (next)
- Split backend into focused services:
  - `auth-billing-service`
  - `strategy-backtest-service`
  - `execution-order-service`
- Introduce durable broker (Kafka/RabbitMQ) for critical async flows.
- Add centralized logs and traces (ELK + OpenTelemetry).
- Move to orchestrated production deployment (ECS/Kubernetes).
- Add managed secrets (Vault / AWS Secrets Manager).
