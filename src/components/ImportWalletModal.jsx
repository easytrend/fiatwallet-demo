import { useState } from 'react';
import { Keypair } from '@solana/web3.js';
import { decodeBase58 } from '../utils';

export default function ImportWalletModal({ onClose, onImport }) {
  const [privateKeyStr, setPrivateKeyStr] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState('bonkbot'); // 'bonkbot' | 'trojan'

  const handleImport = () => {
    setError('');
    const key = privateKeyStr.trim();
    if (!key) {
      setError('Please enter a private key.');
      return;
    }

    try {
      // Decode base58 secret key
      const decoded = decodeBase58(key);
      if (decoded.length !== 64) {
        setError(`Invalid private key length (${decoded.length} bytes). Solana private keys must decode to exactly 64 bytes.`);
        return;
      }
      
      // [SECURITY FIX #1] Only pass the keypair object — the raw secret string is no longer stored.
      const keypair = Keypair.fromSecretKey(decoded);
      onImport(keypair);
      onClose();
    } catch (err) {
      setError('Failed to import: ' + err.message);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box import-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Import Telegram Bot Wallet</h3>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          <p className="modal-desc">
            Connect your existing <strong>Bonkbot</strong> or <strong>Trojan</strong> wallet to execute high-speed transfers and bulk sends on Solana mainnet.
          </p>

          {/* Guide Selector Tabs */}
          <div className="guide-tabs">
            <button 
              className={`guide-tab-btn ${activeTab === 'bonkbot' ? 'active' : ''}`}
              onClick={() => setActiveTab('bonkbot')}
            >
              BONKbot Guide
            </button>
            <button 
              className={`guide-tab-btn ${activeTab === 'trojan' ? 'active' : ''}`}
              onClick={() => setActiveTab('trojan')}
            >
              Trojan Guide
            </button>
          </div>

          {/* Step-by-Step Interactive Guides */}
          <div className="guide-content-box">
            {activeTab === 'bonkbot' ? (
              <ol className="guide-list">
                <li>Open <strong>@bonkbot_bot</strong> in your Telegram app.</li>
                <li>Go to the main menu and click on <strong>Settings</strong>.</li>
                <li>Select <strong>Wallets</strong> and click on <strong>Export Private Key</strong>.</li>
                <li>Click <strong>Confirm</strong>, then copy the long base58 string.</li>
              </ol>
            ) : (
              <ol className="guide-list">
                <li>Open <strong>@trojanbot</strong> or your Trojan bot in Telegram.</li>
                <li>Click on <strong>Wallets</strong> or <strong>Settings</strong> from the bottom menu.</li>
                <li>Find your primary wallet and click <strong>Backup</strong> / <strong>Export Key</strong>.</li>
                <li>Copy the base58 private key string displayed.</li>
              </ol>
            )}
          </div>

          {/* Security Disclaimer */}
          <div className="security-alert">
            <span className="security-icon">🔒</span>
            <div className="security-text">
              <strong>Local & Secure:</strong> Your private key is stored strictly in your browser's local sandbox. It never touches any servers or external APIs.
            </div>
          </div>

          {/* Input Fields */}
          <div className="field" style={{ marginTop: '1rem' }}>
            <label className="field-label">Enter Base58 Private Key</label>
            <div className="pk-input-wrap">
              <input
                type={showKey ? 'text' : 'password'}
                className="pk-input"
                placeholder="Pasting your Solana private key..."
                value={privateKeyStr}
                onChange={e => {
                  setPrivateKeyStr(e.target.value);
                  setError('');
                }}
              />
              <button 
                type="button" 
                className="toggle-pk-visibility"
                onClick={() => setShowKey(!showKey)}
              >
                {showKey ? 'Hide' : 'Show'}
              </button>
            </div>
            {error && <div className="import-error-msg">✕ {error}</div>}
          </div>

          <button className="import-submit-btn" onClick={handleImport}>
            Import & Connect Wallet
          </button>
        </div>
      </div>
    </div>
  );
}
