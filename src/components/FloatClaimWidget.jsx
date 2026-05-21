import React, { useState, useEffect, useMemo } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey, Transaction, SystemProgram, Connection, VersionedTransaction } from '@solana/web3.js';
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

        results.forEach(acc => {
          const parsed = acc.account.data.parsed.info;
          const amount = parsed.tokenAmount.amount;
          const uiAmount = parsed.tokenAmount.uiAmount || 0;

          if (amount === '0' || uiAmount === 0) {
            empties.push({
              pubkey: acc.pubkey,
              mint: parsed.mint,
              programId: acc.programId
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

  // 2. Compute dynamic balances
  const emptyCount = useMemo(() => {
    if (isDemoMode) return rentClaimed ? 0 : 162;
    return rentClaimed ? 0 : emptyAccounts.length;
  }, [isDemoMode, emptyAccounts, rentClaimed]);

  const rentSOL = useMemo(() => {
    if (rentClaimed) return 0;
    if (isDemoMode) return 0.30201;
    // ~0.002039 SOL per account
    return emptyAccounts.length * 0.002039;
  }, [isDemoMode, emptyAccounts, rentClaimed]);

  const activeRentSOL = useMemo(() => {
    if (rentClaimed) return 0;
    return rentSOL;
  }, [rentClaimed, rentSOL]);


  const cashbackSOL = useMemo(() => {
    if (cashbackClaimed) return 0;
    if (isDemoMode) return 0.09426;
    return realCashback;
  }, [isDemoMode, realCashback, cashbackClaimed]);

  // Total Claimable SOL (Pill includes Empty Accounts + Pump.fun Cashback)
  const totalSOL = useMemo(() => {
    return rentSOL + cashbackSOL;
  }, [rentSOL, cashbackSOL]);

  // USD Conversion using liveSolPrice
  const totalUSD = useMemo(() => {
    return totalSOL * liveSolPrice;
  }, [totalSOL, liveSolPrice]);

  const rentUSD = useMemo(() => {
    return rentSOL * liveSolPrice;
  }, [rentSOL, liveSolPrice]);

  const cashbackUSD = useMemo(() => {
    return cashbackSOL * liveSolPrice;
  }, [cashbackSOL, liveSolPrice]);

  // 3. Close Empty Accounts (Real Solana transaction, with highly secure mock fallback)
  const handleClaimRent = async () => {
    if (!publicKey || !connection) return;
    setClaimingRent(true);
    setToast(null);
    try {
      if (isDemoMode) {
        // High-Fidelity Demo mode: Let user sign a valid 0-SOL self-transfer
        // In demo mode, let's simulate up to 3 transactions (60 accounts) to avoid Blowfish timeouts
        const totalAccounts = rentClaimed ? 0 : 162;
        let chunkSize = 20;
        if (totalAccounts > 100) {
          chunkSize = 28;
        } else if (totalAccounts > 40) {
          chunkSize = 25;
        }
        const totalChunks = Math.ceil(totalAccounts / chunkSize);
        
        const transactions = [];
        for (let i = 0; i < totalChunks; i++) {
          transactions.push(
            new Transaction().add(
              SystemProgram.transfer({
                fromPubkey: publicKey,
                toPubkey: publicKey,
                lamports: 0
              })
            )
          );
        }

        const latestBlockhash = await connection.getLatestBlockhash();
        transactions.forEach(tx => {
          tx.recentBlockhash = latestBlockhash.blockhash;
          tx.feePayer = publicKey;
        });

        let signature = '';
        if (signAllTransactions && transactions.length > 1) {
          const signedTxs = await signAllTransactions(transactions);
          const sigs = await Promise.all(
            signedTxs.map(signedTx => 
              connection.sendRawTransaction(signedTx.serialize(), {
                skipPreflight: false,
                preflightCommitment: 'confirmed'
              })
            )
          );
          signature = sigs[0];
          console.log('Simulated rent claim transactions sent:', sigs);
        } else {
          // Fallback or single transaction
          const sig = await sendTransaction(transactions[0], connection);
          signature = sig;
          console.log('Simulated rent claim transaction sent:', sig);
        }

        // Wait a few seconds for visual confirmation
        await new Promise(r => setTimeout(r, 3000));

        setRentClaimed(true);
        setToast({
          type: 'success',
          title: '✓ Rent Claimed (Demo Mode)!',
          message: `Successfully reclaimed ${activeRentSOL.toFixed(5)} SOL from empty accounts in ${totalChunks} batched transactions (Demo).`,
          link: signature ? `https://solscan.io/tx/${signature}` : undefined
        });
        if (onClaimSuccess) onClaimSuccess();
      } else {
        // Real on-chain rent claim
        if (emptyAccounts.length === 0) {
          throw new Error("You have no empty token accounts to claim rent from.");
        }

        // Determine optimal chunk size based on the amount of tokens users are closing
        // to minimize the number of transactions the user needs to sign.
        // Solana standard transactions can safely support up to 28 close account instructions
        // when owner and fee payer are the same public key.
        const totalAccounts = emptyAccounts.length;
        let chunkSize = 20;
        if (totalAccounts > 100) {
          chunkSize = 28; // Pack extra tight for large volumes to minimize signatures
        } else if (totalAccounts > 40) {
          chunkSize = 25; // Pack moderately tight
        }

        // Chunk empty accounts based on the dynamic chunkSize
        const chunks = [];
        for (let i = 0; i < totalAccounts; i += chunkSize) {
          chunks.push(emptyAccounts.slice(i, i + chunkSize));
        }

        // Claim ALL empty accounts at once! No more hard slice/limit.
        const activeChunks = chunks;

        const latestBlockhash = await connection.getLatestBlockhash();

        const transactions = activeChunks.map(chunk => {
          const tx = new Transaction();
          chunk.forEach(acc => {
            tx.add(
              createCloseAccountInstruction(
                acc.pubkey,
                publicKey,
                publicKey,
                [],
                acc.programId
              )
            );
          });
          tx.recentBlockhash = latestBlockhash.blockhash;
          tx.feePayer = publicKey;
          return tx;
        });

        let signatures = [];

        if (transactions.length > 1) {
          if (!signAllTransactions) {
            throw new Error("Your wallet does not support signing multiple transactions at once. Please claim in smaller batches.");
          }
          const signedTxs = await signAllTransactions(transactions);
          signatures = await Promise.all(
            signedTxs.map(signedTx =>
              connection.sendRawTransaction(signedTx.serialize(), {
                skipPreflight: false,
                preflightCommitment: 'confirmed'
              })
            )
          );
        } else {
          // Single transaction can use standard sendTransaction
          const sig = await sendTransaction(transactions[0], connection);
          signatures = [sig];
        }

        console.log('Real rent claim transaction(s) sent:', signatures);

        // Wait for all signatures to confirm
        const succeeded = new Array(signatures.length).fill(false);
        const pendingIndices = new Set(signatures.map((_, i) => i));
        const deadline = Date.now() + 60_000;

        while (Date.now() < deadline && pendingIndices.size > 0) {
          const currentIndices = Array.from(pendingIndices);
          const currentSigs = currentIndices.map(i => signatures[i]);
          
          try {
            const statuses = await connection.getSignatureStatuses(currentSigs);
            if (statuses && statuses.value) {
              statuses.value.forEach((status, idx) => {
                const globalIdx = currentIndices[idx];
                if (status) {
                  if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
                    pendingIndices.delete(globalIdx);
                    succeeded[globalIdx] = true;
                  } else if (status.err) {
                    pendingIndices.delete(globalIdx);
                    console.error(`Transaction index ${globalIdx} failed:`, status.err);
                  }
                }
              });
            }
          } catch (e) {
            console.warn('Error fetching signature statuses:', e);
          }

          if (pendingIndices.size > 0) {
            await new Promise(r => setTimeout(r, 2000));
          }
        }

        const confirmedCount = succeeded.filter(Boolean).length;
        let totalAccountsClosed = 0;
        let totalReclaimedSOL = 0;

        succeeded.forEach((success, idx) => {
          if (success) {
            const chunkLength = activeChunks[idx].length;
            totalAccountsClosed += chunkLength;
            totalReclaimedSOL += chunkLength * 0.002039;
          }
        });

        if (confirmedCount === activeChunks.length) {
          setRentClaimed(true);
          setToast({
            type: 'success',
            title: '✓ Rent Claimed!',
            message: `Successfully reclaimed ${totalReclaimedSOL.toFixed(5)} SOL from ${totalAccountsClosed} empty accounts.`,
            link: `https://solscan.io/account/${publicKey.toBase58()}`
          });
        } else if (confirmedCount > 0) {
          setToast({
            type: 'success',
            title: '✓ Rent Partially Reclaimed',
            message: `Successfully reclaimed ${totalReclaimedSOL.toFixed(5)} SOL from ${totalAccountsClosed} empty accounts. (${confirmedCount}/${activeChunks.length} batches succeeded).`,
            link: `https://solscan.io/account/${publicKey.toBase58()}`
          });
        } else {
          throw new Error("All batched transactions failed to confirm.");
        }

        if (onClaimSuccess) onClaimSuccess();
        await fetchClaimables();
      }
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
        // High-Fidelity confirmation vehicle: Let user sign a real, valid 0-SOL self-transfer transaction
        // which succeeds natively on mainnet, yielding a real signature and Solscan verification
        const transferTx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: publicKey,
            toPubkey: publicKey,
            lamports: 0
          })
        );

        const latestBlockhash = await connection.getLatestBlockhash();
        transferTx.recentBlockhash = latestBlockhash.blockhash;
        transferTx.feePayer = publicKey;

        signature = await sendTransaction(transferTx, connection);
        console.log('Simulated cashback claim transaction sent:', signature);

        // Wait a few seconds for visual confirmation
        await new Promise(r => setTimeout(r, 3000));

        setCashbackClaimed(true);
        setToast({
          type: 'success',
          title: '✓ Cashback Claimed (Demo)!',
          message: `Successfully claimed ${cashbackSOL.toFixed(5)} SOL Pump.fun cashback!`,
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
          message: `Successfully claimed ${cashbackSOL.toFixed(5)} SOL Pump.fun cashback!`,
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
            {/* Solana SVG Logo with diagonal gradient and transparent background */}
            <svg className="solana-logo-svg" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
              <defs>
                <linearGradient id="solana-gradient-logo" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#14F195" />
                  <stop offset="50%" stopColor="#22D3EE" />
                  <stop offset="100%" stopColor="#9945FF" />
                </linearGradient>
              </defs>
              <path 
                d="M356 197q-2 2-6 2H124a9 9 0 0 1-6-15l37-38q3-3 7-3h226c8 0 12 9 6 15zm0 170q-2 3-6 3H124a9 9 0 0 1-6-15l37-37q3-3 7-3h226c8 0 12 9 6 15zm0-136q-2-2-6-2H124a9 9 0 0 0-6 15l37 37q3 2 7 2h226c8 0 12-9 6-15z" 
                fill="url(#solana-gradient-logo)"
              />
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
              <h2 className="claim-modal-title">SOL Available to Claim</h2>
              <p className="claim-modal-subtitle">
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
                    <span className="claim-card-sol">{rentSOL.toFixed(5)}</span>
                    <span className="claim-card-usd"> SOL (${rentUSD.toFixed(2)})</span>
                  </div>
                  <button 
                    className="claim-orange-btn" 
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
                        <ClaimIcon /> Claim {activeRentSOL.toFixed(5)} SOL
                      </>
                    )}
                  </button>
                  {/* Subtle info text showing optimized batching */}
                  {!rentClaimed && emptyCount > 0 && (
                    <div className="claim-batch-subtext" style={{ fontSize: '11px', color: '#a0a0a0', marginTop: '8px', textAlign: 'center', opacity: '0.8', lineHeight: '1.4' }}>
                      Optimized dynamically into {Math.ceil(emptyCount / (emptyCount > 100 ? 28 : emptyCount > 40 ? 25 : 20))} transactions to claim all rent at once.
                    </div>
                  )}
                </div>
              )}

              {/* Card 2: Pump.fun cashback */}
              {(isDemoMode || cashbackSOL > 0) && (
                <div className="claim-card">
                  <div className="claim-card-top">
                    <span className="claim-card-label">Pump.fun cashback</span>
                  </div>
                  <div className="claim-card-balance-row">
                    <span className="claim-card-sol">{cashbackSOL.toFixed(5)}</span>
                    <span className="claim-card-usd"> SOL (${cashbackUSD.toFixed(2)})</span>
                  </div>

                  <button 
                    className="claim-orange-btn" 
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
                        <ClaimIcon /> Claim {cashbackSOL.toFixed(5)} SOL
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
