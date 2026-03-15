# PrivateLend — Privacy-First DeFi Lending on Solana x Arcium

> Onchain lending exposes collateral, borrows, and health factors, inviting predatory liquidations. PrivateLend solves this with Arcium MXE — all sensitive values are computed in encrypted enclaves, invisible to bots.

## Live Demo
https://privatelend-kappa.vercel.app/
## The Problem

Traditional DeFi lending protocols store all position data publicly on-chain:
- Collateral amounts visible to everyone
- LTV ratios readable by any bot
- Health factors exposed — bots know exactly when to liquidate
- Liquidation prices front-runnable by MEV searchers

## The Solution

PrivateLend moves all sensitive computations inside Arcium MXE. The Solana program stores only encrypted ciphertexts — no raw values are ever exposed on-chain.

## How Arcium is Used
```
User supplies collateral + borrow amounts
         │
         ▼
[Client-side encryption]
Collateral ciphertext ─────────────────────┐
Borrow ciphertext ─────────────────────────┤
                                           ▼
                             ┌─────────────────────────┐
                             │    Arcium MXE Cluster    │
                             │  (Multi-party compute)   │
                             │                          │
                             │  Compute LTV (hidden)    │
                             │  Compute health factor   │
                             │  Compute interest rate   │
                             │  Check liq threshold     │
                             │                          │
                             │  Returns: ZK proof only  │
                             └─────────────────────────┘
                                           │
                                           ▼
                             ┌─────────────────────────┐
                             │   Solana Program         │
                             │                          │
                             │  Stores:                 │
                             │  collateral_ciphertext   │
                             │  borrow_ciphertext       │
                             │  mxe_computation_id      │
                             │                          │
                             │  Never stores:           │
                             │  LTV ratio               │
                             │  Health factor           │
                             │  Liquidation price       │
                             └─────────────────────────┘
```

## Privacy Benefits

| Data Point | Traditional DeFi | PrivateLend |
|---|---|---|
| Collateral amount | Public | Encrypted |
| Borrow amount | Public | Encrypted |
| LTV ratio | Public | MXE only |
| Health factor | Public | MXE only |
| Liquidation price | Public | MXE only |
| Interest rate | Public | MXE computed |

## Architecture
```
privatelend-solana/
├── program/src/lib.rs        # Solana Anchor program
├── app/src/index.html        # Frontend DApp
├── app/src/arcium-client.ts  # Arcium MXE SDK integration
├── scripts/test.ts           # Integration tests
└── README.md
```

## Tech Stack

- Solana — high-speed Layer 1
- Anchor — Solana smart contract framework
- Arcium MXE — Multi-party computation Execution Environment
- Web Crypto API — client-side encryption

## Setup
```bash
npm install
anchor build
anchor deploy --provider.cluster devnet
cd app && npx serve src/
```

## License

MIT
```

---

## 📄 File 2 — `.gitignore`

Click **Add file → Create new file** → name it `.gitignore` → paste this:
```
target/
node_modules/
.anchor/
dist/
.env
*.log
.DS_Store
test-ledger/
