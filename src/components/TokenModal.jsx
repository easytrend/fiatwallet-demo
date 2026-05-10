import { useState } from 'react';

export default function TokenModal({ filteredTokens, connected, walletLoading, solBalance, onSelect, onClose, onRefresh }) {
  const [tokenQ, setTokenQ] = useState('');

  const shown = filteredTokens.filter(t =>
    (t.symbol || '').toLowerCase().includes(tokenQ.toLowerCase()) ||
    (t.name   || '').toLowerCase().includes(tokenQ.toLowerCase())
  );

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-sheet" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">Select Token</span>
          <div style={{display:'flex', alignItems:'center', gap:8}}>
            {connected && (
              <button className="wt-refresh" onClick={onRefresh} disabled={walletLoading}
                style={{fontSize:11, padding:'4px 10px'}}>
                {walletLoading ? '⟳' : '⟳ Refresh'}
              </button>
            )}
            <button className="modal-close" onClick={onClose}>✕</button>
          </div>
        </div>

        {/* ── Not connected: gate the list ── */}
        {!connected ? (
          <div style={{textAlign:'center', padding:'2.5rem 1rem'}}>
            <div style={{fontSize:36, marginBottom:14}}>🔐</div>
            <div style={{fontSize:15, fontWeight:600, color:'var(--text)', marginBottom:6}}>Wallet not connected</div>
            <div style={{fontSize:13, color:'var(--text2)'}}>
              Connect your wallet to see your actual SOL &amp; SPL token balances.
            </div>
          </div>
        ) : (
          <>
            {/* Loading state */}
            {walletLoading && (
              <div style={{display:'flex', alignItems:'center', gap:8, padding:'8px 2px', marginBottom:4, fontSize:12, color:'var(--text3)'}}>
                <div className="spin" style={{width:14, height:14}} />
                Fetching your on-chain balances…
              </div>
            )}

            {/* Balances loaded confirmation */}
            {!walletLoading && solBalance !== null && (
              <div style={{fontSize:11, color:'var(--lime)', marginBottom:8, padding:'0 2px', fontWeight:600}}>
                ✓ Showing your actual wallet tokens
              </div>
            )}

            <input
              className="modal-search"
              autoFocus
              placeholder="Search by name or symbol…"
              value={tokenQ}
              onChange={e => setTokenQ(e.target.value)}
            />

            {shown.length === 0 && !walletLoading && (
              <div style={{textAlign:'center', padding:'1.5rem', color:'var(--text3)', fontSize:13}}>
                {filteredTokens.length === 0
                  ? 'No tokens found in this wallet'
                  : 'No results for "' + tokenQ + '"'}
              </div>
            )}

            {shown.map((t, i) => (
              <div key={t.mint || t.symbol || i} className="modal-item" onClick={() => onSelect(t.symbol)}>
                <div
                  className="tok-icon"
                  style={{ background: t.bg || 'rgba(255,255,255,0.08)', color: t.color || '#ccc', width: 36, height: 36, fontSize: 10 }}
                >
                  {(t.symbol || '?').slice(0, 4)}
                </div>
                <div>
                  <div className="m-name">{t.symbol}</div>
                  <div className="m-full">{t.name}</div>
                </div>
                <div style={{ marginLeft: 'auto', textAlign: 'right', minWidth: 90 }}>
                  {/* Live USD price */}
                  {t.price > 0 && (
                    <div className="m-price">
                      ${t.price < 0.0001 ? t.price.toFixed(8) : t.price < 1 ? t.price.toFixed(4) : t.price.toLocaleString()}
                    </div>
                  )}
                  {/* Actual wallet balance */}
                  {t.balance != null && (
                    <div style={{ fontSize: 10, color: 'var(--lime)', fontFamily: 'var(--mono)', marginTop: 2, fontWeight: 600 }}>
                      {t.balance.toLocaleString(undefined, { maximumFractionDigits: 4 })} held
                      {t.price > 0 && t.balance > 0 && ` ($${(t.balance * t.price).toFixed(2)})`}
                    </div>
                  )}
                  {/* For SPL tokens without price, show uiAmount */}
                  {t.price === 0 && t.uiAmount > 0 && (
                    <div style={{ fontSize: 10, color: 'var(--text2)', fontFamily: 'var(--mono)', marginTop: 2 }}>
                      {t.uiAmount.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
