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
  const [accountNumber, setAccountNumber] = useState('0000000000');
  const [selectedBank, setSelectedBank] = useState('Choose Bank');
  const [amount, setAmount] = useState('');
  const [selectedToken, setSelectedToken] = useState(DEFAULT_TOKENS[0]); // Object instead of string

  // Dropdown states
  const [countryOpen, setCountryOpen] = useState(false);
  const [bankOpen, setBankOpen] = useState(false);
  const [tokenOpen, setTokenOpen] = useState(false);

  // Search in Buy Mode
  const [searchTerm, setSearchTerm] = useState('');
  const [customToken, setCustomToken] = useState(null);
  const [customTokenLoading, setCustomTokenLoading] = useState(false);

  // Scan & Paste feedback states
  const [scanStatus, setScanStatus] = useState(null);

  // Routing & Loading states
  const [routingState, setRoutingState] = useState('idle'); // 'routing' | 'loading_market' | 'resolved'

  // Fetch token list from props or defaults
  const getSelectableTokens = () => {
    let list = [];
    if (connected && walletTokenList && walletTokenList.length > 0) {
      list = walletTokenList;
    } else {
      list = DEFAULT_TOKENS;
    }

    if (mode === 'sell') {
      // Sell Mode: show only available tokens in user's wallet
      if (connected) {
        // SOL always exists/visible, others if balance > 0
        return list.filter(t => t.balance > 0 || t.symbol === 'SOL');
      }
      return list;
    } else {
      // Buy Mode: show all
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
      // Fallback prompt if clipboard permissions are blocked
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
          // Fallback mock token if registry lookup fails
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
      {/* ── Header Navigation Row ── */}
      <div className="p2p-header-row">
        {/* Toggle Switch */}
        <div className="p2p-mode-toggle" onClick={() => {
          setMode(mode === 'sell' ? 'buy' : 'sell');
          setAmount('');
          setSearchTerm('');
        }}>
          <div className={`p2p-toggle-track ${mode === 'buy' ? 'mode-buy' : 'mode-sell'}`}>
            {mode === 'sell' ? (
              <>
                <div className="p2p-toggle-knob" />
                <span className="p2p-toggle-text">Sell</span>
              </>
            ) : (
              <>
                <span className="p2p-toggle-text">Buy</span>
                <div className="p2p-toggle-knob" />
              </>
            )}
          </div>
        </div>

        {/* Country Selector Dropdown with World Map Icon */}
        <div className="p2p-country-selector">
          <button className="p2p-country-btn" onClick={() => setCountryOpen(!countryOpen)}>
            <svg className="p2p-map-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="2" y1="12" x2="22" y2="12"></line>
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
            </svg>
            <span style={{ fontSize: '13px', fontWeight: 600 }}>{selectedCountry.flag} {selectedCountry.code}</span>
            <span className="p2p-dropdown-arrow">▼</span>
          </button>

          {countryOpen && (
            <div className="p2p-dropdown-list">
              {COUNTRIES.map(c => (
                <div 
                  key={c.code} 
                  className={`p2p-dropdown-item ${selectedCountry.code === c.code ? 'selected' : ''}`}
                  onClick={() => { setSelectedCountry(c); setCountryOpen(false); }}
                >
                  <span className="p2p-di-flag">{c.flag}</span>
                  <span className="p2p-di-code">{c.code}</span>
                  <span className="p2p-di-name">{c.name}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Main P2P Box Card ── */}
      <div className="p2p-box-card">
        {mode === 'sell' ? (
          /* ==================== SELL MODE ==================== */
          <>
            {/* Account Number Row */}
            <div className="p2p-field-group">
              <div className="p2p-field-header">
                <span className="p2p-field-title">Account Number</span>
                <div className="p2p-action-links">
                  <button className="p2p-link-action" onClick={handleScan}>
                    {scanStatus || 'Scan'}
                  </button>
                  <button className="p2p-btn-badge" onClick={handlePaste}>Paste</button>
                </div>
              </div>
              
              <input 
                type="text" 
                className="p2p-input-val" 
                value={accountNumber}
                onChange={e => setAccountNumber(e.target.value.replace(/\D/g, ''))}
                placeholder="0000000000"
              />
              <div className="p2p-input-underline" />
            </div>

            {/* Choose Bank Bar (Spans full width of card) */}
            <div className="p2p-bank-selector-row-wrap">
              <div className="p2p-bank-selector-bar" onClick={() => setBankOpen(!bankOpen)}>
                <span>{selectedBank}</span>
                <span className="p2p-bank-dropdown-arrow-txt">▼</span>
              </div>
              {bankOpen && (
                <div className="p2p-bank-dropdown-container">
                  <div className="p2p-dropdown-list bank-dropdown-list">
                    {selectedCountry.banks.map(b => (
                      <div 
                        key={b} 
                        className={`p2p-dropdown-item ${selectedBank === b ? 'selected' : ''}`}
                        onClick={() => { setSelectedBank(b); setBankOpen(false); }}
                      >
                        {b}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Amount & Token Selection */}
            <div className="p2p-amount-row" style={{ marginTop: '0.8rem' }}>
              <div className="p2p-amount-col">
                <span className="p2p-field-title">Amount</span>
                <div className="p2p-amount-input-wrap">
                  <span className="p2p-currency-symbol">{selectedCountry.symbol}</span>
                  <input 
                    type="number" 
                    className="p2p-amount-input" 
                    placeholder="0"
                    value={amount}
                    onChange={e => setAmount(e.target.value)}
                  />
                </div>
                {/* Routing Status Box */}
                <div className="p2p-routing-status-line">
                  {routingState === 'routing' ? (
                    <span className="p2p-routing-text loading">
                      <span className="p2p-mini-spinner" /> Routing...
                    </span>
                  ) : (
                    <span className="p2p-routing-text resolved">
                      ✓ Route: {displayBank} Escrow
                    </span>
                  )}
                </div>
              </div>

              {/* Token Selector */}
              <div className="p2p-token-col">
                <span className="p2p-field-title">Token</span>
                <div className="p2p-token-selector">
                  <button className="p2p-token-btn" onClick={() => setTokenOpen(!tokenOpen)}>
                    <strong>{selectedToken.symbol}</strong>
                    <span className="p2p-dropdown-arrow">▼</span>
                  </button>
                  {tokenOpen && (
                    <div className="p2p-dropdown-list tokens-list">
                      {selectableTokens.map(t => (
                        <div 
                          key={t.mint || t.symbol} 
                          className={`p2p-dropdown-item ${selectedToken.symbol === t.symbol ? 'selected' : ''}`}
                          onClick={() => { setSelectedToken(t); setTokenOpen(false); }}
                        >
                          {t.logoURI ? (
                            <img src={t.logoURI} alt={t.symbol} className="p2p-di-logo" />
                          ) : (
                            <div className="p2p-di-logo-fallback">{t.symbol.slice(0, 2)}</div>
                          )}
                          <div className="p2p-di-token-info">
                            <span className="p2p-di-code">{t.symbol}</span>
                            <span className="p2p-di-name-small">{t.name || 'Token'}</span>
                          </div>
                          {t.balance > 0 && (
                            <span className="p2p-di-balance">{t.balance.toLocaleString(undefined, { maximumFractionDigits: 4 })}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
            
            {/* Bottom Gray Bar (Spans full width of card) */}
            <div className="p2p-bottom-status-row">
              {routingState === 'routing' || routingState === 'loading_market' ? (
                <div className="p2p-status-bar loading">
                  <span className="p2p-mini-spinner" /> Loading...
                </div>
              ) : (
                <div className="p2p-status-bar resolved">
                  Est. Receive: {selectedCountry.symbol}{fiatAmountText}
                </div>
              )}
            </div>
          </>
        ) : (
          /* ==================== BUY MODE ==================== */
          <>
            {/* Amount & Token Input */}
            <div className="p2p-amount-row">
              <div className="p2p-amount-col">
                <span className="p2p-field-title">Amount</span>
                <div className="p2p-amount-input-wrap">
                  <span className="p2p-currency-symbol">{selectedCountry.symbol}</span>
                  <input 
                    type="number" 
                    className="p2p-amount-input" 
                    placeholder="0"
                    value={amount}
                    onChange={e => setAmount(e.target.value)}
                  />
                </div>
              </div>

              {/* Token Selector with Contract Search */}
              <div className="p2p-token-col">
                <span className="p2p-field-title">Token</span>
                <div className="p2p-token-selector">
                  <button className="p2p-token-btn" onClick={() => setTokenOpen(!tokenOpen)}>
                    <strong>{selectedToken.symbol}</strong>
                    <span className="p2p-dropdown-arrow">▼</span>
                  </button>
                  {tokenOpen && (
                    <div className="p2p-dropdown-list tokens-list">
                      <div className="p2p-search-box-wrap">
                        <input 
                          type="text" 
                          className="p2p-token-search-input"
                          placeholder="Search symbol or contract..."
                          value={searchTerm}
                          onChange={e => setSearchTerm(e.target.value)}
                          onClick={e => e.stopPropagation()}
                          autoFocus
                        />
                      </div>
                      
                      {customTokenLoading && (
                        <div className="p2p-dropdown-item loading">
                          <span className="p2p-mini-spinner" /> Finding contract...
                        </div>
                      )}

                      {displayList.length === 0 && !customTokenLoading && (
                        <div className="p2p-dropdown-item placeholder">No tokens found</div>
                      )}

                      {displayList.map(t => (
                        <div 
                          key={t.mint || t.symbol} 
                          className={`p2p-dropdown-item ${selectedToken.symbol === t.symbol ? 'selected' : ''}`}
                          onClick={() => {
                            setSelectedToken(t);
                            setTokenOpen(false);
                            setSearchTerm('');
                          }}
                        >
                          {t.logoURI ? (
                            <img src={t.logoURI} alt={t.symbol} className="p2p-di-logo" />
                          ) : (
                            <div className="p2p-di-logo-fallback">{t.symbol.slice(0, 2)}</div>
                          )}
                          <div className="p2p-di-token-info">
                            <span className="p2p-di-code">{t.symbol}</span>
                            <span className="p2p-di-name-small">{t.name || 'Token'}</span>
                          </div>
                          {t.balance > 0 && (
                            <span className="p2p-di-balance">{t.balance.toLocaleString(undefined, { maximumFractionDigits: 4 })}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Account Detail Box */}
            <div className="p2p-account-details-middle">
              <div className="p2p-ad-title-centered">Account Detail</div>
              {routingState === 'routing' ? (
                <div className="p2p-routing-text-centered loading">
                  <span className="p2p-mini-spinner" /> Routing...
                </div>
              ) : (
                <div className="p2p-ad-content-centered animated-fade-in">
                  <div>Bank Name: <strong>{displayBank}</strong></div>
                  <div>Account Number: <strong style={{ fontFamily: 'var(--mono)' }}>9012847592</strong></div>
                  <div>Beneficiary: <strong>Fiatwallet Escrow Ltd</strong></div>
                  <div>Ref: <strong style={{ color: 'var(--lime)', fontFamily: 'var(--mono)' }}>FW-7739</strong></div>
                </div>
              )}
            </div>

            {/* Bottom Gray Bar showing Crypto to Receive */}
            <div className="p2p-bottom-status-row">
              {routingState === 'routing' || routingState === 'loading_market' ? (
                <div className="p2p-status-bar loading">
                  <span className="p2p-mini-spinner" /> Loading...
                </div>
              ) : (
                <div className="p2p-status-bar resolved">
                  {cryptoAmount}   {selectedToken.symbol}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* ── Main Action CTA Button ── */}
      <button 
        className="p2p-submit-btn" 
        onClick={() => alert(`P2P Trade of ${selectedCountry.symbol}${fiatAmountText} via ${displayBank} Escrow initiated!`)}
      >
        {mode === 'sell' ? 'Send' : 'Buy'}
      </button>
    </div>
  );
}
