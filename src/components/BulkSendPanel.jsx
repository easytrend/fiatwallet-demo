import { useState, useRef } from 'react';
import { CURRENCIES } from '../data/currencies';
import { fmtTok, fmtFiat, fmtRate, parseCSV, dlTemplate } from '../utils';
import CurrDrop from './CurrDrop';

export default function BulkSendPanel({ tok, connected, getLiveRate }) {
  const [rows, setRows] = useState([]);
  const [drag, setDrag] = useState(false);
  const [globalAmt, setGlobalAmt] = useState('');
  const [bulkCurr, setBulkCurr] = useState('NGN');
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

  const validRows = rows.filter(r => r.valid && r.amount);
  const totalUSD = validRows.reduce((s,r) => {
    const n = parseFloat(r.amount)||0;
    return s + (bulkMode==='fiat' ? n/liveRate : n*tok.price);
  }, 0);
  const totalTok = totalUSD / tok.price;
  const globalNum = parseFloat(globalAmt)||0;
  const perTok  = bulkMode==='fiat'   ? (globalNum/liveRate)/tok.price : globalNum;
  const perFiat = bulkMode==='crypto' ? globalNum*tok.price*liveRate   : globalNum;
  const convertedLabel = globalNum > 0
    ? (bulkMode==='fiat' ? `≈ ${fmtTok(perTok)} ${tok.symbol} each` : `≈ ${fmtFiat(perFiat,bulkCurr)} each`)
    : '';
  const colLabel = bulkMode==='fiat' ? bulkCurr : tok.symbol;

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
            {bulkMode==='crypto' && (
              <div style={{display:'flex',alignItems:'center',gap:6,background:'rgba(255,255,255,0.07)',border:'1px solid var(--border)',borderRadius:9,padding:'7px 10px',fontSize:13,fontWeight:600,color:'var(--text)',whiteSpace:'nowrap',flexShrink:0}}>
                <div className="tok-icon" style={{background:tok.bg,color:tok.color,width:22,height:22,fontSize:8}}>{tok.symbol.slice(0,3)}</div>
                {tok.symbol}
              </div>
            )}
          </div>
          <div className="amount-divider" />
          <div className="amount-bottom">
            <span className="amount-converted">{convertedLabel || <span style={{color:'var(--text3)'}}>Enter amount above</span>}</span>
            <div className="input-mode-toggle">
              <button className={`imt-btn ${bulkMode==='fiat'?'active':''}`} onClick={() => setBulkMode('fiat')}>{bulkCurr}</button>
              <button className={`imt-btn ${bulkMode==='crypto'?'active':''}`} onClick={() => setBulkMode('crypto')}>{tok.symbol}</button>
            </div>
          </div>
        </div>
        <div className="rate-badge" style={{marginTop:8}}>
          <span className="rate-dot" />
          1 {tok.symbol} = ${tok.price < 0.001 ? tok.price.toFixed(7) : tok.price.toLocaleString()} USD
        </div>
        {globalAmt && (
          <button className="tmpl-btn" style={{width:'100%',marginTop:8,padding:'7px 12px',fontSize:12}} onClick={applyGlobal}>
            Apply this amount to all recipients
          </button>
        )}
      </div>

      {rows.length === 0 ? (
        <>
          <div className="tmpl-btns">
            <button className="tmpl-btn" onClick={dlTemplate}>📄 CSV template</button>
            <button className="tmpl-btn" onClick={dlTemplate}>📊 XLSX template</button>
          </div>
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
            <div className="sum-item"><div className="sum-val">{fmtTok(totalTok)}</div><div className="sum-lbl">Total {tok.symbol}</div></div>
            <div className="sum-item"><div className="sum-val">${totalUSD.toFixed(2)}</div><div className="sum-lbl">Est. USD</div></div>
          </div>
          <button className="add-manual" onClick={addManual}>＋ Add recipient manually</button>
        </>
      )}
      <button className="send-btn" disabled={!connected || validRows.length === 0}>
        {!connected ? 'Connect wallet to send' : validRows.length === 0 ? 'Add recipients to continue' : `Send ${tok.symbol} to ${validRows.length} recipient${validRows.length!==1?'s':''}`}
      </button>
    </div>
  );
}
