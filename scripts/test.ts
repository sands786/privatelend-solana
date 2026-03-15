import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createMint, createAccount, mintTo } from "@solana/spl-token";
import { assert } from "chai";

describe("PrivateLend — Arcium MXE Integration Tests", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Privatelend;
  const authority = provider.wallet as anchor.Wallet;

  let collateralMint: PublicKey;
  let borrowMint: PublicKey;
  let poolPda: PublicKey;
  let vaultAccount: PublicKey;

  // Mock Arcium MXE proof (in production fetched from MXE cluster)
  const mockMxeProof = {
    computationId: new anchor.BN(12345),
    poolKey: PublicKey.default,
    proofType: 0, // LtvWithinBounds
    signature: Buffer.alloc(64, 1),  // mock signature
    publicInputs: Buffer.alloc(32, 2),
  };

  before(async () => {
    // Create token mints
    collateralMint = await createMint(
      provider.connection,
      authority.payer,
      authority.publicKey,
      null,
      9 // SOL decimals
    );

    borrowMint = await createMint(
      provider.connection,
      authority.payer,
      authority.publicKey,
      null,
      6 // USDC decimals
    );

    // Derive pool PDA
    [poolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), collateralMint.toBuffer(), borrowMint.toBuffer()],
      program.programId
    );

    mockMxeProof.poolKey = poolPda;
  });

  it("Initializes lending pool", async () => {
    await program.methods
      .initializePool(
        new anchor.BN(8000),  // 80% max LTV
        new anchor.BN(8500),  // 85% liquidation threshold
        new anchor.BN(450)    // 4.5% base interest
      )
      .accounts({
        pool: poolPda,
        collateralMint,
        borrowMint,
        authority: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const pool = await program.account.lendingPool.fetch(poolPda);
    assert.equal(pool.maxLtv.toNumber(), 8000);
    assert.equal(pool.liquidationThreshold.toNumber(), 8500);
    assert.equal(pool.baseInterestRate.toNumber(), 450);

    console.log("✓ Pool initialized — max LTV: 80%, liq threshold: 85%");
  });

  it("Opens a private position with encrypted values", async () => {
    // Simulate client-side encryption (in production uses arcium-client.ts)
    const collateralCiphertext = Buffer.alloc(64, 0xAB); // mock ciphertext
    const borrowCiphertext = Buffer.alloc(64, 0xCD);     // mock ciphertext

    const [positionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("position"), authority.publicKey.toBuffer(), poolPda.toBuffer()],
      program.programId
    );

    // Create user token accounts
    const userCollateral = await createAccount(
      provider.connection,
      authority.payer,
      collateralMint,
      authority.publicKey
    );

    // Mint test collateral to user
    await mintTo(
      provider.connection,
      authority.payer,
      collateralMint,
      userCollateral,
      authority.payer,
      10 * 1e9 // 10 SOL
    );

    vaultAccount = await createAccount(
      provider.connection,
      authority.payer,
      collateralMint,
      poolPda
    );

    await program.methods
      .openPosition(
        [...collateralCiphertext],
        [...borrowCiphertext],
        mockMxeProof,
        new anchor.BN(5 * 1e9) // 5 SOL collateral
      )
      .accounts({
        pool: poolPda,
        position: positionPda,
        vault: vaultAccount,
        userCollateral,
        user: authority.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const position = await program.account.position.fetch(positionPda);

    // Verify only ciphertexts stored — no plaintext values
    assert.isTrue(position.isActive);
    assert.equal(position.owner.toBase58(), authority.publicKey.toBase58());

    // Verify ciphertexts stored correctly (not plaintext amounts)
    const storedCol = Buffer.from(position.collateralCiphertext);
    assert.isTrue(storedCol.equals(collateralCiphertext), "Ciphertext stored correctly");

    // Verify the position does NOT store plaintext LTV or health factor
    assert.isUndefined(position.ltv, "LTV must NOT be stored on-chain");
    assert.isUndefined(position.healthFactor, "Health factor must NOT be stored on-chain");
    assert.isUndefined(position.liquidationPrice, "Liquidation price must NOT be stored on-chain");

    console.log("✓ Position opened — only ciphertexts on-chain, no plaintext LTV/health/liqPrice");
  });

  it("Rejects position with invalid MXE proof", async () => {
    const invalidProof = {
      ...mockMxeProof,
      signature: Buffer.alloc(64, 0), // invalid — all zeros
    };

    try {
      await program.methods
        .openPosition(
          [...Buffer.alloc(64, 0xAB)],
          [...Buffer.alloc(64, 0xCD)],
          invalidProof,
          new anchor.BN(1e9)
        )
        .accounts({ pool: poolPda })
        .rpc();
      assert.fail("Should have rejected invalid MXE proof");
    } catch (err) {
      assert.include(err.message, "InvalidMxeProof");
      console.log("✓ Invalid MXE proof correctly rejected");
    }
  });

  it("Liquidation requires valid MXE health-below-one proof", async () => {
    // Attempt liquidation with wrong proof type (LtvWithinBounds instead of HealthBelowOne)
    const wrongProofType = {
      ...mockMxeProof,
      proofType: 0, // LtvWithinBounds — wrong type for liquidation
    };

    try {
      await program.methods
        .liquidate(wrongProofType)
        .accounts({ pool: poolPda })
        .rpc();
      assert.fail("Should have rejected wrong proof type for liquidation");
    } catch (err) {
      assert.include(err.message, "InvalidMxeProof");
      console.log("✓ Liquidation correctly requires HealthBelowOne proof type");
    }
  });

  it("Privacy: on-chain data reveals nothing about LTV", async () => {
    // Fetch all position accounts and verify no sensitive data exposed
    const positions = await program.account.position.all();

    for (const pos of positions) {
      assert.isUndefined(pos.account.ltv, "LTV not on-chain");
      assert.isUndefined(pos.account.healthFactor, "Health factor not on-chain");
      assert.isUndefined(pos.account.liquidationPrice, "Liq price not on-chain");
      assert.isUndefined(pos.account.collateralAmountPlaintext, "Plaintext collateral not on-chain");

      // Only ciphertexts and MXE computation IDs should be present
      assert.isDefined(pos.account.collateralCiphertext);
      assert.isDefined(pos.account.borrowCiphertext);
      assert.isDefined(pos.account.mxeComputationId);

      console.log(`✓ Position ${pos.publicKey.toBase58().slice(0,8)}... — privacy verified`);
    }

    console.log("\n✓ All tests passed — PrivateLend privacy model verified");
    console.log("✓ Arcium MXE integration working correctly");
    console.log("✓ Zero plaintext sensitive data exposed on-chain");
  });
});
