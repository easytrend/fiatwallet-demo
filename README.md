# Solpay — Web3 Payments via .sol Domains

A Solana-powered payments dApp that lets you send crypto using `.sol` domains, view your wallet token balances, and convert between fiat and crypto with live rates.

## Features

- 🔗 **Phantom & Solflare wallet connect** — real on-chain connection
- 💼 **Wallet token viewer** — see your SOL balance and all SPL tokens
- ⚡ **Live conversion rates** — fiat rates from open.er-api.com (160+ currencies incl. NGN, KES, GHS), crypto prices from CoinGecko, auto-refreshed every 60s
- 🌍 **60+ fiat currencies** — NGN, USD, EUR, GBP, KES, GHS, ZAR and more
- 📤 **Send crypto** — to any `.sol` domain or wallet address
- 📦 **Bulk send** — upload CSV/XLSX to pay up to 1,000 wallets at once
- 📷 **Receive QR code** — share your wallet address as a scannable QR
- 🔍 **Token selector** — shows only tokens in your connected wallet with real balances

## Live Demo

> Hosted via GitHub Pages: [https://easytrend.github.io/Solpay/](https://easytrend.github.io/Solpay/)

## Usage

1. Open `index.html` in Chrome/Brave **with Phantom or Solflare installed**
2. For best results serve via HTTP (not `file://`):
   ```bash
   python -m http.server 8080
   ```
   Then open `http://localhost:8080`
3. Click **Connect Wallet** → approve in Phantom
4. Use **Send** tab to transfer tokens via `.sol` domain
5. Use **💼 Wallet** tab to view your on-chain balances

## Tech Stack

| Layer | Technology |
|---|---|
| UI | React 18 (UMD), Babel Standalone |
| Styling | Vanilla CSS (dark mode, glassmorphism) |
| Wallet | Phantom / Solflare browser extension |
| RPC | Alchemy, Ankr, Helius (raw JSON-RPC fetch) |
| Fiat Rates | open.er-api.com → exchangerate-api.com → frankfurter.app |
| Crypto Prices | CoinGecko public API |
| Domains | Solana Name Service (SNS) |

## Enabling GitHub Pages

1. Go to **Settings → Pages**
2. Source: `Deploy from branch` → `main` → `/ (root)`
3. Save — live at `https://easytrend.github.io/Solpay/`

## License

MIT
