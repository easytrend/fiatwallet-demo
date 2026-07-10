/**
 * bridgeService.js
 *
 * Cross-chain bridge service: Axelar Asset Transfer (mainnet) + Circle CCTP attestation.
 *
 * Fee model: Axelar Gas Service covers all relayer/bridge gas fees.
 * Users only pay in their source token — no separate EVM gas wallet needed.
 *
 * Workflow:
 *   1. getDepositAddress()       → Axelar-managed deposit address linked to the user's Solana wallet
 *   2. pollDepositStatus()       → Axelarscan GMP API polling for confirmation
 *   3. pollCCTPAttestation()     → Circle Iris API polling for burn attestation
 *   4. buildSolanaReceiveMsg()   → Prepares the Solana CCTP receiveMessage instruction call
 *   5. Fallback (axlUSDC path)   → Detected by caller, delivered automatically if CCTP mint fails
 */

// ── Constants ────────────────────────────────────────────────────────────────

/** Axelar mainnet environment string */
export const AXELAR_ENV = 'mainnet';

/** Circle Iris mainnet attestation API */
const CIRCLE_IRIS_API = 'https://iris-api.circle.com/attestations';

/** Axelarscan GMP status API */
const AXELARSCAN_GMP_API = 'https://api.gmp.axelarscan.io';

/** Squid Router v2 route API */
const SQUID_API = 'https://api.squidrouter.com/v2/route';

/**
 * Supported source chains.
 *
 * routerType controls which bridge path is used:
 *   'axelar'   → Axelar Asset Transfer (all non-BTC chains)
 *   'chainflip' → Squid Router + Chainflip AMM (native BTC only)
 *
 * btcWrapped: true  → EVM chains carrying wrapped BTC (WBTC, tBTC, BTCB)
 *                     routed via Axelar normally; user just sends the token.
 */
export const SUPPORTED_SOURCE_CHAINS = [
  // ── Native Bitcoin ──────────────────────────────────────────────────────────
  {
    id: 'bitcoin',
    label: 'Bitcoin',
    nativeSymbol: 'BTC',
    icon: '₿',
    routerType: 'chainflip',  // Squid + Chainflip — Axelar doesn't support native BTC
    confirmationsRequired: 3, // ~30 min for 3 confirmations
    notice: 'Native BTC is routed via Chainflip through Squid Router. Expect ~30–45 min for 3 Bitcoin confirmations. No EVM wallet needed.',
  },

  // ── EVM Chains (Axelar) ─────────────────────────────────────────────────────
  { id: 'ethereum',    label: 'Ethereum',   nativeSymbol: 'ETH',  icon: '⟠', routerType: 'axelar',
    btcAssets: ['WBTC', 'tBTC'],  // Wrapped BTC tokens supported on this chain
    btcWrapped: true },
  { id: 'avalanche',   label: 'Avalanche',  nativeSymbol: 'AVAX', icon: '🔺', routerType: 'axelar' },
  { id: 'polygon',     label: 'Polygon',    nativeSymbol: 'MATIC',icon: '🟣', routerType: 'axelar',
    btcAssets: ['WBTC'],
    btcWrapped: true },
  { id: 'arbitrum',    label: 'Arbitrum',   nativeSymbol: 'ETH',  icon: '🔵', routerType: 'axelar',
    btcAssets: ['WBTC', 'tBTC'],
    btcWrapped: true },
  { id: 'optimism',    label: 'Optimism',   nativeSymbol: 'ETH',  icon: '🔴', routerType: 'axelar',
    btcAssets: ['WBTC', 'tBTC'],
    btcWrapped: true },
  { id: 'base',        label: 'Base',       nativeSymbol: 'ETH',  icon: '🔷', routerType: 'axelar',
    btcAssets: ['cbBTC'],  // Coinbase's canonical wrapped BTC on Base
    btcWrapped: true },
  { id: 'bnb',         label: 'BNB Chain',  nativeSymbol: 'BNB',  icon: '🟡', routerType: 'axelar',
    btcAssets: ['BTCB'],   // Binance-pegged Bitcoin
    btcWrapped: true },

  // ── Cosmos / Other ──────────────────────────────────────────────────────────
  { id: 'osmosis-6',   label: 'Osmosis',    nativeSymbol: 'OSMO', icon: '🌀', routerType: 'axelar' },
  { id: 'cosmoshub-4', label: 'Cosmos Hub', nativeSymbol: 'ATOM', icon: '⚛️', routerType: 'axelar' },
  { id: 'sui',         label: 'Sui',        nativeSymbol: 'SUI',  icon: '💧', routerType: 'axelar' },
];

