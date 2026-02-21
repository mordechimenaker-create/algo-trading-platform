const express = require('express');
const { WebSocketServer } = require('ws');
const { createServer } = require('http');
const cors = require('cors');
const helmet = require('helmet');
const { Pool } = require('pg');
const redis = require('redis');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const Stripe = require('stripe');
const BacktestEngine = require('./backtest');
require('dotenv').config();

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

const DEV_JWT_SECRET = 'dev-jwt-secret-change-in-production';
const JWT_SECRET = process.env.JWT_SECRET || DEV_JWT_SECRET;
const ACCESS_TOKEN_EXPIRES_IN = process.env.ACCESS_TOKEN_EXPIRES_IN || '15m';
const REFRESH_TOKEN_EXPIRES_DAYS = Number(process.env.REFRESH_TOKEN_EXPIRES_DAYS || 30);
const REFRESH_TOKEN_EXPIRES_MS = REFRESH_TOKEN_EXPIRES_DAYS * 24 * 60 * 60 * 1000;
const APP_URL = process.env.APP_URL || 'http://localhost:8081';
const GRACE_PERIOD_DAYS = Number(process.env.BILLING_GRACE_DAYS || 3);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60 * 1000);
const RATE_LIMIT_PUBLIC_MAX = Number(process.env.RATE_LIMIT_PUBLIC_MAX || 120);
const RATE_LIMIT_AUTH_MAX = Number(process.env.RATE_LIMIT_AUTH_MAX || 20);
const RATE_LIMIT_PRIVATE_MAX = Number(process.env.RATE_LIMIT_PRIVATE_MAX || 240);
const WEBSOCKET_UPDATE_INTERVAL_MS = Number(process.env.WS_UPDATE_INTERVAL_MS || 1000);

const PLAN_LIMITS = {
  free: { strategies: 3, backtestsPerDay: 5, monthlyUsageUnits: 600 },
  pro: { strategies: 25, backtestsPerDay: 100, monthlyUsageUnits: 20000 },
  enterprise: { strategies: 100000, backtestsPerDay: 100000, monthlyUsageUnits: 2000000 }
};

const PLAN_TO_PRICE_ID = {
  pro: process.env.STRIPE_PRICE_ID_PRO || '',
  enterprise: process.env.STRIPE_PRICE_ID_ENTERPRISE || ''
};

const ACTIVE_SUB_STATUSES = new Set(['active', 'trialing']);
const GRACE_SUB_STATUSES = new Set(['past_due', 'unpaid']);
const VALID_ROLES = new Set(['admin', 'user', 'read-only']);

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
let redisConnected = false;
redisClient.on('ready', () => {
  redisConnected = true;
});
redisClient.on('error', (err) => {
  redisConnected = false;
  console.log('Redis Error', err.message);
});
redisClient.connect().catch((err) => console.log('Redis connect warning:', err.message));

const clients = new Set();
let prices = { AAPL: 150.25, GOOGL: 140.8, MSFT: 380.5, AMZN: 175.3 };
const rateLimitState = new Map();
const metrics = {
  requestsTotal: 0,
  requestsByRoute: new Map(),
  requestsByStatus: new Map(),
  authRefreshSuccessTotal: 0,
  authRefreshFailureTotal: 0,
  backtestsTotal: 0,
  ordersTotal: 0,
  usageDeniedTotal: 0,
  rateLimitedTotal: 0
};

const allowedOrigins = new Set(
  (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);
if (!allowedOrigins.size) {
  allowedOrigins.add(APP_URL);
  allowedOrigins.add('http://localhost:8081');
  allowedOrigins.add('http://127.0.0.1:8081');
}

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) return callback(null, true);
    return callback(new Error('Origin not allowed by CORS'));
  }
}));
app.use(helmet({
  contentSecurityPolicy: false
}));

app.use((req, res, next) => {
  metrics.requestsTotal += 1;
  metricInc(metrics.requestsByRoute, `${req.method} ${req.path}`);
  res.on('finish', () => {
    metricInc(metrics.requestsByStatus, String(res.statusCode));
  });
  next();
});

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

function rateLimit({ windowMs, maxRequests, keyPrefix, skip }) {
  return (req, res, next) => {
    if (skip && skip(req)) return next();

    const key = `${keyPrefix}:${req.ip}`;
    const now = Date.now();
    const current = rateLimitState.get(key);
    if (!current || now >= current.resetAt) {
      rateLimitState.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (current.count >= maxRequests) {
      metrics.rateLimitedTotal += 1;
      const retryAfterSeconds = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({
        error: 'Too many requests',
        code: 'RATE_LIMIT_EXCEEDED',
        retry_after_seconds: retryAfterSeconds
      });
    }

    current.count += 1;
    return next();
  };
}

function normalizeSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase();
}

function isValidSymbol(symbol) {
  return /^[A-Z]{1,10}$/.test(symbol);
}

