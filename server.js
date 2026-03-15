import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import { fileURLToPath } from "url";
import config from "./src/config.js";
import { getClient, disconnect, walletFromSecret, fundTestnetWallet } from "./src/xrpl/client.js";
import { enableDefaultRipple } from "./src/xrpl/tokens.js";
import { settleMatchedTrade } from "./src/xrpl/settlement.js";
import { verifyOrderSignature, deriveAddress } from "./src/orders/signer.js";
import OrderBook from "./src/orders/order-book.js";
import Matcher from "./src/orders/matcher.js";
import MarketManager from "./src/market/market-manager.js";
import XrplBankManager from "./xrplBank.js";

// ─── Core instances ───

const orderBook = new OrderBook();
const matcher = new Matcher(orderBook);
const marketManager = new MarketManager();
const xrplBank = new XrplBankManager();

// Public key registry: address → publicKey
const publicKeyRegistry = new Map();

// Virtual balances for quick-play mode (no wallet needed)
const virtualAccounts = new Map();
const INITIAL_BALANCE = 1000;
const MARGIN_PER_CONTRACT = 50;

function getVirtualAccount(userId) {
  if (!virtualAccounts.has(userId)) {
    virtualAccounts.set(userId, { balance: INITIAL_BALANCE, positions: [] });
  }
  return virtualAccounts.get(userId);
}

let oracleTime = null;

// Oracle / run lifecycle (from stream watcher)
let activeSessionId = null;
let currentRunEvents = new Set();
let runSequence = 0;
let currentXrplMarketId = "default";

// ─── Express + WebSocket ───

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });
const wsUserMap = new Map();

app.use(express.json());
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});
app.options("*", (_, res) => res.sendStatus(204));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(__dirname, "sidebar")));

app.get("/", (_req, res) => res.redirect("/sidebar.html"));

// ─── Health ───

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: Date.now() });
});

// ════════════════════════════════════════════════════════════
// MARKETS (from friend's MarketManager)
// ════════════════════════════════════════════════════════════

