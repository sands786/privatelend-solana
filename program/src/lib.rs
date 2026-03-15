use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("PrivLend11111111111111111111111111111111111");

#[program]
pub mod privatelend {
    use super::*;

    pub fn initialize_pool(
        ctx: Context<InitializePool>,
        max_ltv: u64,
        liquidation_threshold: u64,
        base_interest_rate: u64,
    ) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        pool.authority = ctx.accounts.authority.key();
        pool.collateral_mint = ctx.accounts.collateral_mint.key();
        pool.borrow_mint = ctx.accounts.borrow_mint.key();
        pool.max_ltv = max_ltv;
        pool.liquidation_threshold = liquidation_threshold;
        pool.base_interest_rate = base_interest_rate;
        pool.total_supplied = 0;
        pool.total_borrowed = 0;
        pool.bump = *ctx.bumps.get("pool").unwrap();

        emit!(PoolInitialized {
            pool: pool.key(),
            max_ltv,
            liquidation_threshold,
        });

        Ok(())
    }

    pub fn open_position(
        ctx: Context<OpenPosition>,
        collateral_ciphertext: [u8; 64],
        borrow_ciphertext: [u8; 64],
        mxe_proof: MxeProof,
        collateral_amount: u64,
    ) -> Result<()> {
        verify_mxe_proof(&mxe_proof, &ctx.accounts.pool)?;

        let transfer_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_collateral.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        );
        token::transfer(transfer_ctx, collateral_amount)?;

        let position = &mut ctx.accounts.position;
        position.owner = ctx.accounts.user.key();
        position.pool = ctx.accounts.pool.key();
        position.collateral_ciphertext = collateral_ciphertext;
        position.borrow_ciphertext = borrow_ciphertext;
        position.mxe_computation_id = mxe_proof.computation_id;
        position.opened_at = Clock::get()?.unix_timestamp;
        position.is_active = true;
        position.bump = *ctx.bumps.get("position").unwrap();

        let pool = &mut ctx.accounts.pool;
        pool.total_supplied = pool.total_supplied
            .checked_add(collateral_amount)
            .ok_or(ErrorCode::MathOverflow)?;

        emit!(PositionOpened {
            position: position.key(),
            owner: position.owner,
            mxe_computation_id: mxe_proof.computation_id,
        });

        Ok(())
    }

    pub fn repay_and_close(
        ctx: Context<RepayAndClose>,
        repay_amount: u64,
        mxe_repay_proof: MxeProof,
    ) -> Result<()> {
        let position = &mut ctx.accounts.position;
        require!(position.is_active, ErrorCode::PositionInactive);
        require!(position.owner == ctx.accounts.user.key(), ErrorCode::Unauthorized);

        verify_mxe_proof(&mxe_repay_proof, &ctx.accounts.pool)?;

        let transfer_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_borrow_token.to_account_info(),
                to: ctx.accounts.pool_borrow_vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        );
        token::transfer(transfer_ctx, repay_amount)?;

        position.is_active = false;

        emit!(PositionClosed {
            position: position.key(),
            owner: position.owner,
        });

        Ok(())
    }

    pub fn liquidate(
        ctx: Context<Liquidate>,
        mxe_liquidation_proof: MxeProof,
    ) -> Result<()> {
        let position = &mut ctx.accounts.position;
        require!(position.is_active, ErrorCode::PositionInactive);

        verify_mxe_liquidation_proof(&mxe_liquidation_proof, &ctx.accounts.pool)?;

        let pool_key = ctx.accounts.pool.key();
        let seeds = &[
            b"pool",
            pool_key.as_ref(),
            &[ctx.accounts.pool.bump],
        ];
        let signer = &[&seeds[..]];

        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.liquidator_collateral.to_account_info(),
                authority: ctx.accounts.pool.to_account_info(),
            },
            signer,
        );
        token::transfer(transfer_ctx, ctx.accounts.vault.amount)?;

        position.is_active = false;

        emit!(PositionLiquidated {
            position: position.key(),
            liquidator: ctx.accounts.liquidator.key(),
            mxe_computation_id: mxe_liquidation_proof.computation_id,
        });

        Ok(())
    }
}

