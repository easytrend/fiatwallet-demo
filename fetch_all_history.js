import { Connection, PublicKey } from '@solana/web3.js';

const FEE_WALLET = '5xh9BFXqCgpUxGbf3QzADNze945aNSiVG9EFNa8vvb3u';
const JUP_PROGRAM_V6 = 'JUP6Lkb5fJLSqavAB2iqjyz6B91RPQ116uT551w1z37';
const JUP_PROGRAM_V5 = 'JUP5cPgoSLDbt7cnne52cmKy23rq3h47cca5K1ZsQ1rx';
const RPC_HISTORY_URL = 'https://api.mainnet-beta.solana.com';
const RPC_FETCH_URL = 'https://solana-rpc.publicnode.com';
const LAUNCH_DATE = new Date('2026-05-10T00:00:00Z');
const RPC_DELAY = 150;

// Helper to delay executions (avoid RPC 429)
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

// Helper for RPC calls with exponential backoff on 429
async function callRPC(fn, retries = 5, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (e.message && (e.message.includes('429') || e.message.includes('Too Many Requests'))) {
        console.warn(`[429 Rate Limit] Retrying in ${delay}ms...`);
        await sleep(delay);
        delay *= 2;
      } else {
        throw e;
      }
    }
  }
  throw new Error('Max retries exceeded on RPC call');
}

async function parseTransactionsInBatches(connectionFetch, connectionHistory, signatures, batchSize = 10) {
  const parsedResults = [];
  if (batchSize === 1) {
    for (let i = 0; i < signatures.length; i++) {
      const sigInfo = signatures[i];
      if (i % 50 === 0) {
        console.log(`Fetching transaction ${i}/${signatures.length}...`);
      }
      try {
        let tx = null;
        try {
          tx = await callRPC(() => connectionFetch.getParsedTransaction(
            sigInfo.signature,
            { maxSupportedTransactionVersion: 0 }
          ));
        } catch (e) {
          // If PublicNode fails or rate-limits, we fall back below
        }

        if (!tx) {
          console.log(`Transaction missing on PublicNode, falling back to official node: ${sigInfo.signature}`);
          try {
            tx = await callRPC(() => connectionHistory.getParsedTransaction(
              sigInfo.signature,
              { maxSupportedTransactionVersion: 0 }
            ));
          } catch (e) {
            console.error(`Fallback fetch failed: ${e.message}`);
          }
        }

        if (tx) {
          parsedResults.push({
            tx,
            sigInfo
          });
        }
      } catch (seqErr) {
        console.error(`Error parsing transaction: ${seqErr.message}`);
      }
      await sleep(RPC_DELAY);
    }
    return parsedResults;
  }

  for (let i = 0; i < signatures.length; i += batchSize) {
    const chunk = signatures.slice(i, i + batchSize);
    console.log(`Fetching batch of ${chunk.length} transactions (${i}/${signatures.length})...`);
    try {
      const txs = await callRPC(() => connection.getParsedTransactions(
        chunk.map(s => s.signature),
        { maxSupportedTransactionVersion: 0 }
      ));
      if (txs) {
        txs.forEach((tx, idx) => {
          if (tx) {
            parsedResults.push({
              tx,
              sigInfo: chunk[idx]
            });
          }
        });
      }
    } catch (e) {
      console.warn(`Batch fetch failed (${e.message}). Falling back to sequential fetching...`);
      for (const sigInfo of chunk) {
        try {
          const tx = await callRPC(() => connection.getParsedTransaction(
            sigInfo.signature,
            { maxSupportedTransactionVersion: 0 }
          ));
          if (tx) {
            parsedResults.push({
              tx,
              sigInfo
            });
          }
        } catch (seqErr) {
          console.error(`Error parsing transaction sequentially: ${seqErr.message}`);
        }
        await sleep(RPC_DELAY);
      }
    }
    await sleep(RPC_DELAY);
  }
  return parsedResults;
}

