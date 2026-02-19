# Deployment Guide

## Goals
- HTTPS public access
- Stripe webhook reliability
- Managed stateful services for scale

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
- Routes `/api` and `/health` to backend
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

## CI/CD Baseline (GitHub Actions)
- Lint/test job on PR
- Build container images on main
- Deploy workflow to server (SSH or platform-native)
- Healthcheck gate before marking deploy successful

## Hardening Checklist
- Rotate secrets
- Restrict database exposure
- Enable backups and PITR
- Configure monitoring and alerts
- Add rate limiting/WAF
