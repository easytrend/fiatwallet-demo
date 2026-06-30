import { useState, useEffect, useRef, useMemo } from 'react';
import jsQR from 'jsqr';
import { createWorker } from 'tesseract.js';
import {
  initPajSDK,
  getSupportedTokens,
  getBanks,
  resolveBankAccount,
  createOfframpOrder,
  createOnrampOrder,
  getOnrampValue,
  observeOrder,
  getAllRate,
  getTransactionHistory,
  initiateSession,
  verifySession,
} from '../services/pajcashService';
import { logP2PTransaction, syncP2PTransactionStatuses } from '../services/supabase';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { PublicKey, Transaction, TransactionInstruction, SystemProgram, Keypair } from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COUNTRIES = [
  { code: 'NGA', name: 'Nigeria', flag: '🇳🇬', symbol: '₦', currency: 'NGN' },
  { code: 'GHA', name: 'Ghana', flag: '🇬🇭', symbol: '₵', currency: 'GHS' },
  { code: 'KEN', name: 'Kenya', flag: '🇰🇪', symbol: 'Sh', currency: 'KES' },
  { code: 'ZAF', name: 'South Africa', flag: '🇿🇦', symbol: 'R', currency: 'ZAR' },
  { code: 'USA', name: 'United States', flag: '🇺🇸', symbol: '$', currency: 'USD' },
  { code: 'GBR', name: 'United Kingdom', flag: '🇬🇧', symbol: '£', currency: 'USD' },
  { code: 'EUR', name: 'Europe', flag: '🇪🇺', symbol: '€', currency: 'USD' },
  { code: 'CAN', name: 'Canada', flag: '🇨🇦', symbol: '$', currency: 'USD' },
  { code: 'AUS', name: 'Australia', flag: '🇦🇺', symbol: '$', currency: 'USD' },
  { code: 'IND', name: 'India', flag: '🇮🇳', symbol: '₹', currency: 'USD' },
  { code: 'BRA', name: 'Brazil', flag: '🇧🇷', symbol: 'R$', currency: 'USD' },
  { code: 'JPN', name: 'Japan', flag: '🇯🇵', symbol: '¥', currency: 'USD' },
];

// Countries supported live by the paj_ramp API
const LIVE_CURRENCIES = new Set(['NGN', 'GHS', 'KES', 'ZAR']);

const DEFAULT_TOKENS = [
  {
    symbol: 'USDC',
    name: 'USD Coin',
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png',
    decimals: 6,
    balance: 0,
  },
  {
    symbol: 'USDT',
    name: 'Tether USD',
    mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB/logo.png',
    decimals: 6,
    balance: 0,
  },
  {
    symbol: 'SOL',
    name: 'Solana',
    mint: 'So11111111111111111111111111111111111111112',
    logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png',
    decimals: 9,
    balance: 0,
  },
];

const ALLOWED_PROGRAM_IDS = new Set([
  '11111111111111111111111111111111',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
]);

const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');


// PajCash API status values: COMPLETED | PAID | INIT
// COMPLETED = bank payout sent/settled
// PAID      = crypto received, fiat payout in progress
// INIT      = order created, waiting for crypto
const isConfirmed = (status) =>
  status === 'COMPLETED' || status === 'SUCCESSFUL' || status === 'CONFIRMED'; // guard legacy value too

const isSettling = (status) => status === 'PAID';

const getRelativeTime = (isoString) => {
  if (!isoString) return 'Recent';
  const now = Date.now();
  const date = new Date(isoString).getTime();
  const diff = now - date;

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
  if (hours < 24) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
  if (days === 1) return 'yesterday';
  return `${days} day${days > 1 ? 's' : ''} ago`;
};

const getCleanNameForLog = (log) => {
  if (!log) return 'Pending Confirmation…';
  let name = '';
  if (log.accountName && typeof log.accountName === 'string') {
    name = log.accountName;
  } else if (log.name && typeof log.name === 'string') {
    name = log.name;
  } else if (log.recipient && typeof log.recipient === 'string') {
    const isSol = log.recipient.length >= 32 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(log.recipient);
    if (!isSol) {
      name = log.recipient;
    }
  }
  const clean = name.trim();
  // Prefer resolved account name, then bank name, then account number, then generic label
  if (clean) return clean;
  if (log.bank) return log.bank;
  if (log.accountNumber || log.account_number || log.account) return `Acct ${log.accountNumber || log.account_number || log.account}`;
  return 'Payout';
};

const formatTransactionDate = (dateStr) => {
  if (!dateStr) return 'Recent';
  try {
    const date = new Date(dateStr);
    const day = date.getDate();
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const month = months[date.getMonth()];
    const year = date.getFullYear();
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${day} ${month} ${year} · ${hours}:${minutes}`;
  } catch (e) {
    return 'Recent';
  }
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const getBankMetadata = (bankName) => {
  const clean = bankName.toLowerCase();
  let logo = '';

  if (clean.includes('opay')) {
    logo = 'https://play-lh.googleusercontent.com/PFMB9Xeg8vVhnvuiu_jY9ZGXNq6HIuEdz4xlyIOcbdVRccgHa9o8LOJKTyzDUtbL9BphaXvOEhieOQOpW0lgMQ=w240-h240';
  } else if (clean.includes('palm')) {
    logo = 'https://play-lh.googleusercontent.com/pT-RdPoKxq_JRizBJsS99SgrtF9qeQ4Oq3gyhl4TSmK6w7GI_7x2OC9pQOSGo52b1yWBOugQv4w27QDA8mhzZg=w240-h240';
  } else if (clean.includes('kuda')) {
    logo = 'https://play-lh.googleusercontent.com/VfzEWy41G5L17_m23EYdsipfzjel_XizWwoHPFb4Armz5tkhQwW9-W9EWi3PJnWVp4H5aOjDgd-FtB5cTNKmIvs=w240-h240';
  } else if (clean.includes('moniepoint')) {
    logo = 'https://play-lh.googleusercontent.com/vd1kyHDKAvbjA4zqUXr6UIVX4bzXQPpNQrwJh_FmJPm2qWJJl0FP45Ad7cGUgyDOc-3Cdme1TwO21wzspL_80A=w240-h240';
  } else {
    const slug = clean
      .replace('guaranty trust bank', 'guaranty_trust_bank')
      .replace('gtbank', 'guaranty_trust_bank')
      .replace('first bank of nigeria', 'first_bank')
      .replace('firstbank', 'first_bank')
      .replace('united bank for africa', 'united_bank_for_africa')
      .replace('uba', 'united_bank_for_africa')
      .replace('stanbic ibtc', 'stanbic_ibtc')
      .replace('zenith bank', 'zenith_bank')
      .replace('access bank', 'access_bank')
      .replace(/\s+/g, '_')
      .replace(/[^a-z0-9_]/g, '');
    logo = `https://raw.githubusercontent.com/PaystackHQ/nigerialogos/master/public/logos/${slug}/${slug}.svg`;
  }

  const initials = bankName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  let hash = 0;
  for (let i = 0; i < bankName.length; i++) hash = bankName.charCodeAt(i) + ((hash << 5) - hash);
  const color = `hsl(${Math.abs(hash % 360)}, 65%, 40%)`;
  return { name: bankName, logo, color, initial: initials || 'BK' };
};

/**
 * Verify the constructed transaction is safe to sign:
 * - Only uses allowed programs
 * - Transfers to the expected deposit address
 * - Correct token mint and amount
 */
