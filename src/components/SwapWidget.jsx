/**
 * SwapWidget.jsx — Titan-powered floating swap pill + modal
 *
 * Pattern mirrors FloatClaimWidget:
 *   1. A fixed floating pill on screen (top-right, adjacent to claim pill)
 *   2. Click → full swap interface slides up as a bottom-sheet modal
 *
 * Routes via Jupiter V6 API (which Titan aggregates).
 * Replace swapService.js internals when Titan API key is obtained — no UI changes needed.
 */
import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { VersionedTransaction, TransactionMessage, PublicKey } from '@solana/web3.js';
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

import { fmtTok, fmtFiat } from '../utils';
import CurrDrop from './CurrDrop';

const TITAN_REFERRAL = 'https://titan.exchange/@easytrend';

const POPULAR_TOKENS = [
  { symbol: 'SOL',  name: 'Solana',    mint: SOL_MINT,  decimals: 9, logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png' },
  { symbol: 'USDC', name: 'USD Coin',  mint: USDC_MINT, decimals: 6, logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png' },
  { symbol: 'USDT', name: 'Tether',    mint: USDT_MINT, decimals: 6, logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB/logo.png' },
  { symbol: 'BONK', name: 'Bonk',      mint: BONK_MINT, decimals: 5, logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263/logo.png' },
  { symbol: 'JUP',  name: 'Jupiter',   mint: JUP_MINT,  decimals: 6, logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN/logo.png' },
  { symbol: 'WIF',  name: 'dogwifhat', mint: WIF_MINT,  decimals: 6, logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm/logo.png' },
];

const SLIPPAGE_PRESETS = [
  { label: '0.1%', bps: 10 },
  { label: '0.5%', bps: 50 },
  { label: '1%',   bps: 100 },
];

const TOKEN_COLORS = { SOL: '#9945FF', USDC: '#2775CA', USDT: '#26A17B', BONK: '#f5a623', JUP: '#C7F284', WIF: '#a78bfa' };

const TRUSTED_HOSTS = ['raw.githubusercontent.com', 'assets.coingecko.com', 'tokens.jup.ag', 'arweave.net', 'nftstorage.link', 'cdn.jsdelivr.net', 'coin-images.coingecko.com', 'dd.dexscreener.com'];
function isTrustedLogo(url) {
  if (!url) return false;
  try {
    const p = new URL(url);
    return p.protocol === 'https:' && TRUSTED_HOSTS.some(h => p.hostname === h || p.hostname.endsWith('.' + h));
  } catch { return false; }
}

async function fetchTokenMetadata(mintAddress, connection) {
  // 1. Try CoinGecko
  try {
    const cgRes = await fetch(`https://api.coingecko.com/api/v3/coins/solana/contract/${mintAddress}`);
    if (cgRes.ok) {
      const data = await cgRes.json();
      if (data && data.symbol) {
        return {
          symbol: data.symbol.toUpperCase(),
          name: data.name,
          mint: mintAddress,
          decimals: data.detail_platforms?.solana?.decimal_place ?? 9,
          logoURI: data.image?.small || '',
          price: data.market_data?.current_price?.usd || 0
        };
      }
    }
  } catch (e) {
    
  }

  // 2. Try DEX Screener
  let dexMetadata = null;
  try {
    const dsRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`);
    if (dsRes.ok) {
      const data = await dsRes.json();
      const pair = data.pairs?.find(p => p.chainId === 'solana');
      if (pair) {
        const isBase = pair.baseToken?.address?.toLowerCase() === mintAddress.toLowerCase();
        const token = isBase ? pair.baseToken : pair.quoteToken;
        if (token) {
          dexMetadata = {
            symbol: token.symbol.toUpperCase(),
            name: token.name,
            mint: mintAddress,
            logoURI: pair.info?.imageUrl || '',
            price: parseFloat(pair.priceUsd) || 0
          };
        }
      }
    }
  } catch (e) {
    
  }

  // 3. Get Decimals from on-chain RPC (especially if DEX Screener succeeded but lacks decimals, or if both failed)
  let decimals = 9;
  if (connection) {
    try {
      const info = await connection.getParsedAccountInfo(new PublicKey(mintAddress));
      if (info?.value?.data?.parsed?.info?.decimals !== undefined) {
        decimals = info.value.data.parsed.info.decimals;
      } else {
        if (!dexMetadata) return null; // If not a valid mint account, fail early
      }
    } catch (e) {
      
      if (!dexMetadata) return null;
    }
  }

  if (dexMetadata) {
    return {
      ...dexMetadata,
      decimals
    };
  }

  // If nothing worked but it's a valid mint with decimals, return a fallback object
  if (connection) {
    const short = mintAddress.slice(0, 4) + '...' + mintAddress.slice(-4);
    return {
      symbol: short.toUpperCase(),
      name: `Token ${short}`,
      mint: mintAddress,
      decimals,
      logoURI: ''
    };
  }

  return null;
}

/* ── Tiny reusable token icon ── */
function TokenIcon({ token, size = 26 }) {
  const [err, setErr] = useState(false);
  const validLogo = !err && isTrustedLogo(token?.logoURI);
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: validLogo ? 'transparent' : (TOKEN_COLORS[token?.symbol] || '#334'),
      overflow: 'hidden', flexShrink: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.34, fontWeight: 700, color: '#fff',
    }}>
      {validLogo
        ? <img src={token.logoURI} alt={token.symbol} style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={() => setErr(true)} />
        : (token?.symbol?.slice(0, 3) || '?')
      }
    </div>
  );
}

/* ── Inline Token Picker ── */
function TokenPicker({ selected, options, onChange, excludeMint, id, onAddCustomToken }) {
  const { connection } = useConnection();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const wrapRef = useRef(null);

  const [loadingMetadata, setLoadingMetadata] = useState(false);
  const [resolvedToken, setResolvedToken] = useState(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Lookup custom token if search is a mint address
  useEffect(() => {
    const mint = search.trim();
    const isMintAddress = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint);
    if (!isMintAddress) {
      setResolvedToken(null);
      return;
    }

    const exists = options.some(t => t.mint.toLowerCase() === mint.toLowerCase());
    if (exists) {
      setResolvedToken(null);
      return;
    }

    let active = true;
    const lookup = async () => {
      setLoadingMetadata(true);
      setResolvedToken(null);
      try {
        const token = await fetchTokenMetadata(mint, connection);
        if (active && token) {
          setResolvedToken(token);
        }
      } catch (err) {
        
      } finally {
        if (active) setLoadingMetadata(false);
      }
    };

    const t = setTimeout(() => {
      lookup();
    }, 500);

    return () => {
      active = false;
      clearTimeout(t);
    };
  }, [search, options, connection]);

  const filtered = options.filter(t =>
    t.mint !== excludeMint &&
    (t.symbol.toLowerCase().includes(search.toLowerCase()) ||
     t.name.toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <div className="swp-picker-wrap" ref={wrapRef}>
      <button
        className="swp-picker-btn"
        id={id}
        onClick={() => setOpen(o => !o)}
        type="button"
      >
        <TokenIcon token={selected} size={22} />
        <span className="swp-picker-sym">{selected?.symbol ?? 'Select'}</span>
        <span style={{ color: 'var(--text3)', fontSize: 10, marginLeft: 'auto' }}>▾</span>
      </button>

      {open && (
        <div className="swp-dropdown">
          <input
            className="swp-dropdown-search"
            placeholder="Search name or address…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            autoFocus
          />
          {filtered.map(t => (
            <button
              key={t.mint}
              className={`swp-dropdown-item ${selected?.mint === t.mint ? 'sel' : ''}`}
              type="button"
              onClick={() => { onChange(t); setOpen(false); setSearch(''); }}
            >
              <TokenIcon token={t} size={22} />
              <span className="swp-di-sym">{t.symbol}</span>
              <span className="swp-di-name">{t.name}</span>
            </button>
          ))}

          {/* Render dynamically looked up token if found */}
          {resolvedToken && (
            <button
              className="swp-dropdown-item custom-import-item"
              type="button"
              style={{ borderTop: '1px dashed rgba(34, 211, 238, 0.4)', background: 'rgba(34, 211, 238, 0.05)' }}
              onClick={() => {
                if (onAddCustomToken) onAddCustomToken(resolvedToken);
                onChange(resolvedToken);
                setOpen(false);
                setSearch('');
              }}
            >
              <TokenIcon token={resolvedToken} size={22} />
              <div style={{ display: 'flex', flexDirection: 'column', textAlign: 'left' }}>
                <span className="swp-di-sym">{resolvedToken.symbol} <span style={{ fontSize: 9, color: 'var(--cyan)' }}>(Import)</span></span>
                <span className="swp-di-name" style={{ fontSize: 10 }}>{resolvedToken.name}</span>
              </div>
            </button>
          )}

          {/* Loading / Empty states */}
          {loadingMetadata && (
            <div style={{ padding: '12px 14px', color: 'var(--text3)', fontSize: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="swp-mini-spin" /> Searching…
            </div>
          )}

          {filtered.length === 0 && !loadingMetadata && !resolvedToken && (
            <div style={{ padding: '12px 14px', color: 'var(--text3)', fontSize: 12 }}>No tokens found</div>
          )}
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════
   MAIN COMPONENT
   ══════════════════════════════════════════════════════ */
export default function SwapWidget({
  walletTokenList,
  onSwapSuccess,
  currency: parentCurrency,
  setCurrency: parentSetCurrency,
  currRate: parentCurrRate,
}) {
  const { connection } = useConnection();
  const { publicKey, connected, sendTransaction } = useWallet();
  const { setVisible } = useWalletModal();

  const [isOpen, setIsOpen]   = useState(false);

  // Currency configuration
  const [localCurrency, setLocalCurrency] = useState('USD');
  const currency = parentCurrency || localCurrency;
  const setCurrency = parentSetCurrency || setLocalCurrency;
  const currRate = parentCurrRate || 1;

  const [swapInputMode, setSwapInputMode] = useState('crypto'); // 'crypto' or 'fiat'

  // Selected mints state
  const [selectedInputMint, setSelectedInputMint] = useState(null);
  const [selectedOutputMint, setSelectedOutputMint] = useState(null);
  const [inputAmount, setInputAmount]   = useState('');
  const [slippageBps, setSlippageBps]   = useState(50);
  const [customSlip, setCustomSlip]     = useState('');
  const [showSlippage, setShowSlippage] = useState(false);
  const [swapping, setSwapping]         = useState(false);
  const [swapError, setSwapError]       = useState(null);
  const [swapSuccess, setSwapSuccess]   = useState(null);

  const [customTokens, setCustomTokens] = useState([]);

  // Build merged options list (wallet + custom)
  const allOptions = useMemo(() => {
    if (!connected || !walletTokenList) return [];

    const wallet = (walletTokenList || []).map(t => ({
      symbol: t.symbol, name: t.name || t.symbol,
      mint: t.symbol === 'SOL' ? SOL_MINT : (t.mint || ''),
      decimals: t.symbol === 'SOL' ? 9 : (t.decimals || 6),
      logoURI: t.logoURI || '',
      balance: t.balance,
      price: t.price || 0,
    })).filter(t => t.mint);
    
    const mints = new Set(wallet.map(t => t.mint));
    const combined = [...wallet];
    
    customTokens.forEach(t => {
      if (!mints.has(t.mint)) {
        combined.push(t);
        mints.add(t.mint);
      }
    });

    return combined;
  }, [connected, walletTokenList, customTokens]);

  // Derive inputToken and outputToken based on connected status and walletTokenList
  const inputToken = useMemo(() => {
    if (!connected || allOptions.length === 0) return null;
    return allOptions.find(o => o.mint === selectedInputMint) || allOptions.find(o => o.symbol === 'SOL') || allOptions[0];
  }, [connected, allOptions, selectedInputMint]);

  const outputToken = useMemo(() => {
    if (!connected || allOptions.length === 0) return null;
    return allOptions.find(o => o.mint === selectedOutputMint && o.mint !== inputToken?.mint) 
      || allOptions.find(o => o.mint !== inputToken?.mint) 
      || null;
  }, [connected, allOptions, selectedOutputMint, inputToken]);

  const handleAddCustomToken = useCallback((token) => {
    setCustomTokens(prev => {
      if (prev.some(t => t.mint.toLowerCase() === token.mint.toLowerCase())) return prev;
      return [...prev, token];
    });
  }, []);

  const inputTokenPrice = inputToken?.price || 0;
  const num = parseFloat(inputAmount) || 0;

  const tokAmt  = swapInputMode === 'fiat'   ? (num / currRate) / (inputTokenPrice || 1) : num;
  const fiatAmt = swapInputMode === 'crypto' ? num * inputTokenPrice * currRate : num;

  const convertedLabel = useMemo(() => {
    if (!inputToken) return '≈ 0';
    if (swapInputMode === 'fiat') {
      if (inputTokenPrice === 0) return `≈ -- ${inputToken.symbol}`;
      return `≈ ${fmtTok(tokAmt)} ${inputToken.symbol}`;
    } else {
      if (inputTokenPrice === 0) return `≈ -- ${currency}`;
      return `≈ ${fmtFiat(fiatAmt, currency)}`;
    }
  }, [swapInputMode, inputToken, inputTokenPrice, tokAmt, fiatAmt, currency]);

  const toggleInputMode = useCallback((newMode) => {
    if (newMode === swapInputMode) return;
    setSwapError(null);
    setSwapSuccess(null);
    
    const numVal = parseFloat(inputAmount);
    if (numVal > 0) {
      const price = inputToken?.price || 0;
      const r = currRate || 1;
      if (newMode === 'fiat') {
        const fiatAmtVal = numVal * price * r;
        setInputAmount(fiatAmtVal.toFixed(2));
      } else {
        const cryptoAmtVal = price > 0 ? (numVal / r) / price : 0;
        setInputAmount(cryptoAmtVal > 0 ? String(+cryptoAmtVal.toFixed(6)) : '');
      }
    }
    setSwapInputMode(newMode);
  }, [swapInputMode, inputAmount, inputToken, currRate]);

  const inputDecimals  = inputToken?.decimals  ?? 9;
  const outputDecimals = outputToken?.decimals ?? 6;

  const amountBaseUnits = useMemo(() => {
    const n = parseFloat(inputAmount);
    if (!(n > 0)) return 0;
    
    let cryptoAmt = n;
    if (swapInputMode === 'fiat') {
      const price = inputToken?.price || 0;
      if (price <= 0) return 0;
      cryptoAmt = (n / currRate) / price;
    }
    
    return (cryptoAmt > 0) ? toBaseUnits(cryptoAmt, inputDecimals) : 0;
  }, [inputAmount, swapInputMode, currRate, inputToken, inputDecimals]);

  const { quote, loading: quoteLoading, error: quoteError, countdown, refresh } = useSwapQuote({
    inputMint: inputToken?.mint ?? null,
    outputMint: outputToken?.mint ?? null,
    amountBaseUnits,
    slippageBps,
    userPublicKey: publicKey?.toBase58() || null,
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

  const inputBalance = useMemo(() => {
    if (!inputToken || !walletTokenList) return null;
    if (inputToken.symbol === 'SOL') return walletTokenList.find(t => t.symbol === 'SOL')?.balance ?? null;
    return walletTokenList.find(t => t.mint === inputToken.mint || t.symbol === inputToken.symbol)?.balance ?? null;
  }, [inputToken, walletTokenList]);

  function handleFlip() {
    const temp = inputToken?.mint || null;
    setSelectedInputMint(outputToken?.mint || null);
    setSelectedOutputMint(temp);
    setInputAmount('');
    setSwapError(null);
    setSwapSuccess(null);
  }

  function handleMax() {
    if (inputBalance == null) return;
    const maxBalance = inputToken.symbol === 'SOL' ? Math.max(0, inputBalance - 0.01) : inputBalance;
    if (maxBalance <= 0) {
      setInputAmount('');
      return;
    }
    
    if (swapInputMode === 'fiat') {
      const price = inputToken?.price || 0;
      const r = currRate || 1;
      const fiatMax = maxBalance * price * r;
      setInputAmount(fiatMax.toFixed(2));
    } else {
      setInputAmount(String(+maxBalance.toFixed(6)));
    }
  }

  // ─── Swap transaction integrity verification ──────────────────────────────
  // Called after deserializing the VersionedTransaction received from Jupiter/Titan
  // and before simulation/signing. Mirrors verifyTransactionIntegrity() in App.jsx.
  //
  // Checks:
  //   1. Fee payer is the connected wallet (prevents fee-payer hijacking)
  //   2. No Token Approve/SetAuthority/ApproveChecked opcodes (blocks delegation attacks)
  //   3. Every instruction's program is in a known DEX allowlist (blocks unknown programs)
  //   4. Quoted input and output mints appear in transaction account keys (blocks mint substitution)
  async function verifySwapTransaction(vTx, expectedInputMint, expectedOutputMint, connectedPubkey) {
    // Resolve every Address Lookup Table (ALT) the transaction references.
    // Jupiter V6 transactions routinely use ALTs to compress account lists. Without
    // fetching them, decompile() returns an incomplete account key list and the
    // mint-presence check (step 4) becomes blind to ALT-referenced accounts.
    const altKeys = vTx.message.addressTableLookups?.map(l => l.accountKey) ?? [];
    const altAccounts = [];
    for (const key of altKeys) {
      let resp;
      try {
        resp = await connection.getAddressLookupTable(key);
      } catch (e) {
        throw new Error('[SECURITY] Failed to fetch Address Lookup Table for swap transaction — refusing to sign without full account resolution.');
      }
      if (!resp?.value) {
        throw new Error(`[SECURITY] Address Lookup Table ${key.toBase58()} returned empty — refusing to sign.`);
      }
      altAccounts.push(resp.value);
    }

    let decompiled;
    try {
      decompiled = TransactionMessage.decompile(vTx.message, { addressLookupTableAccounts: altAccounts });
    } catch (e) {
      throw new Error('[SECURITY] Could not decompile swap transaction for verification. Refusing to sign.');
    }

    // 1. Fee payer must be the connected wallet — prevents a rogue API from setting
    //    an arbitrary payer that could be used to front-run or drain a different account.
    if (!decompiled.payerKey.equals(connectedPubkey)) {
      throw new Error(
        `[SECURITY] Swap tx fee payer mismatch. Expected ${connectedPubkey.toBase58()}, ` +
        `got ${decompiled.payerKey.toBase58()}. Refusing to sign.`
      );
    }

    // 2. Dangerous token opcodes that must NEVER appear in a swap transaction.
    //    Approve (4)        — grants a delegate unlimited spend authority over the ATA
    //    SetAuthority (6)   — permanently transfers ownership of the token account
    //    ApproveChecked (25)— same as Approve but with decimals check (still dangerous)
    const BLOCKED_TOKEN_OPCODES = new Set([4, 6, 25]);
    const BLOCKED_OPCODE_NAMES  = { 4: 'Approve', 6: 'SetAuthority', 25: 'ApproveChecked' };
    const TOKEN_PROGRAMS = new Set([
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    ]);

    // 3. Strict allowlist of program IDs Jupiter/Titan may route through.
    //    Any instruction from a program not in this set causes immediate rejection.
    const ALLOWED_SWAP_PROGRAMS = new Set([
      // ── Core Solana ───────────────────────────────────────────────────────────
      '11111111111111111111111111111111',                           // System Program
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',              // SPL Token
      'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',              // Token-2022
      'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',             // Associated Token Program
      'ComputeBudget111111111111111111111111111111',                // Compute Budget
      'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',              // Memo
      // ── Jupiter ──────────────────────────────────────────────────────────────
      'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',              // Jupiter V6
      'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB',              // Jupiter V4
      'JUP3c2Uh3WA4Ng34tw6kPd2G4LFLKyz7XN5U5VifaMVH',            // Jupiter V3
      // ── Raydium ──────────────────────────────────────────────────────────────
      '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',             // Raydium AMM V4
      '5quBtoiQqxF9Jv6KYKctB59NT3gtJD2Y65kdnB1Uev3h',             // Raydium AMM V5
      'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',             // Raydium CLMM
      'routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS',              // Raydium Route
      'RVKd61ztZW9GUwhRbbLoYVRE5Xf1B2tVscKqwZqXgEr',             // Raydium (legacy)
      // ── Orca ─────────────────────────────────────────────────────────────────
      'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3sFjiste',             // Orca Whirlpool
      '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP',             // Orca V2
      'DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1',             // Orca (Aldrin)
      // ── Meteora ──────────────────────────────────────────────────────────────
      'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB',            // Meteora Dynamic AMM
      'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',             // Meteora DLMM
      'M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K',             // Meteora AMM
      // ── OpenBook / Serum ─────────────────────────────────────────────────────
      'opnb2LAfJYbRMAHHvqjCwQxanZn7n734bNwrmycumJS',              // OpenBook V2
      'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX',              // Serum DEX V3 / OpenBook V1
      '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',             // Serum DEX V3 (old)
      // ── Phoenix ──────────────────────────────────────────────────────────────
      'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY',              // Phoenix
      // ── Saber / Mercurial / Stable ───────────────────────────────────────────
      'SSwpkEEcbUqx4vtoEByFjSkhKdCT862DNVb52nZg1UZ',             // Saber
      'MERLuDFBMmsHnsBPZw2sDQZHvXFMwp8EdjudcU2pgJavB',            // Mercurial
      // ── Lifinity ─────────────────────────────────────────────────────────────
      'EewxydAPCCVuNEyrVN68PuSYdQ7wKn27V9Gjeoi8dy3S',             // Lifinity V1
      '2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXtEyPy64bL7aD3c',            // Lifinity V2
      // ── Titan ────────────────────────────────────────────────────────────────
      'TitanV9s8gN9e4mPkH9JSqnKFmiwRDTVa3t3Q9UKKAV',              // Titan (if active)
    ]);

    // Track whether we saw the expected mints in any instruction's account keys
    let sawInputMint  = false;
    let sawOutputMint = false;

    for (const ix of decompiled.instructions) {
      const pid = ix.programId.toBase58();

      // Check 2 — block dangerous token opcodes
      if (TOKEN_PROGRAMS.has(pid) && ix.data.length > 0) {
        const opcode = ix.data[0];
        if (BLOCKED_TOKEN_OPCODES.has(opcode)) {
          throw new Error(
            `[SECURITY] Swap transaction contains forbidden token instruction: ` +
            `${BLOCKED_OPCODE_NAMES[opcode] || opcode} (opcode ${opcode}). Refusing to sign.`
          );
        }
      }

      // Check 3 — program allowlist
      if (!ALLOWED_SWAP_PROGRAMS.has(pid)) {
        throw new Error(
          `[SECURITY] Swap transaction contains instruction from unknown program ${pid}. Refusing to sign.`
        );
      }

      // Check 4 — accumulate account keys to verify mints appear
      for (const { pubkey } of ix.keys) {
        const keyStr = pubkey.toBase58();
        if (keyStr === expectedInputMint)  sawInputMint  = true;
        if (keyStr === expectedOutputMint) sawOutputMint = true;
      }
    }

    // Check 4 — both quoted mints must appear somewhere in the transaction.
    // If a mint is swapped for WSOL (SOL), it may appear only as an ATA owner, so
    // we skip the check for the native SOL mint since it is implicitly the wallet address.
    const WSOL = 'So11111111111111111111111111111111111111112';
    if (!sawInputMint && expectedInputMint !== WSOL) {
      throw new Error(
        `[SECURITY] Swap transaction does not reference quoted input mint ${expectedInputMint}. ` +
        `Possible mint substitution. Refusing to sign.`
      );
    }
    if (!sawOutputMint && expectedOutputMint !== WSOL) {
      throw new Error(
        `[SECURITY] Swap transaction does not reference quoted output mint ${expectedOutputMint}. ` +
        `Possible mint substitution. Refusing to sign.`
      );
    }
  }
  // ─────────────────────────────────────────────────────────────────────────────

  const handleSwap = useCallback(async () => {
    if (swapping) return;
    if (!publicKey || !connected || !quote) return;
    setSwapError(null);
    setSwapSuccess(null);
    setSwapping(true);
    try {
      const n = parseFloat(inputAmount);
      if (!n || n <= 0) throw new Error('Enter a valid amount to swap.');

      let cryptoAmt = n;
      if (swapInputMode === 'fiat') {
        const price = inputToken?.price || 0;
        if (price <= 0) throw new Error('Cannot swap: Price of input token is not available.');
        cryptoAmt = (n / currRate) / price;
      }

      // Fresh SOL balance check
      if (inputToken.symbol === 'SOL') {
        const freshLamports = await connection.getBalance(publicKey, 'confirmed');
        if (cryptoAmt + 0.005 > freshLamports / 1e9) throw new Error(`Insufficient SOL (need ${cryptoAmt.toFixed(5)} + fees, have ${(freshLamports/1e9).toFixed(5)}).`);
      }

      const base64Tx = await buildSwapTransaction(quote, publicKey.toBase58());
      const buf      = Buffer.from(base64Tx, 'base64');
      const vTx      = VersionedTransaction.deserialize(buf);

      // Instruction-level integrity check — runs before simulation and signing.
      // Verifies fee payer, blocks dangerous opcodes, enforces DEX program allowlist,
      // and confirms the quoted mints appear in the transaction (with full ALT resolution).
      await verifySwapTransaction(
        vTx,
        quote.inputMint,
        quote.outputMint,
        publicKey
      );

      // Pre-flight simulation
      const sim = await connection.simulateTransaction(vTx);
      if (sim.value.err) {
        const logs = sim.value.logs?.slice(0, 3).join(' | ') || '';
        throw new Error(`Simulation failed: ${JSON.stringify(sim.value.err)}${logs ? ' — ' + logs : ''}`);
      }

      const sig = await sendTransaction(vTx, connection, { skipPreflight: true, maxRetries: 3 });

      // Poll confirmation
      let confirmed = false;
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        try {
          const status = await connection.getSignatureStatus(sig);
          const conf   = status?.value?.confirmationStatus;
          if (conf === 'confirmed' || conf === 'finalized') { confirmed = true; break; }
          if (status?.value?.err) throw new Error('Swap rejected: ' + JSON.stringify(status.value.err));
        } catch (pollErr) {
          if (pollErr.message.startsWith('Swap rejected')) throw pollErr;
        }
        await new Promise(r => setTimeout(r, 2000));
      }
      if (!confirmed) throw new Error('Swap submitted but confirmation timed out.');



      setSwapSuccess({ sig, from: `${n} ${inputToken.symbol}`, to: `${outputAmount?.toFixed(4) ?? '?'} ${outputToken.symbol}` });
      setInputAmount('');
      if (onSwapSuccess) onSwapSuccess();
    } catch (err) {
      
      setSwapError(err.message || 'Swap failed.');
    }
    setSwapping(false);
  }, [swapping, publicKey, connected, quote, inputAmount, inputToken, outputToken, outputAmount, connection, sendTransaction, onSwapSuccess]);

  const hasAmount = parseFloat(inputAmount) > 0;
  const canSwap   = connected && hasAmount && !swapping && !!quote && !quoteLoading;

  // Auto-dismiss errors and success messages after 10 seconds
  useEffect(() => {
    if (swapError) {
      const timer = setTimeout(() => setSwapError(null), 10000);
      return () => clearTimeout(timer);
    }
  }, [swapError]);

  useEffect(() => {
    if (swapSuccess) {
      const timer = setTimeout(() => setSwapSuccess(null), 10000);
      return () => clearTimeout(timer);
    }
  }, [swapSuccess]);

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;
    const h = (e) => { if (e.key === 'Escape') setIsOpen(false); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [isOpen]);

  return (
    <>
      {/* ── 1. Floating Pill ── */}
      <div className="swp-float-pill" onClick={() => setIsOpen(true)} role="button" aria-label="Open Swap">
        <div className="swp-pill-content">
          {/* Swap icon — two arrows */}
          <div className="swp-pill-icon-wrap">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="url(#swp-grad)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <defs>
                <linearGradient id="swp-grad" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
                  <stop stopColor="#22d3ee" />
                  <stop offset="1" stopColor="#a3e635" />
                </linearGradient>
              </defs>
              <path d="M7 16V4m0 0L3 8m4-4l4 4" />
              <path d="M17 8v12m0 0l4-4m-4 4l-4-4" />
            </svg>
          </div>
          <span className="swp-pill-label">
            <strong>Swap</strong>
          </span>
        </div>
      </div>

      {/* ── 2. Modal ── */}
      <div className={`swp-modal-overlay ${isOpen ? 'is-open' : ''}`} onClick={() => setIsOpen(false)}>
        <div className="swp-modal-sheet" onClick={e => e.stopPropagation()}>

            {/* Modal Header */}
            <div className="swp-modal-header">
              <div>
                <h2 className="swp-modal-title">
                  <span className="swp-modal-title-icon">⇄</span> Swap Tokens
                </h2>
              </div>
              <button className="swp-modal-close" onClick={() => setIsOpen(false)} aria-label="Close">✕</button>
            </div>

            {/* Slippage row */}
            <div className="swp-slip-row">
              <span className="swp-slip-lbl">Slippage:</span>
              {SLIPPAGE_PRESETS.map(p => (
                <button
                  key={p.bps}
                  className={`swp-slip-btn ${slippageBps === p.bps && !showSlippage ? 'active' : ''}`}
                  onClick={() => { setSlippageBps(p.bps); setShowSlippage(false); setCustomSlip(''); }}
                >{p.label}</button>
              ))}
              <button
                className={`swp-slip-btn ${showSlippage ? 'active' : ''}`}
                onClick={() => setShowSlippage(s => !s)}
              >Custom</button>
              {showSlippage && (
                <div className="swp-custom-wrap">
                  <input
                    type="number"
                    className="swp-custom-input"
                    placeholder="e.g. 2"
                    value={customSlip}
                    min="0.01" max="50" step="0.1"
                    onChange={e => {
                      setCustomSlip(e.target.value);
                      const v = parseFloat(e.target.value);
                      if (v > 0 && v <= 50) setSlippageBps(Math.round(v * 100));
                    }}
                  />
                  <span className="swp-custom-pct">%</span>
                </div>
              )}
            </div>

            {/* FROM field */}
            <div className="swp-field-card">
              <div className="swp-field-top">
                <span className="swp-field-lbl">From</span>
                {connected && inputBalance != null && (
                  <span className="swp-bal-row">
                    Bal: <strong>{swapInputMode === 'fiat' && inputTokenPrice > 0
                      ? fmtFiat(inputBalance * inputTokenPrice * currRate, currency)
                      : (inputBalance < 0.0001 ? inputBalance.toExponential(2) : inputBalance.toLocaleString(undefined, { maximumFractionDigits: 4 }))} {swapInputMode === 'crypto' ? inputToken?.symbol : ''}</strong>
                    <button className="swp-max-btn" onClick={handleMax}>MAX</button>
                  </span>
                )}
              </div>
              
              {swapInputMode === 'fiat' && (
                <div style={{ marginBottom: '8px' }}>
                  <CurrDrop selected={currency} onSelect={setCurrency} showAsRow={true}
                    rateLabel={`1 USD = ${(currRate || 1).toLocaleString()} ${currency}`} />
                </div>
              )}

              <div className="swp-field-body">
                <TokenPicker
                  selected={inputToken}
                  options={allOptions}
                  onChange={t => { setSelectedInputMint(t.mint); setInputAmount(''); setSwapError(null); setSwapSuccess(null); }}
                  excludeMint={outputToken?.mint}
                  id="swap-input-picker"
                  onAddCustomToken={handleAddCustomToken}
                />
                <input
                  id="swap-amount-input"
                  className="swp-amount-input"
                  type="number"
                  placeholder="0.00"
                  value={inputAmount}
                  min="0"
                  step="any"
                  onChange={e => { setInputAmount(e.target.value); setSwapError(null); setSwapSuccess(null); }}
                />
              </div>

              <div className="swp-divider" style={{ height: '1px', background: 'var(--border)', margin: '10px 0 8px 0', opacity: 0.3 }} />

              <div className="swp-field-bottom" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="swp-converted-lbl" style={{ fontSize: '11px', color: 'var(--text3)', fontFamily: 'var(--mono)' }}>{convertedLabel}</span>
                <div className="input-mode-toggle">
                  <button className={`imt-btn ${swapInputMode === 'fiat' ? 'active' : ''}`} type="button" onClick={() => toggleInputMode('fiat')}>{currency}</button>
                  <button className={`imt-btn ${swapInputMode === 'crypto' ? 'active' : ''}`} disabled={!inputToken} type="button" onClick={() => toggleInputMode('crypto')}>{inputToken?.symbol || 'Token'}</button>
                </div>
              </div>
            </div>

            {/* Flip + Countdown row */}
            <div className="swp-flip-row">
              <button className="swp-flip-btn" onClick={handleFlip} title="Flip tokens" id="swap-flip-btn" type="button">↕</button>
              {hasAmount && (
                <span className="swp-countdown" onClick={refresh} title="Click to refresh" style={{ cursor: 'pointer' }}>
                  {quoteLoading
                    ? <><span className="swp-mini-spin" /> Refreshing…</>
                    : <>🔄 {countdown}s</>
                  }
                </span>
              )}
            </div>

            {/* TO field */}
            <div className="swp-field-card">
              <div className="swp-field-top">
                <span className="swp-field-lbl">To (estimated)</span>
                {outputAmount != null && outputToken?.price > 0 && (
                  <span style={{ fontSize: '11px', color: 'var(--text3)', fontFamily: 'var(--mono)' }}>
                    ≈ {fmtFiat(outputAmount * outputToken.price * currRate, currency)}
                  </span>
                )}
              </div>
              <div className="swp-field-body">
                <TokenPicker
                  selected={outputToken}
                  options={allOptions}
                  onChange={t => { setSelectedOutputMint(t.mint); setSwapError(null); setSwapSuccess(null); }}
                  excludeMint={inputToken?.mint}
                  id="swap-output-picker"
                  onAddCustomToken={handleAddCustomToken}
                />
                <div className="swp-output-wrap">
                  {quoteLoading && hasAmount
                    ? <span className="swp-output-loading"><span className="swp-mini-spin" /> Fetching…</span>
                    : outputAmount != null
                      ? <span className="swp-output-num">{outputAmount < 0.0001 ? outputAmount.toExponential(4) : outputAmount.toLocaleString(undefined, { maximumFractionDigits: outputDecimals > 4 ? 4 : outputDecimals })}</span>
                      : <span className="swp-output-placeholder">—</span>
                  }
                </div>
              </div>
            </div>

            {/* Route info */}
            {quote && !quoteLoading && (
              <div className="swp-route-box">
                <div className="swp-route-row">
                  <span>Price impact</span>
                  <span className={`swp-impact-${priceImpact?.severity}`}>{priceImpact?.label ?? '—'}</span>
                </div>
                <div className="swp-route-row">
                  <span>Min received</span>
                  <span>{minReceived != null ? `${minReceived < 0.0001 ? minReceived.toExponential(3) : minReceived.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${outputToken?.symbol}` : '—'}</span>
                </div>
                {quote.routePlan?.length > 0 && (
                  <div className="swp-route-row">
                    <span>Route</span>
                    <span className="swp-route-path">
                      {[inputToken?.symbol,
                        ...quote.routePlan.map(r => r.swapInfo?.label || '').filter(Boolean),
                        outputToken?.symbol
                      ].join(' → ')}
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* Quote error */}
            {quoteError && hasAmount && !quoteLoading && (
              <div className="swp-error-msg">⚠ {quoteError}</div>
            )}

            {/* Swap error */}
            {swapError && (
              <div className="swp-error-msg">✕ {swapError}</div>
            )}

            {/* Success */}
            {swapSuccess && (
              <div className="swp-success-msg">
                <div>✓ Swapped <strong>{swapSuccess.from}</strong> → <strong>{swapSuccess.to}</strong></div>
                <a href={`https://solscan.io/tx/${swapSuccess.sig}`} target="_blank" rel="noopener noreferrer" className="swp-solscan">
                  {swapSuccess.sig.slice(0, 8)}… View on Solscan ↗
                </a>
              </div>
            )}

            {/* CTA */}
            {connected ? (
              <button
                id="swap-submit-btn"
                className="swp-submit-btn"
                disabled={!canSwap}
                onClick={handleSwap}
                type="button"
              >
                {swapping
                  ? <><span className="swp-btn-spin" /> Swapping…</>
                  : !hasAmount    ? 'Enter an amount'
                  : quoteLoading  ? 'Fetching best price…'
                  : !quote        ? 'No route found'
                  : `Swap ${inputToken?.symbol} → ${outputToken?.symbol}`}
              </button>
            ) : (
              <button className="swp-submit-btn swp-connect-btn" onClick={() => { setVisible(true); setIsOpen(false); }} type="button">
                Connect Wallet to Swap
              </button>
            )}

            {/* Modal footer */}
            <div className="swp-modal-footer">
              <button className="swp-back-btn" onClick={() => setIsOpen(false)}>← Back</button>
            </div>

          </div>
        </div>
    </>
  );
}