function parseBacktestDays(value, fallback = 30) {
  const raw = value == null ? fallback : value;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > 365) return null;
  return days;
}

function validateStrategyInput({ name, code, symbol }) {
  if (typeof name !== 'string' || !name.trim()) return 'name is required';
  if (name.trim().length > 120) return 'name too long (max 120 chars)';

  if (typeof code !== 'string' || !code.trim()) return 'code is required';
  if (code.length > 10000) return 'code too long (max 10000 chars)';

  const normalizedSymbol = normalizeSymbol(symbol);
  if (!isValidSymbol(normalizedSymbol)) return 'symbol must be 1-10 uppercase letters';

  const codeValidation = BacktestEngine.validateStrategyCode(code);
  if (!codeValidation.valid) return codeValidation.error;

  return null;
}

function validateOrderInput({ symbol, quantity, price, side }) {
  const normalizedSymbol = normalizeSymbol(symbol);
  const normalizedSide = String(side || '').toUpperCase();
  const normalizedQuantity = Number(quantity);
  const normalizedPrice = Number(price);

  if (!isValidSymbol(normalizedSymbol)) return { error: 'symbol must be 1-10 uppercase letters' };
  if (!['BUY', 'SELL'].includes(normalizedSide)) return { error: 'side must be BUY or SELL' };
  if (!Number.isInteger(normalizedQuantity) || normalizedQuantity <= 0) {
    return { error: 'quantity must be a positive integer' };
  }
  if (!Number.isFinite(normalizedPrice) || normalizedPrice <= 0) {
    return { error: 'price must be a positive number' };
  }

  return {
    symbol: normalizedSymbol,
    side: normalizedSide,
    quantity: normalizedQuantity,
    price: normalizedPrice
  };
}

function metricInc(map, key, value = 1) {
  map.set(key, (map.get(key) || 0) + value);
}

function hashRefreshToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function signAccessToken(user) {
  const normalizedRole = VALID_ROLES.has(user.role) ? user.role : 'user';
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      username: user.username,
      plan: user.plan || 'free',
      role: normalizedRole,
      token_type: 'access'
    },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_EXPIRES_IN }
  );
}

