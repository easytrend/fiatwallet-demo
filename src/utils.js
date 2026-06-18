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

// Removed hardcoded Helius API key — credential leak.
// Only free, keyless public endpoints remain.
export const RPC_LIST = [
  "https://api.mainnet-beta.solana.com",
  "https://rpc.ankr.com/solana",
  "https://solana-rpc.publicnode.com",
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
      
      return j.result;
    } catch(e) {
      
      errors.push(url.split("/")[2] + ": " + e.message);
    }
  }
  throw new Error("All RPC nodes failed:\n" + errors.join("\n"));
}

// robustResolve accepts an optional wallet-adapter `connection` and tries it
// first before falling back to the internal RPC list. The fallback to public
// RPCs is ONLY used when no connection object is passed (e.g. during bulk CSV
// import preview before a wallet is connected). If a connection IS provided
// but fails, we throw immediately — silently routing the query through Ankr or
// PublicNode would leak domain lookups for users who configured a private RPC.
export async function robustResolve(domain, walletConnection) {
  // Try the wallet-adapter connection first (trusted, user-configured endpoint)
  if (walletConnection) {
    try {
      const addr = await Promise.race([
        resolve(walletConnection, domain),
        new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout')), 6000))
      ]);
      if (addr) return addr;
    } catch (e) {
      // A walletConnection was provided but failed — do NOT fall back to public
      // RPCs. Doing so would expose the domain query to third-party infrastructure
      // for users who deliberately configured a private endpoint.
      throw new Error(`Failed to resolve domain: ${domain}`);
    }
  }

  // No walletConnection available — fall back to public RPCs.
  // This path is taken during bulk CSV import preview only.
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
      
    }
  }
  throw new Error(`Failed to resolve domain: ${domain}`);
}

export async function robustReverseLookup(connection, publicKeyObj) {
  // Use only the provided connection. Do not fall back to public RPC endpoints
  // for reverse lookups — the wallet address being looked up is sensitive; leaking
  // it to Ankr/PublicNode undermines users who configured a private RPC for privacy.
  try {
    const primary = await getPrimaryDomain(connection, publicKeyObj).catch(() => null);
    if (primary && primary.reverse) return primary.reverse + '.sol';
    const reverse = await performReverseLookup(connection, publicKeyObj).catch(() => null);
    if (reverse) return reverse + '.sol';
  } catch (e) {
    
  }
  return null;
}
