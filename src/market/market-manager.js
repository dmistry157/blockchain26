import { v4 as uuidv4 } from "uuid";
import { marketCurrencyCodes, createTrustLine, mintCompleteSet, enableDefaultRipple } from "../xrpl/tokens.js";
import { redeemWinningTokens } from "../xrpl/settlement.js";

class MarketManager {
  constructor() {
    this.markets = new Map();
  }

  createMarket({ question, description, resolutionDate, creatorAddress, issuerAddress }) {
    const marketId = uuidv4().replace(/-/g, "").slice(0, 16);
    const codes = marketCurrencyCodes(marketId);

    const market = {
      id: marketId,
      question,
      description: description || "",
      resolutionDate,
      createdAt: Date.now(),
      creatorAddress,
      issuerAddress,
      yesCurrencyCode: codes.yes,
      noCurrencyCode: codes.no,
      status: "OPEN",
      outcome: null,
      totalMinted: 0,
    };

    this.markets.set(marketId, market);
    return market;
  }

  getMarket(marketId) {
    return this.markets.get(marketId) || null;
  }

  listMarkets(status = null) {
    const all = Array.from(this.markets.values());
    if (status) return all.filter((m) => m.status === status);
    return all;
  }

  async setupUserTrustLines(userWallet, marketId) {
    const market = this.getMarket(marketId);
    if (!market) throw new Error("Market not found");

    const yesResult = await createTrustLine(userWallet, market.issuerAddress, market.yesCurrencyCode);
    const noResult = await createTrustLine(userWallet, market.issuerAddress, market.noCurrencyCode);
    return { yesResult, noResult };
  }

  async mintTokensForUser(issuerWallet, userAddress, marketId, amount) {
    const market = this.getMarket(marketId);
    if (!market) throw new Error("Market not found");
    if (market.status !== "OPEN") throw new Error("Market is not open");

    const result = await mintCompleteSet(issuerWallet, userAddress, marketId, amount);
    market.totalMinted += amount;
    return result;
  }

  closeMarket(marketId) {
    const market = this.getMarket(marketId);
    if (!market) throw new Error("Market not found");
    if (market.status !== "OPEN") throw new Error("Market is not open");
    market.status = "CLOSED";
    return market;
  }

  resolveMarket(marketId, outcome) {
    const market = this.getMarket(marketId);
    if (!market) throw new Error("Market not found");
    if (market.status === "RESOLVED") throw new Error("Market already resolved");
    if (!["YES", "NO"].includes(outcome)) throw new Error("Outcome must be YES or NO");

    market.status = "RESOLVED";
    market.outcome = outcome;
    market.resolvedAt = Date.now();
    return market;
  }

  async redeemForUser(issuerWallet, holderWallet, marketId, amount) {
    const market = this.getMarket(marketId);
    if (!market) throw new Error("Market not found");
    if (market.status !== "RESOLVED") throw new Error("Market not yet resolved");

    return redeemWinningTokens(issuerWallet, holderWallet, marketId, market.outcome, amount);
  }
}

export default MarketManager;
