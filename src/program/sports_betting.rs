/// sports_betting.rs
///
/// Anchor Solana Program for TxODDs USDC Sports Betting Escrow
///
/// Program ID: 9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA (Mainnet)
///
/// Architecture:
///   - initialize_pool  → admin creates a betting pool for a given fixture
///   - place_bet        → user transfers USDC to vault + records prediction in BetRecord PDA
///   - resolve_pool     → trusted resolver (or anyone with a valid proof) marks the winning outcome
///   - claim_winnings   → winning bettors withdraw proportional share of the total pot
///   - cancel_pool      → admin cancels pool (e.g. match postponed) — all bettors get refunds
///
/// Accounts:
///   BettingPool  — one per fixture, stores totals per outcome, status, winning outcome
///   BetRecord    — one per (pool, bettor), stores their staked amount and chosen outcome
///   Vault        — program-owned USDC token account (ATA owned by BettingPool PDA)
///
/// Token: USDC (EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v) — 6 decimals
///
/// NOTE: This is a source reference and must be compiled with Anchor 0.29+ and deployed
/// separately. The frontend bettingService.js interacts with the deployed instance of
/// this program via hand-crafted instructions matching this layout.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Mint, Transfer};
use anchor_spl::associated_token::AssociatedToken;

declare_id!("9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA");

// ── Constants ────────────────────────────────────────────────────────────────

pub const BETTING_POOL_SEED: &[u8]  = b"betting_pool";
pub const VAULT_SEED:        &[u8]  = b"vault";
pub const BET_RECORD_SEED:   &[u8]  = b"bet_record";
pub const MIN_BET_LAMPORTS:  u64    = 1_000_000; // 1 USDC (6 decimals)
pub const FEE_BPS:           u64    = 200;        // 2% platform fee
pub const FEE_BPS_DIVISOR:   u64    = 10_000;

// ── Outcome Enum ─────────────────────────────────────────────────────────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Outcome {
    Home = 0,
    Draw = 1,
    Away = 2,
}

// ── Pool Status ───────────────────────────────────────────────────────────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum PoolStatus {
    Open      = 0, // Accepting bets
    Locked    = 1, // Match started — no new bets
    Resolved  = 2, // Winning outcome known — claims open
    Cancelled = 3, // Match cancelled — refunds available
}

// ── State Accounts ────────────────────────────────────────────────────────────

/// One per fixture. Seeds: ["betting_pool", fixture_id LE u64]
#[account]
pub struct BettingPool {
    pub fixture_id:       u64,
    pub target_timestamp: i64,
    pub admin:            Pubkey,
    pub usdc_mint:        Pubkey,
    pub total_home:       u64,  // sum of all Home stakes (in USDC lamports)
    pub total_draw:       u64,
    pub total_away:       u64,
    pub fees_collected:   u64,
    pub status:           PoolStatus,
    /// -1 when unresolved; 0=Home, 1=Draw, 2=Away
    pub winning_outcome:  i8,
    pub bump:             u8,
    pub vault_bump:       u8,
}

impl BettingPool {
    pub const LEN: usize = 8  // discriminator
        + 8   // fixture_id
        + 8   // target_timestamp
        + 32  // admin
        + 32  // usdc_mint
        + 8   // total_home
        + 8   // total_draw
        + 8   // total_away
        + 8   // fees_collected
        + 1   // status (enum u8)
        + 1   // winning_outcome
        + 1   // bump
        + 1;  // vault_bump

    /// Returns total stake across all outcomes
    pub fn total_pool(&self) -> u64 {
        self.total_home
            .saturating_add(self.total_draw)
            .saturating_add(self.total_away)
    }

    /// Returns total stake for the winning outcome
    pub fn winning_total(&self) -> u64 {
        match self.winning_outcome {
            0 => self.total_home,
            1 => self.total_draw,
            2 => self.total_away,
            _ => 0,
        }
    }
}

/// One per (pool, bettor). Seeds: ["bet_record", pool_pda, bettor]
#[account]
pub struct BetRecord {
    pub bettor:     Pubkey,
    pub pool:       Pubkey,
    pub outcome:    Outcome,
    pub amount:     u64,   // USDC lamports staked
    pub claimed:    bool,
    pub bump:       u8,
}

impl BetRecord {
    pub const LEN: usize = 8   // discriminator
        + 32  // bettor
        + 32  // pool
        + 1   // outcome
        + 8   // amount
        + 1   // claimed
        + 1;  // bump
}

// ── Program ───────────────────────────────────────────────────────────────────