/**
 * Well-known EVM USDC addresses per chain (for CCTP burn step).
 * Keyed by Axelar chain ID.
 */
const EVM_USDC_ADDRESSES = {
  ethereum:  '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  avalanche: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6',
  polygon:   '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  arbitrum:  '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  optimism:  '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  base:      '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
};

/**
 * Circle CCTP domain IDs.
 * Source: https://developers.circle.com/stablecoins/docs/cctp-protocol-contract
 */
export const CCTP_DOMAINS = {
  ethereum:  0,
  avalanche: 1,
  optimism:  2,
  arbitrum:  3,
  base:      6,
  polygon:   7,
  solana:    5,
};

// ── Chainflip / Squid BTC-to-USDC route ─────────────────────────────────────

/**
 * Get a Squid Router route for native BTC → USDC on Solana via Chainflip.
 *
 * Chainflip is a decentralised cross-chain AMM that Squid uses as a liquidity
 * provider for Bitcoin. It produces a native BTC deposit address.
 *
 * @param {Object} params
 * @param {string} params.btcAmountSats     - Amount in satoshis (string)
 * @param {string} params.solanaAddress     - Destination Solana wallet (base58)
 * @param {string} [params.squidIntegratorId] - Optional Squid integrator ID
 * @returns {Promise<{ depositAddress: string, expiry: string, route: Object }>}
 */
export async function getBitcoinSquidRoute({ btcAmountSats, solanaAddress, squidIntegratorId }) {
  const headers = { 'Content-Type': 'application/json' };
  if (squidIntegratorId) headers['x-integrator-id'] = squidIntegratorId;

  const res = await fetch(SQUID_API, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      fromChain: 'bitcoin',          // Squid / Chainflip chain identifier for native Bitcoin
      fromToken: 'BTC',
      fromAmount: btcAmountSats,
      toChain: 'solana',
      toToken: 'USDC',              // Native USDC mint on Solana
      toAddress: solanaAddress,
      prefer: ['chainflip'],        // Prefer Chainflip for native BTC routes
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error || `Squid BTC route error: ${res.status}`);
  }

  const route = await res.json();

  // Squid returns a Chainflip-generated native BTC deposit address in route.estimate.depositAddress
  const depositAddress = route?.estimate?.depositAddress || route?.route?.estimate?.depositAddress;
  if (!depositAddress) throw new Error('Squid did not return a Bitcoin deposit address. Please try again.');

  // Chainflip BTC deposit addresses are valid for ~24h
  const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  return { depositAddress, expiry, route };
}

// ── Axelar SDK lazy-loader ────────────────────────────────────────────────────

let _axelarSDK = null;

/**
 * Lazily initialise the Axelar Asset Transfer SDK (ESM dynamic import).
 * The SDK is only loaded when the bridge panel is first opened — not at boot.
 */
async function getAxelarSDK() {
  if (_axelarSDK) return _axelarSDK;
  const { AxelarAssetTransfer, Environment } = await import(
    '@axelar-network/axelarjs-sdk'
  );
  _axelarSDK = new AxelarAssetTransfer({
    environment: Environment.MAINNET,
  });
  return _axelarSDK;
}

// ── Core Bridge Functions ─────────────────────────────────────────────────────

/**
 * Generate an Axelar-managed deposit address for the user.
 *
 * Gas fee model: Axelar's Gas Service is used — the user does NOT need a separate
 * EVM gas wallet. The relayer fees are deducted from the bridged amount automatically.
 *
 * @param {Object} params
 * @param {string} params.fromChain       - Axelar chain ID (e.g. 'ethereum')
 * @param {string} params.fromAssetSymbol - Asset symbol on source chain (e.g. 'ETH', 'USDC')
 * @param {string} params.solanaAddress   - Destination Solana wallet public key (base58)
 * @returns {Promise<{depositAddress: string, expiry: string}>}
 */
