import { useState, useEffect, useRef } from 'react';
import jsQR from 'jsqr';
import { 
  initPajSDK,
  getSupportedTokens, 
  getBanks, 
  resolveBankAccount, 
  createOfframpOrder, 
  getAllRate, 
  getTransactionHistory 
} from '../services/pajcashService';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { PublicKey, Transaction, TransactionInstruction, SystemProgram } from '@solana/web3.js';
import { 
  getAssociatedTokenAddressSync, 
  createAssociatedTokenAccountIdempotentInstruction, 
  createTransferCheckedInstruction,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID
} from '@solana/spl-token';

const COUNTRIES = [
  { code: 'NGA', name: 'Nigeria', flag: '🇳🇬', symbol: '₦' },
  { code: 'USA', name: 'United States', flag: '🇺🇸', symbol: '$' },
  { code: 'GBR', name: 'United Kingdom', flag: '🇬🇧', symbol: '£' },
  { code: 'EUR', name: 'Europe', flag: '🇪🇺', symbol: '€' },
  { code: 'CAN', name: 'Canada', flag: '🇨🇦', symbol: '$' },
  { code: 'AUS', name: 'Australia', flag: '🇦🇺', symbol: '$' },
  { code: 'KEN', name: 'Kenya', flag: '🇰🇪', symbol: 'Sh' },
  { code: 'GHA', name: 'Ghana', flag: '🇬🇭', symbol: '₵' },
  { code: 'IND', name: 'India', flag: '🇮🇳', symbol: '₹' },
  { code: 'ZAF', name: 'South Africa', flag: '🇿🇦', symbol: 'R' },
  { code: 'BRA', name: 'Brazil', flag: '🇧🇷', symbol: 'R$' },
  { code: 'JPN', name: 'Japan', flag: '🇯🇵', symbol: '¥' }
];

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
    // Sluggify for traditional commercial banks to map to Paystack HQ CDN
    let slug = clean
      .replace('guaranty trust bank', 'guaranty_trust_bank')
      .replace('gtbank', 'guaranty_trust_bank')
      .replace('first bank of nigeria', 'first_bank')
      .replace('firstbank', 'first_bank')
      .replace('united bank for africa', 'united_bank_for_africa')
      .replace('uba', 'united_bank_for_africa')
      .replace('stanbic ibtc', 'stanbic_ibtc')
      .replace('sterling bank', 'sterling_bank')
      .replace('fidelity bank', 'fidelity_bank')
      .replace('union bank', 'union_bank')
      .replace('wema bank', 'wema_bank')
      .replace('zenith bank', 'zenith_bank')
      .replace('access bank', 'access_bank')
      .replace('keystone bank', 'keystone_bank')
      .replace('polaris bank', 'polaris_bank')
      .replace(/\s+/g, '_')
      .replace(/[^a-z0-9_]/g, '');
      
    logo = `https://raw.githubusercontent.com/PaystackHQ/nigerialogos/master/public/logos/${slug}/${slug}.svg`;
  }

  const initials = bankName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  let hash = 0;
  for (let i = 0; i < bankName.length; i++) {
    hash = bankName.charCodeAt(i) + ((hash << 5) - hash);
  }
  const color = `hsl(${Math.abs(hash % 360)}, 65%, 40%)`;
  return { name: bankName, logo, color, initial: initials || 'BK' };
};

