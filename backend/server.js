const express = require('express');
const { WebSocketServer } = require('ws');
const { createServer } = require('http');
const cors = require('cors');
const { Pool } = require('pg');
const redis = require('redis');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const Stripe = require('stripe');
const BacktestEngine = require('./backtest');
require('dotenv').config();

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

const JWT_SECRET = process.env.JWT_SECRET || 'dev-jwt-secret-change-in-production';
const JWT_EXPIRES_IN = '7d';
const APP_URL = process.env.APP_URL || 'http://localhost:8081';

const PLAN_LIMITS = {
  free: { strategies: 3, backtestsPerDay: 5 },
  pro: { strategies: 25, backtestsPerDay: 100 },
  enterprise: { strategies: 100000, backtestsPerDay: 100000 }
};

const PLAN_TO_PRICE_ID = {
  pro: process.env.STRIPE_PRICE_ID_PRO || '',
  enterprise: process.env.STRIPE_PRICE_ID_ENTERPRISE || ''
};

const ACTIVE_SUB_STATUSES = new Set(['active', 'trialing']);

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

const pool = new Pool({
  user: process.env.DB_USER || 'trader',
  password: process.env.DB_PASSWORD || 'password',
  host: process.env.DB_HOST || 'postgres',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'trading_db'
});

const redisClient = redis.createClient({
  url: `redis://${process.env.REDIS_HOST || 'redis'}:${process.env.REDIS_PORT || 6379}`
});
redisClient.on('error', (err) => console.log('Redis Error', err.message));
redisClient.connect().catch((err) => console.log('Redis connect warning:', err.message));

const clients = new Set();
let prices = { AAPL: 150.25, GOOGL: 140.8, MSFT: 380.5, AMZN: 175.3 };

app.use(cors());

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, username: user.username, plan: user.plan || 'free' },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function getAuthToken(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return null;
  return auth.slice(7);
}

