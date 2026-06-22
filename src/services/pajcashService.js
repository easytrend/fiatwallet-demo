/**
 * pajcashService.js - Frontend integration layer wrapping PajCash SDK (paj_ramp)
 */

import {
  initializeSDK,
  initiate,
  verify,
  getBanks as getSdkBanks,
  resolveBankAccount as resolveSdkBankAccount,
  createOfframpOrder as createSdkOfframpOrder,
  getAllRate as getSdkAllRate,
  getAllTransactions as getSdkAllTransactions,
  Environment
} from 'paj_ramp';

let API_URL = import.meta.env.VITE_PAJCASH_API_URL || 'https://api.paj.cash';

/**
 * Initialize PajCash SDK environment
 * @param {string} envString - 'production' | 'staging' | 'local'
 */
export function initPajSDK(envString = 'production') {
  let env = Environment.Production;
  const clean = envString.toLowerCase();
  if (clean.includes('staging') || clean.includes('dev')) {
    env = Environment.Staging;
    API_URL = 'https://api-staging.paj.cash';
  } else if (clean.includes('local')) {
    env = Environment.Local;
    API_URL = 'http://localhost:3000';
  } else {
    API_URL = import.meta.env.VITE_PAJCASH_API_URL || 'https://api.paj.cash';
  }
  initializeSDK(env);
}

/**
 * Fetch all supported tokens from the public endpoint
 */
export async function getSupportedTokens() {
  const res = await fetch(`${API_URL}/token`);
  if (!res.ok) {
    const errData = await res.json().catch(() => null);
    throw new Error(errData?.message || `Failed to fetch supported tokens: ${res.statusText || res.status}`);
  }
  return res.json();
}

/**
 * Initiate an OTP session for email/phone
 */
export async function initiateSession(emailOrPhone, apiKey) {
  return initiate(emailOrPhone, apiKey);
}

/**
 * Verify OTP code to obtain a session token
 */
export async function verifySession(emailOrPhone, otp, apiKey) {
  const deviceInfo = {
    uuid: 'fiatwallet-session-' + Date.now() + Math.random().toString(36).slice(2, 6),
    device: 'Desktop',
    os: 'WebOS',
    browser: 'dApp-Browser'
  };
  return verify(emailOrPhone, otp, deviceInfo, apiKey);
}

/**
 * Fetch supported banks list
 */
export async function getBanks(sessionToken) {
  return getSdkBanks(sessionToken);
}

/**
 * Resolve a bank account number to its registered name
 */
export async function resolveBankAccount(sessionToken, bankId, accountNumber) {
  return resolveSdkBankAccount(sessionToken, bankId, accountNumber);
}

/**
 * Create a direct off-ramp order
 */
export async function createOfframpOrder(options, sessionToken) {
  return createSdkOfframpOrder(options, sessionToken);
}

/**
 * Fetch conversion rates
 */
export async function getAllRate() {
  return getSdkAllRate();
}

/**
 * Fetch payout logs using the active session token or merchant API key
 */
export async function getTransactionHistory(sessionTokenOrApiKey, businessId) {
  if (businessId) {
    const res = await fetch(`${API_URL}/transaction/business/${businessId}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${sessionTokenOrApiKey}`
      }
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => null);
      throw new Error(errData?.message || `Failed to fetch transactions: ${res.statusText || res.status}`);
    }
    return res.json();
  }
  return getSdkAllTransactions(sessionTokenOrApiKey);
}

/**
 * Fetch list of businesses associated with the API Key/Account
 */
export async function getBusinesses(apiKey) {
  if (!apiKey) {
    throw new Error('PajCash API Key is required to fetch businesses');
  }
  const res = await fetch(`${API_URL}/business`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    }
  });
  if (!res.ok) {
    const errData = await res.json().catch(() => null);
    throw new Error(errData?.message || `Failed to fetch businesses: ${res.statusText || res.status}`);
  }
  return res.json();
}
