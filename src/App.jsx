import { useState, useMemo, useEffect, useCallback } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { PublicKey, Transaction, SystemProgram, Connection, Keypair, SystemInstruction, TransactionInstruction } from '@solana/web3.js';
import { getDomainKeySync, NameRegistryState, performReverseLookup, getPrimaryDomain, getFavoriteDomain, resolve } from '@bonfida/spl-name-service';
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction } from '@solana/spl-token';
import logoImg from './assets/logo.png';
import { TOKENS, KNOWN_MINTS } from './data/tokens';
import { CURRENCIES } from './data/currencies';
import { useLiveRates } from './hooks/useLiveRates';
import { fmtTok, fmtFiat, fmtRate, robustResolve, robustReverseLookup } from './utils';
import CurrDrop from './components/CurrDrop';
import AmountInput from './components/AmountInput';
import BulkSendPanel from './components/BulkSendPanel';
import TokenModal from './components/TokenModal';
import Toast from './components/Toast';
import FloatClaimWidget from './components/FloatClaimWidget';
import SwapWidget from './components/SwapWidget';


// SNS_LINK must not embed referral/tracking parameters.
// TOKEN_PROGRAM_ID declared as a module-level frozen constant — never re-instantiated inside a component body.
const SNS_LINK = 'https://www.sns.id';
const TOKEN_PROGRAM_ID = Object.freeze(new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'));
const TOKEN_2022_PROGRAM_ID = Object.freeze(new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'));
// Rate staleness threshold — warn user if rates are older than 5 minutes
const RATE_STALENESS_MS = 5 * 60 * 1000;

// Enforce https-only and restrict image sources to trusted CDN domains.
// Prevents malicious SVG injection, tracking pixels, and data exfiltration from untrusted origins.
const TRUSTED_IMAGE_HOSTS = [
  'raw.githubusercontent.com',
  'arweave.net',
  'ipfs.io',
  'nftstorage.link',
  'shdw-drive.genesysgo.net',
  'tokens.jup.ag',
  'cdn.jsdelivr.net',
  'assets.coingecko.com',
];
function isTrustedImageOrigin(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    return TRUSTED_IMAGE_HOSTS.some(host => parsed.hostname === host || parsed.hostname.endsWith('.' + host));
  } catch { return false; }
}

// Strict allowlist of program IDs permitted in any transaction.
// Any instruction whose programId is not in this set will cause an immediate rejection.
const ALLOWED_PROGRAM_IDS = new Set([
  SystemProgram.programId.toBase58(),                        // System Program
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',           // SPL Token Program
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',           // Token-2022 Program
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1brs',          // Associated Token Program
  // Memo program was missing — caused verifyTransactionIntegrity to throw on
  // every transaction because handleSend() appends a Memo instruction before calling verify.
  // Memo carries no account keys and moves no funds, so it is safe to allowlist.
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',           // SPL Memo Program
]);

// Permitted opcodes for SPL Token / Token-2022 programs.
// Only TransferChecked (12) is allowed — all others (Approve=4, SetAuthority=6, etc.) are rejected.
const ALLOWED_TOKEN_OPCODES = new Set([12]); // TransferChecked only

// Permitted opcodes for the Associated Token Program.
// Only CreateIdempotent (1) is allowed for ATA creation.
const ALLOWED_ATA_OPCODES = new Set([1]); // CreateAssociatedTokenAccountIdempotent only

/**
 * Verifies that the built transaction has not been tampered with before signing/sending.
 * Asserts:
 *   1. feePayer matches the connected wallet (prevents fee-payer hijacking).
 *   2. Every instruction belongs to a strict program allowlist (prevents hidden Approve/SetAuthority injection).
 *   3. Token program instructions use only TransferChecked (opcode 12).
 *   4. Recipient addresses and transfer amounts match expected values.
 *
 * @param {Transaction} transaction - Solana Transaction object
 * @param {Array<{ recipient: string, amountBaseUnits: bigint, mint?: string }>} expectedTransfers - List of expected transfers
 * @param {PublicKey} expectedSignerPublicKey - The connected wallet's public key
 */
function verifyTransactionIntegrity(transaction, expectedTransfers, expectedSignerPublicKey) {
  if (!transaction.instructions || transaction.instructions.length === 0) {
    throw new Error('Transaction integrity violation: Transaction contains no instructions.');
  }

  // Assert the fee payer is the connected wallet.
  // A malicious intermediary could set an arbitrary fee payer to front-run or drain the wallet.
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

    // Reject any instruction from a program not in the strict allowlist.
    // This closes the silent-ignore hole where Approve (opcode 4), SetAuthority (opcode 6),
    // or arbitrary CPI calls to unknown programs would pass through without raising an error.
    if (!ALLOWED_PROGRAM_IDS.has(programIdStr)) {
      throw new Error(
        `Transaction integrity violation: Instruction from disallowed program ${programIdStr}. ` +
        `Only System Program, Token Program, Token-2022, and Associated Token Program are permitted.`
      );
    }

    if (ix.programId.equals(SystemProgram.programId)) {
      try {
        const decoded = SystemInstruction.decodeTransfer(ix);
        const toPubkeyStr = decoded.toPubkey.toBase58();
        const lamports = BigInt(decoded.lamports);

        const match = expectedTransfers.find(expected => 
          !expected.mint &&
          expected.recipient === toPubkeyStr &&
          expected.amountBaseUnits === lamports
        );

        if (!match) {
          throw new Error(`Transaction integrity violation: Unexpected SOL transfer of ${lamports} lamports to ${toPubkeyStr}.`);
        }
        systemTransferCount++;
      } catch (err) {
        throw new Error(`Transaction integrity violation: Failed to validate System Program instruction: ${err.message}`);
      }
    } else if (
      programIdStr === 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr' // SPL Memo Program
    ) {
      // Memo instructions carry no account keys and move no funds.
      // They are safe to allow through without further validation.
      // Do NOT increment transferCheckedCount or systemTransferCount — memo is not a transfer.
    } else if (
      programIdStr === 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1brs' // Associated Token Program
    ) {
      // Only CreateAssociatedTokenAccountIdempotent (opcode 1) is permitted.
      // Any other ATA instruction (e.g. undocumented opcodes) is rejected.
      const ixType = ix.data[0];
      if (!ALLOWED_ATA_OPCODES.has(ixType)) {
        throw new Error(
          `Transaction integrity violation: Disallowed Associated Token Program instruction opcode ${ixType}. ` +
          `Only CreateAssociatedTokenAccountIdempotent (opcode 1) is permitted.`
        );
      }
      // CreateIdempotent is safe to allow through — it only creates ATAs, never moves funds.
    } else if (
      programIdStr === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' || // Token Program
      programIdStr === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'     // Token-2022 Program
    ) {
      const ixType = ix.data[0];

      // Allowlist gate: only TransferChecked (opcode 12) is permitted.
      // This explicitly blocks Approve (4), SetAuthority (6), MintTo (7), Burn (8),
      // legacy Transfer (3), and any other opcode — none can reach the validation below.
      if (!ALLOWED_TOKEN_OPCODES.has(ixType)) {
        throw new Error(
          `Transaction integrity violation: Disallowed Token Program instruction opcode ${ixType}. ` +
          `Only TransferChecked (opcode 12) is permitted. ` +
          `Legacy Transfer (3), Approve (4), SetAuthority (6), and all others are rejected.`
        );
      }

      // ── TransferChecked (opcode 12) full validation ──────────────────────────
      // Instruction layout (SPL Token spec):
      //   data[0]      = opcode (12)
      //   data[1..8]   = amount (u64 LE)
      //   data[9]      = decimals (u8)
      //   keys[0]      = source ATA        (writable)
      //   keys[1]      = mint              (read-only)
      //   keys[2]      = destination ATA   (writable)
      //   keys[3]      = owner/authority   (signer)
      // ─────────────────────────────────────────────────────────────────────────

      // Step 1 — data size: need at least opcode(1) + amount(8) + decimals(1) = 10 bytes
      if (ix.data.length < 10) {
        throw new Error(
          'Transaction integrity violation: TransferChecked instruction data is too short ' +
          `(got ${ix.data.length} bytes, expected at least 10).`
        );
      }

      // Step 2 — decode fields from instruction data and account keys
      const mint           = ix.keys[1].pubkey.toBase58(); // keys[1] = mint
      const destinationATA = ix.keys[2].pubkey.toBase58(); // keys[2] = destination ATA
      const sourceATA      = ix.keys[0].pubkey.toBase58(); // keys[0] = source ATA
      const ownerKey       = ix.keys[3]?.pubkey.toBase58(); // keys[3] = owner/authority

      // Decode amount (u64, little-endian, bytes 1-8)
      let amount = 0n;
      for (let idx = 0; idx < 8; idx++) {
        amount += BigInt(ix.data[idx + 1]) << BigInt(idx * 8);
      }

      // Decode decimals (u8, byte 9)
      const decimals = ix.data[9];

      // Step 3 — match against expectedTransfers (mint + amount must both match)
      const match = expectedTransfers.find(expected =>
        expected.mint === mint &&
        expected.amountBaseUnits === amount
      );

      if (!match) {
        throw new Error(
          `Transaction integrity violation: No expected transfer matches ` +
          `mint=${mint}, amount=${amount}. ` +
          `Possible token substitution or amount tampering.`
        );
      }

      // Step 4 — verify the destination ATA is derived from the expected recipient + mint
      const expectedATA = getAssociatedTokenAddressSync(
        new PublicKey(mint),
        new PublicKey(match.recipient),
        false,
        ix.programId
      ).toBase58();

      if (destinationATA !== expectedATA) {
        throw new Error(
          `Transaction integrity violation: Token destination ATA mismatch. ` +
          `Expected ${expectedATA} (for recipient ${match.recipient}), ` +
          `got ${destinationATA}.`
        );
      }

      // Step 5 — verify the owner/signer is the connected wallet (prevents authority hijacking)
      if (ownerKey && ownerKey !== expectedSignerPublicKey.toBase58()) {
        throw new Error(
          `Transaction integrity violation: TransferChecked owner/authority mismatch. ` +
          `Expected ${expectedSignerPublicKey.toBase58()}, got ${ownerKey}.`
        );
      }

      // Step 6 — sanity-check amount is non-zero (zero-value transfers serve no legitimate purpose)
      if (amount === 0n) {
        throw new Error(
          'Transaction integrity violation: TransferChecked instruction has zero amount.'
        );
      }

      // All checks passed — count this as a verified transfer
      transferCheckedCount++;
    }
  }

  const totalExpectedTransfers = expectedTransfers.length;
  const totalFoundTransfers = systemTransferCount + transferCheckedCount;
  if (totalFoundTransfers !== totalExpectedTransfers) {
    throw new Error(`Transaction integrity violation: Expected ${totalExpectedTransfers} transfer instructions, but found ${totalFoundTransfers}.`);
  }
}

