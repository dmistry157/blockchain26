/**
 * test_market.js — End-to-end backend test for merged SpeedrunFi
 *
 * Usage:
 *   node test_market.js seed       # Create market + seed order book with bots
 *   node test_market.js oracle     # Simulate oracle time updates
 *   node test_market.js full       # Run both: seed then oracle
 *   node test_market.js trade      # Interactive: place a single manual trade
 */

const SERVER = "http://localhost:8080";

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(json)}`);
  return json;
}

// ── Create a market ──

async function createMarket() {
  console.log("=== CREATING MARKET ===");
  const market = await fetchJson(`${SERVER}/markets`, {
    method: "POST",
    body: JSON.stringify({
      question: "Will the speedrun finish under 20 minutes?",
      description: "Binary prediction on total speedrun time",
      resolutionDate: new Date(Date.now() + 3600_000).toISOString(),
      creatorAddress: "rTestCreator",
      issuerAddress: "rTestIssuer",
    }),
  });
  console.log("Market created:", market.id);
  console.log("  Question:", market.question);
  console.log("  YES token:", market.yesCurrencyCode);
  console.log("  NO token:", market.noCurrencyCode);
  return market;
}

// ── Seed order book with virtual bot trades ──

async function seedMarket(marketId) {
  console.log("\n=== SEEDING ORDER BOOK ===");
  // Each bot gets $1000, margin is $50/contract → max 20 contracts
  // Use unique bot names so no one runs out of margin

  // YES bids (each bot places ONE order)
  const bids = [
    { userId: "buyer_1", price: 55, amount: 8, side: "YES", orderSide: "BUY" },
    { userId: "buyer_2", price: 50, amount: 10, side: "YES", orderSide: "BUY" },
    { userId: "buyer_3", price: 45, amount: 8, side: "YES", orderSide: "BUY" },
    { userId: "buyer_4", price: 40, amount: 5, side: "YES", orderSide: "BUY" },
  ];

  // YES asks (different bots)
  const asks = [
    { userId: "seller_1", price: 60, amount: 8, side: "YES", orderSide: "SELL" },
    { userId: "seller_2", price: 65, amount: 10, side: "YES", orderSide: "SELL" },
    { userId: "seller_3", price: 70, amount: 8, side: "YES", orderSide: "SELL" },
    { userId: "seller_4", price: 75, amount: 5, side: "YES", orderSide: "SELL" },
  ];

  // NO side
  const noBids = [
    { userId: "no_buyer_1", price: 40, amount: 8, side: "NO", orderSide: "BUY" },
    { userId: "no_buyer_2", price: 35, amount: 10, side: "NO", orderSide: "BUY" },
  ];

  const noAsks = [
    { userId: "no_seller_1", price: 55, amount: 8, side: "NO", orderSide: "SELL" },
    { userId: "no_seller_2", price: 60, amount: 10, side: "NO", orderSide: "SELL" },
  ];

  const allOrders = [...bids, ...asks, ...noBids, ...noAsks];
  let placed = 0;

  for (const order of allOrders) {
    try {
      const result = await fetchJson(`${SERVER}/api/trade`, {
        method: "POST",
        body: JSON.stringify({
          userId: order.userId,
          marketId,
          side: order.side,
          orderSide: order.orderSide,
          price: order.price / 100,
          amount: order.amount,
        }),
      });
      placed++;
      console.log(`  ${order.orderSide} ${order.amount}x ${order.side}@${order.price}¢ by ${order.userId} → fills: ${result.fills}`);
    } catch (err) {
      console.error(`  FAILED: ${err.message}`);
    }
  }

  console.log(`\nPlaced ${placed}/${allOrders.length} orders`);
}

// ── Oracle simulation ──

async function simulateOracle(durationSeconds = 60, intervalMs = 5000) {
  console.log("\n=== ORACLE SIMULATION ===");
  console.log(`Simulating ${durationSeconds}s speedrun, updating every ${intervalMs / 1000}s`);

  const startTime = Date.now();
  let elapsed = 0;

  while (elapsed < durationSeconds) {
    elapsed = Math.floor((Date.now() - startTime) / 1000);
    const speedrunTime = Math.min(elapsed * 20, durationSeconds * 20);

    try {
      const result = await fetchJson(`${SERVER}/api/oracle-update`, {
        method: "POST",
        body: JSON.stringify({ actualElapsedSeconds: speedrunTime }),
      });
      console.log(`  Oracle: ${speedrunTime}s (stream time: ${elapsed}s)`);
    } catch (err) {
      console.error(`  Oracle error: ${err.message}`);
    }

    await sleep(intervalMs);
  }

  console.log("Oracle simulation complete");
}

// ── Manual trade ──

async function manualTrade() {
  console.log("\n=== MANUAL TRADE ===");
  console.log("Placing a YES BUY @ 52¢ for 5 contracts as 'manual_trader'...\n");

  const result = await fetchJson(`${SERVER}/api/trade`, {
    method: "POST",
    body: JSON.stringify({
      userId: "manual_trader",
      marketId: "default",
      side: "YES",
      orderSide: "BUY",
      price: 0.52,
      amount: 5,
    }),
  });

  console.log("Result:", JSON.stringify(result, null, 2));
}

// ── Main ──

async function main() {
  const cmd = process.argv[2] || "full";

  try {
    // Check server health
    await fetchJson(`${SERVER}/health`);
    console.log("Server is running\n");
  } catch {
    console.error("Server not reachable at " + SERVER);
    console.error("Start it first: node server.js");
    process.exit(1);
  }

  if (cmd === "seed") {
    const market = await createMarket();
    await seedMarket(market.id);
  } else if (cmd === "oracle") {
    await simulateOracle();
  } else if (cmd === "trade") {
    await manualTrade();
  } else if (cmd === "full") {
    const market = await createMarket();
    await seedMarket(market.id);
    console.log("\n--- Waiting 2s before oracle ---\n");
    await sleep(2000);
    await simulateOracle(30, 3000);

    console.log("\n--- Placing a manual trade ---\n");
    await fetchJson(`${SERVER}/api/trade`, {
      method: "POST",
      body: JSON.stringify({
        userId: "manual_trader",
        marketId: market.id,
        side: "YES",
        orderSide: "BUY",
        price: 0.58,
        amount: 8,
      }),
    }).then(r => {
      console.log(`Manual trade: ${r.fills} fills, balance: $${r.balance}`);
    });

    console.log("\n--- Resolving market: YES ---\n");
    await fetchJson(`${SERVER}/markets/${market.id}/resolve`, {
      method: "POST",
      body: JSON.stringify({ outcome: "YES" }),
    }).then(r => console.log("Resolved:", r.status, r.outcome));

    console.log("\n=== FULL TEST COMPLETE ===");
  } else {
    console.log("Usage: node test_market.js [seed|oracle|trade|full]");
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
