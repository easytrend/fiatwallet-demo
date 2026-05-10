import { useState, useMemo, useEffect, useCallback } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { PublicKey } from '@solana/web3.js';
import { TOKENS, KNOWN_MINTS } from './data/tokens';
import { CURRENCIES } from './data/currencies';
import { useLiveRates } from './hooks/useLiveRates';
import { fmtTok, fmtFiat, fmtRate } from './utils';
import CurrDrop from './components/CurrDrop';
import AmountInput from './components/AmountInput';
import BulkSendPanel from './components/BulkSendPanel';
import TokenModal from './components/TokenModal';

const SNS_LINK = 'https://www.sns.id?easytrend.sol';

export default function App() {
  const { connection } = useConnection();
  const { publicKey, connected, disconnect } = useWallet();
  const { setVisible } = useWalletModal();

  // SPL Token Program ID
  const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

  const [bulkMode, setBulkMode] = useState(false);
  const [solBalance, setSolBalance] = useState(null);
  const [splTokens, setSplTokens] = useState([]);
  const [walletLoading, setWalletLoading] = useState(false);
  const [walletError, setWalletError] = useState(null);
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [inputMode, setInputMode] = useState('fiat');
  const [token, setToken] = useState('USDC');
  const [showModal, setShowModal] = useState(false);

  const { liveRates, ratesLoading } = useLiveRates();

  const walletPubkey = publicKey?.toString() || null;

  function getLiveCurrRate(code) {
    const s = CURRENCIES.find(c => c.code === code) || CURRENCIES[0];
    return liveRates.fiat[code] || s.rate;
  }
  function getLiveTokPrice(symbol) {
    const s = TOKENS.find(t => t.symbol === symbol);
    return liveRates.crypto[symbol] || s?.price || 0;
  }

  const liveSolPrice = liveRates.crypto['SOL'] || 148.5;

  // Build wallet token list — SOL + real SPL tokens from chain
  const walletTokenList = useMemo(() => {
    if (!connected) return null;
    const solEntry = {
      symbol: 'SOL', name: 'Solana', color: '#9945FF', bg: '#2d1a4e',
      price: liveSolPrice, balance: solBalance
    };
    const splEntries = splTokens.map(t => {
      const meta = TOKENS.find(x => x.symbol === t.symbol) || { color: '#aaa', bg: 'rgba(255,255,255,0.08)' };
      return { ...meta, ...t, price: liveRates.crypto[t.symbol] || t.price || meta.price || 0, balance: t.uiAmount };
    });
    return [solEntry, ...splEntries];
  }, [connected, solBalance, splTokens, liveRates]);

  // Show all static tokens (with balances if held) + any extra tokens from the wallet
  const selectableTokens = useMemo(() => {
    if (!connected || !walletTokenList) {
      return TOKENS.map(t => ({ ...t, price: getLiveTokPrice(t.symbol) || t.price || 0 }));
    }
    
    const staticWithBalances = TOKENS.map(t => {
      const wt = walletTokenList.find(w => w.symbol === t.symbol);
      const livePrice = getLiveTokPrice(t.symbol) || t.price || 0;
      return wt ? { ...t, price: livePrice, balance: wt.balance } : { ...t, price: livePrice };
    });
    
    const extraTokens = walletTokenList.filter(wt => !TOKENS.find(t => t.symbol === wt.symbol));
    
    return [...staticWithBalances, ...extraTokens];
  }, [connected, walletTokenList, liveRates]);

  const tok = (walletTokenList && walletTokenList.find(t => t.symbol === token))
    || TOKENS.find(t => t.symbol === token) || TOKENS[1];
  const curr = CURRENCIES.find(c => c.code === currency) || CURRENCIES[0];
  const currRate = getLiveCurrRate(currency);
  const tokPrice = getLiveTokPrice(tok.symbol) || tok.price || 1;
  const num = parseFloat(amount) || 0;
  const tokAmt = inputMode === 'fiat' ? (num / currRate) / tokPrice : num;
  const dispTok = fmtTok(tokAmt);
  const tokLive = { ...tok, price: tokPrice };

  // Fetch real on-chain balances using the wallet-adapter connection object
  const fetchBalances = useCallback(async () => {
    if (!publicKey || !connected) return;
    setWalletLoading(true);
    setWalletError(null);
    try {
      // SOL balance
      const lamports = await connection.getBalance(publicKey, 'confirmed');
      setSolBalance(lamports / 1e9);

      // All SPL token accounts owned by this wallet
      const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
        publicKey,
        { programId: TOKEN_PROGRAM_ID }
      );

      const toks = tokenAccounts.value
        .map(account => {
          const info = account.account.data.parsed.info;
          const mint = info.mint;
          const uiAmount = info.tokenAmount.uiAmount || 0;
          const meta = KNOWN_MINTS[mint] || {};
          return {
            mint,
            uiAmount,
            // Use known metadata if available, otherwise show truncated mint
            symbol: meta.symbol || mint.slice(0, 4) + '…',
            name:   meta.name   || 'Unknown (' + mint.slice(0, 8) + '…)',
            price:  meta.price  || 0,
            color:  meta.color  || '#aaa',
            bg:     meta.bg     || 'rgba(255,255,255,0.08)',
          };
        })
        .filter(t => t.uiAmount > 0)
        .sort((a, b) => (b.uiAmount * (b.price || 0)) - (a.uiAmount * (a.price || 0)));

      setSplTokens(toks);
    } catch (e) {
      setWalletError(e.message || 'Failed to fetch balances');
      console.error('fetchBalances error:', e);
    }
    setWalletLoading(false);
  }, [connection, publicKey, connected, TOKEN_PROGRAM_ID]);

  // Auto-fetch when wallet connects or changes
  useEffect(() => {
    if (connected && publicKey) fetchBalances();
    else { setSolBalance(null); setSplTokens([]); setWalletError(null); }
  }, [connected, publicKey?.toString()]);

  function handleDisconnect() {
    disconnect();
    // state cleanup handled by useEffect watching [connected]
  }

  return (
    <div className="page">
      <div className="hex-bg" />
      <nav>
        {liveRates.updatedAt && (
          <span style={{fontSize:10,color:'var(--green)',fontFamily:'var(--mono)',background:'rgba(74,222,128,0.08)',border:'1px solid rgba(74,222,128,0.2)',borderRadius:8,padding:'3px 8px',whiteSpace:'nowrap'}}>
            {ratesLoading ? '⟳ updating…' : `⚡ Live · ${liveRates.updatedAt}`}
          </span>
        )}
        {connected && walletPubkey && (
          <span className="nav-addr" title={walletPubkey}>{walletPubkey.slice(0,4) + '…' + walletPubkey.slice(-4)}</span>
        )}
        {connected
          ? <button className="btn-connected" onClick={handleDisconnect}><span className="live-dot" />Disconnect ▾</button>
          : <button className="btn-connect" onClick={() => setVisible(true)}>Connect Wallet</button>
        }
      </nav>

      <div className="main">
        <div className="app-card">
          <div className="card-body">
            <div className="title-row">
              <div className="card-title">{bulkMode ? 'Bulk Send' : 'Send Crypto'}</div>
              <div className={`bulk-pill ${bulkMode ? 'on' : ''}`} onClick={() => setBulkMode(b => !b)}>
                <span className="pill-txt">{bulkMode ? 'Bulk ON' : 'Bulk'}</span>
                <div className={`tsw ${bulkMode ? 'on' : ''}`}><div className="tknob" /></div>
              </div>
            </div>
            <p className="card-sub">{bulkMode ? 'Send to up to 1,000 wallets or .sol domains at once.' : 'Send tokens easily using .sol domains.'}</p>

            {!bulkMode && (
              <div className="field">
                <div className="field-label">Send To</div>
                <div className="input-wrap">
                  <span className="sol-icon">◎</span>
                  <input value={recipient} onChange={e => setRecipient(e.target.value)} placeholder="example.sol" />
                </div>
              </div>
            )}

            <div className="field">
              <div className="field-label">Select Token</div>
              <div className="token-row" onClick={() => setShowModal(true)}>
                <div className="tok-left">
                  <div className="tok-icon" style={{background:tokLive.bg,color:tokLive.color}}>{tokLive.symbol.slice(0,4)}</div>
                  <div>
                    <span className="tok-sym">{tokLive.symbol}</span>
                    <span style={{fontSize:11,color:'var(--text3)',marginLeft:6}}>${tokLive.price < 0.01 ? tokLive.price.toFixed(6) : tokLive.price.toLocaleString()}</span>
                  </div>
                </div>
                <div style={{display:'flex',alignItems:'center',gap:8}}>
                  {!bulkMode && <span className="tok-equiv">≈ {dispTok} {tokLive.symbol}</span>}
                  <span className="tok-chevron">›</span>
                </div>
              </div>
            </div>

            <div className="rate-badge" style={{marginBottom:'0.75rem'}}>
              <span className="rate-dot" />
              1 {tokLive.symbol} = <strong>${tokLive.price < 0.0001 ? tokLive.price.toFixed(8) : tokLive.price < 1 ? tokLive.price.toFixed(4) : tokLive.price.toLocaleString()}</strong> USD
              <span className="rate-sep">·</span>
              1 USD = <strong>{fmtRate(currRate)}</strong> {currency}
              {liveRates.updatedAt && <span style={{color:'var(--text3)',fontSize:10}}> · live</span>}
            </div>

            {bulkMode ? (
              <BulkSendPanel tok={tokLive} connected={connected} getLiveRate={getLiveCurrRate} />
            ) : (
              <>
                <div className="field">
                  <div className="field-label">Amount</div>
                  <AmountInput amount={amount} setAmount={setAmount} inputMode={inputMode} setInputMode={setInputMode}
                    currency={currency} setCurrency={setCurrency} tok={tokLive} currRate={currRate} />
                </div>
                <button className="send-btn" disabled={!connected || !recipient || !num}>
                  {!connected ? 'Connect wallet to send' : !recipient ? 'Enter a .sol recipient' : `Send ${dispTok} ${tokLive.symbol}`}
                </button>
              </>
            )}
          </div>
        </div>

        <div className="info-panel">
          <div className="info-card">
            <h3>How it works</h3>
            <ul className="info-steps">
              <li className="info-step"><span className="step-num">1</span><span>Connect any Solana wallet — Phantom, Solflare, Backpack, Ledger & more</span></li>
              <li className="info-step"><span className="step-num">2</span><span>Enter a .sol domain — SNS resolves it to a wallet address</span></li>
              <li className="info-step"><span className="step-num">3</span><span>Enter fiat or crypto amount. Live CoinGecko rate auto-converts</span></li>
              <li className="info-step"><span className="step-num">4</span><span>Confirm and send — settles on Solana instantly</span></li>
            </ul>
          </div>
          <div className="info-card">
            <h3>Fiat ↔ Crypto Input</h3>
            <p>Toggle between entering amounts in your local currency or directly in crypto. The other value updates live using CoinGecko rates.</p>
          </div>
          <div className="info-card">
            <h3>Bulk Send</h3>
            <p>Toggle Bulk Send to pay up to 1,000 wallets in one go. Upload CSV or XLSX, set amounts in fiat or crypto, and fire one transaction.</p>
          </div>
        </div>
      </div>

      <footer>
        Powered by <a href="https://x.com/solana" target="_blank" rel="noopener">Solana</a> ·
        Domains by <a href="https://x.com/sns" target="_blank" rel="noopener">SNS</a> ·
        Rates by <a href="https://x.com/coingecko?s=20" target="_blank" rel="noopener">CoinGecko</a>
      </footer>

      {showModal && (
        <TokenModal
          filteredTokens={selectableTokens}
          connected={connected}
          walletLoading={walletLoading}
          solBalance={solBalance}
          onSelect={sym => { setToken(sym); setShowModal(false); }}
          onClose={() => setShowModal(false)}
          onRefresh={fetchBalances}
        />
      )}
    </div>
  );
}
