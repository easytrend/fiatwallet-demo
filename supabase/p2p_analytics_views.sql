-- =============================================================================
-- P2P Analytics Views for fiatwallet Supabase
-- Run this in the Supabase SQL Editor after the main p2p_transactions table
-- has been created.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- VIEW 1: Transaction Detail
-- Columns: user_address, transaction_type, token, token_quantity, usd_value, timestamp
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW p2p_transaction_detail AS
SELECT
  user_address,
  'OFFRAMP'                                     AS transaction_type,
  token_symbol                                  AS token,
  crypto_amount                                 AS token_quantity,
  usd_value,
  created_at                                    AS "timestamp"
FROM p2p_transactions
ORDER BY created_at DESC;


-- ─────────────────────────────────────────────────────────────────────────────
-- VIEW 2: User Totals
-- Columns: user_address, total_transactions, total_usd_value
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW p2p_user_totals AS
SELECT
  user_address,
  COUNT(*)              AS total_transactions,
  SUM(usd_value)        AS total_usd_value
FROM p2p_transactions
GROUP BY user_address
ORDER BY total_usd_value DESC;


-- ─────────────────────────────────────────────────────────────────────────────
-- VIEW 3: Time-Series Volume (Daily / Weekly / Monthly)
-- ─────────────────────────────────────────────────────────────────────────────

-- Daily
CREATE OR REPLACE VIEW p2p_daily_volume AS
SELECT
  DATE_TRUNC('day', created_at)   AS period_start,
  COUNT(DISTINCT user_address)    AS user_count,
  SUM(usd_value)                  AS usd_volume
FROM p2p_transactions
GROUP BY DATE_TRUNC('day', created_at)
ORDER BY period_start DESC;

-- Weekly
CREATE OR REPLACE VIEW p2p_weekly_volume AS
SELECT
  DATE_TRUNC('week', created_at)  AS period_start,
  COUNT(DISTINCT user_address)    AS user_count,
  SUM(usd_value)                  AS usd_volume
FROM p2p_transactions
GROUP BY DATE_TRUNC('week', created_at)
ORDER BY period_start DESC;

-- Monthly
CREATE OR REPLACE VIEW p2p_monthly_volume AS
SELECT
  DATE_TRUNC('month', created_at) AS period_start,
  COUNT(DISTINCT user_address)    AS user_count,
  SUM(usd_value)                  AS usd_volume
FROM p2p_transactions
GROUP BY DATE_TRUNC('month', created_at)
ORDER BY period_start DESC;


-- =============================================================================
-- SAMPLE QUERIES — run in Supabase SQL Editor to verify
-- =============================================================================

-- All transactions (detail view)
-- SELECT * FROM p2p_transaction_detail LIMIT 50;

-- Per-user totals
-- SELECT * FROM p2p_user_totals LIMIT 20;

-- Daily stats
-- SELECT * FROM p2p_daily_volume;

-- Weekly stats
-- SELECT * FROM p2p_weekly_volume;

-- Monthly stats
-- SELECT * FROM p2p_monthly_volume;