#[program]
pub mod sports_betting {
    use super::*;

    /// Admin creates a betting pool for a specific TxODDs fixture.
    pub fn initialize_pool(
        ctx: Context<InitializePool>,
        fixture_id: u64,
        target_timestamp: i64,
    ) -> Result<()> {
        let pool = &mut ctx.accounts.betting_pool;
        pool.fixture_id       = fixture_id;
        pool.target_timestamp = target_timestamp;
        pool.admin            = ctx.accounts.admin.key();
        pool.usdc_mint        = ctx.accounts.usdc_mint.key();
        pool.total_home       = 0;
        pool.total_draw       = 0;
        pool.total_away       = 0;
        pool.fees_collected   = 0;
        pool.status           = PoolStatus::Open;
        pool.winning_outcome  = -1;
        pool.bump             = ctx.bumps.betting_pool;
        pool.vault_bump       = ctx.bumps.vault;
        Ok(())
    }

    /// User places a USDC bet on a given outcome.
    /// Transfers USDC from bettor's ATA to the pool vault.
    /// Records the bet in a BetRecord PDA.
    pub fn place_bet(
        ctx: Context<PlaceBet>,
        _fixture_id: u64,
        outcome: Outcome,
        amount: u64,
    ) -> Result<()> {
        let pool = &mut ctx.accounts.betting_pool;

        require!(pool.status == PoolStatus::Open, BettingError::PoolNotOpen);
        require!(amount >= MIN_BET_LAMPORTS, BettingError::BetTooSmall);

        // Ensure the bettor hasn't already bet on this pool
        let record = &mut ctx.accounts.bet_record;
        require!(!record.claimed && record.amount == 0, BettingError::AlreadyBet);

        // Platform fee
        let fee = amount
            .checked_mul(FEE_BPS)
            .and_then(|v| v.checked_div(FEE_BPS_DIVISOR))
            .ok_or(BettingError::Overflow)?;
        let net_amount = amount.checked_sub(fee).ok_or(BettingError::Overflow)?;

        // Transfer USDC: bettor ATA → vault
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from:      ctx.accounts.bettor_ata.to_account_info(),
                    to:        ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.bettor.to_account_info(),
                },
            ),
            amount,
        )?;

        // Update pool totals
        match outcome {
            Outcome::Home => pool.total_home = pool.total_home.checked_add(net_amount).ok_or(BettingError::Overflow)?,
            Outcome::Draw => pool.total_draw = pool.total_draw.checked_add(net_amount).ok_or(BettingError::Overflow)?,
            Outcome::Away => pool.total_away = pool.total_away.checked_add(net_amount).ok_or(BettingError::Overflow)?,
        }
        pool.fees_collected = pool.fees_collected.checked_add(fee).ok_or(BettingError::Overflow)?;

        // Store bet record
        record.bettor   = ctx.accounts.bettor.key();
        record.pool     = ctx.accounts.betting_pool.key();
        record.outcome  = outcome;
        record.amount   = net_amount;
        record.claimed  = false;
        record.bump     = ctx.bumps.bet_record;

        emit!(BetPlaced {
            fixture_id: pool.fixture_id,
            bettor:     ctx.accounts.bettor.key(),
            outcome,
            amount:     net_amount,
        });

        Ok(())
    }

    /// Resolver (off-chain service with TxODDs Merkle proof validation) sets the winning outcome.
    /// In production, this would verify a TxODDs Merkle proof via CPI into the TxODDs Oracle program.
    /// For MVP: admin-signed resolution after match finalisation (action=game_finalised, statusId=100).
    pub fn resolve_pool(
        ctx: Context<ResolvePool>,
        _fixture_id: u64,
        winning_outcome: Outcome,
    ) -> Result<()> {
        let pool = &mut ctx.accounts.betting_pool;

        require!(
            pool.status == PoolStatus::Open || pool.status == PoolStatus::Locked,
            BettingError::AlreadyResolved
        );
        require!(
            ctx.accounts.resolver.key() == pool.admin,
            BettingError::Unauthorized
        );

        pool.status          = PoolStatus::Resolved;
        pool.winning_outcome = winning_outcome as i8;

        emit!(PoolResolved {
            fixture_id:      pool.fixture_id,
            winning_outcome,
            total_pool:      pool.total_pool(),
        });

        Ok(())
    }

    /// Winner claims their proportional share of the losing pool + their original stake.
    /// Payout = bettor_stake + (bettor_stake / winning_total) * losing_total
    pub fn claim_winnings(ctx: Context<ClaimWinnings>, _fixture_id: u64) -> Result<()> {
        let pool   = &ctx.accounts.betting_pool;
        let record = &mut ctx.accounts.bet_record;

        require!(pool.status == PoolStatus::Resolved, BettingError::NotResolved);
        require!(!record.claimed, BettingError::AlreadyClaimed);
        require!(
            record.outcome as i8 == pool.winning_outcome,
            BettingError::NotAWinner
        );

        let total_pool    = pool.total_pool();
        let winning_total = pool.winning_total();
        require!(winning_total > 0, BettingError::NoWinners);

        // Proportional payout: bettor_stake * total_pool / winning_total
        let payout = (record.amount as u128)
            .checked_mul(total_pool as u128)
            .and_then(|v| v.checked_div(winning_total as u128))
            .and_then(|v| u64::try_from(v).ok())
            .ok_or(BettingError::Overflow)?;

        record.claimed = true;

        // Transfer from vault → bettor ATA (PDA signs)
        let pool_key    = pool.key();
        let vault_seeds = &[
            VAULT_SEED,
            pool_key.as_ref(),
            &[pool.vault_bump],
        ];
        let signer_seeds = &[&vault_seeds[..]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from:      ctx.accounts.vault.to_account_info(),
                    to:        ctx.accounts.bettor_ata.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                signer_seeds,
            ),
            payout,
        )?;

        emit!(WinningsClaimed {
            fixture_id: pool.fixture_id,
            bettor:     ctx.accounts.bettor.key(),
            payout,
        });

        Ok(())
    }

    /// Admin cancels the pool (e.g. match postponed).
    /// Bettors can then call refund_bet to get their USDC back.
    pub fn cancel_pool(ctx: Context<CancelPool>, _fixture_id: u64) -> Result<()> {
        let pool = &mut ctx.accounts.betting_pool;
        require!(pool.admin == ctx.accounts.admin.key(), BettingError::Unauthorized);
        require!(pool.status == PoolStatus::Open || pool.status == PoolStatus::Locked, BettingError::AlreadyResolved);
        pool.status = PoolStatus::Cancelled;
        Ok(())
    }

    /// Refund a bet from a cancelled pool.
    pub fn refund_bet(ctx: Context<RefundBet>, _fixture_id: u64) -> Result<()> {
        let pool   = &ctx.accounts.betting_pool;
        let record = &mut ctx.accounts.bet_record;

        require!(pool.status == PoolStatus::Cancelled, BettingError::PoolNotCancelled);
        require!(!record.claimed, BettingError::AlreadyClaimed);

        let refund = record.amount;
        record.claimed = true;

        let pool_key    = pool.key();
        let vault_seeds = &[VAULT_SEED, pool_key.as_ref(), &[pool.vault_bump]];
        let signer_seeds = &[&vault_seeds[..]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from:      ctx.accounts.vault.to_account_info(),
                    to:        ctx.accounts.bettor_ata.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                signer_seeds,
            ),
            refund,
        )?;

        Ok(())
    }
}

