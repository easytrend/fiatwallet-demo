import { useState, useRef, useEffect } from 'react';
import { PublicKey, Transaction, SystemProgram, ComputeBudgetProgram, SystemInstruction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction } from '@solana/spl-token';
import { getDomainKeySync, NameRegistryState } from '@bonfida/spl-name-service';
import { CURRENCIES } from '../data/currencies';
import { fmtTok, fmtFiat, fmtRate, parseCSV, dlTemplate, isValidEntry, robustResolve } from '../utils';
import CurrDrop from './CurrDrop';
import Toast from './Toast';


// Frozen constants prevent re-instantiation per render
const TOKEN_PROGRAM_ID = Object.freeze(new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'));
const TOKEN_2022_PROGRAM_ID = Object.freeze(new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'));
// Hard cap on bulk batches to prevent unbounded transaction injection
const MAX_BULK_BATCHES = 10; // 10 batches × 5 recipients = 50 max per bulk send

/**
 * Converts a floating-point token amount to integer base units without IEEE 754 precision loss.
 * e.g. toBaseUnits(0.1, 6) → 100000n   (not 99999n or 100001n)
 *
 * Strategy: use toFixed(decimals) to get an exact decimal string, then parse the
 * integer and fractional parts as separate BigInts — no floating-point multiplication.
 *
 * @param {number} amount   - float token amount (e.g. 1.23456)
 * @param {number} decimals - token decimals (e.g. 6 for USDC)
 * @returns {bigint}
 */
function toBaseUnits(amount, decimals) {
  const fixed = amount.toFixed(decimals); // '1.234560'
  const [intStr, fracStr = ''] = fixed.split('.');
  const fracPadded = fracStr.padEnd(decimals, '0').slice(0, decimals);
  return BigInt(intStr + fracPadded);
}

/**
 * Verifies that the built transaction has not been tampered with before signing/sending.
 * Asserts recipient addresses and transfer amounts match expected values.
 *
 * @param {Transaction} transaction - Solana Transaction object
 * @param {Array<{ recipient: string, amountBaseUnits: bigint, mint?: string }>} expectedTransfers - List of expected transfers
 */
function verifyTransactionIntegrity(transaction, expectedTransfers) {
  if (!transaction.instructions || transaction.instructions.length === 0) {
    throw new Error('Transaction integrity violation: Transaction contains no instructions.');
  }

  let transferCheckedCount = 0;
  let systemTransferCount = 0;

  for (const ix of transaction.instructions) {
    const programIdStr = ix.programId.toBase58();

    if (ix.programId.equals(SystemProgram.programId)) {
      try {
        const decoded = SystemInstruction.decodeTransfer(ix);
        const toPubkeyStr = decoded.toPubkey.toBase58();
        const lamports = BigInt(decoded.lamports);

        const match = expectedTransfers.find(expected => 
          !expected.mint &&
          expected.recipient === toPubkeyStr &&
          expected.amountBaseUnits === lamports
        );

        if (!match) {
          throw new Error(`Transaction integrity violation: Unexpected SOL transfer of ${lamports} lamports to ${toPubkeyStr}.`);
        }
        systemTransferCount++;
      } catch (err) {
        throw new Error(`Transaction integrity violation: Failed to validate System Program instruction: ${err.message}`);
      }
    } else if (
      programIdStr === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' || // Token Program
      programIdStr === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'     // Token-2022 Program
    ) {
      const ixType = ix.data[0];
      if (ixType === 12) { // TransferChecked
        if (ix.data.length < 10) {
          throw new Error('Transaction integrity violation: Invalid TransferChecked instruction data size.');
        }
        const mint = ix.keys[1].pubkey.toBase58();
        const destinationATA = ix.keys[2].pubkey.toBase58();

        let amount = 0n;
        for (let idx = 0; idx < 8; idx++) {
          amount += BigInt(ix.data[idx + 1]) << BigInt(idx * 8);
        }

        const match = expectedTransfers.find(expected => {
          if (expected.mint !== mint || expected.amountBaseUnits !== amount) return false;
          const expectedATA = getAssociatedTokenAddressSync(
            new PublicKey(mint),
            new PublicKey(expected.recipient),
            false,
            ix.programId
          ).toBase58();
          return destinationATA === expectedATA;
        });

        if (!match) {
          throw new Error(`Transaction integrity violation: Unexpected token transfer of ${amount} units for mint ${mint}.`);
        }

        const expectedATA = getAssociatedTokenAddressSync(
          new PublicKey(mint),
          new PublicKey(match.recipient),
          false,
          ix.programId
        ).toBase58();

        if (destinationATA !== expectedATA) {
          throw new Error(`Transaction integrity violation: Token destination ATA mismatch. Expected ${expectedATA}, got ${destinationATA}.`);
        }

        transferCheckedCount++;
      } else {
        // Reject all other token opcodes — including legacy Transfer (opcode 3).
        // Legacy Transfer does not encode the mint in its data, making it impossible
        // to verify which token is being transferred (mint substitution attack surface).
        // Only TransferChecked (opcode 12) is accepted.
        throw new Error(`Transaction integrity violation: Disallowed token instruction opcode ${ixType}. Only TransferChecked (12) is permitted.`);
      }
    }
  }

  const totalExpectedTransfers = expectedTransfers.length;
  const totalFoundTransfers = systemTransferCount + transferCheckedCount;
  if (totalFoundTransfers !== totalExpectedTransfers) {
    throw new Error(`Transaction integrity violation: Expected ${totalExpectedTransfers} transfer instructions, but found ${totalFoundTransfers}.`);
  }
}

export default function BulkSendPanel({ tok, connected, getLiveRate, connection, publicKey, sendTransaction, signAllTransactions }) {
  const [rows, setRows] = useState([]);
  const [drag, setDrag] = useState(false);
  const [globalAmt, setGlobalAmt] = useState('');
  const [bulkCurr, setBulkCurr] = useState('USD');
  const [bulkMode, setBulkMode] = useState('fiat');
  const [sendingState, setSendingState] = useState(null); // null | 'resolving' | 'signing' | 'sending' | 'done' | 'error'
  const [errorMsg, setErrorMsg] = useState('');
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [toast, setToast] = useState(null);
  const fileRef = useRef(null);

  const staticCurr = CURRENCIES.find(c => c.code === bulkCurr) || CURRENCIES[0];
  const liveRate = (getLiveRate && getLiveRate(bulkCurr)) || staticCurr.rate;

  const processFile = file => {
    const ext = file.name.split('.').pop().toLowerCase();
    if (!['csv','txt'].includes(ext)) {
      alert('Please upload a .csv or .txt file');
      return;
    }
    // Security: Prevent browser crashes from maliciously huge files (limit to 2MB)
    if (file.size > 2 * 1024 * 1024) {
      alert('File is too large. Maximum size is 2MB.');
      return;
    }

    const r = new FileReader(); 
    r.onload = e => {
      const newRows = parseCSV(e.target.result);
      setRows(v => {
        const combined = [...v, ...newRows];
        // Enforce the 1000 recipient limit shown in the UI
        if (combined.length > 1000) {
          alert('Maximum 1,000 recipients allowed. Truncating excess rows.');
          return combined.slice(0, 1000);
        }
        return combined;
      });
    }; 
    r.readAsText(file);
  };

  const handleDrop = e => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files[0]) processFile(e.dataTransfer.files[0]); };
  const handleFile = e => { if (e.target.files[0]) processFile(e.target.files[0]); e.target.value = ''; };
  const removeRow = id => setRows(r => r.filter(x => x.id !== id));
  const addManual = () => setRows(r => [...r, {id:Date.now()+Math.random(),domain:'',amount:'',valid:false,resolved:null}]);
  const updateRow = (id,field,val) => setRows(r => r.map(x => x.id===id ? {...x,[field]:val,valid:field==='domain'?isValidEntry(val):x.valid,resolved:field==='domain'?null:x.resolved} : x));
  const applyGlobal = () => { if (globalAmt) setRows(r => r.map(x => ({...x, amount:globalAmt}))); };

  // Auto-dismiss errorMsg after 10 seconds
  useEffect(() => {
    if (errorMsg) {
      const timer = setTimeout(() => {
        setErrorMsg('');
        if (sendingState === 'error') {
          setSendingState(null);
        }
      }, 10000);
      return () => clearTimeout(timer);
    }
  }, [errorMsg, sendingState]);

  // Inline resolution for responsive feedback
  const [resolvingIds, setResolvingIds] = useState(new Set());
  useEffect(() => {
    const timer = setTimeout(async () => {
      const target = rows.find(r => r.domain.endsWith('.sol') && !r.resolved && !resolvingIds.has(r.id));
      if (!target) return;

      setResolvingIds(prev => new Set(prev).add(target.id));
      try {
        const addr = await robustResolve(target.domain, connection);
        setRows(curr => curr.map(r => r.id === target.id ? { ...r, resolved: addr.toBase58(), valid: true } : r));
      } catch (e) {
        setRows(curr => curr.map(r => r.id === target.id ? { ...r, valid: false } : r));
      } finally {
        setResolvingIds(prev => { const n = new Set(prev); n.delete(target.id); return n; });
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [rows, resolvingIds]);

  // Poll signature status instead of relying on WS confirmTransaction
  async function pollConfirmation(connection, signature, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const status = await connection.getSignatureStatus(signature);
        const conf = status?.value?.confirmationStatus;
        if (conf === 'confirmed' || conf === 'finalized') return true;
        if (status?.value?.err) throw new Error('Transaction rejected: ' + JSON.stringify(status.value.err));
      } catch (pollErr) {
        if (pollErr.message.startsWith('Transaction rejected')) throw pollErr;
        // RPC blip — keep polling
      }
      await new Promise(r => setTimeout(r, 2000));
    }
    // Final check
    const finalStatus = await connection.getSignatureStatus(signature);
    const finalConf = finalStatus?.value?.confirmationStatus;
    return finalConf === 'confirmed' || finalConf === 'finalized';
  }

  const handleBulkSend = async () => {
    if (['resolving', 'signing', 'sending'].includes(sendingState)) return;
    if (!connected || !publicKey || validRows.length === 0) return;
    setSendingState('resolving');
    setErrorMsg('');
    setToast(null);

    try {
      const existingATAs = new Set();
      // 0. Pre-validate rows with amounts but invalid domains
      const invalidRows = rows.filter(r => r.amount && !r.valid);
      if (invalidRows.length > 0) {
        throw new Error(`Invalid address detected: "${invalidRows[0].domain}". Please fix or remove it.`);
      }

      // Check for raw string duplicates (fast check)
      const domainSet = new Set();
      for (const r of validRows) {
        const d = r.domain.toLowerCase().trim();
        if (domainSet.has(d)) throw new Error(`Duplicate recipient detected: "${r.domain}".`);
        domainSet.add(d);
      }

      // 1. Resolve all domains and validate recipients
      const resolvedRecipients = [];
      const seenPubkeys = new Set();

      for (let i = 0; i < validRows.length; i++) {
        const row = validRows[i];
        let addressStr = row.domain.trim();

        if (addressStr.endsWith('.sol')) {
          try {
            const address = await robustResolve(addressStr, connection);
            addressStr = address.toBase58();
            // Secondary on-chain ownership verification: abort if domain has been
            // transferred to a different address since the initial resolution (TOCTOU guard).
            try {
              const { pubkey: domainKey } = getDomainKeySync(addressStr.slice(0, -4)); // strip .sol before lookup
              const registry = await NameRegistryState.retrieve(connection, domainKey);
              if (registry.owner.toBase58() !== addressStr) {
                throw new Error(`Domain ownership mismatch for "${row.domain}" — the domain may have been transferred. Aborting to prevent sending to the wrong wallet.`);
              }
            } catch (verifyErr) {
              // Re-throw our own security errors; ignore RPC unavailability
              if (verifyErr.message.includes('ownership mismatch')) throw verifyErr;
            }
          } catch (err) {
            throw new Error(`Failed to resolve domain: ${row.domain}`);
          }
        }

        // Validate base58 parse + on-curve check — rejects program addresses
        // and garbage strings before any on-chain instructions are built.
        let recipientPubkey;
        try {
          recipientPubkey = new PublicKey(addressStr);
          if (!PublicKey.isOnCurve(recipientPubkey.toBytes())) {
            throw new Error('Address is not on the Ed25519 curve');
          }
        } catch (err) {
          throw new Error(`Invalid address for "${row.domain}": ${err.message}`);
        }

        const pubkeyStr = recipientPubkey.toBase58();

        // Self-send guard for bulk send
        if (recipientPubkey.equals(publicKey)) {
          throw new Error(`Cannot send to your own wallet address: "${row.domain}" resolves to your connected wallet.`);
        }

        if (seenPubkeys.has(pubkeyStr)) {
          throw new Error(`Duplicate recipient detected: "${row.domain}" resolves to the same address as another recipient.`);
        }
        seenPubkeys.add(pubkeyStr);

        const num = parseFloat(row.amount);
        const tokPrice = tok ? tok.price : 1;
        const tokAmt = bulkMode === 'fiat' ? (num / liveRate) / tokPrice : num;

        resolvedRecipients.push({ pubkey: recipientPubkey, tokAmt });
      }

      // 2. Fetch mint info if SPL token
      let decimals = 9;
      let mintPubkey = null;
      let tokenProgramId = TOKEN_PROGRAM_ID;
      if (tok.symbol !== 'SOL') {
        mintPubkey = new PublicKey(tok.mint);
        const mintInfo = await connection.getParsedAccountInfo(mintPubkey);
        if (!mintInfo.value) throw new Error('Invalid token mint');
        decimals = mintInfo.value.data.parsed.info.decimals;
        // Detect Token-2022 mints to compute correct ATAs
        try {
          const mintAcct = await connection.getAccountInfo(mintPubkey);
          if (mintAcct && mintAcct.owner.equals(TOKEN_2022_PROGRAM_ID)) {
            tokenProgramId = TOKEN_2022_PROGRAM_ID;
          }
        } catch (e) { /* default to legacy */ }
      }

      // Check balance dynamically immediately before building the transaction to prevent race conditions
      const totalRequested = resolvedRecipients.reduce((sum, r) => sum + r.tokAmt, 0);

      if (tok.symbol === 'SOL') {
        const freshLamports = await connection.getBalance(publicKey, 'confirmed');
        const freshSolBalance = freshLamports / 1e9;

        if (totalRequested > freshSolBalance) {
          throw new Error(`Insufficient SOL balance. You need ${totalRequested.toFixed(6)} SOL but have ${freshSolBalance.toFixed(6)} SOL.`);
        }

        // Check if sending all SOL to estimate and subtract transaction fees dynamically
        if (totalRequested >= freshSolBalance - 0.005) {
          const tempChunkSize = 5;
          let totalEstimatedFee = 0;
          const latestBlockhash = await connection.getLatestBlockhash('confirmed');
          for (let i = 0; i < resolvedRecipients.length; i += tempChunkSize) {
            const chunk = resolvedRecipients.slice(i, i + tempChunkSize);
            const tx = new Transaction();
            tx.recentBlockhash = latestBlockhash.blockhash;
            tx.feePayer = publicKey;

            for (const rec of chunk) {
              const lamports = Math.round(rec.tokAmt * 1e9);
              tx.add(SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: rec.pubkey, lamports }));
            }

            let txFee = 5000;
            try {
              const est = await tx.getEstimatedFee(connection);
              if (est !== null && est !== undefined) txFee = est;
            } catch (e) {
              
            }
            totalEstimatedFee += txFee;
          }

          const feeSol = totalEstimatedFee / 1e9;
          const feeSharePerRecipient = feeSol / resolvedRecipients.length;

          resolvedRecipients.forEach(rec => {
            rec.tokAmt = Math.max(0, rec.tokAmt - feeSharePerRecipient);
          });
        }
      } else {
        const senderATA = getAssociatedTokenAddressSync(mintPubkey, publicKey, false, tokenProgramId);
        let freshTokenBalance = 0;
        try {
          const balanceResp = await connection.getTokenAccountBalance(senderATA, 'confirmed');
          freshTokenBalance = balanceResp.value.uiAmount || 0;
        } catch (e) {
          freshTokenBalance = 0;
        }

        if (totalRequested > freshTokenBalance) {
          throw new Error(`Insufficient ${tok.symbol} balance. You need ${totalRequested} ${tok.symbol} but have ${freshTokenBalance}.`);
        }

        // Fetch receiver ATAs and check if they exist to estimate rent fees
        const receiverATAs = resolvedRecipients.map(rec => 
          getAssociatedTokenAddressSync(mintPubkey, rec.pubkey, false, tokenProgramId)
        );

        let accountsInfo = [];
        if (receiverATAs.length > 0) {
          try {
            accountsInfo = await connection.getMultipleAccountsInfo(receiverATAs);
          } catch (e) {
            
            accountsInfo = new Array(receiverATAs.length).fill(null);
          }
        }

        let newAtasCount = 0;
        receiverATAs.forEach((ata, index) => {
          const info = accountsInfo[index];
          if (info === null) {
            newAtasCount++;
          } else {
            existingATAs.add(ata.toBase58());
          }
        });

        // Query fresh SOL balance
        const freshLamports = await connection.getBalance(publicKey, 'confirmed');
        const freshSolBalance = freshLamports / 1e9;
        
        const requiredRentSOL = newAtasCount * 0.00203928;
        const txCount = Math.ceil(resolvedRecipients.length / 5);
        const estimatedFeesSOL = txCount * 0.00001;
        const totalSolNeeded = requiredRentSOL + estimatedFeesSOL;

        if (freshSolBalance < totalSolNeeded) {
          throw new Error(`Insufficient SOL balance for transaction rent/fees. You need at least ${totalSolNeeded.toFixed(6)} SOL to pay for ${newAtasCount} new recipient accounts, but only have ${freshSolBalance.toFixed(6)} SOL.`);
        }
      }

      setSendingState('signing');

      // 3. Chunk instructions (5 per tx for speed, compatible with most wallets)
      const chunkSize = 5;
      const transactions = [];
      const latestBlockhash = await connection.getLatestBlockhash('confirmed');

      for (let i = 0; i < resolvedRecipients.length; i += chunkSize) {
        const chunk = resolvedRecipients.slice(i, i + chunkSize);
        const tx = new Transaction();
        tx.recentBlockhash = latestBlockhash.blockhash;
        tx.feePayer = publicKey;

        if (tok.symbol === 'SOL') {
          for (const rec of chunk) {
            const lamports = Math.round(rec.tokAmt * 1e9);
            tx.add(SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: rec.pubkey, lamports }));
          }
        } else {
          const senderATA = getAssociatedTokenAddressSync(mintPubkey, publicKey, false, tokenProgramId);
          for (const rec of chunk) {
            const amountUnits = toBaseUnits(rec.tokAmt, decimals);
            const receiverATA = getAssociatedTokenAddressSync(mintPubkey, rec.pubkey, false, tokenProgramId);
            if (!existingATAs.has(receiverATA.toBase58())) {
              tx.add(createAssociatedTokenAccountIdempotentInstruction(publicKey, receiverATA, rec.pubkey, mintPubkey, tokenProgramId));
            }
            tx.add(createTransferCheckedInstruction(senderATA, mintPubkey, receiverATA, publicKey, amountUnits, decimals));
          }
        }
        const chunkExpectedTransfers = chunk.map(rec => ({
          recipient: rec.pubkey.toBase58(),
          amountBaseUnits: tok.symbol === 'SOL'
            ? toBaseUnits(rec.tokAmt, 9)
            : toBaseUnits(rec.tokAmt, decimals),
          mint: tok.symbol === 'SOL' ? null : tok.mint
        }));
        verifyTransactionIntegrity(tx, chunkExpectedTransfers);
        transactions.push(tx);
      }

      // Enforce max batch cap to prevent unbounded transaction injection
      if (transactions.length > MAX_BULK_BATCHES) {
        throw new Error(`Too many batches (${transactions.length}). Maximum is ${MAX_BULK_BATCHES} batches (${MAX_BULK_BATCHES * 5} recipients). Split into multiple sends.`);
      }

      // SECURITY: Validate all transactions are empty-checked and contain only expected program IDs
      for (let i = 0; i < transactions.length; i++) {
        if (!transactions[i].instructions || transactions[i].instructions.length === 0) {
          throw new Error(`Transaction ${i + 1} has no instructions`);
        }
        for (const instr of transactions[i].instructions) {
          const pid = instr.programId.toString();
          const allowed = [
            '11111111111111111111111111111111',             // System Program
            'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',  // Token Program (legacy)
            'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',  // Token-2022 Program
            'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // Associated Token Program
          ];
          if (!allowed.includes(pid)) throw new Error(`Transaction ${i + 1} contains unexpected program: ${pid}`);
        }
      }

      setProgress({ current: 0, total: transactions.length });
      const signatures = [];

      setSendingState('signing');

      if (transactions.length > 1 && signAllTransactions) {
        // Pre-flight simulation immediately before signAllTransactions
        for (let i = 0; i < transactions.length; i++) {
          const simResult = await connection.simulateTransaction(transactions[i]);
          if (simResult.value.err) {
            const simErr = JSON.stringify(simResult.value.err);
            const logs = simResult.value.logs?.slice(0, 3).join(' | ') || '';
            throw new Error(`Batch ${i + 1} simulation failed: ${simErr}${logs ? ' — ' + logs : ''}`);
          }
        }

        const signedTxs = await signAllTransactions(transactions);
        setSendingState('sending');

        for (let i = 0; i < signedTxs.length; i++) {
          const rawTx = signedTxs[i].serialize();
          const sig = await connection.sendRawTransaction(rawTx);
          signatures.push(sig);
          const confirmed = await pollConfirmation(connection, sig);
          if (!confirmed) throw new Error(`Batch ${i + 1} timed out — check Solscan for: ${sig.slice(0,8)}…`);
          setProgress(p => ({ ...p, current: i + 1 }));
        }
      } else {
        setSendingState('sending');
        for (let i = 0; i < transactions.length; i++) {
          // Pre-flight simulation immediately before sendTransaction
          const simResult = await connection.simulateTransaction(transactions[i]);
          if (simResult.value.err) {
            const simErr = JSON.stringify(simResult.value.err);
            const logs = simResult.value.logs?.slice(0, 3).join(' | ') || '';
            throw new Error(`Batch ${i + 1} simulation failed: ${simErr}${logs ? ' — ' + logs : ''}`);
          }

          const sig = await sendTransaction(transactions[i], connection);
          signatures.push(sig);
          const confirmed = await pollConfirmation(connection, sig);
          if (!confirmed) throw new Error(`Batch ${i + 1} timed out — check Solscan for: ${sig.slice(0,8)}…`);
          setProgress(p => ({ ...p, current: i + 1 }));
        }
      }

      setSendingState('done');

      // Build Solscan link: single tx or first batch tx
      const firstSig = signatures[0];



      setToast({
        type: 'success',
        title: `✓ Sent to ${validRows.length} recipient${validRows.length !== 1 ? 's' : ''}`,
        message: `${transactions.length} transaction${transactions.length !== 1 ? 's' : ''} confirmed on Solana.`,
        link: firstSig
          ? { href: `https://solscan.io/tx/${firstSig}`, label: `${firstSig.slice(0,8)}… View on Solscan` }
          : undefined,
      });

      setTimeout(() => {
        setSendingState(null);
        setRows([]);
        setGlobalAmt('');
      }, 2000);

    } catch (err) {
      
      const msg = err.message || 'An error occurred';
      setErrorMsg(msg);
      setSendingState('error');
      setToast({ type: 'error', title: 'Bulk send failed', message: msg });
    }
  };

  // Calculate duplicates dynamically for UI rendering
  const domainCounts = {};
  const resolvedCounts = {};
  rows.forEach(r => {
    const d = r.domain.toLowerCase().trim();
    if (d) domainCounts[d] = (domainCounts[d] || 0) + 1;
    if (r.resolved) resolvedCounts[r.resolved] = (resolvedCounts[r.resolved] || 0) + 1;
  });

  const getRowStatus = (row) => {
    const d = row.domain.toLowerCase().trim();
    if (d && domainCounts[d] > 1) return { ok: false, msg: 'Dup', className: 's-err' };
    if (row.resolved && resolvedCounts[row.resolved] > 1) return { ok: false, msg: 'Dup', className: 's-err' };
    if (!row.valid && row.domain.length > 0) return { ok: false, msg: 'Err', className: 's-err' };
    if (!row.amount) return { ok: false, msg: 'Amt', className: 's-err' };
    if (row.valid && row.amount) return { ok: true, msg: 'OK', className: 's-ok' };
    return { ok: false, msg: 'Err', className: 's-err' };
  };

  const validRows = rows.filter(r => getRowStatus(r).ok);
  const hasDuplicates = rows.some(r => {
    const st = getRowStatus(r);
    return st.msg === 'Dup';
  });

  const tokPrice = tok ? tok.price : 1;
  const tokSymbol = tok ? tok.symbol : 'Token';

  const totalUSD = validRows.reduce((s,r) => {
    const n = parseFloat(r.amount)||0;
    return s + (bulkMode==='fiat' ? n/liveRate : n*tokPrice);
  }, 0);
  const totalTok = totalUSD / tokPrice;
  const globalNum = parseFloat(globalAmt)||0;
  const perTok  = bulkMode==='fiat'   ? (globalNum/liveRate)/tokPrice : globalNum;
  const perFiat = bulkMode==='crypto' ? globalNum*tokPrice*liveRate   : globalNum;
  const convertedLabel = globalNum > 0
    ? (bulkMode==='fiat' ? `≈ ${tok ? fmtTok(perTok) : '0'} ${tokSymbol} each` : `≈ ${fmtFiat(perFiat,bulkCurr)} each`)
    : '';
  const colLabel = bulkMode==='fiat' ? bulkCurr : tokSymbol;

  return (
    <div>
      <div className="field">
        <div className="field-label">Default Amount per Recipient</div>
        {bulkMode==='fiat' && (
          <CurrDrop selected={bulkCurr} onSelect={setBulkCurr} showAsRow={true}
            rateLabel={`1 USD = ${fmtRate(liveRate)} ${staticCurr.code}`} />
        )}
        <div className="amount-block" style={{marginTop: bulkMode==='fiat' ? 8 : 0}}>
          <div className="amount-top">
            <div className="amount-num-wrap">
              <div style={{display:'flex', alignItems:'center', gap:8}}>
                <input className="amount-num" type="number" value={globalAmt}
                  onChange={e => setGlobalAmt(e.target.value)} placeholder="0" style={{fontSize:18}} />
                {tok && tok.balance > 0 && (
                  <button className="max-btn" type="button" onClick={() => {
                    const numRecipients = rows.length > 0 ? rows.length : 1;
                    const maxPerRecipient = tok.balance / numRecipients;
                    if (bulkMode === 'fiat') {
                      const fiatMax = maxPerRecipient * tokPrice * liveRate;
                      setGlobalAmt(fiatMax.toFixed(2));
                    } else {
                      setGlobalAmt(maxPerRecipient.toString());
                    }
                  }}>
                    MAX
                  </button>
                )}
              </div>
            </div>
            {bulkMode==='crypto' && tok && (
              <div style={{display:'flex',alignItems:'center',gap:6,background:'rgba(255,255,255,0.07)',border:'1px solid var(--border)',borderRadius:9,padding:'7px 10px',fontSize:13,fontWeight:600,color:'var(--text)',whiteSpace:'nowrap',flexShrink:0}}>
                <div className="tok-icon" style={{background:tok.bg,color:tok.color,width:22,height:22,fontSize:8}}>{tokSymbol.slice(0,3)}</div>
                {tokSymbol}
              </div>
            )}
            {bulkMode==='crypto' && !tok && (
              <div style={{display:'flex',alignItems:'center',gap:6,background:'rgba(255,255,255,0.07)',border:'1px solid var(--border)',borderRadius:9,padding:'7px 10px',fontSize:13,fontWeight:600,color:'var(--text3)',whiteSpace:'nowrap',flexShrink:0}}>
                <div className="tok-icon" style={{background:'rgba(255,255,255,0.05)',color:'var(--text3)',width:22,height:22,fontSize:8}}>?</div>
                Select
              </div>
            )}
          </div>
          <div className="amount-divider" />
          <div className="amount-bottom">
            <span className="amount-converted">{convertedLabel || <span style={{color:'var(--text3)'}}>Enter amount above</span>}</span>
            <div className="input-mode-toggle">
              <button className={`imt-btn ${bulkMode==='fiat'?'active':''}`} onClick={() => setBulkMode('fiat')}>{bulkCurr}</button>
              <button className={`imt-btn ${bulkMode==='crypto'?'active':''}`} disabled={!tok} onClick={() => setBulkMode('crypto')}>{tokSymbol}</button>
            </div>
          </div>
        </div>
        {tok && (
          <div className="rate-badge" style={{marginTop:8}}>
            <span className="rate-dot" />
            1 {tokSymbol} = ${tokPrice < 0.001 ? tokPrice.toFixed(7) : tokPrice.toLocaleString()} USD
          </div>
        )}
        {globalAmt && (
          <button className="tmpl-btn" style={{width:'100%',marginTop:8,padding:'7px 12px',fontSize:12}} onClick={applyGlobal}>
            Apply this amount to all recipients
          </button>
        )}
      </div>

      {rows.length === 0 ? (
        <>
          <div className={`upload-zone ${drag?'drag':''}`}
            onClick={() => fileRef.current.click()}
            onDragOver={e => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)} onDrop={handleDrop}>
            <div className="upload-icon">📂</div>
            <div className="upload-title">Drop file or click to browse</div>
            <div className="upload-sub">Supports <span>.csv</span> and <span>.xlsx</span> · Up to 1,000 recipients</div>
            <input ref={fileRef} type="file" className="upload-input" accept=".csv,.xlsx,.xls,.txt" onChange={handleFile} />
          </div>
          <button className="add-manual" onClick={addManual}>＋ Add recipients manually</button>
        </>
      ) : (
        <>
          <div style={{display:'flex',gap:8,marginBottom:10}}>
            <button className="tmpl-btn" style={{padding:'7px 10px'}} onClick={() => fileRef.current.click()}>＋ Upload more</button>
            <input ref={fileRef} type="file" className="upload-input" accept=".csv,.xlsx,.xls,.txt" onChange={handleFile} />
          </div>
          <div className="recip-hdr">
            <span className="recip-count"><strong>{validRows.length}</strong> of {rows.length} ready</span>
            <button className="clear-btn" onClick={() => setRows([])}>Clear all</button>
          </div>
          <div className="recip-table">
            <div className="rt-head"><span>Wallet / Domain</span><span>Amt ({colLabel})</span><span>Status</span><span></span></div>
            {rows.map(row => (
              <div key={row.id} className="rt-row">
                <div className="rt-domain">
                  <input style={{background:'transparent',border:'none',outline:'none',color:'var(--text)',fontFamily:'var(--mono)',fontSize:11,width:'100%'}}
                    value={row.domain} placeholder="wallet or .sol" onChange={e => updateRow(row.id,'domain',e.target.value)} />
                  {row.resolved && <div style={{fontSize:9,color:'var(--text3)',marginTop:2,overflow:'hidden',textOverflow:'ellipsis'}}>{row.resolved.slice(0,12)}…</div>}
                </div>
                <div className="rt-amount">
                  <input style={{background:'transparent',border:'none',outline:'none',color:'var(--text2)',fontFamily:'var(--mono)',fontSize:11,width:'90%'}}
                    value={row.amount} placeholder="0" type="number" onChange={e => updateRow(row.id,'amount',e.target.value)} />
                </div>
                <div className={`rt-status ${getRowStatus(row).className}`}>
                  <span className="s-dot" />
                  <span className="s-txt">{getRowStatus(row).msg}</span>
                </div>
                <button className="rt-del" onClick={() => removeRow(row.id)}>✕</button>
              </div>
            ))}
          </div>
          <div className="bulk-sum">
            <div className="sum-item"><div className="sum-val">{validRows.length}</div><div className="sum-lbl">Recipients</div></div>
            <div className="sum-item"><div className="sum-val">{tok ? fmtTok(totalTok) : '0'}</div><div className="sum-lbl">Total {tokSymbol}</div></div>
            <div className="sum-item"><div className="sum-val">${totalUSD.toFixed(2)}</div><div className="sum-lbl">Est. USD</div></div>
          </div>
          <button className="add-manual" onClick={addManual}>＋ Add recipient manually</button>

          {/* Progress/status area */}
          {sendingState && (
            <div style={{marginTop:12, padding:'12px', background:'rgba(255,255,255,0.05)', borderRadius:8, fontSize:13}}>
              {sendingState === 'resolving' && <span style={{color:'var(--text2)'}}>🔍 Resolving domains...</span>}
              {sendingState === 'signing'   && <span style={{color:'var(--text2)'}}>✍️ Please sign the transaction(s) in your wallet...</span>}
              {sendingState === 'sending'   && <span style={{color:'var(--lime)'}}>🚀 Confirming batch {progress.current + 1} of {progress.total}...</span>}
              {sendingState === 'done'      && <span style={{color:'var(--lime)'}}>✅ All {validRows.length} recipients paid!</span>}
              {sendingState === 'error'     && <span style={{color:'#f87171'}}>✕ {errorMsg}</span>}
            </div>
          )}
        </>
      )}

      <button className="send-btn"
        disabled={!connected || !tok || validRows.length === 0 || hasDuplicates || ['resolving','signing','sending'].includes(sendingState)}
        onClick={handleBulkSend}>
        {!connected ? 'Connect wallet to send'
          : !tok ? 'Select a token to continue'
          : hasDuplicates ? 'Fix duplicate recipients to continue'
          : validRows.length === 0 ? 'Add valid recipients to continue'
          : ['resolving','signing','sending'].includes(sendingState) ? 'Processing...'
          : `Send ${tokSymbol} to ${validRows.length} recipient${validRows.length!==1?'s':''}`}
      </button>

      {/* Toast popup */}
      {toast && (
        <Toast
          type={toast.type}
          title={toast.title}
          message={toast.message}
          link={toast.link}
          onClose={() => setToast(null)}
          duration={5000}
        />
      )}
    </div>
  );
}
