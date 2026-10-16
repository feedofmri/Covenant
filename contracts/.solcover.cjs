module.exports = {
  skipFiles: ["mocks/AttackTokens.sol", "mocks/MockStable.sol", "mocks/MockAggregator.sol", "mocks/MockAmm.sol", "mocks/MockLendingPool.sol"],
  configureYulOptimizer: true,
  irMinimum: true,
  istanbulReporter: ["html", "lcov", "text", "json"],
};
