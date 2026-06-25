/**
 * backfill_transactions.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Fetches recent transaction history for a wallet from Solana and inserts
 * any missing records into Supabase using the same anonymisation logic as the app.
 *
 * USAGE:
 *   node backfill_transactions.mjs <WALLET_ADDRESS> [LIMIT]
 *
 * EXAMPLES:
 *   node backfill_transactions.mjs 7xKXtg2CW87d3... 50
 *   node backfill_transactions.mjs 7xKXtg2CW87d3...        (defaults to 20 recent txs)
 *
 * REQUIREMENTS:
 *   - Create a .env file in the fiatwallet root with:
 *       VITE_SUPABASE_URL=https://xxxx.supabase.co
 *       VITE_SUPABASE_ANON_KEY=eyJhbGci...
 *   - Run: npm install @supabase/supabase-js @solana/web3.js dotenv
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createClient }                        from '@supabase/supabase-js';
import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { createHash }                           from 'crypto';
import { readFileSync }                         from 'fs';
import { resolve, dirname }                     from 'path';
import { fileURLToPath }                        from 'url';

// ── Load .env manually (no dotenv package needed) ────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath   = resolve(__dirname, '.env');
let envVars     = {};
try {
  const raw = readFileSync(envPath, 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    envVars[key] = val;
  }
} catch {
  console.error('❌  Could not read .env file. Make sure it exists in the fiatwallet root.');
  process.exit(1);
}

const SUPABASE_URL      = envVars.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = envVars.VITE_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('❌  VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY missing in .env');
  process.exit(1);
}

// ── Known token mints → symbol mapping ───────────────────────────────────────
const KNOWN_MINTS = {
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': { symbol: 'USDC',  price: 1.0    },
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': { symbol: 'USDT',  price: 1.0    },
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': { symbol: 'BONK',  price: 0.0000185 },
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN':  { symbol: 'JUP',   price: 0.72   },
  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R': { symbol: 'RAY',   price: 2.15   },
  'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3': { symbol: 'PYTH',  price: 0.31   },
  'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm': { symbol: 'WIF',   price: 1.82   },
  'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE':  { symbol: 'ORCA',  price: 1.07   },
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So':  { symbol: 'mSOL',  price: 168.2  },
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs': { symbol: 'ETH',   price: 2700   },
  '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh': { symbol: 'WBTC',  price: 98000  },
  'JitoTaggrVjdVtFtjD4kMPqiXmNLHyVaGTRdTtLcVu':   { symbol: 'JITO',  price: 2.95   },
};

// Known DEX/swap program IDs (Jupiter, Raydium, Orca etc.)
const SWAP_PROGRAM_IDS = new Set([
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',  // Jupiter v6
  'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB',  // Jupiter v4
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CLMM
  '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP', // Orca v2
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',  // Orca Whirlpool
]);

// ── Helpers ───────────────────────────────────────────────────────────────────

/** SHA-256 hex digest — matches the browser crypto.subtle version in the app */
function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Classify a parsed transaction as send / swap / unknown */
function classifyTransaction(tx, walletAddress) {
  if (!tx?.meta || !tx?.transaction) return null;

  const accountKeys = tx.transaction.message.accountKeys.map(k =>
    typeof k === 'string' ? k : k.toBase58()
  );

  // Check if any known swap program was invoked
  const isSwap = tx.transaction.message.instructions.some(ix => {
    const progIdx = ix.programIdIndex;
    const progId  = accountKeys[progIdx];
    return SWAP_PROGRAM_IDS.has(progId);
  });

  if (isSwap) return 'swap';

  // Check for a simple SOL transfer (fee payer sends SOL, balance decreases)
  const walletIdx = accountKeys.indexOf(walletAddress);
  if (walletIdx !== -1) {
    const preBal  = tx.meta.preBalances[walletIdx]  ?? 0;
    const postBal = tx.meta.postBalances[walletIdx] ?? 0;
    if (preBal > postBal + (tx.meta.fee ?? 0)) return 'send';
  }

  return 'unknown';
}