fn verify_mxe_proof(proof: &MxeProof, pool: &Account<LendingPool>) -> Result<()> {
    require!(!proof.signature.iter().all(|&b| b == 0), ErrorCode::InvalidMxeProof);
    require!(proof.pool_key == pool.key(), ErrorCode::InvalidMxeProof);
    require!(proof.proof_type == ProofType::LtvWithinBounds as u8, ErrorCode::InvalidMxeProof);
    Ok(())
}

fn verify_mxe_liquidation_proof(proof: &MxeProof, pool: &Account<LendingPool>) -> Result<()> {
    require!(!proof.signature.iter().all(|&b| b == 0), ErrorCode::InvalidMxeProof);
    require!(proof.pool_key == pool.key(), ErrorCode::InvalidMxeProof);
    require!(proof.proof_type == ProofType::HealthBelowOne as u8, ErrorCode::InvalidMxeProof);
    Ok(())
}

#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(
        init,
        payer = authority,
        space = LendingPool::SIZE,
        seeds = [b"pool", collateral_mint.key().as_ref(), borrow_mint.key().as_ref()],
        bump
    )]
    pub pool: Account<'info, LendingPool>,
    pub collateral_mint: Account<'info, token::Mint>,
    pub borrow_mint: Account<'info, token::Mint>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OpenPosition<'info> {
    #[account(mut, seeds = [b"pool", pool.collateral_mint.as_ref(), pool.borrow_mint.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, LendingPool>,
    #[account(
        init,
        payer = user,
        space = Position::SIZE,
        seeds = [b"position", user.key().as_ref(), pool.key().as_ref()],
        bump
    )]
    pub position: Account<'info, Position>,
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_collateral: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RepayAndClose<'info> {
    #[account(mut)]
    pub pool: Account<'info, LendingPool>,
    #[account(mut, seeds = [b"position", user.key().as_ref(), pool.key().as_ref()], bump = position.bump)]
    pub position: Account<'info, Position>,
    #[account(mut)]
    pub pool_borrow_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_borrow_token: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Liquidate<'info> {
    #[account(mut)]
    pub pool: Account<'info, LendingPool>,
    #[account(mut)]
    pub position: Account<'info, Position>,
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub liquidator_collateral: Account<'info, TokenAccount>,
    pub liquidator: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[account]
pub struct LendingPool {
    pub authority: Pubkey,
    pub collateral_mint: Pubkey,
    pub borrow_mint: Pubkey,
    pub max_ltv: u64,
    pub liquidation_threshold: u64,
    pub base_interest_rate: u64,
    pub total_supplied: u64,
    pub total_borrowed: u64,
    pub bump: u8,
}

impl LendingPool {
    pub const SIZE: usize = 8 + 32 + 32 + 32 + 8 + 8 + 8 + 8 + 8 + 1 + 64;
}

#[account]
pub struct Position {
    pub owner: Pubkey,
    pub pool: Pubkey,
    pub collateral_ciphertext: [u8; 64],
    pub borrow_ciphertext: [u8; 64],
    pub mxe_computation_id: u64,
    pub opened_at: i64,
    pub is_active: bool,
    pub bump: u8,
}

impl Position {
    pub const SIZE: usize = 8 + 32 + 32 + 64 + 64 + 8 + 8 + 1 + 1 + 32;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct MxeProof {
    pub computation_id: u64,
    pub pool_key: Pubkey,
    pub proof_type: u8,
    pub signature: [u8; 64],
    pub public_inputs: [u8; 32],
}

#[repr(u8)]
pub enum ProofType {
    LtvWithinBounds = 0,
    HealthBelowOne = 1,
    RepaymentSufficient = 2,
}

#[event]
pub struct PoolInitialized {
    pub pool: Pubkey,
    pub max_ltv: u64,
    pub liquidation_threshold: u64,
}

#[event]
pub struct PositionOpened {
    pub position: Pubkey,
    pub owner: Pubkey,
    pub mxe_computation_id: u64,
}

#[event]
pub struct PositionClosed {
    pub position: Pubkey,
    pub owner: Pubkey,
}

#[event]
pub struct PositionLiquidated {
    pub position: Pubkey,
    pub liquidator: Pubkey,
    pub mxe_computation_id: u64,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Invalid Arcium MXE proof")]
    InvalidMxeProof,
    #[msg("LTV exceeds maximum allowed")]
    LtvExceedsMax,
    #[msg("Position is not active")]
    PositionInactive,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Health factor is above liquidation threshold")]
    HealthAboveThreshold,
}
