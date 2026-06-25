import React, { useState, useEffect, useMemo } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey, Transaction, SystemProgram, SystemInstruction, Connection, VersionedTransaction, TransactionMessage, TransactionInstruction } from '@solana/web3.js';
import { createCloseAccountInstruction } from '@solana/spl-token';
import { logTransaction } from '../services/supabase';


const PUMP_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const PUMP_AMM_PROGRAM_ID = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

/**
 * Pre-sign integrity check for rent-claim transactions.
 * The app builds these transactions itself, but a malicious wallet adapter or
 * prototype-pollution attack could inject extra instructions between construction
 * and signing. This guard verifies every instruction before the user is asked to sign.
 *
 * Checks:
 *   1. feePayer is the connected wallet.
 *   2. Every instruction's programId is in a strict allowlist.
 *   3. Token-program instructions are only CloseAccount (opcode 9).
 *   4. Any System Program transfer goes exclusively to the protocol fee wallet
 *      for exactly the expected lamport amount.
 */
function verifyRentClaimTransaction(tx, expectedFeeLamports, protocolFeeWallet, connectedPubkey) {
  const ALLOWED_PROGRAMS = new Set([
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // Token Program
    'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', // Token-2022
    '11111111111111111111111111111111',              // System Program
    'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', // Memo
  ]);

  if (!tx.feePayer || !tx.feePayer.equals(connectedPubkey)) {
    throw new Error('Rent claim integrity violation: fee payer is not the connected wallet.');
  }

  for (const ix of tx.instructions) {
    const pid = ix.programId.toBase58();
    if (!ALLOWED_PROGRAMS.has(pid)) {
      throw new Error(`Rent claim integrity violation: unexpected program ${pid}.`);
    }

    // Token programs: only CloseAccount (opcode 9) is permitted.
    if (pid === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' ||
        pid === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb') {
      const ixType = ix.data[0];
      if (ixType !== 9) {
        throw new Error(`Rent claim integrity violation: disallowed token opcode ${ixType}. Only CloseAccount (9) is permitted.`);
      }
    }

    // System Program: the only permitted transfer is the protocol fee, to the exact wallet, for the exact amount.
    if (pid === '11111111111111111111111111111111') {
      let decoded;
      try { decoded = SystemInstruction.decodeTransfer(ix); } catch (e) {
        throw new Error('Rent claim integrity violation: unrecognised System Program instruction.');
      }
      if (decoded.toPubkey.toBase58() !== protocolFeeWallet) {
        throw new Error(`Rent claim integrity violation: SOL transfer to unexpected destination ${decoded.toPubkey.toBase58()}.`);
      }
      if (BigInt(decoded.lamports) !== BigInt(expectedFeeLamports)) {
        throw new Error(`Rent claim integrity violation: fee lamport mismatch (expected ${expectedFeeLamports}, got ${decoded.lamports}).`);
      }
    }
  }
}

// Premium inline SVG icon matching the Moby "hand-with-coin" / claim icon
const ClaimIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '6px', display: 'inline-block', verticalAlign: 'middle' }}>
    {/* Coin */}
    <circle cx="12" cy="5" r="2.5" fill="currentColor" opacity="0.8" />
    {/* Hand receiving */}
    <path d="M3 14h7c.8 0 1.5-.4 1.8-1.1L14 9.5a1 1 0 0 1 1.7 1v4c0 .8-.5 1.5-1.2 1.8L11 18.5H5.5" />
    <path d="M1.5 17h2v3.5h-2z" />
  </svg>
);