function verifyOfframpTransaction(transaction, expectedRecipient, expectedToken, expectedSignerPublicKey, relayerPublicKey = null) {
  if (!transaction.instructions || transaction.instructions.length === 0)
    throw new Error('Transaction integrity violation: no instructions.');

  // Allow either user or relayer as fee payer
  const validFeePayer = transaction.feePayer && (
    transaction.feePayer.equals(expectedSignerPublicKey) ||
    (relayerPublicKey && transaction.feePayer.equals(relayerPublicKey))
  );
  if (!validFeePayer)
    throw new Error('Transaction integrity violation: fee payer mismatch.');

  let hasTransfer = false;

  for (const ix of transaction.instructions) {
    const progId = ix.programId.toBase58();

    if (!ALLOWED_PROGRAM_IDS.has(progId))
      throw new Error(`Transaction integrity violation: disallowed program ${progId}.`);

    if (progId === '11111111111111111111111111111111') {
      // SOL transfer — System Program instruction type 2
      const view = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength);
      if (view.getUint32(0, true) !== 2)
        throw new Error('Transaction integrity violation: unexpected System Program instruction.');
      const to = ix.keys[1].pubkey.toBase58();
      if (to !== expectedRecipient)
        throw new Error(`Transaction integrity violation: SOL transfer to wrong address ${to}.`);
      if (expectedToken.symbol !== 'SOL')
        throw new Error('Transaction integrity violation: transferring SOL instead of selected token.');
      hasTransfer = true;
    } else if (
      progId === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' ||
      progId === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
    ) {
      if (ix.data[0] !== 12)
        throw new Error(`Transaction integrity violation: disallowed token opcode ${ix.data[0]}.`);
      const mint = ix.keys[1].pubkey.toBase58();
      if (mint !== expectedToken.mint)
        throw new Error(`Transaction integrity violation: token mint mismatch. Expected ${expectedToken.mint}, got ${mint}.`);
      hasTransfer = true;
    }
  }

  if (!hasTransfer)
    throw new Error('Transaction integrity violation: no valid transfer instruction found.');
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function P2PPanel({ connected, walletTokenList }) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction, signTransaction } = useWallet();

  // ── Env config ──────────────────────────────────────────────────────────
  const PAJCASH_API_KEY = import.meta.env.VITE_PAJCASH_API_KEY;
  const isPajcashLive = !!PAJCASH_API_KEY;

  // ── Session State ────────────────────────────────────────────────────────
  const [sessionToken, setSessionToken] = useState('');
  const [sessionEmail, setSessionEmail] = useState('');
  const [authStep, setAuthStep] = useState('input_email'); // 'input_email' | 'input_otp' | 'logged_in'
  const [emailInput, setEmailInput] = useState('');
  const [otpInput, setOtpInput] = useState('');
  const [authError, setAuthError] = useState(null);
  const [authLoading, setAuthLoading] = useState(false);

  // ── Form State ───────────────────────────────────────────────────────────
  const [mode, setMode] = useState('sell'); // 'sell' | 'buy'
  const [selectedCountry, setSelectedCountry] = useState(COUNTRIES[0]); // Nigeria default
  const [selectedBank, setSelectedBank] = useState('Choose Bank');
  const [accountNumber, setAccountNumber] = useState('');
  const [accountName, setAccountName] = useState('');
  const [amount, setAmount] = useState('');
  const [selectedToken, setSelectedToken] = useState(DEFAULT_TOKENS[0]);

  // ── Data State ───────────────────────────────────────────────────────────
  const [pajTokens, setPajTokens] = useState([]);
  const [apiBanks, setApiBanks] = useState([]);
  const [pajRates, setPajRates] = useState(null);
  const [payoutLogs, setPayoutLogs] = useState([]);

  // ── Loading / Error State ────────────────────────────────────────────────
  const [loadingBanks, setLoadingBanks] = useState(false);
  const [loadingRates, setLoadingRates] = useState(false);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [resolvingName, setResolvingName] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [apiError, setApiError] = useState(null);
  const [logError, setLogError] = useState(null);
  const [p2pError, setP2pError] = useState(null);

  // ── UI State ─────────────────────────────────────────────────────────────
  const [countryOpen, setCountryOpen] = useState(false);
  const [bankOpen, setBankOpen] = useState(false);
  const [tokenOpen, setTokenOpen] = useState(false);
  const [bankSearch, setBankSearch] = useState('');
  const [countrySearch, setCountrySearch] = useState('');
  const [routingState, setRoutingState] = useState('idle'); // 'routing' | 'loading_market' | 'resolved'
  const [showSuccess, setShowSuccess] = useState(false);
  const [successDetails, setSuccessDetails] = useState(null);
  const [showHistoryView, setShowHistoryView] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedLog, setSelectedLog] = useState(null); // log detail pop-up
  const [copiedAccount, setCopiedAccount] = useState(false);
  const [showAmountTooltip, setShowAmountTooltip] = useState(false);
  const [relayerActive, setRelayerActive] = useState(false);

  // ── Onramp (Buy) State ───────────────────────────────────────────────────
  const [onrampAmount, setOnrampAmount] = useState(''); // NGN amount user wants to send
  const [onrampOrder, setOnrampOrder] = useState(null); // PajCash order response with bank details
  const [onrampLoading, setOnrampLoading] = useState(false);
  const [onrampError, setOnrampError] = useState(null);
  const [onrampStatus, setOnrampStatus] = useState(null); // 'pending'|'processing'|'completed'|'failed'
  const onrampSocketRef = useRef(null);
  const [copiedOnrampAcct, setCopiedOnrampAcct] = useState(false);

  // ── QR Scanner Refs ──────────────────────────────────────────────────────
  const [scannerActive, setScannerActive] = useState(false);
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);

  // ── Computed ─────────────────────────────────────────────────────────────
  const isLiveRoute = LIVE_CURRENCIES.has(selectedCountry.currency) && mode === 'sell';
  const canTransact = !!sessionToken && isLiveRoute && !apiError;

  // Show all transactions from the API (already scoped to authenticated user).
  // Supplement with localStorage-only entries that haven't appeared in the API yet.
  const displayLogs = useMemo(() => {
    if (!publicKey) return [];
    const walletKey = publicKey.toBase58();
    const localOrders = (() => {
      try { return JSON.parse(localStorage.getItem(`paj_user_orders_${walletKey}`) || '[]'); }
      catch { return []; }
    })();

    // Helper: detect cancelled status
    const isCancelled = (status) => {
      if (!status) return false;
      const s = status.toUpperCase();
      return s === 'CANCELLED' || s === 'CANCELED' || s === 'CANCEL';
    };

    const parseDestination = (dest) => {
      if (!dest || typeof dest !== 'string') return null;

      // Find any sequence of 5 to 20 digits representing the account number
      const acctMatch = dest.match(/\b\d{5,20}\b/);
      if (acctMatch) {
        const account = acctMatch[0];
        const acctIndex = dest.indexOf(account);

        // Bank name is everything before the account number
        let bank = dest.substring(0, acctIndex).trim();
        // Remove trailing dashes, bullets, or spaces from bank name
        bank = bank.replace(/[-•–—\s]+$/, '').trim();

        // Recipient name is everything after the account number
        let name = dest.substring(acctIndex + account.length).trim();
        // Remove leading dashes, bullets, or spaces from recipient name
        name = name.replace(/^[-•–—\s]+/, '').trim();

        return { bank: bank || null, account, name: name || null };
      }

      // Fallback: split by hyphens/bullets with optional spaces
      const parts = dest.split(/\s*[-•–—]\s*/).map(p => p.trim());
      if (parts.length >= 3) {
        return {
          bank: parts[0],
          account: parts[1],
          name: parts.slice(2).join(' - ')
        };
      }

      // Last resort: if the whole string is a digit sequence, treat it as account number
      if (/^\d{5,20}$/.test(dest.trim())) {
        return { bank: null, account: dest.trim(), name: null };
      }

      return null;
    };

    const getLocalMeta = (apiLog) => {
      const apiId = apiLog.id || apiLog._id;
      return localOrders.find(entry => {
        const localId = entry.id || (typeof entry === 'string' ? entry : null);
        return (apiId && localId && String(apiId) === String(localId)) || 
               (apiLog.sig && entry.sig && apiLog.sig === entry.sig) ||
               // Match by order id in reference fields
               (apiLog.reference && entry.id && String(apiLog.reference) === String(entry.id));
      });
    };

    // If the API returned transactions, use them as the primary source, but merge local metadata and parse destination fallbacks
    if (payoutLogs.length > 0) {
      const merged = payoutLogs
        .filter(apiLog => !isCancelled(apiLog.status)) // hide cancelled
        .map(apiLog => {
          const localMatch = getLocalMeta(apiLog);
          const destString = apiLog.destination || apiLog.recipient;
          const parsedDest = parseDestination(destString);

          const bankVal = apiLog.bank || apiLog.bankName || apiLog.bank_name ||
            (parsedDest ? parsedDest.bank : null) ||
            (localMatch ? localMatch.bank : null);
          const accountVal = apiLog.accountNumber || apiLog.account_number || apiLog.account ||
            (parsedDest ? parsedDest.account : null) ||
            (localMatch ? localMatch.account : null);
          const nameVal = apiLog.accountName || apiLog.account_name || apiLog.name ||
            (parsedDest ? parsedDest.name : null) ||
            (localMatch ? localMatch.name : null);
          // Merge on-chain signature from localStorage if the API didn't return it
          const sigVal = apiLog.sig || apiLog.signature || (localMatch ? localMatch.sig : null);

          return {
            ...apiLog,
            bank: bankVal,
            accountNumber: accountVal,
            accountName: nameVal,
            name: nameVal,
            sig: sigVal,
          };
        });

      // Sort newest-first
      return merged.sort((a, b) => {
        const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return tb - ta;
      });
    }

    // API returned nothing yet — fall back to localStorage placeholders, excluding cancelled
    return localOrders
      .filter(entry => !isCancelled(entry.status))
      .map(entry => ({
        id: entry.id || entry,
        status: 'INIT',
        createdAt: entry.ts ? new Date(entry.ts).toISOString() : null,
        amount: null,
        recipient: entry.name || null,
        bank: entry.bank || null,
        accountNumber: entry.account || null,
        accountName: entry.name || null,
        name: entry.name || null,
        sig: entry.sig,
        mint: null,
      }));
  }, [payoutLogs, publicKey]);

  const itemsPerPage = 10;
  const totalPages = Math.ceil(displayLogs.length / itemsPerPage);
  const paginatedLogs = useMemo(() => {
    return displayLogs.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);
  }, [displayLogs, currentPage]);

  const getTokenLogo = (mintOrSymbol) => {
    if (!mintOrSymbol) return '';
    const tokenObj = selectableTokens.find(t =>
      t.mint === mintOrSymbol ||
      t.symbol === mintOrSymbol
    );
    return tokenObj ? tokenObj.logoURI : '';
  };

  // ── SDK Init ─────────────────────────────────────────────────────────────
  useEffect(() => {
    initPajSDK(import.meta.env.VITE_PAJCASH_ENV || 'production');
  }, []);

  // ── API Key verification warning ──
  useEffect(() => {
    if (isLiveRoute && !PAJCASH_API_KEY) {
      setApiError('VITE_PAJCASH_API_KEY is not configured. Please add VITE_PAJCASH_API_KEY to your .env file to enable live settlements.');
    } else {
      setApiError(null);
    }
  }, [isLiveRoute, PAJCASH_API_KEY]);

  // ── Restore bank and session details from localStorage on wallet connect ──
  useEffect(() => {
    // Always clear history when wallet changes so a newly connected wallet
    // never sees transactions from the previously connected wallet.
    setPayoutLogs([]);

    if (publicKey) {
      const key = publicKey.toBase58();
      
      // Restore session
      const cachedToken = localStorage.getItem(`paj_sessionToken_${key}`);
      const cachedEmail = localStorage.getItem(`paj_sessionEmail_${key}`);
      const cachedExpiry = localStorage.getItem(`paj_sessionExpiry_${key}`);
      if (cachedToken && cachedExpiry && Date.now() < Number(cachedExpiry)) {
        setSessionToken(cachedToken);
        setSessionEmail(cachedEmail || '');
        setAuthStep('logged_in');
      } else {
        // Clear expired session
        localStorage.removeItem(`paj_sessionToken_${key}`);
        localStorage.removeItem(`paj_sessionEmail_${key}`);
        localStorage.removeItem(`paj_sessionExpiry_${key}`);
        setSessionToken('');
        setSessionEmail('');
        setAuthStep('input_email');
      }

    } else {
      setSelectedBank('Choose Bank');
      setAccountNumber('');
      setAccountName('');
      setSessionToken('');
      setSessionEmail('');
      setAuthStep('input_email');
    }
  }, [publicKey]);

  // ── Load supported tokens ─────────────────────────────────────────────────
  useEffect(() => {
    if (!isPajcashLive) return;
    getSupportedTokens()
      .then(list => {
        if (list?.length > 0) {
          setPajTokens(
            list
              .filter(t => !t.chain || t.chain.toUpperCase() === 'SOLANA')
              .map(t => ({
                symbol: t.symbol,
                name: t.name,
                mint: t.address || t.mint,
                logoURI: t.logo || '',
                decimals: t.decimals || 6,
                balance: 0,
              }))
          );
        }
      })
      .catch(e => console.warn('Could not load PajCash tokens:', e));
  }, [isPajcashLive]);

  // ── Load banks ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isLiveRoute || !PAJCASH_API_KEY) return;

    setLoadingBanks(true);
    setApiError(null);
    getBanks(PAJCASH_API_KEY)
      .then(list => {
        if (list?.length > 0) setApiBanks(list);
        else setApiError('PajCash returned an empty bank list. Please try again later.');
      })
      .catch(e => {
        console.error('Failed to fetch banks:', e);
        setApiError(`PajCash API error: ${e.message || 'Connection failed'}.`);
      })
      .finally(() => setLoadingBanks(false));
  }, [isLiveRoute, PAJCASH_API_KEY]);

  // ── Load rates ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isLiveRoute) return;
    let cancelled = false;

    const fetchRates = () => {
      setLoadingRates(true);
      getAllRate()
        .then(r => { if (!cancelled && r) setPajRates(r); })
        .catch(e => console.warn('Could not fetch rates:', e))
        .finally(() => { if (!cancelled) setLoadingRates(false); });
    };

    fetchRates();
    const interval = setInterval(fetchRates, 30_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [isLiveRoute]);

  // ── Load payout history ──────────────────────────────────────────────────
  const loadPayoutLogs = () => {
    if (!sessionToken || !publicKey) return;
    setLoadingLogs(true);
    setLogError(null);
    getTransactionHistory(sessionToken)
      .then(res => {
        // The API might wrap data: res could be [] directly, or { data: [] }, or { transactions: [] }
        let txs = res;
        if (res && !Array.isArray(res)) {
          txs = res.data || res.transactions || res.items || res.result || [];
        }
        if (!Array.isArray(txs)) txs = [];

        // Debug: log raw API data to browser console so we can inspect field names
        console.group('[PajCash] Transaction History API Response');
        console.log('Raw response:', res);
        console.log('Parsed txs array:', txs);
        if (txs.length > 0) {
          console.log('First transaction keys:', Object.keys(txs[0]));
          console.log('First transaction:', txs[0]);
        }
        // Log localStorage orders for this wallet
        const walletKey = publicKey.toBase58();
        const localOrders = (() => {
          try { return JSON.parse(localStorage.getItem(`paj_user_orders_${walletKey}`) || '[]'); }
          catch { return []; }
        })();
        console.log('Local orders in storage:', localOrders);
        console.groupEnd();

        syncP2PTransactionStatuses(txs);
        setPayoutLogs(txs);
      })
      .catch(e => {
        console.warn('Could not load payout history:', e);
        setLogError(e.message || 'Failed to load history.');
        if (e.message?.toLowerCase().includes('session') || e.message?.toLowerCase().includes('expired') || e.message?.toLowerCase().includes('unauthorized') || e.message?.toLowerCase().includes('invalid token')) {
          handleLogoutSession();
        }
      })
      .finally(() => setLoadingLogs(false));
  };

  useEffect(() => { loadPayoutLogs(); }, [sessionToken, publicKey]);

  useEffect(() => {
    if (showHistoryView) {
      loadPayoutLogs();
      setCurrentPage(1);
    }
  }, [showHistoryView]);

  // ── Resolve account name ──────────────────────────────────────────────────
  useEffect(() => {
    if (!accountNumber || selectedBank === 'Choose Bank' || !sessionToken) {
      setAccountName('');
      return;
    }
    const trimmed = accountNumber.trim();
    if (selectedCountry.code === 'NGA' && trimmed.length !== 10) {
      setAccountName('');
      return;
    }
    setResolvingName(true);
    setAccountName('');

    const bankObj = apiBanks.find(b => (b.name || b.bank_name || b) === selectedBank);
    const bankId = bankObj ? (bankObj.id || bankObj.code || bankObj.name) : selectedBank;

    const timer = setTimeout(() => {
      resolveBankAccount(sessionToken, bankId, trimmed)
        .then(res => {
          const name = res?.accountName || res?.name || res?.account_name || '';
          setAccountName(name || 'No Bank Match');
          if (name && publicKey) {
            const key = publicKey.toBase58();
            localStorage.setItem(`paj_bank_id_${key}`, bankId);
            localStorage.setItem(`paj_bank_name_${key}`, selectedBank);
            localStorage.setItem(`paj_account_number_${key}`, trimmed);
            localStorage.setItem(`paj_account_name_${key}`, name);
          }
        })
        .catch((err) => {
          setAccountName('No Bank Match');
          if (err?.message?.toLowerCase().includes('session') || err?.message?.toLowerCase().includes('expired') || err?.message?.toLowerCase().includes('unauthorized') || err?.message?.toLowerCase().includes('invalid token')) {
            handleLogoutSession();
          }
        })
        .finally(() => setResolvingName(false));
    }, 300);

    return () => { clearTimeout(timer); setResolvingName(false); };
  }, [accountNumber, selectedBank, selectedCountry, apiBanks, sessionToken]);

  // ── Reset on country / mode change ───────────────────────────────────────
  useEffect(() => {
    setSelectedBank('Choose Bank');
    setAccountNumber('');
    setAccountName('');
    setAmount('');
    setApiBanks([]);
    if (PAJCASH_API_KEY) {
      setApiError(null);
    }
  }, [selectedCountry, mode]);

  // ── Clear error on input changes ─────────────────────────────────────────
  useEffect(() => {
    setP2pError(null);
  }, [amount, accountNumber, selectedBank, selectedToken, selectedCountry, mode]);

  // ── Auto-dismiss errors and confirmations ──────────────────────────────
  useEffect(() => {
    if (p2pError) {
      const timer = setTimeout(() => setP2pError(null), 10000);
      return () => clearTimeout(timer);
    }
  }, [p2pError]);

  useEffect(() => {
    if (authError) {
      const timer = setTimeout(() => setAuthError(null), 10000);
      return () => clearTimeout(timer);
    }
  }, [authError]);

  // NOTE: Success card is intentionally NOT auto-closed.
  // It stays visible until the user clicks "Done".

  // ── Autofill from previous details ──────────────────────────────────────
  // When user types first 4+ digits of account number, check if it matches
  // a previously saved account number prefix and auto-fill bank selection.
  useEffect(() => {
    if (!publicKey || accountNumber.length < 4) return;
    const key = publicKey.toBase58();
    const savedAcc = localStorage.getItem(`paj_account_number_${key}`);
    const savedBank = localStorage.getItem(`paj_bank_name_${key}`);
    if (
      savedAcc &&
      savedBank &&
      savedAcc.startsWith(accountNumber) &&
      accountNumber.length >= 4 &&
      accountNumber.length < savedAcc.length &&
      selectedBank === 'Choose Bank'
    ) {
      // Auto-fill the full account number and bank
      setAccountNumber(savedAcc);
      setSelectedBank(savedBank);
    }
  }, [accountNumber, publicKey]);

  // ── Routing animation ─────────────────────────────────────────────────────
  useEffect(() => {
    setRoutingState('routing');
    const t1 = setTimeout(() => {
      setRoutingState('loading_market');
      const t2 = setTimeout(() => setRoutingState('resolved'), 800);
      return () => clearTimeout(t2);
    }, 800);
    return () => clearTimeout(t1);
  }, [selectedToken, selectedBank]);

  // ── Session Handlers ──────────────────────────────────────────────────────
  const handleInitiateSession = async () => {
    if (!emailInput) {
      setAuthError('Please enter your email.');
      return;
    }
    if (!PAJCASH_API_KEY) {
      setAuthError('API Key is missing. Please add VITE_PAJCASH_API_KEY to your env configuration.');
      return;
    }
    setAuthLoading(true);
    setAuthError(null);
    try {
      await initiateSession(emailInput.trim(), PAJCASH_API_KEY);
      setAuthStep('input_otp');
    } catch (e) {
      setAuthError(e.message || 'Failed to send OTP. Please check your API key and email.');
    } finally {
      setAuthLoading(false);
    }
  };

  const handleVerifySession = async () => {
    if (!otpInput) {
      setAuthError('Please enter the OTP.');
      return;
    }
    if (!PAJCASH_API_KEY) {
      setAuthError('API Key is missing.');
      return;
    }
    setAuthLoading(true);
    setAuthError(null);
    try {
      const res = await verifySession(emailInput.trim(), otpInput.trim(), PAJCASH_API_KEY);
      if (res?.token) {
        setSessionToken(res.token);
        setSessionEmail(emailInput.trim());
        setAuthStep('logged_in');

        // Save session in localStorage for this wallet
        if (publicKey) {
          const key = publicKey.toBase58();
          localStorage.setItem(`paj_sessionToken_${key}`, res.token);
          localStorage.setItem(`paj_sessionEmail_${key}`, emailInput.trim());
          const expiryTime = Date.now() + 20 * 365 * 24 * 60 * 60 * 1000; // 20 Years
          localStorage.setItem(`paj_sessionExpiry_${key}`, String(expiryTime));
        }
      } else {
        throw new Error('Verify response did not include session token.');
      }
    } catch (e) {
      setAuthError(e.message || 'Invalid OTP code. Please try again.');
    } finally {
      setAuthLoading(false);
    }
  };

  const handleLogoutSession = () => {
    setSessionToken('');
    setSessionEmail('');
    setAuthStep('input_email');
    setEmailInput('');
    setOtpInput('');
    setAuthError(null);

    if (publicKey) {
      const key = publicKey.toBase58();
      localStorage.removeItem(`paj_sessionToken_${key}`);
      localStorage.removeItem(`paj_sessionEmail_${key}`);
      localStorage.removeItem(`paj_sessionExpiry_${key}`);
    }
  };

  // ── Selectable token list ─────────────────────────────────────────────────
  // Always show all DEFAULT_TOKENS (USDC, USDT, SOL). Merge with pajTokens
  // from the API so API metadata takes priority, but defaults are never dropped.
  const selectableTokens = (() => {
    // Start with DEFAULT_TOKENS as the baseline
    const baseTokens = DEFAULT_TOKENS.map(dt => {
      // If the API returned a matching token, prefer its metadata
      const apiToken = pajTokens.find(pt =>
        pt.mint === dt.mint || pt.symbol === dt.symbol
      );
      const merged = apiToken ? { ...dt, ...apiToken } : dt;
      // Attach live wallet balance
      const walletToken = walletTokenList?.find(w =>
        (w.mint && w.mint === merged.mint) || w.symbol === merged.symbol
      );
      return {
        ...merged,
        balance: walletToken ? walletToken.balance : 0,
      };
    });

    // Add any extra API tokens that aren't already in DEFAULT_TOKENS
    const extraApiTokens = pajTokens
      .filter(pt =>
        (!pt.chain || pt.chain.toUpperCase() === 'SOLANA') &&
        !DEFAULT_TOKENS.some(dt => dt.mint === pt.mint || dt.symbol === pt.symbol)
      )
      .map(pt => {
        const walletToken = walletTokenList?.find(w =>
          (w.mint && w.mint === pt.mint) || w.symbol === pt.symbol
        );
        return { ...pt, balance: walletToken ? walletToken.balance : 0 };
      });

    return [...baseTokens, ...extraApiTokens];
  })();

  const liveSelectedToken = useMemo(() => {
    const found = selectableTokens.find(t => t.mint === selectedToken.mint || t.symbol === selectedToken.symbol);
    return found || selectedToken;
  }, [selectableTokens, selectedToken]);

  useEffect(() => {
    const available = selectableTokens.some(t => t.symbol === selectedToken.symbol || t.mint === selectedToken.mint);
    const isLiveToken = selectedToken.symbol === 'USDC' || selectedToken.symbol === 'USDT';
    // Reset to USDC if the currently selected token is unavailable OR is not a live (USDC/USDT) token
    if ((!available || !isLiveToken) && selectableTokens.length > 0) {
      const usdc = selectableTokens.find(t => t.symbol === 'USDC') || selectableTokens[0];
      setSelectedToken(usdc);
    }
  }, [connected, walletTokenList, pajTokens]);

  // ── Camera Scanner (QR + OCR for 10-digit account numbers) ────────────────
  const [ocrStatus, setOcrStatus] = useState('');
  const ocrWorkerRef = useRef(null);

  // Preprocess canvas to high-contrast greyscale to improve OCR accuracy
  const preprocessCanvasForOCR = (srcCanvas) => {
    const oc = document.createElement('canvas');
    // Crop and scale the centre 60% of the frame — where the number is likely to be
    const cw = Math.floor(srcCanvas.width * 0.6);
    const ch = Math.floor(srcCanvas.height * 0.25);
    const cx = Math.floor((srcCanvas.width - cw) / 2);
    const cy = Math.floor((srcCanvas.height - ch) / 2);
    // Scale up 2x for better OCR accuracy
    oc.width = cw * 2;
    oc.height = ch * 2;
    const oc2 = oc.getContext('2d');
    oc2.drawImage(srcCanvas, cx, cy, cw, ch, 0, 0, oc.width, oc.height);
    // Convert to greyscale + high contrast threshold
    const id = oc2.getImageData(0, 0, oc.width, oc.height);
    for (let i = 0; i < id.data.length; i += 4) {
      const grey = 0.299 * id.data[i] + 0.587 * id.data[i + 1] + 0.114 * id.data[i + 2];
      const val = grey > 128 ? 255 : 0; // hard threshold — black/white only
      id.data[i] = id.data[i + 1] = id.data[i + 2] = val;
      id.data[i + 3] = 255;
    }
    oc2.putImageData(id, 0, 0);
    return oc;
  };

  const stopScanner = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (ocrWorkerRef.current) {
      ocrWorkerRef.current.terminate().catch(() => {});
      ocrWorkerRef.current = null;
    }
    setOcrStatus('');
    setScannerActive(false);
  };

  useEffect(() => {
    if (!scannerActive) return;
    let active = true;
    let raf;
    let ocrBusy = false;
    let frameCount = 0;

    const initCamera = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }
        });
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.setAttribute('playsinline', 'true');
          await videoRef.current.play();
        }

        setOcrStatus('Loading OCR engine...');
        const worker = await createWorker('eng', 1, { logger: () => {} });
        await worker.setParameters({
          tessedit_char_whitelist: '0123456789',
          tessedit_pageseg_mode: '7',  // single text line
          tessedit_ocr_engine_mode: '1', // LSTM only — faster
        });
        ocrWorkerRef.current = worker;
        setOcrStatus('Align the 10-digit number in the box');
        raf = requestAnimationFrame(tick);
      } catch {
        setP2pError('Camera access denied. Please grant permission and retry.');
        setScannerActive(false);
      }
    };

    const tick = () => {
      if (!active) return;
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (video && canvas && video.readyState === video.HAVE_ENOUGH_DATA) {
        const ctx = canvas.getContext('2d');
        canvas.height = video.videoHeight;
        canvas.width = video.videoWidth;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);

        // ① QR / barcode check (every frame — very fast)
        const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
        if (code?.data) {
          const m = code.data.replace(/\D/g, '').match(/\d{10}/);
          if (m) { setAccountNumber(m[0]); setBankOpen(true); stopScanner(); return; }
        }

        // ② Native BarcodeDetector API (supported on Android Chrome / Safari)
        if (frameCount % 10 === 0 && 'BarcodeDetector' in window) {
          // fire-and-forget — doesn't block the animation loop
          const bitmapCanvas = document.createElement('canvas');
          bitmapCanvas.width = canvas.width;
          bitmapCanvas.height = canvas.height;
          bitmapCanvas.getContext('2d').drawImage(canvas, 0, 0);
          createImageBitmap(bitmapCanvas).then(bmp => {
            const bd = new window.BarcodeDetector({ formats: ['qr_code', 'code_128', 'code_39', 'ean_13'] });
            return bd.detect(bmp);
          }).then(results => {
            for (const r of results) {
              const m = r.rawValue.replace(/\D/g, '').match(/\d{10}/);
              if (m && active) { setAccountNumber(m[0]); setBankOpen(true); stopScanner(); return; }
            }
          }).catch(() => {});
        }

        // ③ Tesseract OCR on preprocessed crop — every 20 frames (~0.67s)
        frameCount++;
        if (frameCount % 20 === 0 && !ocrBusy && ocrWorkerRef.current) {
          ocrBusy = true;
          const processedCanvas = preprocessCanvasForOCR(canvas);
          processedCanvas.toBlob(async (blob) => {
            try {
              if (!active || !ocrWorkerRef.current) return;
              const { data: { text } } = await ocrWorkerRef.current.recognize(blob);
              const digits = text.replace(/[^0-9]/g, '');
              const m = digits.match(/\d{10}/);
              if (m && active) {
                setAccountNumber(m[0]);
                setBankOpen(true); // auto-open bank dropdown after scan
                stopScanner();
              }
            } catch { /* ignore */ }
            finally { ocrBusy = false; }
          }, 'image/png');
        }
      }
      raf = requestAnimationFrame(tick);
    };

    initCamera();
    return () => {
      active = false;
      cancelAnimationFrame(raf);
      if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; }
      if (ocrWorkerRef.current) { ocrWorkerRef.current.terminate().catch(() => {}); ocrWorkerRef.current = null; }
    };
  }, [scannerActive]);

  // ── Clipboard paste ───────────────────────────────────────────────────────
  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      const cleaned = text.trim().replace(/\D/g, '');
      if (cleaned.length >= 8) {
        setAccountNumber(cleaned.slice(0, 10));
        setBankOpen(true); // auto-open bank dropdown for quick selection
      } else {
        setP2pError('Clipboard does not contain a valid account number (minimum 8 digits).');
      }
    } catch {
      setP2pError('Clipboard access denied. Please paste directly into the account number field.');
    }
  };

  // ── Derived values ────────────────────────────────────────────────────────
  const tokenPriceUsd = liveSelectedToken.price || (liveSelectedToken.symbol === 'SOL' ? 145.20 : 1.00);
  const activeNgnRate = pajRates?.offRampRate?.rate || pajRates?.rate || 1550;
  const onrampNgnRate = pajRates?.onRampRate?.rate || pajRates?.rate || 1500;
  const ngnRate = tokenPriceUsd * activeNgnRate;
  const parsedAmt = parseFloat(amount) || 0;
  const estCryptoAmount = ngnRate > 0 ? (parsedAmt / ngnRate) : 0;
  const FEE_PERCENT = 0.01;
  const platformFee = estCryptoAmount * FEE_PERCENT;
  const fiatAmountText = parsedAmt.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const parsedOnrampAmt = parseFloat(onrampAmount) || 0;
  const estOnrampCrypto = onrampNgnRate > 0 ? (parsedOnrampAmt / onrampNgnRate) : 0;
  const onrampFee = estOnrampCrypto * FEE_PERCENT;

  const allBankNames = useMemo(() => {
    return apiBanks.map(b => (typeof b === 'string' ? b : b.name || b.bank_name || ''));
  }, [apiBanks]);

  const filteredBanksList = useMemo(() => {
    const query = bankSearch.toLowerCase().trim();
    if (!query) return allBankNames;
    const matches = allBankNames.filter(b => b.toLowerCase().includes(query));
    return matches.sort((a, b) => {
      const aLower = a.toLowerCase();
      const bLower = b.toLowerCase();

      const aExact = aLower === query;
      const bExact = bLower === query;
      if (aExact && !bExact) return -1;
      if (!aExact && bExact) return 1;

      const aStarts = aLower.startsWith(query);
      const bStarts = bLower.startsWith(query);
      if (aStarts && !bStarts) return -1;
      if (!aStarts && bStarts) return 1;

      return aLower.localeCompare(bLower);
    });
  }, [allBankNames, bankSearch]);

  // Nigeria is the only live country; all others show "Coming Soon"
  const LIVE_COUNTRY_CODES = new Set(['NGA']);

  const filteredCountries = COUNTRIES.filter(c =>
    c.name.toLowerCase().includes(countrySearch.toLowerCase()) ||
    c.code.toLowerCase().includes(countrySearch.toLowerCase())
  );
  const displayBank = selectedBank === 'Choose Bank' ? (allBankNames[0] || 'Choose Bank') : selectedBank;

  const isFormValid =
    !!sessionToken &&
    isLiveRoute &&
    !apiError &&
    parsedAmt > 0 &&
    !!accountNumber &&
    accountNumber.trim().length >= 8 &&
    selectedBank !== 'Choose Bank' &&
    !!accountName &&
    accountName !== 'No Bank Match' &&
    !resolvingName;

  const handleIncrement = () => {
    const current = parseFloat(amount) || 0;
    setAmount(String(current + 1));
  };

  const handleDecrement = () => {
    const current = parseFloat(amount) || 0;
    if (current > 0) {
      setAmount(String(Math.max(0, current - 1)));
    }
  };

  // ── Onramp (Buy) submit handler ──────────────────────────────────────────
  const handleOnrampSubmit = async () => {
    setOnrampError(null);
    setOnrampOrder(null);
    setOnrampStatus(null);
    if (!sessionToken) { setOnrampError('Please verify your email OTP session first.'); return; }
    if (!publicKey) { setOnrampError('Please connect your Solana wallet.'); return; }
    if (!parsedOnrampAmt || parsedOnrampAmt <= 0) { setOnrampError('Please enter a valid NGN amount.'); return; }
    if (!PAJCASH_API_KEY) { setOnrampError('PajCash API Key is not configured.'); return; }

    setOnrampLoading(true);
    try {
      const order = await createOnrampOrder(
        {
          currency: 'NGN',
          amount: parsedOnrampAmt,
          recipient: publicKey.toBase58(),
          chain: 'SOLANA',
          fee: onrampFee,
          mint: liveSelectedToken.mint,
        },
        sessionToken
      );

      if (!order?.id) throw new Error('PajCash did not return a valid onramp order.');
      setOnrampOrder(order);
      setOnrampStatus('pending');

      // Disconnect previous socket if any
      if (onrampSocketRef.current) {
        try { onrampSocketRef.current.disconnect(); } catch { /* ignore */ }
        onrampSocketRef.current = null;
      }

      // Watch order status via WebSocket
      const observer = observeOrder({
        orderId: order.id,
        onOrderUpdate: (data) => {
          const status = (data?.status || '').toLowerCase();
          setOnrampStatus(status);
        },
        onError: (err) => {
          console.warn('Onramp socket error:', err);
        },
      });
      onrampSocketRef.current = observer;
      observer.connect().catch(() => { /* socket unavailable */ });
    } catch (err) {
      setOnrampError(err.message || 'Failed to create onramp order.');
    } finally {
      setOnrampLoading(false);
    }
  };

  // ── Submit handler (Offramp / Sell) ──────────────────────────────────────
  const handleSubmit = async () => {
    setP2pError(null);
    if (!isLiveRoute) { setP2pError('This region/mode is not currently supported.'); return; }
    if (!PAJCASH_API_KEY) { setP2pError('PajCash API Key is not configured.'); return; }
    if (!sessionToken) { setP2pError('Please verify your email OTP session first.'); return; }
    if (apiError) { setP2pError(`PajCash API error: ${apiError}`); return; }
    if (!connected || !publicKey) { setP2pError('Please connect your Solana wallet first.'); return; }
    if (!amount || parseFloat(amount) <= 0) { setP2pError('Please enter a valid amount.'); return; }
    if (!accountNumber) { setP2pError('Please enter your bank account number.'); return; }
    if (selectedBank === 'Choose Bank') { setP2pError('Please select a bank.'); return; }

    setSubmitting(true);
    try {
      const balance = liveSelectedToken.balance || 0;
      if (estCryptoAmount > balance) {
        throw new Error(`Insufficient ${liveSelectedToken.symbol} balance. You have ${balance.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${liveSelectedToken.symbol} but need ${estCryptoAmount.toFixed(4)} ${liveSelectedToken.symbol}.`);
      }

      const bankObj = apiBanks.find(b => (b.name || b.bank_name || b) === selectedBank);
      const bankId = bankObj ? (bankObj.id || bankObj.code || bankObj.name) : selectedBank;

      // 1. Create paj_ramp off-ramp order
      const order = await createOfframpOrder(
        {
          bank: bankId,
          accountNumber: accountNumber.trim(),
          currency: selectedCountry.currency,
          amount: Number(amount) / ngnRate,
          mint: liveSelectedToken.mint,
          chain: 'SOLANA',
          fee: platformFee,
          webhookURL: import.meta.env.VITE_PAJCASH_WEBHOOK_URL || undefined,
        },
        sessionToken
      );

      if (!order?.address) throw new Error('PajCash did not return a deposit address for this order.');

      // 2. Build on-chain Solana transaction
      const { blockhash } = await connection.getLatestBlockhash('confirmed');
      const transaction = new Transaction();
      transaction.feePayer = publicKey;
      transaction.recentBlockhash = blockhash;

      const depositPubkey = new PublicKey(order.address);

      if (liveSelectedToken.symbol === 'SOL') {
        const lamports = Math.round((order.amount || estCryptoAmount) * 1e9);
        transaction.add(
          SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: depositPubkey, lamports })
        );
      } else {
        const mintPubkey = new PublicKey(liveSelectedToken.mint);
        let tokenProgram = TOKEN_PROGRAM_ID;
        try {
          const mintAcct = await connection.getAccountInfo(mintPubkey);
          if (mintAcct?.owner.equals(TOKEN_2022_PROGRAM_ID)) tokenProgram = TOKEN_2022_PROGRAM_ID;
        } catch { /* use default */ }

        const senderATA = getAssociatedTokenAddressSync(mintPubkey, publicKey, false, tokenProgram);
        const receiverATA = getAssociatedTokenAddressSync(mintPubkey, depositPubkey, false, tokenProgram);

        // Fetch decimals from chain
        const mintInfo = await connection.getParsedAccountInfo(mintPubkey);
        if (!mintInfo.value) throw new Error('Invalid token mint — could not fetch decimals.');
        const decimals = mintInfo.value.data.parsed.info.decimals;
        const sendAmount = order.amount || estCryptoAmount;
        const units = BigInt(Math.round(sendAmount * Math.pow(10, decimals)));

        transaction.add(
          createAssociatedTokenAccountIdempotentInstruction(
            publicKey, receiverATA, depositPubkey, mintPubkey, tokenProgram
          )
        );
        transaction.add(
          createTransferCheckedInstruction(
            senderATA, mintPubkey, receiverATA, publicKey, units, decimals, [], tokenProgram
          )
        );
      }

      // 3. Attach on-chain memo with order ID
      transaction.add(
        new TransactionInstruction({
          keys: [],
          programId: MEMO_PROGRAM_ID,
          data: new TextEncoder().encode(`fiatwallet:pajcash:offramp:${order.id}`),
        })
      );

      // 4. Verify transaction integrity before signing
      // ── Relayer fee sponsorship ───────────────────────────────────────────────────
      let relayerKp = null;
      let usingRelayer = false;

      const relayerSecretEnv = import.meta.env.VITE_RELAYER_SECRET_KEY;
      if (relayerSecretEnv) {
        try {
          const keyArray = JSON.parse(relayerSecretEnv);
          relayerKp = Keypair.fromSecretKey(new Uint8Array(keyArray));
          const relayerLamports = await connection.getBalance(relayerKp.publicKey).catch(() => 0);
          usingRelayer = relayerLamports >= 5000; // need at least ~5000 lamports
        } catch {
          relayerKp = null;
          usingRelayer = false;
        }
      }

      if (usingRelayer && relayerKp && signTransaction) {
        // Relayer pays gas — set relayer as fee payer
        transaction.feePayer = relayerKp.publicKey;
      } else {
        // User pays gas (default)
        transaction.feePayer = publicKey;
      }

      verifyOfframpTransaction(transaction, order.address, liveSelectedToken, publicKey,
        usingRelayer ? relayerKp.publicKey : null);

      // 5. Pre-flight simulation
      const sim = await connection.simulateTransaction(transaction);
      if (sim.value.err) throw new Error(`Simulation failed: ${JSON.stringify(sim.value.err)}`);

      // 6. Sign & send
      let sig;
      if (usingRelayer && relayerKp && signTransaction) {
        // User signs first, then relayer co-signs as fee payer
        const signedTx = await signTransaction(transaction);
        signedTx.partialSign(relayerKp);
        sig = await connection.sendRawTransaction(signedTx.serialize(), {
          skipPreflight: false, preflightCommitment: 'confirmed',
        });
        setRelayerActive(true);
      } else {
        sig = await sendTransaction(transaction, connection);
        setRelayerActive(false);
      }

      // 7. Poll for confirmation
      let confirmed = false;
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const status = await connection.getSignatureStatus(sig).catch(() => null);
        const conf = status?.value?.confirmationStatus;
        if (conf === 'confirmed' || conf === 'finalized') { confirmed = true; break; }
        if (status?.value?.err) throw new Error('Transaction rejected: ' + JSON.stringify(status.value.err));
        await new Promise(r => setTimeout(r, 2000));
      }

      if (!confirmed) {
        setP2pError(`Transaction sent but not yet confirmed. Signature: ${sig}`);
        return;
      }

      // 8. Persist order details in localStorage (keyed by wallet address)
      const walletKey = publicKey.toBase58();
      const existing = (() => {
        try { return JSON.parse(localStorage.getItem(`paj_user_orders_${walletKey}`) || '[]'); }
        catch { return []; }
      })();
      existing.unshift({ 
        id: order.id, 
        sig, 
        ts: Date.now(),
        bank: displayBank,
        account: accountNumber.trim(),
        name: accountName || 'Account Holder'
      });
      localStorage.setItem(`paj_user_orders_${walletKey}`, JSON.stringify(existing.slice(0, 50)));

      const cryptoLogged = order.amount || estCryptoAmount;
      const fiatLogged = Number(amount);
      const usdLogged = selectedCountry.currency === 'USD'
        ? fiatLogged
        : fiatLogged / (ngnRate || 1);

      logP2PTransaction({
        signature: sig,
        userAddress: walletKey,
        orderId: order.id,
        tokenSymbol: liveSelectedToken.symbol,
        cryptoAmount: cryptoLogged,
        fiatCurrency: selectedCountry.currency,
        fiatAmount: fiatLogged,
        usdValue: usdLogged,
        bankName: displayBank,
        accountNumber: accountNumber.trim(),
        accountName: accountName || 'Account Holder',
        status: 'INIT',
        userEmail: sessionEmail || undefined,
        depositAddress: order.address,
      });

      setSuccessDetails({
        amount: `${estCryptoAmount.toFixed(4)} ${liveSelectedToken.symbol}`,
        fiat: `${selectedCountry.symbol}${fiatAmountText}`,
        bank: displayBank,
        account: accountNumber,
        name: accountName || 'Account Holder',
        orderId: order.id,
        sig,
        // status comes from the API — mark as PENDING initially; history refresh will update
        status: 'PENDING',
      });
      setShowSuccess(true);
      // Clear form fields in the UI. Keep bank cache in localStorage so that
      // the user can trigger autofill by typing the first 4 digits of the account number later.
      setAmount('');
      setAccountNumber('');
      setAccountName('');
      setSelectedBank('Choose Bank');
      // Refresh history after 2s to get updated status from API
      setTimeout(loadPayoutLogs, 2000);
    } catch (err) {
      console.error('Transaction failed:', err);
      setP2pError(err.message || 'Transaction failed');
      if (err.message?.toLowerCase().includes('session') || err.message?.toLowerCase().includes('expired') || err.message?.toLowerCase().includes('unauthorized') || err.message?.toLowerCase().includes('invalid token')) {
        handleLogoutSession();
      }
    } finally {
      setSubmitting(false);
    }
  };

  // ── Wallet not connected guard ────────────────────────────────────────────
  if (!connected || !publicKey) {
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        minHeight: '320px', textAlign: 'center', padding: '20px 24px',
        background: 'rgba(255,255,255,0.01)', border: '1.5px dashed rgba(255,255,255,0.1)',
        borderRadius: '16px', margin: '10px 0',
      }}>
        <div style={{ fontSize: '38px', marginBottom: '14px' }}>🔌</div>
        <h4 style={{ fontSize: '15px', fontWeight: 'bold', color: 'white', marginBottom: '10px' }}>
          Connect Your Wallet
        </h4>
        <p style={{ fontSize: '11px', color: 'var(--text3)', maxWidth: '300px', lineHeight: '1.5' }}>
          Connect your Solana wallet to access live off-ramp settlements.
          Your bank details will be saved automatically for future visits.
        </p>
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="p2p-panel-wrap">

      {/* API error banner */}
      {isLiveRoute && apiError && (
        <div style={{
          background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)',
          borderRadius: '12px', padding: '12px 14px', fontSize: '12px', color: '#f87171',
          marginBottom: '1.25rem', lineHeight: '1.5',
        }}>
          ⚠️ <strong>Payout Gateway Offline:</strong> {apiError}
        </div>
      )}

      {/* Title Row with History Icon */}
      <div className="title-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
        <h2 className="card-title" style={{ margin: 0, fontSize: '1.25rem' }}>P2P Trade</h2>
        {canTransact && publicKey && (
          <button 
            onClick={() => setShowHistoryView(true)}
            style={{ background: 'none', border: 'none', color: 'var(--text2)', cursor: 'pointer', padding: '4px' }}
            title="Transaction History"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"></circle>
              <polyline points="12 6 12 12 16 14"></polyline>
            </svg>
          </button>
        )}
      </div>
      <p className="card-sub" style={{ marginBottom: '1.25rem' }}>Peer-to-peer token trading platform.</p>

      {showHistoryView ? (
        <div className="p2p-history-view" style={{ animation: 'fadeIn 0.2s ease-in-out' }}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: '1.25rem', gap: '10px' }}>
            <button 
              onClick={() => setShowHistoryView(false)}
              style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border)', borderRadius: '8px', color: 'white', cursor: 'pointer', padding: '6px 10px', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px' }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
              Back
            </button>
            <h3 style={{ fontSize: '14px', margin: 0, color: 'white' }}>Transaction History</h3>
          </div>
          {loadingLogs ? (
              <div style={{ fontSize: '12px', color: 'var(--text3)', fontStyle: 'italic', textAlign: 'center', padding: '24px' }}>
                <span className="p2p-mini-spinner" /> Loading history...
              </div>
          ) : logError ? (
              <div style={{ fontSize: '11px', color: '#f87171', background: 'rgba(239,68,68,0.08)', padding: '8px 12px', borderRadius: '8px', border: '1px solid rgba(239,68,68,0.2)' }}>
                ⚠️ {logError}
              </div>
          ) : paginatedLogs.length === 0 ? (
              <div style={{ fontSize: '12px', color: 'var(--text3)', textAlign: 'center', padding: '24px' }}>
                No payout history found.
              </div>
          ) : (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', minHeight: '300px' }}>
                {paginatedLogs.map(log => {
                  const tokenLogo = getTokenLogo(log.mint || 'USDC');
                  const bankMeta = log.bank ? getBankMetadata(log.bank) : null;
                  
                  // Get token symbol
                  const tokenSymbol = log.tokenSymbol || (log.mint ? (selectableTokens.find(t => t.mint === log.mint)?.symbol || 'USDC') : 'USDC');
                  
                  // Get crypto amount
                  const cryptoAmt = log.cryptoAmount || log.amount || 0;
                  const formattedCrypto = `${cryptoAmt.toFixed(4)} ${tokenSymbol}`;

                  // Determine display name using shared helper (same logic as receipt)
                  const displayName = getCleanNameForLog(log).toUpperCase();

                  return (
                    <div 
                      key={log._id || log.id}
                      onClick={() => setSelectedLog(log)}
                      style={{
                        background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border)',
                        borderRadius: '12px', padding: '12px', fontSize: '12px',
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        cursor: 'pointer', transition: 'background 0.15s',
                      }}
                      onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.06)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'rgba(255,255,255,0.02)'}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        {/* Overlapping double circular icons */}
                        <div style={{ position: 'relative', width: '38px', height: '38px', flexShrink: 0 }}>
                          {/* Token Logo */}
                          {tokenLogo ? (
                            <img 
                              src={tokenLogo} 
                              alt="token" 
                              style={{ 
                                position: 'absolute', top: 0, left: 0, 
                                width: '26px', height: '26px', borderRadius: '50%', 
                                zIndex: 1, border: '2px solid rgba(18, 18, 18, 1)' 
                              }} 
                              onError={(e) => { e.target.style.display = 'none'; e.target.nextElementSibling.style.display = 'flex'; }}
                            />
                          ) : null}
                          <div 
                            style={{ 
                              position: 'absolute', top: 0, left: 0, 
                              width: '26px', height: '26px', borderRadius: '50%', 
                              background: 'rgba(255,255,255,0.1)', color: 'white', 
                              display: tokenLogo ? 'none' : 'flex', alignItems: 'center', justifyContent: 'center', 
                              fontSize: '9px', fontWeight: 'bold', zIndex: 1, 
                              border: '2px solid rgba(18, 18, 18, 1)' 
                            }}
                          >
                            {tokenSymbol.slice(0, 3)}
                          </div>

                          {/* Bank Logo */}
                          {bankMeta && bankMeta.logo ? (
                            <img 
                              src={bankMeta.logo} 
                              alt="bank" 
                              style={{ 
                                position: 'absolute', bottom: 0, right: 0, 
                                width: '20px', height: '20px', borderRadius: '50%', 
                                zIndex: 2, border: '2px solid rgba(18, 18, 18, 1)',
                                objectFit: 'cover'
                              }} 
                              onError={(e) => { e.target.style.display = 'none'; e.target.nextElementSibling.style.display = 'flex'; }}
                            />
                          ) : null}
                          <div 
                            style={{ 
                              position: 'absolute', bottom: 0, right: 0, 
                              width: '20px', height: '20px', borderRadius: '50%', 
                              background: bankMeta ? bankMeta.color : 'var(--border)', 
                              color: 'white', display: (bankMeta && bankMeta.logo) ? 'none' : 'flex', alignItems: 'center', 
                              justifyContent: 'center', fontSize: '8px', fontWeight: 'bold', 
                              zIndex: 2, border: '2px solid rgba(18, 18, 18, 1)' 
                            }}
                          >
                            {bankMeta ? bankMeta.initial : 'BK'}
                          </div>
                        </div>

                        {/* Texts */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                          <span 
                            style={{ 
                              color: 'white', fontWeight: 'bold', fontSize: '13px',
                              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                              maxWidth: '160px', display: 'block' 
                            }}
                            title={displayName}
                          >
                            {displayName}
                          </span>
                          <span style={{ color: 'var(--text3)', fontSize: '11px' }}>
                            {log.createdAt ? getRelativeTime(log.createdAt) : 'Recent'}
                          </span>
                        </div>
                      </div>

                      {/* Right Details */}
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '2px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                          <span style={{ color: 'white', fontWeight: 'bold', fontSize: '13px' }}>
                            {formattedCrypto}
                          </span>
                          {log.sig && (
                            <a 
                              href={`https://solscan.io/tx/${log.sig}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              style={{ color: 'var(--text3)', display: 'inline-flex', alignItems: 'center', transition: 'color 0.15s' }}
                              onMouseEnter={e => e.currentTarget.style.color = 'var(--lime)'}
                              onMouseLeave={e => e.currentTarget.style.color = 'var(--text3)'}
                            >
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <line x1="7" y1="17" x2="17" y2="7"></line>
                                <polyline points="7 7 17 7 17 17"></polyline>
                              </svg>
                            </a>
                          )}
                        </div>
                        <span style={{ 
                          color: isConfirmed(log.status) ? 'var(--lime)' : isSettling(log.status) ? '#eab308' : log.status === 'FAILED' ? '#ef4444' : 'rgba(255,255,255,0.4)', 
                          fontSize: '11px', fontWeight: 'bold'
                        }}>
                          {isConfirmed(log.status) ? 'Confirmed' : isSettling(log.status) ? 'Settling…' : log.status === 'FAILED' ? 'Failed' : 'Pending'}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
              
              {/* Pagination Controls — numbered buttons */}
              {totalPages > 1 && (
                <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '6px', marginTop: '16px', paddingTop: '16px', borderTop: '1px solid var(--border)', flexWrap: 'wrap' }}>
                  <button
                    onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                    disabled={currentPage === 1}
                    style={{ background: 'none', border: 'none', color: currentPage === 1 ? 'var(--text3)' : 'white', cursor: currentPage === 1 ? 'not-allowed' : 'pointer', fontSize: '12px', padding: '4px 8px' }}
                  >
                    ‹
                  </button>
                  {Array.from({ length: totalPages }, (_, i) => i + 1)
                    .filter(p => p === 1 || p === totalPages || Math.abs(p - currentPage) <= 2)
                    .reduce((acc, p, idx, arr) => {
                      if (idx > 0 && p - arr[idx - 1] > 1) acc.push('…');
                      acc.push(p);
                      return acc;
                    }, [])
                    .map((p, i) =>
                      p === '…' ? (
                        <span key={`ellipsis-${i}`} style={{ color: 'var(--text3)', fontSize: '12px', padding: '4px 2px' }}>…</span>
                      ) : (
                        <button
                          key={p}
                          onClick={() => setCurrentPage(p)}
                          style={{
                            minWidth: '28px', height: '28px', borderRadius: '6px', fontSize: '12px',
                            background: currentPage === p ? 'var(--lime)' : 'rgba(255,255,255,0.05)',
                            color: currentPage === p ? '#000' : 'white',
                            border: currentPage === p ? 'none' : '1px solid var(--border)',
                            cursor: 'pointer', fontWeight: currentPage === p ? '700' : '400',
                          }}
                        >
                          {p}
                        </button>
                      )
                    )
                  }
                  <button
                    onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                    disabled={currentPage === totalPages}
                    style={{ background: 'none', border: 'none', color: currentPage === totalPages ? 'var(--text3)' : 'white', cursor: currentPage === totalPages ? 'not-allowed' : 'pointer', fontSize: '12px', padding: '4px 8px' }}
                  >
                    ›
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      ) : (
        <>
      {/* Mode switch + Country selector */}
      <div className="p2p-header-row" style={{ marginBottom: '1.25rem' }}>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <div
            className="bulk-pill"
            onClick={() => setMode(mode === 'sell' ? 'buy' : 'sell')}
            style={{ padding: '6px 12px', cursor: 'pointer' }}
          >
            <span className="pill-txt" style={{ fontSize: '11px', fontWeight: 700, color: 'white' }}>
              {mode === 'sell' ? 'Sell' : 'Buy'}
            </span>
            <div className={`tsw ${mode === 'buy' ? 'on' : ''}`} style={{ marginLeft: '6px' }}>
              <div className="tknob" />
            </div>
          </div>

        </div>

        {/* Country picker */}
        <div className="p2p-country-selector" style={{ position: 'relative' }}>
          <div className="curr-selector" onClick={() => setCountryOpen(!countryOpen)}>
            <span className="curr-flag">{selectedCountry.flag}</span>
            <span style={{ marginLeft: '4px' }}>{selectedCountry.code}</span>
            <span className="curr-chevron" style={{ marginLeft: '6px' }}>▼</span>
          </div>
          {countryOpen && (
            <div className="drop-menu" style={{ right: 0, zIndex: 100, minWidth: '220px' }}>
              <div style={{ padding: '8px', borderBottom: '1px solid var(--border)' }} onClick={e => e.stopPropagation()}>
                <input
                  type="text"
                  placeholder="Search country..."
                  value={countrySearch}
                  onChange={e => setCountrySearch(e.target.value)}
                  style={{ width: '100%', padding: '6px 10px', background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border)', borderRadius: '6px', color: 'white', fontSize: '12px', outline: 'none' }}
                />
              </div>
              <div style={{ maxHeight: '200px', overflowY: 'auto' }}>
                {filteredCountries.map(c => {
                  const isLiveCountry = LIVE_COUNTRY_CODES.has(c.code);
                  return (
                    <div
                      key={c.code}
                      className={`drop-item ${selectedCountry.code === c.code ? 'sel' : ''} ${!isLiveCountry ? 'country-coming-soon' : ''}`}
                      onClick={() => {
                        if (!isLiveCountry) return; // block non-Nigeria selection
                        setSelectedCountry(c);
                        setCountryOpen(false);
                        setCountrySearch('');
                      }}
                      style={{ opacity: isLiveCountry ? 1 : 0.55, cursor: isLiveCountry ? 'pointer' : 'not-allowed' }}
                    >
                      <span className="curr-flag">{c.flag}</span>
                      <span className="di-code" style={{ marginLeft: '8px' }}>{c.code}</span>
                      <span className="di-name">{c.name}</span>
                      {!isLiveCountry && (
                        <span style={{
                          marginLeft: 'auto',
                          fontSize: '9px',
                          fontWeight: '700',
                          color: '#f59e0b',
                          background: 'rgba(245,158,11,0.12)',
                          border: '1px solid rgba(245,158,11,0.3)',
                          borderRadius: '4px',
                          padding: '1px 5px',
                          letterSpacing: '0.03em',
                          textTransform: 'uppercase',
                          flexShrink: 0,
                        }}>Soon</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── LIVE OFFRAMP ROUTE ── */}
      {isLiveRoute ? (
        authStep !== 'logged_in' ? (
          <div className="p2p-auth-container" style={{
            background: 'rgba(255, 255, 255, 0.02)',
            border: '1px solid var(--border)',
            borderRadius: '16px',
            padding: '24px',
            textAlign: 'center',
            marginBottom: '1.25rem',
            backdropFilter: 'blur(10px)'
          }}>
            <h3 style={{ fontSize: '16px', fontWeight: 'bold', color: 'var(--lime)', marginBottom: '20px' }}>
              Verify Your Email
            </h3>

            {authError && (
              <div style={{
                background: 'rgba(239, 68, 68, 0.08)',
                border: '1px solid rgba(239, 68, 68, 0.2)',
                borderRadius: '8px',
                padding: '8px 10px',
                fontSize: '11px',
                color: '#f87171',
                marginBottom: '14px',
                textAlign: 'left',
                lineHeight: '1.4'
              }}>
                ✕ {authError}
              </div>
            )}

            {authStep === 'input_email' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div className="field" style={{ textAlign: 'left', marginBottom: 0 }}>
                  <div className="field-label">Email Address</div>
                  <div className="input-wrap">
                    <input
                      type="email"
                      value={emailInput}
                      onChange={e => setEmailInput(e.target.value)}
                      placeholder="name@example.com"
                      disabled={authLoading}
                    />
                  </div>
                </div>
                <button
                  className="send-btn"
                  onClick={handleInitiateSession}
                  disabled={authLoading || !emailInput}
                  style={{ marginTop: '8px' }}
                >
                  {authLoading ? 'Sending code...' : 'Send Verification Code'}
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div className="field" style={{ textAlign: 'left', marginBottom: 0 }}>
                  <div className="field-label">Enter 4-Digit OTP</div>
                  <div className="input-wrap">
                    <input
                      type="text"
                      maxLength={4}
                      value={otpInput}
                      onChange={e => setOtpInput(e.target.value.replace(/\D/g, ''))}
                      placeholder="0000"
                      disabled={authLoading}
                      style={{ textAlign: 'center', letterSpacing: '0.5em', fontSize: '18px' }}
                    />
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '10px', marginTop: '8px' }}>
                  <button
                    className="send-btn"
                    onClick={() => { setAuthStep('input_email'); setAuthError(null); }}
                    disabled={authLoading}
                    style={{ flex: 1, background: 'rgba(255,255,255,0.06)', color: 'white' }}
                  >
                    Back
                  </button>
                  <button
                    className="send-btn"
                    onClick={handleVerifySession}
                    disabled={authLoading || otpInput.length !== 4}
                    style={{ flex: 2 }}
                  >
                    {authLoading ? 'Verifying...' : 'Verify & Connect'}
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <>
            {/* Account Number — shown first */}
            <div className="field">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                <div className="field-label" style={{ marginBottom: 0 }}>Account Number</div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button className="p2p-btn-badge" onClick={handlePaste} disabled={!canTransact} style={{ opacity: canTransact ? 1 : 0.6 }}>Paste</button>
                  <button
                    className="p2p-btn-badge"
                    onClick={() => setScannerActive(true)}
                    disabled={!canTransact}
                    style={{ opacity: canTransact ? 1 : 0.6, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                    title="Scan QR Code"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <rect x="2" y="2" width="20" height="20" rx="4" stroke="currentColor" strokeWidth="2.5" fill="none" />
                      <rect x="1" y="10" width="22" height="4" fill="currentColor" />
                    </svg>
                  </button>
                </div>
              </div>
              <div className="input-wrap" style={{ opacity: canTransact ? 1 : 0.6 }}>
                <input
                  type="text"
                  value={accountNumber}
                  onChange={e => setAccountNumber(e.target.value.replace(/\D/g, ''))}
                  placeholder="0000000000"
                  disabled={!canTransact}
                />
              </div>
              <div style={{ marginTop: '6px', minHeight: '16px', fontSize: '12px', color: 'var(--lime)', fontWeight: 'bold' }}>
                {accountNumber && selectedBank !== 'Choose Bank' && (
                  resolvingName
                    ? <span style={{ fontStyle: 'italic', color: 'var(--text3)', fontWeight: 'normal' }}><span className="p2p-mini-spinner" /> Resolving...</span>
                    : accountName && (
                      <span
                        className="animated-fade-in"
                        style={{ color: accountName === 'No Bank Match' ? '#f87171' : 'var(--lime)' }}
                      >
                        {accountName}
                      </span>
                    )
                )}
              </div>
            </div>

            {/* Bank selector — shown second */}
            <div className="field" style={{ position: 'relative' }}>
              <div className="field-label">Bank</div>
              <div
                className="input-wrap"
                onClick={() => { if (canTransact) setBankOpen(!bankOpen); }}
                style={{ cursor: canTransact ? 'pointer' : 'not-allowed', justifyContent: 'space-between', opacity: canTransact ? 1 : 0.6 }}
              >
                {loadingBanks ? (
                  <span style={{ fontSize: '12px', color: 'var(--text3)', fontStyle: 'italic' }}>
                    <span className="p2p-mini-spinner" /> Loading banks...
                  </span>
                ) : (
                  <span style={{ color: selectedBank === 'Choose Bank' ? 'var(--text3)' : 'var(--text)' }}>
                    {selectedBank}
                  </span>
                )}
                <span style={{ color: 'var(--text3)', fontSize: '11px' }}>▼</span>
              </div>

              {bankOpen && (
                <div className="drop-menu" style={{ left: 0, right: 0, width: '100%' }} onClick={e => e.stopPropagation()}>
                  <div style={{ padding: '8px', borderBottom: '1px solid var(--border)' }}>
                    <input
                      type="text"
                      placeholder="Search bank name..."
                      value={bankSearch}
                      onChange={e => setBankSearch(e.target.value)}
                      style={{ width: '100%', padding: '6px 10px', background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border)', borderRadius: '6px', color: 'white', fontSize: '12px', outline: 'none' }}
                    />
                  </div>
                  <div style={{ maxHeight: '200px', overflowY: 'auto' }}>
                    {filteredBanksList.map(b => {
                      const meta = getBankMetadata(b);
                      return (
                        <div
                          key={b}
                          className={`drop-item ${selectedBank === b ? 'sel' : ''}`}
                          onClick={() => { setSelectedBank(b); setBankOpen(false); setBankSearch(''); }}
                          style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px' }}
                        >
                          {meta.logo ? (
                            <img
                              src={meta.logo} alt={meta.name}
                              onError={e => { e.target.style.display = 'none'; e.target.nextSibling.style.display = 'flex'; }}
                              style={{ width: '22px', height: '22px', borderRadius: '50%', objectFit: 'cover' }}
                          />
                          ) : null}
                          <div
                            className="bank-avatar"
                            style={{
                              display: meta.logo ? 'none' : 'flex',
                              width: '22px', height: '22px', borderRadius: '50%',
                              background: meta.color, color: 'white', fontSize: '9px',
                              fontWeight: 'bold', alignItems: 'center', justifyContent: 'center',
                            }}
                          >
                            {meta.initial}
                          </div>
                          <span className="di-name" style={{ marginLeft: 0 }}>{b}</span>
                        </div>
                      );
                    })}
                    {filteredBanksList.length === 0 && (
                      <div style={{ fontSize: '11px', color: 'var(--text3)', fontStyle: 'italic', padding: '12px', textAlign: 'center' }}>
                        No banks found
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Amount + Token Row */}
            <div style={{ marginBottom: '0.95rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
                <div className="field-label" style={{ marginBottom: 0, textTransform: 'none', fontSize: '13px', fontWeight: '500', color: 'rgba(255,255,255,0.6)', letterSpacing: 'normal' }}>
                  Amount
                </div>
                {/* Clickable tooltip */}
                <div style={{ position: 'relative', display: 'inline-flex' }}>
                  <svg
                    width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                    style={{ color: 'rgba(255,255,255,0.4)', cursor: 'pointer' }}
                    onClick={() => setShowAmountTooltip(v => !v)}
                  >
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="16" x2="12" y2="12" />
                    <line x1="12" y1="8" x2="12.01" y2="8" />
                  </svg>
                  {showAmountTooltip && (
                    <div
                      onClick={() => setShowAmountTooltip(false)}
                      style={{
                        position: 'absolute', bottom: '18px', left: '50%', transform: 'translateX(-50%)',
                        background: 'rgba(20,20,30,0.97)', border: '1px solid rgba(255,255,255,0.12)',
                        borderRadius: '8px', padding: '8px 12px', fontSize: '11px', color: 'rgba(255,255,255,0.85)',
                        width: '220px', lineHeight: '1.5', zIndex: 200, cursor: 'pointer',
                        boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
                      }}
                    >
                      ℹ️ Please note that Fiatwallet charges <strong>1% fee</strong> on all off-ramp transactions.
                    </div>
                  )}
                </div>
              </div>
              <div className="amount-block" style={{ marginTop: '4px', opacity: canTransact ? 1 : 0.6, padding: '14px 16px' }}>
                {/* Top Row: Input & Token Selector */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                  {/* Left Part: Input & symbol */}
                  <div style={{ display: 'flex', flex: 1, flexDirection: 'row', alignItems: 'center', gap: '6px' }}>
                    <span style={{
                      color: amount ? 'white' : 'rgba(255, 255, 255, 0.38)',
                      fontWeight: '500',
                      fontSize: '32px',
                      fontFamily: 'var(--ff)',
                      lineHeight: 1,
                      userSelect: 'none'
                    }}>
                      {selectedCountry.symbol}
                    </span>
                    <input
                      className="amount-num"
                      type="number"
                      placeholder="0"
                      value={amount}
                      onChange={e => setAmount(e.target.value)}
                      disabled={!canTransact}
                      style={{
                        fontSize: '32px',
                        fontWeight: '500',
                        fontFamily: 'var(--ff)',
                        width: '100%',
                        flex: 1,
                        color: 'white',
                        padding: 0,
                        lineHeight: 1,
                      }}
                    />
                  </div>

                  {/* Right Part: Token selector dropdown */}
                  <div className="drop-wrap" style={{ position: 'relative' }}>
                    <div
                      className="input-wrap"
                      onClick={() => { if (canTransact) setTokenOpen(!tokenOpen); }}
                      style={{
                        cursor: canTransact ? 'pointer' : 'not-allowed',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        background: 'rgba(255,255,255,0.06)',
                        border: '1px solid var(--border)',
                        borderRadius: '24px',
                        padding: '6px 12px',
                        fontWeight: 600,
                        color: 'white',
                        userSelect: 'none',
                        transition: 'background 0.2s, border-color 0.2s',
                      }}
                      onMouseEnter={(e) => { if (canTransact) e.currentTarget.style.background = 'rgba(255,255,255,0.1)'; }}
                      onMouseLeave={(e) => { if (canTransact) e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
                    >
                      {liveSelectedToken.logoURI ? (
                        <img src={liveSelectedToken.logoURI} alt={liveSelectedToken.symbol} style={{ width: '18px', height: '18px', borderRadius: '50%' }} />
                      ) : (
                        <div style={{ width: '18px', height: '18px', borderRadius: '50%', background: 'rgba(255,255,255,0.1)', color: 'white', fontSize: '9px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold' }}>
                          {liveSelectedToken.symbol.slice(0, 2)}
                        </div>
                      )}
                      <span style={{ fontSize: '13px', fontWeight: '500' }}>{liveSelectedToken.symbol}</span>
                      <svg width="10" height="6" viewBox="0 0 10 6" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ color: 'rgba(255,255,255,0.6)', marginLeft: '2px' }}>
                        <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </div>

                    {tokenOpen && (
                      <div className="drop-menu" style={{ right: 0, minWidth: '220px', zIndex: 100 }}>
                        {selectableTokens.map(t => {
                          const isLiveToken = t.symbol === 'USDC' || t.symbol === 'USDT';
                          return (
                            <div
                              key={t.mint || t.symbol}
                              className={`drop-item ${liveSelectedToken.symbol === t.symbol ? 'sel' : ''}`}
                              onClick={() => {
                                if (!isLiveToken) return; // block non-USDC/USDT
                                setSelectedToken(t);
                                setTokenOpen(false);
                              }}
                              style={{
                                display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 12px',
                                opacity: isLiveToken ? 1 : 0.55,
                                cursor: isLiveToken ? 'pointer' : 'not-allowed',
                              }}
                            >
                              {t.logoURI ? (
                                <img src={t.logoURI} alt={t.symbol} style={{ width: '20px', height: '20px', borderRadius: '50%' }} />
                              ) : (
                                <div style={{ width: '20px', height: '20px', borderRadius: '50%', background: 'rgba(255,255,255,0.1)', color: 'white', fontSize: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold' }}>
                                  {t.symbol.slice(0, 2)}
                                </div>
                              )}
                              <span className="di-code" style={{ marginLeft: 0 }}>{t.symbol}</span>
                              {isLiveToken ? (
                                t.balance > 0 && (
                                  <span className="di-name" style={{ marginLeft: 'auto' }}>
                                    {t.balance.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                                  </span>
                                )
                              ) : (
                                <span style={{
                                  marginLeft: 'auto',
                                  fontSize: '9px',
                                  fontWeight: '700',
                                  color: '#f59e0b',
                                  background: 'rgba(245,158,11,0.12)',
                                  border: '1px solid rgba(245,158,11,0.3)',
                                  borderRadius: '4px',
                                  padding: '1px 5px',
                                  letterSpacing: '0.03em',
                                  textTransform: 'uppercase',
                                  flexShrink: 0,
                                }}>Coming Soon</span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>

                {/* ── Estimated display with 1% fee note ── */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  {/* Estimated crypto quantity */}
                  <span className="amount-converted" style={{ fontSize: '12px', color: 'rgba(255,255,255,0.38)', fontFamily: 'var(--ff)' }}>
                    {routingState === 'routing' || routingState === 'loading_market' ? (
                      <span style={{ color: 'rgba(255,255,255,0.38)', fontStyle: 'italic' }}>
                        <span className="p2p-mini-spinner" /> Routing...
                      </span>
                    ) : (
                      amount && Number(amount) > 0
                        ? `≈ ${estCryptoAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })} ${liveSelectedToken.symbol} (fee: ${platformFee.toFixed(4)})`
                        : `≈ ${liveSelectedToken.symbol}`
                    )}
                  </span>

                  {/* Token balance with small MAX button before the quantity */}
                  {liveSelectedToken.balance != null && (
                    <div style={{ display: 'flex', alignItems: 'center', fontSize: '12px', color: 'rgba(255, 255, 255, 0.38)', fontWeight: 'normal', fontFamily: 'var(--ff)' }}>
                      <button
                        type="button"
                        onClick={() => {
                          const fiatMax = liveSelectedToken.balance * ngnRate;
                          setAmount(fiatMax.toFixed(2));
                        }}
                        disabled={!canTransact}
                        style={{
                          background: 'none',
                          border: 'none',
                          color: 'var(--lime)',
                          cursor: 'pointer',
                          padding: 0,
                          fontSize: '10px',
                          fontWeight: '700',
                          letterSpacing: '0.05em',
                          marginRight: '6px',
                          opacity: canTransact ? 0.85 : 0.5,
                          transition: 'opacity 0.2s',
                        }}
                        onMouseEnter={(e) => { if (canTransact) e.currentTarget.style.opacity = '1'; }}
                        onMouseLeave={(e) => { if (canTransact) e.currentTarget.style.opacity = '0.85'; }}
                      >
                        MAX
                      </button>
                      <span>
                        {liveSelectedToken.balance.toLocaleString(undefined, { maximumFractionDigits: 4 })} {liveSelectedToken.symbol}
                      </span>
                    </div>
                  )}
                </div>
              </div>

              {/* Exchange rate — shown without 'Rate:' prefix */}
              {pajRates?.offRampRate?.rate && (
                <div style={{ marginTop: '6px', fontSize: '11px' }}>
                  <span style={{ color: 'rgba(255,255,255,0.38)' }}>
                    1 {liveSelectedToken.symbol} = {selectedCountry.symbol}{ngnRate.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  </span>
                </div>
              )}
            </div>

            {p2pError && (
              <div style={{
                background: 'rgba(239, 68, 68, 0.08)',
                border: '1px solid rgba(239, 68, 68, 0.2)',
                borderRadius: '8px',
                padding: '10px 12px',
                fontSize: '11px',
                color: '#f87171',
                marginBottom: '12px',
                textAlign: 'left',
                lineHeight: '1.4'
              }}>
                ✕ {p2pError}
              </div>
            )}

            {/* Submit button + Relayer badge */}
            <button
              className="send-btn"
              onClick={handleSubmit}
              disabled={submitting || !isFormValid}
              style={{ opacity: (submitting || !isFormValid) ? 0.6 : 1, cursor: (submitting || !isFormValid) ? 'not-allowed' : 'pointer' }}
            >
              {submitting && <span className="p2p-mini-spinner" style={{ marginRight: '6px' }} />}
              {submitting ? 'Processing...' : (!isLiveRoute || apiError ? 'Payout Gateway Offline' : 'Send')}
            </button>
            {relayerActive && (
              <div style={{ textAlign: 'center', marginTop: '6px', fontSize: '10px', color: 'var(--lime)', opacity: 0.75 }}>
                ⚡ Gas fee sponsored by relayer
              </div>
            )}
        </>
      ) ) : (
        /* ── Buy (Onramp) Mode — Nigeria only ── */
        selectedCountry.code === 'NGA' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <p style={{ fontSize: '11px', color: 'var(--text3)', margin: 0, lineHeight: '1.5' }}>
            Enter the NGN amount you want to pay. PajCash will provide a Nigerian bank account to receive your payment. Once confirmed, USDC/USDT will be sent to your connected wallet.
          </p>

          {/* NGN Amount & Target Token Block */}
          <div className="field">
            <div className="field-label" style={{ marginBottom: '6px', fontSize: '13px', fontWeight: '500', color: 'rgba(255,255,255,0.6)' }}>Amount</div>
            <div className="amount-block" style={{ marginTop: '4px', padding: '14px 16px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                {/* Left Part: NGN Input */}
                <div style={{ display: 'flex', flex: 1, flexDirection: 'row', alignItems: 'center', gap: '6px' }}>
                  <span style={{ color: onrampAmount ? 'white' : 'rgba(255, 255, 255, 0.38)', fontWeight: '500', fontSize: '32px', fontFamily: 'var(--ff)', lineHeight: 1, userSelect: 'none' }}>
                    ₦
                  </span>
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder="0"
                    value={onrampAmount}
                    onChange={e => {
                      const val = e.target.value.replace(/[^0-9.]/g, '');
                      setOnrampAmount(val);
                      setOnrampOrder(null);
                      setOnrampStatus(null);
                    }}
                    style={{ fontSize: '32px', fontWeight: '500', fontFamily: 'var(--ff)', width: '100%', flex: 1, color: 'white', padding: 0, lineHeight: 1, background: 'transparent', border: 'none', outline: 'none' }}
                  />
                </div>

                {/* Right Part: Token selector dropdown */}
                <div className="drop-wrap" style={{ position: 'relative' }}>
                  <div
                    className="input-wrap"
                    onClick={() => setTokenOpen(!tokenOpen)}
                    style={{
                      cursor: 'pointer',
                      background: 'rgba(255,255,255,0.06)',
                      border: '1px solid var(--border)',
                      borderRadius: '24px',
                      padding: '6px 12px',
                      fontWeight: 600,
                      color: 'white',
                      userSelect: 'none',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      transition: 'background 0.2s, border-color 0.2s',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.1)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
                  >
                    {liveSelectedToken.logoURI ? (
                      <img src={liveSelectedToken.logoURI} alt={liveSelectedToken.symbol} style={{ width: '18px', height: '18px', borderRadius: '50%' }} />
                    ) : (
                      <div style={{ width: '18px', height: '18px', borderRadius: '50%', background: 'rgba(255,255,255,0.1)', color: 'white', fontSize: '9px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold' }}>
                        {liveSelectedToken.symbol.slice(0, 2)}
                      </div>
                    )}
                    <span style={{ fontSize: '13px', fontWeight: '500' }}>{liveSelectedToken.symbol}</span>
                    <svg width="10" height="6" viewBox="0 0 10 6" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ color: 'rgba(255,255,255,0.6)', marginLeft: '2px' }}>
                      <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </div>

                  {tokenOpen && (
                    <div className="drop-menu" style={{ right: 0, minWidth: '220px', zIndex: 100 }}>
                      {selectableTokens.map(t => {
                        const isLiveToken = t.symbol === 'USDC' || t.symbol === 'USDT';
                        return (
                          <div
                            key={t.mint || t.symbol}
                            className={`drop-item ${liveSelectedToken.symbol === t.symbol ? 'sel' : ''}`}
                            onClick={() => {
                              if (!isLiveToken) return; // block non-USDC/USDT
                              setSelectedToken(t);
                              setTokenOpen(false);
                            }}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '8px',
                              padding: '10px 12px',
                              opacity: isLiveToken ? 1 : 0.55,
                              cursor: isLiveToken ? 'pointer' : 'not-allowed',
                            }}
                          >
                            {t.logoURI ? (
                              <img src={t.logoURI} alt={t.symbol} style={{ width: '20px', height: '20px', borderRadius: '50%' }} />
                            ) : (
                              <div style={{ width: '20px', height: '20px', borderRadius: '50%', background: 'rgba(255,255,255,0.1)', color: 'white', fontSize: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold' }}>
                                {t.symbol.slice(0, 2)}
                              </div>
                            )}
                            <span className="di-code" style={{ marginLeft: 0 }}>{t.symbol}</span>
                            {!isLiveToken && (
                              <span style={{
                                marginLeft: 'auto',
                                fontSize: '9px',
                                fontWeight: '700',
                                color: '#f59e0b',
                                background: 'rgba(245,158,11,0.12)',
                                border: '1px solid rgba(245,158,11,0.3)',
                                borderRadius: '4px',
                                padding: '1px 5px',
                                letterSpacing: '0.03em',
                                textTransform: 'uppercase',
                                flexShrink: 0,
                              }}>Coming Soon</span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>

              {/* Bottom Row of block: Estimation preview */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '10px', marginTop: '8px' }}>
                <span className="amount-converted" style={{ fontSize: '12px', color: 'rgba(255,255,255,0.38)', fontFamily: 'var(--ff)' }}>
                  {parsedOnrampAmt > 0
                    ? `≈ ${estOnrampCrypto.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })} ${liveSelectedToken.symbol} (fee: ${onrampFee.toFixed(4)})`
                    : `≈ ${liveSelectedToken.symbol}`
                  }
                </span>
              </div>
            </div>

            {/* Exchange rate — shown below Amount input block */}
            {pajRates?.onRampRate?.rate && (
              <div style={{ marginTop: '6px', fontSize: '11px' }}>
                <span style={{ color: 'rgba(255,255,255,0.38)' }}>
                  1 {liveSelectedToken.symbol} = {selectedCountry.symbol}{onrampNgnRate.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </span>
              </div>
            )}
          </div>

          {/* Session notice if not yet logged in */}
          {authStep !== 'logged_in' && (
            <div style={{ background: 'rgba(234,179,8,0.08)', border: '1px solid rgba(234,179,8,0.2)', borderRadius: '8px', padding: '10px 14px', fontSize: '11px', color: '#facc15', lineHeight: '1.5' }}>
              🔒 Please verify your email (above) to activate the Buy gateway.
            </div>
          )}

          {onrampError && (
            <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '8px', padding: '10px 12px', fontSize: '11px', color: '#f87171' }}>
              ✕ {onrampError}
            </div>
          )}

          {/* Bank Details Card (after order created) */}
          {onrampOrder && (
            <div style={{
              background: 'linear-gradient(135deg, rgba(16,185,129,0.08) 0%, rgba(6,78,59,0.12) 100%)',
              border: '1px solid rgba(16,185,129,0.25)', borderRadius: '14px', padding: '16px',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Transfer Fiat To</div>
                <button
                  onClick={() => {
                    setOnrampOrder(null);
                    setOnrampStatus(null);
                    setOnrampAmount('');
                    if (onrampSocketRef.current) {
                      try { onrampSocketRef.current.disconnect(); } catch {}
                      onrampSocketRef.current = null;
                    }
                  }}
                  style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.5)', cursor: 'pointer', fontSize: '16px', padding: 0 }}
                  title="Cancel Order"
                >
                  ✕
                </button>
              </div>
              {[['Bank', onrampOrder.bankName || onrampOrder.bank || '—'],
                ['Account No.', onrampOrder.accountNumber || onrampOrder.account || '—'],
                ['Account Name', onrampOrder.accountName || onrampOrder.name || '—'],
                ['Amount (NGN)', `₦${parsedOnrampAmt.toLocaleString()}`],
                ['Reference', onrampOrder.reference || onrampOrder.id],
              ].map(([label, val]) => (
                <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                  <span style={{ fontSize: '11px', color: 'var(--text3)' }}>{label}</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span style={{ fontSize: '12px', color: 'white', fontWeight: '600', fontFamily: 'monospace' }}>{val}</span>
                    {(label === 'Account No.' || label === 'Reference') && (
                      <button
                        onClick={() => { navigator.clipboard?.writeText(String(val)); setCopiedOnrampAcct(label); setTimeout(() => setCopiedOnrampAcct(false), 1500); }}
                        style={{ background: 'none', border: 'none', color: copiedOnrampAcct === label ? 'var(--lime)' : 'var(--text3)', cursor: 'pointer', fontSize: '10px', padding: '2px' }}
                      >
                        {copiedOnrampAcct === label ? '✓' : '📋'}
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {/* Status indicator */}
              <div style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid rgba(255,255,255,0.08)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '11px', color: 'var(--text3)' }}>Status</span>
                <span style={{
                  fontSize: '11px', fontWeight: '700',
                  color: onrampStatus === 'completed' ? 'var(--lime)' : onrampStatus === 'failed' ? '#ef4444' : '#eab308',
                  textTransform: 'uppercase',
                }}>
                  {onrampStatus === 'completed' ? '✓ Completed' : onrampStatus === 'failed' ? '✕ Failed' : '⏳ Awaiting Payment'}
                </span>
              </div>
            </div>
          )}

          {/* Get Bank Details Button */}
          {!onrampOrder && (
            <button
              className="send-btn"
              onClick={handleOnrampSubmit}
              disabled={onrampLoading || !parsedOnrampAmt || parsedOnrampAmt <= 0 || !sessionToken}
              style={{ opacity: (onrampLoading || !parsedOnrampAmt || !sessionToken) ? 0.6 : 1, cursor: 'pointer' }}
            >
              {onrampLoading && <span className="p2p-mini-spinner" style={{ marginRight: '6px' }} />}
              {onrampLoading ? 'Getting Bank Details...' : '🏦 Get Bank Details'}
            </button>
          )}
          {onrampOrder && onrampStatus !== 'completed' && (
            <button
              className="send-btn"
              onClick={() => { setOnrampOrder(null); setOnrampStatus(null); setOnrampAmount(''); }}
              style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border)', fontSize: '12px', opacity: 0.7 }}
            >
              Start New Order
            </button>
          )}
        </div>
        ) : (
        /* ── Coming soon for non-Nigeria Buy ── */
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          minHeight: '320px', textAlign: 'center', padding: '20px 24px',
          background: 'rgba(255,255,255,0.01)', border: '1.5px dashed rgba(255,255,255,0.1)',
          borderRadius: '16px', margin: '10px 0',
        }}>
          <div style={{ fontSize: '38px', marginBottom: '14px' }}>🚀</div>
          <h4 style={{ fontSize: '15px', fontWeight: 'bold', color: 'white', marginBottom: '10px' }}>
            {mode === 'buy' ? 'Buy Coming Soon for this Region' : `${selectedCountry.name} Payouts Coming Soon`}
          </h4>
          <p style={{ fontSize: '11px', color: 'var(--text3)', maxWidth: '300px', lineHeight: '1.5' }}>
            {mode === 'buy'
              ? 'Switch to Nigeria (NGA) to use the live Buy gateway.'
              : `Off-ramp for ${selectedCountry.name} is in development. Select Nigeria (NGA) in Sell mode to use the live PajCash gateway.`
            }
          </p>
        </div>
        )
      )}
      </>
      )}

      {/* ── Success Modal (never auto-closes, user must click Done) ── */}
      {showSuccess && successDetails && (() => {
        const parseFiatNum = (str) => {
          if (!str) return 0;
          const cleaned = str.replace(/[^\d.]/g, '');
          return parseFloat(cleaned) || 0;
        };
        const fiatNum = typeof successDetails.fiat === 'number' ? successDetails.fiat : parseFiatNum(successDetails.fiat);
        const fiatValStr = `${selectedCountry.symbol}${fiatNum.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
        const cryptoValStr = successDetails.amount;
        const recipientName = successDetails.name ? successDetails.name.toUpperCase() : 'PENDING';
        const accountNumber = successDetails.account || '—';
        const bankName = successDetails.bank || '—';
        const dateStr = formatTransactionDate(successDetails.createdAt || new Date().toISOString());
        const statusVal = isConfirmed(successDetails.status) ? 'Confirmed' : isSettling(successDetails.status) ? 'Settling…' : 'Pending';
        const statusHeader = `TRANSFER ${statusVal.toUpperCase()}`;
        const bankMeta = bankName !== '—' ? getBankMetadata(bankName) : null;
        const orderId = successDetails.orderId || successDetails.id || successDetails._id || '—';
        const sig = successDetails.sig;

        return (
          <div className="p2p-success-overlay" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(6px)', zIndex: 1000, position: 'fixed', top: 0, left: 0, right: 0, bottom: 0 }}>
            <div 
              style={{
                background: 'var(--card)',
                border: '1px solid var(--border)',
                borderRadius: '22px',
                width: '92%',
                maxWidth: '380px',
                padding: '30px 24px 24px 24px',
                position: 'relative',
                boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)'
              }}
            >
              {/* Circular Status Icon */}
              <div 
                style={{
                  width: '56px',
                  height: '56px',
                  borderRadius: '50%',
                  background: statusVal === 'Confirmed' ? 'rgba(34, 197, 94, 0.1)' : statusVal === 'Settling…' ? 'rgba(234, 179, 8, 0.1)' : 'rgba(255, 255, 255, 0.05)',
                  border: statusVal === 'Confirmed' ? '2px solid rgba(34, 197, 94, 0.4)' : statusVal === 'Settling…' ? '2px solid rgba(234, 179, 8, 0.4)' : '2px solid rgba(255, 255, 255, 0.15)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  margin: '0 auto 20px auto'
                }}
              >
                {statusVal === 'Confirmed' ? (
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                ) : (
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={statusVal === 'Pending' ? '#8e9aa8' : '#eab308'} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <polyline points="12 6 12 12 16 14" />
                  </svg>
                )}
              </div>

              {/* Header Info */}
              <div style={{ textAlign: 'center', marginBottom: '24px' }}>
                <div style={{ fontSize: '11px', color: '#8e9aa8', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600, marginBottom: '6px' }}>
                  {statusHeader}
                </div>
                <div style={{ fontSize: '38px', fontWeight: '800', color: '#fcefdc', letterSpacing: '-0.02em', marginBottom: '6px', fontFamily: 'sans-serif' }}>
                  {fiatValStr}
                </div>
                <div style={{ fontSize: '13.5px', color: '#8e9aa8' }}>
                  ≈ {cryptoValStr}
                </div>
              </div>

              {/* Clean solid divider line */}
              <div style={{ height: '1px', background: 'rgba(255, 255, 255, 0.08)', margin: '8px 0 24px 0' }}></div>

              {/* Details list */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginBottom: '28px' }}>
                {/* Recipient Row */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', fontSize: '13.5px' }}>
                  <span style={{ color: '#8e9aa8', minWidth: '80px' }}>Recipient</span>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', color: 'white', fontWeight: '700', textAlign: 'right', maxWidth: '70%', lineHeight: '1.4' }}>
                    {recipientName}
                  </div>
                </div>

                {/* Account Number Row */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '13.5px' }}>
                  <span style={{ color: '#8e9aa8' }}>Account Number</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'white', fontWeight: '700' }}>
                    <span>{accountNumber}</span>
                    {accountNumber !== '—' && (
                      <svg 
                        onClick={() => {
                          navigator.clipboard.writeText(accountNumber);
                          setCopiedAccount(true);
                          setTimeout(() => setCopiedAccount(false), 2000);
                        }}
                        style={{ cursor: 'pointer', transition: 'color 0.15s', color: copiedAccount ? 'var(--lime)' : '#8e9aa8' }}
                        width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                      >
                        {copiedAccount ? (
                          <polyline points="20 6 9 17 4 12" />
                        ) : (
                          <>
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                          </>
                        )}
                      </svg>
                    )}
                  </div>
                </div>

                {/* Bank Row */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '13.5px' }}>
                  <span style={{ color: '#8e9aa8' }}>Bank</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'white', fontWeight: '700', maxWidth: '70%', textAlign: 'right' }}>
                    {bankMeta && bankMeta.logo ? (
                      <img src={bankMeta.logo} alt="bank" style={{ width: '18px', height: '18px', borderRadius: '50%', objectFit: 'cover' }} onError={(e) => { e.target.style.display = 'none'; e.target.nextElementSibling.style.display = 'flex'; }} />
                    ) : null}
                    {bankMeta ? (
                      <div style={{ width: '18px', height: '18px', borderRadius: '50%', background: bankMeta.color, color: 'white', display: bankMeta.logo ? 'none' : 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '8px', fontWeight: 'bold' }}>
                        {bankMeta.initial}
                      </div>
                    ) : null}
                    <span>{bankName}</span>
                  </div>
                </div>

                {/* Date Row */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '13.5px' }}>
                  <span style={{ color: '#8e9aa8' }}>Date</span>
                  <span style={{ color: 'white', fontWeight: '700' }}>{dateStr}</span>
                </div>

                {/* Status Row */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '13.5px' }}>
                  <span style={{ color: '#8e9aa8' }}>Status</span>
                  <span style={{ color: 'white', fontWeight: '700' }}>{statusVal}</span>
                </div>

                {/* Sender Row */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '13.5px' }}>
                  <span style={{ color: '#8e9aa8' }}>Sender</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'white', fontWeight: '700' }}>
                    <div style={{ 
                      width: '18px', 
                      height: '18px', 
                      borderRadius: '50%', 
                      background: 'black', 
                      color: 'white', 
                      display: 'flex', 
                      alignItems: 'center', 
                      justifyContent: 'center', 
                      fontSize: '9px', 
                      fontWeight: '800', 
                      fontStyle: 'italic', 
                      fontFamily: '"Georgia", serif' 
                    }}>
                      paj
                    </div>
                    <span>Paj Cash</span>
                  </div>
                </div>

                {sig && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '11px', borderTop: '1px solid rgba(255, 255, 255, 0.05)', paddingTop: '12px', marginTop: '4px' }}>
                    <span style={{ color: '#8e9aa8' }}>Tx Signature</span>
                    <a
                      href={`https://solscan.io/tx/${sig}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: 'var(--lime)', fontFamily: 'var(--mono)', textDecoration: 'underline' }}
                    >
                      {sig.slice(0, 12)}...
                    </a>
                  </div>
                )}
              </div>

              {/* Close Button */}
              <button 
                className="send-btn" 
                onClick={() => { setShowSuccess(false); setSuccessDetails(null); }} 
                style={{ 
                  width: '100%', 
                  padding: '14px', 
                  borderRadius: '13px', 
                  background: 'var(--lime)', 
                  border: 'none', 
                  color: '#0a1628', 
                  fontSize: '15px', 
                  fontWeight: 'bold', 
                  cursor: 'pointer',
                  boxShadow: '0 4px 12px rgba(74, 222, 128, 0.15)',
                  transition: 'background 0.2s, transform 0.1s, opacity 0.15s'
                }}
                onMouseEnter={e => {
                  e.currentTarget.style.background = 'var(--lime2)';
                  e.currentTarget.style.transform = 'translateY(-1px)';
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.background = 'var(--lime)';
                  e.currentTarget.style.transform = 'translateY(0)';
                }}
              >
                Done
              </button>
            </div>
          </div>
        );
      })()}

      {/* ── History Detail Pop-up (clicking a history entry) ── */}
      {selectedLog && (() => {
        const logFiatVal = selectedLog.fiatAmount || selectedLog.fiat || 0;
        const fiatValStr = `${selectedCountry.symbol}${logFiatVal.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

        // Equivalent Crypto
        const tokenSymbol = selectedLog.tokenSymbol || (selectedLog.mint ? (selectableTokens.find(t => t.mint === selectedLog.mint)?.symbol || 'USDC') : 'USDC');
        const cryptoAmt = selectedLog.cryptoAmount || selectedLog.amount || 0;
        const cryptoValStr = `${cryptoAmt.toFixed(4)} ${tokenSymbol}`;

        const recipientName = getCleanNameForLog(selectedLog).toUpperCase();
        const accountNumber = selectedLog.accountNumber || selectedLog.account || '—';
        const bankName = selectedLog.bank || '—';
        const dateStr = formatTransactionDate(selectedLog.createdAt);
        const statusVal = isConfirmed(selectedLog.status) ? 'Confirmed' : isSettling(selectedLog.status) ? 'Settling…' : 'Pending';
        const statusHeader = `TRANSFER ${statusVal.toUpperCase()}`;
        const bankMeta = bankName !== '—' ? getBankMetadata(bankName) : null;
        const orderId = selectedLog.orderId || selectedLog.id || selectedLog._id || selectedLog.reference || '—';
        const sig = selectedLog.sig;

        return (
          <div className="p2p-success-overlay" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(6px)', zIndex: 1000, position: 'fixed', top: 0, left: 0, right: 0, bottom: 0 }}>
            <div 
              style={{
                background: 'var(--card)',
                border: '1px solid var(--border)',
                borderRadius: '22px',
                width: '92%',
                maxWidth: '380px',
                padding: '30px 24px 24px 24px',
                position: 'relative',
                boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)'
              }}
            >
              {/* Circular Status Icon */}
              <div 
                style={{
                  width: '56px',
                  height: '56px',
                  borderRadius: '50%',
                  background: statusVal === 'Confirmed' ? 'rgba(34, 197, 94, 0.1)' : statusVal === 'Settling…' ? 'rgba(234, 179, 8, 0.1)' : 'rgba(255, 255, 255, 0.05)',
                  border: statusVal === 'Confirmed' ? '2px solid rgba(34, 197, 94, 0.4)' : statusVal === 'Settling…' ? '2px solid rgba(234, 179, 8, 0.4)' : '2px solid rgba(255, 255, 255, 0.15)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  margin: '0 auto 20px auto'
                }}
              >
                {statusVal === 'Confirmed' ? (
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                ) : (
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={statusVal === 'Pending' ? '#8e9aa8' : '#eab308'} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <polyline points="12 6 12 12 16 14" />
                  </svg>
                )}
              </div>

              {/* Header Info */}
              <div style={{ textAlign: 'center', marginBottom: '24px' }}>
                <div style={{ fontSize: '11px', color: '#8e9aa8', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600, marginBottom: '6px' }}>
                  {statusHeader}
                </div>
                <div style={{ fontSize: '38px', fontWeight: '800', color: '#fcefdc', letterSpacing: '-0.02em', marginBottom: '6px', fontFamily: 'sans-serif' }}>
                  {fiatValStr}
                </div>
                <div style={{ fontSize: '13.5px', color: '#8e9aa8' }}>
                  ≈ {cryptoValStr}
                </div>
              </div>

              {/* Clean solid divider line */}
              <div style={{ height: '1px', background: 'rgba(255, 255, 255, 0.08)', margin: '8px 0 24px 0' }}></div>

              {/* Details list */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginBottom: '28px' }}>
                {/* Recipient Row */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', fontSize: '13.5px' }}>
                  <span style={{ color: '#8e9aa8', minWidth: '80px' }}>Recipient</span>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', color: 'white', fontWeight: '700', textAlign: 'right', maxWidth: '70%', lineHeight: '1.4' }}>
                    {recipientName}
                  </div>
                </div>

                {/* Account Number Row */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '13.5px' }}>
                  <span style={{ color: '#8e9aa8' }}>Account Number</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'white', fontWeight: '700' }}>
                    <span>{accountNumber}</span>
                    {accountNumber !== '—' && (
                      <svg 
                        onClick={() => {
                          navigator.clipboard.writeText(accountNumber);
                          setCopiedAccount(true);
                          setTimeout(() => setCopiedAccount(false), 2000);
                        }}
                        style={{ cursor: 'pointer', transition: 'color 0.15s', color: copiedAccount ? 'var(--lime)' : '#8e9aa8' }}
                        width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                      >
                        {copiedAccount ? (
                          <polyline points="20 6 9 17 4 12" />
                        ) : (
                          <>
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                          </>
                        )}
                      </svg>
                    )}
                  </div>
                </div>

                {/* Bank Row */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '13.5px' }}>
                  <span style={{ color: '#8e9aa8' }}>Bank</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'white', fontWeight: '700', maxWidth: '70%', textAlign: 'right' }}>
                    {bankMeta && bankMeta.logo ? (
                      <img src={bankMeta.logo} alt="bank" style={{ width: '18px', height: '18px', borderRadius: '50%', objectFit: 'cover' }} onError={(e) => { e.target.style.display = 'none'; e.target.nextElementSibling.style.display = 'flex'; }} />
                    ) : null}
                    {bankMeta ? (
                      <div style={{ width: '18px', height: '18px', borderRadius: '50%', background: bankMeta.color, color: 'white', display: bankMeta.logo ? 'none' : 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '8px', fontWeight: 'bold' }}>
                        {bankMeta.initial}
                      </div>
                    ) : null}
                    <span>{bankName}</span>
                  </div>
                </div>

                {/* Date Row */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '13.5px' }}>
                  <span style={{ color: '#8e9aa8' }}>Date</span>
                  <span style={{ color: 'white', fontWeight: '700' }}>{dateStr}</span>
                </div>

                {/* Status Row */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '13.5px' }}>
                  <span style={{ color: '#8e9aa8' }}>Status</span>
                  <span style={{ color: 'white', fontWeight: '700' }}>{statusVal}</span>
                </div>

                {/* Sender Row */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '13.5px' }}>
                  <span style={{ color: '#8e9aa8' }}>Sender</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'white', fontWeight: '700' }}>
                    <div style={{ 
                      width: '18px', 
                      height: '18px', 
                      borderRadius: '50%', 
                      background: 'black', 
                      color: 'white', 
                      display: 'flex', 
                      alignItems: 'center', 
                      justifyContent: 'center', 
                      fontSize: '9px', 
                      fontWeight: '800', 
                      fontStyle: 'italic', 
                      fontFamily: '"Georgia", serif' 
                    }}>
                      paj
                    </div>
                    <span>Paj Cash</span>
                  </div>
                </div>

                {sig && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '11px', borderTop: '1px solid rgba(255, 255, 255, 0.05)', paddingTop: '12px', marginTop: '4px' }}>
                    <span style={{ color: '#8e9aa8' }}>Tx Signature</span>
                    <a
                      href={`https://solscan.io/tx/${sig}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: 'var(--lime)', fontFamily: 'var(--mono)', textDecoration: 'underline' }}
                    >
                      {sig.slice(0, 12)}...
                    </a>
                  </div>
                )}
              </div>

              {/* Close Button */}
              <button 
                className="send-btn" 
                onClick={() => setSelectedLog(null)} 
                style={{ 
                  width: '100%', 
                  padding: '14px', 
                  borderRadius: '13px', 
                  background: 'var(--lime)', 
                  border: 'none', 
                  color: '#0a1628', 
                  fontSize: '15px', 
                  fontWeight: 'bold', 
                  cursor: 'pointer',
                  boxShadow: '0 4px 12px rgba(74, 222, 128, 0.15)',
                  transition: 'background 0.2s, transform 0.1s, opacity 0.15s'
                }}
                onMouseEnter={e => {
                  e.currentTarget.style.background = 'var(--lime2)';
                  e.currentTarget.style.transform = 'translateY(-1px)';
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.background = 'var(--lime)';
                  e.currentTarget.style.transform = 'translateY(0)';
                }}
              >
                Done
              </button>
            </div>
          </div>
        );
      })()}

      {/* ── QR Scanner ── */}
      {scannerActive && (
        <div className="p2p-success-overlay" style={{ zIndex: 1100 }}>
          <div className="p2p-success-card" style={{ maxWidth: '360px', width: '90%', padding: '20px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <h3 className="p2p-success-title" style={{ fontSize: '15px', color: 'white', marginBottom: '12px', fontWeight: 'bold' }}>Scan Account Number</h3>
            <p className="p2p-success-sub" style={{ fontSize: '11px', color: 'var(--text3)', marginBottom: '16px', textAlign: 'center', fontWeight: 'normal' }}>
              {ocrStatus || 'Point camera at a printed or written 10-digit account number.'}
            </p>
            <div style={{ position: 'relative', width: '260px', height: '260px', background: '#000', borderRadius: '12px', overflow: 'hidden', border: '2px solid var(--border)' }}>
              <video ref={videoRef} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              <canvas ref={canvasRef} style={{ display: 'none' }} />
              <div style={{ position: 'absolute', top: '20px', left: '20px', right: '20px', bottom: '20px', border: '2px dashed var(--lime)', opacity: 0.7, pointerEvents: 'none', borderRadius: '8px' }}>
                <div style={{ position: 'absolute', left: 0, right: 0, height: '2px', background: 'var(--lime)', boxShadow: '0 0 8px var(--lime)', animation: 'p2pScanLine 2s linear infinite' }} />
              </div>
            </div>
            <button className="send-btn" onClick={stopScanner} style={{ marginTop: '1.25rem', background: 'rgba(255,255,255,0.08)', color: 'white' }}>
              Cancel
            </button>
            <style>{`@keyframes p2pScanLine { 0% { top:0% } 50% { top:100% } 100% { top:0% } }`}</style>
          </div>
        </div>
      )}

    </div>
  );
}
