/**
 * useSwapQuote.js — Reactive hook for fetching and auto-refreshing swap quotes.
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { getQuote } from '../services/swapService';

const REFRESH_INTERVAL_MS = 15_000; // Auto-refresh every 15 seconds

/**
 * @param {Object} params
 * @param {string|null} params.inputMint
 * @param {string|null} params.outputMint
 * @param {number} params.amountBaseUnits  — amount in smallest units (lamports, etc.)
 * @param {number} params.slippageBps
 */
export function useSwapQuote({ inputMint, outputMint, amountBaseUnits, slippageBps }) {
  const [quote, setQuote]       = useState(null);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState(null);
  const [countdown, setCountdown] = useState(REFRESH_INTERVAL_MS / 1000);

  const abortRef      = useRef(null);
  const intervalRef   = useRef(null);
  const countdownRef  = useRef(null);

  const canFetch = inputMint && outputMint && amountBaseUnits > 0 && inputMint !== outputMint;

  const fetchQuote = useCallback(async () => {
    if (!canFetch) {
      setQuote(null);
      setError(null);
      setLoading(false);
      return;
    }

    // Cancel any in-flight request
    if (abortRef.current) abortRef.current.abort();
    abortRef.current = new AbortController();

    setLoading(true);
    setError(null);
    setCountdown(REFRESH_INTERVAL_MS / 1000);

    try {
      const q = await getQuote({ inputMint, outputMint, amount: amountBaseUnits, slippageBps });
      setQuote(q);
      setError(null);
    } catch (err) {
      if (err.name !== 'AbortError') {
        setError(err.message || 'Failed to fetch quote');
        setQuote(null);
      }
    } finally {
      setLoading(false);
    }
  }, [inputMint, outputMint, amountBaseUnits, slippageBps, canFetch]);

  // Fetch on parameter change (debounced 600ms)
  useEffect(() => {
    setQuote(null);
    setError(null);
    if (!canFetch) return;

    const debounce = setTimeout(() => {
      fetchQuote();
    }, 600);

    return () => clearTimeout(debounce);
  }, [fetchQuote, canFetch]);

  // Auto-refresh every 15 seconds
  useEffect(() => {
    if (!canFetch) return;

    intervalRef.current = setInterval(() => {
      fetchQuote();
    }, REFRESH_INTERVAL_MS);

    return () => clearInterval(intervalRef.current);
  }, [fetchQuote, canFetch]);

  // Countdown timer
  useEffect(() => {
    if (!canFetch || loading) return;

    countdownRef.current = setInterval(() => {
      setCountdown(prev => (prev <= 1 ? REFRESH_INTERVAL_MS / 1000 : prev - 1));
    }, 1000);

    return () => clearInterval(countdownRef.current);
  }, [canFetch, loading]);

  return { quote, loading, error, countdown, refresh: fetchQuote };
}
