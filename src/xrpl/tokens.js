import { submitAndWait } from "./client.js";

export function encodeHexCurrency(name) {
  const hex = Buffer.from(name, "utf8").toString("hex").toUpperCase();
  if (hex.length > 40) throw new Error("Currency name too long (max 20 bytes)");
  return hex.padEnd(40, "0");
}

export function decodeHexCurrency(hex) {
  const trimmed = hex.replace(/(00)+$/, "");
  return Buffer.from(trimmed, "hex").toString("utf8");
}

export function marketCurrencyCodes(marketId) {
  const shortId = marketId.slice(0, 8);
  return {
    yes: encodeHexCurrency(`Y_${shortId}`),
    no: encodeHexCurrency(`N_${shortId}`),
  };
}

export async function enableDefaultRipple(issuerWallet) {
  const tx = {
    TransactionType: "AccountSet",
    Account: issuerWallet.address,
    SetFlag: 8,
  };
  return submitAndWait(tx, issuerWallet);
}

export async function createTrustLine(userWallet, issuerAddress, currencyCode, limit = "1000000") {
  const tx = {
    TransactionType: "TrustSet",
    Account: userWallet.address,
    LimitAmount: {
      currency: currencyCode,
      issuer: issuerAddress,
      value: limit,
    },
  };
  return submitAndWait(tx, userWallet);
}

export async function mintTokens(issuerWallet, destinationAddress, currencyCode, amount) {
  const tx = {
    TransactionType: "Payment",
    Account: issuerWallet.address,
    Destination: destinationAddress,
    Amount: {
      currency: currencyCode,
      issuer: issuerWallet.address,
      value: String(amount),
    },
  };
  return submitAndWait(tx, issuerWallet);
}

export async function mintCompleteSet(issuerWallet, destinationAddress, marketId, amount) {
  const codes = marketCurrencyCodes(marketId);
  const yesResult = await mintTokens(issuerWallet, destinationAddress, codes.yes, amount);
  const noResult = await mintTokens(issuerWallet, destinationAddress, codes.no, amount);
  return { yesResult, noResult };
}

export async function burnTokens(userWallet, issuerAddress, currencyCode, amount) {
  const tx = {
    TransactionType: "Payment",
    Account: userWallet.address,
    Destination: issuerAddress,
    Amount: {
      currency: currencyCode,
      issuer: issuerAddress,
      value: String(amount),
    },
  };
  return submitAndWait(tx, userWallet);
}
