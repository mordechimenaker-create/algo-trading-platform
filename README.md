# Algo Trading SaaS Platform

Production-style algo-trading platform with:
- JWT auth (signup/login)
- Plan-based limits (free/pro/enterprise)
- Stripe checkout + billing portal + webhook sync
- Backtesting engine
- Strategy management
- Order endpoints
- Live market stream dashboard (WebSocket)

## Stack
- Backend: Node.js + Express + WebSocket
- Frontend: Nginx static dashboard
- Database: PostgreSQL
- Cache: Redis
- Orchestration: Docker Compose

## Quick Start (Local)
```bash
cp .env.example .env
# Set Stripe variables in .env if you want real billing

docker compose up --build -d
```

Open:
- Dashboard: `http://localhost:8081`
- API: `http://localhost:3001`

Demo user:
- `demo@algo.local`
- `demo12345`

## Stripe Setup
See `STRIPE_SETUP.md`.

Required env vars for real Stripe:
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_ID_PRO`
- `STRIPE_PRICE_ID_ENTERPRISE`
- `APP_URL`

## Important API Endpoints
- `POST /api/auth/signup`
- `POST /api/auth/login`
- `GET /api/auth/me`
- `POST /api/billing/checkout-session`
- `POST /api/billing/portal-session`
- `POST /api/billing/webhook`
- `GET /api/billing/status`
- `POST /api/strategies`
- `GET /api/strategies`
- `POST /api/backtest`
- `POST /api/orders`
- `GET /api/orders`

## Publish To GitHub
```bash
git init
git add .
git commit -m "feat: algo trading saas with auth and stripe billing"

git branch -M main
git remote add origin <YOUR_REPO_URL>
git push -u origin main
```

## Security Notes
- Never commit real secrets.
- Use `.env` for production secrets.
- Rotate keys if exposed.
- Put backend behind HTTPS in production.

## License
MIT (see `LICENSE`).
