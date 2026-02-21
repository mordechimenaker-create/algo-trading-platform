const test = require('node:test');
const assert = require('node:assert/strict');
const BacktestEngine = require('../../backtest');

test('validates blocked strategy code', () => {
  const result = BacktestEngine.validateStrategyCode('const x = process.env.SECRET;');
  assert.equal(result.valid, false);
});

test('runs a simple backtest with deterministic data', async () => {
  const engine = new BacktestEngine();
  const candles = [
    { symbol: 'AAPL', timestamp: '2025-01-01T00:00:00.000Z', open: 100, high: 101, low: 99, close: 100, volume: 1000 },
    { symbol: 'AAPL', timestamp: '2025-01-01T01:00:00.000Z', open: 101, high: 102, low: 100, close: 101, volume: 1000 },
    { symbol: 'AAPL', timestamp: '2025-01-01T02:00:00.000Z', open: 102, high: 103, low: 101, close: 102, volume: 1000 }
  ];

  const result = await engine.runBacktest(
    'if (data.close <= 100) executeOrder("BUY", 1, data.close); if (data.close >= 102) executeOrder("SELL", 1, data.close);',
    'AAPL',
    3,
    { historicalData: candles }
  );

  assert.equal(result.success, true);
  assert.ok(result.totalTrades >= 2);
  assert.ok(Array.isArray(result.equity));
});

test('applies fee and slippage options', async () => {
  const engine = new BacktestEngine();
  const candles = [
    { symbol: 'AAPL', timestamp: '2025-01-01T00:00:00.000Z', open: 100, high: 100, low: 100, close: 100, volume: 1000 },
    { symbol: 'AAPL', timestamp: '2025-01-01T01:00:00.000Z', open: 100, high: 100, low: 100, close: 100, volume: 1000 }
  ];

  const result = await engine.runBacktest(
    'executeOrder("BUY", 1, data.close); executeOrder("SELL", 1, data.close);',
    'AAPL',
    2,
    {
      historicalData: candles,
      slippageBps: 10,
      latencyMs: 5,
      feeModel: { fixedPerTrade: 1, bps: 5 }
    }
  );

  assert.equal(result.success, true);
  assert.equal(result.slippageBps, 10);
  assert.equal(result.latencyMs, 5);
  assert.ok(result.totalFeesPaid > 0);
});
