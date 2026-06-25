import { Connection, PublicKey } from '@solana/web3.js';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

// 1. Manually parse .env to avoid external dependencies
const envPath = path.resolve('.env');
if (fs.existsSync(envPath)) {
  const envConfig = fs.readFileSync(envPath, 'utf8');
  envConfig.split('\n').forEach(line => {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (match) {
      const key = match[1];
      let value = match[2] || '';
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  });
}

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.error('Supabase credentials missing in env');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);

const FEE_WALLET = '5xh9BFXqCgpUxGbf3QzADNze945aNSiVG9EFNa8vvb3u';
const RPC_URL = process.env.VITE_RPC_URL || 'https://api.mainnet-beta.solana.com';
const LAUNCH_DATE = new Date('2026-05-10T00:00:00Z');

const sleep = (ms) => new Promise(res => setTimeout(res, ms));

// Helper to fetch historical token prices from Coinbase API
const priceCache = {};
async function getHistoricalUSDPrice(symbol, dateStr) {
  const cacheKey = `${symbol}-${dateStr}`;
  if (priceCache[cacheKey]) return priceCache[cacheKey];

  if (symbol === 'USDC' || symbol === 'USDT') return 1.0;

  try {
    const url = `https://api.coinbase.com/v2/prices/${symbol}-USD/spot?date=${dateStr}`;
    const res = await fetch(url);
    const json = await res.json();
    const price = parseFloat(json?.data?.amount);
    if (price > 0) {
      priceCache[cacheKey] = price;
      return price;
    }
  } catch (e) {
    console.warn(`Failed to fetch historical price for ${symbol} on ${dateStr}:`, e.message);
  }

  // Fallbacks
  const fallbacks = { SOL: 72.70, BONK: 0.0000185, JUP: 0.72, WIF: 1.82 };
  return fallbacks[symbol] || 0;
}

