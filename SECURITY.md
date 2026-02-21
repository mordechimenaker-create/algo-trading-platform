# Security Policy

## Supported Versions

Security fixes are provided for the latest `main` branch and current production deployment.

## Reporting a Vulnerability

Please do not open public issues for security reports.

Report vulnerabilities by email to `mordechi.menaker@gmail.com` with:
- Steps to reproduce
- Impact assessment
- Suggested mitigation (optional)

We aim to acknowledge within 72 hours and provide a remediation plan.

## Secrets and Hardening

- Never commit `.env` files or API keys.
- Rotate leaked credentials immediately.
- For production, set strong `JWT_SECRET` (32+ chars), strict `CORS_ORIGINS`, and Stripe webhook secrets.
