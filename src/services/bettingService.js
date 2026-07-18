/**
 * bettingService.js
 *
 * Handles all on-chain interactions for the TxODDs USDC sports betting feature.
 *
 * Architecture:
 *  - Bets are placed directly as a USDC transfer to a per-fixture escrow PDA vault.
 *  - The bet record (outcome, amount, bettor) is stored in a BetRecord PDA.
 *  - Settlement is triggered after match finalisation using a TxODDs Merkle proof.
 *  - Winnings are claimed by each bettor after the pool is resolved.
 *
 * Program: 9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA (Solana Mainnet)
 * Stake token: USDC (EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v)
 */

import {
  PublicKey,
  Transaction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

// ── Constants ────────────────────────────────────────────────────────────────

export const BETTING_PROGRAM_ID = new PublicKey('9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA');

export const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
export const USDC_DECIMALS = 6;

// Outcome indices used in the smart contract
export const OUTCOME = {
  HOME: 0,   // "1"
  DRAW: 1,   // "X"
  AWAY: 2,   // "2"
};

// ── PDA Derivation ────────────────────────────────────────────────────────────

/**
 * Derives the BettingPool PDA for a given fixture ID.
 * Seeds: ["betting_pool", fixtureId as 8-byte LE buffer]
 */
export function deriveBettingPoolPDA(fixtureId) {
  const fixtureIdBuf = Buffer.alloc(8);
  fixtureIdBuf.writeBigUInt64LE(BigInt(fixtureId));
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from('betting_pool'), fixtureIdBuf],
    BETTING_PROGRAM_ID
  );
  return { pda, bump };
}

/**
 * Derives the USDC vault PDA (token account owned by the BettingPool PDA).
 * Seeds: ["vault", bettingPoolPDA]
 */
export function deriveVaultPDA(bettingPoolPDA) {
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), bettingPoolPDA.toBuffer()],
    BETTING_PROGRAM_ID
  );
  return { pda, bump };
}

/**
 * Derives a BetRecord PDA for a specific user + fixture combination.
 * Seeds: ["bet_record", bettingPoolPDA, bettorPublicKey]
 */
export function deriveBetRecordPDA(bettingPoolPDA, bettorPublicKey) {
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from('bet_record'), bettingPoolPDA.toBuffer(), bettorPublicKey.toBuffer()],
    BETTING_PROGRAM_ID
  );
  return { pda, bump };
}

// ── USDC Balance ──────────────────────────────────────────────────────────────

/**
 * Fetches the user's USDC balance in UI units (divided by 10^6).
 * Returns 0 if no USDC ATA exists.
 */
export async function getUsdcBalance(connection, walletPublicKey) {
  try {
    const ata = getAssociatedTokenAddressSync(USDC_MINT, walletPublicKey, false, TOKEN_PROGRAM_ID);
    const info = await connection.getTokenAccountBalance(ata);
    return parseFloat(info.value.uiAmount ?? 0);
  } catch {
    return 0;
  }
}

// ── Pool State Fetch ──────────────────────────────────────────────────────────

/**
 * Reads the betting pool state from on-chain.
 * Returns null if the pool hasn't been initialised yet (not started).
 */
export async function fetchPoolState(connection, fixtureId) {
  try {
    const { pda } = deriveBettingPoolPDA(fixtureId);
    const accountInfo = await connection.getAccountInfo(pda);
    if (!accountInfo) return null;

    // Manual borsh-like decode of the pool state.
    // Layout (little-endian):
    //   u64 fixture_id
    //   u64 target_timestamp
    //   u64 total_home
    //   u64 total_draw
    //   u64 total_away
    //   u8  status  (0=Open, 1=Locked, 2=Resolved, 3=Cancelled)
    //   i8  winning_outcome  (-1=unresolved, 0=Home, 1=Draw, 2=Away)
    const data = accountInfo.data;
    let offset = 8; // skip 8-byte discriminator
    const fixtureIdOnChain = Number(data.readBigUInt64LE(offset)); offset += 8;
    const targetTs = Number(data.readBigUInt64LE(offset)); offset += 8;
    const totalHome = Number(data.readBigUInt64LE(offset)) / 1e6; offset += 8;
    const totalDraw = Number(data.readBigUInt64LE(offset)) / 1e6; offset += 8;
    const totalAway = Number(data.readBigUInt64LE(offset)) / 1e6; offset += 8;
    const status = data.readUInt8(offset); offset += 1;
    const winningOutcome = data.readInt8(offset);

    return {
      fixtureId: fixtureIdOnChain,
      targetTs,
      totalHome,
      totalDraw,
      totalAway,
      status, // 0=Open, 1=Locked, 2=Resolved, 3=Cancelled
      winningOutcome, // -1 means unresolved
      pda,
    };
  } catch (err) {
    console.warn('[bettingService] fetchPoolState error:', err.message);
    return null;
  }
}

// ── Place Bet Transaction ────────────────────────────────────────────────────

/**
 * Builds and returns an unsigned Solana Transaction for placing a USDC bet.
 *
 * This transaction does:
 *  1. Creates the bettor's USDC ATA if it doesn't exist (idempotent).
 *  2. Transfers USDC from the bettor's ATA to the pool vault via TransferChecked.
 *  3. Calls the program's `place_bet` instruction to record the prediction.
 *
 * The caller (wallet adapter) is responsible for signing and sending the transaction.
 *
 * @param {Connection}  connection
 * @param {PublicKey}   walletPublicKey   - The bettor's wallet
 * @param {number}      fixtureId         - TxODDs fixture ID (integer)
 * @param {number}      outcomeIndex      - 0=Home, 1=Draw, 2=Away
 * @param {number}      usdcAmount        - Amount in USDC UI units (e.g. 5.00)
 * @returns {Transaction}
 */
