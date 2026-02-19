# Stripe Setup

1. Create products/prices in Stripe:
- Pro monthly -> copy `price_...` into `STRIPE_PRICE_ID_PRO`
- Enterprise monthly -> copy `price_...` into `STRIPE_PRICE_ID_ENTERPRISE`

2. Create local `.env` from `.env.example` and set keys.

3. Start stack:
```bash
docker compose up --build -d
```

4. Forward Stripe webhooks to local backend:
```bash
stripe listen --forward-to localhost:3001/api/billing/webhook
```
Copy the printed signing secret into `STRIPE_WEBHOOK_SECRET`.

5. Test subscription flow:
- Login in dashboard
- Click `Checkout Pro` or `Checkout Enterprise`
- Complete Stripe Checkout
- Stripe webhook updates user `plan` in DB

6. Open Billing Portal from dashboard to manage/cancel subscription.