function signRefreshToken(user, tokenVersion = 0) {
  const jti = crypto.randomUUID();
  const token = jwt.sign(
    {
      id: user.id,
      token_type: 'refresh',
      jti,
      token_version: tokenVersion
    },
    JWT_SECRET,
    { expiresIn: `${REFRESH_TOKEN_EXPIRES_DAYS}d` }
  );

  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRES_MS);
  return { token, jti, expiresAt };
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
    if (req.user.token_type && req.user.token_type !== 'access') {
      return res.status(401).json({ error: 'Invalid token type' });
    }
    return next();
  } catch (_err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function requireRole(...roles) {
  const roleSet = new Set(roles);
  return (req, res, next) => {
    const role = req.user?.role || 'user';
    if (!roleSet.has(role)) {
      return res.status(403).json({ error: 'Forbidden', required_roles: [...roleSet], current_role: role });
    }
    return next();
  };
}

function requireWriteAccess(req, res, next) {
  if ((req.user?.role || 'user') === 'read-only') {
    return res.status(403).json({ error: 'Forbidden for read-only role' });
  }
  return next();
}

async function recordAuditEvent({
  userId,
  action,
  resourceType,
  resourceId = null,
  status = 'success',
  detail = null,
  req = null
}) {
  try {
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, resource_type, resource_id, status, detail, ip_address, user_agent, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
      [
        userId || null,
        String(action || 'unknown'),
        String(resourceType || 'system'),
        resourceId == null ? null : String(resourceId),
        String(status || 'success'),
        detail ? JSON.stringify(detail) : null,
        req?.ip || null,
        req?.headers?.['user-agent'] || null
      ]
    );
  } catch (err) {
    console.warn('audit log warning:', err.message);
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
    `SELECT id, username, email, role, plan, balance, created_at,
            stripe_customer_id, stripe_subscription_id, stripe_subscription_status,
            stripe_price_id, stripe_current_period_end, stripe_grace_until,
            token_version
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
  const graceUntil = getGraceUntilFromSubscription(stripeSubscriptionStatus, stripeCurrentPeriodEnd);

  await pool.query(
    `UPDATE users
     SET plan = $1,
         stripe_subscription_id = $2,
         stripe_price_id = $3,
         stripe_subscription_status = $4,
         stripe_current_period_end = $5,
         stripe_grace_until = $6
     WHERE id = $7`,
    [
      mappedPlan,
      stripeSubscriptionId || null,
      stripePriceId || null,
      stripeSubscriptionStatus || 'inactive',
      stripeCurrentPeriodEnd || null,
      graceUntil,
      userId
    ]
  );
}

async function storeRefreshToken(userId, rawToken, jti, expiresAt) {
  const tokenHash = hashRefreshToken(rawToken);
  await pool.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, jti, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [userId, tokenHash, jti, expiresAt]
  );
}

async function issueAuthTokens(user, tokenVersion = 0) {
  const accessToken = signAccessToken(user);
  const refresh = signRefreshToken(user, tokenVersion);
  await storeRefreshToken(user.id, refresh.token, refresh.jti, refresh.expiresAt);
  return {
    token: accessToken,
    refresh_token: refresh.token,
    refresh_expires_at: refresh.expiresAt.toISOString()
  };
}

function getGraceUntilFromSubscription(status, periodEnd) {
  if (GRACE_SUB_STATUSES.has(status)) {
    return new Date(Date.now() + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000);
  }
  if (status === 'canceled' && periodEnd) {
    return new Date(periodEnd);
  }
  return null;
}

function isWithinGracePeriod(user) {
  if (!user?.stripe_grace_until) return false;
  return new Date(user.stripe_grace_until).getTime() > Date.now();
}

function getEffectivePlan(user) {
  if (!user) return 'free';
  if (ACTIVE_SUB_STATUSES.has(user.stripe_subscription_status)) return user.plan || 'free';
  if (isWithinGracePeriod(user)) {
    if (user.plan === 'enterprise') return 'pro';
    return 'free';
  }
  return user.plan || 'free';
}

async function getMonthlyUsageUnits(userId) {
  const result = await pool.query(
    `SELECT COALESCE(SUM(units), 0)::int AS total
     FROM usage_events
     WHERE user_id = $1
       AND DATE_TRUNC('month', created_at) = DATE_TRUNC('month', NOW())`,
    [userId]
  );
  return result.rows[0]?.total || 0;
}

async function recordUsageEvent(userId, eventType, units) {
  const safeUnits = Number.isInteger(units) && units > 0 ? units : 0;
  if (!safeUnits) return;
  await pool.query(
    `INSERT INTO usage_events (user_id, event_type, units, created_at)
     VALUES ($1, $2, $3, NOW())`,
    [userId, eventType, safeUnits]
  );
}

async function enforceUsageLimit(user, extraUnits) {
  const plan = getEffectivePlan(user);
  const limits = getPlanLimits(plan);
  const monthlyUsageUnits = limits.monthlyUsageUnits || 0;
  if (monthlyUsageUnits <= 0) return { allowed: true, usage: 0, limit: 0, plan };

  const currentUsage = await getMonthlyUsageUnits(user.id);
  const projected = currentUsage + extraUnits;
  const usageHardStop = Number(process.env.STRICT_USAGE_CAP || 1) === 1;
  if (usageHardStop && projected > monthlyUsageUnits) {
    metrics.usageDeniedTotal += 1;
    return {
      allowed: false,
      usage: currentUsage,
      limit: monthlyUsageUnits,
      plan,
      grace: isWithinGracePeriod(user)
    };
  }

  return {
    allowed: true,
    usage: currentUsage,
    limit: monthlyUsageUnits,
    plan,
    grace: isWithinGracePeriod(user)
  };
}

function mapToPrometheusSamples(metricName, map, labelsBuilder) {
  const lines = [];
  map.forEach((value, key) => {
    const labels = labelsBuilder(key);
    lines.push(`${metricName}{${labels}} ${value}`);
  });
  return lines;
}

function buildMetricsPayload() {
  const lines = [
    '# HELP algo_requests_total Total HTTP requests',
    '# TYPE algo_requests_total counter',
    `algo_requests_total ${metrics.requestsTotal}`,
    '# HELP algo_rate_limited_total Requests rejected by rate limiting',
    '# TYPE algo_rate_limited_total counter',
    `algo_rate_limited_total ${metrics.rateLimitedTotal}`,
    '# HELP algo_auth_refresh_success_total Successful token refreshes',
    '# TYPE algo_auth_refresh_success_total counter',
    `algo_auth_refresh_success_total ${metrics.authRefreshSuccessTotal}`,
    '# HELP algo_auth_refresh_failure_total Failed token refreshes',
    '# TYPE algo_auth_refresh_failure_total counter',
    `algo_auth_refresh_failure_total ${metrics.authRefreshFailureTotal}`,
    '# HELP algo_backtests_total Total backtests run',
    '# TYPE algo_backtests_total counter',
    `algo_backtests_total ${metrics.backtestsTotal}`,
    '# HELP algo_orders_total Total simulated orders created',
    '# TYPE algo_orders_total counter',
    `algo_orders_total ${metrics.ordersTotal}`,
    '# HELP algo_usage_denied_total Usage-cap denials',
    '# TYPE algo_usage_denied_total counter',
    `algo_usage_denied_total ${metrics.usageDeniedTotal}`
  ];

  lines.push('# HELP algo_requests_by_route_total Requests split by method/path');
  lines.push('# TYPE algo_requests_by_route_total counter');
  lines.push(
    ...mapToPrometheusSamples(
      'algo_requests_by_route_total',
      metrics.requestsByRoute,
      (key) => {
        const method = key.split(' ')[0] || 'UNKNOWN';
        const path = key.slice(method.length + 1) || '/';
        return `method="${method}",path="${path}"`;
      }
    )
  );

  lines.push('# HELP algo_requests_by_status_total Requests split by status code');
  lines.push('# TYPE algo_requests_by_status_total counter');
  lines.push(
    ...mapToPrometheusSamples(
      'algo_requests_by_status_total',
      metrics.requestsByStatus,
      (status) => `status="${status}"`
    )
  );

  return `${lines.join('\n')}\n`;
}

function buildOpenApiSpec() {
  return {
    openapi: '3.0.3',
    info: {
      title: 'Algo Trading Platform API',
      version: '1.3.0',
      description: 'Authentication, billing, strategies, backtesting and orders API'
    },
    servers: [{ url: APP_URL.replace(':8081', ':3001') }, { url: 'http://localhost:3001' }],
    components: {
      securitySchemes: {
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT'
        }
      }
    },
    paths: {
      '/health': { get: { summary: 'Health check', responses: { 200: { description: 'OK' } } } },
      '/live': { get: { summary: 'Liveness probe', responses: { 200: { description: 'UP' } } } },
      '/ready': { get: { summary: 'Readiness probe', responses: { 200: { description: 'READY' }, 503: { description: 'NOT_READY' } } } },
      '/metrics': { get: { summary: 'Prometheus metrics', responses: { 200: { description: 'Metrics text/plain' } } } },
      '/api/auth/signup': { post: { summary: 'Create account', responses: { 201: { description: 'Created' } } } },
      '/api/auth/login': { post: { summary: 'Login', responses: { 200: { description: 'Logged in' } } } },
      '/api/auth/refresh': { post: { summary: 'Rotate access+refresh token pair', responses: { 200: { description: 'Rotated' } } } },
      '/api/auth/me': {
        get: {
          summary: 'Current user profile',
          security: [{ BearerAuth: [] }],
          responses: { 200: { description: 'Current user profile' } }
        }
      },
      '/api/billing/status': {
        get: {
          summary: 'Billing and usage status',
          security: [{ BearerAuth: [] }],
          responses: { 200: { description: 'Billing status' } }
        }
      },
      '/api/activity/me': {
        get: {
          summary: 'Current user audit activity',
          security: [{ BearerAuth: [] }],
          responses: { 200: { description: 'Activity entries' } }
        }
      },
      '/api/admin/audit-logs': {
        get: {
          summary: 'Admin audit logs',
          security: [{ BearerAuth: [] }],
          responses: { 200: { description: 'Audit entries' }, 403: { description: 'Forbidden' } }
        }
      },
      '/api/strategies': {
        get: { summary: 'List strategies', security: [{ BearerAuth: [] }], responses: { 200: { description: 'List' } } },
        post: { summary: 'Create strategy', security: [{ BearerAuth: [] }], responses: { 201: { description: 'Created' } } }
      },
      '/api/backtest': {
        post: {
          summary: 'Run backtest with optional fee/slippage/latency',
          security: [{ BearerAuth: [] }],
          responses: { 200: { description: 'Backtest result' } }
        }
      },
      '/api/orders': {
        get: { summary: 'List orders', security: [{ BearerAuth: [] }], responses: { 200: { description: 'List' } } },
        post: { summary: 'Create order', security: [{ BearerAuth: [] }], responses: { 201: { description: 'Created' } } }
      }
    }
  };
}

async function ensureSchema() {
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT');
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(32) NOT NULL DEFAULT 'user'");
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS plan VARCHAR(32) NOT NULL DEFAULT 'free'");
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(255)');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_id VARCHAR(255)');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_price_id VARCHAR(255)');
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_status VARCHAR(32) NOT NULL DEFAULT 'inactive'");
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_current_period_end TIMESTAMP');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_grace_until TIMESTAMP');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INT NOT NULL DEFAULT 0');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash VARCHAR(128) UNIQUE NOT NULL,
      jti VARCHAR(128) UNIQUE NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      revoked_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expiry ON refresh_tokens(expires_at)');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS usage_events (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      event_type VARCHAR(32) NOT NULL,
      units INT NOT NULL CHECK (units >= 0),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_usage_events_user_created ON usage_events(user_id, created_at)');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id SERIAL PRIMARY KEY,
      user_id INT REFERENCES users(id) ON DELETE SET NULL,
      action VARCHAR(64) NOT NULL,
      resource_type VARCHAR(64) NOT NULL,
      resource_id VARCHAR(128),
      status VARCHAR(16) NOT NULL DEFAULT 'success',
      detail JSONB,
      ip_address VARCHAR(64),
      user_agent TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_audit_logs_user_created ON audit_logs(user_id, created_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_audit_logs_action_created ON audit_logs(action, created_at DESC)');
  await pool.query('DELETE FROM refresh_tokens WHERE expires_at < NOW() OR revoked_at IS NOT NULL');

  const demoUser = await pool.query('SELECT id FROM users WHERE email = $1', ['demo@algo.local']);
  if (demoUser.rows.length === 0) {
    const hash = await bcrypt.hash('demo12345', 10);
    await pool.query(
      `INSERT INTO users (username, email, role, balance, plan, stripe_subscription_status, password_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      ['demo', 'demo@algo.local', 'user', 25000, 'free', 'inactive', hash]
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
  }, WEBSOCKET_UPDATE_INTERVAL_MS);
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
app.use('/api/auth', rateLimit({ windowMs: RATE_LIMIT_WINDOW_MS, maxRequests: RATE_LIMIT_AUTH_MAX, keyPrefix: 'auth' }));
app.use('/api', rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  maxRequests: RATE_LIMIT_PRIVATE_MAX,
  keyPrefix: 'api',
  skip: (req) => req.path.startsWith('/auth')
}));
app.use(rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  maxRequests: RATE_LIMIT_PUBLIC_MAX,
  keyPrefix: 'public',
  skip: (req) => req.path.startsWith('/api')
}));

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
      `INSERT INTO users (username, email, role, balance, plan, stripe_subscription_status, password_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, username, email, role, plan, balance, created_at`,
      [username, email, 'user', 10000, 'free', 'inactive', passwordHash]
    );

    const user = insert.rows[0];
    const tokens = await issueAuthTokens(user, 0);
    await recordAuditEvent({
      userId: user.id,
      action: 'auth.signup',
      resourceType: 'user',
      resourceId: user.id,
      req
    });
    return res.status(201).json({ success: true, ...tokens, user });
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
      role: user.role || 'user',
      plan: user.plan,
      balance: user.balance,
      created_at: user.created_at
    };

    const tokens = await issueAuthTokens(safeUser, user.token_version || 0);
    await recordAuditEvent({
      userId: user.id,
      action: 'auth.login',
      resourceType: 'user',
      resourceId: user.id,
      req
    });
    return res.json({ success: true, ...tokens, user: safeUser });
  } catch (err) {
    return res.status(500).json({ error: 'Login failed', detail: err.message });
  }
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const user = await loadCurrentUser(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const plan = getEffectivePlan(user);
    const usageThisMonth = await getMonthlyUsageUnits(user.id);
    return res.json({
      ...user,
      plan,
      usage_this_month: usageThisMonth,
      usage_limit_monthly: getPlanLimits(plan).monthlyUsageUnits
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load profile', detail: err.message });
  }
});

