import { useState, useEffect } from 'react';

const COUNTRIES = [
  { code: 'USA', name: 'United States', flag: '🇺🇸', symbol: '$', banks: ['Chase Bank', 'Bank of America', 'Wells Fargo', 'Citibank'] },
  { code: 'NGA', name: 'Nigeria', flag: '🇳🇬', symbol: '₦', banks: ['GTBank', 'Zenith Bank', 'Access Bank', 'United Bank for Africa'] },
  { code: 'GBR', name: 'United Kingdom', flag: '🇬🇧', symbol: '£', banks: ['Barclays', 'HSBC', 'Lloyds Bank', 'NatWest'] },
  { code: 'EUR', name: 'Europe', flag: '🇪🇺', symbol: '€', banks: ['Deutsche Bank', 'BNP Paribas', 'Santander', 'Société Générale'] },
  { code: 'CAN', name: 'Canada', flag: '🇨🇦', symbol: '$', banks: ['Royal Bank of Canada', 'TD Bank', 'Scotiabank', 'BMO'] },
  { code: 'AUS', name: 'Australia', flag: '🇦🇺', symbol: '$', banks: ['Commonwealth Bank', 'Westpac', 'ANZ', 'NAB'] },
  { code: 'KEN', name: 'Kenya', flag: '🇰🇪', symbol: 'Sh', banks: ['KCB Bank', 'Equity Bank', 'Co-operative Bank', 'NCBA Bank'] },
  { code: 'GHA', name: 'Ghana', flag: '🇬🇭', symbol: '₵', banks: ['GCB Bank', 'Ecobank', 'ABSA Bank', 'Zenith Bank Ghana'] },
  { code: 'IND', name: 'India', flag: '🇮🇳', symbol: '₹', banks: ['State Bank of India', 'HDFC Bank', 'ICICI Bank', 'Axis Bank'] }
];

