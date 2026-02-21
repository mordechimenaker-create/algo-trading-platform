const vm = require('vm');

const MAX_STRATEGY_LENGTH = 10000;
const MAX_BACKTEST_DAYS = 365;
const STRATEGY_TIMEOUT_MS = 25;
const BLOCKED_STRATEGY_PATTERNS = [
  /\bprocess\b/i,
  /\brequire\b/i,
  /\bglobalThis\b/i,
  /\bglobal\b/i,
  /\bmodule\b/i,
  /\bexports\b/i,
  /\bchild_process\b/i,
  /\bFunction\b/i,
  /\beval\b/i
];

class BacktestEngine {
  constructor() {
    this.trades = [];
    this.equity = [];
    this.portfolio = {};
    this.cash = 100000;
  }

  generateHistoricalData(symbol, days = 30) {
    const data = [];
    let price = 150;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    for (let i = 0; i < days * 24; i++) {
      const timestamp = new Date(startDate.getTime() + i * 60 * 60 * 1000);
      const change = (Math.random() - 0.5) * 4;
      price = Math.max(100, price + change);

      data.push({
        symbol,
        timestamp: timestamp.toISOString(),
        open: price,
        high: price + Math.random() * 2,
        low: Math.max(100, price - Math.random() * 2),
        close: price + (Math.random() - 0.5),
        volume: Math.floor(Math.random() * 100000 + 50000)
      });
    }
    return data;
  }

  static validateStrategyCode(strategyCode) {
    if (typeof strategyCode !== 'string') {
      return { valid: false, error: 'Strategy code must be a string' };
    }

    if (!strategyCode.trim()) {
      return { valid: false, error: 'Strategy code cannot be empty' };
    }

    if (strategyCode.length > MAX_STRATEGY_LENGTH) {
      return { valid: false, error: `Strategy code too long (max ${MAX_STRATEGY_LENGTH} chars)` };
    }

    const blocked = BLOCKED_STRATEGY_PATTERNS.find((pattern) => pattern.test(strategyCode));
    if (blocked) {
      return { valid: false, error: 'Strategy contains blocked keywords for safety' };
    }

    try {
      new vm.Script(strategyCode);
    } catch (err) {
      return { valid: false, error: `Syntax error: ${err.message}` };
    }

    return { valid: true };
  }

  async runBacktest(strategyCode, symbol = 'AAPL', days = 30) {
    if (!Number.isInteger(days) || days < 1 || days > MAX_BACKTEST_DAYS) {
      return { error: `days must be an integer between 1 and ${MAX_BACKTEST_DAYS}` };
    }

    const strategyValidation = BacktestEngine.validateStrategyCode(strategyCode);
    if (!strategyValidation.valid) {
      return { error: strategyValidation.error };
    }

    const historicalData = this.generateHistoricalData(symbol, days);
    const strategyScript = new vm.Script(strategyCode);

    this.trades = [];
    this.equity = [];
    this.portfolio = {};
    this.cash = 100000;

    const executeOrder = (side, quantity, price) => {
      const normalizedSide = String(side || '').toUpperCase();
      if (!['BUY', 'SELL'].includes(normalizedSide)) {
        return { success: false, reason: 'Invalid side' };
      }

      if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isInteger(quantity)) {
        return { success: false, reason: 'Quantity must be a positive integer' };
      }

      if (!Number.isFinite(price) || price <= 0) {
        return { success: false, reason: 'Price must be a positive number' };
      }

      const cost = quantity * price;

      if (normalizedSide === 'BUY') {
        if (this.cash < cost) return { success: false, reason: 'Insufficient cash' };
        this.cash -= cost;
        this.portfolio[symbol] = (this.portfolio[symbol] || 0) + quantity;
        this.trades.push({ timestamp: new Date().toISOString(), side: 'BUY', quantity, price, cost });
      } else if (normalizedSide === 'SELL') {
        if ((this.portfolio[symbol] || 0) < quantity) {
          return { success: false, reason: 'Insufficient shares' };
        }
        this.cash += cost;
        this.portfolio[symbol] -= quantity;
        this.trades.push({ timestamp: new Date().toISOString(), side: 'SELL', quantity, price, proceeds: cost });
      }

      return { success: true };
    };

    for (const candle of historicalData) {
      try {
        const sandbox = {
          data: Object.freeze({ ...candle }),
          portfolio: Object.freeze({ ...this.portfolio }),
          cash: this.cash,
          executeOrder
        };
        strategyScript.runInNewContext(sandbox, { timeout: STRATEGY_TIMEOUT_MS });
      } catch (err) {
        return { error: `Strategy runtime error: ${err.message}` };
      }

      const portfolioValue = Object.values(this.portfolio).reduce((sum, qty) => sum + qty * candle.close, 0);
      this.equity.push({ timestamp: candle.timestamp, value: this.cash + portfolioValue });
    }

    return this.calculateStats();
  }

  calculateStats() {
    const equityValues = this.equity.map((e) => e.value);
    const returns = [];
    for (let i = 1; i < equityValues.length; i++) {
      returns.push((equityValues[i] - equityValues[i - 1]) / equityValues[i - 1]);
    }

    const initialCapital = 100000;
    const finalEquity = equityValues[equityValues.length - 1] || initialCapital;
    const totalReturn = ((finalEquity - initialCapital) / initialCapital) * 100;

    const avgReturn = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
    const variance = returns.length
      ? returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length
      : 0;
    const stdDev = Math.sqrt(variance);
    const sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(252) : 0;

    let maxDrawdown = 0;
    let peak = equityValues[0] || initialCapital;
    for (const value of equityValues) {
      if (value > peak) peak = value;
      const drawdown = (peak - value) / peak;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }

    let completedPairs = 0;
    let winningPairs = 0;
    for (let i = 0; i < this.trades.length - 1; i++) {
      const a = this.trades[i];
      const b = this.trades[i + 1];
      if (a.side === 'BUY' && b.side === 'SELL') {
        completedPairs += 1;
        if (b.price > a.price) winningPairs += 1;
      }
    }
    const winRate = completedPairs ? (winningPairs / completedPairs) * 100 : 0;

    return {
      success: true,
      initialCapital,
      finalEquity: Number(finalEquity.toFixed(2)),
      totalReturn: Number(totalReturn.toFixed(2)),
      sharpeRatio: Number(sharpeRatio.toFixed(2)),
      maxDrawdown: Number((maxDrawdown * 100).toFixed(2)),
      winRate: Number(winRate.toFixed(2)),
      totalTrades: this.trades.length,
      trades: this.trades,
      equity: this.equity.map((e) => ({ timestamp: e.timestamp, value: Number(e.value.toFixed(2)) }))
    };
  }
}

module.exports = BacktestEngine;