// ── Account Contexts ──────────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(fixture_id: u64)]
pub struct InitializePool<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = BettingPool::LEN,
        seeds = [BETTING_POOL_SEED, &fixture_id.to_le_bytes()],
        bump
    )]
    pub betting_pool: Account<'info, BettingPool>,

    /// Program-owned USDC vault (token account seeded from pool PDA)
    #[account(
        init,
        payer = admin,
        token::mint = usdc_mint,
        token::authority = vault,
        seeds = [VAULT_SEED, betting_pool.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, TokenAccount>,

    pub usdc_mint: Account<'info, Mint>,

    pub token_program:           Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program:          Program<'info, System>,
    pub rent:                    Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(fixture_id: u64)]
pub struct PlaceBet<'info> {
    #[account(mut)]
    pub bettor: Signer<'info>,

    #[account(
        mut,
        seeds = [BETTING_POOL_SEED, &fixture_id.to_le_bytes()],
        bump = betting_pool.bump
    )]
    pub betting_pool: Account<'info, BettingPool>,

    #[account(
        init_if_needed,
        payer = bettor,
        space = BetRecord::LEN,
        seeds = [BET_RECORD_SEED, betting_pool.key().as_ref(), bettor.key().as_ref()],
        bump
    )]
    pub bet_record: Account<'info, BetRecord>,

    #[account(
        mut,
        seeds = [VAULT_SEED, betting_pool.key().as_ref()],
        bump = betting_pool.vault_bump
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = bettor,
    )]
    pub bettor_ata: Account<'info, TokenAccount>,

    pub usdc_mint: Account<'info, Mint>,

    pub token_program:           Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program:          Program<'info, System>,
    pub rent:                    Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(fixture_id: u64)]
