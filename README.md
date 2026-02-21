# Algo Trading SaaS Platform

A production-oriented algorithmic trading SaaS starter with authentication, Stripe subscriptions, strategy management, backtesting, and a live monitoring dashboard.

## Features
- JWT authentication (`signup`, `login`, `me`)
- Refresh token rotation (`/api/auth/refresh`, `/api/auth/logout`)
- Stripe subscription billing (`Checkout`, `Webhook`, `Billing Portal`)
- Plan-based usage limits (`free`, `pro`, `enterprise`)
- Role-based access control (`admin`, `user`, `read-only`)
- Audit logging for auth, strategy, backtest, order, and billing actions
- Grace period + monthly usage-unit enforcement
- Strategy CRUD with per-user isolation
- Backtesting engine with key metrics (return, Sharpe, drawdown, win rate) + fee/slippage/latency simulation
- Order endpoints and history tracking
- Live price stream via WebSocket
- Built-in OpenAPI endpoint (`/openapi.json`) + Swagger UI (`/docs`)
- Prometheus-style metrics endpoint (`/metrics`)
- Health endpoints: `/health`, `/live`, `/ready`
- Dockerized local environment (Backend, Frontend, PostgreSQL, Redis)

## Architecture
See full architecture notes in `docs/ARCHITECTURE.md`.

High-level services:
- `backend` (Node.js/Express/WebSocket)
- `frontend` (Nginx static dashboard)
- `postgres` (data persistence)
- `redis` (cache/realtime support)

## Screenshots
Add images to `docs/screenshots/` and update paths if needed.

- Dashboard: `docs/screenshots/dashboard.png`
- Strategy Editor: `docs/screenshots/strategy-editor.png`
- Backtest Results: `docs/screenshots/backtest-results.png`
- Live Monitor: `docs/screenshots/live-monitor.png`
- Billing: `docs/screenshots/billing.png`

## Local Setup
### 1) Clone
```bash
git clone https://github.com/mordechimenaker-create/algo-trading-platform.git
cd algo-trading-platform
```

### 2) Configure env
```bash
cp .env.example .env
# fill Stripe values when ready
```

### 3) Start stack
```bash
docker compose up --build -d
```

### 4) Open app
- Dashboard: `http://localhost:8081`
- API: `http://localhost:3001`

Demo user:
- Email: `demo@algo.local`
- Password: `demo12345`

## Stripe Billing Setup
Short guide: `STRIPE_SETUP.md`
Detailed guide: `docs/DEPLOYMENT.md#stripe-production-setup`

Required env values:
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_ID_PRO`
- `STRIPE_PRICE_ID_ENTERPRISE`
- `APP_URL`

## API Documentation
Full API docs: `docs/API.md`
OpenAPI JSON: `/openapi.json`
Swagger UI: `/docs`

Main groups:
- Auth
- Billing
- Activity / Admin Audit
- Strategies
- Backtesting
- Orders
- Health

## Backtesting Docs
See `docs/BACKTESTING.md` for:
- Engine behavior
- Metric definitions
- Known limitations

## Load Testing
See `docs/LOAD_TESTING.md`.

## PWA App Install
See `docs/PWA.md` to install the dashboard as a web app on desktop/mobile.

## Windows EXE
See `docs/EXE_BUILD.md` to build a Windows `.exe` desktop wrapper.

Latest Windows EXE release:
- Tag: `v31e5266`
- Release page: `https://github.com/mordechimenaker-create/algo-trading-platform/releases/tag/v31e5266`
- Direct EXE: `https://github.com/mordechimenaker-create/algo-trading-platform/releases/download/v31e5266/Algo-Trading-Platform-1.0.0-x64.exe`
- Behavior: on launch, tries to auto-start local stack (`docker compose up --build -d`) then opens dashboard.

## Live Simulation Docs
See `docs/LIVE_SIMULATION.md` for:
- WebSocket feed format
- Update cadence
- Frontend behavior

## Production Deployment
See `docs/DEPLOYMENT.md` for:
- `docker-compose.prod.yml`
- Reverse proxy setup
- HTTPS and domain setup
- Managed DB/Redis guidance
- CI/CD baseline

## Developer Onboarding
See `docs/DEVELOPER_ONBOARDING.md`.

## GitHub Actions (CI/CD)
Workflows included:
- `CI` (`.github/workflows/ci.yml`)
- `Docker Publish` (`.github/workflows/docker-publish.yml`)
- `Deploy` (`.github/workflows/deploy.yml`)
- `CodeQL` (`.github/workflows/codeql.yml`)
- `Release EXE` (`.github/workflows/release-exe.yml`)
- `Dependabot` (`.github/dependabot.yml`)

### Required GitHub Secrets
For Docker publishing:
- `DOCKERHUB_USERNAME` (optional, only if pushing to Docker Hub)
- `DOCKERHUB_TOKEN` (optional, only if pushing to Docker Hub)

For deployment over SSH:
- `VPS_HOST`
- `VPS_USER`
- `VPS_SSH_KEY`
- `VPS_PORT` (optional, defaults to `22`)
- `VPS_APP_PATH` (optional, defaults to `/opt/algo-trading-platform`)

If deploy secrets are missing, the Deploy workflow now exits gracefully with a warning instead of failing the push checks.

For production app runtime on server:
- Create `.env` on target server using `.env.example`
- Set Stripe and JWT values before first production deploy

## Repository Structure
```text
backend/                 API, auth, billing, backtesting
frontend/public/         Dashboard UI
db/init.sql              Schema and seed data
docker-compose.yml       Local/dev stack
docker-compose.prod.yml  Production-oriented stack
docs/                    Product + technical docs
deploy/nginx/            Reverse proxy configs
```

## Security Notes
- Never commit real secrets.
- Keep production secrets in `.env` or secret manager.
- Rotate tokens/keys if exposed.
- Enforce HTTPS in production.
- Restrict CORS and tighten JWT secret policy in production.

## License
MIT (`LICENSE`)
