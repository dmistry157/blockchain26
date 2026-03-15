import xrpl from "xrpl";
import config from "../config.js";

let client = null;

export async function getClient() {
  if (client && client.isConnected()) return client;
  client = new xrpl.Client(config.xrpl.wssUrl);
  await client.connect();
  return client;
}

export async function disconnect() {
  if (client && client.isConnected()) {
    await client.disconnect();
    client = null;
  }
}

export async function fundTestnetWallet() {
  const c = await getClient();
  const { wallet } = await c.fundWallet();
  return wallet;
}

export function walletFromSecret(secret) {
  return xrpl.Wallet.fromSecret(secret);
}

export async function submitAndWait(tx, wallet) {
  const c = await getClient();
  const prepared = await c.autofill(tx);
  const signed = wallet.sign(prepared);
  const result = await c.submitAndWait(signed.tx_blob);
  return result;
}

export async function getAccountInfo(address) {
  const c = await getClient();
  return c.request({ command: "account_info", account: address });
}

export async function getAccountLines(address) {
  const c = await getClient();
  return c.request({ command: "account_lines", account: address });
}
