import { Connection, PublicKey } from '@solana/web3.js';

const FEE_WALLET = '5xh9BFXqCgpUxGbf3QzADNze945aNSiVG9EFNa8vvb3u';
const RPC_URL = 'https://api.mainnet-beta.solana.com';

const MAY_10_2026_TIMESTAMP = 1778371200; // May 10, 2026 (assuming 2026 current year based on local time metadata)
// Let's also support 2024/2025 just in case: May 10, 2026 is timestamp ~1778371200. Let's filter by date dynamically.
const LAUNCH_DATE = new Date('2026-05-10T00:00:00Z');

async function main() {
  console.log(`Connecting to Solana RPC...`);
  const connection = new Connection(RPC_URL, 'confirmed');
  const feePubkey = new PublicKey(FEE_WALLET);

  console.log(`Fetching transaction signatures for fee wallet: ${FEE_WALLET}...`);
  
  let allSignatures = [];
  let before = undefined;
  let reachedLaunchDate = false;

  // Fetch signatures in batches of 1000
  while (!reachedLaunchDate) {
    try {
      const options = { limit: 100 }; // Fetch small batches for speed/stability
      if (before) options.before = before;

      const signatures = await connection.getSignaturesForAddress(feePubkey, options);
      if (signatures.length === 0) break;

      for (const sigInfo of signatures) {
        const blockTime = sigInfo.blockTime;
        const txDate = blockTime ? new Date(blockTime * 1000) : null;
        
        if (txDate && txDate < LAUNCH_DATE) {
          reachedLaunchDate = true;
          break;
        }

        allSignatures.push(sigInfo);
      }

      if (reachedLaunchDate) break;
      before = signatures[signatures.length - 1].signature;
      console.log(`Fetched ${allSignatures.length} signatures so far...`);
    } catch (e) {
      console.error('Error fetching signatures:', e.message);
      break;
    }
  }

  console.log(`Fetched total ${allSignatures.length} signatures since launch date.`);
  console.log(`Parsing transactions to extract fee volumes & unique users...`);

  let parsedTransactions = [];
  let uniqueUsers = new Set();
  let totalVolumeSOL = 0;
  let totalFeeSOL = 0;

  // Parse each transaction (process in parallel chunk-by-chunk to avoid RPC rate limits)
  const batchSize = 10;
  for (let i = 0; i < allSignatures.length; i += batchSize) {
    const batch = allSignatures.slice(i, i + batchSize);
    await Promise.all(batch.map(async (sigInfo) => {
      try {
        const tx = await connection.getParsedTransaction(sigInfo.signature, {
          maxSupportedTransactionVersion: 0,
        });

        if (!tx || !tx.meta) return;

        // Check for memo in instructions
        let memoText = '';
        let isFiatwalletTx = false;

        const checkInstruction = (ix) => {
          if (ix.programId.toBase58() === 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr' ||
              ix.programId.toBase58() === 'MemoSq4gqABAXKb96qJ8dnS7JsAg5057upE1tCku135') {
            memoText = ix.parsed || String(ix.data || '');
            if (memoText.includes('fiatwallet:')) {
              isFiatwalletTx = true;
            }
          }
        };

        tx.transaction.message.instructions.forEach(checkInstruction);
        if (tx.meta.innerInstructions) {
          tx.meta.innerInstructions.forEach(inner => inner.instructions.forEach(checkInstruction));
        }

        if (!isFiatwalletTx) return;

        // Find the SOL transfer to fee wallet
        let feeAmountLamports = 0n;
        let senderAddress = '';

        tx.transaction.message.instructions.forEach(ix => {
          if (ix.program === 'system' && ix.parsed?.type === 'transfer') {
            const transfer = ix.parsed.info;
            if (transfer.destination === FEE_WALLET) {
              feeAmountLamports = BigInt(transfer.lamports);
              senderAddress = transfer.source;
            }
          }
        });

        // If not found in outer instructions, look in inner
        if (feeAmountLamports === 0n && tx.meta.innerInstructions) {
          tx.meta.innerInstructions.forEach(inner => {
            inner.instructions.forEach(ix => {
              if (ix.program === 'system' && ix.parsed?.type === 'transfer') {
                const transfer = ix.parsed.info;
                if (transfer.destination === FEE_WALLET) {
                  feeAmountLamports = BigInt(transfer.lamports);
                  senderAddress = transfer.source;
                }
              }
            });
          });
        }

        if (feeAmountLamports === 0n) return;

        const feeSOL = Number(feeAmountLamports) / 1e9;
        let grossVolumeSOL = 0;
        let txType = 'unknown';

        if (memoText.includes('accounts')) {
          // Rent claim: 6% fee
          grossVolumeSOL = feeSOL / 0.06;
          txType = 'rent_claim';
        } else if (memoText.includes('cashback')) {
          // Cashback claim: 10% fee
          grossVolumeSOL = feeSOL / 0.10;
          txType = 'cashback_claim';
        }

        uniqueUsers.add(senderAddress);
        totalVolumeSOL += grossVolumeSOL;
        totalFeeSOL += feeSOL;

        const dateStr = sigInfo.blockTime 
          ? new Date(sigInfo.blockTime * 1000).toISOString().split('T')[0]
          : 'unknown';

        parsedTransactions.push({
          date: dateStr,
          sender: senderAddress,
          type: txType,
          fee: feeSOL,
          volume: grossVolumeSOL,
          signature: sigInfo.signature
        });

      } catch (err) {
        // console.error(`Error parsing tx ${sigInfo.signature}:`, err.message);
      }
    }));
  }

  console.log(`\n==================================================`);
  console.log(`STATISTICS REPORT (From May 10, 2026 onwards)`);
  console.log(`==================================================`);
  console.log(`Total Unique Users: ${uniqueUsers.size}`);
  console.log(`Total Claim Volume: ${totalVolumeSOL.toFixed(4)} SOL`);
  console.log(`Total Fees Collected: ${totalFeeSOL.toFixed(4)} SOL`);
  console.log(`Total Successful Logged Transactions: ${parsedTransactions.length}`);

  // Group by Date for DAU and Daily Volume
  const dailyStats = {};
  parsedTransactions.forEach(tx => {
    if (!dailyStats[tx.date]) {
      dailyStats[tx.date] = { users: new Set(), volume: 0, fees: 0, count: 0 };
    }
    dailyStats[tx.date].users.add(tx.sender);
    dailyStats[tx.date].volume += tx.volume;
    dailyStats[tx.date].fees += tx.fee;
    dailyStats[tx.date].count += 1;
  });

  console.log(`\nDaily Breakdowns:`);
  console.log(`Date       | Senders | Transactions | Volume (SOL) | Fees (SOL)`);
  console.log(`-----------|---------|--------------|--------------|-----------`);
  Object.keys(dailyStats).sort().reverse().forEach(date => {
    const stat = dailyStats[date];
    console.log(`${date} | ${stat.users.size}       | ${stat.count}            | ${stat.volume.toFixed(4)}       | ${stat.fees.toFixed(4)}`);
  });
}

main().catch(console.error);
