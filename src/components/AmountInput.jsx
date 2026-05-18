import { CURRENCIES } from '../data/currencies';
import { fmtTok, fmtFiat } from '../utils';
import CurrDrop from './CurrDrop';

export default function AmountInput({ amount, setAmount, inputMode, setInputMode, currency, setCurrency, tok, currRate }) {
  const curr = CURRENCIES.find(c => c.code === currency) || CURRENCIES[0];
  const rate = currRate || curr.rate;
  const num = parseFloat(amount) || 0;
  
  const tokPrice = tok ? tok.price : 1;
  const tokSymbol = tok ? tok.symbol : 'Token';

  const tokAmt  = inputMode === 'fiat'   ? (num / rate) / tokPrice : num;
  const fiatAmt = inputMode === 'crypto' ? num * tokPrice * rate    : num;
  const convertedLabel = inputMode === 'fiat'
    ? `≈ ${tok ? fmtTok(tokAmt) : '0'} ${tokSymbol}`
    : `≈ ${fmtFiat(fiatAmt, currency)}`;

  return (
    <div>
      {inputMode === 'fiat' && (
        <CurrDrop selected={currency} onSelect={setCurrency} showAsRow={true}
          rateLabel={`1 USD = ${rate.toLocaleString()} ${curr.code}`} />
      )}
      <div className="amount-block" style={{marginTop: inputMode === 'fiat' ? 8 : 0}}>
        <div className="amount-top">
          <div className="amount-num-wrap">
            <div style={{display:'flex', alignItems:'center', gap:8}}>
              <input className="amount-num" type="number" value={amount}
                onChange={e => setAmount(e.target.value)} placeholder="0" />
              {tok && tok.balance > 0 && (
                <button className="max-btn" type="button" onClick={() => {
                  if (inputMode === 'fiat') {
                    const fiatMax = tok.balance * tokPrice * rate;
                    setAmount(fiatMax.toFixed(2));
                  } else {
                    setAmount(tok.balance.toString());
                  }
                }}>
                  MAX
                </button>
              )}
            </div>
          </div>
          {inputMode === 'crypto' && tok && (
            <div style={{display:'flex',alignItems:'center',gap:6,background:'rgba(255,255,255,0.07)',border:'1px solid var(--border)',borderRadius:9,padding:'7px 10px',fontSize:13,fontWeight:600,color:'var(--text)',whiteSpace:'nowrap',flexShrink:0}}>
              <div className="tok-icon" style={{background:tok.bg,color:tok.color,width:22,height:22,fontSize:8}}>{tokSymbol.slice(0,3)}</div>
              {tokSymbol}
            </div>
          )}
          {inputMode === 'crypto' && !tok && (
            <div style={{display:'flex',alignItems:'center',gap:6,background:'rgba(255,255,255,0.07)',border:'1px solid var(--border)',borderRadius:9,padding:'7px 10px',fontSize:13,fontWeight:600,color:'var(--text3)',whiteSpace:'nowrap',flexShrink:0}}>
              <div className="tok-icon" style={{background:'rgba(255,255,255,0.05)',color:'var(--text3)',width:22,height:22,fontSize:8}}>?</div>
              Select
            </div>
          )}
        </div>
        <div className="amount-divider" />
        <div className="amount-bottom">
          <span className="amount-converted">{convertedLabel}</span>
          <div className="input-mode-toggle">
            <button className={`imt-btn ${inputMode === 'fiat' ? 'active' : ''}`} onClick={() => setInputMode('fiat')}>{currency}</button>
            <button className={`imt-btn ${inputMode === 'crypto' ? 'active' : ''}`} disabled={!tok} onClick={() => setInputMode('crypto')}>{tokSymbol}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