app.post('/api/auth/refresh', async (req, res) => {
  try {
    const { refresh_token } = req.body || {};
    if (!refresh_token) return res.status(400).json({ error: 'refresh_token is required' });

    let payload;
    try {
      payload = jwt.verify(refresh_token, JWT_SECRET);
    } catch (_err) {
      metrics.authRefreshFailureTotal += 1;
      return res.status(401).json({ error: 'Invalid refresh token' });
    }

    if (payload.token_type !== 'refresh') {
      metrics.authRefreshFailureTotal += 1;
      return res.status(401).json({ error: 'Invalid token type' });
    }

    const tokenHash = hashRefreshToken(refresh_token);
    const stored = await pool.query(
      `SELECT id, user_id, expires_at, revoked_at
       FROM refresh_tokens
       WHERE token_hash = $1 AND jti = $2`,
      [tokenHash, payload.jti]
    );
    if (!stored.rows.length) {
      metrics.authRefreshFailureTotal += 1;
      return res.status(401).json({ error: 'Refresh token not found' });
    }

    const tokenRow = stored.rows[0];
    if (tokenRow.revoked_at || new Date(tokenRow.expires_at).getTime() <= Date.now()) {
      metrics.authRefreshFailureTotal += 1;
      return res.status(401).json({ error: 'Refresh token expired or revoked' });
    }

    const user = await loadCurrentUser(tokenRow.user_id);
    if (!user || Number(user.token_version || 0) !== Number(payload.token_version || 0)) {
      metrics.authRefreshFailureTotal += 1;
      return res.status(401).json({ error: 'Session no longer valid' });
    }

    await pool.query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = $1', [tokenRow.id]);

    const safeUser = {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role || 'user',
      plan: getEffectivePlan(user),
      balance: user.balance,
      created_at: user.created_at
    };
    const nextTokens = await issueAuthTokens(safeUser, user.token_version || 0);
    await recordAuditEvent({
      userId: user.id,
      action: 'auth.refresh',
      resourceType: 'user',
      resourceId: user.id,
      req
    });
    metrics.authRefreshSuccessTotal += 1;
    return res.json({ success: true, ...nextTokens, user: safeUser });
  } catch (err) {
    metrics.authRefreshFailureTotal += 1;
    return res.status(500).json({ error: 'Failed to refresh token', detail: err.message });
  }
});

