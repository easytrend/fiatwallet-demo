import { useState, useRef, useEffect } from 'react';
import { CURRENCIES } from '../data/currencies';
import { fmtRate } from '../utils';

export default function CurrDrop({ selected, onSelect, showAsRow=false, rateLabel='' }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef(null);
  const curr = CURRENCIES.find(c => c.code === selected) || CURRENCIES[0];
  const filtered = CURRENCIES.filter(c =>
    c.code.toLowerCase().includes(q.toLowerCase()) ||
    c.name.toLowerCase().includes(q.toLowerCase())
  );
  useEffect(() => {
    const fn = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', fn);
    return () => document.removeEventListener('mousedown', fn);
  }, []);

  const trigger = showAsRow ? (
    <div className="curr-row" onClick={() => setOpen(!open)}>
      <div className="curr-left">
        <div className="curr-icon">{curr.flag}</div>
        <div><div className="curr-code">{curr.code}</div><div className="curr-name-small">{curr.name}</div></div>
      </div>
      <div className="curr-right">
        {rateLabel && <span className="curr-rate-val">{rateLabel}</span>}
        <span className="curr-chevron-r">›</span>
      </div>
    </div>
  ) : (
    <div className="curr-selector" onClick={() => setOpen(!open)}>
      <span className="curr-flag">{curr.flag}</span>
      <span style={{fontSize:13,fontWeight:600}}>{curr.code}</span>
      <span className="curr-chevron">▼</span>
    </div>
  );

  return (
    <div className="drop-wrap" ref={ref}>
      {trigger}
      {open && (
        <div className="drop-menu">
          <div className="drop-search">
            <input autoFocus placeholder="Search currency…" value={q} onChange={e => setQ(e.target.value)} />
          </div>
          {filtered.map(c => (
            <div key={c.code} className={`drop-item ${c.code === selected ? 'sel' : ''}`}
              onClick={() => { onSelect(c.code); setOpen(false); setQ(''); }}>
              <span style={{fontSize:14}}>{c.flag}</span>
              <span className="di-code">{c.code}</span>
              <span className="di-name">{c.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