function requireAuth(req, res, next) {
  const token = getAuthToken(req);
  if (!token) return res.status(401).json({ error: 'Missing token' });

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch (_err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function requireStripeConfigured(res) {
  if (!stripe) {
    res.status(500).json({
      error: 'Stripe is not configured',
      detail: 'Set STRIPE_SECRET_KEY, STRIPE_PRICE_ID_PRO, STRIPE_PRICE_ID_ENTERPRISE, STRIPE_WEBHOOK_SECRET'
    });
    return false;
  }
  return true;
}

function getPlanLimits(plan) {
  return PLAN_LIMITS[plan] || PLAN_LIMITS.free;
}

function getPlanByPriceId(priceId) {
  if (!priceId) return 'free';
  if (PLAN_TO_PRICE_ID.pro && PLAN_TO_PRICE_ID.pro === priceId) return 'pro';
  if (PLAN_TO_PRICE_ID.enterprise && PLAN_TO_PRICE_ID.enterprise === priceId) return 'enterprise';
  return 'free';
}

function derivePlanFromSubscription(status, priceId) {
  if (!ACTIVE_SUB_STATUSES.has(status)) return 'free';
  return getPlanByPriceId(priceId);
}

async function loadCurrentUser(userId) {
  const result = await pool.query(
    `SELECT id, username, email, plan, balance, created_at,
            stripe_customer_id, stripe_subscription_id, stripe_subscription_status,
            stripe_price_id, stripe_current_period_end
     FROM users
     WHERE id = $1`,
    [userId]
  );
  return result.rows[0] || null;
}

async function assertStrategyOwnership(strategyId, userId) {
  const result = await pool.query('SELECT * FROM strategies WHERE id = $1 AND user_id = $2', [strategyId, userId]);
  return result.rows[0] || null;
}

async function ensureStripeCustomer(user) {
  if (!stripe) return null;

  if (user.stripe_customer_id) return user.stripe_customer_id;

  const customer = await stripe.customers.create({
    email: user.email,
    name: user.username,
    metadata: { user_id: String(user.id) }
  });

  await pool.query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', [customer.id, user.id]);
  return customer.id;
}

async function updateUserFromSubscription({
  stripeCustomerId,
  stripeSubscriptionId,
  stripePriceId,
  stripeSubscriptionStatus,
  stripeCurrentPeriodEnd,
  fallbackUserId
}) {
  let userResult;

  if (stripeCustomerId) {
    userResult = await pool.query('SELECT id FROM users WHERE stripe_customer_id = $1', [stripeCustomerId]);
  } else {
    userResult = { rows: [] };
  }

  if (!userResult.rows.length && fallbackUserId) {
    userResult = await pool.query('SELECT id FROM users WHERE id = $1', [Number(fallbackUserId)]);
    if (userResult.rows.length && stripeCustomerId) {
      await pool.query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', [stripeCustomerId, userResult.rows[0].id]);
    }
  }

  if (!userResult.rows.length) return;

  const userId = userResult.rows[0].id;
  const mappedPlan = derivePlanFromSubscription(stripeSubscriptionStatus, stripePriceId);

  await pool.query(
    `UPDATE users
     SET plan = $1,
         stripe_subscription_id = $2,
         stripe_price_id = $3,
         stripe_subscription_status = $4,
         stripe_current_period_end = $5
     WHERE id = $6`,
    [
      mappedPlan,
      stripeSubscriptionId || null,
      stripePriceId || null,
      stripeSubscriptionStatus || 'inactive',
      stripeCurrentPeriodEnd || null,
      userId
    ]
  );
}

async function ensureSchema() {
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT');
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS plan VARCHAR(32) NOT NULL DEFAULT 'free'");
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(255)');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_id VARCHAR(255)');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_price_id VARCHAR(255)');
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_status VARCHAR(32) NOT NULL DEFAULT 'inactive'");
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_current_period_end TIMESTAMP');

  const demoUser = await pool.query('SELECT id FROM users WHERE email = $1', ['demo@algo.local']);
  if (demoUser.rows.length === 0) {
    const hash = await bcrypt.hash('demo12345', 10);
    await pool.query(
      `INSERT INTO users (username, email, balance, plan, stripe_subscription_status, password_hash)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ['demo', 'demo@algo.local', 25000, 'free', 'inactive', hash]
    );
  }
}

function broadcastPrices() {
  setInterval(() => {
    Object.keys(prices).forEach((symbol) => {
      prices[symbol] += (Math.random() - 0.5) * 2;
      prices[symbol] = Math.max(100, prices[symbol]);
    });

    const message = JSON.stringify({
      type: 'price_update',
      prices,
      timestamp: new Date().toISOString()
    });

    clients.forEach((client) => {
      if (client.readyState === 1) client.send(message);
    });
  }, 1000);
}

app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });
  if (!process.env.STRIPE_WEBHOOK_SECRET) return res.status(500).json({ error: 'Missing STRIPE_WEBHOOK_SECRET' });

  const signature = req.headers['stripe-signature'];
  if (!signature) return res.status(400).json({ error: 'Missing stripe signature' });

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).json({ error: `Webhook signature verification failed: ${err.message}` });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.mode === 'subscription' && session.subscription) {
          const subscription = await stripe.subscriptions.retrieve(session.subscription);
          const firstItem = subscription.items?.data?.[0];
          await updateUserFromSubscription({
            stripeCustomerId: subscription.customer,
            stripeSubscriptionId: subscription.id,
            stripePriceId: firstItem?.price?.id || null,
            stripeSubscriptionStatus: subscription.status,
            stripeCurrentPeriodEnd: subscription.current_period_end
              ? new Date(subscription.current_period_end * 1000)
              : null,
            fallbackUserId: session.metadata?.user_id || subscription.metadata?.user_id || null
          });
        }
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const firstItem = subscription.items?.data?.[0];
        await updateUserFromSubscription({
          stripeCustomerId: subscription.customer,
          stripeSubscriptionId: subscription.id,
          stripePriceId: firstItem?.price?.id || null,
          stripeSubscriptionStatus: subscription.status,
          stripeCurrentPeriodEnd: subscription.current_period_end
            ? new Date(subscription.current_period_end * 1000)
            : null,
          fallbackUserId: subscription.metadata?.user_id || null
        });
        break;
      }
      default:
        break;
    }

    return res.json({ received: true });
  } catch (err) {
    return res.status(500).json({ error: 'Webhook handling failed', detail: err.message });
  }
});

app.use(express.json({ limit: '50mb' }));

app.post('/api/auth/signup', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'username, email, password are required' });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const exists = await pool.query('SELECT id FROM users WHERE email = $1 OR username = $2', [email, username]);
    if (exists.rows.length) return res.status(409).json({ error: 'User already exists' });

    const passwordHash = await bcrypt.hash(password, 10);
    const insert = await pool.query(
      `INSERT INTO users (username, email, balance, plan, stripe_subscription_status, password_hash)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, username, email, plan, balance, created_at`,
      [username, email, 10000, 'free', 'inactive', passwordHash]
    );

    const user = insert.rows[0];
    const token = signToken(user);
    return res.status(201).json({ success: true, token, user });
  } catch (err) {
    return res.status(500).json({ error: 'Signup failed', detail: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (!result.rows.length) return res.status(401).json({ error: 'Invalid credentials' });

    const user = result.rows[0];
    if (!user.password_hash) return res.status(401).json({ error: 'Account has no password, sign up a new user' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const safeUser = {
      id: user.id,
      username: user.username,
      email: user.email,
      plan: user.plan,
      balance: user.balance,
      created_at: user.created_at
    };

    const token = signToken(safeUser);
    return res.json({ success: true, token, user: safeUser });
  } catch (err) {
    return res.status(500).json({ error: 'Login failed', detail: err.message });
  }
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const user = await loadCurrentUser(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    return res.json(user);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load profile', detail: err.message });
  }
});

app.post('/api/billing/checkout-session', requireAuth, async (req, res) => {
  try {
    if (!requireStripeConfigured(res)) return;

    const { plan, success_url, cancel_url } = req.body;
    if (!['pro', 'enterprise'].includes(plan)) {
      return res.status(400).json({ error: 'plan must be pro or enterprise' });
    }

    const priceId = PLAN_TO_PRICE_ID[plan];
    if (!priceId) {
      return res.status(500).json({ error: `Missing Stripe price id for plan ${plan}` });
    }

    const user = await loadCurrentUser(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const customerId = await ensureStripeCustomer(user);

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: success_url || `${APP_URL}/?billing=success`,
      cancel_url: cancel_url || `${APP_URL}/?billing=cancel`,
      allow_promotion_codes: true,
      metadata: {
        user_id: String(user.id),
        plan
      },
      subscription_data: {
        metadata: {
          user_id: String(user.id),
          plan
        }
      }
    });

    return res.json({ url: session.url, session_id: session.id });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to create checkout session', detail: err.message });
  }
});

app.post('/api/billing/portal-session', requireAuth, async (req, res) => {
  try {
    if (!requireStripeConfigured(res)) return;

    const user = await loadCurrentUser(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const customerId = await ensureStripeCustomer(user);
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: req.body.return_url || `${APP_URL}/?billing=portal_return`
    });

    return res.json({ url: portalSession.url });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to create portal session', detail: err.message });
  }
});

app.post('/api/billing/subscribe', requireAuth, async (req, res) => {
  try {
    const { plan } = req.body;
    if (plan !== 'free') {
      return res.status(400).json({ error: 'Use /api/billing/checkout-session for paid plans' });
    }

    const result = await pool.query(
      `UPDATE users
       SET plan = 'free',
           stripe_subscription_status = 'inactive'
       WHERE id = $1
       RETURNING id, username, email, plan, balance, created_at`,
      [req.user.id]
    );

    const user = result.rows[0];
    const token = signToken(user);
    return res.json({ success: true, token, user });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update plan', detail: err.message });
  }
});

app.get('/api/billing/status', requireAuth, async (req, res) => {
  try {
    const user = await loadCurrentUser(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    return res.json({
      plan: user.plan,
      stripe_customer_id: user.stripe_customer_id,
      stripe_subscription_id: user.stripe_subscription_id,
      stripe_price_id: user.stripe_price_id,
      stripe_subscription_status: user.stripe_subscription_status,
      stripe_current_period_end: user.stripe_current_period_end
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load billing status', detail: err.message });
  }
});

app.post('/api/strategies', requireAuth, async (req, res) => {
  try {
    const { name, description, code, symbol } = req.body;
    if (!name || !code || !symbol) return res.status(400).json({ error: 'name, code, symbol are required' });

    const user = await loadCurrentUser(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const limits = getPlanLimits(user.plan);
    const countResult = await pool.query('SELECT COUNT(*)::int AS count FROM strategies WHERE user_id = $1', [user.id]);
    const strategyCount = countResult.rows[0].count;
    if (strategyCount >= limits.strategies) {
      return res.status(403).json({
        error: `Plan limit reached. ${user.plan} allows up to ${limits.strategies} strategies`,
        code: 'PLAN_LIMIT_STRATEGIES'
      });
    }

    const result = await pool.query(
      `INSERT INTO strategies (user_id, name, description, code, symbol, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING *`,
      [user.id, name, description || '', code, symbol.toUpperCase()]
    );
    return res.status(201).json({ success: true, strategy: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to save strategy', detail: err.message });
  }
});

app.get('/api/strategies', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM strategies WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user.id]
    );
    return res.json(result.rows);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch strategies', detail: err.message });
  }
});

app.get('/api/users/:user_id/strategies', requireAuth, async (req, res) => {
  if (Number(req.params.user_id) !== Number(req.user.id)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const result = await pool.query(
      'SELECT * FROM strategies WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user.id]
    );
    return res.json(result.rows);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch strategies', detail: err.message });
  }
});

app.get('/api/strategies/:id', requireAuth, async (req, res) => {
  try {
    const strategy = await assertStrategyOwnership(req.params.id, req.user.id);
    if (!strategy) return res.status(404).json({ error: 'Not found' });
    return res.json(strategy);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch strategy', detail: err.message });
  }
});

app.put('/api/strategies/:id', requireAuth, async (req, res) => {
  try {
    const strategy = await assertStrategyOwnership(req.params.id, req.user.id);
    if (!strategy) return res.status(404).json({ error: 'Not found' });

    const { name, description, code, symbol } = req.body;
    const result = await pool.query(
      `UPDATE strategies SET name = $1, description = $2, code = $3, symbol = $4, updated_at = NOW()
       WHERE id = $5 AND user_id = $6
       RETURNING *`,
      [name || strategy.name, description || strategy.description, code || strategy.code, (symbol || strategy.symbol).toUpperCase(), req.params.id, req.user.id]
    );
    return res.json({ success: true, strategy: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update strategy', detail: err.message });
  }
});

app.delete('/api/strategies/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM strategies WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Not found' });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete strategy', detail: err.message });
  }
});

app.post('/api/backtest', requireAuth, async (req, res) => {
  try {
    const { strategy_id, days = 30 } = req.body;
    if (!strategy_id) return res.status(400).json({ error: 'strategy_id is required' });

    const user = await loadCurrentUser(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const limits = getPlanLimits(user.plan);
    const backtestCountResult = await pool.query(
      'SELECT COUNT(*)::int AS count FROM backtest_results WHERE user_id = $1 AND created_at::date = CURRENT_DATE',
      [user.id]
    );
    const backtestsToday = backtestCountResult.rows[0].count;
    if (backtestsToday >= limits.backtestsPerDay) {
      return res.status(403).json({
        error: `Daily backtest limit reached. ${user.plan} allows ${limits.backtestsPerDay} per day`,
        code: 'PLAN_LIMIT_BACKTESTS'
      });
    }

    const strategy = await assertStrategyOwnership(strategy_id, user.id);
    if (!strategy) return res.status(404).json({ error: 'Strategy not found' });

    const engine = new BacktestEngine();
    const result = await engine.runBacktest(strategy.code, strategy.symbol, days);
    if (result.error) return res.status(400).json(result);

    await pool.query(
      `INSERT INTO backtest_results (strategy_id, user_id, result, created_at)
       VALUES ($1, $2, $3, NOW())`,
      [strategy_id, user.id, JSON.stringify(result)]
    );

    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: 'Backtest failed', detail: err.message });
  }
});

app.get('/api/backtests/:strategy_id', requireAuth, async (req, res) => {
  try {
    const strategy = await assertStrategyOwnership(req.params.strategy_id, req.user.id);
    if (!strategy) return res.status(404).json({ error: 'Strategy not found' });

    const result = await pool.query(
      'SELECT * FROM backtest_results WHERE strategy_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 10',
      [req.params.strategy_id, req.user.id]
    );

    const results = result.rows.map((r) => ({
      ...r,
      result: typeof r.result === 'string' ? JSON.parse(r.result) : r.result
    }));
    return res.json(results);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch backtest results', detail: err.message });
  }
});

app.post('/api/orders', requireAuth, async (req, res) => {
  try {
    const { symbol, quantity, price, side } = req.body;
    if (!symbol || !quantity || !price || !side) {
      return res.status(400).json({ error: 'symbol, quantity, price, side are required' });
    }

    const result = await pool.query(
      `INSERT INTO orders (user_id, symbol, quantity, price, side, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW()) RETURNING *`,
      [req.user.id, symbol.toUpperCase(), quantity, price, side, 'PENDING']
    );
    return res.status(201).json({ success: true, order: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ error: 'Order failed', detail: err.message });
  }
});

app.get('/api/orders', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user.id]
    );
    return res.json(result.rows);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch orders', detail: err.message });
  }
});

app.get('/api/users/:user_id/orders', requireAuth, async (req, res) => {
  if (Number(req.params.user_id) !== Number(req.user.id)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const result = await pool.query(
      'SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user.id]
    );
    return res.json(result.rows);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch orders', detail: err.message });
  }
});

app.get('/api/orderbook/:symbol', (_req, res) => {
  const symbol = (_req.params.symbol || 'AAPL').toUpperCase();
  const p = prices[symbol] || 150;
  return res.json({
    symbol,
    bids: [
      { price: Number((p - 0.2).toFixed(2)), quantity: 120 },
      { price: Number((p - 0.4).toFixed(2)), quantity: 200 }
    ],
    asks: [
      { price: Number((p + 0.2).toFixed(2)), quantity: 90 },
      { price: Number((p + 0.4).toFixed(2)), quantity: 160 }
    ]
  });
});

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.send(JSON.stringify({ type: 'price_update', prices, timestamp: new Date().toISOString() }));
});

app.get('/health', (_req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

async function start() {
  try {
    await ensureSchema();
    broadcastPrices();
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
      console.log(`Trading API running on port ${PORT}`);
      if (!stripe) console.log('Stripe not configured yet. Billing checkout/portal/webhook will return configuration errors.');
    });
  } catch (err) {
    console.error('Startup failed:', err);
    process.exit(1);
  }
}

start();
