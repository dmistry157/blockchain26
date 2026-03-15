import { ClobClient } from "@polymarket/clob-client";

const AMOY_RPC = "https://polygon-amoy.infura.io/v3/your-infura-key";
const CHAIN_ID = 80002; // Polygon Amoy testnet

const PRIVATE_KEY = process.env.POLY_PRIVATE_KEY;
if (!PRIVATE_KEY) {
  throw new Error("POLY_PRIVATE_KEY environment variable is required");
}

const clobClient = new ClobClient(
  "https://clob.polymarket.com",
  CHAIN_ID,
  undefined,
  { key: PRIVATE_KEY }
);

/**
 * Place a small bid/ask spread around the current probability to provide liquidity.
 */
export async function provideLiquidity(
  marketTokenId: string,
  currentProbability: number
): Promise<void> {
  const spread = 0.02;
  const size = 5; // small order size in USDC

  const bidPrice = Math.max(0.01, currentProbability - spread);
  const askPrice = Math.min(0.99, currentProbability + spread);

  const bidOrder = await clobClient.createAndPostOrder({
    tokenID: marketTokenId,
    price: bidPrice,
    side: "BUY",
    size,
  });
  console.log(`[AMM] Bid placed at ${bidPrice}:`, bidOrder);

  const askOrder = await clobClient.createAndPostOrder({
    tokenID: marketTokenId,
    price: askPrice,
    side: "SELL",
    size,
  });
  console.log(`[AMM] Ask placed at ${askPrice}:`, askOrder);
}

/**
 * Express route handler for POST /trigger-micro-market.
 * Import this in server.js and wire it up.
 */
export async function handleTriggerMicroMarket(
  req: { body: { event?: string; tokenId?: string; probability?: number } },
  res: { json: (data: unknown) => void; status: (code: number) => { json: (data: unknown) => void } }
): Promise<void> {
  const { event, tokenId, probability } = req.body;

  if (!event) {
    res.status(400).json({ error: "event is required" });
    return;
  }

  // Hardcoded testnet market token ID — replace with real one
  const marketTokenId = tokenId || "0x1234567890abcdef1234567890abcdef12345678";
  const prob = probability || 0.5;

  try {
    await provideLiquidity(marketTokenId, prob);
    res.json({ success: true, event, marketTokenId, probability: prob });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
}
