/**
 * StakeModal.jsx
 *
 * Premium overlay for placing USDC sports bets on Solana Mainnet.
 * Connects to the TxODDs program via bettingService.js.
 *
 * Props:
 *   game       - { id, participant1, participant2, odds: { home, draw, away }, sport, competition }
 *   outcomeKey - "home" | "draw" | "away"
 *   onClose    - callback to dismiss the modal
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import {
  getUsdcBalance,
  buildPlaceBetTransaction,
  OUTCOME,
} from '../services/bettingService';

// ── Helpers ───────────────────────────────────────────────────────────────────

const OUTCOME_LABELS = { home: '1', draw: 'X', away: '2' };
const OUTCOME_NAMES  = { home: 'Home Win', draw: 'Draw', away: 'Away Win' };
const OUTCOME_IDX    = { home: OUTCOME.HOME, draw: OUTCOME.DRAW, away: OUTCOME.AWAY };

const PRESET_AMOUNTS = [1, 5, 10, 25, 50, 100];

function fmt(n, dec = 2) {
  return Number(n).toFixed(dec);
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function StakeModal({ game, outcomeKey, onClose }) {
  const { publicKey, connected, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const { setVisible } = useWalletModal();

  const [stakeInput, setStakeInput] = useState('5');
  const [usdcBalance, setUsdcBalance] = useState(null);
  const [step, setStep] = useState('idle'); // idle | confirm | signing | sending | success | error
  const [txSig, setTxSig] = useState(null);
  const [errorMsg, setErrorMsg] = useState('');

  const odds = game?.odds?.[outcomeKey] ?? '-';
  const stakeAmount = parseFloat(stakeInput) || 0;
  const potentialReturn = stakeAmount > 0 && odds !== '-'
    ? fmt(stakeAmount * parseFloat(odds))
    : '-';
  const profit = stakeAmount > 0 && odds !== '-'
    ? fmt(stakeAmount * parseFloat(odds) - stakeAmount)
    : '-';

  // Fetch USDC balance when wallet is connected
  useEffect(() => {
    if (!connected || !publicKey) { setUsdcBalance(null); return; }
    getUsdcBalance(connection, publicKey).then(setUsdcBalance);
  }, [connected, publicKey, connection]);

  // Dismiss on Escape key
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const handlePlaceBet = useCallback(async () => {
    if (!connected || !publicKey) { setVisible(true); return; }
    
    // Prevent actual betting and show "Coming soon" popup
    alert('Coming soon!');
    return;

    if (stakeAmount < 1) { setErrorMsg('Minimum stake is 1 USDC.'); return; }
    setStep('signing');

    try {
      const { transaction, lastValidBlockHeight } = await buildPlaceBetTransaction(
        connection,
        publicKey,
        game.id,
        OUTCOME_IDX[outcomeKey],
        stakeAmount
      );

      setStep('sending');
      const signature = await sendTransaction(transaction, connection, {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      });

      // Wait for confirmation
      const confirmation = await connection.confirmTransaction(
        { signature, lastValidBlockHeight, blockhash: transaction.recentBlockhash },
        'confirmed'
      );

      if (confirmation?.value?.err) {
        throw new Error('Transaction confirmed but execution failed. Check the explorer for details.');
      }

      setTxSig(signature);
      setStep('success');
    } catch (err) {
      console.error('[StakeModal] place bet error:', err);
      setErrorMsg(err?.message ?? 'Transaction failed. Please try again.');
      setStep('error');
    }
  }, [connected, publicKey, connection, game, outcomeKey, stakeAmount, usdcBalance, sendTransaction, setVisible]);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="stake-modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="stake-modal" role="dialog" aria-modal="true" aria-label="Place USDC Bet">

        {/* Header */}
        <div className="stake-modal-header">
          <div className="stake-modal-title">
            <span className="stake-modal-sport-badge">{game?.sport ?? '⚽'}</span>
            Place Bet
          </div>
          <button className="stake-modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        {/* Accent bar */}
        <div className="stake-accent-bar" />

        {/* Match info */}
        <div className="stake-match-info">
          <span className="stake-competition">{game?.competition}</span>
          <div className="stake-teams">
            <span>{game?.participant1}</span>
            <span className="stake-vs">vs</span>
            <span>{game?.participant2}</span>
          </div>
        </div>

        {/* Selection pill */}
        <div className="stake-selection-row">
          <div className="stake-selection-pill">
            <span className="stake-selection-label">Your Pick</span>
            <span className="stake-selection-outcome">
              {OUTCOME_LABELS[outcomeKey]} — {OUTCOME_NAMES[outcomeKey]}
            </span>
            <span className="stake-selection-odds">{odds}×</span>
          </div>
        </div>

        {/* USDC Balance */}
        {connected && (
          <div className="stake-balance-row">
            <span className="stake-balance-label">USDC Balance</span>
            <span className="stake-balance-value">
              {usdcBalance === null ? '…' : `${fmt(usdcBalance)} USDC`}
            </span>
          </div>
        )}

        {/* Stake input */}
        <div className="stake-input-section">
          <label className="stake-input-label" htmlFor="stake-amount-input">
            Stake Amount (USDC)
          </label>
          <div className="stake-input-wrapper">
            <span className="stake-currency-symbol">$</span>
            <input
              id="stake-amount-input"
              className="stake-input"
              type="number"
              min="1"
              step="0.5"
              value={stakeInput}
              onChange={(e) => setStakeInput(e.target.value)}
              placeholder="5.00"
              disabled={step === 'signing' || step === 'sending' || step === 'success'}
            />
            <span className="stake-currency-label">USDC</span>
          </div>

          {/* Preset buttons */}
          <div className="stake-presets">
            {PRESET_AMOUNTS.map((amt) => (
              <button
                key={amt}
                className={`stake-preset-btn${stakeAmount === amt ? ' active' : ''}`}
                onClick={() => setStakeInput(String(amt))}
                disabled={step === 'signing' || step === 'sending' || step === 'success'}
              >
                ${amt}
              </button>
            ))}
            {connected && usdcBalance > 0 && (
              <button
                className="stake-preset-btn stake-preset-max"
                onClick={() => setStakeInput(fmt(usdcBalance))}
                disabled={step === 'signing' || step === 'sending' || step === 'success'}
              >
                MAX
              </button>
            )}
          </div>
        </div>

        {/* Payout summary */}
        <div className="stake-payout-card">
          <div className="stake-payout-row">
            <span>Stake</span>
            <span>{stakeAmount > 0 ? `${fmt(stakeAmount)} USDC` : '-'}</span>
          </div>
          <div className="stake-payout-row">
            <span>Odds</span>
            <span>{odds !== '-' ? `${odds}×` : '-'}</span>
          </div>
          <div className="stake-payout-divider" />
          <div className="stake-payout-row stake-payout-total">
            <span>Potential Return</span>
            <span className="stake-payout-amount">
              {potentialReturn !== '-' ? `${potentialReturn} USDC` : '-'}
            </span>
          </div>
          <div className="stake-payout-row stake-profit">
            <span>Potential Profit</span>
            <span className="stake-profit-value">
              {profit !== '-' ? `+${profit} USDC` : '-'}
            </span>
          </div>
        </div>

        {/* Error message */}
        {(step === 'error' || errorMsg) && (
          <div className="stake-error-box" role="alert">
            ⚠️ {errorMsg || 'Transaction failed. Please try again.'}
          </div>
        )}

        {/* Success state */}
        {step === 'success' && (
          <div className="stake-success-box">
            <div className="stake-success-icon">✅</div>
            <div className="stake-success-title">Bet Placed!</div>
            <div className="stake-success-subtitle">
              {fmt(stakeAmount)} USDC on {OUTCOME_NAMES[outcomeKey]}
            </div>
            {txSig && (
              <a
                className="stake-explorer-link"
                href={`https://solscan.io/tx/${txSig}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                View on Solscan ↗
              </a>
            )}
            <button className="stake-btn-primary" onClick={onClose}>Done</button>
          </div>
        )}

        {/* CTA Button */}
        {step !== 'success' && (
          <div className="stake-cta-area">
            {!connected ? (
              <button
                className="stake-btn-primary stake-btn-connect"
                onClick={() => setVisible(true)}
              >
                🔌 Connect Wallet to Bet
              </button>
            ) : (
              <button
                className="stake-btn-primary"
                onClick={handlePlaceBet}
                disabled={step === 'signing' || step === 'sending' || stakeAmount < 1}
              >
                {step === 'signing' && (
                  <><span className="stake-spinner" /> Approve in Wallet…</>
                )}
                {step === 'sending' && (
                  <><span className="stake-spinner" /> Confirming on Chain…</>
                )}
                {(step === 'idle' || step === 'error') && (
                  <>Place Bet · {stakeAmount > 0 ? `${fmt(stakeAmount)} USDC` : '–'}</>
                )}
              </button>
            )}
            <p className="stake-disclaimer">
              Bets are settled on-chain via TxODDs Merkle proofs. USDC is held
              in escrow until the match finalises.
            </p>
          </div>
        )}

      </div>
    </div>
  );
}
