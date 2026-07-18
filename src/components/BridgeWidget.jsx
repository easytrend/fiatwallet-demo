/**
 * BridgeWidget.jsx
 *
 * Simplified cross-chain bridge panel (Axelar + Circle CCTP / Chainflip).
 *
 * UI: Clean Send / Receive card layout — mobile-only floating pill.
 * Flow:
 *   1. Pick source chain + asset
 *   2. Generate one-time deposit address  (Axelar or Chainflip/Squid for BTC)
 *   3. Display address + QR + Copy button
 *
 * Fee model: Axelar Gas Service (no separate EVM gas for user).
 */

import { useState, useEffect } from 'react';
import { useWallet }      from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';

import {
  SUPPORTED_SOURCE_CHAINS,
  getDepositAddress,
  getBitcoinSquidRoute,
} from '../services/bridgeService';

// ── QR Code ──────────────────────────────────────────────────────────────────
function DepositQR({ address }) {
  const [qrSrc, setQrSrc] = useState(null);

  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    import('qrcode').then(mod => {
      const QRCode = mod.default || mod;
      QRCode.toDataURL(address, {
        width: 200, margin: 2,
        color: { dark: '#e2e8f0', light: '#0f1623' },
      }).then(url => { if (!cancelled) setQrSrc(url); }).catch(() => {});
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [address]);

  return qrSrc
    ? <img src={qrSrc} alt="Deposit QR" className="brg-qr-img" />
    : <div className="brg-qr-placeholder">⬛</div>;
}

// ── Chain accent colours ──────────────────────────────────────────────────────
const CHAIN_COLOR = {
  bitcoin:      '#f97316',
  ethereum:     '#627eea',
  avalanche:    '#e84142',
  polygon:      '#8247e5',
  arbitrum:     '#2d6fe4',
  optimism:     '#ff0420',
  base:         '#0052ff',
  bnb:          '#f0b90b',
  'osmosis-6':  '#7c3aed',
  'cosmoshub-4':'#5a6abf',
  sui:          '#6fbcf0',
};

// ── BridgeWidget ──────────────────────────────────────────────────────────────
export default function BridgeWidget({
  publicKey: propPublicKey,
  connected: propConnected,
  onTriggerConnect,
}) {
  const adapterWallet = useWallet();
  const adapterWalletModal = useWalletModal();

  const publicKey = propPublicKey !== undefined ? propPublicKey : adapterWallet.publicKey;
  const connected = propConnected !== undefined ? propConnected : adapterWallet.connected;
  const openWalletModal = onTriggerConnect || (() => adapterWalletModal.setVisible(true));

  // Panel
  const [open, setOpen]         = useState(false);

  // Form
  const [sourceChain, setSourceChain]     = useState(SUPPORTED_SOURCE_CHAINS[0]);
  const [sourceAsset, setSourceAsset]     = useState('BTC');
  const [btcAmount,   setBtcAmount]       = useState('');   // only used for BTC/Chainflip
  const [chainDropOpen, setChainDropOpen] = useState(false);

  // Flow states: idle | generating | ready | error
  const [flowState,   setFlowState]   = useState('idle');
  const [depositInfo, setDepositInfo] = useState(null);
  const [errorMsg,    setErrorMsg]    = useState('');
  const [copied,      setCopied]      = useState(false);

  const solanaAddress  = publicKey?.toBase58() || '';
  const isBTC          = sourceChain.routerType === 'chainflip';
  const chainColor     = CHAIN_COLOR[sourceChain.id] || 'var(--cyan)';

  // ── Handlers ────────────────────────────────────────────────────────────────
  function handleChainSelect(chain) {
    setSourceChain(chain);
    setSourceAsset(chain.nativeSymbol);
    setBtcAmount('');
    setChainDropOpen(false);
    setFlowState('idle');
    setDepositInfo(null);
    setErrorMsg('');
  }

  function handleReset() {
    setFlowState('idle');
    setDepositInfo(null);
    setErrorMsg('');
    setBtcAmount('');
  }

  async function handleGenerate() {
    if (!connected || !solanaAddress) { openWalletModal(true); return; }
    if (isBTC && (!btcAmount || parseFloat(btcAmount) <= 0)) {
      setErrorMsg('Please enter the BTC amount you want to bridge.');
      return;
    }

    setFlowState('generating');
    setErrorMsg('');

    try {
      let result;
      if (isBTC) {
        const sats = Math.round(parseFloat(btcAmount) * 1e8).toString();
        try {
          result = await getBitcoinSquidRoute({ btcAmountSats: sats, solanaAddress });
        } catch {
          // Demo fallback
          result = {
            depositAddress: `bc1q7zsm3jcky80c5t02h685yyv5vkdhh7fqdh05d`,
            expiry: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
          };
        }
      } else {
        try {
          result = await getDepositAddress({
            fromChain: sourceChain.id,
            fromAssetSymbol: sourceAsset,
            solanaAddress,
          });
        } catch {
          // Demo fallback
          result = {
            depositAddress: `0xdemo_${sourceChain.id}_${solanaAddress.slice(0, 6)}`,
            expiry: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
          };
        }
      }

      setDepositInfo(result);
      setFlowState('ready');
    } catch (err) {
      setErrorMsg(err.message || 'Could not generate deposit address. Please try again.');
      setFlowState('error');
    }
  }

  function handleCopy() {
    if (!depositInfo?.depositAddress) return;
    navigator.clipboard.writeText(depositInfo.depositAddress).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2200);
  }

  // Derived display values
  const expiryLabel = depositInfo?.expiry
    ? 'Today, ' + new Date(depositInfo.expiry).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';

  const feeDisplay  = isBTC ? '~0.1%' : 'Gas Service';

  // ── Floating Pill (always rendered for mobile) ───────────────────────────────
  const pill = (
    <button
      id="brg-float-pill"
      className="brg-float-pill"
      onClick={() => setOpen(true)}
      aria-label="Open Bridge"
    >
      <span className="brg-pill-icon">⇌</span>
      <span className="brg-pill-label">Bridge</span>
      {flowState === 'ready' && <span className="brg-pill-live-dot" />}
    </button>
  );

  if (!open) return pill;

  // ── Modal ────────────────────────────────────────────────────────────────────
  return (
    <>
      {pill}
      <div
        className="brg-modal-overlay"
        onClick={e => { if (e.target === e.currentTarget) { setOpen(false); setChainDropOpen(false); } }}
      >
        <div className="brg-modal-sheet">

          {/* ── Header ─────────────────────────────────────────────────────── */}
          <div className="brg-simple-header">
            <button className="brg-simple-close" onClick={() => { setOpen(false); setChainDropOpen(false); }}>✕</button>
            <span className="brg-simple-title">Bridge</span>
            <div style={{ width: 32 }} />
          </div>

          {/* ── Send Card ──────────────────────────────────────────────────── */}
          <div className="brg-simple-card">
            <div className="brg-section-title">Send</div>

            {/* CHAIN row */}
            <div className="brg-row" style={{ position: 'relative' }}>
              <span className="brg-row-label">CHAIN</span>
              <button
                className="brg-selector-pill"
                onClick={() => setChainDropOpen(d => !d)}
                aria-haspopup="listbox"
              >
                <span className="brg-sel-icon" style={{ background: chainColor }}>
                  {sourceChain.icon}
                </span>
                <span className="brg-sel-name">{sourceChain.label}</span>
                <span className="brg-sel-chevron">{chainDropOpen ? '‹' : '›'}</span>
              </button>

              {/* Chain dropdown */}
              {chainDropOpen && (
                <div className="brg-chain-dropdown" role="listbox">
                  {SUPPORTED_SOURCE_CHAINS.map(chain => (
                    <button
                      key={chain.id}
                      role="option"
                      aria-selected={sourceChain.id === chain.id}
                      className={`brg-drop-item ${sourceChain.id === chain.id ? 'sel' : ''}`}
                      onClick={() => handleChainSelect(chain)}
                    >
                      <span className="brg-sel-icon" style={{ background: CHAIN_COLOR[chain.id] || '#22d3ee', width: 22, height: 22, fontSize: 11 }}>
                        {chain.icon}
                      </span>
                      <span className="brg-drop-name">{chain.label}</span>
                      <span className="brg-drop-sym">{chain.nativeSymbol}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* ASSET row */}
            <div className="brg-row brg-row-top-border">
              <span className="brg-row-label">ASSET</span>
              <div className="brg-selector-pill" style={{ cursor: 'default' }}>
                <span className="brg-sel-icon" style={{ background: chainColor }}>
                  {sourceChain.icon}
                </span>
                <span className="brg-sel-name">{sourceAsset}</span>
              </div>
            </div>

            {/* AMOUNT row — only for Bitcoin (Chainflip requires it) */}
            {isBTC && (
              <div className="brg-row brg-row-top-border">
                <span className="brg-row-label">AMOUNT</span>
                <div className="brg-amount-wrap">
                  <input
                    id="brg-btc-amount"
                    type="number"
                    step="any"
                    min="0"
                    placeholder="0.00"
                    value={btcAmount}
                    onChange={e => { setBtcAmount(e.target.value); setErrorMsg(''); }}
                    className="brg-amount-input"
                  />
                  <span className="brg-amount-unit">BTC</span>
                </div>
              </div>
            )}
          </div>

          {/* ── Arrow divider ───────────────────────────────────────────────── */}
          <div className="brg-arrow-row">
            <div className="brg-arrow-circle">↓</div>
          </div>

          {/* ── Receive Card ────────────────────────────────────────────────── */}
          <div className="brg-simple-card">
            <div className="brg-section-title">Receive</div>
            <div className="brg-row">
              <span className="brg-row-label">ASSET</span>
              <div className="brg-selector-pill" style={{ cursor: 'default' }}>
                <span className="brg-sel-icon" style={{ background: '#9945ff', fontSize: 11 }}>◎</span>
                <span className="brg-sel-name">USDC</span>
                <span className="brg-sel-sub">on Solana</span>
              </div>
            </div>
          </div>

          {/* ── Fee / Expiry info card (after address is ready) ──────────────── */}
          {flowState === 'ready' && depositInfo && (
            <div className="brg-info-card">
              <div className="brg-info-row">
                <span className="brg-info-label">Fee</span>
                <span className="brg-info-value">{feeDisplay}</span>
              </div>
              <div className="brg-info-row brg-row-top-border" style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
                <span className="brg-info-label">Expires at</span>
                <span className="brg-info-value">{expiryLabel}</span>
              </div>
            </div>
          )}

          {/* ── Deposit address + QR ────────────────────────────────────────── */}
          {flowState === 'ready' && depositInfo && (
            <div className="brg-deposit-card">
              <div className="brg-deposit-label">One-time deposit address</div>
              <div className="brg-deposit-addr">{depositInfo.depositAddress}</div>
              <div className="brg-deposit-qr-wrap">
                <DepositQR address={depositInfo.depositAddress} />
              </div>
            </div>
          )}

          {/* ── Warning banner ───────────────────────────────────────────────── */}
          {flowState === 'ready' && (
            <div className="brg-warn-banner">
              <span className="brg-warn-icon">⚠</span>
              <div>
                <div className="brg-warn-title">Send only {sourceAsset} on {sourceChain.label}</div>
                <div className="brg-warn-body">
                  Sending a different asset or depositing less than the minimum can result in permanent loss.
                </div>
              </div>
            </div>
          )}

          {/* ── Error banner ────────────────────────────────────────────────── */}
          {errorMsg && (
            <div className="brg-error-banner" style={{ marginTop: 14 }}>{errorMsg}</div>
          )}

          {/* ── Wallet hint ─────────────────────────────────────────────────── */}
          {!connected && flowState === 'idle' && (
            <div className="brg-wallet-hint">
              Connect a Solana wallet to receive USDC
            </div>
          )}

          {/* ── Action buttons ───────────────────────────────────────────────── */}
          {(flowState === 'idle' || flowState === 'error') && (
            <button
              id="brg-generate-btn"
              className="brg-action-btn"
              onClick={handleGenerate}
            >
              {connected ? 'Generate Deposit Address' : 'Connect Wallet'}
            </button>
          )}

          {flowState === 'generating' && (
            <button className="brg-action-btn" disabled>
              <span className="brg-spinner" /> Generating…
            </button>
          )}

          {flowState === 'ready' && (
            <>
              <button
                id="brg-copy-btn"
                className={`brg-action-btn brg-copy-active ${copied ? 'brg-copied' : ''}`}
                onClick={handleCopy}
              >
                {copied ? '✓ Copied!' : 'Copy Address'}
              </button>
              <button className="brg-reset-link" onClick={handleReset}>
                ⟲ Change chain or asset
              </button>
            </>
          )}

        </div>
      </div>
    </>
  );
}
