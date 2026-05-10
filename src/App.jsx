import { useState, useMemo } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { TOKENS, KNOWN_MINTS, TOKEN_PROGRAM } from './data/tokens';
import { CURRENCIES } from './data/currencies';
import { useLiveRates } from './hooks/useLiveRates';
import { fmtTok, fmtFiat, fmtRate, rpcFetch } from './utils';
import CurrDrop from './components/CurrDrop';
import AmountInput from './components/AmountInput';
import BulkSendPanel from './components/BulkSendPanel';
import TokenModal from './components/TokenModal';

const SNS_LINK = 'https://www.sns.id?easytrend.sol';

export default function App() {
  const { publicKey, connected, disconnect } = useWallet();
  const { setVisible } = useWalletModal();

  const [bulkMode, setBulkMode] = useState(false);
  const [solBalance, setSolBalance] = useState(null);
  const [splTokens, setSplTokens] = useState([]);
  const [walletLoading, setWalletLoading] = useState(false);
  const [walletError, setWalletError] = useState(null);
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('1000');
  const [currency, setCurrency] = useState('NGN');
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

  const walletTokenList = useMemo(() => {
    if (!connected) return null;
    const solEntry = { symbol:'SOL', name:'Solana', color:'#9945FF', bg:'#2d1a4e', price: liveSolPrice, balance: solBalance };
    const splEntries = splTokens.map(t => {
      const meta = TOKENS.find(x => x.symbol === t.symbol) || { color:'#aaa', bg:'rgba(255,255,255,0.08)' };
      return { ...meta, ...t, price: liveRates.crypto[t.symbol] || t.price || meta.price || 0 };
    });
    return [solEntry, ...splEntries];
  }, [connected, solBalance, splTokens, liveRates]);

  const selectableTokens = useMemo(() => TOKENS.map(t => {
    const wt = walletTokenList && walletTokenList.find(w => w.symbol === t.symbol);
    const livePrice = getLiveTokPrice(t.symbol) || t.price || 0;
    return wt ? { ...t, price: livePrice, balance: wt.balance } : { ...t, price: livePrice };
  }), [walletTokenList, liveRates]);

  const tok = (walletTokenList && walletTokenList.find(t => t.symbol === token))
    || TOKENS.find(t => t.symbol === token) || TOKENS[1];
  const curr = CURRENCIES.find(c => c.code === currency) || CURRENCIES[0];
  const currRate = getLiveCurrRate(currency);
  const tokPrice = getLiveTokPrice(tok.symbol) || tok.price || 1;
  const num = parseFloat(amount) || 0;
  const tokAmt = inputMode === 'fiat' ? (num / currRate) / tokPrice : num;
  const dispTok = fmtTok(tokAmt);
  const tokLive = { ...tok, price: tokPrice };

  async function fetchBalances(pubkey) {
    setWalletLoading(true); setWalletError(null);
    try {
      const balRes = await rpcFetch('getBalance', [pubkey, { commitment:'confirmed' }]);
      setSolBalance(balRes.value / 1e9);
      const tokRes = await rpcFetch('getTokenAccountsByOwner', [
        pubkey, { programId: TOKEN_PROGRAM }, { encoding:'jsonParsed', commitment:'confirmed' }
      ]);
      const toks = (tokRes.value || []).map(a => {
        const info = a.account.data.parsed.info;
        const mint = info.mint;
        const uiAmount = info.tokenAmount.uiAmount || 0;
        const meta = KNOWN_MINTS[mint] || {};
        return { mint, uiAmount, symbol: meta.symbol, name: meta.name, price: meta.price };
      }).filter(t => t.uiAmount > 0).sort((a,b) => (b.uiAmount*(b.price||0)) - (a.uiAmount*(a.price||0)));
      setSplTokens(toks);
    } catch(e) { setWalletError(e.message || 'RPC error'); }
    setWalletLoading(false);
  }

  // Auto-fetch balances when wallet connects
  useMemo(() => {
    if (connected && walletPubkey) fetchBalances(walletPubkey);
  }, [connected, walletPubkey]);

  function handleDisconnect() {
    disconnect();
    setSolBalance(null); setSplTokens([]); setWalletError(null);
  }

  return (
    <div className="page">
      <div className="hex-bg" />
      <nav>
        <a href={SNS_LINK} target="_blank" rel="noopener noreferrer" className="btn-register">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.5" stroke="#a3e635" strokeWidth="1.4"/><path d="M5.5 8.5c.8-.8 4.5-.8 4.5 0s-1.8 2-2.25 2" stroke="#a3e635" strokeWidth="1.3" strokeLinecap="round"/><circle cx="8" cy="5.5" r="0.7" fill="#a3e635"/></svg>
          Register .sol domain
        </a>
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

            <div className="sns-banner">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.5" stroke="#a3e635" strokeWidth="1.3"/><circle cx="8" cy="5.5" r="0.7" fill="#a3e635"/><path d="M8 8v3.5" stroke="#a3e635" strokeWidth="1.3" strokeLinecap="round"/></svg>
              {bulkMode ? 'Ensure recipients have .sol domains —' : 'No .sol domain yet?'}&nbsp;
              <a href={SNS_LINK} target="_blank" rel="noopener noreferrer">{bulkMode ? 'Register on SNS →' : 'Register yours on SNS →'}</a>
            </div>

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
          <div className="info-card">
            <h3>No .sol domain yet?</h3>
            <p>Register yours on SNS and use it across all Solana apps as your Web3 identity.</p>
            <a href={SNS_LINK} target="_blank" rel="noopener noreferrer"
              style={{display:'inline-block',marginTop:10,color:'#a3e635',fontSize:13,fontWeight:600,textDecoration:'none'}}>
              Register on SNS →
            </a>
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
        />
      )}
    </div>
  );
}
