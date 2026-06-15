import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// SECURITY NOTE: This client uses the public anon key.
// The 'transactions' table MUST have Row Level Security (RLS) enabled with policies
// that restrict INSERT to authenticated sessions only, and SELECT/UPDATE/DELETE
// to the owning user. Never disable RLS on this table.
// See: https://supabase.com/docs/guides/auth/row-level-security
if (!supabaseUrl || !supabaseAnonKey) {
  console.warn('Supabase credentials missing in environment variables. Analytics logging disabled.');
}

export const supabase = (supabaseUrl && supabaseAnonKey)
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null;

/**
 * One-way SHA-256 hash of a string value.
 * Used to anonymise wallet addresses before storing — the hash is useful
 * for analytics aggregation but cannot be reversed to the original address.
 *
 * @param {string} value - Raw string to hash
 * @returns {Promise<string>} Hex-encoded SHA-256 digest
 */
async function sha256Hex(value) {
  const encoded = new TextEncoder().encode(value);
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Log an anonymised transaction record to Supabase.
 *
 * SECURITY CONTRACT:
 *   - Raw wallet addresses are NEVER written to the database.
 *     userAddress is SHA-256 hashed before storage to prevent wallet profiling,
 *     targeted phishing, and data-breach exposure.
 *   - Only the first 16 characters of the signature are stored (sufficient for
 *     debug traceability; not enough to unambiguously correlate to the on-chain tx
 *     without additional context).
 *   - usdValue is rounded to 2 decimal places to prevent floating-point fingerprinting.
 *   - No mint addresses, recipient addresses, or raw amounts are logged.
 *
 * @param {Object} params
 * @param {string} params.signature   - Transaction signature (only prefix stored)
 * @param {string} params.userAddress - Sender's wallet address (hashed before storage)
 * @param {string} params.type        - Transaction type: 'send' | 'swap' | 'bulk_send'
 * @param {string} params.symbol      - Token symbol (e.g. 'SOL', 'USDC')
 * @param {number} params.usdValue    - USD value of the transaction
 */
export async function logTransaction({ signature, userAddress, type, symbol, usdValue }) {
  if (!supabase) {
    console.warn('Supabase client not initialized. Skipping transaction log.');
    return;
  }

  try {
    // Hash the wallet address — never store raw public keys
    const userAddressHash = await sha256Hex(userAddress);

    // Truncate signature to first 16 chars for debug traceability only
    const signaturePrefix = typeof signature === 'string' ? signature.slice(0, 16) : '';

    // Round USD value to 2dp to avoid floating-point fingerprinting
    const roundedUsdValue = Math.round((parseFloat(usdValue) || 0) * 100) / 100;

    const { error } = await supabase
      .from('transactions')
      .insert([
        {
          signature_prefix:    signaturePrefix,  // NOT the full signature
          user_address_hash:   userAddressHash,  // SHA-256 hash, NOT raw address
          transaction_type:    type,
          token_symbol:        symbol,
          usd_value:           roundedUsdValue,
        }
      ]);

    if (error) {
      console.warn('Supabase logTransaction error:', error.message);
    }
  } catch (err) {
    // Logging failures must never surface to the user or disrupt the app
    console.warn('logTransaction: non-fatal logging failure:', err?.message ?? err);
  }
}
