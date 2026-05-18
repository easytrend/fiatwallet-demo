import { Connection, PublicKey } from '@solana/web3.js';
import { resolve, getPrimaryDomain, performReverseLookup } from '@bonfida/spl-name-service';

export function fmtRate(r) {
  if (r >= 10000) return r.toLocaleString(undefined, { maximumFractionDigits:0 });
  if (r >= 1)     return r.toFixed(2);
  if (r >= 0.01)  return r.toFixed(4);
  return r.toFixed(6);
}

export function fmtTok(v) {
  if (!v || isNaN(v)) return "0";
  if (v < 0.0001) return v.toFixed(8);
  if (v < 1)      return v.toFixed(4);
  return v.toFixed(3);
}

export function fmtFiat(v, code) {
  if (!v || isNaN(v)) return "0.00 " + code;
  if (v < 0.01) return v.toFixed(6) + " " + code;
  return v.toFixed(2) + " " + code;
}


// Validates a Solana address or .sol domain from a CSV row
export function isValidEntry(domain) {
  if (!domain || domain.length < 3) return false;
  // .sol domains: must end with .sol and have at least one character before it
  if (domain.endsWith('.sol')) return domain.length > 4;
  // Solana public keys: base58, always exactly 32–44 characters
  if (domain.length < 32 || domain.length > 44) return false;
  // Must only contain base58 characters (no 0, O, I, l)
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(domain);
}

export function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  let start = 0;
  if (lines[0] && isNaN(parseFloat(lines[0].split(/[,\t]/)[1]))) start = 1;
  return lines.slice(start).map((line, i) => {
    const p = line.split(/[,\t]/);
    const domain = (p[0] || "").trim();
    const amt = parseFloat((p[1] || "").trim());
    return { id: Date.now() + i + Math.random(), domain, amount: isNaN(amt) ? "" : String(amt), valid: isValidEntry(domain) };
  }).filter(r => r.domain);
}

export function dlTemplate() {
  const csv = "wallet_or_domain,amount\n";
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type:"text/csv" }));
  a.download = "bulk-send-template.csv";
  a.click();
}

export const RPC_LIST = [
  "https://solana-mainnet.g.alchemy.com/v2/demo",
  "https://rpc.ankr.com/solana",
  "https://mainnet.helius-rpc.com/?api-key=15319bf8-35b6-4a2c-aa8b-09c1e7f6b5a0",
  "https://api.mainnet-beta.solana.com",
];

export async function rpcFetch(method, params) {
  const errors = [];
  for (const url of RPC_LIST) {
    try {
      const r = await fetch(url, {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({ jsonrpc:"2.0", id:1, method, params })
      });
      if (!r.ok) throw new Error("HTTP " + r.status + " from " + url);
      const j = await r.json();
      if (j.error) throw new Error((j.error.message || JSON.stringify(j.error)) + " [" + url + "]");
      console.log("✅ RPC success via", url);
      return j.result;
    } catch(e) {
      console.warn("❌ RPC failed (" + url + "):", e.message);
      errors.push(url.split("/")[2] + ": " + e.message);
    }
  }
  throw new Error("All RPC nodes failed:\n" + errors.join("\n"));
}

export async function robustResolve(domain) {
  const RESOLVE_RPCS = [
    'https://api.mainnet-beta.solana.com',
    'https://rpc.ankr.com/solana',
    'https://solana-rpc.publicnode.com'
  ];
  for (const rpcUrl of RESOLVE_RPCS) {
    try {
      const conn = new Connection(rpcUrl);
      const addr = await Promise.race([
        resolve(conn, domain),
        new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout')), 4000))
      ]);
      if (addr) return addr;
    } catch (e) {
      console.warn(`Resolve failed on ${rpcUrl}:`, e.message);
    }
  }
  throw new Error(`Failed to resolve domain: ${domain}`);
}

export async function robustReverseLookup(publicKeyObj) {
  const RESOLVE_RPCS = [
    'https://api.mainnet-beta.solana.com',
    'https://rpc.ankr.com/solana',
    'https://solana-rpc.publicnode.com'
  ];
  for (const rpcUrl of RESOLVE_RPCS) {
    try {
      const conn = new Connection(rpcUrl);
      // Try Primary first as requested
      const primary = await getPrimaryDomain(conn, publicKeyObj).catch(() => null);
      if (primary && primary.reverse) return primary.reverse + '.sol';
      // Fallback to standard reverse
      const reverse = await performReverseLookup(conn, publicKeyObj).catch(() => null);
      if (reverse) return reverse + '.sol';
    } catch (e) {
      console.warn(`Reverse lookup failed on ${rpcUrl}:`, e.message);
    }
  }
  return null;
}
