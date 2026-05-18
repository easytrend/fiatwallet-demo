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
  BackpackWalletAdapter,
  GlowWalletAdapter,
  ExodusWalletAdapter,
  BraveWalletAdapter,
} from '@solana/wallet-adapter-wallets';

// Wallet adapter default UI styles (for the "Select Wallet" modal)
import '@solana/wallet-adapter-react-ui/styles.css';
import App from './App';
import './App.css';

function Root() {
  // Use a reliable free public RPC to prevent 403 Access Forbidden errors
  const endpoint = useMemo(() => 'https://solana-rpc.publicnode.com', []);
  const wallets = useMemo(() => [
    new PhantomWalletAdapter(),
    new SolflareWalletAdapter(),
    new CoinbaseWalletAdapter(),
    new LedgerWalletAdapter(),
    new TorusWalletAdapter(),
    new TrustWalletAdapter(),
    new TrezorWalletAdapter(),
    new BackpackWalletAdapter(),
    new GlowWalletAdapter(),
    new ExodusWalletAdapter(),
    new BraveWalletAdapter(),
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