const DEFAULT_TOKENS = [
  { symbol: 'USDC', name: 'USD Coin', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png', balance: 0 },
  { symbol: 'SOL', name: 'Solana', mint: 'So11111111111111111111111111111111111111112', logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png', balance: 0 },
  { symbol: 'USDT', name: 'Tether', mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB/logo.png', balance: 0 }
];

const ALLOWED_PROGRAM_IDS = new Set([
  '11111111111111111111111111111111',                         // System Program
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',           // SPL Token Program
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',           // Token-2022 Program
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1brs',          // Associated Token Program
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',           // SPL Memo Program
]);

const ALLOWED_TOKEN_OPCODES = new Set([12]); // TransferChecked only
const ALLOWED_ATA_OPCODES = new Set([1]); // CreateAssociatedTokenAccountIdempotent only

function verifyOfframpTransaction(transaction, expectedRecipient, expectedAmount, expectedToken, expectedSignerPublicKey) {
  if (!transaction.instructions || transaction.instructions.length === 0) {
    throw new Error('Transaction integrity violation: Transaction contains no instructions.');
  }

  if (!transaction.feePayer) {
    throw new Error('Transaction integrity violation: Transaction has no fee payer set.');
  }
  if (!transaction.feePayer.equals(expectedSignerPublicKey)) {
    throw new Error(
      `Transaction integrity violation: Fee payer mismatch. ` +
      `Expected ${expectedSignerPublicKey.toBase58()}, got ${transaction.feePayer.toBase58()}.`
    );
  }

  let transferCheckedCount = 0;
  let systemTransferCount = 0;

  for (const ix of transaction.instructions) {
    const programIdStr = ix.programId.toBase58();

    if (!ALLOWED_PROGRAM_IDS.has(programIdStr)) {
      throw new Error(`Transaction integrity violation: Instruction from disallowed program ${programIdStr}.`);
    }

    if (programIdStr === '11111111111111111111111111111111') {
      const data = ix.data;
      const type = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true);
      if (type !== 2) {
        throw new Error('Transaction integrity violation: Unexpected System Program instruction type.');
      }
      
      const toPubkeyStr = ix.keys[1].pubkey.toBase58();
      const dataView = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const lamports = dataView.getBigUint64(4, true);

      if (toPubkeyStr !== expectedRecipient) {
        throw new Error(`Transaction integrity violation: Unexpected SOL transfer destination: ${toPubkeyStr}.`);
      }
      if (expectedToken.symbol !== 'SOL') {
        throw new Error('Transaction integrity violation: Transferring SOL instead of the selected token.');
      }
      systemTransferCount++;
    } else if (programIdStr === 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr') {
      // Memo is safe
    } else if (programIdStr === 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1brs') {
      const ixType = ix.data[0];
      if (!ALLOWED_ATA_OPCODES.has(ixType)) {
        throw new Error(`Transaction integrity violation: Disallowed ATA instruction opcode ${ixType}.`);
      }
    } else if (
      programIdStr === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' || 
      programIdStr === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
    ) {
      const ixType = ix.data[0];

      if (!ALLOWED_TOKEN_OPCODES.has(ixType)) {
        throw new Error(`Transaction integrity violation: Disallowed Token instruction opcode ${ixType}.`);
      }

      if (ix.data.length < 10) {
        throw new Error('Transaction integrity violation: TransferChecked instruction data too short.');
      }

      const mint = ix.keys[1].pubkey.toBase58();
      const destinationATA = ix.keys[2].pubkey.toBase58();
      const ownerKey = ix.keys[3]?.pubkey.toBase58();

      const dataView = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength);
      const amount = dataView.getBigUint64(1, true);

      if (mint !== expectedToken.mint) {
        throw new Error(`Transaction integrity violation: Token mint mismatch. Expected ${expectedToken.mint}, got ${mint}.`);
      }

      const expectedATA = getAssociatedTokenAddressSync(
        new PublicKey(mint),
        new PublicKey(expectedRecipient),
        false,
        ix.programId
      ).toBase58();

      if (destinationATA !== expectedATA) {
        throw new Error(`Transaction integrity violation: Destination ATA mismatch.`);
      }

      if (ownerKey && ownerKey !== expectedSignerPublicKey.toBase58()) {
        throw new Error(`Transaction integrity violation: Owner authority mismatch.`);
      }

      if (amount === 0n) {
        throw new Error('Transaction integrity violation: Zero amount transfer.');
      }

      transferCheckedCount++;
    }
  }

  const expectedTotal = expectedToken.symbol === 'SOL' ? systemTransferCount : transferCheckedCount;
  if (expectedTotal === 0) {
    throw new Error('Transaction integrity violation: No valid transfer instruction found.');
  }
}

export default function P2PPanel({ connected, walletTokenList }) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();

  const [mode, setMode] = useState('sell'); // 'sell' or 'buy'
  const [selectedCountry, setSelectedCountry] = useState(COUNTRIES[0]);
  const [accountNumber, setAccountNumber] = useState('');

  // QR Code Scanner State & Refs
  const [scannerActive, setScannerActive] = useState(false);
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const [accountName, setAccountName] = useState('');
  const [selectedBank, setSelectedBank] = useState('Choose Bank');
  const [amount, setAmount] = useState('');
  const [selectedToken, setSelectedToken] = useState(DEFAULT_TOKENS[0]);

  // PajCash configuration detection
  const PAJCASH_API_KEY = import.meta.env.VITE_PAJCASH_API_KEY;
  const isPajcashLive = !!PAJCASH_API_KEY;

  // Dynamic tokens, logs, and errors
  const [pajTokens, setPajTokens] = useState([]);
  const [payoutLogs, setPayoutLogs] = useState([]);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [logError, setLogError] = useState(null);
  const [bankSearch, setBankSearch] = useState('');
  const [countrySearch, setCountrySearch] = useState('');
  const [apiBanks, setApiBanks] = useState([]);
  const [loadingBanks, setLoadingBanks] = useState(false);
  const [apiError, setApiError] = useState(null);

  // Live exchange rate quote state
  const [pajRates, setPajRates] = useState(null);
  const [loadingRates, setLoadingRates] = useState(false);

  // Success Pop-up state
  const [showSuccess, setShowSuccess] = useState(false);
  const [successDetails, setSuccessDetails] = useState(null);

  // Dropdown states
  const [countryOpen, setCountryOpen] = useState(false);
  const [bankOpen, setBankOpen] = useState(false);
  const [tokenOpen, setTokenOpen] = useState(false);

  // Routing & Loading states
  const [routingState, setRoutingState] = useState('idle'); // 'routing' | 'loading_market' | 'resolved'
  const [resolvingName, setResolvingName] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Live route determination
  const isLiveRoute = selectedCountry.code === 'NGA' && mode === 'sell';

  // Initialize SDK
  useEffect(() => {
    initPajSDK(import.meta.env.VITE_PAJCASH_ENV || 'production');
  }, []);

  // Initialize API and credential warnings
  useEffect(() => {
    if (!isPajcashLive && isLiveRoute) {
      setApiError("PajCash API Key is not configured. To enable live payouts, configure VITE_PAJCASH_API_KEY in Vercel.");
    } else {
      setApiError(null);
    }
  }, [isPajcashLive, isLiveRoute]);

  // Load cached bank details from local storage on wallet connection
  useEffect(() => {
    if (publicKey) {
      const cachedBankName = localStorage.getItem(`paj_bank_name_${publicKey}`);
      const cachedAccNum = localStorage.getItem(`paj_account_number_${publicKey}`);
      const cachedAccName = localStorage.getItem(`paj_account_name_${publicKey}`);

      if (cachedBankName) setSelectedBank(cachedBankName);
      if (cachedAccNum) setAccountNumber(cachedAccNum);
      if (cachedAccName) setAccountName(cachedAccName);
    } else {
      setSelectedBank('Choose Bank');
      setAccountNumber('');
      setAccountName('');
    }
  }, [publicKey]);

  // Load supported tokens from PajCash API on mount
  useEffect(() => {
    async function loadTokens() {
      try {
        const list = await getSupportedTokens();
        if (list && list.length > 0) {
          const mapped = list.map(t => ({
            symbol: t.symbol,
            name: t.name,
            mint: t.address,
            logoURI: t.logo || '',
            chain: t.chain,
            decimals: t.decimals || 6,
            balance: 0
          }));
          setPajTokens(mapped);
        }
      } catch (e) {
        console.error("Failed to load PajCash tokens:", e);
      }
    }
    loadTokens();
  }, []);

  // Fetch supported banks from PajCash API on mount/live route change
  useEffect(() => {
    async function fetchApiBanks() {
      if (!isLiveRoute || !isPajcashLive) return;
      setLoadingBanks(true);
      setApiError(null);
      try {
        const list = await getBanks(PAJCASH_API_KEY);
        if (list && list.length > 0) {
          setApiBanks(list);
        } else {
          setApiError("PajCash API returned an empty bank list.");
        }
      } catch (e) {
        console.error("Failed to fetch banks from PajCash API:", e);
        setApiError(`PajCash API connection failed: ${e.message || "Unauthorized / Connection Refused"}. Please check that your API Key is valid.`);
      } finally {
        setLoadingBanks(false);
      }
    }
    fetchApiBanks();
  }, [isPajcashLive, isLiveRoute, PAJCASH_API_KEY]);

  // Fetch payout logs when active
  const loadPayoutLogs = async () => {
    if (!isLiveRoute || !isPajcashLive) return;
    setLoadingLogs(true);
    setLogError(null);
    try {
      const txs = await getTransactionHistory(PAJCASH_API_KEY);
      if (txs) {
        setPayoutLogs(txs);
      }
    } catch (e) {
      console.error("Failed to load PajCash payouts logs:", e);
      setLogError(e.message || "Failed to retrieve live payout history.");
    } finally {
      setLoadingLogs(false);
    }
  };

  useEffect(() => {
    loadPayoutLogs();
  }, [isPajcashLive, isLiveRoute, PAJCASH_API_KEY]);

  // Fetch exchange rates from PajCash
  useEffect(() => {
    async function loadRates() {
      if (!isLiveRoute) return;
      setLoadingRates(true);
      try {
        const rates = await getAllRate();
        if (rates) {
          setPajRates(rates);
        }
      } catch (e) {
        console.error("Failed to fetch rates:", e);
      } finally {
        setLoadingRates(false);
      }
    }
    loadRates();
    const interval = setInterval(loadRates, 30000);
    return () => clearInterval(interval);
  }, [isLiveRoute]);

  // Resolve account name dynamically matching the country's localized naming style
  useEffect(() => {
    if (!accountNumber || selectedBank === 'Choose Bank' || !isPajcashLive) {
      setAccountName('');
      return;
    }
    
    const trimmedAcc = accountNumber.trim();
    if (selectedCountry.code === 'NGA' && trimmedAcc.length === 10) {
      setResolvingName(true);
      
      const bankObj = apiBanks.find(b => 
        (typeof b === 'string' ? b : b.name || b.bank_name) === selectedBank
      );
      const bankIdParam = bankObj ? (bankObj.id || bankObj.code || bankObj.name) : selectedBank;

      const t = setTimeout(async () => {
        try {
          const res = await resolveBankAccount(PAJCASH_API_KEY, bankIdParam, trimmedAcc);
          if (res && res.accountName) {
            setAccountName(res.accountName);
            if (publicKey) {
              localStorage.setItem(`paj_bank_id_${publicKey}`, bankIdParam);
              localStorage.setItem(`paj_bank_name_${publicKey}`, selectedBank);
              localStorage.setItem(`paj_account_number_${publicKey}`, trimmedAcc);
              localStorage.setItem(`paj_account_name_${publicKey}`, res.accountName);
            }
          } else if (res && typeof res === 'object' && (res.name || res.account_name)) {
            const resolvedName = res.name || res.account_name;
            setAccountName(resolvedName);
            if (publicKey) {
              localStorage.setItem(`paj_bank_id_${publicKey}`, bankIdParam);
              localStorage.setItem(`paj_bank_name_${publicKey}`, selectedBank);
              localStorage.setItem(`paj_account_number_${publicKey}`, trimmedAcc);
              localStorage.setItem(`paj_account_name_${publicKey}`, resolvedName);
            }
          } else {
            setAccountName('Beneficiary Account');
          }
        } catch (e) {
          console.error("Failed to resolve bank account name:", e);
          setAccountName('Beneficiary Account');
        } finally {
          setResolvingName(false);
        }
      }, 800);

      return () => clearTimeout(t);
    } else {
      setAccountName('');
    }
  }, [accountNumber, selectedCountry, selectedBank, apiBanks, isPajcashLive, PAJCASH_API_KEY]);

  // Reset fields when country or mode changes
  useEffect(() => {
    setSelectedBank('Choose Bank');
    setAccountNumber('');
    setAccountName('');
    setAmount('');
  }, [selectedCountry, mode]);

  // Fetch token list from props or defaults
  const getSelectableTokens = () => {
    let list = pajTokens.length > 0 ? pajTokens : (connected && walletTokenList && walletTokenList.length > 0 ? walletTokenList : DEFAULT_TOKENS);
    return list.filter(t => !t.chain || t.chain.toUpperCase() === 'SOLANA');
  };

  const selectableTokens = getSelectableTokens();

  // Adjust selected token if it is not available in the current list
  useEffect(() => {
    const list = getSelectableTokens();
    const isAvailable = list.some(t => t.symbol === selectedToken.symbol || t.mint === selectedToken.mint);
    if (!isAvailable && list.length > 0) {
      setSelectedToken(list[0]);
    }
  }, [connected, walletTokenList, pajTokens]);

  // Handle QR code scanning using camera and jsQR
  const stopScanner = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    setScannerActive(false);
  };

  useEffect(() => {
    if (!scannerActive) return;

    let active = true;
    let animationFrameId;

    async function initCamera() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' }
        });
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.setAttribute('playsinline', 'true');
          videoRef.current.play().catch(e => console.error("Play error:", e));
        }
        animationFrameId = requestAnimationFrame(tick);
      } catch (err) {
        console.error("Camera access failed:", err);
        alert("Could not access camera. Please ensure permissions are granted.");
        setScannerActive(false);
      }
    }

    function tick() {
      if (!active) return;

      const video = videoRef.current;
      const canvas = canvasRef.current;

      if (video && canvas && video.readyState === video.HAVE_ENOUGH_DATA) {
        const ctx = canvas.getContext('2d');
        canvas.height = video.videoHeight;
        canvas.width = video.videoWidth;

        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

        const code = jsQR(imageData.data, imageData.width, imageData.height, {
          inversionAttempts: 'dontInvert',
        });

        if (code && code.data) {
          const matched = code.data.trim();
          // Detect a 10 digit account number
          if (/^\d{10}$/.test(matched)) {
            setAccountNumber(matched);
            stopScanner();
            return;
          }
        }
      }

      animationFrameId = requestAnimationFrame(tick);
    }

    initCamera();

    return () => {
      active = false;
      cancelAnimationFrame(animationFrameId);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
        streamRef.current = null;
      }
    };
  }, [scannerActive]);

  // Handle Paste from Clipboard
  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text && /^\d+$/.test(text.trim())) {
        setAccountNumber(text.trim());
      } else {
        alert("Clipboard content is not a valid account number.");
      }
    } catch (err) {
      const fallback = prompt("Paste your account number here:");
      if (fallback && /^\d+$/.test(fallback.trim())) {
        setAccountNumber(fallback.trim());
      }
    }
  };

  // Trigger loading sequence on interactive changes (Token, Bank)
  useEffect(() => {
    setRoutingState('routing');
    const t1 = setTimeout(() => {
      setRoutingState('loading_market');
      const t2 = setTimeout(() => {
        setRoutingState('resolved');
      }, 800);
      return () => clearTimeout(t2);
    }, 800);
    return () => clearTimeout(t1);
  }, [selectedToken, selectedBank]);

  // Calculate NGN conversion values dynamically using live exchange rate quotes
  const tokenPriceUsd = selectedToken.price || (selectedToken.symbol === 'SOL' ? 145.20 : selectedToken.symbol === 'BONK' ? 0.000022 : 1.00);
  const activeNgnRate = pajRates?.offRampRate?.rate || 1500;
  const ngnRate = tokenPriceUsd * activeNgnRate;
  const parsedAmt = parseFloat(amount) || 0;
  
  const fiatAmountText = parsedAmt > 0 ? (parsedAmt * ngnRate).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00';

  const allBanksForCountry = apiBanks.map(b => typeof b === 'string' ? b : b.name || b.bank_name || '');
  const filteredBanksList = allBanksForCountry.filter(b => 
    b.toLowerCase().includes(bankSearch.toLowerCase())
  );

  const displayBank = selectedBank === 'Choose Bank' ? (allBanksForCountry[0] || 'Choose Bank') : selectedBank;

  // Filter country dropdown by search input
  const filteredCountries = COUNTRIES.filter(c => 
    c.name.toLowerCase().includes(countrySearch.toLowerCase()) ||
    c.code.toLowerCase().includes(countrySearch.toLowerCase())
  );

  // Handle transaction submission
  const handleSubmit = async () => {
    if (!isLiveRoute) {
      alert('This region/mode is not supported on the active gateway.');
      return;
    }
    if (!isPajcashLive || apiError) {
      alert('PajCash API is offline. Cannot process transactions.');
      return;
    }
    if (!connected || !publicKey) {
      alert('Please connect your Solana wallet first.');
      return;
    }
    if (!amount || parseFloat(amount) <= 0) {
      alert('Please enter a valid amount.');
      return;
    }
    if (!accountNumber) {
      alert('Please enter an account number.');
      return;
    }
    if (selectedBank === 'Choose Bank') {
      alert('Please select a bank.');
      return;
    }
    if (!accountName) {
      alert('Please wait for the account name to resolve.');
      return;
    }

    setSubmitting(true);
    try {
      const bankObj = apiBanks.find(b => 
        (typeof b === 'string' ? b : b.name || b.bank_name) === selectedBank
      );
      const bankIdParam = bankObj ? (bankObj.id || bankObj.code || bankObj.name) : selectedBank;

      const orderData = {
        bank: bankIdParam,
        accountNumber: accountNumber.trim(),
        currency: 'NGN',
        amount: Number(amount),
        mint: selectedToken.mint || 'So11111111111111111111111111111111111111112',
        chain: 'SOLANA',
        webhookURL: 'https://api.paj.cash/webhook',
      };

      // 1. Create PajCash Off-ramp Order
      const order = await createOfframpOrder(orderData, PAJCASH_API_KEY);
      if (!order || !order.address) {
        throw new Error('PajCash failed to generate a deposit address for this order.');
      }

      // 2. Build on-chain transaction
      const latestBlockhash = await connection.getLatestBlockhash('confirmed');
      const transaction = new Transaction();
      transaction.feePayer = publicKey;
      transaction.recentBlockhash = latestBlockhash.blockhash;

      const depositPublicKey = new PublicKey(order.address);

      if (selectedToken.symbol === 'SOL') {
        const lamports = BigInt(Math.round(order.amount * 1e9));
        transaction.add(
          SystemProgram.transfer({
            fromPubkey: publicKey,
            toPubkey: depositPublicKey,
            lamports: Number(lamports)
          })
        );
      } else {
        const mintPubkey = new PublicKey(selectedToken.mint);

        let tokenProgramId = TOKEN_PROGRAM_ID;
        try {
          const mintAcct = await connection.getAccountInfo(mintPubkey);
          if (mintAcct && mintAcct.owner.equals(TOKEN_2022_PROGRAM_ID)) {
            tokenProgramId = TOKEN_2022_PROGRAM_ID;
          }
        } catch (e) { }

        const senderATA = getAssociatedTokenAddressSync(mintPubkey, publicKey, false, tokenProgramId);
        const receiverATA = getAssociatedTokenAddressSync(mintPubkey, depositPublicKey, false, tokenProgramId);

        // Check if recipient's ATA needs to be created
        let needsAtaCreation = false;
        try {
          const ataInfo = await connection.getAccountInfo(receiverATA);
          if (!ataInfo) needsAtaCreation = true;
        } catch (e) {
          needsAtaCreation = true;
        }

        const mintInfo = await connection.getParsedAccountInfo(mintPubkey);
        if (!mintInfo.value) throw new Error('Invalid token mint');
        const decimals = mintInfo.value.data.parsed.info.decimals;
        const amountUnits = BigInt(Math.round(order.amount * Math.pow(10, decimals)));

        transaction.add(
          createAssociatedTokenAccountIdempotentInstruction(
            publicKey,
            receiverATA,
            depositPublicKey,
            mintPubkey,
            tokenProgramId
          )
        );

        transaction.add(
          createTransferCheckedInstruction(
            senderATA,
            mintPubkey,
            receiverATA,
            publicKey,
            amountUnits,
            decimals,
            [],
            tokenProgramId
          )
        );
      }

      // Add custom on-chain memo instruction
      const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
      transaction.add(
        new TransactionInstruction({
          keys: [],
          programId: MEMO_PROGRAM_ID,
          data: new TextEncoder().encode(`fiatwallet:pajcash:order:${order.id}`)
        })
      );

      // Auditing transaction before signature
      verifyOfframpTransaction(transaction, order.address, order.amount, selectedToken, publicKey);

      // Pre-flight simulation
      const simResult = await connection.simulateTransaction(transaction);
      if (simResult.value.err) {
        throw new Error(`Transaction simulation failed: ${JSON.stringify(simResult.value.err)}`);
      }

      // 3. Prompt user wallet adapter for signature and execution
      const signature = await sendTransaction(transaction, connection);

      // 5. Poll for confirmation
      let confirmed = false;
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        try {
          const status = await connection.getSignatureStatus(signature);
          const conf = status?.value?.confirmationStatus;
          if (conf === 'confirmed' || conf === 'finalized') {
            confirmed = true;
            break;
          }
          if (status?.value?.err) {
            throw new Error('Transaction rejected by network: ' + JSON.stringify(status.value.err));
          }
        } catch (pollErr) {
          if (pollErr.message.startsWith('Transaction rejected')) throw pollErr;
        }
        await new Promise(r => setTimeout(r, 2000));
      }

      if (confirmed) {
        // Cache order ID in local storage for user's transaction history retention
        const userOrderIds = (() => {
          try {
            const raw = localStorage.getItem(`paj_user_orders_${publicKey}`);
            return raw ? JSON.parse(raw) : [];
          } catch { return []; }
        })();
        userOrderIds.push(order.id);
        localStorage.setItem(`paj_user_orders_${publicKey}`, JSON.stringify(userOrderIds));

        setSuccessDetails({
          action: 'Sell',
          amount: `${amount} ${selectedToken.symbol}`,
          fiat: `₦${fiatAmountText}`,
          bank: displayBank,
          account: accountNumber,
          name: accountName,
          txId: order.id || 'N/A'
        });
        setShowSuccess(true);
        loadPayoutLogs();
      } else {
        alert(`Transaction submitted but confirmation timed out. Signature: ${signature}`);
      }
    } catch (err) {
      console.error(err);
      alert(`Transaction Failed: ${err.message}`);
    } finally {
      setSubmitting(false);
    }
  };

  if (!connected || !publicKey) {
    return (
      <div className="p2p-coming-soon-container" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '320px', textAlign: 'center', padding: '20px 24px', background: 'rgba(255, 255, 255, 0.01)', border: '1.5px dashed rgba(255, 255, 255, 0.1)', borderRadius: '16px', margin: '10px 0' }}>
        <div style={{ fontSize: '38px', marginBottom: '14px' }}>🔌</div>
        <h4 style={{ fontSize: '15px', fontWeight: 'bold', color: 'white', marginBottom: '10px' }}>
          Connect Your Wallet
        </h4>
        <p style={{ fontSize: '11px', color: 'var(--text3)', maxWidth: '300px', lineHeight: '1.5' }}>
          Please connect your Solana wallet using the button in the top-right corner to perform live off-ramp settlements.
        </p>
      </div>
    );
  }

  return (
    <div className="p2p-panel-wrap">
      
      {/* ── API Configuration Warning Banner ── */}
      {isLiveRoute && apiError && (
        <div style={{ background: 'rgba(239, 68, 68, 0.08)', border: '1px solid rgba(239, 68, 68, 0.2)', borderRadius: '12px', padding: '12px 14px', fontSize: '12px', color: '#f87171', marginBottom: '1.25rem', lineHeight: '1.5' }}>
          ⚠️ <strong>PajCash Payout Gateway Offline:</strong> {apiError}
        </div>
      )}

      {/* ── Mode Switch & Searchable Country selector ── */}
      <div className="p2p-header-row" style={{ marginBottom: '1.25rem' }}>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <div className="bulk-pill" onClick={() => setMode(mode === 'sell' ? 'buy' : 'sell')} style={{ padding: '6px 12px', cursor: 'pointer' }}>
            <span className="pill-txt" style={{ fontSize: '11px', fontWeight: 700, color: 'white' }}>
              {mode === 'sell' ? 'Sell' : 'Buy'}
            </span>
            <div className={`tsw ${mode === 'buy' ? 'on' : ''}`} style={{ marginLeft: '6px' }}><div className="tknob" /></div>
          </div>
          {isLiveRoute && isPajcashLive && !apiError && (
            <span style={{ fontSize: '10px', color: 'var(--lime)', background: 'rgba(74, 222, 128, 0.1)', padding: '4px 8px', borderRadius: '6px', fontWeight: 'bold' }}>
              ● Live Payouts
            </span>
          )}
        </div>

        <div className="p2p-country-selector" style={{ position: 'relative' }}>
          <div className="curr-selector" onClick={() => setCountryOpen(!countryOpen)}>
            <span className="curr-flag">{selectedCountry.flag}</span>
            <span style={{ marginLeft: '4px' }}>{selectedCountry.code}</span>
            <span className="curr-chevron" style={{ marginLeft: '6px' }}>▼</span>
          </div>

          {countryOpen && (
            <div className="drop-menu" style={{ right: 0, zIndex: 100, minWidth: '220px' }}>
              <div className="drop-search" style={{ padding: '8px', borderBottom: '1px solid var(--border)' }} onClick={e => e.stopPropagation()}>
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
                {filteredCountries.length === 0 && (
                  <div style={{ fontSize: '11px', color: 'var(--text3)', fontStyle: 'italic', padding: '12px', textAlign: 'center' }}>
                    No countries found
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Route Determination & Layout ── */}
      {isLiveRoute ? (
        /* ==================== LIVE ROUTE (NIGERIA SELL/OFF-RAMP) ==================== */
        <>
          {/* Choose Bank Field */}
          <div className="field" style={{ position: 'relative' }}>
            <div className="field-label">Bank</div>
            <div 
              className="input-wrap" 
              onClick={() => { if (isPajcashLive && !apiError) setBankOpen(!bankOpen); }} 
              style={{ cursor: (isPajcashLive && !apiError) ? 'pointer' : 'not-allowed', justifyContent: 'space-between', opacity: (isPajcashLive && !apiError) ? 1 : 0.6 }}
            >
              <span style={{ color: selectedBank === 'Choose Bank' ? 'var(--text3)' : 'var(--text)' }}>{selectedBank}</span>
              <span style={{ color: 'var(--text3)', fontSize: '11px' }}>▼</span>
            </div>

            {bankOpen && (
              <div className="drop-menu" style={{ left: 0, right: 0, width: '100%' }} onClick={e => e.stopPropagation()}>
                <div className="drop-search" style={{ padding: '8px', borderBottom: '1px solid var(--border)' }}>
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
                            src={meta.logo} 
                            alt={meta.name} 
                            onError={(e) => { e.target.style.display = 'none'; e.target.nextSibling.style.display = 'flex'; }}
                            style={{ width: '22px', height: '22px', borderRadius: '50%', objectFit: 'cover' }} 
                          />
                        ) : null}
                        <div 
                          className="bank-avatar"
                          style={{ 
                            display: meta.logo ? 'none' : 'flex', 
                            width: '22px', 
                            height: '22px', 
                            borderRadius: '50%', 
                            background: meta.color, 
                            color: 'white', 
                            fontSize: '9px', 
                            fontWeight: 'bold', 
                            alignItems: 'center', 
                            justifyContent: 'center',
                            textTransform: 'uppercase'
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

          {/* Account Number Field */}
          <div className="field">
            <div className="field-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
              <div className="field-label" style={{ marginBottom: 0 }}>Account Number</div>
              <div className="p2p-action-links" style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <button 
                  className="p2p-btn-badge" 
                  onClick={handlePaste}
                  disabled={!isPajcashLive || !!apiError}
                  style={{ opacity: (isPajcashLive && !apiError) ? 1 : 0.6 }}
                >
                  Paste
                </button>
                <button 
                  className="p2p-btn-badge" 
                  onClick={() => setScannerActive(true)}
                  disabled={!isPajcashLive || !!apiError}
                  style={{ 
                    opacity: (isPajcashLive && !apiError) ? 1 : 0.6,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                  }}
                  title="Scan QR Code"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <rect x="2" y="2" width="20" height="20" rx="4" stroke="currentColor" strokeWidth="2.5" fill="none" />
                    <rect x="1" y="10" width="22" height="4" fill="currentColor" />
                  </svg>
                </button>
              </div>
            </div>
            
            <div className="input-wrap" style={{ opacity: (isPajcashLive && !apiError) ? 1 : 0.6 }}>
              <input 
                type="text" 
                value={accountNumber}
                onChange={e => setAccountNumber(e.target.value.replace(/\D/g, ''))}
                placeholder="0000000000"
                disabled={!isPajcashLive || !!apiError}
              />
            </div>

            {/* Resolved Name - Only pops after Bank + Acc Num is entered */}
            <div className="p2p-account-name-resolved" style={{ marginTop: '6px', minHeight: '16px', fontSize: '12px', color: 'var(--lime)', fontWeight: 'bold' }}>
              {accountNumber && accountNumber.trim().length > 0 && selectedBank !== 'Choose Bank' && (
                resolvingName ? (
                  <span style={{ fontStyle: 'italic', color: 'var(--text3)', fontWeight: 'normal' }}>
                    <span className="p2p-mini-spinner" /> Resolving...
                  </span>
                ) : (
                  accountName && <span className="animated-fade-in">{accountName}</span>
                )
              )}
            </div>
          </div>

          {/* Amount & Token Selection Row */}
          <div className="p2p-amount-row" style={{ display: 'flex', gap: '16px', marginBottom: '0.95rem' }}>
            <div style={{ flex: 1.4 }}>
              <div className="field-label">Amount to Sell</div>
              <div className="input-wrap" style={{ opacity: (isPajcashLive && !apiError) ? 1 : 0.6 }}>
                <span style={{ color: 'var(--text2)', fontWeight: 700, fontSize: '13px', marginRight: '6px' }}>
                  {selectedToken.symbol}
                </span>
                <input 
                  type="number" 
                  placeholder="0.00"
                  value={amount}
                  onChange={e => setAmount(e.target.value)}
                  style={{ width: '100%', border: 'none', outline: 'none', background: 'transparent', color: 'white' }}
                  disabled={!isPajcashLive || !!apiError}
                />
              </div>
              
              <div style={{ marginTop: '6px', fontSize: '12px', minHeight: '16px' }}>
                {routingState === 'routing' ? (
                  <span style={{ color: 'var(--text3)', fontStyle: 'italic' }}>
                    <span className="p2p-mini-spinner" /> Routing...
                  </span>
                ) : (
                  selectedBank !== 'Choose Bank' && (
                    <span style={{ color: 'var(--text2)' }}>
                      ✓ Route: {displayBank} Escrow
                    </span>
                  )
                )}
              </div>
            </div>

            <div style={{ flex: 1 }}>
              <div className="field-label">Token</div>
              <div className="drop-wrap">
                <div 
                  className="input-wrap" 
                  onClick={() => { if (isPajcashLive && !apiError) setTokenOpen(!tokenOpen); }} 
                  style={{ cursor: (isPajcashLive && !apiError) ? 'pointer' : 'not-allowed', justifyContent: 'space-between', opacity: (isPajcashLive && !apiError) ? 1 : 0.6 }}
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
                        {t.logoURI ? (
                          <img src={t.logoURI} alt={t.symbol} style={{ width: '20px', height: '20px', borderRadius: '50%' }} />
                        ) : (
                          <div style={{ width: '20px', height: '20px', borderRadius: '50%', background: 'rgba(255,255,255,0.1)', color: 'white', fontSize: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold' }}>{t.symbol.slice(0, 2)}</div>
                        )}
                        <span className="di-code" style={{ marginLeft: '8px' }}>{t.symbol}</span>
                        {t.balance > 0 && <span className="di-name">{t.balance.toLocaleString(undefined, { maximumFractionDigits: 4 })}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Est. Receive Receipt Banner */}
          <div className="p2p-receipt-banner" style={{ background: 'rgba(255, 255, 255, 0.02)', border: '1px solid var(--border)', borderRadius: '12px', padding: '14px', textAlign: 'center', marginBottom: '1rem', display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Est. Receive</span>
            {routingState === 'routing' || routingState === 'loading_market' ? (
              <div style={{ fontSize: '16px', fontWeight: 700, color: 'white' }}>
                <span className="p2p-mini-spinner" /> Loading...
              </div>
            ) : (
              <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--lime)' }}>
                ₦{fiatAmountText}
              </div>
            )}
          </div>

          {/* Submit Button */}
          <button 
            className="send-btn" 
            onClick={handleSubmit}
            disabled={submitting || !isPajcashLive || !!apiError}
            style={{ opacity: (submitting || !isPajcashLive || !!apiError) ? 0.6 : 1, cursor: (submitting || !isPajcashLive || !!apiError) ? 'not-allowed' : 'pointer' }}
          >
            {submitting ? (
              <span className="p2p-mini-spinner" style={{ marginRight: '6px' }} />
            ) : null}
            {submitting ? 'Processing...' : (!isPajcashLive || apiError ? 'Payout Gateway Offline' : 'Send')}
          </button>
        </>
      ) : (
        /* ==================== FALLBACK "COMING SOON" FOR OTHER COUNTRIES/BUY MODE ==================== */
        <div className="p2p-coming-soon-container" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '320px', textAlign: 'center', padding: '20px 24px', background: 'rgba(255, 255, 255, 0.01)', border: '1.5px dashed rgba(255, 255, 255, 0.1)', borderRadius: '16px', margin: '10px 0' }}>
          <div style={{ fontSize: '38px', marginBottom: '14px' }}>🚀</div>
          <h4 style={{ fontSize: '15px', fontWeight: 'bold', color: 'white', marginBottom: '10px', tracking: '-0.02em' }}>
            {mode === 'buy' ? 'Buy Coming Soon' : `${selectedCountry.name} P2P Payouts Coming Soon`}
          </h4>
          <p style={{ fontSize: '11px', color: 'var(--text3)', maxWidth: '300px', lineHeight: '1.5' }}>
            {mode === 'buy' 
              ? 'We are currently prioritizing live Sell settlements. Direct purchases will be activated shortly.'
              : `P2P off-ramping for ${selectedCountry.name} is currently in development. Please select Nigeria (NGA) and Sell mode to access our live PajCash integration.`
            }
          </p>
        </div>
      )}

      {/* ── Live Payout History Section ── */}
      {isLiveRoute && isPajcashLive && !apiError && (() => {
        const userOrderIds = (() => {
          try {
            const raw = localStorage.getItem(`paj_user_orders_${publicKey}`);
            return raw ? JSON.parse(raw) : [];
          } catch { return []; }
        })();

        const userLogs = payoutLogs.filter(log => userOrderIds.includes(log.id || log._id));

        return (
          <div className="pajcash-logs-section" style={{ marginTop: '1.5rem', borderTop: '1px solid var(--border)', paddingTop: '1rem' }}>
            <h4 style={{ fontSize: '12px', fontWeight: 700, color: 'white', marginBottom: '0.75rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>Live Payout History</span>
              <button onClick={loadPayoutLogs} style={{ background: 'none', border: 'none', color: 'var(--lime)', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold' }}>
                Refresh
              </button>
            </h4>
            {loadingLogs ? (
              <div style={{ fontSize: '12px', color: 'var(--text3)', fontStyle: 'italic', textAlign: 'center', padding: '12px' }}>
                <span className="p2p-mini-spinner" /> Loading payouts...
              </div>
            ) : logError ? (
              <div style={{ fontSize: '11px', color: '#f87171', background: 'rgba(239, 68, 68, 0.08)', padding: '8px 12px', borderRadius: '8px', border: '1px solid rgba(239, 68, 68, 0.2)', marginBottom: '8px', lineHeight: '1.4' }}>
                ⚠️ API error loading history: {logError}
              </div>
            ) : userLogs.length === 0 ? (
              <div style={{ fontSize: '12px', color: 'var(--text3)', fontStyle: 'italic', textAlign: 'center', padding: '12px' }}>
                No recent payouts found.
              </div>
            ) : (
              <div style={{ maxHeight: '150px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '6px', paddingRight: '4px' }}>
                {userLogs.map(log => (
                  <div key={log._id || log.id} style={{ background: 'rgba(255, 255, 255, 0.02)', border: '1px solid var(--border)', borderRadius: '8px', padding: '8px 10px', fontSize: '11px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                      <span style={{ color: 'white', fontWeight: 'bold', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap', maxWidth: '170px' }}>
                        {log.recipient || 'Naira Payout'}
                      </span>
                      <span style={{ color: 'var(--text3)', fontSize: '10px' }}>
                        {log.createdAt ? new Date(log.createdAt).toLocaleString() : 'Recent'}
                      </span>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '2px' }}>
                      <span style={{ color: 'var(--lime)', fontWeight: 'bold' }}>
                        ₦{log.fiatAmount?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
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

      {/* Success Modal Popup */}
      {showSuccess && successDetails && (
        <div className="p2p-success-overlay">
          <div className="p2p-success-card">
            <div className="p2p-success-icon-wrap">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <h3 className="p2p-success-title">Trade Successful</h3>
            <p className="p2p-success-sub" style={{ color: 'var(--lime)', fontWeight: 'bold' }}>
              Live Transaction Settled via PajCash Gateway.
            </p>
            
            <div className="p2p-success-fields">
              <div className="p2p-success-field">
                <span>Action:</span>
                <strong>{successDetails.action} {successDetails.amount}</strong>
              </div>
              <div className="p2p-success-field">
                <span>Fiat Value:</span>
                <strong>{successDetails.fiat}</strong>
              </div>
              <div className="p2p-success-field">
                <span>Bank:</span>
                <strong>{successDetails.bank}</strong>
              </div>
              <div className="p2p-success-field">
                <span>Account Number:</span>
                <strong>{successDetails.account}</strong>
              </div>
              <div className="p2p-success-field">
                <span>Recipient/Sender:</span>
                <strong>{successDetails.name}</strong>
              </div>
              {successDetails.txId && (
                <div className="p2p-success-field">
                  <span>PajCash Tx ID:</span>
                  <strong style={{ color: 'var(--lime)', fontFamily: 'var(--mono)', fontSize: '11px' }}>
                    {successDetails.txId}
                  </strong>
                </div>
              )}
            </div>
            
            <button className="send-btn" onClick={() => { setShowSuccess(false); setAmount(''); }} style={{ marginTop: '1rem' }}>
              Done
            </button>
          </div>
        </div>
      )}

      {/* QR Code Scanner Overlay */}
      {scannerActive && (
        <div className="p2p-success-overlay" style={{ zIndex: 1100 }}>
          <div className="p2p-success-card" style={{ maxWidth: '360px', width: '90%', padding: '20px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <h3 className="p2p-success-title" style={{ fontSize: '15px', color: 'white', marginBottom: '12px', fontWeight: 'bold' }}>Scan QR Code</h3>
            <p className="p2p-success-sub" style={{ fontSize: '11px', color: 'var(--text3)', marginBottom: '16px', textAlign: 'center', fontWeight: 'normal' }}>
              Position the account number QR code inside the box to scan automatically.
            </p>
            
            <div style={{ position: 'relative', width: '260px', height: '260px', background: '#000', borderRadius: '12px', overflow: 'hidden', border: '2px solid var(--border)' }}>
              <video 
                ref={videoRef} 
                style={{ width: '100%', height: '100%', objectFit: 'cover' }} 
              />
              <canvas 
                ref={canvasRef} 
                style={{ display: 'none' }} 
              />
              
              {/* Guidelines scan overlay */}
              <div style={{ position: 'absolute', top: '20px', left: '20px', right: '20px', bottom: '20px', border: '2px dashed var(--lime)', opacity: 0.7, pointerEvents: 'none', borderRadius: '8px' }}>
                {/* Scanning line animation */}
                <div style={{ position: 'absolute', left: 0, right: 0, height: '2px', background: 'var(--lime)', boxShadow: '0 0 8px var(--lime)', animation: 'p2pScanLine 2s linear infinite' }} />
              </div>
            </div>
            
            <button className="send-btn" onClick={stopScanner} style={{ marginTop: '1.25rem', background: 'rgba(255,255,255,0.08)', color: 'white' }}>
              Cancel
            </button>
            
            <style>{`
              @keyframes p2pScanLine {
                0% { top: 0%; }
                50% { top: 100%; }
                100% { top: 0%; }
              }
            `}</style>
          </div>
        </div>
      )}

    </div>
  );
}