app.post('/api/auth/logout', requireAuth, async (req, res) => {
  try {
    const { refresh_token } = req.body || {};
    if (refresh_token) {
      await pool.query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1', [hashRefreshToken(refresh_token)]);
    } else {
      await pool.query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL', [req.user.id]);
    }
    await recordAuditEvent({
      userId: req.user.id,
      action: 'auth.logout',
      resourceType: 'user',
      resourceId: req.user.id,
      req
    });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'Logout failed', detail: err.message });
  }
});

app.post('/api/billing/checkout-session', requireAuth, requireWriteAccess, async (req, res) => {
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

    await recordAuditEvent({
      userId: req.user.id,
      action: 'billing.checkout_session.create',
      resourceType: 'billing',
      resourceId: session.id,
      detail: { plan },
      req
    });
    return res.json({ url: session.url, session_id: session.id });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to create checkout session', detail: err.message });
  }
});

app.post('/api/billing/portal-session', requireAuth, requireWriteAccess, async (req, res) => {
  try {
    if (!requireStripeConfigured(res)) return;

    const user = await loadCurrentUser(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const customerId = await ensureStripeCustomer(user);
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: req.body.return_url || `${APP_URL}/?billing=portal_return`
    });

    await recordAuditEvent({
      userId: req.user.id,
      action: 'billing.portal_session.create',
      resourceType: 'billing',
      resourceId: customerId,
      req
    });
    return res.json({ url: portalSession.url });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to create portal session', detail: err.message });
  }
});