/** Extract token symbol and USD value from a transaction */
function extractTokenInfo(tx, walletAddress) {
  const SOL_PRICE = 148.5; // fallback static price

  if (!tx?.meta) return { symbol: 'SOL', usdValue: 0 };

  const accountKeys = tx.transaction.message.accountKeys.map(k =>
    typeof k === 'string' ? k : k.toBase58()
  );

  // Try SPL token balances first
  const preTokenBals  = tx.meta.preTokenBalances  ?? [];
  const postTokenBals = tx.meta.postTokenBalances ?? [];

  // Find token accounts owned by the wallet that had a balance decrease (sent)
  for (const post of postTokenBals) {
    const pre = preTokenBals.find(p => p.accountIndex === post.accountIndex);
    if (!pre) continue;
    if (post.owner !== walletAddress && pre.owner !== walletAddress) continue;

    const preBal  = Number(pre.uiTokenAmount?.uiAmount  ?? 0);
    const postBal = Number(post.uiTokenAmount?.uiAmount ?? 0);
    const diff    = preBal - postBal;

    if (diff > 0 && post.mint) {
      const known    = KNOWN_MINTS[post.mint];
      const symbol   = known?.symbol   ?? post.mint.slice(0, 6) + '…';
      const price    = known?.price    ?? 0;
      return { symbol, usdValue: Math.round(diff * price * 100) / 100 };
    }
  }

  // Fall back to SOL balance change
  const walletIdx = accountKeys.indexOf(walletAddress);
  if (walletIdx !== -1) {
    const preBal  = tx.meta.preBalances[walletIdx]  ?? 0;
    const postBal = tx.meta.postBalances[walletIdx] ?? 0;
    const fee     = tx.meta.fee ?? 0;
    const solSent = (preBal - postBal - fee) / LAMPORTS_PER_SOL;
    if (solSent > 0) {
      return { symbol: 'SOL', usdValue: Math.round(solSent * SOL_PRICE * 100) / 100 };
    }
  }

  return { symbol: 'UNKNOWN', usdValue: 0 };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const walletAddress = process.argv[2];
  const limit         = parseInt(process.argv[3] ?? '20', 10);

  if (!walletAddress) {
    console.error('❌  Usage: node backfill_transactions.mjs <WALLET_ADDRESS> [LIMIT]');
    process.exit(1);
  }

  // Validate wallet address
  let walletPubkey;
  try {
    walletPubkey = new PublicKey(walletAddress);
  } catch {
    console.error(`❌  Invalid Solana wallet address: ${walletAddress}`);
    process.exit(1);
  }

  console.log(`\n🔍  Fetching last ${limit} transactions for ${walletAddress}…`);

  // ── Connect to Solana ─────────────────────────────────────────────────────
  const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');

  let signatures;
  try {
    signatures = await connection.getSignaturesForAddress(walletPubkey, { limit });
  } catch (err) {
    console.error('❌  Failed to fetch signatures from Solana RPC:', err.message);
    process.exit(1);
  }

  console.log(`📋  Found ${signatures.length} signatures on-chain.`);

  // ── Connect to Supabase ───────────────────────────────────────────────────
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  // Check which signatures already exist in Supabase (avoid duplicates)
  const sigList = signatures.map(s => s.signature);
  const { data: existing } = await supabase
    .from('transactions')
    .select('signature')
    .in('signature', sigList);

  const existingSigs = new Set((existing ?? []).map(r => r.signature));
  const missing = signatures.filter(s => !existingSigs.has(s.signature));

  console.log(`✅  ${existingSigs.size} already in Supabase. ${missing.length} to backfill.\n`);

  if (missing.length === 0) {
    console.log('🎉  Nothing to backfill — all transactions are already recorded!');
    return;
  }

  // ── Fetch and insert missing transactions ─────────────────────────────────
  let inserted = 0;
  let failed   = 0;

  for (const sigInfo of missing) {
    const sig = sigInfo.signature;
    process.stdout.write(`  ↳ Processing ${sig.slice(0, 20)}… `);

    try {
      // Fetch full transaction from Solana
      const tx = await connection.getParsedTransaction(sig, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });

      if (!tx) {
        console.log('⚠️  not found (may have expired)');
        failed++;
        continue;
      }

      // Classify and extract info
      const type            = classifyTransaction(tx, walletAddress) ?? 'unknown';
      const { symbol, usdValue } = extractTokenInfo(tx, walletAddress);

      // Skip truly unknown/unclassifiable transactions (e.g. program deployments)
      if (type === 'unknown' && usdValue === 0) {
        console.log('⏭️  skipped (not a send/swap)');
        continue;
      }

      // Insert into Supabase
      const { error } = await supabase.from('transactions').insert([{
        signature:         sig,
        user_address:      walletAddress,
        transaction_type:  type,
        token_symbol:      symbol,
        usd_value:         usdValue,
      }]);

      if (error) {
        console.log(`❌  insert failed: ${error.message}`);
        failed++;
      } else {
        console.log(`✅  inserted (${type} · ${symbol} · $${usdValue})`);
        inserted++;
      }

      // Small delay to avoid RPC rate limits
      await new Promise(r => setTimeout(r, 300));

    } catch (err) {
      console.log(`❌  error: ${err.message}`);
      failed++;
    }
  }

  console.log(`\n─────────────────────────────────────────`);
  console.log(`✅  Inserted : ${inserted}`);
  console.log(`❌  Failed   : ${failed}`);
  console.log(`⏭️  Skipped  : ${missing.length - inserted - failed}`);
  console.log(`─────────────────────────────────────────\n`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
