-- =============================================================================
-- Fiatwallet Supabase schema — P2P transaction history
-- Run this in the Supabase SQL Editor (Dashboard → SQL → New query)
-- =============================================================================

-- 1. Core transactions table (send, swap, bulk_send, claims, p2p_offramp)
CREATE TABLE IF NOT EXISTS public.transactions (
  id            bigserial PRIMARY KEY,
  signature     text UNIQUE NOT NULL,
  user_address  text NOT NULL,
  transaction_type text NOT NULL,
  token_symbol  text NOT NULL DEFAULT 'SOL',
  usd_value     numeric(18, 2) NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_transactions_user_address ON public.transactions (user_address);
CREATE INDEX IF NOT EXISTS idx_transactions_type ON public.transactions (transaction_type);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON public.transactions (created_at DESC);

-- 2. P2P off-ramp history (live tracking from P2P card)
CREATE TABLE IF NOT EXISTS public.p2p_transactions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  signature        text UNIQUE NOT NULL,
  user_address     text NOT NULL,
  order_id         text NOT NULL,
  transaction_type text NOT NULL DEFAULT 'p2p_offramp',
  token_symbol     text NOT NULL,
  crypto_amount    numeric(18, 8) NOT NULL DEFAULT 0,
  fiat_currency    text NOT NULL,
  fiat_amount      numeric(18, 2) NOT NULL DEFAULT 0,
  usd_value        numeric(18, 2) NOT NULL DEFAULT 0,
  bank_name        text,
  account_number   text,
  account_name     text,
  status           text NOT NULL DEFAULT 'INIT',
  user_email       text,
  deposit_address  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_p2p_transactions_order_id ON public.p2p_transactions (order_id);
CREATE INDEX IF NOT EXISTS idx_p2p_transactions_user_address ON public.p2p_transactions (user_address);
CREATE INDEX IF NOT EXISTS idx_p2p_transactions_status ON public.p2p_transactions (status);
CREATE INDEX IF NOT EXISTS idx_p2p_transactions_created_at ON public.p2p_transactions (created_at DESC);

-- 3. Auto-update updated_at on row changes
CREATE OR REPLACE FUNCTION public.set_p2p_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_p2p_transactions_updated_at ON public.p2p_transactions;
CREATE TRIGGER trg_p2p_transactions_updated_at
  BEFORE UPDATE ON public.p2p_transactions
  FOR EACH ROW EXECUTE FUNCTION public.set_p2p_updated_at();

-- 4. Row Level Security — allow anon key inserts/updates from the app
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.p2p_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow anon insert transactions" ON public.transactions;
CREATE POLICY "Allow anon insert transactions"
  ON public.transactions FOR INSERT TO anon WITH CHECK (true);

DROP POLICY IF EXISTS "Allow anon upsert transactions" ON public.transactions;
CREATE POLICY "Allow anon upsert transactions"
  ON public.transactions FOR UPDATE TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow anon select transactions" ON public.transactions;
CREATE POLICY "Allow anon select transactions"
  ON public.transactions FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "Allow anon insert p2p_transactions" ON public.p2p_transactions;
CREATE POLICY "Allow anon insert p2p_transactions"
  ON public.p2p_transactions FOR INSERT TO anon WITH CHECK (true);

DROP POLICY IF EXISTS "Allow anon update p2p_transactions" ON public.p2p_transactions;
CREATE POLICY "Allow anon update p2p_transactions"
  ON public.p2p_transactions FOR UPDATE TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow anon select p2p_transactions" ON public.p2p_transactions;
CREATE POLICY "Allow anon select p2p_transactions"
  ON public.p2p_transactions FOR SELECT TO anon USING (true);

-- 5. Dashboard view — all live P2P history (newest first)
CREATE OR REPLACE VIEW public.p2p_transaction_history AS
SELECT
  id,
  signature,
  user_address,
  order_id,
  token_symbol,
  crypto_amount,
  fiat_currency,
  fiat_amount,
  usd_value,
  bank_name,
  account_number,
  account_name,
  status,
  user_email,
  deposit_address,
  created_at,
  updated_at,
  CASE status
    WHEN 'COMPLETED' THEN 'Completed'
    WHEN 'PAID'      THEN 'Settling'
    WHEN 'INIT'      THEN 'Pending'
    ELSE status
  END AS status_label
FROM public.p2p_transactions
ORDER BY created_at DESC;

-- 6. Useful queries for the Supabase Table Editor / SQL Editor

-- All P2P transactions (live dashboard)
-- SELECT * FROM public.p2p_transaction_history;

-- Today's P2P volume by currency
-- SELECT fiat_currency, COUNT(*) AS tx_count, SUM(fiat_amount) AS total_fiat, SUM(usd_value) AS total_usd
-- FROM public.p2p_transactions
-- WHERE created_at >= date_trunc('day', now())
-- GROUP BY fiat_currency
-- ORDER BY total_usd DESC;

-- Pending / settling orders
-- SELECT order_id, user_address, fiat_currency, fiat_amount, token_symbol, crypto_amount, status, created_at
-- FROM public.p2p_transactions
-- WHERE status IN ('INIT', 'PAID', 'PENDING')
-- ORDER BY created_at DESC;

-- Combined app activity (send + swap + P2P)
-- SELECT signature, user_address, transaction_type, token_symbol, usd_value, created_at
-- FROM public.transactions
-- ORDER BY created_at DESC
-- LIMIT 100;

-- 7. Grant schema privileges for anon/authenticated/service_role roles to prevent "permission denied" on upsert
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.transactions TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.p2p_transactions TO anon, authenticated, service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO postgres;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO postgres;

