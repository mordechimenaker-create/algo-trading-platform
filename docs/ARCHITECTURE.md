# Architecture

## Components
- `frontend` (Nginx static host)
  - serves `dashboard.html`
  - proxies `/api` and `/health` to backend
- `backend` (Node.js + Express)
  - auth, billing, strategy APIs, backtesting, orders
  - WebSocket for live prices
- `postgres`
  - users, strategies, backtest_results, orders
- `redis`
  - reserved for fast state/cache use in realtime workloads

## Data Ownership Model
- Every protected endpoint uses JWT and `req.user.id`
- Strategy/backtest/order queries are user-scoped
- Billing state is persisted on `users` table via Stripe webhooks

## Billing Flow (Stripe)
1. User logs in and clicks paid plan
2. Backend creates Stripe Checkout Session
3. User pays in Stripe-hosted checkout
4. Stripe sends webhook to backend
5. Backend maps `price_id` to plan and updates user record
6. Usage limits are enforced from persisted plan

## Trading Flow
1. User creates strategy code
2. Strategy stored in DB (owned by user)
3. Backtest endpoint executes strategy over generated candles
4. Metrics + curve returned and persisted
5. Dashboard renders results in charts and logs
