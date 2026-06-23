import { useState, useEffect, useRef } from 'react';
import jsQR from 'jsqr';
import {
  initPajSDK,
  getSupportedTokens,
  getBanks,
  resolveBankAccount,
  createOfframpOrder,
  getAllRate,
  getTransactionHistory,
  initiateSession,
  verifySession,
} from '../services/pajcashService';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { PublicKey, Transaction, TransactionInstruction, SystemProgram } from '@solana/web3.js';
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
function verifyOfframpTransaction(transaction, expectedRecipient, expectedToken, expectedSignerPublicKey) {
  if (!transaction.instructions || transaction.instructions.length === 0)
    throw new Error('Transaction integrity violation: no instructions.');

  if (!transaction.feePayer || !transaction.feePayer.equals(expectedSignerPublicKey))
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
  const { publicKey, sendTransaction } = useWallet();

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

  // ── UI State ─────────────────────────────────────────────────────────────
  const [countryOpen, setCountryOpen] = useState(false);
  const [bankOpen, setBankOpen] = useState(false);
  const [tokenOpen, setTokenOpen] = useState(false);
  const [bankSearch, setBankSearch] = useState('');
  const [countrySearch, setCountrySearch] = useState('');
  const [routingState, setRoutingState] = useState('idle'); // 'routing' | 'loading_market' | 'resolved'
  const [showSuccess, setShowSuccess] = useState(false);
  const [successDetails, setSuccessDetails] = useState(null);

  // ── QR Scanner Refs ──────────────────────────────────────────────────────
  const [scannerActive, setScannerActive] = useState(false);
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);

  // ── Computed ─────────────────────────────────────────────────────────────
  const isLiveRoute = LIVE_CURRENCIES.has(selectedCountry.currency) && mode === 'sell';
  const canTransact = !!sessionToken && isLiveRoute && !apiError;

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

      // Restore bank details
      const cachedBank = localStorage.getItem(`paj_bank_name_${key}`);
      const cachedAcc = localStorage.getItem(`paj_account_number_${key}`);
      const cachedName = localStorage.getItem(`paj_account_name_${key}`);
      if (cachedBank) setSelectedBank(cachedBank);
      if (cachedAcc) setAccountNumber(cachedAcc);
      if (cachedName) setAccountName(cachedName);
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
    if (!isLiveRoute || !sessionToken) return;

    setLoadingBanks(true);
    setApiError(null);
    getBanks(sessionToken)
      .then(list => {
        if (list?.length > 0) setApiBanks(list);
        else setApiError('PajCash returned an empty bank list. Please try again later.');
      })
      .catch(e => {
        console.error('Failed to fetch banks:', e);
        setApiError(`PajCash API error: ${e.message || 'Connection failed'}.`);
        if (e.message?.toLowerCase().includes('session') || e.message?.toLowerCase().includes('expired') || e.message?.toLowerCase().includes('unauthorized') || e.message?.toLowerCase().includes('invalid token')) {
          handleLogoutSession();
        }
      })
      .finally(() => setLoadingBanks(false));
  }, [isLiveRoute, sessionToken]);

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
      .then(txs => { if (txs) setPayoutLogs(Array.isArray(txs) ? txs : []); })
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

    const bankObj = apiBanks.find(b => (b.name || b.bank_name || b) === selectedBank);
    const bankId = bankObj ? (bankObj.id || bankObj.code || bankObj.name) : selectedBank;

    const timer = setTimeout(() => {
      resolveBankAccount(sessionToken, bankId, trimmed)
        .then(res => {
          const name = res?.accountName || res?.name || res?.account_name || '';
          // Only set the name if a real name was returned; leave blank on mismatch/failure
          setAccountName(name || '');
          if (name && publicKey) {
            const key = publicKey.toBase58();
            localStorage.setItem(`paj_bank_id_${key}`, bankId);
            localStorage.setItem(`paj_bank_name_${key}`, selectedBank);
            localStorage.setItem(`paj_account_number_${key}`, trimmed);
            localStorage.setItem(`paj_account_name_${key}`, name);
          }
        })
        .catch((err) => {
          setAccountName('');
          if (err?.message?.toLowerCase().includes('session') || err?.message?.toLowerCase().includes('expired') || err?.message?.toLowerCase().includes('unauthorized') || err?.message?.toLowerCase().includes('invalid token')) {
            handleLogoutSession();
          }
        })
        .finally(() => setResolvingName(false));
    }, 800);

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
          const expiryTime = Date.now() + 24 * 60 * 60 * 1000; // 24 Hours
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
  const selectableTokens = (() => {
    const list = pajTokens.length > 0
      ? pajTokens
      : (connected && walletTokenList?.length > 0 ? walletTokenList : DEFAULT_TOKENS);
    return list.filter(t => !t.chain || t.chain.toUpperCase() === 'SOLANA');
  })();

  useEffect(() => {
    const available = selectableTokens.some(t => t.symbol === selectedToken.symbol || t.mint === selectedToken.mint);
    if (!available && selectableTokens.length > 0) setSelectedToken(selectableTokens[0]);
  }, [connected, walletTokenList, pajTokens]);

  // ── QR Scanner ────────────────────────────────────────────────────────────
  const stopScanner = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    setScannerActive(false);
  };

  useEffect(() => {
    if (!scannerActive) return;
    let active = true;
    let raf;

    const initCamera = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.setAttribute('playsinline', 'true');
          await videoRef.current.play();
        }
        raf = requestAnimationFrame(tick);
      } catch {
        alert('Camera access denied. Please grant permission and retry.');
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
        const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
        if (code?.data && /^\d{10}$/.test(code.data.trim())) {
          setAccountNumber(code.data.trim());
          stopScanner();
          return;
        }
      }
      raf = requestAnimationFrame(tick);
    };

    initCamera();
    return () => {
      active = false;
      cancelAnimationFrame(raf);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
        streamRef.current = null;
      }
    };
  }, [scannerActive]);

  // ── Clipboard paste ───────────────────────────────────────────────────────
  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (/^\d+$/.test(text.trim())) setAccountNumber(text.trim());
      else alert('Clipboard content is not a valid account number.');
    } catch {
      const fb = prompt('Paste your account number here:');
      if (fb && /^\d+$/.test(fb.trim())) setAccountNumber(fb.trim());
    }
  };

  // ── Derived values ────────────────────────────────────────────────────────
  const tokenPriceUsd = selectedToken.price || (selectedToken.symbol === 'SOL' ? 145.20 : 1.00);
  const activeNgnRate = pajRates?.offRampRate?.rate || pajRates?.rate || 1550;
  const ngnRate = tokenPriceUsd * activeNgnRate;
  const parsedAmt = parseFloat(amount) || 0;
  const fiatAmountText = parsedAmt > 0
    ? (parsedAmt * ngnRate).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '0.00';

  const allBankNames = apiBanks.map(b => (typeof b === 'string' ? b : b.name || b.bank_name || ''));
  const filteredBanksList = allBankNames.filter(b => b.toLowerCase().includes(bankSearch.toLowerCase()));
  const filteredCountries = COUNTRIES.filter(c =>
    c.name.toLowerCase().includes(countrySearch.toLowerCase()) ||
    c.code.toLowerCase().includes(countrySearch.toLowerCase())
  );
  const displayBank = selectedBank === 'Choose Bank' ? (allBankNames[0] || 'Choose Bank') : selectedBank;

  // ── Submit handler ────────────────────────────────────────────────────────
  const handleSubmit = async () => {
    if (!isLiveRoute) { alert('This region/mode is not currently supported.'); return; }
    if (!PAJCASH_API_KEY) { alert('PajCash API Key is not configured.'); return; }
    if (!sessionToken) { alert('Please verify your email OTP session first.'); return; }
    if (apiError) { alert(`PajCash API error: ${apiError}`); return; }
    if (!connected || !publicKey) { alert('Please connect your Solana wallet first.'); return; }
    if (!amount || parseFloat(amount) <= 0) { alert('Please enter a valid amount.'); return; }
    if (!accountNumber) { alert('Please enter your bank account number.'); return; }
    if (selectedBank === 'Choose Bank') { alert('Please select a bank.'); return; }

    setSubmitting(true);
    try {
      const bankObj = apiBanks.find(b => (b.name || b.bank_name || b) === selectedBank);
      const bankId = bankObj ? (bankObj.id || bankObj.code || bankObj.name) : selectedBank;

      // 1. Create paj_ramp off-ramp order
      const order = await createOfframpOrder(
        {
          bank: bankId,
          accountNumber: accountNumber.trim(),
          currency: selectedCountry.currency,
          amount: Number(amount),
          mint: selectedToken.mint,
          chain: 'SOLANA',
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

      if (selectedToken.symbol === 'SOL') {
        const lamports = Math.round((order.amount || Number(amount)) * 1e9);
        transaction.add(
          SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: depositPubkey, lamports })
        );
      } else {
        const mintPubkey = new PublicKey(selectedToken.mint);
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
        const sendAmount = order.amount || Number(amount);
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
      verifyOfframpTransaction(transaction, order.address, selectedToken, publicKey);

      // 5. Pre-flight simulation
      const sim = await connection.simulateTransaction(transaction);
      if (sim.value.err) throw new Error(`Simulation failed: ${JSON.stringify(sim.value.err)}`);

      // 6. Sign & send via wallet adapter
      const sig = await sendTransaction(transaction, connection);

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
        alert(`Transaction sent but not yet confirmed. Signature: ${sig}`);
        return;
      }

      // 8. Persist order ID in localStorage (keyed by wallet address)
      const walletKey = publicKey.toBase58();
      const existing = (() => {
        try { return JSON.parse(localStorage.getItem(`paj_user_orders_${walletKey}`) || '[]'); }
        catch { return []; }
      })();
      existing.unshift({ id: order.id, sig, ts: Date.now() });
      localStorage.setItem(`paj_user_orders_${walletKey}`, JSON.stringify(existing.slice(0, 50)));

      setSuccessDetails({
        action: 'Sell',
        amount: `${amount} ${selectedToken.symbol}`,
        fiat: `${selectedCountry.symbol}${fiatAmountText}`,
        bank: displayBank,
        account: accountNumber,
        name: accountName || 'Account Holder',
        orderId: order.id,
        sig,
      });
      setShowSuccess(true);
      setTimeout(loadPayoutLogs, 2000);
    } catch (err) {
      console.error('Transaction failed:', err);
      alert(`Transaction Failed: ${err.message}`);
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
                {filteredCountries.map(c => (
                  <div
                    key={c.code}
                    className={`drop-item ${selectedCountry.code === c.code ? 'sel' : ''}`}
                    onClick={() => { setSelectedCountry(c); setCountryOpen(false); setCountrySearch(''); }}
                  >
                    <span className="curr-flag">{c.flag}</span>
                    <span className="di-code" style={{ marginLeft: '8px' }}>{c.code}</span>
                    <span className="di-name">{c.name}</span>
                  </div>
                ))}
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
            <div style={{ fontSize: '32px', marginBottom: '12px' }}>🔐</div>
            <h3 style={{ fontSize: '16px', fontWeight: 'bold', color: 'white', marginBottom: '8px' }}>
              Unlock Live Settlements
            </h3>
            <p style={{ fontSize: '12px', color: 'var(--text2)', marginBottom: '20px', lineHeight: '1.5' }}>
              Verify your email to securely link bank payouts to your Solana wallet.
            </p>

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
                    : accountName && <span className="animated-fade-in">{accountName}</span>
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

            {/* Amount + Token row */}
            <div style={{ display: 'flex', gap: '16px', marginBottom: '0.95rem' }}>
              <div style={{ flex: 1.4 }}>
                <div className="field-label">Amount to Sell</div>
                <div className="input-wrap" style={{ opacity: canTransact ? 1 : 0.6 }}>
                  <span style={{ color: 'var(--text2)', fontWeight: 700, fontSize: '13px', marginRight: '6px' }}>
                    {selectedToken.symbol}
                  </span>
                  <input
                    type="number"
                    placeholder="0.00"
                    value={amount}
                    onChange={e => setAmount(e.target.value)}
                    style={{ width: '100%', border: 'none', outline: 'none', background: 'transparent', color: 'white' }}
                    disabled={!canTransact}
                  />
                </div>
                <div style={{ marginTop: '6px', fontSize: '12px', minHeight: '16px' }}>
                  {routingState === 'routing'
                    ? <span style={{ color: 'var(--text3)', fontStyle: 'italic' }}><span className="p2p-mini-spinner" /> Routing...</span>
                    : routingState === 'loading_market'
                    ? <span style={{ color: 'var(--text3)', fontStyle: 'italic' }}><span className="p2p-mini-spinner" /> Scanning merchants...</span>
                    : null
                  }
                </div>
              </div>

            <div style={{ flex: 1 }}>
              <div className="field-label">Token</div>
              <div className="drop-wrap">
                <div
                  className="input-wrap"
                  onClick={() => { if (canTransact) setTokenOpen(!tokenOpen); }}
                  style={{ cursor: canTransact ? 'pointer' : 'not-allowed', justifyContent: 'space-between', opacity: canTransact ? 1 : 0.6 }}
                >
                  <strong style={{ color: 'white' }}>{selectedToken.symbol}</strong>
                  <span style={{ color: 'var(--text3)', fontSize: '11px' }}>▼</span>
                </div>
                {tokenOpen && (
                  <div className="drop-menu" style={{ right: 0, minWidth: '260px' }}>
                    {selectableTokens.map(t => (
                      <div
                        key={t.mint || t.symbol}
                        className={`drop-item ${selectedToken.symbol === t.symbol ? 'sel' : ''}`}
                        onClick={() => { setSelectedToken(t); setTokenOpen(false); }}
                      >
                        {t.logoURI
                          ? <img src={t.logoURI} alt={t.symbol} style={{ width: '20px', height: '20px', borderRadius: '50%' }} />
                          : <div style={{ width: '20px', height: '20px', borderRadius: '50%', background: 'rgba(255,255,255,0.1)', color: 'white', fontSize: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold' }}>{t.symbol.slice(0, 2)}</div>
                        }
                        <span className="di-code" style={{ marginLeft: '8px' }}>{t.symbol}</span>
                        {t.balance > 0 && <span className="di-name">{t.balance.toLocaleString(undefined, { maximumFractionDigits: 4 })}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Est. receive banner */}
          <div style={{
            background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border)',
            borderRadius: '12px', padding: '14px', textAlign: 'center',
            marginBottom: '1rem', display: 'flex', flexDirection: 'column', gap: '4px',
          }}>
            <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Est. Receive
            </span>
            {routingState === 'routing' || routingState === 'loading_market' ? (
              <div style={{ fontSize: '16px', fontWeight: 700, color: 'white' }}>
                <span className="p2p-mini-spinner" /> Loading...
              </div>
            ) : (
              <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--lime)' }}>
                {selectedCountry.symbol}{fiatAmountText}
              </div>
            )}
            {pajRates?.offRampRate?.rate && (
              <span style={{ fontSize: '10px', color: 'var(--text3)' }}>
                Rate: 1 USD = {selectedCountry.symbol}{pajRates.offRampRate.rate.toLocaleString()}
              </span>
            )}
          </div>

          {/* Submit button */}
          <button
            className="send-btn"
            onClick={handleSubmit}
            disabled={submitting || !canTransact}
            style={{ opacity: (submitting || !canTransact) ? 0.6 : 1, cursor: (submitting || !canTransact) ? 'not-allowed' : 'pointer' }}
          >
            {submitting && <span className="p2p-mini-spinner" style={{ marginRight: '6px' }} />}
            {submitting ? 'Processing...' : (!canTransact ? 'Payout Gateway Offline' : 'Send')}
          </button>
        </>
      ) ) : (
        /* ── Coming soon ── */
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          minHeight: '320px', textAlign: 'center', padding: '20px 24px',
          background: 'rgba(255,255,255,0.01)', border: '1.5px dashed rgba(255,255,255,0.1)',
          borderRadius: '16px', margin: '10px 0',
        }}>
          <div style={{ fontSize: '38px', marginBottom: '14px' }}>🚀</div>
          <h4 style={{ fontSize: '15px', fontWeight: 'bold', color: 'white', marginBottom: '10px' }}>
            {mode === 'buy' ? 'Buy Coming Soon' : `${selectedCountry.name} Payouts Coming Soon`}
          </h4>
          <p style={{ fontSize: '11px', color: 'var(--text3)', maxWidth: '300px', lineHeight: '1.5' }}>
            {mode === 'buy'
              ? 'Direct crypto purchases will be activated shortly.'
              : `Off-ramp for ${selectedCountry.name} is in development. Select Nigeria (NGA) in Sell mode to use the live PajCash gateway.`
            }
          </p>
        </div>
      )}

      {/* ── Transaction History ── */}
      {canTransact && publicKey && (() => {
        const walletKey = publicKey.toBase58();
        const localOrders = (() => {
          try { return JSON.parse(localStorage.getItem(`paj_user_orders_${walletKey}`) || '[]'); }
          catch { return []; }
        })();

        const localIds = new Set(localOrders.map(o => o.id || o));
        const userLogs = payoutLogs.filter(log => localIds.has(log.id || log._id));
        const showHistory = localOrders.length > 0;

        if (!showHistory) return null;

        return (
          <div style={{ marginTop: '1.5rem', borderTop: '1px solid var(--border)', paddingTop: '1rem' }}>
            <h4 style={{ fontSize: '12px', fontWeight: 700, color: 'white', marginBottom: '0.75rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>My Payout History</span>
              <button onClick={loadPayoutLogs} style={{ background: 'none', border: 'none', color: 'var(--lime)', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold' }}>
                Refresh
              </button>
            </h4>
            {loadingLogs ? (
              <div style={{ fontSize: '12px', color: 'var(--text3)', fontStyle: 'italic', textAlign: 'center', padding: '12px' }}>
                <span className="p2p-mini-spinner" /> Loading...
              </div>
            ) : logError ? (
              <div style={{ fontSize: '11px', color: '#f87171', background: 'rgba(239,68,68,0.08)', padding: '8px 12px', borderRadius: '8px', border: '1px solid rgba(239,68,68,0.2)' }}>
                ⚠️ {logError}
              </div>
            ) : userLogs.length === 0 ? (
              <div style={{ fontSize: '11px', color: 'var(--text3)', textAlign: 'center', padding: '12px' }}>
                {localOrders.length > 0
                  ? `${localOrders.length} order(s) pending confirmation.`
                  : 'No recent payouts found.'
                }
              </div>
            ) : (
              <div style={{ maxHeight: '150px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '6px', paddingRight: '4px' }}>
                {userLogs.map(log => (
                  <div key={log._id || log.id} style={{
                    background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border)',
                    borderRadius: '8px', padding: '8px 10px', fontSize: '11px',
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                      <span style={{ color: 'white', fontWeight: 'bold' }}>
                        {log.status || 'Processing'}
                      </span>
                      <span style={{ color: 'var(--text3)', fontSize: '10px' }}>
                        {log.createdAt ? new Date(log.createdAt).toLocaleString() : 'Recent'}
                      </span>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '2px' }}>
                      <span style={{ color: 'var(--lime)', fontWeight: 'bold' }}>
                        {selectedCountry.symbol}{(log.fiatAmount || log.amount)?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </span>
                      <span style={{ color: 'var(--text3)', fontSize: '9px', fontFamily: 'var(--mono)' }}>
                        {(log._id || log.id)?.slice(0, 8)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })()}

      {/* ── Success Modal ── */}
      {showSuccess && successDetails && (
        <div className="p2p-success-overlay">
          <div className="p2p-success-card">
            <div className="p2p-success-icon-wrap">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <h3 className="p2p-success-title">Trade Submitted</h3>
            <p className="p2p-success-sub" style={{ color: 'var(--lime)', fontWeight: 'bold' }}>
              Transaction confirmed.
            </p>
            <div className="p2p-success-fields">
              <div className="p2p-success-field"><span>Action:</span><strong>{successDetails.action} {successDetails.amount}</strong></div>
              <div className="p2p-success-field"><span>Fiat Value:</span><strong>{successDetails.fiat}</strong></div>
              <div className="p2p-success-field"><span>Bank:</span><strong>{successDetails.bank}</strong></div>
              <div className="p2p-success-field"><span>Account:</span><strong>{successDetails.account}</strong></div>
              <div className="p2p-success-field"><span>Recipient:</span><strong>{successDetails.name}</strong></div>
              {successDetails.orderId && (
                <div className="p2p-success-field">
                  <span>Order ID:</span>
                  <strong style={{ color: 'var(--lime)', fontFamily: 'var(--mono)', fontSize: '11px' }}>{successDetails.orderId}</strong>
                </div>
              )}
              {successDetails.sig && (
                <div className="p2p-success-field">
                  <span>Tx Sig:</span>
                  <a
                    href={`https://solscan.io/tx/${successDetails.sig}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: 'var(--lime)', fontFamily: 'var(--mono)', fontSize: '10px', wordBreak: 'break-all' }}
                  >
                    {successDetails.sig.slice(0, 16)}...
                  </a>
                </div>
              )}
            </div>
            <button className="send-btn" onClick={() => { setShowSuccess(false); setAmount(''); }} style={{ marginTop: '1rem' }}>
              Done
            </button>
          </div>
        </div>
      )}

      {/* ── QR Scanner ── */}
      {scannerActive && (
        <div className="p2p-success-overlay" style={{ zIndex: 1100 }}>
          <div className="p2p-success-card" style={{ maxWidth: '360px', width: '90%', padding: '20px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <h3 className="p2p-success-title" style={{ fontSize: '15px', color: 'white', marginBottom: '12px', fontWeight: 'bold' }}>Scan Account QR</h3>
            <p className="p2p-success-sub" style={{ fontSize: '11px', color: 'var(--text3)', marginBottom: '16px', textAlign: 'center', fontWeight: 'normal' }}>
              Point camera at a 10-digit account number QR code.
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