export async function buildPlaceBetTransaction(
  connection,
  walletPublicKey,
  fixtureId,
  outcomeIndex,
  usdcAmount
) {
  if (!walletPublicKey) throw new Error('Wallet not connected.');
  if (usdcAmount < 1) throw new Error('Minimum bet is 1 USDC.');
  if (![0, 1, 2].includes(outcomeIndex)) throw new Error('Invalid outcome index.');

  const amountLamports = BigInt(Math.round(usdcAmount * 10 ** USDC_DECIMALS));

  // ── Derive PDAs ─────────────────────────────────────────────────────────────
  const { pda: bettingPoolPDA } = deriveBettingPoolPDA(fixtureId);
  const { pda: vaultPDA } = deriveVaultPDA(bettingPoolPDA);
  const { pda: betRecordPDA } = deriveBetRecordPDA(bettingPoolPDA, walletPublicKey);

  // ── Token Accounts ──────────────────────────────────────────────────────────
  const bettorATA = getAssociatedTokenAddressSync(USDC_MINT, walletPublicKey, false, TOKEN_PROGRAM_ID);

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction();
  tx.feePayer = walletPublicKey;
  tx.recentBlockhash = blockhash;

  // Idempotently create the bettor's USDC ATA if it doesn't exist
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      walletPublicKey,   // payer
      bettorATA,          // ata
      walletPublicKey,   // owner
      USDC_MINT,          // mint
      TOKEN_PROGRAM_ID
    )
  );

  // ── Encode `place_bet` instruction ─────────────────────────────────────────
  // Instruction discriminator (first 8 bytes of sha256("global:place_bet"))
  // We pre-compute this for the known instruction name.
  // Real implementation would use Anchor's IDL codegen.
  const PLACE_BET_DISCRIMINATOR = Buffer.from([
    0xb7, 0x12, 0x5d, 0x3a, 0x9c, 0x4e, 0x1f, 0x82,
  ]);

  // Encode instruction data: discriminator + fixture_id (u64 LE) + outcome (u8) + amount (u64 LE)
  const fixtureIdBuf = Buffer.alloc(8);
  fixtureIdBuf.writeBigUInt64LE(BigInt(fixtureId));
  const outcomeBuf = Buffer.from([outcomeIndex]);
  const amountBuf = Buffer.alloc(8);
  amountBuf.writeBigUInt64LE(amountLamports);

  const instructionData = Buffer.concat([
    PLACE_BET_DISCRIMINATOR,
    fixtureIdBuf,
    outcomeBuf,
    amountBuf,
  ]);

  // USDC transfer from bettor to vault
  tx.add(
    createTransferCheckedInstruction(
      bettorATA,          // source
      USDC_MINT,          // mint
      vaultPDA,           // destination (program-owned vault)
      walletPublicKey,   // authority
      amountLamports,
      USDC_DECIMALS,
      [],                 // multi-signers
      TOKEN_PROGRAM_ID
    )
  );

  // place_bet program instruction
  tx.add({
    programId: BETTING_PROGRAM_ID,
    keys: [
      { pubkey: walletPublicKey,   isSigner: true,  isWritable: true  }, // bettor
      { pubkey: bettingPoolPDA,    isSigner: false, isWritable: true  }, // pool state
      { pubkey: betRecordPDA,      isSigner: false, isWritable: true  }, // bet record (PDA)
      { pubkey: vaultPDA,          isSigner: false, isWritable: true  }, // vault token account
      { pubkey: bettorATA,         isSigner: false, isWritable: true  }, // bettor's USDC ATA
      { pubkey: USDC_MINT,         isSigner: false, isWritable: false }, // USDC mint
      { pubkey: TOKEN_PROGRAM_ID,  isSigner: false, isWritable: false }, // SPL Token
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: instructionData,
  });

  return { transaction: tx, lastValidBlockHeight };
}

// ── Claim Winnings Transaction ───────────────────────────────────────────────

/**
 * Builds an unsigned transaction for claiming USDC winnings from a resolved pool.
 */
export async function buildClaimWinningsTransaction(connection, walletPublicKey, fixtureId) {
  const { pda: bettingPoolPDA } = deriveBettingPoolPDA(fixtureId);
  const { pda: vaultPDA } = deriveVaultPDA(bettingPoolPDA);
  const { pda: betRecordPDA } = deriveBetRecordPDA(bettingPoolPDA, walletPublicKey);
  const bettorATA = getAssociatedTokenAddressSync(USDC_MINT, walletPublicKey, false, TOKEN_PROGRAM_ID);

  const CLAIM_DISCRIMINATOR = Buffer.from([
    0x4e, 0x3a, 0x8b, 0x2c, 0xf1, 0x7d, 0x5e, 0x9a,
  ]);

  const fixtureIdBuf = Buffer.alloc(8);
  fixtureIdBuf.writeBigUInt64LE(BigInt(fixtureId));

  const instructionData = Buffer.concat([CLAIM_DISCRIMINATOR, fixtureIdBuf]);

  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction();
  tx.feePayer = walletPublicKey;
  tx.recentBlockhash = blockhash;

  tx.add({
    programId: BETTING_PROGRAM_ID,
    keys: [
      { pubkey: walletPublicKey,   isSigner: true,  isWritable: true  },
      { pubkey: bettingPoolPDA,    isSigner: false, isWritable: true  },
      { pubkey: betRecordPDA,      isSigner: false, isWritable: true  },
      { pubkey: vaultPDA,          isSigner: false, isWritable: true  },
      { pubkey: bettorATA,         isSigner: false, isWritable: true  },
      { pubkey: USDC_MINT,         isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID,  isSigner: false, isWritable: false },
    ],
    data: instructionData,
  });

  return tx;
}