export async function getDepositAddress({ fromChain, fromAssetSymbol, solanaAddress }) {
  if (!solanaAddress) throw new Error('Solana wallet must be connected before generating a deposit address.');

  const sdk = await getAxelarSDK();

  const depositAddress = await sdk.getDepositAddress({
    fromChain,
    toChain: 'solana',
    destinationAddress: solanaAddress,
    asset: fromAssetSymbol,
  });

  // Axelar deposit addresses are valid for 24 hours
  const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  return { depositAddress, expiry };
}

/**
 * Poll the Axelarscan GMP status API to get the current status of a bridge tx.
 *
 * Possible statuses returned: 'pending', 'confirmed', 'executed', 'error'
 *
 * @param {string} txHash - Source chain transaction hash
 * @returns {Promise<{status: string, confirmations?: number, totalConfirmations?: number}>}
 */
export async function pollDepositStatus(txHash) {
  if (!txHash) throw new Error('No transaction hash provided.');

  const res = await fetch(`${AXELARSCAN_GMP_API}?method=searchGMP&txHash=${txHash}`, {
    headers: { 'Content-Type': 'application/json' },
  });

  if (!res.ok) throw new Error(`Axelarscan API error: ${res.status}`);

  const data = await res.json();
  const gmpTx = Array.isArray(data?.data) ? data.data[0] : null;

  if (!gmpTx) return { status: 'pending' };

  return {
    status: gmpTx.status || 'pending',
    confirmations: gmpTx.confirm?.receipt?.blockNumber || 0,
    totalConfirmations: gmpTx.confirm?.event?.returnValues?.confirmations || 0,
    axelarscanUrl: `https://axelarscan.io/gmp/${txHash}`,
  };
}

/**
 * Poll the Circle Iris attestation API until an attestation is issued.
 *
 * This is the "burn proof" that unlocks the CCTP mint on Solana.
 *
 * @param {string} messageHash - The keccak256 hash of the CCTP burn message
 * @param {Object} [opts]
 * @param {number} [opts.maxAttempts=180]   - Stop after this many attempts (default: 15 min at 5s)
 * @param {number} [opts.intervalMs=5000]   - Polling interval in milliseconds
 * @param {Function} [opts.onProgress]      - Called on each poll with { attempt, maxAttempts }
 * @returns {Promise<string>} The hex-encoded attestation signature
 */
export async function pollCCTPAttestation(messageHash, { maxAttempts = 180, intervalMs = 5000, onProgress } = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (onProgress) onProgress({ attempt, maxAttempts });

    const res = await fetch(`${CIRCLE_IRIS_API}/${messageHash}`);

    if (res.ok) {
      const data = await res.json();
      if (data?.status === 'complete' && data?.attestation) {
        return data.attestation;
      }
    }

    // Wait before next poll
    await new Promise(r => setTimeout(r, intervalMs));
  }

  throw new Error('CCTP attestation timed out. The Solana mint path may be temporarily unavailable — fallback will be triggered.');
}

/**
 * Get a Squid Router cross-chain swap route for converting any source token → USDC
 * on an EVM chain, prior to the CCTP burn step.
 *
 * Axelar's Gas Service is requested via the route for automatic fee coverage.
 *
 * @param {Object} params
 * @param {string} params.fromChainId       - EVM chain ID (e.g. '1' for Ethereum)
 * @param {string} params.fromTokenAddress  - Source token contract address
 * @param {string} params.fromAmount        - Amount in base units (string)
 * @param {string} params.toChainId         - EVM chain ID of the CCTP burn chain
 * @param {string} params.evmRecipientAddr  - EVM address that will receive USDC before burn
 * @param {string} params.squidIntegratorId - Your Squid integrator ID
 * @returns {Promise<Object>} Squid route object (contains tx calldata)
 */
export async function getSquidSwapRoute({
  fromChainId,
  fromTokenAddress,
  fromAmount,
  toChainId,
  evmRecipientAddr,
  squidIntegratorId,
}) {
  const headers = { 'Content-Type': 'application/json' };
  if (squidIntegratorId) headers['x-integrator-id'] = squidIntegratorId;

  const res = await fetch(SQUID_API, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      fromChain: fromChainId,
      fromToken: fromTokenAddress,
      fromAmount,
      toChain: toChainId,
      toToken: EVM_USDC_ADDRESSES[toChainId] || EVM_USDC_ADDRESSES.ethereum,
      toAddress: evmRecipientAddr,
      enableCCTP: true,
      // Ask Squid/Axelar Gas Service to handle relayer fees automatically
      prefer: ['gas_included'],
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error || `Squid API error: ${res.status}`);
  }

  return res.json();
}

