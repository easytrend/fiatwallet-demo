import { useState, useEffect } from 'react';
import { COINGECKO_IDS } from '../data/tokens';

const FIAT_APIS = [
  { url:"https://open.er-api.com/v6/latest/USD",           parse: j => j.rates },
  { url:"https://api.exchangerate-api.com/v4/latest/USD",  parse: j => j.rates },
  { url:"https://api.frankfurter.app/latest?from=USD",     parse: j => j.rates },
];

async function fetchLiveRates() {
  const result = { fiat:{}, crypto:{}, updatedAt:null, fiatSource:"static" };

  for (const api of FIAT_APIS) {
    try {
      const r = await fetch(api.url);
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      const rates = api.parse(j);
      if (!rates || typeof rates !== "object") throw new Error("Bad response");
      result.fiat = { USD:1, ...rates };
      result.fiatSource = api.url.split("/")[2];
      console.log("✅ Fiat rates loaded from", result.fiatSource, "| NGN =", rates.NGN);
      break;
    } catch(e) { console.warn("Fiat API failed (" + api.url + "):", e.message); }
  }

  try {
    const ids = Object.values(COINGECKO_IDS).join(",");
    const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`);
    const j = await r.json();
    Object.entries(COINGECKO_IDS).forEach(([sym, id]) => {
      if (j[id]?.usd) result.crypto[sym] = j[id].usd;
    });
    console.log("✅ Crypto prices loaded | SOL=$" + result.crypto.SOL);
  } catch(e) { console.warn("CoinGecko failed:", e.message); }

  // Fallback 1: Coinbase
  if (!result.crypto.SOL) {
    try {
      const r = await fetch("https://api.coinbase.com/v2/prices/SOL-USD/spot");
      const j = await r.json();
      const solPrice = parseFloat(j?.data?.amount);
      if (solPrice > 0) {
        result.crypto.SOL = solPrice;
        console.log("✅ Crypto prices loaded (Coinbase fallback) | SOL=$" + solPrice);
      }
    } catch (e) {
      console.warn("Coinbase price fallback failed:", e.message);
    }
  }

  // Fallback 2: Binance
  if (!result.crypto.SOL) {
    try {
      const r = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT");
      const j = await r.json();
      const solPrice = parseFloat(j?.price);
      if (solPrice > 0) {
        result.crypto.SOL = solPrice;
        console.log("✅ Crypto prices loaded (Binance fallback) | SOL=$" + solPrice);
      }
    } catch (e) {
      console.warn("Binance price fallback failed:", e.message);
    }
  }

  // Fallback 3: Jupiter Price API
  if (!result.crypto.SOL) {
    try {
      const r = await fetch("https://api.jup.ag/price/v2?ids=So11111111111111111111111111111111111111112");
      const j = await r.json();
      const solPrice = parseFloat(j?.data?.["So11111111111111111111111111111111111111112"]?.price);
      if (solPrice > 0) {
        result.crypto.SOL = solPrice;
        console.log("✅ Crypto prices loaded (Jupiter fallback) | SOL=$" + solPrice);
      }
    } catch (e) {
      console.warn("Jupiter price fallback failed:", e.message);
    }
  }

  result.updatedAt = new Date().toLocaleTimeString();
  return result;
}

export function useLiveRates() {
  const [liveRates, setLiveRates] = useState({ fiat:{}, crypto:{}, updatedAt:null });
  const [ratesLoading, setRatesLoading] = useState(true);

  useEffect(() => {
    async function load() {
      setRatesLoading(true);
      const r = await fetchLiveRates();
      setLiveRates(r);
      setRatesLoading(false);
    }
    load();
    const id = setInterval(load, 60000);
    return () => clearInterval(id);
  }, []);

  return { liveRates, ratesLoading };
}
