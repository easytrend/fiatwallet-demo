import { useState } from 'react';
import { TOKENS } from '../data/tokens';

export default function TokenModal({ filteredTokens, connected, walletLoading, solBalance, onSelect, onClose }) {
  const [tokenQ, setTokenQ] = useState('');
  const shown = filteredTokens.filter(t =>
    (t.symbol||'').toLowerCase().includes(tokenQ.toLowerCase()) ||
    (t.name||'').toLowerCase().includes(tokenQ.toLowerCase())
  );
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-sheet" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">Select Token</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        {connected && solBalance !== null && (
          <div style={{fontSize:11,color:'var(--lime)',marginBottom:8,padding:'0 2px',fontWeight:600}}>✓ Wallet balances loaded</div>
        )}
        {connected && walletLoading && (
          <div style={{fontSize:11,color:'var(--text3)',marginBottom:8,padding:'0 2px'}}>⟳ Fetching your wallet balances…</div>
        )}
        <input className="modal-search" autoFocus placeholder="Search by name or symbol…" value={tokenQ} onChange={e => setTokenQ(e.target.value)} />
        {shown.length === 0 && <div style={{textAlign:'center',padding:'1.5rem',color:'var(--text3)',fontSize:13}}>No tokens found</div>}
        {shown.map(t => (
          <div key={t.symbol} className="modal-item" onClick={() => onSelect(t.symbol)}>
            <div className="tok-icon" style={{background:t.bg||'rgba(255,255,255,0.08)',color:t.color||'#ccc',width:36,height:36,fontSize:10}}>{(t.symbol||'').slice(0,4)}</div>
            <div><div className="m-name">{t.symbol}</div><div className="m-full">{t.name}</div></div>
            <div style={{marginLeft:'auto',textAlign:'right',minWidth:90}}>
              {t.price > 0 && <div className="m-price">${t.price < 0.0001 ? t.price.toFixed(8) : t.price < 1 ? t.price.toFixed(4) : t.price.toLocaleString()}</div>}
              {t.balance != null && <div style={{fontSize:10,color:'var(--lime)',fontFamily:'var(--mono)',marginTop:2,fontWeight:600}}>{t.balance.toLocaleString(undefined,{maximumFractionDigits:4})} held</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
