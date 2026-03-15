import xrpl from "xrpl";

/**
 * XrplBankManager — Escrow-based prize pool + CREDIT/YES/NO token system.
 *
 * Lifecycle:
 * 1. Sponsor locks real XRP in an on-chain Escrow (the "prize vault")
 * 2. Platform issues free CREDIT tokens to viewers
 * 3. Viewers trade YES/NO outcome tokens on XRPL's native DEX
 * 4. Stream ends → market resolves → Escrow releases → winners get real XRP
 *
 * Legal model: "No Purchase Necessary" sweepstakes.
 */
class XrplBankManager {
  constructor() {
    this.client = null;
    this.connected = false;
    this.issuerWallet = null;
    this.activeEscrows = new Map();
    this.markets = new Map();
    this.viewerCredits = new Map();
  }

  async initialize(url = "wss://s.devnet.rippletest.net:51233") {
    this.client = new xrpl.Client(url);
    await this.client.connect();
    this.connected = true;
    console.log(`[XrplBank] Connected to XRPL: ${url}`);
    return this;
  }

  async disconnect() {
    if (this.client && this.connected) {
      await this.client.disconnect();
      this.connected = false;
      console.log("[XrplBank] Disconnected from XRPL");
    }
  }

  async createTestWallet() {
    const { wallet, balance } = await this.client.fundWallet();
    console.log(`[XrplBank] Funded wallet: ${wallet.address} (${balance} XRP)`);
    return { address: wallet.address, secret: wallet.seed, publicKey: wallet.publicKey, wallet };
  }

  async initializeIssuer() {
    const { wallet } = await this.createTestWallet();
    this.issuerWallet = wallet;

    const accountSetTx = {
      TransactionType: "AccountSet",
      Account: wallet.address,
      SetFlag: 8, // asfDefaultRipple
    };
    const result = await this._submitTx(accountSetTx, wallet);
    console.log(`[XrplBank] Issuer initialized: ${wallet.address}`);
    console.log(`[XrplBank] DefaultRipple TX: ${result.result.hash}`);

    return { address: wallet.address, secret: wallet.seed, publicKey: wallet.publicKey };
  }

  // ── Escrow-based Prize Vault ──

  async createPrizeVault(sponsorWallet, amountXRP, durationSeconds, marketId) {
    const nowRipple = xrpl.isoTimeToRippleTime(new Date().toISOString());
    const finishAfter = nowRipple + durationSeconds;
    const cancelAfter = finishAfter + 86400;

    const escrowTx = {
      TransactionType: "EscrowCreate",
      Account: sponsorWallet.address,
      Amount: xrpl.xrpToDrops(amountXRP),
      Destination: sponsorWallet.address,
      FinishAfter: finishAfter,
      CancelAfter: cancelAfter,
    };

    console.log(`[XrplBank] Creating Prize Vault: ${amountXRP} XRP for ${durationSeconds}s`);
    const result = await this._submitTx(escrowTx, sponsorWallet);
    const txHash = result.result.hash;
    const escrowSequence = result.result.Sequence || result.result.tx_json?.Sequence;

    const escrowInfo = {
      marketId,
      sponsorAddress: sponsorWallet.address,
      amountXRP,
      amountDrops: xrpl.xrpToDrops(amountXRP),
      finishAfter,
      cancelAfter,
      escrowSequence,
      txHash,
      status: "LOCKED",
    };

    this.activeEscrows.set(marketId, escrowInfo);
    console.log(`[XrplBank] Prize Vault TX: ${txHash}`);
    console.log(`[XrplBank] Escrow Sequence: ${escrowSequence}`);
    console.log(`[XrplBank] Explorer: https://devnet.xrpl.org/transactions/${txHash}`);

    return escrowInfo;
  }