export default function FloatClaimWidget({ liveSolPrice, onClaimSuccess }) {
  const { connection } = useConnection();
  const { publicKey, connected, sendTransaction, signAllTransactions } = useWallet();

  const [isOpen, setIsOpen] = useState(false);
  const [isDismissed, setIsDismissed] = useState(false);

  // Reclaimer States
  const [emptyAccounts, setEmptyAccounts] = useState([]);
  const [realCashback, setRealCashback] = useState(0);
  const [realBondingCurveCashback, setRealBondingCurveCashback] = useState(0);
  const [realAmmCashback, setRealAmmCashback] = useState(0);
  const [loading, setLoading] = useState(false);
  const [claimingRent, setClaimingRent] = useState(false);
  const [claimingCashback, setClaimingCashback] = useState(false);
  const [rentClaimed, setRentClaimed] = useState(false);
  const [cashbackClaimed, setCashbackClaimed] = useState(false);


  const [toast, setToast] = useState(null);

  // 1. Fetch Real Empty & Dust Accounts + Pump.fun Cashback on-chain
  const fetchClaimables = async () => {
    if (!publicKey) return;
    setLoading(true);
    try {
      const tokenProgramId = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
      const token2022ProgramId = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

      let results = [];
      let success = false;

      // SECURITY FIX: Use only the wallet-adapter's connection object
      // Do NOT fall back to hardcoded public RPC endpoints. This prevents split-brain scenarios
      // where balance checks occur against different RPC nodes with potentially inconsistent state.
      try {
        const [resp1, resp2] = await Promise.all([
          connection.getParsedTokenAccountsByOwner(publicKey, { programId: tokenProgramId }),
          connection.getParsedTokenAccountsByOwner(publicKey, { programId: token2022ProgramId }).catch(() => ({ value: [] })),
        ]);
        results = [
          ...resp1.value.map(a => ({ ...a, programId: tokenProgramId })),
          ...resp2.value.map(a => ({ ...a, programId: token2022ProgramId }))
        ];
        success = true;
        
      } catch (err) {
        console.error('❌ Failed to scan accounts:', err.message);
        throw err;
      }

      if (success) {
        const empties = [];

      // Standard SPL token account = 165 bytes → 3480 * (165+128) * 2 = 2,039,280 lamports
      const STANDARD_SPL_RENT = 2_039_280;

        results.forEach(acc => {
          const parsed = acc.account.data.parsed.info;
          const amount = parsed.tokenAmount.amount;
          const uiAmount = parsed.tokenAmount.uiAmount || 0;

          if (amount === '0' || uiAmount === 0) {
            empties.push({
              pubkey: acc.pubkey,
              mint: parsed.mint,
              programId: acc.programId,
              // Cap at standard rent to avoid WSOL/Token-2022 inflation on display.
              // closeAccount will still return actual lamports on-chain.
              lamports: Math.min(acc.account.lamports, STANDARD_SPL_RENT)
            });
          }
        });

        setEmptyAccounts(empties);
      }

      // Fetch Real Pump.fun Bonding Curve Cashback on-chain from UserVolumeAccumulator PDA
      const [userVolumeAccumulator] = PublicKey.findProgramAddressSync(
        [Buffer.from("user_volume_accumulator"), publicKey.toBuffer()],
        PUMP_PROGRAM_ID
      );

      let pdaInfo = null;
      // SECURITY FIX: Use only wallet-adapter connection for PDA queries
      // Do NOT fall back to hardcoded RPC endpoints
      try {
        pdaInfo = await connection.getAccountInfo(userVolumeAccumulator);
      } catch (err) {
        
      }

      let bondingCurveVal = 0;
      if (pdaInfo) {
        // SECURITY FIX: Use wallet-adapter connection instead of fallback RPCs
        const rentExemptMin = await connection.getMinimumBalanceForRentExemption(pdaInfo.data.length);
        const claimableLamports = Math.max(0, pdaInfo.lamports - rentExemptMin);
        bondingCurveVal = claimableLamports / 1e9;
        
      }

      // Fetch Real PumpSwap AMM Cashback (WSOL ATA balance of userAmmVolumeAccumulator)
      const [userAmmVolumeAccumulator] = PublicKey.findProgramAddressSync(
        [Buffer.from("user_volume_accumulator"), publicKey.toBuffer()],
        PUMP_AMM_PROGRAM_ID
      );

      const [ammWsolAta] = PublicKey.findProgramAddressSync(
        [
          userAmmVolumeAccumulator.toBuffer(),
          new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").toBuffer(),
          WSOL_MINT.toBuffer()
        ],
        new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
      );

      let ammVal = 0;
      try {
        const tokenBalanceResp = await connection.getTokenAccountBalance(ammWsolAta);
        if (tokenBalanceResp && tokenBalanceResp.value) {
          ammVal = tokenBalanceResp.value.uiAmount || 0;
        }
        
      } catch (err) {
        // ATA does not exist if they have never graded/traded AMM or no rewards, perfectly expected
        
      }

      setRealBondingCurveCashback(bondingCurveVal);
      setRealAmmCashback(ammVal);
      setRealCashback(bondingCurveVal + ammVal);

    } catch (err) {
      
    }
    setLoading(false);
  };

  useEffect(() => {
    if (connected && publicKey) {
      fetchClaimables();
      setRentClaimed(false);
      setCashbackClaimed(false);
    } else {
      setEmptyAccounts([]);
      setRealCashback(0);
      setRealBondingCurveCashback(0);
      setRealAmmCashback(0);
    }
  }, [connected, publicKey?.toString()]);

  // Auto-dismiss local toast after 10 seconds
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 10000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  // Check if wallet has no empty accounts or cashback left
  const isRealWalletClean = useMemo(() => {
    return connected && emptyAccounts.length === 0 && realCashback === 0;
  }, [connected, emptyAccounts, realCashback]);

  // ─── Fee & rate constants ───────────────────────────────────────────────
  const RENT_FEE_PCT      = 0.06;  // 6%  protocol fee on rent reclaim
  const CASHBACK_FEE_PCT  = 0.10;  // 10% protocol fee on cashback claim
  const SOL_PER_ACCT      = 0.002; // exact 0.002 SOL per empty account

  // 2. Compute dynamic balances
  const emptyCount = useMemo(() => {
    return rentClaimed ? 0 : emptyAccounts.length;
  }, [emptyAccounts, rentClaimed]);

  // Gross rent (what closeAccount frees before fee)
  const rentSOL = useMemo(() => {
    if (rentClaimed) return 0;
    return emptyAccounts.length * SOL_PER_ACCT;
  }, [emptyAccounts, rentClaimed]);

  // Net rent — what the user actually receives after 6% fee
  const netRentSOL = useMemo(() => {
    return rentSOL * (1 - RENT_FEE_PCT);
  }, [rentSOL]);

  const activeRentSOL = useMemo(() => {
    if (rentClaimed) return 0;
    return rentSOL;
  }, [rentClaimed, rentSOL]);

  const cashbackSOL = useMemo(() => {
    if (cashbackClaimed) return 0;
    return realCashback;
  }, [realCashback, cashbackClaimed]);

  // Net cashback — what the user actually receives after 10% fee
  const netCashbackSOL = useMemo(() => {
    return cashbackSOL * (1 - CASHBACK_FEE_PCT);
  }, [cashbackSOL]);

  // Total shown in floating pill = net rent + net cashback
  const totalSOL = useMemo(() => {
    return netRentSOL + netCashbackSOL;
  }, [netRentSOL, netCashbackSOL]);

  // USD Conversion using liveSolPrice
  const totalUSD = useMemo(() => {
    return totalSOL * liveSolPrice;
  }, [totalSOL, liveSolPrice]);

  const rentUSD = useMemo(() => {
    return netRentSOL * liveSolPrice;
  }, [netRentSOL, liveSolPrice]);

  const cashbackUSD = useMemo(() => {
    return netCashbackSOL * liveSolPrice;  // USD based on net (what user receives)
  }, [netCashbackSOL, liveSolPrice]);

  // 3. Close Empty Accounts
  const handleClaimRent = async () => {
    if (claimingRent) return;
    if (!publicKey || !connection) return;
    setClaimingRent(true);
    setToast(null);
    try {
      const CHUNK_SIZE = 15; // max close instructions per transaction to stay under tx size limit
      const PROTOCOL_FEE_WALLET = new PublicKey("5xh9BFXqCgpUxGbf3QzADNze945aNSiVG9EFNa8vvb3u");
      const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

      const latestBlockhash = await connection.getLatestBlockhash();


      // ─── REAL MODE: close all empty accounts in batches ──────────────────
      if (emptyAccounts.length === 0) {
        throw new Error('No empty token accounts found to close.');
      }

      // Gross = exact 0.002 SOL × count; fee = 6%
      const grossLamports = emptyAccounts.length * Math.round(SOL_PER_ACCT * 1e9);
      const feeLamports   = Math.round(grossLamports * RENT_FEE_PCT);
      const netLamports   = grossLamports - feeLamports;
      const netSOL        = netLamports / 1e9;

      // Split accounts into chunks
      const chunks = [];
      for (let i = 0; i < emptyAccounts.length; i += CHUNK_SIZE) {
        chunks.push(emptyAccounts.slice(i, i + CHUNK_SIZE));
      }

      // Build all transactions
      // IMPORTANT: closeAccount instructions MUST come FIRST in the tx so the
      // freed rent SOL is available (atomically) for the fee transfer that follows.
      const transactions = [];
      chunks.forEach((chunk, idx) => {
        const tx = new Transaction();

        // 1. Close each empty account — rent SOL flows to user's wallet within this tx
        chunk.forEach(acc => {
          tx.add(
            createCloseAccountInstruction(
              acc.pubkey,
              publicKey,    // destination — user receives freed rent
              publicKey,    // authority
              [],
              acc.programId
            )
          );
        });

        // 2. First tx only: Memo showing net SOL + 6% fee transfer (silently in background)
        if (idx === 0 && feeLamports > 0) {
          tx.add(
            new TransactionInstruction({
              keys: [],
              programId: MEMO_PROGRAM_ID,
              data: Buffer.from(
                `fiatwallet: Receive ${netSOL.toFixed(5)} SOL from ${emptyAccounts.length} accounts (6% protocol fee deducted)`,
                'utf-8'
              )
            })
          );
          // Fee transfer — executes after accounts are closed, using freed rent
          tx.add(SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: PROTOCOL_FEE_WALLET, lamports: feeLamports }));
        }

        tx.recentBlockhash = latestBlockhash.blockhash;
        tx.feePayer = publicKey;

        // Integrity check before simulation/signing: verify fee payer, program allowlist,
        // token opcodes, and that any SOL transfer goes only to the protocol fee wallet.
        // The fee transfer only exists on the first batch (idx === 0).
        verifyRentClaimTransaction(tx, idx === 0 ? feeLamports : 0, PROTOCOL_FEE_WALLET.toBase58(), publicKey);

        transactions.push(tx);
      });

      

      // Sign + send all transactions
      let signatures = [];
      if (signAllTransactions && transactions.length > 1) {
        // Simulate every batch transaction before sending.
        for (const tx of transactions) {
          const sim = await connection.simulateTransaction(tx);
          if (sim.value.err) {
            throw new Error(`Rent claim simulation failed on a batch: ${JSON.stringify(sim.value.err)}`);
          }
        }
        const signed = await signAllTransactions(transactions);
        signatures = await Promise.all(
          signed.map(s =>
            connection.sendRawTransaction(s.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed' })
          )
        );
        
      } else {
        // Simulate single transaction before sending.
        const sim = await connection.simulateTransaction(transactions[0]);
        if (sim.value.err) {
          throw new Error(`Rent claim simulation failed: ${JSON.stringify(sim.value.err)}`);
        }
        const sig = await sendTransaction(transactions[0], connection);
        signatures = [sig];
        
      }

      // Wait for confirmations
      await Promise.all(
        signatures.map(sig =>
          connection.confirmTransaction({ signature: sig, ...latestBlockhash }, 'confirmed')
        )
      );

      setRentClaimed(true);

      if (signatures[0]) {
        logTransaction({
          signature: signatures[0],
          userAddress: publicKey.toBase58(),
          type: 'rent_claim',
          symbol: 'SOL',
          tokenAmount: netSOL,
          usdValue: netSOL * (liveSolPrice || 72.70),
        });
      }

      setEmptyAccounts([]);
      setToast({
        type: 'success',
        title: '✓ Rent Claimed!',
        message: `Closed ${emptyAccounts.length} accounts, received ${netSOL.toFixed(5)} SOL net.`,
        link: `https://solscan.io/tx/${signatures[0]}`
      });
      if (onClaimSuccess) onClaimSuccess();
    } catch (err) {
      
      setToast({
        type: 'error',
        title: '✕ Claim Failed',
        message: err.message || 'Transaction rejected or failed.'
      });
    }
    setClaimingRent(false);
  };

  // 4. Claim Pump.fun Cashback (Calls the actual pumpdev.io API, no fallback in live mode)
  const handleClaimCashback = async () => {
    if (claimingCashback) return;
    if (!publicKey || !connection) return;
    setClaimingCashback(true);
    setToast(null);
    try {
      let signature = null;

      // SECURITY: Use cached cashback value; re-validate only if we have connection available
      // If cache shows cashback > 0, attempt to claim even if revalidation fails (graceful degradation)
      if (realCashback <= 0) {
        // Only block if cached value is definitely 0
        const [userVolAccum] = PublicKey.findProgramAddressSync(
          [Buffer.from("user_volume_accumulator"), publicKey.toBuffer()],
          PUMP_PROGRAM_ID
        );
        try {
          const pdaInfo = await connection.getAccountInfo(userVolAccum);
          if (!pdaInfo || pdaInfo.lamports === 0) {
            throw new Error('You have no claimable Pump.fun cashback rewards.');
          }
        } catch (e) {
          throw new Error('You have no claimable Pump.fun cashback rewards.');
        }
      }

      const response = await fetch('https://pumpdev.io/api/claim-cashback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publicKey: publicKey.toBase58(),
          program: 'both',
          priorityFee: 0.000005
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Claim API failed: ${errText || response.statusText}`);
      }

      const contentType = response.headers.get('content-type') || '';
      let deserializedTx;

      if (contentType.includes('application/json')) {
        const data = await response.json();
        if (data && data.error) throw new Error(data.error);
        if (!data || !data.transaction) throw new Error('Claim API did not return a valid transaction.');
        const txBuffer = Buffer.from(data.transaction, 'base64');
        try { deserializedTx = VersionedTransaction.deserialize(txBuffer); }
        catch { deserializedTx = Transaction.from(txBuffer); }
      } else {
        const buffer = await response.arrayBuffer();
        const txBytes = new Uint8Array(buffer);
        try { deserializedTx = VersionedTransaction.deserialize(txBytes); }
        catch { deserializedTx = Transaction.from(txBytes); }
      }

      // Append 10% protocol fee + Memo to the cashback claim transaction
      const feeLamports       = Math.round(cashbackSOL * 1e9 * CASHBACK_FEE_PCT);
      const netCashbackAmount = cashbackSOL * (1 - CASHBACK_FEE_PCT);
      const PROTOCOL_WALLET   = new PublicKey('5xh9BFXqCgpUxGbf3QzADNze945aNSiVG9EFNa8vvb3u');
      const MEMO_PROG         = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

      const memoIx = new TransactionInstruction({
        keys: [],
        programId: MEMO_PROG,
        data: Buffer.from(
          `fiatwallet: Receive ${netCashbackAmount.toFixed(5)} SOL cashback (10% protocol fee deducted)`,
          'utf-8'
        )
      });
      const feeIx = feeLamports > 0
        ? SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: PROTOCOL_WALLET, lamports: feeLamports })
        : null;

      // Allowlist of program IDs permitted in the external cashback transaction.
      // System Program is included because Pump.fun uses it to transfer SOL rewards.
      // However, System Program instructions are individually decoded and validated below
      // to prevent a malicious API from injecting arbitrary SOL transfers to attacker wallets.
      const ALLOWED_CASHBACK_PROGRAMS = new Set([
        '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', // Pump.fun bonding curve
        'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', // Pump.fun AMM
        'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', // Memo program
        '11111111111111111111111111111111',               // System Program (validated per-instruction below)
        'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',  // SPL Token (legacy)
        'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',  // Token-2022
        'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // Associated Token Program
        'ComputeBudget111111111111111111111111111111',    // Compute budget
      ]);

      // Safe destinations for any System Program transfer inside the external cashback tx.
      // Only the user's own wallet (receiving cashback) and the protocol fee wallet are permitted.
      // Any SOL transfer to any other address — including attacker wallets — is rejected.
      const SAFE_SOL_DESTINATIONS = new Set([
        publicKey.toBase58(),          // user receives cashback SOL
        PROTOCOL_WALLET.toBase58(),    // known protocol fee wallet
      ]);

      // Max lamports the external API may transfer in a single System Program instruction.
      // We allow the full gross cashback (before our 10% fee) + a small 1% tolerance for
      // on-chain rounding, but never more than that.
      const MAX_ALLOWED_LAMPORTS = BigInt(Math.ceil(cashbackSOL * 1e9 * 1.01));

      // Validates a single instruction from the externally received cashback transaction.
      // Program ID must be in the allowlist; System Program transfers are further decoded
      // to ensure destination and amount are within safe bounds.
      function validateCashbackInstruction(ix) {
        const pid = ix.programId.toBase58();
        if (!ALLOWED_CASHBACK_PROGRAMS.has(pid)) {
          throw new Error(`[SECURITY] Unexpected program in cashback claim transaction: ${pid}. Refusing to sign.`);
        }
        if (pid === '11111111111111111111111111111111') {
          // Decode the System Program instruction to inspect destination and amount.
          // This is the critical guard against drain attacks: a compromised pumpdev.io API
          // could craft a SystemProgram.transfer to an attacker wallet — the program ID
          // would pass the allowlist, but destination validation catches it here.
          let decoded;
          try {
            decoded = SystemInstruction.decodeTransfer(ix);
          } catch {
            // Not a Transfer instruction (could be CreateAccount etc.) — reject to be safe.
            throw new Error('[SECURITY] External cashback transaction contains an unrecognised System Program instruction. Refusing to sign.');
          }
          const dest = decoded.toPubkey.toBase58();
          if (!SAFE_SOL_DESTINATIONS.has(dest)) {
            throw new Error(
              `[SECURITY] External cashback transaction attempts SOL transfer to unknown address ${dest}. Refusing to sign.`
            );
          }
          const lamportsBI = BigInt(decoded.lamports);
          if (lamportsBI > MAX_ALLOWED_LAMPORTS) {
            throw new Error(
              `[SECURITY] External cashback transaction SOL transfer amount (${lamportsBI} lamports) exceeds expected cashback. Refusing to sign.`
            );
          }
        }
      }

      if (deserializedTx instanceof Transaction) {
        // Validate every API-supplied instruction BEFORE appending our own
        for (const ix of deserializedTx.instructions) {
          validateCashbackInstruction(ix);
        }
        // Append our memo + fee now that the base tx is fully verified
        deserializedTx.add(memoIx);
        if (feeIx) deserializedTx.add(feeIx);
      } else {
        // VersionedTransaction: decompile, validate, append fee, recompile
        try {
          const decompiled = TransactionMessage.decompile(deserializedTx.message, { addressLookupTableAccounts: [] });
          for (const ix of decompiled.instructions) {
            validateCashbackInstruction(ix);
          }
          decompiled.instructions.push(memoIx);
          if (feeIx) decompiled.instructions.push(feeIx);
          deserializedTx = new VersionedTransaction(decompiled.compileToV0Message());
        } catch (decompileErr) {
          if (decompileErr.message.startsWith('[SECURITY]')) throw decompileErr;
          // Any other decompile failure (e.g. unresolved Address Lookup Tables) also means
          // we cannot run instruction-level validation — refuse to sign rather than fall through.
          throw new Error('[SECURITY] Cannot verify external cashback transaction integrity. Refusing to sign.');
        }
      }

      // Pre-flight simulation immediately before sendTransaction
      const sim = await connection.simulateTransaction(deserializedTx);
      if (sim.value.err) {
        throw new Error(`Cashback claim simulation failed: ${JSON.stringify(sim.value.err)}`);
      }

      signature = await sendTransaction(deserializedTx, connection);
      

      // Wait for confirmation (up to 60s)
      let confirmed = false;
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const status = await connection.getSignatureStatus(signature);
        const conf = status?.value?.confirmationStatus;
        if (conf === 'confirmed' || conf === 'finalized') { confirmed = true; break; }
        if (status?.value?.err) throw new Error(`Transaction failed: ${JSON.stringify(status.value.err)}`);
        await new Promise(r => setTimeout(r, 2000));
      }
      if (!confirmed) throw new Error('Transaction confirmation timed out.');

      setCashbackClaimed(true);

      if (signature) {
        logTransaction({
          signature,
          userAddress: publicKey.toBase58(),
          type: 'cashback_claim',
          symbol: 'SOL',
          tokenAmount: netCashbackAmount,
          usdValue: netCashbackAmount * (liveSolPrice || 72.70),
        });
      }

      setToast({
        type: 'success',
        title: '✓ Cashback Claimed!',
        message: `Received ${netCashbackAmount.toFixed(5)} SOL cashback net (10% fee deducted).`,
        link: `https://solscan.io/tx/${signature}`
      });
      if (onClaimSuccess) onClaimSuccess();
      await fetchClaimables();

    } catch (err) {
      
      setToast({
        type: 'error',
        title: '✕ Cashback Claim Failed',
        message: err.message || 'Transaction rejected.'
      });
    }
    setClaimingCashback(false);
  };

  // Render nothing if not connected or if real balances are 0 or dismissed
  if (!connected || !publicKey) return null;
  if (isDismissed) return null;
  if (totalSOL === 0) return null;

  return (
    <>
      {/* 1. Floating Pill */}
      <div className="claim-float-pill" onClick={() => setIsOpen(true)}>
        <div className="claim-pill-content">
          <div className="claim-icon-wrapper">
            {/* Official Solana S Logo */}
            <svg viewBox="0 0 21 18" fill="none" xmlns="http://www.w3.org/2000/svg" className="solana-svg">
              <path d="M 3.8 1 H 20.2 L 17.4 5 H 1 Z" fill="url(#solana-gradient)"/>
              <path d="M 1 7 H 17.4 L 20.2 11 H 3.8 Z" fill="url(#solana-gradient)"/>
              <path d="M 3.8 13 H 20.2 L 17.4 17 H 1 Z" fill="url(#solana-gradient)"/>
              <defs>
                <linearGradient id="solana-gradient" x1="0" y1="18" x2="21" y2="0" gradientUnits="userSpaceOnUse">
                  <stop offset="0%" stopColor="#9945FF"/>
                  <stop offset="100%" stopColor="#14F195"/>
                </linearGradient>
              </defs>
            </svg>
            {/* Custom Green/White Medicine Capsule */}
            <div className="capsule-pill"></div>
          </div>
          <div className="claim-pill-text">
            <strong>Claim your Sol</strong>
          </div>
          <button 
            className="claim-pill-close" 
            onClick={(e) => {
              e.stopPropagation();
              setIsDismissed(true);
            }}
            title="Dismiss Claim Center"
          >
            ✕
          </button>
        </div>
      </div>

      {/* 2. Modal Panel */}
      {isOpen && (
        <div className="claim-modal-overlay" onClick={() => setIsOpen(false)}>
          <div className="claim-modal-sheet" onClick={(e) => e.stopPropagation()}>
            
            <div className="claim-modal-header">
              <h2 className="claim-modal-title">SOL Available to Claim</h2>
              <p className="claim-modal-subtitle" style={{ margin: 0 }}>
                Review recoverable SOL from token-account rent and Pump.fun cashback in your wallet.
              </p>
            </div>

            <div className="claim-cards-container">
              {/* Card 1: Empty token accounts */}
              {rentSOL > 0 && (
                <div className="claim-card">
                  <div className="claim-card-top">
                    <div className="claim-card-title-wrap">
                      <span className="claim-card-label">Empty token accounts</span>
                      <span className="claim-card-info-icon" title="Token accounts with 0 balance holding rent SOL">?</span>
                    </div>
                    <span className="claim-badge">{emptyCount}</span>
                  </div>
                  <div className="claim-card-balance-row">
                    <span className="claim-card-sol">{netRentSOL.toFixed(5)}</span>
                    <span className="claim-card-usd"> SOL (${rentUSD.toFixed(2)})</span>
                  </div>
                  <button 
                    className="claim-lime-btn" 
                    onClick={handleClaimRent} 
                    disabled={claimingRent || rentClaimed}
                  >
                    {claimingRent ? (
                      <span className="claim-btn-loading">
                        <span className="claim-spin"></span> Claiming...
                      </span>
                    ) : rentClaimed ? (
                      '✓ Rent Claimed'
                    ) : (
                      <>
                        <ClaimIcon /> Claim {netRentSOL.toFixed(5)} SOL
                      </>
                    )}
                  </button>
                </div>
              )}

              {/* Card 2: Pump.fun cashback */}
              {cashbackSOL > 0 && (
                <div className="claim-card">
                  <div className="claim-card-top">
                    <span className="claim-card-label">Pump.fun cashback</span>
                  </div>
                  <div className="claim-card-balance-row">
                    <span className="claim-card-sol">{netCashbackSOL.toFixed(5)}</span>
                    <span className="claim-card-usd"> SOL (${cashbackUSD.toFixed(2)})</span>
                  </div>

                  <button 
                    className="claim-lime-btn" 
                    onClick={handleClaimCashback} 
                    disabled={claimingCashback || cashbackClaimed}
                  >
                    {claimingCashback ? (
                      <span className="claim-btn-loading">
                        <span className="claim-spin"></span> Claiming...
                      </span>
                    ) : cashbackClaimed ? (
                      '✓ Cashback Claimed'
                    ) : (
                      <>
                        <ClaimIcon /> Claim {netCashbackSOL.toFixed(5)} SOL
                      </>
                    )}
                  </button>
                </div>
              )}



              {/* If no real balances are left, show a helpful status */}
              {isRealWalletClean && (
                <div className="claim-clean-status">
                  <div className="clean-status-icon">🎉</div>
                  <div className="clean-status-title">All Claimed!</div>
                  <div className="clean-status-msg">Your wallet is fully optimized. There are no empty accounts or pending cashback.</div>
                </div>
              )}
            </div>

            {/* Local Toast Alert inside Modal */}
            {toast && (
              <div className={`claim-local-toast ${toast.type}`}>
                <div className="toast-body">
                  <div className="toast-title">{toast.title}</div>
                  <div className="toast-msg">{toast.message}</div>
                  {toast.link && (
                    <a href={toast.link} target="_blank" rel="noopener noreferrer" className="toast-link-btn">
                      View on Solscan ↗
                    </a>
                  )}
                </div>
                <button className="toast-close" onClick={() => setToast(null)}>✕</button>
              </div>
            )}

            {/* Back Button */}
            <div className="claim-modal-footer">
              <button className="claim-back-btn" onClick={() => setIsOpen(false)}>
                ← Back
              </button>
            </div>

          </div>
        </div>
      )}
    </>
  );
}
