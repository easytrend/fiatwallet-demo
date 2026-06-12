/**
 * SwapWidget.jsx — Titan-powered swap widget
 *
 * Renders as a standalone card widget below the main page, adjacent to the
 * FloatClaimWidget. Routes swaps through Jupiter V6 API (which Titan aggregates).
 *
 * When you obtain a Titan API key, replace swapService.js internals — no UI changes needed.
 */
import { useState, useCallback, useMemo, useRef } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { useSwapQuote } from '../hooks/useSwapQuote';
import {
  buildSwapTransaction,
  formatPriceImpact,
  fromBaseUnits,
  toBaseUnits,
  SOL_MINT,
  USDC_MINT,
  USDT_MINT,
  BONK_MINT,
  JUP_MINT,
  WIF_MINT,
} from '../services/swapService';

// Titan referral — embedded in the powered-by link
const TITAN_REFERRAL = 'https://titan.exchange';

// Popular output tokens for the swap widget
const POPULAR_TOKENS = [
  { symbol: 'SOL',  name: 'Solana',       mint: SOL_MINT,  decimals: 9,  logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png' },
  { symbol: 'USDC', name: 'USD Coin',      mint: USDC_MINT, decimals: 6,  logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png' },
  { symbol: 'USDT', name: 'Tether',        mint: USDT_MINT, decimals: 6,  logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB/logo.png' },
  { symbol: 'BONK', name: 'Bonk',          mint: BONK_MINT, decimals: 5,  logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263/logo.png' },
  { symbol: 'JUP',  name: 'Jupiter',       mint: JUP_MINT,  decimals: 6,  logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN/logo.png' },
  { symbol: 'WIF',  name: 'dogwifhat',     mint: WIF_MINT,  decimals: 6,  logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm/logo.png' },
];

const SLIPPAGE_PRESETS = [
  { label: '0.1%', bps: 10 },
  { label: '0.5%', bps: 50 },
  { label: '1%',   bps: 100 },
];

const TRUSTED_HOSTS = ['raw.githubusercontent.com', 'assets.coingecko.com', 'tokens.jup.ag', 'arweave.net'];
function isTrustedLogo(url) {
  if (!url) return false;
  try {
    const p = new URL(url);
    return p.protocol === 'https:' && TRUSTED_HOSTS.some(h => p.hostname === h || p.hostname.endsWith('.' + h));
  } catch { return false; }
}

function TokenIcon({ token, size = 28 }) {
  const [imgErr, setImgErr] = useState(false);
  const validLogo = !imgErr && isTrustedLogo(token?.logoURI);
  const colors = { SOL: '#9945FF', USDC: '#2775CA', USDT: '#26A17B', BONK: '#f5a623', JUP: '#C7F284', WIF: '#a78bfa' };
  const bg = colors[token?.symbol] || '#334';

  return (
    <div style={{ width: size, height: size, borderRadius: '50%', background: validLogo ? 'transparent' : bg, overflow: 'hidden', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: size * 0.35, fontWeight: 700, color: '#fff' }}>
      {validLogo
        ? <img src={token.logoURI} alt={token.symbol} style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={() => setImgErr(true)} />
        : (token?.symbol?.slice(0, 3) || '?')
      }
    </div>
  );
}

function TokenPicker({ label, selected, options, onChange, excludeMint }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef(null);

  const filtered = options.filter(t =>
    t.mint !== excludeMint &&
    (t.symbol.toLowerCase().includes(search.toLowerCase()) || t.name.toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <div className="sw-picker-wrap" ref={ref}>
      <div className="sw-picker-label">{label}</div>
      <button className="sw-picker-btn" onClick={() => setOpen(o => !o)} id={`swap-${label.toLowerCase().replace(/\s/g, '-')}-picker`}>
        {selected ? (
          <>
            <TokenIcon token={selected} size={22} />
            <span className="sw-picker-sym">{selected.symbol}</span>
          </>
        ) : (
          <span className="sw-picker-sym" style={{ color: 'var(--text3)' }}>Select</span>
        )}
        <span style={{ color: 'var(--text3)', marginLeft: 'auto', fontSize: 11 }}>▾</span>
      </button>

      {open && (
        <div className="sw-picker-dropdown">
          <input
            className="sw-picker-search"
            placeholder="Search token…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            autoFocus
          />
          {filtered.map(t => (
            <button
              key={t.mint}
              className={`sw-picker-item ${selected?.mint === t.mint ? 'active' : ''}`}
              onClick={() => { onChange(t); setOpen(false); setSearch(''); }}
            >
              <TokenIcon token={t} size={24} />
              <div>
                <div className="sw-item-sym">{t.symbol}</div>
                <div className="sw-item-name">{t.name}</div>
              </div>
            </button>
          ))}
          {filtered.length === 0 && <div style={{ padding: '12px 14px', color: 'var(--text3)', fontSize: 12 }}>No tokens found</div>}
        </div>
      )}
    </div>
  );
}

export default function SwapWidget({ walletTokenList, onSwapSuccess }) {
  const { connection } = useConnection();
  const { publicKey, connected, sendTransaction } = useWallet();
  const { setVisible } = useWalletModal();

  const [inputToken, setInputToken]   = useState(POPULAR_TOKENS[0]); // SOL
  const [outputToken, setOutputToken] = useState(POPULAR_TOKENS[1]); // USDC
  const [inputAmount, setInputAmount] = useState('');
  const [slippageBps, setSlippageBps] = useState(50);
  const [customSlip, setCustomSlip]   = useState('');
  const [swapping, setSwapping]       = useState(false);
  const [swapError, setSwapError]     = useState(null);
  const [swapSuccess, setSwapSuccess] = useState(null);
  const [showSlippage, setShowSlippage] = useState(false);

  // Build the options list — combine wallet tokens with popular list
  const allInputOptions = useMemo(() => {
    const wallet = (walletTokenList || []).map(t => ({
      symbol: t.symbol, name: t.name || t.symbol,
      mint: t.symbol === 'SOL' ? SOL_MINT : (t.mint || ''),
      decimals: t.symbol === 'SOL' ? 9 : (t.decimals || 6),
      logoURI: t.logoURI || '',
      balance: t.balance,
    })).filter(t => t.mint);

    // Merge: wallet tokens first, then add popular tokens not already present
    const mints = new Set(wallet.map(t => t.mint));
    const extras = POPULAR_TOKENS.filter(t => !mints.has(t.mint));
    return [...wallet, ...extras];
  }, [walletTokenList]);

  const inputDecimals = inputToken?.decimals ?? 9;
  const outputDecimals = outputToken?.decimals ?? 6;

  const amountBaseUnits = useMemo(() => {
    const n = parseFloat(inputAmount);
    if (!n || n <= 0) return 0;
    return toBaseUnits(n, inputDecimals);
  }, [inputAmount, inputDecimals]);

  const { quote, loading: quoteLoading, error: quoteError, countdown, refresh } = useSwapQuote({
    inputMint: inputToken?.mint ?? null,
    outputMint: outputToken?.mint ?? null,
    amountBaseUnits,
    slippageBps,
  });

  const outputAmount = useMemo(() => {
    if (!quote?.outAmount) return null;
    return fromBaseUnits(quote.outAmount, outputDecimals);
  }, [quote, outputDecimals]);

  const priceImpact = useMemo(() => {
    if (!quote?.priceImpactPct) return null;
    return formatPriceImpact(quote.priceImpactPct);
  }, [quote]);

  const minReceived = useMemo(() => {
    if (!quote?.otherAmountThreshold) return null;
    return fromBaseUnits(quote.otherAmountThreshold, outputDecimals);
  }, [quote, outputDecimals]);

  // Input token balance from wallet
  const inputBalance = useMemo(() => {
    if (!inputToken || !walletTokenList) return null;
    if (inputToken.symbol === 'SOL') {
      const sol = walletTokenList.find(t => t.symbol === 'SOL');
      return sol?.balance ?? null;
    }
    const tok = walletTokenList.find(t => (t.mint === inputToken.mint) || t.symbol === inputToken.symbol);
    return tok?.balance ?? null;
  }, [inputToken, walletTokenList]);

  function handleFlip() {
    setInputToken(outputToken);
    setOutputToken(inputToken);
    setInputAmount('');
    setSwapError(null);
    setSwapSuccess(null);
  }

  function handleMaxAmount() {
    if (inputBalance == null) return;
    // For SOL, leave 0.01 for fees
    const max = inputToken.symbol === 'SOL' ? Math.max(0, inputBalance - 0.01) : inputBalance;
    setInputAmount(max > 0 ? String(max.toFixed(inputDecimals > 6 ? 6 : inputDecimals)) : '');
  }

  async function handleSwap() {
    if (swapping) return;
    if (!publicKey || !connected || !quote) return;
    setSwapError(null);
    setSwapSuccess(null);
    setSwapping(true);

    try {
      // 1. Validate input amount
      const n = parseFloat(inputAmount);
      if (!n || n <= 0) throw new Error('Enter a valid amount to swap.');

      // 2. Fresh balance check
      if (inputToken.symbol === 'SOL') {
        const freshLamports = await connection.getBalance(publicKey, 'confirmed');
        const freshSOL = freshLamports / 1e9;
        if (n + 0.005 > freshSOL) {
          throw new Error(`Insufficient SOL. You have ${freshSOL.toFixed(5)} SOL (need ${n} + fees).`);
        }
      }

      // 3. Build the swap transaction
      const base64Tx = await buildSwapTransaction(quote, publicKey.toBase58());

      // 4. Deserialize
      const buf = Buffer.from(base64Tx, 'base64');
      const versionedTx = VersionedTransaction.deserialize(buf);

      // 5. Simulate before sending
      const simResult = await connection.simulateTransaction(versionedTx);
      if (simResult.value.err) {
        const logs = simResult.value.logs?.slice(0, 3).join(' | ') || '';
        throw new Error(`Swap simulation failed: ${JSON.stringify(simResult.value.err)}${logs ? ' — ' + logs : ''}`);
      }

      // 6. Sign and send
      const signature = await sendTransaction(versionedTx, connection, {
        skipPreflight: true, // Already simulated above
        maxRetries: 3,
      });

      // 7. Wait for confirmation (up to 60s)
      let confirmed = false;
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        try {
          const status = await connection.getSignatureStatus(signature);
          const conf = status?.value?.confirmationStatus;
          if (conf === 'confirmed' || conf === 'finalized') { confirmed = true; break; }
          if (status?.value?.err) throw new Error('Swap rejected on-chain: ' + JSON.stringify(status.value.err));
        } catch (pollErr) {
          if (pollErr.message.startsWith('Swap rejected')) throw pollErr;
        }
        await new Promise(r => setTimeout(r, 2000));
      }

      if (!confirmed) throw new Error('Swap submitted but confirmation timed out.');

      setSwapSuccess({
        sig: signature,
        from: `${n} ${inputToken.symbol}`,
        to: `${outputAmount?.toFixed(outputDecimals > 4 ? 4 : outputDecimals) || '?'} ${outputToken.symbol}`,
      });
      setInputAmount('');
      if (onSwapSuccess) onSwapSuccess();

    } catch (err) {
      console.error('Swap failed:', err);
      setSwapError(err.message || 'Swap failed. Please try again.');
    }
    setSwapping(false);
  }

  const hasAmount = parseFloat(inputAmount) > 0;
  const canSwap = connected && hasAmount && !swapping && !!quote && !quoteLoading;

  return (
    <div className="swap-widget-card">
      {/* Header */}
      <div className="sw-header">
        <div className="sw-title-row">
          <div className="sw-title">
            <span className="sw-icon">⇄</span> Swap
          </div>
          <a
            href={TITAN_REFERRAL}
            target="_blank"
            rel="noopener noreferrer"
            className="sw-powered-by"
            title="Powered by Titan Exchange routing"
          >
            <span>Powered by</span>
            <span className="sw-titan-badge">⚡ Titan</span>
          </a>
        </div>
        <p className="sw-subtitle">Best-price routing across Solana DEXs</p>
      </div>

      {/* Slippage Row */}
      <div className="sw-slippage-row">
        <span className="sw-slippage-label">Slippage</span>
        <div className="sw-slippage-btns">
          {SLIPPAGE_PRESETS.map(p => (
            <button
              key={p.bps}
              className={`sw-slip-btn ${slippageBps === p.bps && !showSlippage ? 'active' : ''}`}
              onClick={() => { setSlippageBps(p.bps); setShowSlippage(false); setCustomSlip(''); }}
            >{p.label}</button>
          ))}
          <button
            className={`sw-slip-btn ${showSlippage ? 'active' : ''}`}
            onClick={() => setShowSlippage(s => !s)}
          >Custom</button>
        </div>
        {showSlippage && (
          <div className="sw-custom-slip-wrap">
            <input
              type="number"
              className="sw-custom-slip-input"
              placeholder="e.g. 2.0"
              value={customSlip}
              min="0.01"
              max="50"
              step="0.1"
              onChange={e => {
                setCustomSlip(e.target.value);
                const v = parseFloat(e.target.value);
                if (v > 0 && v <= 50) setSlippageBps(Math.round(v * 100));
              }}
            />
            <span className="sw-custom-slip-pct">%</span>
          </div>
        )}
      </div>

      {/* Token Selectors & Amount */}
      <div className="sw-fields">
        {/* FROM */}
        <div className="sw-field-card">
          <div className="sw-field-header">
            <TokenPicker
              label="From"
              selected={inputToken}
              options={allInputOptions}
              onChange={t => { setInputToken(t); setInputAmount(''); setSwapError(null); setSwapSuccess(null); }}
              excludeMint={outputToken?.mint}
            />
            {connected && inputBalance != null && (
              <div className="sw-balance-row">
                <span className="sw-balance-val">Bal: {inputBalance < 0.0001 ? inputBalance.toExponential(2) : inputBalance.toLocaleString(undefined, { maximumFractionDigits: 4 })} {inputToken?.symbol}</span>
                <button className="sw-max-btn" onClick={handleMaxAmount}>MAX</button>
              </div>
            )}
          </div>
          <input
            id="swap-input-amount"
            className="sw-amount-input"
            type="number"
            placeholder="0.00"
            value={inputAmount}
            min="0"
            step="any"
            onChange={e => { setInputAmount(e.target.value); setSwapError(null); setSwapSuccess(null); }}
          />
        </div>

        {/* Flip Button */}
        <div className="sw-flip-row">
          <button className="sw-flip-btn" onClick={handleFlip} title="Flip tokens" id="swap-flip-btn">
            ↕
          </button>
          {/* Quote refresh countdown */}
          {hasAmount && (
            <div className="sw-countdown">
              {quoteLoading ? (
                <span className="sw-countdown-loading"><span className="sw-spin" />Refreshing…</span>
              ) : (
                <span className="sw-countdown-num" onClick={refresh} title="Click to refresh quote">
                  🔄 {countdown}s
                </span>
              )}
            </div>
          )}
        </div>

        {/* TO */}
        <div className="sw-field-card">
          <TokenPicker
            label="To"
            selected={outputToken}
            options={POPULAR_TOKENS}
            onChange={t => { setOutputToken(t); setSwapError(null); setSwapSuccess(null); }}
            excludeMint={inputToken?.mint}
          />
          <div className="sw-amount-output">
            {quoteLoading && hasAmount ? (
              <span className="sw-output-loading"><span className="sw-spin" />Fetching…</span>
            ) : outputAmount != null ? (
              <span className="sw-output-num">
                {outputAmount < 0.0001 ? outputAmount.toExponential(4) : outputAmount.toLocaleString(undefined, { maximumFractionDigits: outputDecimals > 4 ? 4 : outputDecimals })}
              </span>
            ) : (
              <span className="sw-output-placeholder">—</span>
            )}
          </div>
        </div>
      </div>

      {/* Route Info */}
      {quote && !quoteLoading && (
        <div className="sw-route-info">
          <div className="sw-route-row">
            <span className="sw-route-key">Price impact</span>
            <span className={`sw-route-val sw-impact-${priceImpact?.severity}`}>{priceImpact?.label ?? '—'}</span>
          </div>
          <div className="sw-route-row">
            <span className="sw-route-key">Min received</span>
            <span className="sw-route-val">
              {minReceived != null
                ? `${minReceived < 0.0001 ? minReceived.toExponential(3) : minReceived.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${outputToken?.symbol}`
                : '—'}
            </span>
          </div>
          {quote.routePlan?.length > 0 && (
            <div className="sw-route-row">
              <span className="sw-route-key">Route</span>
              <span className="sw-route-val sw-route-path">
                {[inputToken?.symbol, ...quote.routePlan.map(r => r.swapInfo?.label || '').filter(Boolean), outputToken?.symbol].join(' → ')}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Quote Error */}
      {quoteError && hasAmount && !quoteLoading && (
        <div className="sw-error-banner">⚠ {quoteError}</div>
      )}

      {/* Swap Error */}
      {swapError && (
        <div className="sw-error-banner">✕ {swapError}</div>
      )}

      {/* Success Toast */}
      {swapSuccess && (
        <div className="sw-success-banner">
          <div>
            ✓ Swapped <strong>{swapSuccess.from}</strong> → <strong>{swapSuccess.to}</strong>
          </div>
          <a
            href={`https://solscan.io/tx/${swapSuccess.sig}`}
            target="_blank"
            rel="noopener noreferrer"
            className="sw-solscan-link"
          >
            {swapSuccess.sig.slice(0, 8)}… ↗
          </a>
        </div>
      )}

      {/* Swap Button */}
      {connected ? (
        <button
          id="swap-submit-btn"
          className="sw-swap-btn"
          disabled={!canSwap}
          onClick={handleSwap}
        >
          {swapping ? (
            <><span className="sw-spin sw-spin-dark" /> Swapping…</>
          ) : !hasAmount ? 'Enter amount' :
            quoteLoading ? 'Fetching best price…' :
            !quote ? 'No route found' :
            `Swap ${inputToken?.symbol} → ${outputToken?.symbol}`}
        </button>
      ) : (
        <button className="sw-swap-btn sw-connect-btn" onClick={() => setVisible(true)}>
          Connect Wallet to Swap
        </button>
      )}

      {/* Footer */}
      <div className="sw-footer">
        <span>Routes via Jupiter · Aggregated by</span>
        <a href={TITAN_REFERRAL} target="_blank" rel="noopener noreferrer" className="sw-titan-link">⚡ Titan Exchange</a>
      </div>
    </div>
  );
}