app.post("/markets", (req, res) => {
  try {
    const { question, description, resolutionDate, creatorAddress, issuerAddress } = req.body;
    if (!question || !resolutionDate || !creatorAddress || !issuerAddress) {
      return res.status(400).json({ error: "question, resolutionDate, creatorAddress, issuerAddress required" });
    }
    const market = marketManager.createMarket({ question, description, resolutionDate, creatorAddress, issuerAddress });
    broadcast({ type: "marketCreated", market });
    res.status(201).json(market);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/markets", (req, res) => {
  res.json(marketManager.listMarkets(req.query.status || null));
});

app.get("/markets/:id", (req, res) => {
  const market = marketManager.getMarket(req.params.id);
  if (!market) return res.status(404).json({ error: "Market not found" });
  res.json(market);
});

app.post("/markets/:id/close", (req, res) => {
  try {
    const market = marketManager.closeMarket(req.params.id);
    broadcast({ type: "marketClosed", market });
    res.json(market);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/markets/:id/resolve", (req, res) => {
  try {
    const { outcome } = req.body;
    if (!outcome) return res.status(400).json({ error: "outcome required (YES or NO)" });
    const market = marketManager.resolveMarket(req.params.id, outcome);
    broadcast({ type: "marketResolved", market });
    res.json(market);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════
// PUBLIC KEY REGISTRY (for signed orders)
// ════════════════════════════════════════════════════════════

app.post("/register", (req, res) => {
  const { address, publicKey } = req.body;
  if (!address || !publicKey) return res.status(400).json({ error: "address and publicKey required" });
  const derived = deriveAddress(publicKey);
  if (derived !== address) return res.status(400).json({ error: "publicKey does not match address" });
  publicKeyRegistry.set(address, publicKey);
  res.json({ registered: true, address });
});

// ════════════════════════════════════════════════════════════
// SIGNED ORDERS (friend's order book with crypto signing)
// ════════════════════════════════════════════════════════════

app.post("/orders", (req, res) => {
  try {
    const order = req.body;
    const requiredFields = ["marketId", "side", "price", "amount", "maker", "expiry", "nonce", "orderSide", "signature"];
    for (const field of requiredFields) {
      if (order[field] === undefined) return res.status(400).json({ error: `Missing field: ${field}` });
    }

    const market = marketManager.getMarket(order.marketId);
    if (!market) return res.status(404).json({ error: "Market not found" });
    if (market.status !== "OPEN") return res.status(400).json({ error: "Market is not open for trading" });

    const publicKey = publicKeyRegistry.get(order.maker);
    if (!publicKey) return res.status(400).json({ error: "Maker public key not registered. POST /register first." });
    if (!verifyOrderSignature(order, publicKey)) return res.status(401).json({ error: "Invalid order signature" });

    const enrichedOrder = orderBook.addOrder(order);
    const fills = matcher.matchOrder(enrichedOrder);

    broadcast({ type: "orderBookUpdate", marketId: order.marketId, side: order.side, book: orderBook.getOrderBook(order.marketId, order.side), fills });

    res.status(201).json({ order: enrichedOrder, fills, pendingSettlement: fills.length });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/orders/:id", (req, res) => {
  try {
    const { maker } = req.body || {};
    const order = orderBook.getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.maker !== maker) return res.status(403).json({ error: "Only the maker can cancel" });
    const cancelled = orderBook.cancelOrder(req.params.id);
    res.json(cancelled);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/orderbook/:marketId/:side", (req, res) => {
  const { marketId, side } = req.params;
  if (!["YES", "NO"].includes(side)) return res.status(400).json({ error: "side must be YES or NO" });
  res.json(orderBook.getOrderBook(marketId, side));
});

app.get("/orders/maker/:address", (req, res) => {
  res.json(orderBook.getOrdersByMaker(req.params.address));
});

// ════════════════════════════════════════════════════════════
// QUICK-PLAY TRADES (virtual balances, no wallet needed)
// For the sidebar UI — viewers can trade immediately
// ════════════════════════════════════════════════════════════

app.post("/api/trade", (req, res) => {
  const { userId, marketId, side, orderSide, price, amount } = req.body;

  if (!userId || !price || !amount) {
    return res.status(400).json({ error: "userId, price, and amount required" });
  }

  const account = getVirtualAccount(userId);
  const cost = MARGIN_PER_CONTRACT * amount;
  if (account.balance < cost) {
    return res.status(400).json({ error: `Insufficient margin. Need $${cost}, have $${account.balance}` });
  }

  account.balance -= cost;

  // Create a virtual order compatible with the order book
  const virtualOrder = {
    marketId: marketId || "default",
    side: side || "YES",
    orderSide: orderSide || "BUY",
    price,
    amount,
    maker: userId,
    nonce: uuidv4(),
    expiry: Math.floor(Date.now() / 1000) + 3600,
  };

  const enrichedOrder = orderBook.addOrder(virtualOrder);
  const fills = matcher.matchOrder(enrichedOrder);

  // Return margin on fills
  for (const fill of fills) {
    if (fill.seller === userId) {
      const sellerAcct = getVirtualAccount(fill.seller);
      sellerAcct.balance += MARGIN_PER_CONTRACT * fill.amount;
      sendToUser(fill.seller, { type: "balanceUpdate", balance: sellerAcct.balance });
    }
    if (fill.buyer !== userId) {
      const buyerAcct = getVirtualAccount(fill.buyer);
      sendToUser(fill.buyer, { type: "balanceUpdate", balance: buyerAcct.balance });
    }
  }

  sendToUser(userId, { type: "balanceUpdate", balance: account.balance });
  broadcast({
    type: "orderBookUpdate",
    marketId: virtualOrder.marketId,
    side: virtualOrder.side,
    book: orderBook.getOrderBook(virtualOrder.marketId, virtualOrder.side),
    fills,
  });

  res.json({
    accepted: true,
    order: enrichedOrder,
    fills: fills.length,
    balance: account.balance,
    book: orderBook.getOrderBook(virtualOrder.marketId, virtualOrder.side),
  });
});

// ════════════════════════════════════════════════════════════
// ORACLE (your AI oracle endpoint)
// ════════════════════════════════════════════════════════════

app.post("/api/oracle-update", (req, res) => {
  const { actualElapsedSeconds } = req.body;
  if (typeof actualElapsedSeconds !== "number" || actualElapsedSeconds < 0) {
    return res.status(400).json({ error: "actualElapsedSeconds must be a non-negative number" });
  }

  oracleTime = actualElapsedSeconds;
  broadcast({ type: "oracleUpdate", oracleTime });
  res.json({ success: true, oracleTime });
});

// ════════════════════════════════════════════════════════════
// SETTLEMENT (on-chain)
// ════════════════════════════════════════════════════════════

app.get("/settlement/pending", (_req, res) => {
  res.json(matcher.getPendingTrades());
});

app.post("/settlement/execute", async (req, res) => {
  try {
    const { buyOrderId, sellOrderId, sellerSecret, buyerSecret } = req.body;
    if (!buyOrderId || !sellOrderId || !sellerSecret || !buyerSecret) {
      return res.status(400).json({ error: "buyOrderId, sellOrderId, sellerSecret, buyerSecret required" });
    }

    const trade = matcher.markSettledByIds(buyOrderId, sellOrderId);
    if (!trade) return res.status(404).json({ error: "Pending trade not found" });

    const market = marketManager.getMarket(trade.marketId);
    const sellerWallet = walletFromSecret(sellerSecret);
    const buyerWallet = walletFromSecret(buyerSecret);

    const result = await settleMatchedTrade({
      sellerWallet, buyerWallet, issuerAddress: market.issuerAddress,
      marketId: trade.marketId, side: trade.side, amount: trade.amount, pricePerToken: trade.price,
    });

    res.json({ settled: true, trade, result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════
// XRPL BANK (Escrow vault + CREDIT/YES/NO tokens)
// ════════════════════════════════════════════════════════════

app.post("/api/xrpl/init", async (_req, res) => {
  try {
    await xrplBank.initialize();
    const issuer = await xrplBank.initializeIssuer();
    res.json({ success: true, issuer });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/xrpl/create-vault", async (req, res) => {
  const { sponsorSecret, amountXRP, durationSeconds, marketId } = req.body;
  if (!sponsorSecret || !amountXRP || !marketId) {
    return res.status(400).json({ error: "sponsorSecret, amountXRP, marketId required" });
  }
  try {
    const sponsorWallet = walletFromSecret(sponsorSecret);
    const escrow = await xrplBank.createPrizeVault(sponsorWallet, amountXRP, durationSeconds || 3600, marketId);
    res.json({ success: true, escrow });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/xrpl/create-market", async (req, res) => {
  const { marketId, question } = req.body;
  if (!marketId || !question) return res.status(400).json({ error: "marketId and question required" });
  try {
    const market = xrplBank.createMarket(marketId, question);
    const liquidity = await xrplBank.mintOutcomeTokens(marketId);
    res.json({ success: true, market, liquidity });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/xrpl/issue-credit", async (req, res) => {
  const { viewerSecret, marketId, creditAmount } = req.body;
  if (!viewerSecret || !marketId) return res.status(400).json({ error: "viewerSecret and marketId required" });
  try {
    const viewerWallet = walletFromSecret(viewerSecret);
    const credit = await xrplBank.issueTradingCredit(viewerWallet, marketId, creditAmount || 1000);
    res.json({ success: true, credit });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/xrpl/trade", async (req, res) => {
  const { viewerSecret, marketId, side, orderSide, amount, price } = req.body;
  if (!viewerSecret || !marketId || !side || !amount || !price) {
    return res.status(400).json({ error: "viewerSecret, marketId, side, orderSide, amount, price required" });
  }
  try {
    const viewerWallet = walletFromSecret(viewerSecret);
    const result = orderSide === "SELL"
      ? await xrplBank.placeSellOrder(viewerWallet, marketId, side, amount, price)
      : await xrplBank.placeBuyOrder(viewerWallet, marketId, side, amount, price);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/xrpl/balances/:address/:marketId", async (req, res) => {
  try {
    const balances = await xrplBank.getViewerBalances(req.params.address, req.params.marketId);
    res.json(balances);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/xrpl/vault/:marketId", async (req, res) => {
  try {
    const status = await xrplBank.getVaultStatus(req.params.marketId);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/xrpl/derive-address", (req, res) => {
  try {
    const { secret } = req.body;
    if (!secret) return res.status(400).json({ error: "secret required" });
    const wallet = walletFromSecret(secret);
    res.json({ address: wallet.address });
  } catch (err) {
    res.status(400).json({ error: err.message || "Invalid secret" });
  }
});

app.get("/api/xrpl/markets", (_req, res) => {
  const markets = Array.from(xrplBank.markets.values()).map((m) => ({
    id: m.id,
    question: m.question,
    status: m.status,
  }));
  res.json(markets);
});

app.post("/api/session/register", (req, res) => {
  const { session_id } = req.body;
  if (session_id) {
    activeSessionId = session_id;
    console.log(`[server] Oracle session registered: ${session_id}`);
  }
  res.json({ ok: true });
});

app.post("/api/oracle/event", async (req, res) => {
  const { event_type, session_id, description } = req.body;
  res.json({ received: true });

  if (event_type === "speedrun_started") {
    currentRunEvents.clear();
    runSequence++;
    const marketId = `run_${runSequence}`;
    const question = `Will this speedrun be completed? (Run #${runSequence})`;
    try {
      if (!xrplBank.connected) await xrplBank.initialize();
      if (!xrplBank.issuerWallet) await xrplBank.initializeIssuer();
      const market = xrplBank.createMarket(marketId, question);
      await xrplBank.mintOutcomeTokens(marketId);
      currentXrplMarketId = marketId;
      broadcast({ type: "marketCreated", market });
      console.log(`[server] New market: ${marketId} — ${question}`);
    } catch (err) {
      console.error("[server] Failed to create market:", err.message);
    }
    return;
  }

  if (event_type === "ender_dragon_killed") {
    currentRunEvents.add("ender_dragon_killed");
    return;
  }

  if (event_type === "speedrun_ended") {
    const outcome = currentRunEvents.has("ender_dragon_killed") ? "YES" : "NO";
    const market = xrplBank.markets.get(currentXrplMarketId);
    if (market && market.status === "OPEN") {
      market.status = "RESOLVED";
      market.outcome = outcome;
      broadcast({ type: "marketResolved", market });
      console.log(`[server] Market resolved: ${currentXrplMarketId} → ${outcome}`);
    }
    return;
  }
});

app.get("/api/suggestions", async (_req, res) => {
  if (!activeSessionId) {
    return res.json({ suggestions: [] });
  }
  const streamUrl = process.env.STREAM_WATCHER_URL || "http://127.0.0.1:8421";
  try {
    const r = await fetch(`${streamUrl}/session/suggest-markets/${activeSessionId}`);
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.json({ suggestions: [] });
  }
});

app.get("/api/xrpl/current-market", (_req, res) => {
  const market = xrplBank.markets.get(currentXrplMarketId);
  if (!market) {
    return res.json({ marketId: currentXrplMarketId, question: "Speedrun Market" });
  }
  res.json({ marketId: market.id, question: market.question, status: market.status });
});

app.post("/api/xrpl/bootstrap", async (req, res) => {
  try {
    if (!xrplBank.connected) await xrplBank.initialize();
    if (!xrplBank.issuerWallet) await xrplBank.initializeIssuer();
    const marketId = req.body.marketId || "default";
    const question = req.body.question || "Speedrun Market";
    if (!xrplBank.markets.has(marketId)) {
      const market = xrplBank.createMarket(marketId, question);
      await xrplBank.mintOutcomeTokens(marketId);
      currentXrplMarketId = marketId;
      res.json({ success: true, market, bootstrapped: true });
    } else {
      res.json({ success: true, market: xrplBank.markets.get(marketId), bootstrapped: false });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════
// TESTNET HELPERS
// ════════════════════════════════════════════════════════════

app.post("/testnet/fund", async (_req, res) => {
  try {
    const wallet = await fundTestnetWallet();
    res.json({ address: wallet.address, secret: wallet.seed, publicKey: wallet.publicKey });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/testnet/init-issuer", async (req, res) => {
  try {
    const { issuerSecret } = req.body;
    if (!issuerSecret) return res.status(400).json({ error: "issuerSecret required" });
    const issuerWallet = walletFromSecret(issuerSecret);
    const result = await enableDefaultRipple(issuerWallet);
    res.json({ success: true, address: issuerWallet.address, result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════
// TOKEN MINTING (on-chain, from MarketManager)
// ════════════════════════════════════════════════════════════

app.post("/markets/:id/trust", async (req, res) => {
  try {
    const { userSecret } = req.body;
    if (!userSecret) return res.status(400).json({ error: "userSecret required" });
    const userWallet = walletFromSecret(userSecret);
    const result = await marketManager.setupUserTrustLines(userWallet, req.params.id);
    res.json({ success: true, address: userWallet.address, result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/markets/:id/mint", async (req, res) => {
  try {
    const { userAddress, amount } = req.body;
    if (!userAddress || !amount) return res.status(400).json({ error: "userAddress and amount required" });
    if (!config.issuer.secret) return res.status(500).json({ error: "Issuer not configured" });
    const issuerWallet = walletFromSecret(config.issuer.secret);
    const result = await marketManager.mintTokensForUser(issuerWallet, userAddress, req.params.id, amount);
    res.json({ success: true, amount, result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/markets/:id/redeem", async (req, res) => {
  try {
    const { holderSecret, amount } = req.body;
    if (!holderSecret || !amount) return res.status(400).json({ error: "holderSecret and amount required" });
    if (!config.issuer.secret) return res.status(500).json({ error: "Issuer not configured" });
    const issuerWallet = walletFromSecret(config.issuer.secret);
    const holderWallet = walletFromSecret(holderSecret);
    const result = await marketManager.redeemForUser(issuerWallet, holderWallet, req.params.id, amount);
    res.json({ redeemed: true, amount, result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════
// WEBSOCKET (your real-time layer)
// ════════════════════════════════════════════════════════════

function broadcast(data) {
  const message = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(message);
  }
}

function sendToUser(userId, data) {
  const message = JSON.stringify(data);
  for (const [ws, uid] of wsUserMap) {
    if (uid === userId && ws.readyState === 1) ws.send(message);
  }
}

wss.on("connection", (ws, req) => {
  console.log(`[WS] New connection from ${req.socket.remoteAddress}`);
  const markets = marketManager.listMarkets();
  const firstMarket = markets[0] || null;

  // Send initial state including current order book
  let yesBook = null;
  let noBook = null;
  if (firstMarket) {
    yesBook = orderBook.getOrderBook(firstMarket.id, "YES");
    noBook = orderBook.getOrderBook(firstMarket.id, "NO");
  }

  ws.send(JSON.stringify({
    type: "init",
    balance: INITIAL_BALANCE,
    oracleTime,
    markets,
    orderBook: yesBook,
    noOrderBook: noBook,
  }));

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    const { action } = msg;

    if (action === "register") {
      wsUserMap.set(ws, msg.userId);
      ws.send(JSON.stringify({ type: "registered", userId: msg.userId }));
      return;
    }

    if (action === "placeOrder") {
      const { userId, marketId, side, orderSide, price, amount } = msg;
      if (!userId) { ws.send(JSON.stringify({ type: "error", message: "userId required" })); return; }

      wsUserMap.set(ws, userId);
      const account = getVirtualAccount(userId);
      const cost = MARGIN_PER_CONTRACT * (amount || 1);

      if (account.balance < cost) {
        ws.send(JSON.stringify({ type: "error", message: `Insufficient margin. Need $${cost}, have $${account.balance}` }));
        return;
      }

      account.balance -= cost;

      const virtualOrder = {
        marketId: marketId || "default",
        side: side || "YES",
        orderSide: orderSide || "BUY",
        price: price || 0.5,
        amount: amount || 1,
        maker: userId,
        nonce: uuidv4(),
        expiry: Math.floor(Date.now() / 1000) + 3600,
      };

      try {
        const enrichedOrder = orderBook.addOrder(virtualOrder);
        const fills = matcher.matchOrder(enrichedOrder);

        ws.send(JSON.stringify({ type: "orderAccepted", order: enrichedOrder, fills: fills.length }));
        sendToUser(userId, { type: "balanceUpdate", balance: account.balance });

        for (const fill of fills) {
          if (fill.seller && fill.seller !== userId) {
            const sellerAcct = getVirtualAccount(fill.seller);
            sellerAcct.balance += MARGIN_PER_CONTRACT * fill.amount;
            sendToUser(fill.seller, { type: "balanceUpdate", balance: sellerAcct.balance });
          }
        }

        broadcast({
          type: "orderBookUpdate",
          marketId: virtualOrder.marketId,
          side: virtualOrder.side,
          book: orderBook.getOrderBook(virtualOrder.marketId, virtualOrder.side),
          fills,
        });
      } catch (err) {
        account.balance += cost;
        ws.send(JSON.stringify({ type: "error", message: err.message }));
      }

      return;
    }

    ws.send(JSON.stringify({ type: "error", message: `Unknown action: ${action}` }));
  });

  ws.on("close", () => {
    console.log(`[WS] Connection closed (${wsUserMap.get(ws) || "unknown"})`);
    wsUserMap.delete(ws);
  });
});

// ════════════════════════════════════════════════════════════
// SERVER START
// ════════════════════════════════════════════════════════════

async function start() {
  try {
    await getClient();
    console.log(`Connected to XRPL: ${config.xrpl.wssUrl}`);
  } catch (err) {
    console.warn("XRPL not available on startup:", err.message);
    console.warn("On-chain operations will fail until XRPL is available.");
  }

  server.listen(config.server.port, () => {
    console.log(`SpeedrunFi server on http://localhost:${config.server.port}`);
    console.log(`WebSocket on ws://localhost:${config.server.port}`);
    console.log(`Network: ${config.xrpl.network}`);
  });
}

process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  await disconnect();
  await xrplBank.disconnect();
  process.exit(0);
});

start();