async function main() {
  const connectionHistory = new Connection(RPC_HISTORY_URL, 'confirmed');
  const connectionFetch = new Connection(RPC_FETCH_URL, 'confirmed');
  const feePubkey = new PublicKey(FEE_WALLET);

  console.log(`==================================================`);
  console.log(`STAGE 1: Scanning Fee Wallet to identify users...`);
  console.log(`==================================================`);

  let feeSignatures = [];
  let before = undefined;
  let reachedLaunch = false;

  while (!reachedLaunch) {
    const options = { limit: 100 };
    if (before) options.before = before;

    const signatures = await callRPC(() => connectionHistory.getSignaturesForAddress(feePubkey, options));
    if (signatures.length === 0) break;

    for (const sigInfo of signatures) {
      const txDate = sigInfo.blockTime ? new Date(sigInfo.blockTime * 1000) : null;
      if (txDate && txDate < LAUNCH_DATE) {
        reachedLaunch = true;
        break;
      }
      feeSignatures.push(sigInfo);
    }
    if (reachedLaunch) break;
    before = signatures[signatures.length - 1].signature;
  }

  console.log(`Found ${feeSignatures.length} claim/cashback signatures since launch.`);

  const uniqueUsers = new Set();
  const claimsData = [];

  // Parse fee signatures using batched helper
  const parsedFeeTxs = await parseTransactionsInBatches(connectionFetch, connectionHistory, feeSignatures, 1);

  for (const { tx, sigInfo } of parsedFeeTxs) {
    if (!tx.meta) continue;

    let memoText = '';
    let isFiatwalletTx = false;
    
    const checkIx = (ix) => {
      if (ix.programId.toBase58() === 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr' ||
          ix.programId.toBase58() === 'MemoSq4gqABAXKb96qJ8dnS7JsAg5057upE1tCku135') {
        memoText = ix.parsed || String(ix.data || '');
        if (memoText.includes('fiatwallet:')) isFiatwalletTx = true;
      }
    };

    tx.transaction.message.instructions.forEach(checkIx);
    if (tx.meta.innerInstructions) {
      tx.meta.innerInstructions.forEach(inner => inner.instructions.forEach(checkIx));
    }

    if (!isFiatwalletTx) continue;

    // Find sender
    let sender = '';
    let feeSOL = 0;

    tx.transaction.message.instructions.forEach(ix => {
      if (ix.program === 'system' && ix.parsed?.type === 'transfer') {
        if (ix.parsed.info.destination === FEE_WALLET) {
          sender = ix.parsed.info.source;
          feeSOL = ix.parsed.info.lamports / 1e9;
        }
      }
    });

    if (!sender && tx.meta.innerInstructions) {
      tx.meta.innerInstructions.forEach(inner => inner.instructions.forEach(ix => {
        if (ix.program === 'system' && ix.parsed?.type === 'transfer') {
          if (ix.parsed.info.destination === FEE_WALLET) {
            sender = ix.parsed.info.source;
            feeSOL = ix.parsed.info.lamports / 1e9;
          }
        }
      }));
    }

    if (sender) {
      uniqueUsers.add(sender);
      let vol = 0;
      let type = 'claim_rent';
      if (memoText.includes('accounts')) {
        vol = feeSOL / 0.06;
      } else if (memoText.includes('cashback')) {
        vol = feeSOL / 0.10;
        type = 'claim_cashback';
      }

      claimsData.push({
        signature: sigInfo.signature,
        user: sender,
        type,
        volume: vol,
        date: sigInfo.blockTime ? new Date(sigInfo.blockTime * 1000).toISOString().split('T')[0] : 'unknown'
      });
    }
  }

  const usersArray = Array.from(uniqueUsers);
  console.log(`Active Users Identified:`, usersArray);

  console.log(`\n==================================================`);
  console.log(`STAGE 2: Scanning active user histories for activity...`);
  console.log(`==================================================`);

  const results = [];

  for (const user of usersArray) {
    console.log(`Scanning wallet: ${user}...`);
    const userPubkey = new PublicKey(user);
    let userSigs = [];
    let userBefore = undefined;
    let userReachedLaunch = false;

    while (!userReachedLaunch) {
      const options = { limit: 100 };
      if (userBefore) options.before = userBefore;

      const sigs = await callRPC(() => connectionHistory.getSignaturesForAddress(userPubkey, options));
      if (sigs.length === 0) break;

      for (const sigInfo of sigs) {
        const txDate = sigInfo.blockTime ? new Date(sigInfo.blockTime * 1000) : null;
        if (txDate && txDate < LAUNCH_DATE) {
          userReachedLaunch = true;
          break;
        }
        userSigs.push(sigInfo);
      }
      if (userReachedLaunch) break;
      userBefore = sigs[sigs.length - 1].signature;
      await sleep(100);
    }

    // Filter out signatures that are already in claimsData or had errors
    const filteredUserSigs = userSigs.filter(sig => !sig.err && !claimsData.some(c => c.signature === sig.signature));
    console.log(`Found ${userSigs.length} signatures, parsing ${filteredUserSigs.length} transactions after filtering claims/errors...`);

    // Batch parse user signatures using batched helper
    const parsedUserTxs = await parseTransactionsInBatches(connectionFetch, connectionHistory, filteredUserSigs, 1);

    for (const { tx, sigInfo } of parsedUserTxs) {
      try {
        if (!tx.meta || tx.meta.err) continue;

        const dateStr = sigInfo.blockTime 
          ? new Date(sigInfo.blockTime * 1000).toISOString().split('T')[0]
          : 'unknown';

        // Categorize Transaction
        let isSwap = false;
        let transfersCount = 0;
        let transferDetails = [];

        const analyzeIx = (ix) => {
          const programId = ix.programId.toBase58();
          if (programId === JUP_PROGRAM_V5 || programId === JUP_PROGRAM_V6) {
            isSwap = true;
          }
          if (ix.program === 'system' && ix.parsed?.type === 'transfer') {
            transfersCount++;
            transferDetails.push(ix.parsed.info);
          }
          // Token transfers
          if (ix.program === 'spl-token' && ix.parsed?.type === 'transferChecked') {
            transfersCount++;
            transferDetails.push(ix.parsed.info);
          }
          if (ix.program === 'spl-token' && ix.parsed?.type === 'transfer') {
            transfersCount++;
            transferDetails.push(ix.parsed.info);
          }
        };

        tx.transaction.message.instructions.forEach(analyzeIx);
        if (tx.meta.innerInstructions) {
          tx.meta.innerInstructions.forEach(inner => inner.instructions.forEach(analyzeIx));
        }

        if (isSwap) {
          // Log Swap
          results.push({
            signature: sigInfo.signature,
            user,
            type: 'swap',
            volume: 0, // Swaps are hard to price retroactively without a price oracle, set as 0
            symbol: 'Various',
            date: dateStr
          });
        } else if (transfersCount > 1) {
          // Bulk Send (More than 1 transfer inside transaction)
          // Filter transfers where the source is the user
          const outgoingTransfers = transferDetails.filter(t => t.source === user || t.authority === user);
          if (outgoingTransfers.length > 1) {
            let totalSOL = 0;
            outgoingTransfers.forEach(t => {
              if (t.lamports) totalSOL += t.lamports / 1e9;
            });

            results.push({
              signature: sigInfo.signature,
              user,
              type: 'bulk_send',
              volume: totalSOL,
              symbol: 'SOL',
              date: dateStr
            });
          }
        } else if (transfersCount === 1) {
          // Single Send (Exactly 1 outgoing transfer)
          const outgoing = transferDetails.find(t => t.source === user || t.authority === user);
          if (outgoing && outgoing.destination !== FEE_WALLET) {
            let vol = outgoing.lamports ? (outgoing.lamports / 1e9) : 0;
            results.push({
              signature: sigInfo.signature,
              user,
              type: 'single_send',
              volume: vol,
              symbol: 'SOL',
              date: dateStr
            });
          }
        }
      } catch (e) {
        // Ignore parse errors
      }
    }
  }

  // Combine claims data with other results
  const allResults = [...claimsData, ...results];

  console.log(`\n==================================================`);
  console.log(`COMPLETE HISTORY REPORT (From May 10, 2026 onwards)`);
  console.log(`==================================================`);
  console.log(`Total Unique Users detected: ${usersArray.length}`);
  console.log(`Total Transactions identified: ${allResults.length}`);

  // Count by Type
  const typeCounts = {};
  allResults.forEach(r => {
    typeCounts[r.type] = (typeCounts[r.type] || 0) + 1;
  });

  console.log(`\nBreakdown by Transaction Type:`);
  Object.keys(typeCounts).forEach(type => {
    console.log(`- ${type}: ${typeCounts[type]}`);
  });

  // Daily Breakdown table
  const dailyStats = {};
  allResults.forEach(r => {
    if (!dailyStats[r.date]) {
      dailyStats[r.date] = { single_send: 0, bulk_send: 0, swap: 0, claim_rent: 0, claim_cashback: 0 };
    }
    dailyStats[r.date][r.type] = (dailyStats[r.date][r.type] || 0) + 1;
  });

  console.log(`\nDaily Transaction Matrix:`);
  console.log(`Date       | Single Send | Bulk Send | Swap | Claim Rent | Claim Cashback`);
  console.log(`-----------|-------------|-----------|------|------------|---------------`);
  Object.keys(dailyStats).sort().reverse().forEach(date => {
    const s = dailyStats[date];
    console.log(`${date} | ${s.single_send || 0}           | ${s.bulk_send || 0}         | ${s.swap || 0}    | ${s.claim_rent || 0}          | ${s.claim_cashback || 0}`);
  });
}

main().catch(console.error);
