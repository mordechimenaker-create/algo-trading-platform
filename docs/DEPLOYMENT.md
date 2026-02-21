# Deployment Guide

## Goals
- HTTPS public access
- Stripe webhook reliability
- Managed stateful services for scale
- Observable and secure runtime

## Recommended Production Topology
- App VM(s): backend + frontend + reverse proxy
- Managed PostgreSQL (RDS/Cloud SQL/DO Managed)
- Managed Redis (ElastiCache/Redis Cloud/DO Managed)
- DNS: Cloudflare or Route53

## Production Compose
Use `docker-compose.prod.yml` as baseline.

## Reverse Proxy
Template: `deploy/nginx/reverse-proxy.conf`
- Terminates TLS
- Routes `/api`, `/health`, `/metrics`, `/docs` to backend
- Serves frontend at `/`

## HTTPS
Options:
- Let's Encrypt via certbot
- Cloudflare proxy + origin certificate

## Stripe Production Setup
1. Create Stripe products/prices (Pro + Enterprise)
2. Set env:
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_ID_PRO`
- `STRIPE_PRICE_ID_ENTERPRISE`
3. Configure webhook endpoint:
- `https://yourdomain.com/api/billing/webhook`
4. Enable required webhook events:
- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`

## Env Vars (Security/Quota/Backtesting)
- `JWT_SECRET`
- `ACCESS_TOKEN_EXPIRES_IN`
- `REFRESH_TOKEN_EXPIRES_DAYS`
- `RATE_LIMIT_*`
- `BILLING_GRACE_DAYS`
- `STRICT_USAGE_CAP`
- `BACKTEST_FEE_BPS`
- `BACKTEST_FEE_FIXED`
- `BACKTEST_SLIPPAGE_BPS`
- `BACKTEST_LATENCY_MS`

## Observability
- Liveness: `GET /health`
- Metrics: `GET /metrics` (Prometheus format)
- API docs: `GET /docs`

Minimum stack:
- Prometheus scrape backend `/metrics`
- Grafana dashboard for request rate/error/rate-limit counters
- Centralized logs (ELK/Loki)

## Secrets Management
Preferred production options:
- AWS Secrets Manager
- HashiCorp Vault
- GCP Secret Manager

Avoid long-lived plaintext secrets in compose files or shell history.

## CI/CD Baseline (GitHub Actions)
- Test job on PR
- Build container images on main
- Deploy workflow to server (SSH or platform-native)
- Healthcheck gate before marking deploy successful

## Scale Path
- Move from Compose to ECS/Kubernetes for autoscaling and rollbacks.
- Introduce Kafka/RabbitMQ for durable async processing.
- Split backend into domain services once throughput requires it.

## Hardening Checklist
- Rotate secrets
- Restrict database exposure
- Enable backups and PITR
- Configure monitoring and alerts
- Add WAF and network ACLs
- Run periodic penetration testing
