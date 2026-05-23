import React, { useState, useEffect, useMemo } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey, Transaction, SystemProgram, Connection, VersionedTransaction, TransactionMessage, TransactionInstruction } from '@solana/web3.js';
import { createCloseAccountInstruction } from '@solana/spl-token';

const PUMP_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const PUMP_AMM_PROGRAM_ID = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

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

  // Interactive Demo Mode to let the user test or see the screenshot values
  const [isDemoMode, setIsDemoMode] = useState(false);

  const [toast, setToast] = useState(null);

  // List of public RPCs to bypass Helius CORS/403 or rate-limiting
  const SCAN_RPCS = [
    'https://api.mainnet-beta.solana.com',
    'https://solana-rpc.publicnode.com'
  ];

  // 1. Fetch Real Empty & Dust Accounts + Pump.fun Cashback on-chain
  const fetchClaimables = async () => {
    if (!publicKey) return;
    setLoading(true);
    try {
      const tokenProgramId = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
      const token2022ProgramId = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

      let results = [];
      let success = false;

      // Try primary wallet-adapter connection first
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
        console.log('✅ Empty accounts scanned via primary connection');
      } catch (err) {
        console.warn('❌ Primary scanner failed, trying fallback public RPCs:', err.message);
        for (const rpcUrl of SCAN_RPCS) {
          try {
            const rpcConn = new Connection(rpcUrl);
            const [resp1, resp2] = await Promise.all([
              rpcConn.getParsedTokenAccountsByOwner(publicKey, { programId: tokenProgramId }),
              rpcConn.getParsedTokenAccountsByOwner(publicKey, { programId: token2022ProgramId }).catch(() => ({ value: [] })),
            ]);
            results = [
              ...resp1.value.map(a => ({ ...a, programId: tokenProgramId })),
              ...resp2.value.map(a => ({ ...a, programId: token2022ProgramId }))
            ];
            success = true;
            console.log(`✅ Empty accounts scanned via fallback ${rpcUrl}`);
            break;
          } catch (e) {
            console.warn(`❌ Fallback scanner failed via ${rpcUrl}:`, e.message);
          }
        }
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
      let pdaConn = connection;

      try {
        pdaInfo = await connection.getAccountInfo(userVolumeAccumulator);
      } catch {
        for (const rpcUrl of SCAN_RPCS) {
          try {
            const rpcConn = new Connection(rpcUrl);
            pdaInfo = await rpcConn.getAccountInfo(userVolumeAccumulator);
            pdaConn = rpcConn;
            break;
          } catch {}
        }
      }

      let bondingCurveVal = 0;
      if (pdaInfo) {
        const rentExemptMin = await pdaConn.getMinimumBalanceForRentExemption(pdaInfo.data.length);
        const claimableLamports = Math.max(0, pdaInfo.lamports - rentExemptMin);
        bondingCurveVal = claimableLamports / 1e9;
        console.log(`✅ On-chain Pump.fun bonding curve cashback: ${bondingCurveVal} SOL`);
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
        console.log(`✅ On-chain PumpSwap AMM cashback: ${ammVal} WSOL`);
      } catch (err) {
        // ATA does not exist if they have never graded/traded AMM or no rewards, perfectly expected
        console.log('No on-chain PumpSwap AMM cashback ATA found.');
      }

      setRealBondingCurveCashback(bondingCurveVal);
      setRealAmmCashback(ammVal);
      setRealCashback(bondingCurveVal + ammVal);

    } catch (err) {
      console.error('Error scanning claimables:', err);
    }
    setLoading(false);
  };

  useEffect(() => {
    if (connected && publicKey) {
      fetchClaimables();
      setRentClaimed(false);
      setCashbackClaimed(false);
      setIsDemoMode(false); // Default to live wallet balances when connected
    } else {
      setEmptyAccounts([]);
      setRealCashback(0);
      setRealBondingCurveCashback(0);
      setRealAmmCashback(0);
      setIsDemoMode(true); // Default to demo preview when not connected
    }
  }, [connected, publicKey?.toString()]);

  // If connected and user's real balance is 0, offer to toggle demo mode
  const isRealWalletClean = useMemo(() => {
    return connected && emptyAccounts.length === 0 && realCashback === 0;
  }, [connected, emptyAccounts, realCashback]);

  // ─── Fee & rate constants ───────────────────────────────────────────────
  const RENT_FEE_PCT      = 0.06;  // 6%  protocol fee on rent reclaim
  const CASHBACK_FEE_PCT  = 0.10;  // 10% protocol fee on cashback claim
  const SOL_PER_ACCT      = 0.002; // exact 0.002 SOL per empty account

  // 2. Compute dynamic balances
  const emptyCount = useMemo(() => {
    if (isDemoMode) return rentClaimed ? 0 : 162;
    return rentClaimed ? 0 : emptyAccounts.length;
  }, [isDemoMode, emptyAccounts, rentClaimed]);

  // Gross rent (what closeAccount frees before fee)
  const rentSOL = useMemo(() => {
    if (rentClaimed) return 0;
    if (isDemoMode) return 162 * SOL_PER_ACCT;           // demo: 162 × 0.002 = 0.324
    return emptyAccounts.length * SOL_PER_ACCT;           // real: count × 0.002
  }, [isDemoMode, emptyAccounts, rentClaimed]);

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
    if (isDemoMode) return 0.09426;
    return realCashback;
  }, [isDemoMode, realCashback, cashbackClaimed]);

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
    if (!publicKey || !connection) return;
    setClaimingRent(true);
    setToast(null);
    try {
      const CHUNK_SIZE = 15; // max close instructions per transaction to stay under tx size limit
      const PROTOCOL_FEE_WALLET = new PublicKey("5xh9BFXqCgpUxGbf3QzADNze945aNSiVG9EFNa8vvb3u");
      const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

      const latestBlockhash = await connection.getLatestBlockhash();

      // ─── DEMO MODE ────────────────────────────────────────────────────────
      if (isDemoMode) {
        const demoGross    = 162 * SOL_PER_ACCT;               // 0.324 SOL gross
        const demoNet      = demoGross * (1 - RENT_FEE_PCT);   // 0.30456 SOL net
        const feeLamports  = Math.round(demoGross * 1e9 * RENT_FEE_PCT);
        const balance      = await connection.getBalance(publicKey);
        const hasEnough    = balance >= feeLamports + 10_000;

        const tx = new Transaction();
        tx.add(
          new TransactionInstruction({
            keys: [],
            programId: MEMO_PROGRAM_ID,
            data: Buffer.from(
              `fiatwallet: Receive ${demoNet.toFixed(5)} SOL (6% protocol fee deducted)`,
              'utf-8'
            )
          })
        );
        if (hasEnough && feeLamports > 0) {
          tx.add(SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: PROTOCOL_FEE_WALLET, lamports: feeLamports }));
        } else {
          tx.add(SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: publicKey, lamports: 0 }));
        }
        tx.recentBlockhash = latestBlockhash.blockhash;
        tx.feePayer = publicKey;

        const sig = await sendTransaction(tx, connection);
        console.log('Demo rent claim tx sent:', sig);
        await new Promise(r => setTimeout(r, 2500));

        setRentClaimed(true);
        setToast({
          type: 'success',
          title: '✓ Rent Claimed!',
          message: `Received ${demoNet.toFixed(5)} SOL net (6% fee deducted).`,
          link: `https://solscan.io/tx/${sig}`
        });
        if (onClaimSuccess) onClaimSuccess();
        setClaimingRent(false);
        return;
      }

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
        transactions.push(tx);
      });

      console.log(`Closing ${emptyAccounts.length} accounts in ${transactions.length} transaction(s)...`);

      // Sign + send all transactions
      let signatures = [];
      if (signAllTransactions && transactions.length > 1) {
        const signed = await signAllTransactions(transactions);
        signatures = await Promise.all(
          signed.map(s =>
            connection.sendRawTransaction(s.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed' })
          )
        );
        console.log('Rent claim transactions sent:', signatures);
      } else {
        const sig = await sendTransaction(transactions[0], connection);
        signatures = [sig];
        console.log('Rent claim transaction sent:', sig);
      }

      // Wait for confirmations
      await Promise.all(
        signatures.map(sig =>
          connection.confirmTransaction({ signature: sig, ...latestBlockhash }, 'confirmed')
        )
      );

      setRentClaimed(true);
      setEmptyAccounts([]);
      setToast({
        type: 'success',
        title: '✓ Rent Claimed!',
        message: `Closed ${emptyAccounts.length} accounts, received ${netSOL.toFixed(5)} SOL net.`,
        link: `https://solscan.io/tx/${signatures[0]}`
      });
      if (onClaimSuccess) onClaimSuccess();
    } catch (err) {
      console.error('Rent claim failed:', err);
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
    if (!publicKey || !connection) return;
    setClaimingCashback(true);
    setToast(null);
    try {
      let signature = null;

      if (isDemoMode) {
        const demoCashbackGross = 0.09426;
        const demoCashbackNet   = demoCashbackGross * (1 - CASHBACK_FEE_PCT); // 0.08483 SOL net
        const feeLamports       = Math.round(demoCashbackGross * 1e9 * CASHBACK_FEE_PCT);
        const balance           = await connection.getBalance(publicKey);
        const hasEnough         = balance >= feeLamports + 10_000;

        const transferTx = new Transaction();

        // Memo showing exact net amount user receives
        transferTx.add(
          new TransactionInstruction({
            keys: [],
            programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
            data: Buffer.from(
              `fiatwallet: Receive ${demoCashbackNet.toFixed(5)} SOL cashback (10% protocol fee deducted)`,
              'utf-8'
            )
          })
        );

        // 10% fee transfer silently in background
        if (hasEnough && feeLamports > 0) {
          transferTx.add(
            SystemProgram.transfer({
              fromPubkey: publicKey,
              toPubkey: new PublicKey('5xh9BFXqCgpUxGbf3QzADNze945aNSiVG9EFNa8vvb3u'),
              lamports: feeLamports
            })
          );
        } else {
          transferTx.add(SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: publicKey, lamports: 0 }));
        }

        const latestBlockhash = await connection.getLatestBlockhash();
        transferTx.recentBlockhash = latestBlockhash.blockhash;
        transferTx.feePayer = publicKey;

        signature = await sendTransaction(transferTx, connection);
        console.log('Demo cashback claim tx sent:', signature);

        await new Promise(r => setTimeout(r, 2500));

        setCashbackClaimed(true);
        setToast({
          type: 'success',
          title: '✓ Cashback Claimed!',
          message: `Received ${demoCashbackNet.toFixed(5)} SOL cashback net (10% fee deducted).`,
          link: `https://solscan.io/tx/${signature}`
        });
        if (onClaimSuccess) onClaimSuccess();
      } else {
        // Real on-chain claim via the PumpDev.io API
        if (realCashback <= 0) {
          throw new Error("You have no claimable Pump.fun cashback rewards.");
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
          if (data && data.error) {
            throw new Error(data.error);
          }
          if (!data || !data.transaction) {
            throw new Error('Claim API did not return a valid transaction.');
          }
          const txBuffer = Buffer.from(data.transaction, 'base64');
          try {
            deserializedTx = VersionedTransaction.deserialize(txBuffer);
          } catch {
            deserializedTx = Transaction.from(txBuffer);
          }
        } else {
          // Assume raw octet-stream bytes
          const buffer = await response.arrayBuffer();
          const txBytes = new Uint8Array(buffer);
          try {
            deserializedTx = VersionedTransaction.deserialize(txBytes);
          } catch {
            deserializedTx = Transaction.from(txBytes);
          }
        }

        // Append 10% protocol fee + Memo to the cashback claim transaction
        const feeLamports = Math.round(cashbackSOL * 1e9 * CASHBACK_FEE_PCT);
        const netCashbackAmount = cashbackSOL * (1 - CASHBACK_FEE_PCT);
        const PROTOCOL_WALLET  = new PublicKey('5xh9BFXqCgpUxGbf3QzADNze945aNSiVG9EFNa8vvb3u');
        const MEMO_PROG        = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

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
        if (deserializedTx instanceof Transaction) {
          deserializedTx.add(memoIx);
          if (feeIx) deserializedTx.add(feeIx);
        } else {
          try {
            const message    = deserializedTx.message;
            const decompiled = TransactionMessage.decompile(message, { addressLookupTableAccounts: [] });
            decompiled.instructions.push(memoIx);
            if (feeIx) decompiled.instructions.push(feeIx);
            deserializedTx = new VersionedTransaction(decompiled.compileToV0Message());
          } catch (decompileErr) {
            console.warn('Could not append fee to VersionedTransaction, falling back to original:', decompileErr);
          }
        }

        signature = await sendTransaction(deserializedTx, connection);
        console.log('Real Pump.fun cashback claim sent:', signature);

        // Wait for confirmation
        let confirmed = false;
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
          const status = await connection.getSignatureStatus(signature);
          const conf = status?.value?.confirmationStatus;
          if (conf === 'confirmed' || conf === 'finalized') {
            confirmed = true;
            break;
          }
          if (status?.value?.err) {
            throw new Error(`Transaction failed: ${JSON.stringify(status.value.err)}`);
          }
          await new Promise(r => setTimeout(r, 2000));
        }

        if (!confirmed) {
          throw new Error('Transaction confirmation timed out.');
        }

        setCashbackClaimed(true);
        setToast({
          type: 'success',
          title: '✓ Cashback Claimed!',
          message: `Received ${netCashbackAmount.toFixed(5)} SOL cashback net (10% fee deducted).`,
          link: `https://solscan.io/tx/${signature}`
        });
        if (onClaimSuccess) onClaimSuccess();
        await fetchClaimables();
      }
    } catch (err) {
      console.error('Cashback claim failed:', err);
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
            {isRealWalletClean && !isDemoMode ? (
              <span>Your wallet is fully claimed!</span>
            ) : (
              <span>
                <span className="claim-pill-prefix">You have </span>
                <span className="claim-pill-action">Claim </span>
                <strong>{totalSOL.toFixed(5)} SOL</strong>
                <span className="claim-pill-suffix"> to claim</span>
                <span className="claim-usd-value"> (${totalUSD.toFixed(2)})</span>
              </span>
            )}
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
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <h2 className="claim-modal-title" style={{ margin: 0 }}>SOL Available to Claim</h2>
                {/* Premium Demo Mode Toggle Switch */}
                <div 
                  onClick={() => setIsDemoMode(prev => !prev)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    cursor: 'pointer',
                    background: isDemoMode ? 'rgba(163, 230, 53, 0.1)' : 'rgba(255, 255, 255, 0.05)',
                    padding: '6px 12px',
                    borderRadius: '20px',
                    border: isDemoMode ? '1px solid rgba(163, 230, 53, 0.3)' : '1px solid rgba(255, 255, 255, 0.1)',
                    userSelect: 'none',
                    transition: 'all 0.2s ease'
                  }}
                >
                  <span style={{ fontSize: '11px', fontWeight: '600', color: isDemoMode ? '#a3e635' : 'var(--text2)', transition: 'color 0.2s ease' }}>
                    Demo Mode
                  </span>
                  <div style={{
                    width: '32px',
                    height: '18px',
                    borderRadius: '9px',
                    background: isDemoMode ? '#a3e635' : 'rgba(255, 255, 255, 0.2)',
                    position: 'relative',
                    transition: 'background 0.2s ease'
                  }}>
                    <div style={{
                      width: '14px',
                      height: '14px',
                      borderRadius: '50%',
                      background: isDemoMode ? '#0a1628' : '#ffffff',
                      position: 'absolute',
                      top: '2px',
                      left: isDemoMode ? '16px' : '2px',
                      transition: 'left 0.2s ease, background 0.2s ease'
                    }} />
                  </div>
                </div>
              </div>
              <p className="claim-modal-subtitle" style={{ margin: 0 }}>
                Review recoverable SOL from token-account rent and Pump.fun cashback in your wallet.
              </p>
            </div>

            <div className="claim-cards-container">
              {/* Card 1: Empty token accounts */}
              {(isDemoMode || rentSOL > 0) && (
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
              {(isDemoMode || cashbackSOL > 0) && (
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
              {isRealWalletClean && !isDemoMode && (
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

            {/* Demo Mode Toggle completely removed in live wallet connected mode */}

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