app.post('/api/billing/subscribe', requireAuth, requireWriteAccess, async (req, res) => {
  try {
    const { plan } = req.body;
    if (plan !== 'free') {
      return res.status(400).json({ error: 'Use /api/billing/checkout-session for paid plans' });
    }

    const result = await pool.query(
      `UPDATE users
       SET plan = 'free',
           stripe_subscription_status = 'inactive',
           stripe_grace_until = NULL
       WHERE id = $1
       RETURNING id, username, email, role, plan, balance, created_at, token_version`,
      [req.user.id]
    );

    const user = result.rows[0];
    const tokens = await issueAuthTokens(user, user.token_version || 0);
    await recordAuditEvent({
      userId: req.user.id,
      action: 'billing.plan.change',
      resourceType: 'user',
      resourceId: req.user.id,
      detail: { plan: 'free' },
      req
    });
    return res.json({ success: true, ...tokens, user });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update plan', detail: err.message });
  }
});

app.get('/api/billing/status', requireAuth, async (req, res) => {
  try {
    const user = await loadCurrentUser(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const effectivePlan = getEffectivePlan(user);
    const usage = await getMonthlyUsageUnits(user.id);
    const limits = getPlanLimits(effectivePlan);
    return res.json({
      plan: effectivePlan,
      stripe_customer_id: user.stripe_customer_id,
      stripe_subscription_id: user.stripe_subscription_id,
      stripe_price_id: user.stripe_price_id,
      stripe_subscription_status: user.stripe_subscription_status,
      stripe_current_period_end: user.stripe_current_period_end,
      stripe_grace_until: user.stripe_grace_until,
      usage_this_month: usage,
      usage_limit_monthly: limits.monthlyUsageUnits
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load billing status', detail: err.message });
  }
});

app.get('/api/usage/me', requireAuth, async (req, res) => {
  try {
    const user = await loadCurrentUser(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const plan = getEffectivePlan(user);
    const limits = getPlanLimits(plan);
    const usage = await getMonthlyUsageUnits(user.id);
    return res.json({
      plan,
      usage_this_month: usage,
      usage_limit_monthly: limits.monthlyUsageUnits,
      remaining: Math.max(0, limits.monthlyUsageUnits - usage),
      grace: isWithinGracePeriod(user)
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load usage', detail: err.message });
  }
});

app.get('/api/activity/me', requireAuth, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));
    const result = await pool.query(
      `SELECT id, action, resource_type, resource_id, status, detail, ip_address, user_agent, created_at
       FROM audit_logs
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [req.user.id, limit]
    );
    return res.json(result.rows);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load activity', detail: err.message });
  }
});

app.get('/api/admin/audit-logs', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit || 100)));
    const userId = req.query.user_id ? Number(req.query.user_id) : null;
    if (userId && !Number.isInteger(userId)) {
      return res.status(400).json({ error: 'user_id must be an integer' });
    }
    const result = userId
      ? await pool.query(
        `SELECT id, user_id, action, resource_type, resource_id, status, detail, ip_address, user_agent, created_at
         FROM audit_logs
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [userId, limit]
      )
      : await pool.query(
        `SELECT id, user_id, action, resource_type, resource_id, status, detail, ip_address, user_agent, created_at
         FROM audit_logs
         ORDER BY created_at DESC
         LIMIT $1`,
        [limit]
      );
    return res.json(result.rows);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load audit logs', detail: err.message });
  }
});

app.post('/api/strategies', requireAuth, requireWriteAccess, async (req, res) => {
  try {
    const { name, description, code, symbol } = req.body;
    const validationError = validateStrategyInput({ name, code, symbol });
    if (validationError) return res.status(400).json({ error: validationError });
    const normalizedSymbol = normalizeSymbol(symbol);

    const user = await loadCurrentUser(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const effectivePlan = getEffectivePlan(user);
    const limits = getPlanLimits(effectivePlan);
    const countResult = await pool.query('SELECT COUNT(*)::int AS count FROM strategies WHERE user_id = $1', [user.id]);
    const strategyCount = countResult.rows[0].count;
    if (strategyCount >= limits.strategies) {
      return res.status(403).json({
        error: `Plan limit reached. ${effectivePlan} allows up to ${limits.strategies} strategies`,
        code: 'PLAN_LIMIT_STRATEGIES'
      });
    }

    const result = await pool.query(
      `INSERT INTO strategies (user_id, name, description, code, symbol, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING *`,
      [user.id, name.trim(), String(description || '').trim(), code, normalizedSymbol]
    );
    await recordAuditEvent({
      userId: user.id,
      action: 'strategy.create',
      resourceType: 'strategy',
      resourceId: result.rows[0].id,
      detail: { symbol: normalizedSymbol },
      req
    });
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

app.put('/api/strategies/:id', requireAuth, requireWriteAccess, async (req, res) => {
  try {
    const strategy = await assertStrategyOwnership(req.params.id, req.user.id);
    if (!strategy) return res.status(404).json({ error: 'Not found' });

    const { name, description, code, symbol } = req.body;
    const nextName = name == null ? strategy.name : name;
    const nextCode = code == null ? strategy.code : code;
    const nextSymbol = symbol == null ? strategy.symbol : symbol;
    const validationError = validateStrategyInput({ name: nextName, code: nextCode, symbol: nextSymbol });
    if (validationError) return res.status(400).json({ error: validationError });

    const result = await pool.query(
      `UPDATE strategies SET name = $1, description = $2, code = $3, symbol = $4, updated_at = NOW()
       WHERE id = $5 AND user_id = $6
       RETURNING *`,
      [
        String(nextName).trim(),
        description == null ? strategy.description : String(description).trim(),
        nextCode,
        normalizeSymbol(nextSymbol),
        req.params.id,
        req.user.id
      ]
    );
    await recordAuditEvent({
      userId: req.user.id,
      action: 'strategy.update',
      resourceType: 'strategy',
      resourceId: req.params.id,
      detail: { symbol: normalizeSymbol(nextSymbol) },
      req
    });
    return res.json({ success: true, strategy: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update strategy', detail: err.message });
  }
});

app.delete('/api/strategies/:id', requireAuth, requireWriteAccess, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM strategies WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Not found' });
    await recordAuditEvent({
      userId: req.user.id,
      action: 'strategy.delete',
      resourceType: 'strategy',
      resourceId: req.params.id,
      req
    });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete strategy', detail: err.message });
  }
});

app.post('/api/backtest', requireAuth, requireWriteAccess, async (req, res) => {
  try {
    const { strategy_id, days = 30 } = req.body;
    if (!strategy_id) return res.status(400).json({ error: 'strategy_id is required' });
    const normalizedDays = parseBacktestDays(days);
    if (normalizedDays == null) {
      return res.status(400).json({ error: 'days must be an integer between 1 and 365' });
    }

    const user = await loadCurrentUser(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const effectivePlan = getEffectivePlan(user);
    const limits = getPlanLimits(effectivePlan);
    const backtestCountResult = await pool.query(
      'SELECT COUNT(*)::int AS count FROM backtest_results WHERE user_id = $1 AND created_at::date = CURRENT_DATE',
      [user.id]
    );
    const backtestsToday = backtestCountResult.rows[0].count;
    if (backtestsToday >= limits.backtestsPerDay) {
      return res.status(403).json({
        error: `Daily backtest limit reached. ${effectivePlan} allows ${limits.backtestsPerDay} per day`,
        code: 'PLAN_LIMIT_BACKTESTS'
      });
    }

    const usageGate = await enforceUsageLimit(user, normalizedDays);
    if (!usageGate.allowed) {
      return res.status(403).json({
        error: `Monthly usage limit reached (${usageGate.limit} units for ${usageGate.plan})`,
        code: 'PLAN_LIMIT_USAGE',
        usage: usageGate.usage,
        limit: usageGate.limit,
        grace: usageGate.grace
      });
    }

    const strategy = await assertStrategyOwnership(strategy_id, user.id);
    if (!strategy) return res.status(404).json({ error: 'Strategy not found' });

    const engine = new BacktestEngine();
    const feeBps = Number(req.body?.fee_bps ?? process.env.BACKTEST_FEE_BPS ?? 0);
    const feeFixed = Number(req.body?.fee_fixed ?? process.env.BACKTEST_FEE_FIXED ?? 0);
    const slippageBps = Number(req.body?.slippage_bps ?? process.env.BACKTEST_SLIPPAGE_BPS ?? 0);
    const latencyMs = Number(req.body?.latency_ms ?? process.env.BACKTEST_LATENCY_MS ?? 0);
    const result = await engine.runBacktest(strategy.code, strategy.symbol, normalizedDays, {
      feeModel: { bps: feeBps, fixedPerTrade: feeFixed },
      slippageBps,
      latencyMs
    });
    if (result.error) return res.status(400).json(result);

    await pool.query(
      `INSERT INTO backtest_results (strategy_id, user_id, result, created_at)
       VALUES ($1, $2, $3, NOW())`,
      [strategy_id, user.id, JSON.stringify(result)]
    );
    await recordUsageEvent(user.id, 'backtest', normalizedDays);
    await recordAuditEvent({
      userId: user.id,
      action: 'backtest.run',
      resourceType: 'strategy',
      resourceId: strategy_id,
      detail: { days: normalizedDays, symbol: strategy.symbol },
      req
    });
    metrics.backtestsTotal += 1;

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

app.post('/api/orders', requireAuth, requireWriteAccess, async (req, res) => {
  try {
    const { symbol, quantity, price, side } = req.body;
    const orderValidation = validateOrderInput({ symbol, quantity, price, side });
    if (orderValidation.error) return res.status(400).json({ error: orderValidation.error });

    const user = await loadCurrentUser(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const usageGate = await enforceUsageLimit(user, 1);
    if (!usageGate.allowed) {
      return res.status(403).json({
        error: `Monthly usage limit reached (${usageGate.limit} units for ${usageGate.plan})`,
        code: 'PLAN_LIMIT_USAGE',
        usage: usageGate.usage,
        limit: usageGate.limit,
        grace: usageGate.grace
      });
    }

    const result = await pool.query(
      `INSERT INTO orders (user_id, symbol, quantity, price, side, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW()) RETURNING *`,
      [req.user.id, orderValidation.symbol, orderValidation.quantity, orderValidation.price, orderValidation.side, 'PENDING']
    );
    await recordUsageEvent(req.user.id, 'order', 1);
    await recordAuditEvent({
      userId: req.user.id,
      action: 'order.create',
      resourceType: 'order',
      resourceId: result.rows[0].id,
      detail: { symbol: orderValidation.symbol, side: orderValidation.side, quantity: orderValidation.quantity },
      req
    });
    metrics.ordersTotal += 1;
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

app.get('/openapi.json', (_req, res) => {
  res.json(buildOpenApiSpec());
});

app.get('/docs', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Algo API Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    window.ui = SwaggerUIBundle({
      url: '/openapi.json',
      dom_id: '#swagger-ui',
      deepLinking: true,
      presets: [SwaggerUIBundle.presets.apis]
    });
  </script>
</body>
</html>`);
});

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.send(JSON.stringify({ type: 'price_update', prices, timestamp: new Date().toISOString() }));
});

app.get('/metrics', (_req, res) => {
  res.type('text/plain').send(buildMetricsPayload());
});

app.get('/health', (_req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.get('/live', (_req, res) => {
  res.json({ status: 'UP', timestamp: new Date().toISOString() });
});

app.get('/ready', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    const redisOk = redisConnected ? true : (await redisClient.ping()) === 'PONG';
    if (!redisOk) {
      return res.status(503).json({ status: 'NOT_READY', db: 'up', redis: 'down' });
    }
    return res.json({ status: 'READY', db: 'up', redis: 'up', timestamp: new Date().toISOString() });
  } catch (err) {
    return res.status(503).json({ status: 'NOT_READY', error: err.message });
  }
});

async function start() {
  try {
    if (process.env.NODE_ENV === 'production') {
      if (JWT_SECRET === DEV_JWT_SECRET || JWT_SECRET.length < 32) {
        throw new Error('Set a strong JWT_SECRET (at least 32 characters) in production');
      }
    }

    await ensureSchema();
    broadcastPrices();
    setInterval(() => {
      const now = Date.now();
      rateLimitState.forEach((entry, key) => {
        if (entry.resetAt <= now) rateLimitState.delete(key);
      });
    }, RATE_LIMIT_WINDOW_MS);
    setInterval(async () => {
      try {
        await pool.query('DELETE FROM refresh_tokens WHERE expires_at < NOW() OR revoked_at IS NOT NULL');
      } catch (err) {
        console.warn('refresh token cleanup warning:', err.message);
      }
    }, 60 * 60 * 1000);
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
