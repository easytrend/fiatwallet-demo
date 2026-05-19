import { Buffer } from 'buffer';
globalThis.Buffer = Buffer;

import React, { useMemo } from 'react';
import ReactDOM from 'react-dom/client';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { clusterApiUrl } from '@solana/web3.js';
import {
  PhantomWalletAdapter,
  SolflareWalletAdapter,
  CoinbaseWalletAdapter,
  LedgerWalletAdapter,
  TorusWalletAdapter,
  TrustWalletAdapter,
  TrezorWalletAdapter,
} from '@solana/wallet-adapter-wallets';

// Wallet adapter default UI styles (for the "Select Wallet" modal)
import '@solana/wallet-adapter-react-ui/styles.css';
import App from './App';
import './App.css';

function Root() {
  // Use an environment variable for your premium RPC (like Helius) to prevent CORS and 403 errors.
  // Fallback to the placeholder if the env variable isn't set yet.
  const endpoint = useMemo(() => import.meta.env.VITE_RPC_URL || 'https://mainnet.helius-rpc.com/?api-key=YOUR_KEY', []);
  const wallets = useMemo(() => [
    new PhantomWalletAdapter(),
    new SolflareWalletAdapter(),
    new CoinbaseWalletAdapter(),
    new LedgerWalletAdapter(),
    new TorusWalletAdapter(),
    new TrustWalletAdapter(),
    new TrezorWalletAdapter(),
  ], []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <App />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
