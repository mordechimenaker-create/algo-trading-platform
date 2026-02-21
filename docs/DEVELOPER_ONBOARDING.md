# Developer Onboarding

## Prerequisites
- Docker + Docker Compose
- Node.js 20+
- (Optional) Stripe CLI for webhook testing

## First Run
1. Copy env template:
```bash
cp .env.example .env
```
2. Start stack:
```bash
docker compose up --build -d
```
3. Open:
- Dashboard: `http://localhost:8081`
- API: `http://localhost:3001`
- Swagger UI: `http://localhost:3001/docs`

Demo user:
- Email: `demo@algo.local`
- Password: `demo12345`

## Local Backend Tests
```bash
npm install --prefix backend
npm run test:unit --prefix backend
npm run test:integration --prefix backend
```

To run integration tests against a running API:
```bash
API_BASE_URL=http://localhost:3001 npm run test:integration --prefix backend
```

## Rate Limits and Auth
- Access tokens are short-lived (`ACCESS_TOKEN_EXPIRES_IN`, default `15m`).
- Refresh tokens are rotated via `POST /api/auth/refresh`.
- Default rate limits are configurable through env vars (`RATE_LIMIT_*`).

## Billing/Quota Behavior
- Plan limits apply to strategy count and daily backtests.
- Monthly usage units are enforced for backtests/orders.
- Billing grace period (`BILLING_GRACE_DAYS`) allows temporary degraded access.

## Observability
- Prometheus metrics: `GET /metrics`
- Health endpoint: `GET /health`

## Load Testing (Smoke)
Install k6 and run:
```bash
k6 run tests/load/k6-smoke.js
```

## Security Baseline
- Keep `JWT_SECRET` strong and private.
- Never commit real Stripe keys.
- Use a secrets manager in production.
