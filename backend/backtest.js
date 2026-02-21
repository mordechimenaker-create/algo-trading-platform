const vm = require('vm');

const MAX_STRATEGY_LENGTH = 10000;
const MAX_BACKTEST_DAYS = 365;
const STRATEGY_TIMEOUT_MS = 25;
const DEFAULT_FEE_MODEL = Object.freeze({ fixedPerTrade: 0, bps: 0 });
const DEFAULT_EXECUTION_OPTIONS = Object.freeze({
  slippageBps: 0,
  latencyMs: 0,
  feeModel: DEFAULT_FEE_MODEL
});
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
    this.totalFeesPaid = 0;
    this.executionOptions = DEFAULT_EXECUTION_OPTIONS;
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

  getExecutionOptions(options = {}) {
    const normalizedSlippage = Number(options.slippageBps ?? 0);
    const normalizedLatency = Number(options.latencyMs ?? 0);
    const feeModel = options.feeModel || {};
    const fixedPerTrade = Number(feeModel.fixedPerTrade ?? 0);
    const bps = Number(feeModel.bps ?? 0);

    return {
      slippageBps: Number.isFinite(normalizedSlippage) && normalizedSlippage >= 0 ? normalizedSlippage : 0,
      latencyMs: Number.isFinite(normalizedLatency) && normalizedLatency >= 0 ? normalizedLatency : 0,
      feeModel: {
        fixedPerTrade: Number.isFinite(fixedPerTrade) && fixedPerTrade >= 0 ? fixedPerTrade : 0,
        bps: Number.isFinite(bps) && bps >= 0 ? bps : 0
      }
    };
  }

  applyExecutionPrice(side, quotedPrice) {
    const slippagePct = this.executionOptions.slippageBps / 10000;
    if (side === 'BUY') return quotedPrice * (1 + slippagePct);
    return quotedPrice * (1 - slippagePct);
  }

  getTradeFees(notional) {
    const { fixedPerTrade, bps } = this.executionOptions.feeModel;
    return fixedPerTrade + (notional * bps / 10000);
  }

  async runBacktest(strategyCode, symbol = 'AAPL', days = 30, options = {}) {
    if (!Number.isInteger(days) || days < 1 || days > MAX_BACKTEST_DAYS) {
      return { error: `days must be an integer between 1 and ${MAX_BACKTEST_DAYS}` };
    }

    const strategyValidation = BacktestEngine.validateStrategyCode(strategyCode);
    if (!strategyValidation.valid) {
      return { error: strategyValidation.error };
    }

    const historicalData = Array.isArray(options.historicalData) && options.historicalData.length
      ? options.historicalData
      : this.generateHistoricalData(symbol, days);
    this.executionOptions = this.getExecutionOptions(options);
    const strategyScript = new vm.Script(strategyCode);

    this.trades = [];
    this.equity = [];
    this.portfolio = {};
    this.cash = 100000;
    this.totalFeesPaid = 0;

    const executeOrder = (side, quantity, price, orderSymbol = symbol) => {
      const normalizedSide = String(side || '').toUpperCase();
      const normalizedSymbol = String(orderSymbol || symbol).trim().toUpperCase();
      if (!['BUY', 'SELL'].includes(normalizedSide)) {
        return { success: false, reason: 'Invalid side' };
      }
      if (!/^[A-Z]{1,10}$/.test(normalizedSymbol)) {
        return { success: false, reason: 'Invalid symbol' };
      }

      if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isInteger(quantity)) {
        return { success: false, reason: 'Quantity must be a positive integer' };
      }

      if (!Number.isFinite(price) || price <= 0) {
        return { success: false, reason: 'Price must be a positive number' };
      }

      const executionPrice = this.applyExecutionPrice(normalizedSide, price);
      const notional = quantity * executionPrice;
      const fees = this.getTradeFees(notional);
      const timestamp = new Date(Date.now() + this.executionOptions.latencyMs).toISOString();

      if (normalizedSide === 'BUY') {
        const totalCost = notional + fees;
        if (this.cash < totalCost) return { success: false, reason: 'Insufficient cash' };
        this.cash -= totalCost;
        this.totalFeesPaid += fees;
        this.portfolio[normalizedSymbol] = (this.portfolio[normalizedSymbol] || 0) + quantity;
        this.trades.push({
          timestamp,
          side: 'BUY',
          symbol: normalizedSymbol,
          quantity,
          price: Number(executionPrice.toFixed(6)),
          quotedPrice: Number(price.toFixed(6)),
          fees: Number(fees.toFixed(6)),
          cost: Number(totalCost.toFixed(6))
        });
      } else if (normalizedSide === 'SELL') {
        if ((this.portfolio[normalizedSymbol] || 0) < quantity) {
          return { success: false, reason: 'Insufficient shares' };
        }
        const proceeds = notional - fees;
        this.cash += proceeds;
        this.totalFeesPaid += fees;
        this.portfolio[normalizedSymbol] -= quantity;
        this.trades.push({
          timestamp,
          side: 'SELL',
          symbol: normalizedSymbol,
          quantity,
          price: Number(executionPrice.toFixed(6)),
          quotedPrice: Number(price.toFixed(6)),
          fees: Number(fees.toFixed(6)),
          proceeds: Number(proceeds.toFixed(6))
        });
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
      totalFeesPaid: Number(this.totalFeesPaid.toFixed(2)),
      slippageBps: Number(this.executionOptions.slippageBps.toFixed(4)),
      latencyMs: Number(this.executionOptions.latencyMs.toFixed(2)),
      totalTrades: this.trades.length,
      trades: this.trades,
      equity: this.equity.map((e) => ({ timestamp: e.timestamp, value: Number(e.value.toFixed(2)) }))
    };
  }
}

module.exports = BacktestEngine;