  async getVaultStatus(marketId) {
    const escrowInfo = this.activeEscrows.get(marketId);
    if (!escrowInfo) throw new Error("No vault found for this market");

    try {
      const response = await this.client.request({
        command: "account_objects",
        account: escrowInfo.sponsorAddress,
        type: "escrow",
      });
      const escrow = response.result.account_objects.find(
        (obj) => obj.Sequence === escrowInfo.escrowSequence
      );
      return { ...escrowInfo, onChain: escrow || null, exists: !!escrow };
    } catch {
      return { ...escrowInfo, onChain: null, exists: false };
    }
  }

  // ── Market & Credit Token Creation ──

  createMarket(marketId, question) {
    const shortId = marketId.slice(0, 8);
    const market = {
      id: marketId,
      question,
      creditCurrency: this._hexCurrency(`CR_${shortId}`),
      yesCurrency: this._hexCurrency(`YS_${shortId}`),
      noCurrency: this._hexCurrency(`NO_${shortId}`),
      issuerAddress: this.issuerWallet.address,
      status: "OPEN",
      createdAt: Date.now(),
    };

    this.markets.set(marketId, market);
    console.log(`[XrplBank] Market Created: "${question}" (${marketId})`);
    return market;
  }

  async issueTradingCredit(viewerWallet, marketId, creditAmount = 1000) {
    const market = this.markets.get(marketId);
    if (!market) throw new Error("Market not found");

    const issuer = this.issuerWallet;
    const currencies = [market.creditCurrency, market.yesCurrency, market.noCurrency];

    console.log(`[XrplBank] Setting up trust lines for ${viewerWallet.address}...`);
    for (const currency of currencies) {
      const trustTx = {
        TransactionType: "TrustSet",
        Account: viewerWallet.address,
        LimitAmount: { currency, issuer: issuer.address, value: "10000000" },
      };
      await this._submitTx(trustTx, viewerWallet);
    }

    const paymentTx = {
      TransactionType: "Payment",
      Account: issuer.address,
      Destination: viewerWallet.address,
      Amount: { currency: market.creditCurrency, issuer: issuer.address, value: String(creditAmount) },
    };
    const result = await this._submitTx(paymentTx, issuer);

    this.viewerCredits.set(viewerWallet.address, { initial: creditAmount, marketId });
    console.log(`[XrplBank] Issued ${creditAmount} FREE credits to ${viewerWallet.address}`);

    return { address: viewerWallet.address, credits: creditAmount, txHash: result.result.hash };
  }

  async mintOutcomeTokens(marketId, amount = 10000) {
    const market = this.markets.get(marketId);
    if (!market) throw new Error("Market not found");
    const issuer = this.issuerWallet;

    const { wallet: liquidityWallet } = await this.createTestWallet();
    for (const currency of [market.creditCurrency, market.yesCurrency, market.noCurrency]) {
      const trustTx = {
        TransactionType: "TrustSet",
        Account: liquidityWallet.address,
        LimitAmount: { currency, issuer: issuer.address, value: "100000000" },
      };
      await this._submitTx(trustTx, liquidityWallet);
    }

    for (const [currency, label] of [
      [market.yesCurrency, "YES"], [market.noCurrency, "NO"], [market.creditCurrency, "CREDIT"],
    ]) {
      const paymentTx = {
        TransactionType: "Payment",
        Account: issuer.address,
        Destination: liquidityWallet.address,
        Amount: { currency, issuer: issuer.address, value: String(amount) },
      };
      await this._submitTx(paymentTx, issuer);
      console.log(`[XrplBank] Minted ${amount} ${label} to liquidity pool`);
    }

    await this._seedDexLiquidity(liquidityWallet, market, amount);
    market.liquidityWallet = liquidityWallet;
    return { liquidityAddress: liquidityWallet.address };
  }