pub struct ResolvePool<'info> {
    #[account(mut)]
    pub resolver: Signer<'info>,

    #[account(
        mut,
        seeds = [BETTING_POOL_SEED, &fixture_id.to_le_bytes()],
        bump = betting_pool.bump
    )]
    pub betting_pool: Account<'info, BettingPool>,
}

#[derive(Accounts)]
#[instruction(fixture_id: u64)]
pub struct ClaimWinnings<'info> {
    #[account(mut)]
    pub bettor: Signer<'info>,

    #[account(
        seeds = [BETTING_POOL_SEED, &fixture_id.to_le_bytes()],
        bump = betting_pool.bump
    )]
    pub betting_pool: Account<'info, BettingPool>,

    #[account(
        mut,
        seeds = [BET_RECORD_SEED, betting_pool.key().as_ref(), bettor.key().as_ref()],
        bump = bet_record.bump,
        constraint = bet_record.bettor == bettor.key()
    )]
    pub bet_record: Account<'info, BetRecord>,

    #[account(
        mut,
        seeds = [VAULT_SEED, betting_pool.key().as_ref()],
        bump = betting_pool.vault_bump
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = bettor,
    )]
    pub bettor_ata: Account<'info, TokenAccount>,

    pub usdc_mint: Account<'info, Mint>,

    pub token_program:           Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program:          Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(fixture_id: u64)]
pub struct CancelPool<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [BETTING_POOL_SEED, &fixture_id.to_le_bytes()],
        bump = betting_pool.bump,
        constraint = betting_pool.admin == admin.key()
    )]
    pub betting_pool: Account<'info, BettingPool>,
}

#[derive(Accounts)]
#[instruction(fixture_id: u64)]
pub struct RefundBet<'info> {
    #[account(mut)]
    pub bettor: Signer<'info>,

    #[account(
        seeds = [BETTING_POOL_SEED, &fixture_id.to_le_bytes()],
        bump = betting_pool.bump
    )]
    pub betting_pool: Account<'info, BettingPool>,

    #[account(
        mut,
        seeds = [BET_RECORD_SEED, betting_pool.key().as_ref(), bettor.key().as_ref()],
        bump = bet_record.bump,
        constraint = bet_record.bettor == bettor.key()
    )]
    pub bet_record: Account<'info, BetRecord>,

    #[account(
        mut,
        seeds = [VAULT_SEED, betting_pool.key().as_ref()],
        bump = betting_pool.vault_bump
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = bettor,
    )]
    pub bettor_ata: Account<'info, TokenAccount>,

    pub usdc_mint:                Account<'info, Mint>,
    pub token_program:            Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program:           Program<'info, System>,
}

// ── Events ────────────────────────────────────────────────────────────────────

#[event]
pub struct BetPlaced {
    pub fixture_id: u64,
    pub bettor:     Pubkey,
    pub outcome:    Outcome,
    pub amount:     u64,
}

#[event]
pub struct PoolResolved {
    pub fixture_id:      u64,
    pub winning_outcome: Outcome,
    pub total_pool:      u64,
}

#[event]
pub struct WinningsClaimed {
    pub fixture_id: u64,
    pub bettor:     Pubkey,
    pub payout:     u64,
}

// ── Errors ────────────────────────────────────────────────────────────────────

#[error_code]
pub enum BettingError {
    #[msg("Pool is not accepting bets.")]
    PoolNotOpen,
    #[msg("Bet amount is below the 1 USDC minimum.")]
    BetTooSmall,
    #[msg("Wallet has already placed a bet on this pool.")]
    AlreadyBet,
    #[msg("Pool has already been resolved.")]
    AlreadyResolved,
    #[msg("Pool has not been resolved yet.")]
    NotResolved,
    #[msg("This bet did not win.")]
    NotAWinner,
    #[msg("Winnings have already been claimed.")]
    AlreadyClaimed,
    #[msg("Arithmetic overflow in payout calculation.")]
    Overflow,
    #[msg("No winning bets were placed — pool must be cancelled.")]
    NoWinners,
    #[msg("Pool is not cancelled — use claim_winnings for resolved pools.")]
    PoolNotCancelled,
    #[msg("Caller is not authorized to perform this action.")]
    Unauthorized,
}
