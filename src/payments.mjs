import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { root, directory, list, readJSON, writeJSON } from "./state.mjs";
import { amount, units, budget } from "./budget.mjs";

const rpc = "https://rpc.tempo.xyz";
const token = "0x20c000000000000000000000b9537d11c60e8b50";
const transfer = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const hashPattern = /^0x[a-f0-9]{64}$/i;

export function paymentReference(meta) {
  const header = Object.entries(meta?.headers || {}).find(([key]) => key.toLowerCase() === "payment-receipt")?.[1];
  if (!header) return null;
  try {
    const value = JSON.parse(Buffer.from(Array.isArray(header) ? header[0] : header, "base64url").toString("utf8"));
    return value.method === "tempo" && value.status === "success" && hashPattern.test(value.reference || "")
      ? { hash: value.reference.toLowerCase(), timestamp: value.timestamp } : null;
  } catch { return null; }
}

async function call(method, params, signal) {
  const response = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), redirect: "error",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Payment lookup HTTP ${response.status}.`);
  const value = await response.json();
  if (value.error) throw new Error("Payment lookup failed; saved evidence is unchanged.");
  return value.result;
}

export function receiptOutflow(receipt, hash) {
  if (receipt?.transactionHash?.toLowerCase() !== hash || receipt.status !== "0x1" ||
    !/^0x[a-f0-9]{40}$/i.test(receipt.from || "") || !Array.isArray(receipt.logs)) return null;
  const sender = receipt.from.toLowerCase();
  let paid = 0n;
  for (const log of receipt.logs) {
    if (log.removed || log.address?.toLowerCase() !== token || log.topics?.[0]?.toLowerCase() !== transfer) continue;
    if (log.topics.length !== 3 || !log.topics.every((topic) => hashPattern.test(topic)) || !hashPattern.test(log.data || "")) return null;
    if ("0x" + log.topics[1].slice(-40).toLowerCase() === sender) paid += BigInt(log.data);
  }
  // Count only canonical Transfer logs, not the duplicate TransferWithMemo.
  // This is sender USDC.e outflow, including same-token fees, not net spend
  // across other assets or a promise that every transaction has a single payee.
  return amount(paid);
}

export async function spending({ refresh = false, signal } = {}) {
  const states = await list(), transactions = new Map(), unknownWorkspaces = new Set();
  let unresolvedRequests = 0, unreadableRecords = 0;
  for (const state of states) {
    const dir = join(directory(state.name), "requests");
    let files;
    try { files = await readdir(dir); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    for (const file of files.filter((file) => /^[a-f0-9-]{36}\.json$/.test(file))) {
      let intent, meta;
      try { intent = await readJSON(join(dir, file)); meta = await readJSON(join(dir, file.replace(".json", ".meta.json"))); }
      catch { unreadableRecords++; unknownWorkspaces.add(state.name); continue; }
      if (intent.maximum === "0") continue;
      const receipt = paymentReference(meta);
      if (!receipt) { unresolvedRequests++; unknownWorkspaces.add(state.name); continue; }
      const previous = transactions.get(receipt.hash);
      if (previous) {
        previous.workspaces = [...new Set([...previous.workspaces, state.name])];
        continue;
      }
      transactions.set(receipt.hash, { ...receipt, workspaces: [state.name], operation: intent.operation,
        explorer: `https://explore.tempo.xyz/tx/${receipt.hash}` });
    }
  }
  let refreshError;
  if (refresh) {
    try {
      if (await call("eth_chainId", [], signal) !== "0x1079") throw new Error("Payment lookup returned a different chain.");
      for (const transaction of transactions.values()) {
        const path = join(root, ".payments", transaction.hash + ".json");
        if (await readJSON(path)) continue;
        signal?.throwIfAborted();
        const receipt = await call("eth_getTransactionReceipt", [transaction.hash], signal);
        const paid = receiptOutflow(receipt, transaction.hash);
        if (paid !== null) await writeJSON(path, { hash: transaction.hash, paid, verifiedAt: new Date().toISOString() });
      }
    } catch (error) { refreshError = error.message; }
  }
  let paid = 0n, verified = 0;
  for (const transaction of transactions.values()) {
    const cached = await readJSON(join(root, ".payments", transaction.hash + ".json"));
    if (cached?.hash === transaction.hash && cached.verifiedAt) {
      paid += units(cached.paid); verified++;
      transaction.paid = cached.paid; transaction.verifiedAt = cached.verifiedAt;
    } else transaction.paid = null;
  }
  const ledger = await readJSON(join(root, ".budget.json"));
  return { currency: "USDC.e", paid: amount(paid), verifiedTransactions: verified,
    pendingVerification: transactions.size - verified, unresolvedRequests, unreadableRecords, unknownWorkspaces: [...unknownWorkspaces],
    basis: "Verified sender USDC.e outflow from recorded payment transactions, including fees in that token. Other assets and later refunds excluded. Missing receipts are unknown, not zero. Shared transactions are counted once.",
    budget: ledger ? await budget() : null, refreshError,
    transactions: [...transactions.values()].sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || ""))) };
}