  async _seedDexLiquidity(liquidityWallet, market, amount) {
    const issuer = this.issuerWallet.address;
    const seedAmount = Math.floor(amount * 0.2);

    const offers = [
      { TakerGets: { currency: market.creditCurrency, issuer, value: String(seedAmount / 2) }, TakerPays: { currency: market.yesCurrency, issuer, value: String(seedAmount) } },
      { TakerGets: { currency: market.creditCurrency, issuer, value: String(seedAmount / 2) }, TakerPays: { currency: market.noCurrency, issuer, value: String(seedAmount) } },
      { TakerGets: { currency: market.yesCurrency, issuer, value: String(seedAmount) }, TakerPays: { currency: market.creditCurrency, issuer, value: String(seedAmount / 2) } },
      { TakerGets: { currency: market.noCurrency, issuer, value: String(seedAmount) }, TakerPays: { currency: market.creditCurrency, issuer, value: String(seedAmount / 2) } },
    ];

    for (const offer of offers) {
      await this._submitTx({ TransactionType: "OfferCreate", Account: liquidityWallet.address, ...offer }, liquidityWallet);
    }
    console.log(`[XrplBank] DEX seeded: YES=0.50, NO=0.50 (${seedAmount} tokens each)`);
  }

  // ── DEX Trading ──

  async placeBuyOrder(viewerWallet, marketId, side, amount, price) {
    const market = this.markets.get(marketId);
    if (!market || market.status !== "OPEN") throw new Error("Market not found or not open");
    const issuer = this.issuerWallet.address;
    const outcomeCurrency = side === "YES" ? market.yesCurrency : market.noCurrency;

    const offerTx = {
      TransactionType: "OfferCreate",
      Account: viewerWallet.address,
      TakerGets: { currency: market.creditCurrency, issuer, value: String(amount * price) },
      TakerPays: { currency: outcomeCurrency, issuer, value: String(amount) },
    };

    const result = await this._submitTx(offerTx, viewerWallet);
    const meta = result.result.meta || result.result.metaData;
    return { txHash: result.result.hash, side, amount, price, ...this._parseOfferResult(meta) };
  }

  async placeSellOrder(viewerWallet, marketId, side, amount, price) {
    const market = this.markets.get(marketId);
    if (!market || market.status !== "OPEN") throw new Error("Market not found or not open");
    const issuer = this.issuerWallet.address;
    const outcomeCurrency = side === "YES" ? market.yesCurrency : market.noCurrency;

    const offerTx = {
      TransactionType: "OfferCreate",
      Account: viewerWallet.address,
      TakerGets: { currency: outcomeCurrency, issuer, value: String(amount) },
      TakerPays: { currency: market.creditCurrency, issuer, value: String(amount * price) },
    };

    const result = await this._submitTx(offerTx, viewerWallet);
    const meta = result.result.meta || result.result.metaData;
    return { txHash: result.result.hash, side, amount, price, ...this._parseOfferResult(meta) };
  }

  async getViewerBalances(viewerAddress, marketId) {
    const market = this.markets.get(marketId);
    if (!market) throw new Error("Market not found");

    const response = await this.client.request({
      command: "account_lines", account: viewerAddress, peer: this.issuerWallet.address,
    });
    const balances = { CREDIT: "0", YES: "0", NO: "0" };
    for (const line of response.result.lines) {
      if (line.currency === market.creditCurrency) balances.CREDIT = line.balance;
      else if (line.currency === market.yesCurrency) balances.YES = line.balance;
      else if (line.currency === market.noCurrency) balances.NO = line.balance;
    }
    return balances;
  }

  // ── Settlement ──

