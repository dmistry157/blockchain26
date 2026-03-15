import { createHash } from "crypto";
import rippleKeypairs from "ripple-keypairs";

function canonicalOrderPayload(order) {
  const payload = {
    amount: String(order.amount),
    expiry: String(order.expiry),
    maker: order.maker,
    marketId: order.marketId,
    nonce: order.nonce,
    price: String(order.price),
    side: order.side,
    type: order.type || "LIMIT",
  };
  return JSON.stringify(payload, Object.keys(payload).sort());
}

function hashOrderPayload(order) {
  const canonical = canonicalOrderPayload(order);
  return createHash("sha512").update(canonical).digest("hex").toUpperCase();
}

export function signOrder(order, privateKey) {
  const hash = hashOrderPayload(order);
  return rippleKeypairs.sign(hash, privateKey);
}

export function verifyOrderSignature(order, publicKey) {
  const hash = hashOrderPayload(order);
  try {
    return rippleKeypairs.verify(hash, order.signature, publicKey);
  } catch {
    return false;
  }
}

export function deriveAddress(publicKey) {
  return rippleKeypairs.deriveAddress(publicKey);
}

export function createSignedOrder({ marketId, side, price, amount, maker, expiry, nonce, privateKey, orderSide }) {
  if (price <= 0 || price >= 1) throw new Error("Price must be between 0 and 1 (exclusive) for binary markets");
  if (amount <= 0) throw new Error("Amount must be positive");
  if (!["YES", "NO"].includes(side)) throw new Error("Side must be YES or NO");

  const order = { marketId, side, type: "LIMIT", price, amount, maker, expiry, nonce, orderSide: orderSide || "BUY" };
  order.signature = signOrder(order, privateKey);
  return order;
}