const DEFAULT_TOKENS = [
  { symbol: 'USDC', name: 'USD Coin', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png', balance: 0 },
  { symbol: 'SOL', name: 'Solana', mint: 'So11111111111111111111111111111111111111112', logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png', balance: 0 },
  { symbol: 'USDT', name: 'Tether', mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB/logo.png', balance: 0 },
  { symbol: 'BONK', name: 'Bonk', mint: 'DezXAZ8z7PnrnRJjz3wJaRix35C1ON4C74Dqcbdn6dx3', logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/DezXAZ8z7PnrnRJjz3wJaRix35C1ON4C74Dqcbdn6dx3/logo.png', balance: 0 },
  { symbol: 'JUP', name: 'Jupiter', mint: 'JUPyiwrYJGwHMTIe6gp89e1tRT2OgpJ21Dcwh64GPunI', logoURI: 'https://dd.dexscreener.com/ds-data/tokens/solana/JUPyiwrYJGwHMTIe6gp89e1tRT2OgpJ21Dcwh64GPunI.png', balance: 0 }
];

export default function P2PPanel({ connected, walletTokenList }) {
  const [mode, setMode] = useState('sell'); // 'sell' or 'buy'
  const [selectedCountry, setSelectedCountry] = useState(COUNTRIES[0]);
  const [accountNumber, setAccountNumber] = useState('');
  const [selectedBank, setSelectedBank] = useState('Choose Bank');
  const [amount, setAmount] = useState('');
  const [selectedToken, setSelectedToken] = useState(DEFAULT_TOKENS[0]);

  // Success Pop-up state
  const [showSuccess, setShowSuccess] = useState(false);
  const [successDetails, setSuccessDetails] = useState(null);

  // Dropdown states
  const [countryOpen, setCountryOpen] = useState(false);
  const [bankOpen, setBankOpen] = useState(false);
  const [tokenOpen, setTokenOpen] = useState(false);

  // Search & dynamic token imports in Buy Mode
  const [searchTerm, setSearchTerm] = useState('');
  const [customToken, setCustomToken] = useState(null);
  const [customTokenLoading, setCustomTokenLoading] = useState(false);

  // Scan & Paste feedback states
  const [scanStatus, setScanStatus] = useState(null);

  // Routing & Loading states
  const [routingState, setRoutingState] = useState('idle'); // 'routing' | 'loading_market' | 'resolved'

  // Account Name resolution states
  const [accountName, setAccountName] = useState('David Miller');
  const [resolvingName, setResolvingName] = useState(false);

  // Fetch token list from props or defaults
  const getSelectableTokens = () => {
    let list = [];
    if (connected && walletTokenList && walletTokenList.length > 0) {
      list = walletTokenList;
    } else {
      list = DEFAULT_TOKENS;
    }

    if (mode === 'sell') {
      if (connected) {
        return list.filter(t => t.balance > 0 || t.symbol === 'SOL');
      }
      return list;
    } else {
      return list;
    }
  };

  const selectableTokens = getSelectableTokens();

  // Adjust selected token if it is not available in the current mode's selectable list
  useEffect(() => {
    const list = getSelectableTokens();
    const isAvailable = list.some(t => t.symbol === selectedToken.symbol || t.mint === selectedToken.mint);
    if (!isAvailable && list.length > 0) {
      setSelectedToken(list[0]);
    }
  }, [mode, connected, walletTokenList]);

  // Reset bank selection when country changes
  useEffect(() => {
    setSelectedBank('Choose Bank');
  }, [selectedCountry]);

  // Handle Paste from Clipboard
  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text && /^\d+$/.test(text.trim())) {
        setAccountNumber(text.trim());
      } else {
        alert("Clipboard content is not a valid account number.");
      }
    } catch (err) {
      const fallback = prompt("Paste your account number here:");
      if (fallback && /^\d+$/.test(fallback.trim())) {
        setAccountNumber(fallback.trim());
      }
    }
  };

  // Handle Mock Scan
  const handleScan = () => {
    setScanStatus("Scanning...");
    setTimeout(() => {
      const mockAcc = Math.floor(1000000000 + Math.random() * 9000000000).toString();
      setAccountNumber(mockAcc);
      setScanStatus("Scanned");
      setTimeout(() => setScanStatus(null), 2000);
    }, 1200);
  };

  // Trigger loading sequence on interactive changes (Mode, Token, Country, Bank)
  useEffect(() => {
    setRoutingState('routing');

    const t1 = setTimeout(() => {
      setRoutingState('loading_market');

      const t2 = setTimeout(() => {
        setRoutingState('resolved');
      }, 1200);

      return () => clearTimeout(t2);
    }, 1200);

    return () => clearTimeout(t1);
  }, [selectedToken, mode, selectedCountry, selectedBank]);

  // Resolve account name dynamically matching the country's localized naming style
  useEffect(() => {
    if (!accountNumber) {
      setAccountName('');
      return;
    }
    
    setResolvingName(true);
    const t = setTimeout(() => {
      setResolvingName(false);
      const namesByCountry = {
        USA: 'David Miller',
        NGA: 'Chinedu Okeke',
        GBR: 'Alastair Campbell',
        EUR: 'Hans Meier',
        CAN: 'Jean-Pierre Tremblay',
        AUS: 'Lachlan Murdoch',
        KEN: 'Mwangi Kamau',
        GHA: 'Kofi Mensah',
        IND: 'Aarav Patel'
      };
      setAccountName(namesByCountry[selectedCountry.code] || 'John Doe');
    }, 600);

    return () => clearTimeout(t);
  }, [accountNumber, selectedCountry]);

  // Search by contract address API query (Buy Mode only)
  useEffect(() => {
    if (mode === 'buy' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(searchTerm.trim())) {
      const address = searchTerm.trim();
      const exists = selectableTokens.some(t => t.mint === address || t.symbol.toLowerCase() === address.toLowerCase());
      if (exists) {
        setCustomToken(null);
        return;
      }

      setCustomTokenLoading(true);
      let cancelled = false;
      
      fetch(`https://tokens.jup.ag/token/${address}`)
        .then(res => {
          if (res.ok) return res.json();
          throw new Error("Not found");
        })
        .then(data => {
          if (cancelled) return;
          if (data && data.symbol) {
            setCustomToken({
              symbol: data.symbol,
              name: data.name || data.symbol,
              mint: data.address,
              logoURI: data.logoURI || '',
              price: 1.00,
              balance: 0
            });
          } else {
            setCustomToken(null);
          }
        })
        .catch(() => {
          if (cancelled) return;
          setCustomToken({
            symbol: address.slice(0, 4).toUpperCase(),
            name: 'Imported Contract',
            mint: address,
            logoURI: '',
            price: 1.00,
            balance: 0
          });
        })
        .finally(() => {
          if (!cancelled) setCustomTokenLoading(false);
        });

      return () => { cancelled = true; };
    } else {
      setCustomToken(null);
      setCustomTokenLoading(false);
    }
  }, [searchTerm, mode]);

  // Filter token list by search input
  const filteredTokens = selectableTokens.filter(t => {
    const term = searchTerm.toLowerCase().trim();
    if (!term) return true;
    return (
      t.symbol.toLowerCase().includes(term) ||
      t.name?.toLowerCase().includes(term) ||
      (t.mint && t.mint.toLowerCase() === term)
    );
  });

  const displayList = [...filteredTokens];
  if (customToken && !displayList.some(t => t.mint === customToken.mint)) {
    displayList.unshift(customToken);
  }

  // Calculate mock conversion values
  const rate = selectedToken.symbol === 'SOL' ? 145.20 : selectedToken.symbol === 'BONK' ? 0.000022 : 1.00;
  const parsedAmt = parseFloat(amount) || 0;
  
  const cryptoAmount = mode === 'buy'
    ? (parsedAmt > 0 ? (parsedAmt / rate).toFixed(2) : '00')
    : (parsedAmt > 0 ? parsedAmt.toFixed(2) : '00');

  const fiatAmountText = mode === 'sell'
    ? (parsedAmt > 0 ? (parsedAmt * rate).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00')
    : (parsedAmt > 0 ? parsedAmt.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00');

  const displayBank = selectedBank === 'Choose Bank' ? selectedCountry.banks[0] : selectedBank;

  return (
    <div className="p2p-panel-wrap">
      {/* ── Toggle Switch & Country Selector ── */}
      <div className="p2p-header-row" style={{ marginBottom: '1.25rem' }}>
        <div className={`bulk-pill ${mode === 'buy' ? 'on' : ''}`} onClick={() => {
          setMode(mode === 'sell' ? 'buy' : 'sell');
          setAmount('');
          setSearchTerm('');
        }} style={{ padding: '6px 12px' }}>
          <span className="pill-txt" style={{ fontSize: '11px', fontWeight: 700 }}>{mode === 'sell' ? 'SELL' : 'BUY'}</span>
          <div className={`tsw ${mode === 'buy' ? 'on' : ''}`}><div className="tknob" /></div>
        </div>

        <div className="p2p-country-selector">
          <div className="curr-selector" onClick={() => setCountryOpen(!countryOpen)}>
            <span className="curr-flag">{selectedCountry.flag}</span>
            <span style={{ marginLeft: '4px' }}>{selectedCountry.code}</span>
            <span className="curr-chevron" style={{ marginLeft: '6px' }}>▼</span>
          </div>

          {countryOpen && (
            <div className="drop-menu" style={{ right: 0, zIndex: 100 }}>
              {COUNTRIES.map(c => (
                <div 
                  key={c.code} 
                  className={`drop-item ${selectedCountry.code === c.code ? 'sel' : ''}`}
                  onClick={() => { setSelectedCountry(c); setCountryOpen(false); }}
                >
                  <span className="curr-flag">{c.flag}</span>
                  <span className="di-code" style={{ marginLeft: '8px' }}>{c.code}</span>
                  <span className="di-name">{c.name}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {mode === 'sell' ? (
        /* ==================== SELL MODE (NATIVE FIELD STYLING) ==================== */
        <>
          {/* Account Number Field */}
          <div className="field">
            <div className="field-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
              <div className="field-label" style={{ marginBottom: 0 }}>Account Number</div>
              <div className="p2p-action-links" style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                <button className="p2p-link-action" onClick={handleScan} title="Scan QR Code">
                  {scanStatus ? (
                    <span style={{ fontSize: '10px', color: 'var(--lime)', fontWeight: 'bold' }}>{scanStatus}</span>
                  ) : (
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
                      <rect x="3" y="3" width="7" height="7" />
                      <rect x="14" y="3" width="7" height="7" />
                      <rect x="14" y="14" width="7" height="7" />
                      <rect x="3" y="14" width="7" height="7" />
                      <rect x="9" y="9" width="2" height="2" fill="currentColor" stroke="none" />
                      <rect x="14" y="9" width="2" height="2" fill="currentColor" stroke="none" />
                      <rect x="9" y="14" width="2" height="2" fill="currentColor" stroke="none" />
                    </svg>
                  )}
                </button>
                <button className="p2p-btn-badge" onClick={handlePaste}>
                  Paste
                </button>
              </div>
            </div>
            
            <div className="input-wrap">
              <input 
                type="text" 
                value={accountNumber}
                onChange={e => setAccountNumber(e.target.value.replace(/\D/g, ''))}
                placeholder="0000000000"
              />
            </div>

            <div className="p2p-account-name-resolved" style={{ marginTop: '6px', minHeight: '16px', fontSize: '12px', color: 'var(--lime)', fontWeight: 'bold' }}>
              {accountNumber && accountNumber.trim().length > 0 && selectedBank !== 'Choose Bank' && (
                resolvingName ? (
                  <span style={{ fontStyle: 'italic', color: 'var(--text3)', fontWeight: 'normal' }}>
                    <span className="p2p-mini-spinner" /> Resolving...
                  </span>
                ) : (
                  accountName && <span className="animated-fade-in">{accountName}</span>
                )
              )}
            </div>
          </div>

          {/* Choose Bank Field */}
          <div className="field" style={{ position: 'relative' }}>
            <div className="field-label">Bank</div>
            <div className="input-wrap" onClick={() => setBankOpen(!bankOpen)} style={{ cursor: 'pointer', justifyContent: 'space-between' }}>
              <span style={{ color: selectedBank === 'Choose Bank' ? 'var(--text3)' : 'var(--text)' }}>{selectedBank}</span>
              <span style={{ color: 'var(--text3)', fontSize: '11px' }}>▼</span>
            </div>

            {bankOpen && (
              <div className="drop-menu" style={{ left: 0, right: 0, width: '100%' }}>
                {selectedCountry.banks.map(b => (
                  <div 
                    key={b} 
                    className={`drop-item ${selectedBank === b ? 'sel' : ''}`}
                    onClick={() => { setSelectedBank(b); setBankOpen(false); }}
                  >
                    {b}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Amount & Token Selection Row */}
          <div className="p2p-amount-row" style={{ display: 'flex', gap: '16px', marginBottom: '0.95rem' }}>
            <div style={{ flex: 1.4 }}>
              <div className="field-label">Amount</div>
              <div className="input-wrap">
                <span style={{ color: 'var(--text2)', fontWeight: 700, fontSize: '15px' }}>{selectedCountry.symbol}</span>
                <input 
                  type="number" 
                  placeholder="0"
                  value={amount}
                  onChange={e => setAmount(e.target.value)}
                  style={{ width: '100%', border: 'none', outline: 'none', background: 'transparent', color: 'white' }}
                />
              </div>
              
              <div style={{ marginTop: '6px', fontSize: '12px', minHeight: '16px' }}>
                {routingState === 'routing' ? (
                  <span style={{ color: 'var(--text3)', fontStyle: 'italic' }}>
                    <span className="p2p-mini-spinner" /> Routing...
                  </span>
                ) : (
                  <span style={{ color: 'var(--text2)' }}>
                    ✓ Route: {displayBank} Escrow
                  </span>
                )}
              </div>
            </div>

            <div style={{ flex: 1 }}>
              <div className="field-label">Token</div>
              <div className="drop-wrap">
                <div className="input-wrap" onClick={() => setTokenOpen(!tokenOpen)} style={{ cursor: 'pointer', justifyContent: 'space-between' }}>
                  <strong style={{ color: 'white' }}>{selectedToken.symbol}</strong>
                  <span style={{ color: 'var(--text3)', fontSize: '11px' }}>▼</span>
                </div>

                {tokenOpen && (
                  <div className="drop-menu" style={{ right: 0, minWidth: '260px' }}>
                    {selectableTokens.map(t => (
                      <div 
                        key={t.mint || t.symbol} 
                        className={`drop-item ${selectedToken.symbol === t.symbol ? 'sel' : ''}`}
                        onClick={() => { setSelectedToken(t); setTokenOpen(false); }}
                      >
                        {t.logoURI ? (
                          <img src={t.logoURI} alt={t.symbol} style={{ width: '20px', height: '20px', borderRadius: '50%' }} />
                        ) : (
                          <div style={{ width: '20px', height: '20px', borderRadius: '50%', background: 'rgba(255,255,255,0.1)', color: 'white', fontSize: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold' }}>{t.symbol.slice(0, 2)}</div>
                        )}
                        <span className="di-code" style={{ marginLeft: '8px' }}>{t.symbol}</span>
                        {t.balance > 0 && <span className="di-name">{t.balance.toLocaleString(undefined, { maximumFractionDigits: 4 })}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Est. Receive Receipt Banner */}
          <div className="p2p-receipt-banner" style={{ background: 'rgba(255, 255, 255, 0.02)', border: '1px solid var(--border)', borderRadius: '12px', padding: '14px', textAlign: 'center', marginBottom: '1rem', display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Est. Receive</span>
            {routingState === 'routing' || routingState === 'loading_market' ? (
              <div style={{ fontSize: '16px', fontWeight: 700, color: 'white' }}>
                <span className="p2p-mini-spinner" /> Loading...
              </div>
            ) : (
              <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--lime)' }}>
                {selectedCountry.symbol}{fiatAmountText}
              </div>
            )}
          </div>
        </>
      ) : (
        /* ==================== BUY MODE (NATIVE FIELD STYLING) ==================== */
        <>
          {/* Amount & Token Selection Row */}
          <div className="p2p-amount-row" style={{ display: 'flex', gap: '16px', marginBottom: '0.95rem' }}>
            <div style={{ flex: 1.4 }}>
              <div className="field-label">Amount</div>
              <div className="input-wrap">
                <span style={{ color: 'var(--text2)', fontWeight: 700, fontSize: '15px' }}>{selectedCountry.symbol}</span>
                <input 
                  type="number" 
                  placeholder="0"
                  value={amount}
                  onChange={e => setAmount(e.target.value)}
                  style={{ width: '100%', border: 'none', outline: 'none', background: 'transparent', color: 'white' }}
                />
              </div>
            </div>

            <div style={{ flex: 1 }}>
              <div className="field-label">Token</div>
              <div className="drop-wrap">
                <div className="input-wrap" onClick={() => setTokenOpen(!tokenOpen)} style={{ cursor: 'pointer', justifyContent: 'space-between' }}>
                  <strong style={{ color: 'white' }}>{selectedToken.symbol}</strong>
                  <span style={{ color: 'var(--text3)', fontSize: '11px' }}>▼</span>
                </div>

                {tokenOpen && (
                  <div className="drop-menu" style={{ right: 0, minWidth: '280px' }}>
                    <div className="drop-search">
                      <input 
                        type="text" 
                        placeholder="Search symbol or contract..."
                        value={searchTerm}
                        onChange={e => setSearchTerm(e.target.value)}
                        onClick={e => e.stopPropagation()}
                        autoFocus
                      />
                    </div>
                    
                    {customTokenLoading && (
                      <div className="drop-item" style={{ fontStyle: 'italic', justifyContent: 'center' }}>
                        <span className="p2p-mini-spinner" /> Finding contract...
                      </div>
                    )}

                    {displayList.length === 0 && !customTokenLoading && (
                      <div className="drop-item" style={{ fontStyle: 'italic', justifyContent: 'center' }}>No tokens found</div>
                    )}

                    {displayList.map(t => (
                      <div 
                        key={t.mint || t.symbol} 
                        className={`drop-item ${selectedToken.symbol === t.symbol ? 'sel' : ''}`}
                        onClick={() => {
                          setSelectedToken(t);
                          setTokenOpen(false);
                          setSearchTerm('');
                        }}
                      >
                        {t.logoURI ? (
                          <img src={t.logoURI} alt={t.symbol} style={{ width: '20px', height: '20px', borderRadius: '50%' }} />
                        ) : (
                          <div style={{ width: '20px', height: '20px', borderRadius: '50%', background: 'rgba(255,255,255,0.1)', color: 'white', fontSize: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold' }}>{t.symbol.slice(0, 2)}</div>
                        )}
                        <span className="di-code" style={{ marginLeft: '8px' }}>{t.symbol}</span>
                        {t.balance > 0 && <span className="di-name">{t.balance.toLocaleString(undefined, { maximumFractionDigits: 4 })}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Account Detail Box */}
          <div className="field">
            <div className="field-label" style={{ textAlign: 'center' }}>Account Detail</div>
            <div className="p2p-account-detail-box" style={{ background: 'rgba(0, 0, 0, 0.15)', border: '1.5px solid var(--border)', borderRadius: '13px', padding: '14px', minHeight: '120px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              {routingState === 'routing' ? (
                <div style={{ textAlign: 'center', color: 'var(--text3)', fontSize: '13px', fontStyle: 'italic' }}>
                  <span className="p2p-mini-spinner" /> Routing...
                </div>
              ) : (
                <div className="animated-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '13px', color: 'var(--text2)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>Bank Name:</span>
                    <strong style={{ color: 'white' }}>{displayBank}</strong>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>Account Number:</span>
                    <strong style={{ color: 'white', fontFamily: 'var(--mono)' }}>9012847592</strong>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>Beneficiary:</span>
                    <strong style={{ color: 'white' }}>Fiatwallet Escrow Ltd</strong>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>Ref Code:</span>
                    <strong style={{ color: 'var(--lime)', fontFamily: 'var(--mono)' }}>FW-7739</strong>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Est. Crypto to Receive Receipt Banner */}
          <div className="p2p-receipt-banner" style={{ background: 'rgba(255, 255, 255, 0.02)', border: '1px solid var(--border)', borderRadius: '12px', padding: '14px', textAlign: 'center', marginBottom: '1rem', display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Est. Crypto to Receive</span>
            {routingState === 'routing' || routingState === 'loading_market' ? (
              <div style={{ fontSize: '16px', fontWeight: 700, color: 'white' }}>
                <span className="p2p-mini-spinner" /> Loading...
              </div>
            ) : (
              <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--lime)' }}>
                {cryptoAmount} {selectedToken.symbol}
              </div>
            )}
          </div>
        </>
      )}

      {/* ── Submit Action Button (Reusing Send Button Class) ── */}
      <button 
        className="send-btn" 
        onClick={() => {
          setSuccessDetails({
            action: mode === 'sell' ? 'Sell' : 'Buy',
            amount: `${amount || '0'} ${selectedToken.symbol}`,
            fiat: `${selectedCountry.symbol}${fiatAmountText}`,
            bank: displayBank,
            account: mode === 'sell' ? (accountNumber || '0000000000') : '9012847592',
            name: mode === 'sell' ? (accountName || 'David Miller') : 'Fiatwallet Escrow Ltd'
          });
          setShowSuccess(true);
        }}
      >
        {mode === 'sell' ? 'Send' : 'Buy'}
      </button>

      {/* Success Modal Popup */}
      {showSuccess && successDetails && (
        <div className="p2p-success-overlay">
          <div className="p2p-success-card">
            <div className="p2p-success-icon-wrap">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <h3 className="p2p-success-title">Trade Successful</h3>
            <p className="p2p-success-sub">Demo Mode — No real funds were sent or received.</p>
            
            <div className="p2p-success-fields">
              <div className="p2p-success-field">
                <span>Action:</span>
                <strong>{successDetails.action} {successDetails.amount}</strong>
              </div>
              <div className="p2p-success-field">
                <span>Fiat Value:</span>
                <strong>{successDetails.fiat}</strong>
              </div>
              <div className="p2p-success-field">
                <span>Bank:</span>
                <strong>{successDetails.bank}</strong>
              </div>
              <div className="p2p-success-field">
                <span>Account Number:</span>
                <strong>{successDetails.account}</strong>
              </div>
              <div className="p2p-success-field">
                <span>Recipient/Sender:</span>
                <strong>{successDetails.name}</strong>
              </div>
            </div>
            
            <button className="send-btn" onClick={() => { setShowSuccess(false); setAmount(''); }} style={{ marginTop: '1rem' }}>
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