async function main() {
  const connection = new Connection(RPC_URL, 'confirmed');
  const feePubkey = new PublicKey(FEE_WALLET);

  console.log('--- STARTING SOLANA ON-CHAIN MEMO SYNC ---');
  console.log(`Connecting to Solana RPC: ${RPC_URL}`);

  // Step 1: Scan fee wallet to identify all active user addresses
  console.log('\nStep 1: Scanning fee wallet history to discover user addresses...');
  const userWallets = new Set([
    '8oXUkSqybMEgQLUBVikYeW1j2GYGssYkGrE3T8yfEmLL',
    '9tbQcuteHcu2jA3NKGrLRQEkowYE7eMWxF4vcMitpgqm',
    '227pM3q9NxC1GktXLyP4WiVF3qcx9RFfgQoBLFi3N3jV',
    'F4CDHF5ksEWXWY8csUvcGHL2ewX4WbEZVEYCqEvP3XGg',
    '3K9tyXQtT13zJNTJsWYqPXzKhKYf5wA94DFwKDgE6ANc',
    'EHjVvBtRwrqichJfczhS75UaGM18YE7yK5yX25jqkUN6',
    'D2CKUBrTWD11yspNzv596NUhGNq3eTMhHukmwo8JXiRV',
    '6XRKqfP7VxLjzi2fFdTp7HEHkTM5hsXQJC1e918gSCWA',
    'BtaNkxAEFn7mopZBg7771NkRiE3cCgnthH7BHetJAc4X',
    'AYBeVQXtrvxd3FPEQdN9RCPFkFWMtmEViPV2o4Uj2tSw',
    '7aJFUekvXJErfT211xEywH4SutigGtg5ECGegthuWxMf'
  ]);

  let before = undefined;
  let reachedLaunch = false;
  let feeSigs = [];

  while (!reachedLaunch) {
    const sigs = await connection.getSignaturesForAddress(feePubkey, { limit: 100, before });
    if (sigs.length === 0) break;

    for (const s of sigs) {
      const txDate = s.blockTime ? new Date(s.blockTime * 1000) : null;
      if (txDate && txDate < LAUNCH_DATE) {
        reachedLaunch = true;
        break;
      }
      feeSigs.push(s.signature);
    }
    if (reachedLaunch) break;
    before = sigs[sigs.length - 1].signature;
    await sleep(200);
  }

  console.log(`Scanning ${feeSigs.length} fee signatures...`);
  for (let i = 0; i < feeSigs.length; i++) {
    const sig = feeSigs[i];
    try {
      const tx = await connection.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 });
      if (!tx || !tx.meta) continue;

      let memoText = '';
      const checkMemo = (ix) => {
        if (ix.programId.toBase58() === 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr') {
          memoText = ix.parsed || String(ix.data || '');
        }
      };
      tx.transaction.message.instructions.forEach(checkMemo);
      if (tx.meta.innerInstructions) {
        tx.meta.innerInstructions.forEach(inner => inner.instructions.forEach(checkMemo));
      }

      if (memoText.includes('fiatwallet:')) {
        // Find fee payer or system transfer source
        let sender = '';
        tx.transaction.message.instructions.forEach(ix => {
          if (ix.program === 'system' && ix.parsed?.type === 'transfer') {
            if (ix.parsed.info.destination === FEE_WALLET) {
              sender = ix.parsed.info.source;
            }
          }
        });
        if (sender) userWallets.add(sender);
      }
    } catch (e) {
      // console.warn(`Error scanning fee sig ${sig}:`, e.message);
    }
  }

  console.log(`Discovered ${userWallets.size} unique user addresses:`, Array.from(userWallets));

  // Step 2: Scan each user wallet for transactions with the memo tag
  console.log('\nStep 2: Scanning user wallets for transactions with the memo program...');
  let totalImported = 0;

  for (const wallet of userWallets) {
    console.log(`Scanning wallet: ${wallet}...`);
    const pubkey = new PublicKey(wallet);
    let userBefore = undefined;
    let userReachedLaunch = false;
    let candidates = [];

    while (!userReachedLaunch) {
      const sigs = await connection.getSignaturesForAddress(pubkey, { limit: 100, before: userBefore });
      if (sigs.length === 0) break;

      for (const s of sigs) {
        const txDate = s.blockTime ? new Date(s.blockTime * 1000) : null;
        if (s.err || (txDate && txDate < LAUNCH_DATE)) {
          userReachedLaunch = true;
          break;
        }
        candidates.push(s);
      }
      if (userReachedLaunch) break;
      userBefore = sigs[sigs.length - 1].signature;
      await sleep(200);
    }

    console.log(`- Found ${candidates.length} transactions since launch. Checking for memos...`);

    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      try {
        const tx = await connection.getParsedTransaction(c.signature, { maxSupportedTransactionVersion: 0 });
        if (!tx || !tx.meta || tx.meta.err) continue;

        let memoText = '';
        const checkMemo = (ix) => {
          if (ix.programId.toBase58() === 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr') {
            memoText = ix.parsed || String(ix.data || '');
          }
        };
        tx.transaction.message.instructions.forEach(checkMemo);
        if (tx.meta.innerInstructions) {
          tx.meta.innerInstructions.forEach(inner => inner.instructions.forEach(checkMemo));
        }

        if (memoText.includes('fiatwallet:')) {
          const dateStr = c.blockTime 
            ? new Date(c.blockTime * 1000).toISOString().split('T')[0]
            : new Date().toISOString().split('T')[0];
          const fullTimestamp = c.blockTime
            ? new Date(c.blockTime * 1000).toISOString()
            : new Date().toISOString();

          let type = '';
          let symbol = 'SOL';
          let amount = 0;

          if (memoText.includes('send:')) {
            const parts = memoText.split(':');
            type = 'send';
            symbol = parts[2] || 'SOL';
            amount = parseFloat(parts[3]) || 0;
          } else if (memoText.includes('bulk_send:')) {
            const parts = memoText.split(':');
            type = 'bulk_send';
            symbol = parts[2] || 'SOL';
            amount = parseFloat(parts[3]) || 0;
          } else if (memoText.includes('swap:')) {
            const parts = memoText.split(':');
            type = 'swap';
            symbol = parts[2] || 'SOL';
            amount = parseFloat(parts[3]) || 0;
          } else if (memoText.includes('Receive') && memoText.includes('accounts')) {
            type = 'rent_claim';
            const match = memoText.match(/Receive ([\d.]+) SOL/);
            amount = match ? parseFloat(match[1]) : 0;
          } else if (memoText.includes('Receive') && memoText.includes('cashback')) {
            type = 'cashback_claim';
            const match = memoText.match(/Receive ([\d.]+) SOL/);
            amount = match ? parseFloat(match[1]) : 0;
          } else if (memoText.includes('pajcash:offramp:')) {
            type = 'p2p_offramp';
            const parts = memoText.split(':');
            symbol = 'USDC';
            amount = 0;
            // order id is parts[3] — stored in transaction_type metadata via p2p_transactions table
          }

          if (type) {
            const price = await getHistoricalUSDPrice(symbol, dateStr);
            const usdValue = amount * price;

            const { error } = await supabase
              .from('transactions')
              .upsert({
                signature: c.signature,
                user_address: wallet,
                transaction_type: type,
                token_symbol: symbol,
                token_amount: amount,
                usd_value: parseFloat(usdValue.toFixed(2)),
                created_at: fullTimestamp
              }, { onConflict: 'signature' });

            if (type === 'p2p_offramp') {
              const orderId = memoText.split(':')[3] || 'unknown';
              await supabase.from('p2p_transactions').upsert({
                signature: c.signature,
                user_address: wallet,
                order_id: orderId,
                transaction_type: 'p2p_offramp',
                token_symbol: symbol,
                crypto_amount: amount,
                fiat_currency: 'NGN',
                fiat_amount: 0,
                usd_value: parseFloat(usdValue.toFixed(2)),
                status: 'COMPLETED',
                created_at: fullTimestamp,
                updated_at: fullTimestamp,
              }, { onConflict: 'signature' });
            }

            if (error) {
              console.error(`- Error importing signature ${c.signature}:`, error.message);
            } else {
              console.log(`  [IMPORTED] ${type} | ${amount} ${symbol} ($${usdValue.toFixed(2)}) | ${c.signature.slice(0, 8)}...`);
              totalImported++;
            }
          }
        }
      } catch (err) {
        // console.warn(`- Error parsing signature ${c.signature}:`, err.message);
      }
      await sleep(100);
    }
  }

  console.log(`\n✅ Sync Completed! Imported/synced a total of ${totalImported} new transactions from on-chain memos.`);
}

main().catch(console.error);