  async settleMarket(sponsorWallet, marketId, outcome, viewers) {
    const market = this.markets.get(marketId);
    if (!market) throw new Error("Market not found");
    const escrowInfo = this.activeEscrows.get(marketId);
    if (!escrowInfo) throw new Error("No escrow found for this market");

    console.log(`[XrplBank] SETTLING MARKET: "${market.question}" → ${outcome}`);
    market.status = "RESOLVED";
    market.outcome = outcome;

    const leaderboard = [];
    for (const viewer of viewers) {
      const balances = await this.getViewerBalances(viewer.address, marketId);
      const winningTokens = parseFloat(outcome === "YES" ? balances.YES : balances.NO);
      if (winningTokens > 0) {
        leaderboard.push({ address: viewer.address, wallet: viewer.wallet, winningTokens });
      }
    }

    if (leaderboard.length === 0) {
      console.log("[XrplBank] No winners found");
      return { winners: [], txHashes: [] };
    }

    // Release escrow
    console.log("[XrplBank] Releasing Prize Vault (EscrowFinish)...");
    const escrowFinishTx = {
      TransactionType: "EscrowFinish",
      Account: sponsorWallet.address,
      Owner: escrowInfo.sponsorAddress,
      OfferSequence: escrowInfo.escrowSequence,
    };
    const finishResult = await this._submitTx(escrowFinishTx, sponsorWallet);
    escrowInfo.status = "RELEASED";
    console.log(`[XrplBank] Escrow released: ${finishResult.result.hash}`);

    // Proportional payouts
    const totalWinningTokens = leaderboard.reduce((s, w) => s + w.winningTokens, 0);
    const prizePoolDrops = parseInt(escrowInfo.amountDrops, 10);
    const feeReserve = leaderboard.length * 15;
    const distributableDrops = prizePoolDrops - feeReserve;

    for (const winner of leaderboard) {
      winner.share = winner.winningTokens / totalWinningTokens;
      winner.payoutDrops = Math.floor(distributableDrops * winner.share);
      winner.payoutXRP = winner.payoutDrops / 1_000_000;
    }

    const txHashes = [];
    for (const winner of leaderboard) {
      if (winner.payoutDrops <= 0) continue;
      const paymentTx = {
        TransactionType: "Payment",
        Account: sponsorWallet.address,
        Destination: winner.address,
        Amount: String(winner.payoutDrops),
      };
      const payResult = await this._submitTx(paymentTx, sponsorWallet);
      txHashes.push({
        address: winner.address,
        payoutXRP: winner.payoutXRP,
        txHash: payResult.result.hash,
        explorerUrl: `https://devnet.xrpl.org/transactions/${payResult.result.hash}`,
      });
      console.log(`[XrplBank] Paid ${winner.payoutXRP.toFixed(2)} XRP → ${winner.address}`);
    }

    console.log(`[XrplBank] Settlement complete: ${txHashes.length} winners paid`);
    return {
      outcome,
      winners: leaderboard.map((w) => ({ address: w.address, winningTokens: w.winningTokens, share: w.share, payoutXRP: w.payoutXRP })),
      txHashes,
    };
  }

  // ── Internal ──

  async _submitTx(tx, wallet) {
    const prepared = await this.client.autofill(tx);
    const signed = wallet.sign(prepared);
    const result = await this.client.submitAndWait(signed.tx_blob);
    const engineResult = result.result.meta?.TransactionResult || result.result.engine_result;
    if (engineResult !== "tesSUCCESS") {
      throw new Error(`TX failed: ${engineResult} (${result.result.hash})`);
    }
    return result;
  }

  _hexCurrency(name) {
    const hex = Buffer.from(name, "utf8").toString("hex").toUpperCase();
    if (hex.length > 40) throw new Error("Currency name too long (max 20 bytes)");
    return hex.padEnd(40, "0");
  }

  _parseOfferResult(meta) {
    if (!meta) return { status: "UNKNOWN", filled: 0 };
    const affectedNodes = meta.AffectedNodes || [];
    const createdOffer = affectedNodes.find((n) => n.CreatedNode?.LedgerEntryType === "Offer");
    const deletedOffers = affectedNodes.filter((n) => n.DeletedNode?.LedgerEntryType === "Offer");

    if (!createdOffer && deletedOffers.length > 0) return { status: "FILLED", filled: "100%" };
    if (createdOffer && deletedOffers.length > 0) return { status: "PARTIALLY_FILLED", filled: "partial" };
    if (createdOffer) return { status: "PLACED", filled: "0%", offerSequence: createdOffer.CreatedNode?.NewFields?.Sequence };
    return { status: "FILLED", filled: "100%" };
  }
}

export default XrplBankManager;
