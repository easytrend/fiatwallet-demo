/**
 * Supabase service integration has been fully revoked and disabled.
 * All functions are no-ops to prevent import breakage across the application.
 */

export const supabase = null;

export async function logTransaction() {
  // No-op: Supabase is disabled
}

export async function logP2PTransaction() {
  // No-op: Supabase is disabled
}

export async function syncP2PTransactionStatuses() {
  // No-op: Supabase is disabled
}