// ── Bridge Status State Machine ───────────────────────────────────────────────

/**
 * All possible states in the bridge lifecycle.
 * The UI uses this to render the correct step + progress indicator.
 */
export const BRIDGE_STATES = {
  IDLE:              'idle',              // No bridge in progress
  AWAITING_DEPOSIT:  'awaiting_deposit',  // Deposit address shown, waiting for user to send
  CONFIRMING:        'confirming',        // Deposit seen on-chain, accumulating confirmations
  SWAPPING:          'swapping',          // Axelar/Squid converting asset → USDC
  BURNING:           'burning',           // CCTP depositForBurn tx submitted
  ATTESTING:         'attesting',         // Polling Circle Iris for attestation
  MINTING:           'minting',           // Submitting receiveMessage on Solana
  SUCCESS:           'success',           // Canonical USDC delivered to user's Solana wallet
  FALLBACK_DELIVERY: 'fallback_delivery', // axlUSDC interim delivery while fallback resolves
  FALLBACK_ROUTING:  'fallback_routing',  // Routing axlUSDC → Ethereum → CCTP → Solana
  ERROR:             'error',             // Unrecoverable error
};

/**
 * Human-readable labels for each bridge state (shown in the UI progress tracker).
 */
export const BRIDGE_STATE_LABELS = {
  [BRIDGE_STATES.IDLE]:              'Ready',
  [BRIDGE_STATES.AWAITING_DEPOSIT]:  'Awaiting Deposit',
  [BRIDGE_STATES.CONFIRMING]:        'Confirming on Source Chain',
  [BRIDGE_STATES.SWAPPING]:          'Swapping to USDC',
  [BRIDGE_STATES.BURNING]:           'Initiating CCTP Burn',
  [BRIDGE_STATES.ATTESTING]:         'Waiting for Circle Attestation',
  [BRIDGE_STATES.MINTING]:           'Minting on Solana',
  [BRIDGE_STATES.SUCCESS]:           'Delivered ✓',
  [BRIDGE_STATES.FALLBACK_DELIVERY]: 'axlUSDC Delivered (Interim)',
  [BRIDGE_STATES.FALLBACK_ROUTING]:  'Fallback: Routing via Ethereum',
  [BRIDGE_STATES.ERROR]:             'Error',
};

/**
 * Ordered list of progress steps for the "Happy Path" display.
 */
export const HAPPY_PATH_STEPS = [
  BRIDGE_STATES.AWAITING_DEPOSIT,
  BRIDGE_STATES.CONFIRMING,
  BRIDGE_STATES.SWAPPING,
  BRIDGE_STATES.BURNING,
  BRIDGE_STATES.ATTESTING,
  BRIDGE_STATES.MINTING,
  BRIDGE_STATES.SUCCESS,
];

/**
 * Important user-facing notification messages keyed by state.
 * These are shown as contextual banners in the bridge UI.
 */
export const BRIDGE_NOTIFICATIONS = {
  [BRIDGE_STATES.ATTESTING]: {
    type: 'info',
    message: 'Circle CCTP attestation takes 13–20 minutes on Ethereum mainnet due to finality requirements. Your funds are safe — please do not close this window.',
  },
  [BRIDGE_STATES.FALLBACK_DELIVERY]: {
    type: 'warning',
    message: 'Solana CCTP minting encountered an issue. You have been delivered axlUSDC as a temporary interim. Click "Resolve via Ethereum" to convert to canonical USDC — this may take an additional 15–30 minutes.',
  },
  [BRIDGE_STATES.FALLBACK_ROUTING]: {
    type: 'info',
    message: 'Fallback route triggered — routing your axlUSDC via Ethereum to obtain canonical Circle USDC. Estimated additional time: 15–30 minutes.',
  },
  [BRIDGE_STATES.AWAITING_DEPOSIT]: {
    type: 'info',
    message: 'This deposit address expires in 24 hours. Send only the selected asset to this address. For Bitcoin, expect around 3 confirmations (~30-45 minutes) to clear on-chain.',
  },
};
