import { useState, useRef } from 'react';
import { PublicKey, Transaction, SystemProgram } from '@solana/web3.js';
import { resolve } from '@bonfida/spl-name-service';
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction } from '@solana/spl-token';
import { CURRENCIES } from '../data/currencies';
import { fmtTok, fmtFiat, fmtRate, parseCSV, dlTemplate } from '../utils';
import CurrDrop from './CurrDrop';

export default function BulkSendPanel({ tok, connected, getLiveRate, connection, publicKey, sendTransaction, signAllTransactions }) {
  const [rows, setRows] = useState([]);
  const [drag, setDrag] = useState(false);
  const [globalAmt, setGlobalAmt] = useState('');
  const [bulkCurr, setBulkCurr] = useState('USD');
  const [bulkMode, setBulkMode] = useState('fiat');
  const fileRef = useRef(null);

  const staticCurr = CURRENCIES.find(c => c.code === bulkCurr) || CURRENCIES[0];
  const liveRate = (getLiveRate && getLiveRate(bulkCurr)) || staticCurr.rate;

  const processFile = file => {
    const ext = file.name.split('.').pop().toLowerCase();
    if (['csv','txt'].includes(ext)) {
      const r = new FileReader(); r.onload = e => setRows(v => [...v, ...parseCSV(e.target.result)]); r.readAsText(file);
    } else { alert('Please upload .csv or .txt'); }
  };

  const handleDrop = e => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files[0]) processFile(e.dataTransfer.files[0]); };
  const handleFile = e => { if (e.target.files[0]) processFile(e.target.files[0]); e.target.value = ''; };
  const removeRow = id => setRows(r => r.filter(x => x.id !== id));
  const addManual = () => setRows(r => [...r, {id:Date.now()+Math.random(),domain:'',amount:'',valid:false}]);
  const updateRow = (id,field,val) => setRows(r => r.map(x => x.id===id ? {...x,[field]:val,valid:field==='domain'?val.length>2:x.valid} : x));
  const applyGlobal = () => { if (globalAmt) setRows(r => r.map(x => ({...x, amount:globalAmt}))); };

  const [sendingState, setSendingState] = useState(null); // null | 'resolving' | 'signing' | 'sending' | 'done' | 'error'
  const [errorMsg, setErrorMsg] = useState('');
  const [progress, setProgress] = useState({ current: 0, total: 0 });

  const handleBulkSend = async () => {
    if (!connected || !publicKey || validRows.length === 0) return;
    setSendingState('resolving');
    setErrorMsg('');
    
    try {
      // 1. Resolve all domains and validate recipients
      const resolvedRecipients = [];
      for (let i = 0; i < validRows.length; i++) {
        const row = validRows[i];
        let addressStr = row.domain;
        
        if (addressStr.endsWith('.sol')) {
          try {
            const address = await resolve(connection, addressStr);
            addressStr = address.toBase58();
          } catch (err) {
            throw new Error(`Failed to resolve domain: ${row.domain}`);
          }
        }
        
        let recipientPubkey;
        try {
          recipientPubkey = new PublicKey(addressStr);
        } catch (err) {
          throw new Error(`Invalid address for ${row.domain}`);
        }
        
        const num = parseFloat(row.amount);
        const tokPrice = tok ? tok.price : 1;
        const tokAmt = bulkMode === 'fiat' ? (num / liveRate) / tokPrice : num;
        
        resolvedRecipients.push({
          pubkey: recipientPubkey,
          tokAmt
        });
      }

      setSendingState('signing');
      
      // 2. Fetch mint info if SPL token
      let decimals = 9;
      let mintPubkey = null;
      if (tok.symbol !== 'SOL') {
        mintPubkey = new PublicKey(tok.mint);
        const mintInfo = await connection.getParsedAccountInfo(mintPubkey);
        if (!mintInfo.value) throw new Error("Invalid token mint");
        decimals = mintInfo.value.data.parsed.info.decimals;
      }

      // 3. Chunk instructions (max 10 per tx to be safe)
      const chunkSize = 10;
      const transactions = [];
      const latestBlockhash = await connection.getLatestBlockhash();
      
      for (let i = 0; i < resolvedRecipients.length; i += chunkSize) {
        const chunk = resolvedRecipients.slice(i, i + chunkSize);
        const tx = new Transaction();
        tx.recentBlockhash = latestBlockhash.blockhash;
        tx.feePayer = publicKey;

        if (tok.symbol === 'SOL') {
          for (const rec of chunk) {
            const lamports = Math.round(rec.tokAmt * 1e9);
            tx.add(SystemProgram.transfer({
              fromPubkey: publicKey,
              toPubkey: rec.pubkey,
              lamports
            }));
          }
        } else {
          const senderATA = getAssociatedTokenAddressSync(mintPubkey, publicKey);
          for (const rec of chunk) {
            const amountUnits = BigInt(Math.round(rec.tokAmt * Math.pow(10, decimals)));
            const receiverATA = getAssociatedTokenAddressSync(mintPubkey, rec.pubkey);
            
            tx.add(createAssociatedTokenAccountIdempotentInstruction(
              publicKey, receiverATA, rec.pubkey, mintPubkey
            ));
            
            tx.add(createTransferCheckedInstruction(
              senderATA, mintPubkey, receiverATA, publicKey, amountUnits, decimals
            ));
          }
        }
        transactions.push(tx);
      }
      
      // 4. Sign and send
      setProgress({ current: 0, total: transactions.length });
      
      if (transactions.length > 1 && signAllTransactions) {
        const signedTxs = await signAllTransactions(transactions);
        setSendingState('sending');
        
        for (let i = 0; i < signedTxs.length; i++) {
          const tx = signedTxs[i];
          const rawTx = tx.serialize();
          const signature = await connection.sendRawTransaction(rawTx);
          await connection.confirmTransaction({
            signature,
            blockhash: latestBlockhash.blockhash,
            lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
          }, 'confirmed');
          setProgress(p => ({ ...p, current: i + 1 }));
        }
      } else {
        setSendingState('sending');
        for (let i = 0; i < transactions.length; i++) {
          const tx = transactions[i];
          const signature = await sendTransaction(tx, connection);
          await connection.confirmTransaction({
            signature,
            blockhash: latestBlockhash.blockhash,
            lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
          }, 'confirmed');
          setProgress(p => ({ ...p, current: i + 1 }));
        }
      }

      setSendingState('done');
      setTimeout(() => {
        setSendingState(null);
        setRows([]);
        setGlobalAmt('');
      }, 3000);

    } catch (err) {
      console.error(err);
      setErrorMsg(err.message || "An error occurred");
      setSendingState('error');
    }
  };

  const validRows = rows.filter(r => r.valid && r.amount);
  const tokPrice = tok ? tok.price : 1;
  const tokSymbol = tok ? tok.symbol : 'Token';

  const totalUSD = validRows.reduce((s,r) => {
    const n = parseFloat(r.amount)||0;
    return s + (bulkMode==='fiat' ? n/liveRate : n*tokPrice);
  }, 0);
  const totalTok = totalUSD / tokPrice;
  const globalNum = parseFloat(globalAmt)||0;
  const perTok  = bulkMode==='fiat'   ? (globalNum/liveRate)/tokPrice : globalNum;
  const perFiat = bulkMode==='crypto' ? globalNum*tokPrice*liveRate   : globalNum;
  const convertedLabel = globalNum > 0
    ? (bulkMode==='fiat' ? `≈ ${tok ? fmtTok(perTok) : '0'} ${tokSymbol} each` : `≈ ${fmtFiat(perFiat,bulkCurr)} each`)
    : '';
  const colLabel = bulkMode==='fiat' ? bulkCurr : tokSymbol;

  return (
    <div>
      <div className="field">
        <div className="field-label">Default Amount per Recipient</div>
        {bulkMode==='fiat' && (
          <CurrDrop selected={bulkCurr} onSelect={setBulkCurr} showAsRow={true}
            rateLabel={`1 USD = ${fmtRate(liveRate)} ${staticCurr.code}`} />
        )}
        <div className="amount-block" style={{marginTop: bulkMode==='fiat' ? 8 : 0}}>
          <div className="amount-top">
            <div className="amount-num-wrap">
              <input className="amount-num" type="number" value={globalAmt}
                onChange={e => setGlobalAmt(e.target.value)} placeholder="0" style={{fontSize:18}} />
            </div>
            {bulkMode==='crypto' && tok && (
              <div style={{display:'flex',alignItems:'center',gap:6,background:'rgba(255,255,255,0.07)',border:'1px solid var(--border)',borderRadius:9,padding:'7px 10px',fontSize:13,fontWeight:600,color:'var(--text)',whiteSpace:'nowrap',flexShrink:0}}>
                <div className="tok-icon" style={{background:tok.bg,color:tok.color,width:22,height:22,fontSize:8}}>{tokSymbol.slice(0,3)}</div>
                {tokSymbol}
              </div>
            )}
            {bulkMode==='crypto' && !tok && (
              <div style={{display:'flex',alignItems:'center',gap:6,background:'rgba(255,255,255,0.07)',border:'1px solid var(--border)',borderRadius:9,padding:'7px 10px',fontSize:13,fontWeight:600,color:'var(--text3)',whiteSpace:'nowrap',flexShrink:0}}>
                <div className="tok-icon" style={{background:'rgba(255,255,255,0.05)',color:'var(--text3)',width:22,height:22,fontSize:8}}>?</div>
                Select
              </div>
            )}
          </div>
          <div className="amount-divider" />
          <div className="amount-bottom">
            <span className="amount-converted">{convertedLabel || <span style={{color:'var(--text3)'}}>Enter amount above</span>}</span>
            <div className="input-mode-toggle">
              <button className={`imt-btn ${bulkMode==='fiat'?'active':''}`} onClick={() => setBulkMode('fiat')}>{bulkCurr}</button>
              <button className={`imt-btn ${bulkMode==='crypto'?'active':''}`} disabled={!tok} onClick={() => setBulkMode('crypto')}>{tokSymbol}</button>
            </div>
          </div>
        </div>
        {tok && (
          <div className="rate-badge" style={{marginTop:8}}>
            <span className="rate-dot" />
            1 {tokSymbol} = ${tokPrice < 0.001 ? tokPrice.toFixed(7) : tokPrice.toLocaleString()} USD
          </div>
        )}
        {globalAmt && (
          <button className="tmpl-btn" style={{width:'100%',marginTop:8,padding:'7px 12px',fontSize:12}} onClick={applyGlobal}>
            Apply this amount to all recipients
          </button>
        )}
      </div>

      {rows.length === 0 ? (
        <>
          <div className={`upload-zone ${drag?'drag':''}`}
            onClick={() => fileRef.current.click()}
            onDragOver={e => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)} onDrop={handleDrop}>
            <div className="upload-icon">📂</div>
            <div className="upload-title">Drop file or click to browse</div>
            <div className="upload-sub">Supports <span>.csv</span> and <span>.xlsx</span> · Up to 1,000 recipients</div>
            <input ref={fileRef} type="file" className="upload-input" accept=".csv,.xlsx,.xls,.txt" onChange={handleFile} />
          </div>
          <button className="add-manual" onClick={addManual}>＋ Add recipients manually</button>
        </>
      ) : (
        <>
          <div style={{display:'flex',gap:8,marginBottom:10}}>
            <button className="tmpl-btn" style={{padding:'7px 10px'}} onClick={() => fileRef.current.click()}>＋ Upload more</button>
            <input ref={fileRef} type="file" className="upload-input" accept=".csv,.xlsx,.xls,.txt" onChange={handleFile} />
          </div>
          <div className="recip-hdr">
            <span className="recip-count"><strong>{validRows.length}</strong> of {rows.length} ready</span>
            <button className="clear-btn" onClick={() => setRows([])}>Clear all</button>
          </div>
          <div className="recip-table">
            <div className="rt-head"><span>Wallet / Domain</span><span>Amt ({colLabel})</span><span>Status</span><span></span></div>
            {rows.map(row => (
              <div key={row.id} className="rt-row">
                <div className="rt-domain">
                  <input style={{background:'transparent',border:'none',outline:'none',color:'var(--text)',fontFamily:'var(--mono)',fontSize:11,width:'100%'}}
                    value={row.domain} placeholder="wallet or .sol" onChange={e => updateRow(row.id,'domain',e.target.value)} />
                </div>
                <div className="rt-amount">
                  <input style={{background:'transparent',border:'none',outline:'none',color:'var(--text2)',fontFamily:'var(--mono)',fontSize:11,width:'90%'}}
                    value={row.amount} placeholder="0" type="number" onChange={e => updateRow(row.id,'amount',e.target.value)} />
                </div>
                <div className={`rt-status ${row.valid&&row.amount?'s-ok':'s-err'}`}>
                  <span className="s-dot" />{row.valid&&row.amount?'Ready':!row.valid?'Invalid':'No amt'}
                </div>
                <button className="rt-del" onClick={() => removeRow(row.id)}>✕</button>
              </div>
            ))}
          </div>
          <div className="bulk-sum">
            <div className="sum-item"><div className="sum-val">{validRows.length}</div><div className="sum-lbl">Recipients</div></div>
            <div className="sum-item"><div className="sum-val">{tok ? fmtTok(totalTok) : '0'}</div><div className="sum-lbl">Total {tokSymbol}</div></div>
            <div className="sum-item"><div className="sum-val">${totalUSD.toFixed(2)}</div><div className="sum-lbl">Est. USD</div></div>
          </div>
          <button className="add-manual" onClick={addManual}>＋ Add recipient manually</button>
          {sendingState && (
            <div style={{marginTop:12, padding:'12px', background:'rgba(255,255,255,0.05)', borderRadius:8, fontSize:13}}>
              {sendingState === 'resolving' && <span style={{color:'var(--text2)'}}>🔍 Resolving domains...</span>}
              {sendingState === 'signing' && <span style={{color:'var(--text2)'}}>✍️ Please sign the transaction(s) in your wallet...</span>}
              {sendingState === 'sending' && <span style={{color:'var(--lime)'}}>🚀 Sending batch {progress.current + 1} of {progress.total}...</span>}
              {sendingState === 'done' && <span style={{color:'var(--lime)'}}>✅ All {validRows.length} recipients successfully paid!</span>}
              {sendingState === 'error' && <span style={{color:'#f87171'}}>✕ Error: {errorMsg}</span>}
            </div>
          )}
        </>
      )}
      <button className="send-btn" disabled={!connected || !tok || validRows.length === 0 || ['resolving','signing','sending'].includes(sendingState)} onClick={handleBulkSend}>
        {!connected ? 'Connect wallet to send' : !tok ? 'Select a token to continue' : validRows.length === 0 ? 'Add recipients to continue' : ['resolving','signing','sending'].includes(sendingState) ? 'Processing...' : `Send ${tokSymbol} to ${validRows.length} recipient${validRows.length!==1?'s':''}`}
      </button>
    </div>
  );
}
