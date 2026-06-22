/**
 * pajcashService.js
 *
 * Wallet-only integration with the PajCash (paj_ramp) API.
 *
 * Authentication: Uses the merchant BUSINESS_API_KEY directly via
 * `x-api-key` header — no email/OTP session required.
 * Transaction retention is handled via the connected Solana wallet address.
 *
 * Follows the paj_ramp SDK API surface:
 *   https://github.com/paj-cash/paj_ramp
 */

import { initializeSDK, getAllRate as getSdkAllRate, Environment } from 'paj_ramp';

// Base URL resolved from env var; defaults to production
let BASE_URL = 'https://api.paj.cash';

/**
 * Initialize the SDK environment and set the base URL.
 * @param {string} envString - 'production' | 'staging' | 'local'
 */
export function initPajSDK(envString = 'production') {
  const clean = (envString || '').toLowerCase();
  if (clean.includes('staging') || clean.includes('dev')) {
    BASE_URL = 'https://api-staging.paj.cash';
    initializeSDK(Environment.Staging);
  } else if (clean.includes('local')) {
    BASE_URL = 'http://localhost:3000';
    initializeSDK(Environment.Local);
  } else {
    BASE_URL = 'https://api.paj.cash';
    initializeSDK(Environment.Production);
  }
}

/**
 * Internal helper: make an authenticated API request using the merchant API key.
 * Sends both `x-api-key` and `Authorization: Bearer` headers to maximise
 * compatibility across all paj.cash API endpoints.
 */
async function apiRequest(method, path, apiKey, body = null) {
  const url = `${BASE_URL}${path}`;

  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'Authorization': `Bearer ${apiKey}`,
  };

  const options = { method, headers };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(url, options);
  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const msg = data?.message || data?.error || res.statusText || `HTTP ${res.status}`;
    throw new Error(msg);
  }

  return data;
}

/**
 * Fetch supported token list (public endpoint — no auth required).
 */
export async function getSupportedTokens() {
  const res = await fetch(`${BASE_URL}/token`);
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    throw new Error(err?.message || `Failed to fetch tokens: ${res.status}`);
  }
  return res.json();
}

/**
 * Fetch available banks.
 * @param {string} apiKey - Merchant Business API Key
 */
export async function getBanks(apiKey) {
  return apiRequest('GET', '/pub/bank', apiKey);
}

/**
 * Resolve a bank account number to its registered account name.
 * @param {string} apiKey        - Merchant Business API Key
 * @param {string} bankId        - Bank ID from getBanks()
 * @param {string} accountNumber - Account number to resolve
 */
export async function resolveBankAccount(apiKey, bankId, accountNumber) {
  return apiRequest(
    'GET',
    `/pub/bank-account/confirm/?bankId=${encodeURIComponent(bankId)}&accountNumber=${encodeURIComponent(accountNumber)}`,
    apiKey
  );
}

/**
 * Create an off-ramp order.
 * Returns: { id, address, mint, currency, amount, fiatAmount, rate, fee }
 *
 * @param {Object} order
 * @param {string} order.bank          - Bank ID from getBanks()
 * @param {string} order.accountNumber - Beneficiary account number
 * @param {string} order.currency      - Currency code e.g. 'NGN'
 * @param {number} [order.amount]      - Token amount to sell
 * @param {number} [order.fiatAmount]  - Fiat amount to receive (alternative to amount)
 * @param {string} order.mint          - Token mint address on Solana
 * @param {string} order.chain         - Chain identifier e.g. 'SOLANA'
 * @param {string} [order.webhookURL]  - Optional webhook URL for status callbacks
 * @param {number} [order.fee]         - Optional business USDC fee
 * @param {string} apiKey              - Merchant Business API Key
 */
export async function createOfframpOrder(order, apiKey) {
  const { fee, ...rest } = order;
  const body = { ...rest };
  if (fee !== undefined) body.businessUSDCFee = fee;
  return apiRequest('POST', '/pub/offramp', apiKey, body);
}

/**
 * Fetch live exchange rates (public — no auth required).
 * Uses the paj_ramp SDK internally.
 */
export async function getAllRate() {
  return getSdkAllRate();
}

/**
 * Fetch all transactions for the merchant account.
 * @param {string} apiKey - Merchant Business API Key
 */
export async function getTransactionHistory(apiKey) {
  return apiRequest('GET', '/pub/transaction', apiKey);
}
