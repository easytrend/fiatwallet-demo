/**
 * swapService.js — Swap execution layer via Jupiter V6 API
 * Abstracted so Titan SDK can replace this with zero UI changes.
 *
 * Titan Exchange aggregates Jupiter routes among others (OKX, DFlow, Argos).
 * Phase 1: Jupiter V6 REST — free, public, production-ready.
 * Phase 2: Replace QUOTE_API/SWAP_API with Titan SDK when API key obtained.
 *
 * Template Titan WebSocket snippet for real-time price streaming (RPCpool Integration):
 *   const ws = new WebSocket(import.meta.env.VITE_TITAN_WS_URL || 'wss://your-endpoint.rpcpool.com/your-token/titan/api/v1/ws');
 *   ws.onopen = () => console.log('Connected to Titan Swap API');
 *   ws.onmessage = (event) => {
 *     const data = JSON.parse(event.data);
 *     console.log('Price update:', data);
 *   };
 */

const QUOTE_API = 'https://api.jup.ag/swap/v1';

// Well-known mint addresses
export const SOL_MINT   = 'So11111111111111111111111111111111111111112';
export const USDC_MINT  = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDT_MINT  = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
export const BONK_MINT  = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
export const JUP_MINT   = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
export const WIF_MINT   = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm';
export const PYTH_MINT  = 'HZ1JovNiVvGqkvK2mFfszzgXahygABErEpoFeis2mkai';

/**
 * Fetch a swap quote.
 * @param {Object} params
 * @param {string} params.inputMint
 * @param {string} params.outputMint
 * @param {number} params.amount - in base units (lamports for SOL, smallest unit for SPL)
 * @param {number} params.slippageBps - slippage in basis points (50 = 0.5%)
 * @returns {Promise<Object>} Jupiter quote response
 */
export async function getQuote({ inputMint, outputMint, amount, slippageBps = 50 }) {
  if (!inputMint || !outputMint || !amount || amount <= 0) {
    throw new Error('Invalid quote parameters');
  }
  if (inputMint === outputMint) {
    throw new Error('Input and output tokens must be different');
  }

  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: String(Math.floor(amount)),
    slippageBps: String(slippageBps),
    platformFeeBps: '0',
    onlyDirectRoutes: 'false',
    asLegacyTransaction: 'false',
  });

  const res = await fetch(`${QUOTE_API}/quote?${params}`);
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Quote API error ${res.status}: ${errBody || res.statusText}`);
  }
  const data = await res.json();
  if (data.error) throw new Error(`Quote error: ${data.error}`);
  return data;
}

/**
 * Build a swap VersionedTransaction (unsigned).
 * @param {Object} quote - quote object returned by getQuote()
 * @param {string} userPublicKey - base58 public key of the user
 * @returns {Promise<string>} base64-encoded unsigned VersionedTransaction
 */
export async function buildSwapTransaction(quote, userPublicKey) {
  const res = await fetch(`${QUOTE_API}/swap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey,
      wrapAndUnwrapSol: true,
      useSharedAccounts: true,
      prioritizationFeeLamports: 'auto',
      asLegacyTransaction: false,
      dynamicComputeUnitLimit: true,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Swap build API error ${res.status}: ${errBody || res.statusText}`);
  }
  const data = await res.json();
  if (data.error) throw new Error(`Swap build error: ${data.error}`);
  return data.swapTransaction; // base64 VersionedTransaction
}

/**
 * Deserialize the base64 VersionedTransaction.
 * Note: Callers should import VersionedTransaction from @solana/web3.js directly.
 * This helper is kept for convenience — Buffer is polyfilled by vite-plugin-node-polyfills.
 * @param {string} base64Tx
 * @param {Function} VersionedTransaction - pass in from @solana/web3.js
 * @returns {import('@solana/web3.js').VersionedTransaction}
 */
export function deserializeSwapTx(base64Tx, VersionedTransaction) {
  const buf = Buffer.from(base64Tx, 'base64');
  return VersionedTransaction.deserialize(buf);
}

/**
 * Format a price impact percentage for display.
 * @param {string|number} priceImpactPct
 * @returns {{ label: string, severity: 'low'|'medium'|'high' }}
 */
export function formatPriceImpact(priceImpactPct) {
  const pct = parseFloat(priceImpactPct) || 0;
  const label = pct < 0.01 ? '<0.01%' : `${pct.toFixed(2)}%`;
  const severity = pct < 1 ? 'low' : pct < 3 ? 'medium' : 'high';
  return { label, severity };
}

/**
 * Convert UI amount to base units (lamports for SOL, token units for SPL).
 * @param {number} uiAmount
 * @param {number} decimals
 * @returns {number}
 */
export function toBaseUnits(uiAmount, decimals) {
  return Math.floor(uiAmount * Math.pow(10, decimals));
}

/**
 * Convert base units to UI amount.
 * @param {number|string} baseUnits
 * @param {number} decimals
 * @returns {number}
 */
export function fromBaseUnits(baseUnits, decimals) {
  return Number(baseUnits) / Math.pow(10, decimals);
}

/**
 * Shorten a mint address for display.
 * @param {string} mint
 * @returns {string}
 */
export function shortMint(mint) {
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}
