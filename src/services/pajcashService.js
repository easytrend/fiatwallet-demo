/**
 * pajcashService.js - Frontend integration layer for PajCash API
 * Communicates with https://api.paj.cash
 */

const API_URL = import.meta.env.VITE_PAJCASH_API_URL || 'https://api.paj.cash';

/**
 * Helper to generate authorization headers
 */
function getHeaders(apiKey) {
  const headers = {
    'Content-Type': 'application/json',
  };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  return headers;
}

/**
 * Fetch all supported tokens from the PajCash gateway
 * @returns {Promise<Array>}
 */
export async function getSupportedTokens() {
  const res = await fetch(`${API_URL}/token`);
  if (!res.ok) {
    throw new Error(`Failed to fetch supported tokens: ${res.statusText}`);
  }
  return res.json();
}

/**
 * Fetch metadata for a specific token
 * @param {string} addressOrSymbol - token mint address or symbol
 * @param {string} chain - uppercase chain ID (e.g. SOLANA, MONAD)
 * @returns {Promise<Object>}
 */
export async function getTokenMetadata(addressOrSymbol, chain = 'SOLANA') {
  if (!addressOrSymbol) {
    throw new Error('Token address or symbol is required');
  }
  const res = await fetch(`${API_URL}/token/${addressOrSymbol}?chain=${chain.toUpperCase()}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch token metadata: ${res.statusText}`);
  }
  return res.json();
}

/**
 * Initiate a fiat payout/withdrawal to a destination bank account
 * @param {string} businessId - PajCash Business ID
 * @param {string} apiKey - PajCash API Key
 * @param {string} destination - bank details (e.g. "GTBank - 0123456789 - John Doe")
 * @param {number} amount - withdrawal amount (fiat or stablecoin units)
 * @returns {Promise<Object>}
 */
export async function initiateWithdrawal(businessId, apiKey, destination, amount) {
  if (!businessId || !apiKey) {
    throw new Error('PajCash Business ID and API Key are required for withdrawals');
  }
  if (!destination || !amount || amount <= 0) {
    throw new Error('Invalid destination bank details or amount');
  }

  const res = await fetch(`${API_URL}/business/${businessId}/withdraw`, {
    method: 'POST',
    headers: getHeaders(apiKey),
    body: JSON.stringify({
      destination,
      amount: Number(amount)
    })
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => null);
    throw new Error(errData?.message || `Withdrawal failed: ${res.statusText}`);
  }

  return res.json();
}

/**
 * Fetch recent payout transactions for a business
 * @param {string} businessId - PajCash Business ID
 * @param {string} apiKey - PajCash API Key
 * @returns {Promise<Array>}
 */
export async function getTransactionHistory(businessId, apiKey) {
  if (!businessId || !apiKey) {
    throw new Error('PajCash Business ID and API Key are required to fetch transactions');
  }

  const res = await fetch(`${API_URL}/transaction/business/${businessId}`, {
    method: 'GET',
    headers: getHeaders(apiKey)
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch transaction history: ${res.statusText}`);
  }

  return res.json();
}

/**
 * Fetch supported banks list from PajCash API
 * @param {string} apiKey - PajCash API Key
 * @returns {Promise<Array>}
 */
export async function getBanks(apiKey) {
  if (!apiKey) {
    throw new Error('PajCash API Key is required to fetch banks');
  }

  const res = await fetch(`${API_URL}/bank`, {
    method: 'GET',
    headers: getHeaders(apiKey)
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch banks: ${res.statusText}`);
  }

  return res.json();
}

/**
 * Resolve a bank account number to its registered name using PajCash API
 * @param {string} apiKey - PajCash API Key
 * @param {string} bankId - Bank identifier (ID, code, or name)
 * @param {string} accountNumber - 10-digit account number
 * @returns {Promise<Object>}
 */
export async function resolveBankAccount(apiKey, bankId, accountNumber) {
  if (!apiKey) {
    throw new Error('PajCash API Key is required to resolve bank accounts');
  }
  if (!bankId || !accountNumber) {
    throw new Error('Bank ID and account number are required');
  }

  // Use the public bank account confirm endpoint
  const res = await fetch(`${API_URL}/pub/bank-account/confirm/?bankId=${encodeURIComponent(bankId)}&accountNumber=${encodeURIComponent(accountNumber)}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    }
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => null);
    throw new Error(errData?.message || `Failed to resolve bank account name: ${res.statusText}`);
  }

  return res.json();
}

