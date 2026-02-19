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

  async runBacktest(strategyCode, symbol = 'AAPL', days = 30) {
    const historicalData = this.generateHistoricalData(symbol, days);

    let strategy;
    try {
      strategy = new Function('data', 'portfolio', 'cash', 'executeOrder', strategyCode);
    } catch (err) {
      return { error: `Syntax error: ${err.message}` };
    }

    this.trades = [];
    this.equity = [];
    this.portfolio = {};
    this.cash = 100000;

    const executeOrder = (side, quantity, price) => {
      const cost = quantity * price;

      if (side === 'BUY') {
        if (this.cash < cost) return { success: false, reason: 'Insufficient cash' };
        this.cash -= cost;
        this.portfolio[symbol] = (this.portfolio[symbol] || 0) + quantity;
        this.trades.push({ timestamp: new Date().toISOString(), side: 'BUY', quantity, price, cost });
      } else if (side === 'SELL') {
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
        strategy(candle, this.portfolio, this.cash, executeOrder);
      } catch (err) {
        console.error('Strategy error:', err);
        break;
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