export default function App() {
  const { connection } = useConnection();
  const { publicKey, connected, disconnect, sendTransaction, signAllTransactions } = useWallet();
  const { setVisible } = useWalletModal();


  const [inputMode, setInputMode] = useState('fiat'); // fiat or crypto
  // Detect if no private RPC endpoint is configured — user is on the default
  // rate-limited public endpoint. Show a UI warning in this case.
  const isUsingPublicRpc = !import.meta.env.VITE_RPC_URL;
  const [rpcWarnDismissed, setRpcWarnDismissed] = useState(false);

  const [bulkMode, setBulkMode] = useState(false);
  const [showModal, setShowModal] = useState(false);
  // walletPubkey string state removed — use `publicKey` from useWallet() directly to
  // avoid exposing a redundant plaintext string that malicious extensions can enumerate via React fiber.
  const [walletDomain, setWalletDomain] = useState(null);
  const [walletLoading, setWalletLoading] = useState(false);
  const [walletError, setWalletError] = useState(null);
  const [solBalance, setSolBalance] = useState(null);
  const [splTokens, setSplTokens] = useState([]);
  const [recipient, setRecipient] = useState('');
  const [resolvedAddress, setResolvedAddress] = useState(null);
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState(null);
  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState(null); // { type, title, message, link }
  const [rentFeeInfo, setRentFeeInfo] = useState(null); // null | 'network' | 'rent'
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [token, setToken] = useState('');
  // Track when rates were last successfully fetched to detect staleness
  const [ratesTimestamp, setRatesTimestamp] = useState(null);

  const { liveRates, ratesLoading } = useLiveRates();

  // Update timestamp whenever live rates successfully arrive
  useEffect(() => {
    if (liveRates.updatedAt) setRatesTimestamp(Date.now());
  }, [liveRates.updatedAt]);

  // Detect stale rates — warn user if rates are older than RATE_STALENESS_MS
  const ratesAreStale = ratesTimestamp != null && (Date.now() - ratesTimestamp) > RATE_STALENESS_MS;

  // Resolve .sol domains with on-chain ownership re-verification via NameRegistryState.
  // Raw addresses now validated with new PublicKey() + isOnCurve() — garbage strings rejected.
  useEffect(() => {
    let cancelled = false;
    async function checkDomain() {
      if (recipient.endsWith('.sol')) {
        setResolving(true);
        setResolveError(null);
        setResolvedAddress(null);
        try {
          const address = await robustResolve(recipient, connection);
          if (cancelled) return;
          // Secondary on-chain ownership verification to prevent MITM substitution
          try {
            const { pubkey: domainKey } = getDomainKeySync(recipient);
            const registry = await NameRegistryState.retrieve(connection, domainKey);
            if (cancelled) return;
            const resolvedBase58 = address.toBase58();
            const ownerBase58 = registry.owner.toBase58();
            if (ownerBase58 !== resolvedBase58) {
              setResolveError('Domain ownership mismatch — possible spoofing attempt');
              setResolving(false);
              return;
            }
          } catch (verifyErr) {
            // Registry verification unavailable — still proceed but note it
            
          }
          if (!cancelled) setResolvedAddress(address.toBase58());
        } catch (err) {
          if (!cancelled) setResolveError('Domain not found or invalid');
        }
        if (!cancelled) setResolving(false);
      } else if (recipient.length >= 32) {
        // Validate raw public key with try/catch + isOnCurve to reject garbage strings
        try {
          const pk = new PublicKey(recipient);
          if (!PublicKey.isOnCurve(pk.toBytes())) {
            throw new Error('Address is not on the Ed25519 curve (program address not allowed)');
          }
          if (!cancelled) {
            setResolvedAddress(pk.toBase58());
            setResolveError(null);
          }
        } catch (e) {
          if (!cancelled) {
            setResolvedAddress(null);
            setResolveError('Invalid Solana address');
          }
        }
      } else {
        setResolvedAddress(null);
        setResolveError(null);
      }
    }
    const t = setTimeout(checkDomain, 500);
    return () => { cancelled = true; clearTimeout(t); };
  }, [recipient, connection]);

  function getLiveCurrRate(code) {
    const s = CURRENCIES.find(c => c.code === code) || CURRENCIES[0];
    const live = liveRates.fiat[code];
    const staticRate = s.rate;
    return live || staticRate;
  }
  function getLiveTokPrice(symbol) {
    const s = TOKENS.find(t => t.symbol === symbol);
    const live = liveRates.crypto[symbol];
    const staticPrice = s?.price || 0;
    return live || staticPrice;
  }

  const liveSolPrice = liveRates.crypto['SOL'] || 72.70;

  // Build wallet token list — SOL + real SPL tokens from chain
  const walletTokenList = useMemo(() => {
    if (!connected) return null;
    const solEntry = {
      symbol: 'SOL', name: 'Solana', color: '#9945FF', bg: '#2d1a4e',
      price: liveSolPrice, balance: solBalance,
      logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png'
    };
    const splEntries = splTokens.map(t => {
      const meta = TOKENS.find(x => x.symbol === t.symbol) || { color: '#aaa', bg: 'rgba(255,255,255,0.08)' };
      return { ...meta, ...t, price: liveRates.crypto[t.symbol] || t.price || meta.price || 0, balance: t.uiAmount };
    });
    return [solEntry, ...splEntries];
  }, [connected, solBalance, splTokens, liveRates]);

  // When connected → show ONLY real wallet tokens
  // When not connected → show full static list so user can browse
  const selectableTokens = useMemo(() => {
    if (connected && walletTokenList) return walletTokenList;
    return TOKENS.map(t => {
      let logoURI = '';
      if (t.symbol === 'SOL') {
        logoURI = 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png';
      } else {
        const knownMint = Object.values(KNOWN_MINTS).find(k => k.symbol === t.symbol);
        logoURI = (knownMint?.logoURI && isTrustedImageOrigin(knownMint.logoURI)) ? knownMint.logoURI : '';
      }
      return { ...t, price: getLiveTokPrice(t.symbol) || t.price || 0, logoURI };
    });
  }, [connected, walletTokenList, liveRates]);

  const tok = token ? ((walletTokenList && walletTokenList.find(t => t.symbol === token))
    || TOKENS.find(t => t.symbol === token)) : null;
  const curr = CURRENCIES.find(c => c.code === currency) || CURRENCIES[0];
  const currRate = getLiveCurrRate(currency);
  const tokPrice = tok ? (getLiveTokPrice(tok.symbol) || tok.price || 1) : 1;
  const num = parseFloat(amount) || 0;
  const tokAmt = inputMode === 'fiat' ? (num / currRate) / tokPrice : num;
  const dispTok = fmtTok(tokAmt);
  const tokLive = tok ? { ...tok, price: tokPrice } : null;

  // Check if receiver already has the ATA for the selected SPL token.
  // AbortController cancellation flag prevents stale in-flight responses from writing back
  // after the recipient/token has already changed (race condition fix).
  useEffect(() => {
    let cancelled = false;
    async function checkReceiverATA() {
      if (!connection || !tokLive || tokLive.symbol === 'SOL' || !tokLive.mint || !publicKey) {
        setRentFeeInfo(null);
        return;
      }
      const addrStr = resolvedAddress || (recipient.length >= 32 ? recipient : null);
      if (!addrStr) { setRentFeeInfo(null); return; }
      try {
        const recipientPubkey = new PublicKey(addrStr);
        const mintPubkey = new PublicKey(tokLive.mint);
        // Detect Token-2022 mints by checking the mint account owner
        // to compute the correct ATA. Token-2022 ATAs differ from legacy Token ATAs.
        let tokenProgramId = TOKEN_PROGRAM_ID;
        try {
          const mintAcct = await connection.getAccountInfo(mintPubkey);
          if (mintAcct && mintAcct.owner.equals(TOKEN_2022_PROGRAM_ID)) {
            tokenProgramId = TOKEN_2022_PROGRAM_ID;
          }
        } catch (e) { /* default to legacy */ }

        const ata = getAssociatedTokenAddressSync(mintPubkey, recipientPubkey, false, tokenProgramId);
        const testTransaction = new Transaction();
        testTransaction.add(
          createAssociatedTokenAccountIdempotentInstruction(
            publicKey, ata, recipientPubkey, mintPubkey, tokenProgramId
          )
        );
        const { value: { err } } = await connection.simulateTransaction(testTransaction, [publicKey]);
        if (!cancelled) setRentFeeInfo(err ? 'network' : 'rent');
      } catch (e) {
        
        if (!cancelled) setRentFeeInfo(null);
      }
    }
    const t = setTimeout(checkReceiverATA, 400);
    return () => { cancelled = true; clearTimeout(t); };
  }, [resolvedAddress, recipient, tokLive, connection, publicKey]);

  // Fetch real on-chain balances using the wallet-adapter connection object
  const fetchBalances = useCallback(async () => {
    if (!publicKey || !connected) return;
    setWalletLoading(true);
    setWalletError(null);
    try {
      // SOL balance
      const lamports = await connection.getBalance(publicKey, 'confirmed');
      setSolBalance(lamports / 1e9);

      // Use ONLY the wallet-adapter connection for ALL token fetches.
      // Hardcoded fallback RPC arrays removed — they bypass wallet security, expose public keys
      // to unauthenticated third-party endpoints, and can return falsified balances.
      let results = [];
      try {
        const [resp1, resp2] = await Promise.all([
          connection.getParsedTokenAccountsByOwner(publicKey, { programId: TOKEN_PROGRAM_ID }),
          connection.getParsedTokenAccountsByOwner(publicKey, { programId: TOKEN_2022_PROGRAM_ID }).catch(() => ({ value: [] })),
        ]);
        results = [...(resp1.value || []), ...(resp2.value || [])];
        
      } catch (primaryErr) {
        console.warn(`❌ Token fetch failed on wallet-adapter connection:`, primaryErr.message);
        // Do not fall back to hardcoded RPCs — surface the error to the user instead.
        throw primaryErr;
      }

      const mintMap = {};
      results.forEach(account => {
        const parsed = account.account.data.parsed.info;
        const mint = parsed.mint;
        const amt = parsed.tokenAmount.uiAmount || 0;
        if (amt > 0) mintMap[mint] = (mintMap[mint] || 0) + amt;
      });

      const allMints = Object.keys(mintMap);
      
      // 2. Fetch live prices from Jupiter price API (api.jup.ag, different from tokens.jup.ag)
      let jupPrices = {};
      let jupTokensMap = {};
      if (allMints.length > 0) {
        try {
          const [priceResp, tokensResp] = await Promise.all([
            fetch(`https://api.jup.ag/price/v2?ids=${allMints.join(',')}`),
            fetch('https://tokens.jup.ag/tokens?tags=verified').catch(() => ({ json: () => [] }))
          ]);
          const priceData = await priceResp.json();
          jupPrices = priceData.data || {};
          
          if (tokensResp.ok || tokensResp.json) {
            const tokensData = await tokensResp.json();
            if (Array.isArray(tokensData)) {
              tokensData.forEach(t => jupTokensMap[t.address] = t);
            }
          }
        } catch (e) {
          
        }
      }

      // 3. Construct the full portfolio list using KNOWN_MINTS and Jupiter for metadata
      const toks = allMints.map(mint => {
        const balance = mintMap[mint];
        const priceInfo = jupPrices[mint] || {};
        const staticMeta = KNOWN_MINTS[mint] || {};
        const jupMeta = jupTokensMap[mint] || {};

        // Sanitize token logo URIs through isTrustedImageOrigin
        const candidateLogoURI = jupMeta.logoURI || staticMeta.logoURI || `https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/${mint}/logo.png`;

        return {
          mint,
          uiAmount: balance,
          symbol:   jupMeta.symbol || staticMeta.symbol  || mint.slice(0, 6),
          name:     jupMeta.name   || staticMeta.name    || 'Unknown Token',
          price:    parseFloat(priceInfo.price || staticMeta.price || 0),
          color:    staticMeta.color   || '#aaa',
          bg:       staticMeta.bg      || 'rgba(255,255,255,0.08)',
          logoURI:  isTrustedImageOrigin(candidateLogoURI) ? candidateLogoURI : null,
        };
      });

      // Sort by USD value
      toks.sort((a, b) => (b.uiAmount * b.price) - (a.uiAmount * a.price));

      setSplTokens(toks);
    } catch (e) {
      setWalletError(e.message || 'Failed to fetch balances');
    }
    setWalletLoading(false);
  }, [connection, publicKey, connected]);

  // Auto-fetch when wallet connects or changes
  useEffect(() => {
    if (connected && publicKey) {
      fetchBalances();
    } else {
      setSolBalance(null);
      setSplTokens([]);
      setWalletError(null);
      setWalletDomain(null);
      setResolvedAddress(null);
      setRecipient('');
      setAmount('');
    }
  }, [connected]);

  // Separate domain lookup
  useEffect(() => {
    if (connected && publicKey) {
      const pubkeyStr = publicKey.toString();
      // Use sessionStorage (tab-scoped) with a 1-hour TTL to limit persistence.
      // localStorage is writable by extensions/XSS; sessionStorage reduces the attack
      // surface and the TTL ensures stale domain mappings are re-verified.
      const TTL_MS = 60 * 60 * 1000; // 1 hour
      try {
        const raw = sessionStorage.getItem(`sns_${pubkeyStr}`);
        if (raw) {
          const { domain, ts } = JSON.parse(raw);
          if (Date.now() - ts < TTL_MS) {
            setWalletDomain(domain); // show cached value immediately while re-verifying
          } else {
            sessionStorage.removeItem(`sns_${pubkeyStr}`); // expired — discard
          }
        }
      } catch {
        sessionStorage.removeItem(`sns_${pubkeyStr}`);
      }

      const lookupDomain = async () => {
        try {
          const apiPromise = fetch(`https://sns-sdk-proxy.bonfida.workers.dev/reverse-lookup/${pubkeyStr}`)
            .then(r => r.json())
            .then(j => j.domain ? j.domain + '.sol' : Promise.reject())
            .catch(() => Promise.reject());

          const rpcPromise = (async () => {
            const domain = await robustReverseLookup(connection, publicKey);
            if (domain) return domain;
            throw new Error('Not found');
          })();

          const winner = await Promise.any([apiPromise, rpcPromise]).catch(() => null);
          if (winner) {
            setWalletDomain(winner);
            // Persist with timestamp so TTL can be enforced on next reconnect
            sessionStorage.setItem(`sns_${pubkeyStr}`, JSON.stringify({ domain: winner, ts: Date.now() }));
          }
        } catch (e) {
          
        }
      };
      lookupDomain();
    }
  }, [connected, publicKey?.toString(), connection]);

  function handleDisconnect() {
    disconnect();
    // state cleanup handled by useEffect watching [connected]
  }

  async function handleSend() {
    if (sending) return;
    if (!publicKey || !connection || !num) return;
    setToast(null);
    
    setSending(true);
    setWalletError(null);
    try {
      // SECURITY FIX: Re-validate SNS domain resolution immediately before transaction
      // to prevent TOCTOU (Time-of-Check-Time-of-Use) race condition where a domain
      // could be transferred to another address between resolution and transaction submission
      let finalRecipient;
      if (recipient.endsWith('.sol')) {
        // Re-resolve the domain atomically at transaction build time
        try {
          const freshAddress = await robustResolve(recipient, connection);
          const freshAddrStr = freshAddress.toBase58();
          // Validate the re-resolved address matches the cached one
          if (freshAddrStr !== resolvedAddress) {
            throw new Error('Recipient changed! Domain was transferred during transaction preparation. Please verify the recipient and try again.');
          }
          finalRecipient = freshAddress;
        } catch (err) {
          throw new Error(`Domain re-validation failed: ${err.message}`);
        }
      } else {
        const addrStr = resolvedAddress || recipient;
        try {
          finalRecipient = new PublicKey(addrStr);
        } catch (err) {
          throw new Error(`Invalid recipient address: ${err.message}`);
        }
      }

      // Validate the resolved/raw recipient with PublicKey + isOnCurve.
      // Rejects program/off-curve addresses from receiving directly.
      if (!PublicKey.isOnCurve(finalRecipient.toBytes())) {
        throw new Error('Recipient address is not a valid Ed25519 public key (program/off-curve addresses cannot receive funds directly)');
      }

      // Guard against self-sends — sending to your own address is almost always a user error.
      if (finalRecipient.equals(publicKey)) {
        throw new Error('Cannot send to your own wallet address.');
      }

      // Validate transfer amount is a positive finite number before any arithmetic.
      if (!Number.isFinite(tokAmt) || tokAmt <= 0) {
        throw new Error('Invalid transfer amount. Please enter a positive number.');
      }

      // ─────────────────────────────────────────────
      // Step 1: Fetch latest blockhash ONCE up front.
      // This is set explicitly on the transaction so that
      // feePayer and recentBlockhash are ALWAYS present
      // on every instruction path — required for auditing.
      // ─────────────────────────────────────────────
      const latestBlockhash = await connection.getLatestBlockhash('confirmed');

      const transaction = new Transaction();
      transaction.feePayer = publicKey;
      transaction.recentBlockhash = latestBlockhash.blockhash;

      let senderATA = null;
      let needsAtaCreation = false;
      let solTransferLamports = 0n;
      let estimatedFee = 5000n;

      if (tokLive.symbol === 'SOL') {
        let lamports = BigInt(Math.round(tokAmt * 1e9));

        if (lamports <= 0n) {
          throw new Error('Transfer amount must be greater than zero.');
        }

        // Fetch fresh SOL balance to calculate final send lamports if sending max
        const freshLamports = await connection.getBalance(publicKey, 'confirmed');
        const solBalanceLamports = BigInt(freshLamports);

        // If trying to send everything or very close to everything, estimate and subtract the exact fee
        if (lamports >= solBalanceLamports - BigInt(50000)) {
          // Build a probe transaction to estimate the fee accurately
          const probeTx = new Transaction();
          probeTx.feePayer = publicKey;
          probeTx.recentBlockhash = latestBlockhash.blockhash;
          probeTx.add(SystemProgram.transfer({
            fromPubkey: publicKey,
            toPubkey: finalRecipient,
            lamports: Number(1000n)
          }));

          let fee = 5000n;
          try {
            const feeResponse = await probeTx.getEstimatedFee(connection);
            if (feeResponse !== null && feeResponse !== undefined) fee = BigInt(feeResponse);
          } catch (e) {
            
          }

          estimatedFee = fee;
          lamports = solBalanceLamports - fee;
          if (lamports <= 0n) {
            throw new Error(`Insufficient SOL balance to cover the network fee of ${Number(fee) / 1e9} SOL.`);
          }
        }

        solTransferLamports = lamports;

        transaction.add(
          SystemProgram.transfer({
            fromPubkey: publicKey,
            toPubkey: finalRecipient,
            lamports: Number(lamports)
          })
        );
      } else {
        // ── SPL Token transfer ──
        const mintPubkey = new PublicKey(tokLive.mint);

        // Detect Token-2022 mints to pass correct programId to ATA functions
        let tokenProgramId = TOKEN_PROGRAM_ID;
        try {
          const mintAcct = await connection.getAccountInfo(mintPubkey);
          if (mintAcct && mintAcct.owner.equals(TOKEN_2022_PROGRAM_ID)) {
            tokenProgramId = TOKEN_2022_PROGRAM_ID;
          }
        } catch (e) { /* default to legacy Token program */ }

        senderATA = getAssociatedTokenAddressSync(mintPubkey, publicKey, false, tokenProgramId);
        const receiverATA = getAssociatedTokenAddressSync(mintPubkey, finalRecipient, false, tokenProgramId);

        // Check if recipient's ATA needs to be created
        try {
          const ataInfo = await connection.getAccountInfo(receiverATA);
          if (!ataInfo) needsAtaCreation = true;
        } catch (e) {
          needsAtaCreation = true;
        }

        // Fetch decimals from on-chain mint info
        const mintInfo = await connection.getParsedAccountInfo(mintPubkey);
        if (!mintInfo.value) throw new Error('Invalid token mint');
        const decimals = mintInfo.value.data.parsed.info.decimals;

        // Use safe BigInt integer math to avoid floating-point rounding errors
        const amountUnits = BigInt(Math.round(tokAmt * Math.pow(10, decimals)));
        if (amountUnits <= 0n) {
          throw new Error('Transfer amount must be greater than zero token units.');
        }

        // Instruction 1: Idempotently create the receiver's ATA if it doesn't exist yet.
        transaction.add(
          createAssociatedTokenAccountIdempotentInstruction(
            publicKey,      // payer of rent
            receiverATA,    // ATA to create
            finalRecipient, // owner of ATA
            mintPubkey,     // mint
            tokenProgramId  // Token-2022 or legacy
          )
        );

        // Instruction 2: Transfer tokens using TransferChecked
        transaction.add(
          createTransferCheckedInstruction(
            senderATA,      // source token account
            mintPubkey,     // mint (verified by instruction)
            receiverATA,    // destination token account
            publicKey,      // authority (owner of source ATA)
            amountUnits,    // amount in base units
            decimals,       // decimals (verified by instruction)
            [],             // multisigners (none)
            tokenProgramId  // Token-2022 or legacy
          )
        );
      }

      // Add custom on-chain memo instruction
      const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
      transaction.add(
        new TransactionInstruction({
          keys: [],
          programId: MEMO_PROGRAM_ID,
          data: new TextEncoder().encode(`fiatwallet:send:${tokLive.symbol}:${tokAmt}`)
        })
      );

      // Instruction injection guard — reject transaction if it has more instructions
      const expectedMaxInstructions = tokLive.symbol === 'SOL' ? 2 : 3;
      if (transaction.instructions.length > expectedMaxInstructions) {
        throw new Error(`Transaction has unexpected instructions (${transaction.instructions.length}). Refusing to sign.`);
      }

      // Verify feePayer and recentBlockhash are explicitly set before signing.
      if (!transaction.feePayer || !transaction.recentBlockhash) {
        throw new Error('INTERNAL: Transaction is missing feePayer or recentBlockhash. Refusing to sign.');
      }

      // ────────────────────────────────────────────────────────────────────────
      // ATOMIC BALANCE CHECK GUARD (Before simulation/send to minimize race window)
      // ────────────────────────────────────────────────────────────────────────
      if (tokLive.symbol === 'SOL') {
        const latestBalance = await connection.getBalance(publicKey, 'confirmed');

        if (BigInt(latestBalance) < solTransferLamports + estimatedFee) {
          throw new Error(`Insufficient SOL balance. You have ${(Number(latestBalance) / 1e9).toFixed(6)} SOL but need at least ${((Number(solTransferLamports) + estimatedFee) / 1e9).toFixed(6)} SOL.`);
        }
      } else {
        if (!senderATA) {
          throw new Error('Internal Error: sender ATA is null');
        }
        // Fetch fresh SPL token balance using confirmed commitment
        const tokenBalanceResp = await connection.getTokenAccountBalance(senderATA, 'confirmed');
        const freshTokenBalance = tokenBalanceResp.value.uiAmount || 0;
        if (tokAmt > freshTokenBalance) {
          throw new Error(`Insufficient ${tokLive.symbol} balance. You have ${freshTokenBalance} but tried to send ${tokAmt}.`);
        }

        // Fetch fresh SOL balance for rent and transaction fee using confirmed commitment
        const latestSolBalance = await connection.getBalance(publicKey, 'confirmed');
        const requiredSOL = (needsAtaCreation ? 0.00203928 : 0) + 0.00001;
        if ((latestSolBalance / 1e9) < requiredSOL) {
          if (needsAtaCreation) {
            throw new Error(`Insufficient SOL balance. Creating a new recipient account requires 0.002039 SOL for rent, but you only have ${(latestSolBalance / 1e9).toFixed(6)} SOL.`);
          } else {
            throw new Error(`Insufficient SOL balance. You need at least 0.00001 SOL to cover network transaction fees, but only have ${(latestSolBalance / 1e9).toFixed(6)} SOL.`);
          }
        }
      }

      // Verify transaction integrity before simulation/submission
      const expectedTransfers = [{
        recipient: finalRecipient.toBase58(),
        amountBaseUnits: tokLive.symbol === 'SOL' ? solTransferLamports : amountUnits,
        mint: tokLive.symbol === 'SOL' ? null : tokLive.mint
      }];
      verifyTransactionIntegrity(transaction, expectedTransfers, publicKey);

      // Pre-flight simulation immediately before sendTransaction
      const simResult = await connection.simulateTransaction(transaction);
      if (simResult.value.err) {
        const simErr = JSON.stringify(simResult.value.err);
        const logs = simResult.value.logs?.slice(0, 3).join(' | ') || '';
        throw new Error(`Transaction simulation failed: ${simErr}${logs ? ' — ' + logs : ''}`);
      }

      // All checks passed — submit to wallet for signing and broadcast.
      const signature = await sendTransaction(transaction, connection);
      

      // Poll for confirmation instead of relying on the WS subscription.
      // This prevents false "failed" messages when the RPC drops the WS but
      // the transaction is already finalized on-chain.
      let confirmed = false;
      const deadline = Date.now() + 60_000; // 60 second timeout
      while (Date.now() < deadline) {
        try {
          const status = await connection.getSignatureStatus(signature);
          const conf = status?.value?.confirmationStatus;
          if (conf === 'confirmed' || conf === 'finalized') {
            confirmed = true;
            break;
          }
          // If the transaction errored on-chain, throw immediately
          if (status?.value?.err) {
            throw new Error('Transaction rejected by network: ' + JSON.stringify(status.value.err));
          }
        } catch (pollErr) {
          if (pollErr.message.startsWith('Transaction rejected')) throw pollErr;
          // RPC blip — keep polling
        }
        await new Promise(r => setTimeout(r, 2000));
      }

      if (!confirmed) {
        // Last resort — check once more; if it's there, treat as success
        const finalStatus = await connection.getSignatureStatus(signature);
        const finalConf = finalStatus?.value?.confirmationStatus;
        if (finalConf === 'confirmed' || finalConf === 'finalized') {
          confirmed = true;
        }
      }

      if (confirmed) {
        setWalletError(null);



        setToast({
          type: 'success',
          title: `✓ Sent ${dispTok} ${tokLive.symbol}`,
          message: `Transaction confirmed on Solana.`,
          link: { href: `https://solscan.io/tx/${signature}`, label: `${signature.slice(0,8)}… View on Solscan` }
        });
        fetchBalances();
        setAmount('');
        setRecipient('');
        setResolvedAddress(null);
      } else {
        setWalletError(`Transaction submitted but confirmation timed out. Check Solscan: ${signature.slice(0,8)}…`);
      }

    } catch (err) {
      
      setWalletError(err.message || 'Transaction failed');
    }
    setSending(false);
  }

  return (
    <div className="page">
      <div className="hex-bg" />
      <nav>
        <div className="nav-logo-wrap">
          <img src={logoImg} alt="Fiatwallet Logo" className="nav-logo" />
        </div>

        <div className="nav-actions">
          {connected && publicKey && (
            <span className="nav-addr" title={publicKey.toBase58()}>{walletDomain || (publicKey.toBase58().slice(0,4) + '…' + publicKey.toBase58().slice(-4))}</span>
          )}
          {connected
            ? <button className="btn-connected" onClick={handleDisconnect}><span className="live-dot" />Disconnect ▾</button>
            : <button className="btn-connect" onClick={() => setVisible(true)}>Connect Wallet</button>
          }
        </div>
      </nav>

      <FloatClaimWidget liveSolPrice={liveSolPrice} onClaimSuccess={fetchBalances} />

      <div className="main">
        <div className="app-card">
          <div className="card-body">

            {/* RPC warning banner — shown when no custom VITE_RPC_URL is set */}
            {isUsingPublicRpc && !rpcWarnDismissed && (
              <div style={{
                display: 'flex', alignItems: 'flex-start', gap: 10,
                background: 'rgba(234,179,8,0.12)', border: '1px solid rgba(234,179,8,0.35)',
                borderRadius: 10, padding: '10px 14px', marginBottom: 14, fontSize: 12,
                color: '#fde68a', lineHeight: 1.5
              }}>
                <span style={{ fontSize: 16, flexShrink: 0 }}>⚠️</span>
                <span style={{ flex: 1 }}>
                  <strong>Public RPC active.</strong> No <code>VITE_RPC_URL</code> is configured.
                  The default endpoint (<code>api.mainnet-beta.solana.com</code>) is rate-limited
                  and may cause simulation failures or stale balance reads.
                  Set a private RPC (e.g. Helius) in your <code>.env</code> file for reliable operation.
                </span>
                <button
                  onClick={() => setRpcWarnDismissed(true)}
                  style={{ background: 'none', border: 'none', color: '#fde68a', cursor: 'pointer', fontSize: 16, padding: 0, flexShrink: 0 }}
                  aria-label="Dismiss RPC warning"
                >✕</button>
              </div>
            )}
            <div className="title-row">
              <div className="card-title">{bulkMode ? 'Bulk Send' : 'Send Crypto'}</div>
              <div className={`bulk-pill ${bulkMode ? 'on' : ''}`} onClick={() => setBulkMode(b => !b)}>
                <span className="pill-txt">{bulkMode ? 'Bulk ON' : 'Bulk'}</span>
                <div className={`tsw ${bulkMode ? 'on' : ''}`}><div className="tknob" /></div>
              </div>
            </div>
            <p className="card-sub">{bulkMode ? 'Send to up to 1,000 wallets or .sol domains at once.' : 'Send tokens easily using .sol domains.'}</p>

            {!bulkMode && (
              <div className="field">
                <div className="field-label">Send To</div>
                <div className="input-wrap">
                  <span className="sol-icon">◎</span>
                  <input value={recipient} onChange={e => setRecipient(e.target.value)} placeholder="example.sol or address" />
                </div>
                {resolving && <div style={{fontSize:11, color:'var(--text3)', marginTop:6}}>Resolving domain…</div>}
                {resolveError && <div style={{fontSize:11, color:'#f87171', marginTop:6}}>✕ {resolveError}</div>}
                {resolvedAddress && recipient.endsWith('.sol') && (
                  <div style={{fontSize:11, color:'var(--lime)', marginTop:6}}>
                    ✓ Resolved: {resolvedAddress.slice(0,4)}…{resolvedAddress.slice(-4)}
                  </div>
                )}
              </div>
            )}

            <div className="field">
              <div className="field-label">Select Token</div>
              <div className="token-row" onClick={() => setShowModal(true)}>
                {tokLive ? (
                  <>
                    <div className="tok-left">
                      <img
                        src={tokLive.logoURI || ''}
                        alt={tokLive.symbol}
                        className="tok-icon"
                        style={{width:32, height:32, borderRadius:'50%', display: tokLive.logoURI ? 'block' : 'none'}}
                        onError={(e) => { e.target.style.display='none'; e.target.nextElementSibling.style.display='flex'; }}
                      />
                      <div className="tok-icon" style={{background:tokLive.bg, color:tokLive.color, display: tokLive.logoURI ? 'none' : 'flex'}}>{tokLive.symbol.slice(0,4)}</div>
                      <div>
                        <span className="tok-sym">{tokLive.symbol}</span>
                        <span style={{fontSize:11,color:'var(--text3)',marginLeft:6}}>${tokLive.price < 0.01 ? tokLive.price.toFixed(6) : tokLive.price.toLocaleString()}</span>
                        {tokLive.balance != null && tokLive.balance > 0 && (
                          <div style={{fontSize:10, color:'var(--lime)', fontFamily:'var(--mono)', marginTop:2}}>
                            {tokLive.balance.toLocaleString(undefined, {maximumFractionDigits: 4})} {tokLive.symbol} 
                            {tokLive.price > 0 && ` ($${(tokLive.balance * tokLive.price).toFixed(2)})`}
                          </div>
                        )}
                      </div>
                    </div>
                    <div style={{display:'flex',alignItems:'center',gap:8}}>
                      {!bulkMode && <span className="tok-equiv">≈ {dispTok} {tokLive.symbol}</span>}
                      <span className="tok-chevron">›</span>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="tok-left">
                      <div className="tok-icon" style={{background:'rgba(255,255,255,0.05)',color:'var(--text3)'}}>?</div>
                      <div>
                        <span className="tok-sym" style={{color:'var(--text2)'}}>Select Token</span>
                      </div>
                    </div>
                    <div style={{display:'flex',alignItems:'center',gap:8}}>
                      <span className="tok-chevron">›</span>
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Display staleness warning when live rates exceed threshold */}
            {ratesAreStale && (
              <div style={{fontSize:11,color:'#f87171',padding:'6px 10px',background:'rgba(248,113,113,0.12)',borderRadius:8,marginBottom:8,display:'flex',alignItems:'center',gap:6}}>
                ⚠️ Rate data may be stale — send button disabled until rates refresh.
              </div>
            )}
            {tokLive && (
              <div className="rate-badge" style={{marginBottom:'0.75rem'}}>
                <span className="rate-dot" />
                1 {tokLive.symbol} = <strong>${tokLive.price < 0.0001 ? tokLive.price.toFixed(8) : tokLive.price < 1 ? tokLive.price.toFixed(4) : tokLive.price.toLocaleString()}</strong> USD
                <span className="rate-sep">·</span>
                1 USD = <strong>{fmtRate(currRate)}</strong> {currency}
                {liveRates.updatedAt && !ratesAreStale && <span style={{color:'var(--text3)',fontSize:10}}> · live</span>}
                {ratesAreStale && <span style={{color:'#f87171',fontSize:10}}> · stale</span>}
              </div>
            )}

            {bulkMode ? (
              <BulkSendPanel tok={tokLive} connected={connected} getLiveRate={getLiveCurrRate}
                connection={connection} publicKey={publicKey}
                sendTransaction={sendTransaction} signAllTransactions={signAllTransactions} />
            ) : (
              <>
                <div className="field">
                  <div className="field-label">Amount</div>
                  <AmountInput amount={amount} setAmount={setAmount} inputMode={inputMode} setInputMode={setInputMode}
                    currency={currency} setCurrency={setCurrency} tok={tokLive} currRate={currRate} />
                </div>
                {walletError && <div style={{fontSize:12, color:'#f87171', marginBottom:12, padding:'8px 12px', background:'rgba(248,113,113,0.1)', borderRadius:8}}>{walletError}</div>}

                <button className="send-btn"
                  disabled={!connected || !tokLive || !recipient || !num || !resolvedAddress || sending || ratesAreStale}
                  onClick={handleSend}>
                  {sending ? 'Sending…'
                    : !connected ? 'Connect wallet to send'
                    : !tokLive ? 'Select a token to continue'
                    : ratesAreStale ? 'Waiting for fresh rates…'
                    : !resolvedAddress ? 'Enter a valid recipient'
                    : `Send ${dispTok} ${tokLive.symbol}`}
                </button>
              </>
            )}
          </div>
        </div>

        <SwapWidget
          walletTokenList={walletTokenList}
          onSwapSuccess={fetchBalances}
          currency={currency}
          setCurrency={setCurrency}
          currRate={currRate}
        />
      </div>



      {showModal && (
        <TokenModal
          filteredTokens={selectableTokens}
          connected={connected}
          walletLoading={walletLoading}
          solBalance={solBalance}
          onSelect={sym => { setToken(sym); setShowModal(false); }}
          onClose={() => setShowModal(false)}
          onRefresh={fetchBalances}
        />
      )}
      {toast && (
        <Toast
          type={toast.type}
          title={toast.title}
          message={toast.message}
          link={toast.link}
          onClose={() => setToast(null)}
          duration={5000}
        />
      )}
    </div>
  );
}
