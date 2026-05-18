import { useState, useMemo, useEffect, useCallback } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { PublicKey, Transaction, SystemProgram, Connection, VersionedTransaction, TransactionMessage } from '@solana/web3.js';
import { getDomainKeySync, NameRegistryState, performReverseLookup, getPrimaryDomain, getFavoriteDomain, resolve } from '@bonfida/spl-name-service';
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction } from '@solana/spl-token';
import logoImg from './assets/logo.png';
import { TOKENS, KNOWN_MINTS } from './data/tokens';
import { CURRENCIES } from './data/currencies';
import { useLiveRates } from './hooks/useLiveRates';
import { fmtTok, fmtFiat, fmtRate } from './utils';
import CurrDrop from './components/CurrDrop';
import AmountInput from './components/AmountInput';
import BulkSendPanel from './components/BulkSendPanel';
import TokenModal from './components/TokenModal';
import Toast from './components/Toast';

const SNS_LINK = 'https://www.sns.id?easytrend.sol';

export default function App() {
  const { connection } = useConnection();
  const { publicKey, connected, disconnect, sendTransaction, signTransaction, signAllTransactions } = useWallet();
  const { setVisible } = useWalletModal();

  // SPL Token Program ID
  const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

  const [inputMode, setInputMode] = useState('fiat'); // fiat or crypto
  const [bulkMode, setBulkMode] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [walletPubkey, setWalletPubkey] = useState(null);
  const [walletDomain, setWalletDomain] = useState(null);
  const [walletLoading, setWalletLoading] = useState(false);
  const [walletError, setWalletError] = useState(null);
  const [solBalance, setSolBalance] = useState(null);
  const [splTokens, setSplTokens] = useState([]);
  const [accOpen, setAccOpen] = useState(0); // 0=How it works, 1=Fiat<>Crypto, 2=Bulk Send
  const [recipient, setRecipient] = useState('');
  const [resolvedAddress, setResolvedAddress] = useState(null);
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState(null);
  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState(null); // { type, title, message, link }
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [token, setToken] = useState('');
  const [staticLogos, setStaticLogos] = useState({});

  const { liveRates, ratesLoading } = useLiveRates();

  // Fetch logos for static tokens on mount
  useEffect(() => {
    async function loadStaticLogos() {
      const logos = {};
      const mints = Object.keys(KNOWN_MINTS);
      try {
        const metaPromises = mints.map(m => 
          fetch(`https://tokens.jup.ag/token/${m}`).then(r => r.json()).catch(() => null)
        );
        const results = await Promise.all(metaPromises);
        results.forEach((m, idx) => {
          if (m && m.logoURI) logos[KNOWN_MINTS[mints[idx]].symbol] = m.logoURI;
        });
        setStaticLogos(logos);
      } catch (e) { console.warn('Static logo fetch failed:', e); }
    }
    loadStaticLogos();
  }, []);

  useEffect(() => {
    setWalletPubkey(publicKey?.toString() || null);
  }, [publicKey]);

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
      price: liveSolPrice, balance: solBalance,
      logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png'
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
    return TOKENS.map(t => ({ 
      ...t, 
      price: getLiveTokPrice(t.symbol) || t.price || 0,
      logoURI: t.symbol === 'SOL' ? 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png' : staticLogos[t.symbol]
    }));
  }, [connected, walletTokenList, liveRates, staticLogos]);

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

      // 1. Fetch ALL token accounts (no filtering)
      let results = [];
      try {
        const fastConn = new Connection('https://api.mainnet-beta.solana.com');
        const tokenProgramId = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
        const resp = await fastConn.getParsedTokenAccountsByOwner(publicKey, { programId: tokenProgramId });
        results = resp.value || [];
      } catch (e) {
        console.warn('Bulk fetch failed, using fallback:', e);
      }

      const mintMap = {};
      results.forEach(account => {
        const parsed = account.account.data.parsed.info;
        const mint = parsed.mint;
        const amt = parsed.tokenAmount.uiAmount || 0;
        if (amt > 0) mintMap[mint] = (mintMap[mint] || 0) + amt;
      });

      const allMints = Object.keys(mintMap);
      
      // 2. Batch fetch metadata and prices for ALL held tokens from Jupiter
      let jupMeta = {};
      let jupPrices = {};
      
      if (allMints.length > 0) {
        try {
          const metaPromises = allMints.map(m => 
            fetch(`https://tokens.jup.ag/token/${m}`).then(r => r.json()).catch(() => null)
          );
          const metaResults = await Promise.all(metaPromises);
          metaResults.forEach((m, idx) => {
            if (m) jupMeta[allMints[idx]] = m;
          });

          const priceResp = await fetch(`https://api.jup.ag/price/v2/lookup?ids=${allMints.join(',')}`);
          const priceData = await priceResp.json();
          jupPrices = priceData.data || {};
        } catch (e) {
          console.warn('Jupiter API fetch failed:', e);
        }
      }

      // 3. Construct the full portfolio list
      const toks = allMints.map(mint => {
        const balance = mintMap[mint];
        const dynamic = jupMeta[mint] || {};
        const priceInfo = jupPrices[mint] || {};
        const staticMeta = KNOWN_MINTS[mint] || {};

        return {
          mint,
          uiAmount: balance,
          symbol: dynamic.symbol || staticMeta.symbol || mint.slice(0, 4),
          name: dynamic.name || staticMeta.name || 'Unknown Token',
          price: parseFloat(priceInfo.price || staticMeta.price || 0),
          color: staticMeta.color || '#aaa',
          bg: staticMeta.bg || 'rgba(255,255,255,0.08)',
          logoURI: dynamic.logoURI || staticMeta.logoURI
        };
      });

      // Sort by USD value
      toks.sort((a, b) => (b.uiAmount * b.price) - (a.uiAmount * a.price));

      setSplTokens(toks);
    } catch (e) {
      setWalletError(e.message || 'Failed to fetch balances');
    }
    setWalletLoading(false);
  }, [connection, publicKey, connected]);

  // Auto-fetch when wallet connects or changes
  useEffect(() => {
    if (connected && publicKey) {
      const pubkeyStr = publicKey.toString();
      fetchBalances();

      // 1. Instant Cache Load
      const cached = localStorage.getItem(`sns_${pubkeyStr}`);
      if (cached) setWalletDomain(cached);

      // 2. High-Speed Parallel Lookup (Race for fastest resolution)
      const lookupDomain = async () => {
        try {
          // Parallel fetch to get the fastest response
          const apiPromise = fetch(`https://sns-sdk-proxy.bonfida.workers.dev/reverse-lookup/${pubkeyStr}`)
            .then(r => r.json())
            .then(j => j.domain ? j.domain + '.sol' : null)
            .catch(() => null);

          const rpcPromise = (async () => {
            const conn = new Connection('https://solana-rpc.publicnode.com');
            // Try Primary first as requested
            const primary = await getPrimaryDomain(conn, publicKey).catch(() => null);
            if (primary && primary.reverse) return primary.reverse + '.sol';
            // Fallback to standard reverse
            const reverse = await performReverseLookup(conn, publicKey).catch(() => null);
            if (reverse) return reverse + '.sol';
            return null;
          })();

          // Race all valid methods
          const winner = await Promise.race([apiPromise, rpcPromise].filter(p => p !== null));
          
          if (winner) {
            setWalletDomain(winner);
            localStorage.setItem(`sns_${pubkeyStr}`, winner);
          }
        } catch (e) {
          console.warn('Domain lookup failed:', e);
        }
      };

      lookupDomain();
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
    setToast(null);
    
    setSending(true);
    setWalletError(null);
    try {
      const finalRecipient = new PublicKey(resolvedAddress || recipient);
      const transaction = new Transaction();

      const { ComputeBudgetProgram } = await import('@solana/web3.js');
      const addPriorityFee = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100000 });
      transaction.add(addPriorityFee);

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

      const latestBlockhash = await connection.getLatestBlockhash('confirmed');
      const messageV0 = new TransactionMessage({
        payerKey: publicKey,
        recentBlockhash: latestBlockhash.blockhash,
        instructions: transaction.instructions,
      }).compileToV0Message();
      const versionedTx = new VersionedTransaction(messageV0);

      // Use signTransaction → sendRawTransaction pattern for MWA/Seeker compatibility.
      // sendTransaction on MWA can drop the signature before it reaches the RPC.
      let signature;
      if (signTransaction) {
        const signedTx = await signTransaction(versionedTx);
        signature = await connection.sendRawTransaction(signedTx.serialize(), {
          skipPreflight: false,
          preflightCommitment: 'confirmed',
          maxRetries: 5,
        });
      } else {
        // Fallback for wallets that only expose sendTransaction (e.g. Ledger)
        signature = await sendTransaction(versionedTx, connection, {
          skipPreflight: false,
          preflightCommitment: 'confirmed',
          maxRetries: 5,
        });
      }
      console.log('Transaction sent:', signature);

      // Poll for confirmation instead of relying on the WS subscription
      // This prevents false "failed" messages when the RPC drops the WS but
      // the transaction is already finalized on-chain.
      let confirmed = false;
      const deadline = Date.now() + 60_000; // 60 second timeout
      while (Date.now() < deadline) {
        try {
          const status = await connection.getSignatureStatus(signature);
          const conf = status?.value?.confirmationStatus;
          if (conf === 'confirmed' || conf === 'finalized') {
            confirmed = true;
            break;
          }
          // If the transaction errored on-chain, throw immediately
          if (status?.value?.err) {
            throw new Error('Transaction rejected by network: ' + JSON.stringify(status.value.err));
          }
        } catch (pollErr) {
          if (pollErr.message.startsWith('Transaction rejected')) throw pollErr;
          // RPC blip — keep polling
        }
        await new Promise(r => setTimeout(r, 2000));
      }

      if (!confirmed) {
        // Last resort — check once more; if it's there, treat as success
        const finalStatus = await connection.getSignatureStatus(signature);
        const finalConf = finalStatus?.value?.confirmationStatus;
        if (finalConf === 'confirmed' || finalConf === 'finalized') {
          confirmed = true;
        }
      }

      if (confirmed) {
        setWalletError(null);
        setToast({
          type: 'success',
          title: `✓ Sent ${dispTok} ${tokLive.symbol}`,
          message: `Transaction confirmed on Solana.`,
          link: { href: `https://solscan.io/tx/${signature}`, label: `${signature.slice(0,8)}… View on Solscan` }
        });
        fetchBalances();
        setAmount('');
        setRecipient('');
        setResolvedAddress(null);
      } else {
        setWalletError(`Transaction submitted but confirmation timed out. Check Solscan: ${signature.slice(0,8)}…`);
      }

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
        <div className="nav-logo-wrap">
          <img src={logoImg} alt="Fiatwallet Logo" className="nav-logo" />
        </div>

        <div className="nav-actions">
          {connected && walletPubkey && (
            <span className="nav-addr" title={walletPubkey}>{walletDomain || (walletPubkey.slice(0,4) + '…' + walletPubkey.slice(-4))}</span>
          )}
          {connected
            ? <button className="btn-connected" onClick={handleDisconnect}><span className="live-dot" />Disconnect ▾</button>
            : <button className="btn-connect" onClick={() => setVisible(true)}>Connect Wallet</button>
          }
        </div>
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
                      {tokLive.logoURI ? (
                        <img src={tokLive.logoURI} alt={tokLive.symbol} className="tok-icon" style={{width:32, height:32, borderRadius:'50%'}} />
                      ) : (
                        <div className="tok-icon" style={{background:tokLive.bg,color:tokLive.color}}>{tokLive.symbol.slice(0,4)}</div>
                      )}
                      <div>
                        <span className="tok-sym">{tokLive.symbol}</span>
                        <span style={{fontSize:11,color:'var(--text3)',marginLeft:6}}>${tokLive.price < 0.01 ? tokLive.price.toFixed(6) : tokLive.price.toLocaleString()}</span>
                        {tokLive.balance != null && tokLive.balance > 0 && (
                          <div style={{fontSize:10, color:'var(--lime)', fontFamily:'var(--mono)', marginTop:2}}>
                            {tokLive.balance.toLocaleString(undefined, {maximumFractionDigits: 4})} {tokLive.symbol} 
                            {tokLive.price > 0 && ` ($${(tokLive.balance * tokLive.price).toFixed(2)})`}
                          </div>
                        )}
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
                sendTransaction={sendTransaction} signTransaction={signTransaction} signAllTransactions={signAllTransactions} />
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

        <div className="info-cards">
          <div className="info-card" onClick={() => setAccOpen(accOpen === 0 ? -1 : 0)} style={{cursor:'pointer', paddingBottom: accOpen===0 ? 20 : 16}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <h3 style={{margin:0}}>HOW IT WORKS</h3>
              <span style={{color:'var(--text2)', transition:'transform 0.2s', transform: accOpen===0?'rotate(180deg)':'none'}}>▼</span>
            </div>
            {accOpen === 0 && (
              <ul className="info-steps" style={{marginTop: 16}}>
                <li className="info-step"><span className="step-num">1</span><span>Connect any Solana wallet — Phantom, Solflare, Backpack, Ledger & more</span></li>
                <li className="info-step"><span className="step-num">2</span><span>Enter a .sol domain — SNS resolves it to a wallet address</span></li>
                <li className="info-step"><span className="step-num">3</span><span>Enter fiat or crypto amount. Live CoinGecko rate auto-converts</span></li>
                <li className="info-step"><span className="step-num">4</span><span>Confirm and send — settles on Solana instantly</span></li>
              </ul>
            )}
          </div>
          <div className="info-card" onClick={() => setAccOpen(accOpen === 1 ? -1 : 1)} style={{cursor:'pointer', paddingBottom: accOpen===1 ? 20 : 16}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <h3 style={{margin:0}}>FIAT ↔ CRYPTO INPUT</h3>
              <span style={{color:'var(--text2)', transition:'transform 0.2s', transform: accOpen===1?'rotate(180deg)':'none'}}>▼</span>
            </div>
            {accOpen === 1 && (
              <p style={{marginTop: 12}}>Toggle between entering amounts in your local currency or directly in crypto. The other value updates live using CoinGecko rates.</p>
            )}
          </div>
          <div className="info-card" onClick={() => setAccOpen(accOpen === 2 ? -1 : 2)} style={{cursor:'pointer', paddingBottom: accOpen===2 ? 20 : 16}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <h3 style={{margin:0}}>BULK SEND</h3>
              <span style={{color:'var(--text2)', transition:'transform 0.2s', transform: accOpen===2?'rotate(180deg)':'none'}}>▼</span>
            </div>
            {accOpen === 2 && (
              <p style={{marginTop: 12}}>Toggle Bulk Send to pay up to 1,000 wallets in one go. Upload CSV or XLSX, set amounts in fiat or crypto, and fire one transaction.</p>
            )}
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
      {toast && (
        <Toast
          type={toast.type}
          title={toast.title}
          message={toast.message}
          link={toast.link}
          onClose={() => setToast(null)}
          duration={5000}
        />
      )}
    </div>
  );
}
