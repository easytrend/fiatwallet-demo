import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  
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
      
    } else {
      
    }
  } catch (err) {
    
  }
}
