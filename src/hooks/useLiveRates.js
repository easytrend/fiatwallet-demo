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
