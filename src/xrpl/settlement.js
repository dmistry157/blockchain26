import { submitAndWait } from "./client.js";
import { marketCurrencyCodes } from "./tokens.js";

export async function transferTokens(senderWallet, recipientAddress, issuerAddress, currencyCode, amount) {
  const tx = {
    TransactionType: "Payment",
    Account: senderWallet.address,
    Destination: recipientAddress,
    Amount: {
      currency: currencyCode,
      issuer: issuerAddress,
      value: String(amount),
    },
  };
  return submitAndWait(tx, senderWallet);
}

export async function transferXRP(senderWallet, recipientAddress, dropsAmount) {
  const tx = {
    TransactionType: "Payment",
    Account: senderWallet.address,
    Destination: recipientAddress,
    Amount: String(dropsAmount),
  };
  return submitAndWait(tx, senderWallet);
}

export async function settleMatchedTrade({ sellerWallet, buyerWallet, issuerAddress, marketId, side, amount, pricePerToken }) {
  const codes = marketCurrencyCodes(marketId);
  const currencyCode = side === "YES" ? codes.yes : codes.no;
  const totalXrpDrops = Math.floor(pricePerToken * amount * 1_000_000);

  const tokenTransferResult = await transferTokens(
    sellerWallet, buyerWallet.address, issuerAddress, currencyCode, amount
  );
  const xrpTransferResult = await transferXRP(buyerWallet, sellerWallet.address, totalXrpDrops);

  return {
    tokenTransfer: tokenTransferResult,
    xrpTransfer: xrpTransferResult,
    summary: { seller: sellerWallet.address, buyer: buyerWallet.address, side, amount, pricePerToken, totalXRP: pricePerToken * amount },
  };
}

export async function redeemWinningTokens(issuerWallet, holderWallet, marketId, winningSide, amount) {
  const codes = marketCurrencyCodes(marketId);
  const currencyCode = winningSide === "YES" ? codes.yes : codes.no;

  const burnResult = await transferTokens(holderWallet, issuerWallet.address, issuerWallet.address, currencyCode, amount);
  const xrpDrops = amount * 1_000_000;
  const payoutResult = await transferXRP(issuerWallet, holderWallet.address, xrpDrops);

  return { burnResult, payoutResult };
}
