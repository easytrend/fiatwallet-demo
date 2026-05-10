import { useState, useMemo, useEffect, useCallback } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { PublicKey, Transaction, SystemProgram } from '@solana/web3.js';
import { getDomainKeySync, NameRegistryState, performReverseLookup, getFavoriteDomain, resolve } from '@bonfida/spl-name-service';
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction } from '@solana/spl-token';
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
  const { publicKey, connected, disconnect, sendTransaction, signAllTransactions } = useWallet();
  const { setVisible } = useWalletModal();

  // SPL Token Program ID
  const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

  const [bulkMode, setBulkMode] = useState(false);
  const [solBalance, setSolBalance] = useState(null);
  const [splTokens, setSplTokens] = useState([]);
  const [walletLoading, setWalletLoading] = useState(false);
  const [walletError, setWalletError] = useState(null);
  const [walletDomain, setWalletDomain] = useState(null);
  const [recipient, setRecipient] = useState('');
  const [resolvedAddress, setResolvedAddress] = useState(null);
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState(null);
  const [sending, setSending] = useState(false);
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [inputMode, setInputMode] = useState('fiat');
  const [token, setToken] = useState('');
  const [showModal, setShowModal] = useState(false);

  const { liveRates, ratesLoading } = useLiveRates();

  const walletPubkey = publicKey?.toString() || null;

  // Resolve .sol domains automatically
  useEffect(() => {
    async function checkDomain() {
      if (recipient.endsWith('.sol')) {
        setResolving(true);
        setResolveError(null);
        setResolvedAddress(null);
        try {
          // Promise.race to prevent infinite 429 retries
          const address = await Promise.race([
            resolve(connection, recipient),
            new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout')), 7000))
          ]);
          setResolvedAddress(address.toBase58());
        } catch (err) {
          setResolveError('Domain not found or invalid');
        }
        setResolving(false);
      } else if (recipient.length > 30) {
        // Assume raw pubkey
        setResolvedAddress(recipient);
        setResolveError(null);
      } else {
        setResolvedAddress(null);
        setResolveError(null);
      }
    }
    const t = setTimeout(checkDomain, 500);
    return () => clearTimeout(t);
  }, [recipient, connection]);

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

  // When connected → show ONLY real wallet tokens
  // When not connected → show full static list so user can browse
  const selectableTokens = useMemo(() => {
    if (connected && walletTokenList) return walletTokenList;
    return TOKENS.map(t => ({ ...t, price: getLiveTokPrice(t.symbol) || t.price || 0 }));
  }, [connected, walletTokenList, liveRates]);

  const tok = token ? ((walletTokenList && walletTokenList.find(t => t.symbol === token))
    || TOKENS.find(t => t.symbol === token)) : null;
  const curr = CURRENCIES.find(c => c.code === currency) || CURRENCIES[0];
  const currRate = getLiveCurrRate(currency);
  const tokPrice = tok ? (getLiveTokPrice(tok.symbol) || tok.price || 1) : 1;
  const num = parseFloat(amount) || 0;
  const tokAmt = inputMode === 'fiat' ? (num / currRate) / tokPrice : num;
  const dispTok = fmtTok(tokAmt);
  const tokLive = tok ? { ...tok, price: tokPrice } : null;

  // Fetch real on-chain balances using the wallet-adapter connection object
  const fetchBalances = useCallback(async () => {
    if (!publicKey || !connected) return;
    setWalletLoading(true);
    setWalletError(null);
    try {
      // SOL balance
      const lamports = await connection.getBalance(publicKey, 'confirmed');
      setSolBalance(lamports / 1e9);

      // We must fetch by mint because publicnode RPC blocks querying by programId
      const mintKeys = Object.keys(KNOWN_MINTS);
      const tokenPromises = mintKeys.map(mint => 
        connection.getParsedTokenAccountsByOwner(
          publicKey,
          { mint: new PublicKey(mint) }
        ).catch(() => ({ value: [] })) // Handle individual failures gracefully
      );
      
      const results = await Promise.all(tokenPromises);
      const toks = [];
      
      results.forEach((res, i) => {
        if (!res.value || res.value.length === 0) return;
        const mint = mintKeys[i];
        let totalAmount = 0;
        
        // A user might have multiple token accounts for the same mint
        res.value.forEach(account => {
          totalAmount += account.account.data.parsed.info.tokenAmount.uiAmount || 0;
        });
        
        if (totalAmount > 0) {
          const meta = KNOWN_MINTS[mint];
          toks.push({
            mint,
            uiAmount: totalAmount,
            symbol: meta.symbol,
            name: meta.name,
            price: meta.price || 0,
            color: meta.color || '#aaa',
            bg: meta.bg || 'rgba(255,255,255,0.08)',
          });
        }
      });
      
      toks.sort((a, b) => (b.uiAmount * (b.price || 0)) - (a.uiAmount * (a.price || 0)));

      setSplTokens(toks);
    } catch (e) {
      setWalletError(e.message || 'Failed to fetch balances');
      console.error('fetchBalances error:', e);
    }
    setWalletLoading(false);
  }, [connection, publicKey, connected, TOKEN_PROGRAM_ID]);

  // Auto-fetch when wallet connects or changes
  useEffect(() => {
    if (connected && publicKey) {
      fetchBalances();
      getFavoriteDomain(connection, publicKey)
        .then(fav => {
          if (fav && fav.reverse) setWalletDomain(fav.reverse + '.sol');
          else throw new Error("No favorite");
        })
        .catch(() => {
          performReverseLookup(connection, publicKey)
            .then(domain => {
              if (domain) setWalletDomain(domain + '.sol');
              else setWalletDomain(null);
            })
            .catch(() => setWalletDomain(null));
        });
    } else { 
      setSolBalance(null); 
      setSplTokens([]); 
      setWalletError(null); 
      setWalletDomain(null);
    }
  }, [connected, publicKey?.toString()]);

  function handleDisconnect() {
    disconnect();
    // state cleanup handled by useEffect watching [connected]
  }

  async function handleSend() {
    if (!publicKey || !connection || !num) return;
    
    setSending(true);
    setWalletError(null);
    try {
      const finalRecipient = new PublicKey(resolvedAddress || recipient);
      const transaction = new Transaction();

      if (tokLive.symbol === 'SOL') {
        const lamports = Math.round(tokAmt * 1e9);
        transaction.add(
          SystemProgram.transfer({
            fromPubkey: publicKey,
            toPubkey: finalRecipient,
            lamports
          })
        );
      } else {
        const mintPubkey = new PublicKey(tokLive.mint);
        
        // Fetch decimals from on-chain mint info
        const mintInfo = await connection.getParsedAccountInfo(mintPubkey);
        if (!mintInfo.value) throw new Error("Invalid token mint");
        const decimals = mintInfo.value.data.parsed.info.decimals;
        
        const amountUnits = BigInt(Math.round(tokAmt * Math.pow(10, decimals)));

        const senderATA = getAssociatedTokenAddressSync(mintPubkey, publicKey);
        const receiverATA = getAssociatedTokenAddressSync(mintPubkey, finalRecipient);

        transaction.add(
          createAssociatedTokenAccountIdempotentInstruction(
            publicKey, // payer
            receiverATA, // ata
            finalRecipient, // owner
            mintPubkey // mint
          )
        );

        transaction.add(
          createTransferCheckedInstruction(
            senderATA, // source
            mintPubkey, // mint
            receiverATA, // destination
            publicKey, // owner of source
            amountUnits, // amount
            decimals // decimals
          )
        );
      }

      const latestBlockhash = await connection.getLatestBlockhash();
      transaction.recentBlockhash = latestBlockhash.blockhash;
      transaction.feePayer = publicKey;

      const signature = await sendTransaction(transaction, connection);
      console.log('Transaction sent:', signature);
      
      await connection.confirmTransaction({
        signature,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
      }, 'confirmed');
      
      alert(`Successfully sent ${dispTok} ${tokLive.symbol}!`);
      
      fetchBalances();
      setAmount('');
      setRecipient('');
      setResolvedAddress(null);
      
    } catch (err) {
      console.error('Send failed:', err);
      setWalletError(err.message || 'Transaction failed');
    }
    setSending(false);
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
          <span className="nav-addr" title={walletPubkey}>{walletDomain || (walletPubkey.slice(0,4) + '…' + walletPubkey.slice(-4))}</span>
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
                  <input value={recipient} onChange={e => setRecipient(e.target.value)} placeholder="example.sol or address" />
                </div>
                {resolving && <div style={{fontSize:11, color:'var(--text3)', marginTop:6}}>Resolving domain…</div>}
                {resolveError && <div style={{fontSize:11, color:'#f87171', marginTop:6}}>✕ {resolveError}</div>}
                {resolvedAddress && recipient.endsWith('.sol') && (
                  <div style={{fontSize:11, color:'var(--lime)', marginTop:6}}>
                    ✓ Resolved: {resolvedAddress.slice(0,4)}…{resolvedAddress.slice(-4)}
                  </div>
                )}
              </div>
            )}

            <div className="field">
              <div className="field-label">Select Token</div>
              <div className="token-row" onClick={() => setShowModal(true)}>
                {tokLive ? (
                  <>
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
                  </>
                ) : (
                  <>
                    <div className="tok-left">
                      <div className="tok-icon" style={{background:'rgba(255,255,255,0.05)',color:'var(--text3)'}}>?</div>
                      <div>
                        <span className="tok-sym" style={{color:'var(--text2)'}}>Select Token</span>
                      </div>
                    </div>
                    <div style={{display:'flex',alignItems:'center',gap:8}}>
                      <span className="tok-chevron">›</span>
                    </div>
                  </>
                )}
              </div>
            </div>

            {tokLive && (
              <div className="rate-badge" style={{marginBottom:'0.75rem'}}>
                <span className="rate-dot" />
                1 {tokLive.symbol} = <strong>${tokLive.price < 0.0001 ? tokLive.price.toFixed(8) : tokLive.price < 1 ? tokLive.price.toFixed(4) : tokLive.price.toLocaleString()}</strong> USD
                <span className="rate-sep">·</span>
                1 USD = <strong>{fmtRate(currRate)}</strong> {currency}
                {liveRates.updatedAt && <span style={{color:'var(--text3)',fontSize:10}}> · live</span>}
              </div>
            )}

            {bulkMode ? (
              <BulkSendPanel tok={tokLive} connected={connected} getLiveRate={getLiveCurrRate}
                connection={connection} publicKey={publicKey}
                sendTransaction={sendTransaction} signAllTransactions={signAllTransactions} />
            ) : (
              <>
                <div className="field">
                  <div className="field-label">Amount</div>
                  <AmountInput amount={amount} setAmount={setAmount} inputMode={inputMode} setInputMode={setInputMode}
                    currency={currency} setCurrency={setCurrency} tok={tokLive} currRate={currRate} />
                </div>
                {walletError && <div style={{fontSize:12, color:'#f87171', marginBottom:12, padding:'8px 12px', background:'rgba(248,113,113,0.1)', borderRadius:8}}>{walletError}</div>}
                <button className="send-btn" disabled={!connected || !tokLive || !recipient || !num || (recipient.endsWith('.sol') && !resolvedAddress) || sending} onClick={handleSend}>
                  {sending ? 'Sending…' : !connected ? 'Connect wallet to send' : !tokLive ? 'Select a token to continue' : (!recipient || (recipient.endsWith('.sol') && !resolvedAddress)) ? 'Enter a valid recipient' : `Send ${dispTok} ${tokLive.symbol}`}
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
