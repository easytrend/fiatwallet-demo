import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn("Supabase credentials missing in environment variables. Analytics logging disabled.");
}

export const supabase = (supabaseUrl && supabaseAnonKey) 
  ? createClient(supabaseUrl, supabaseAnonKey) 
  : null;

/**
 * Log a transaction to Supabase.
 * @param {Object} params
 * @param {string} params.signature - Transaction signature/hash
 * @param {string} params.userAddress - Wallet address of the sender
 * @param {string} params.type - Transaction type ('send', 'swap', 'bulk_send')
 * @param {string} params.symbol - Token symbol (e.g., SOL, USDC)
 * @param {number} params.usdValue - Computed USD value of the transaction
 */
export async function logTransaction({ signature, userAddress, type, symbol, usdValue }) {
  if (!supabase) {
    console.warn("Supabase client not initialized. Skipping transaction log.");
    return;
  }

  try {
    const { error } = await supabase
      .from('transactions')
      .insert([
        {
          signature,
          user_address: userAddress,
          transaction_type: type,
          token_symbol: symbol,
          usd_value: parseFloat(usdValue) || 0
        }
      ]);

    if (error) {
      console.error("Supabase logTransaction error:", error.message);
    } else {
      console.log(`Successfully logged transaction (${type}) to Supabase:`, signature);
    }
  } catch (err) {
    console.error("Failed to execute logTransaction:", err);
  }
}
