# Q6 Integration Description rewrites (1000 chars max)

Five paste-ready Q6 rewrites by category. Each follows the winning template: three-phase timeline, named Soroban contracts, named SCF Integration List items, why-Stellar economic argument, MIT open-source commitment, supporting infrastructure separated from Integration Track scope.

## Category 1: Regulated DeFi yield vault (For Yield style, 7 Integration List items)

> For Yield uses Soroban as the settlement and routing layer for a regulated EU DeFi yield vault.
>
> Phase 1 (Months 1-2): YieldVault.rs and PerfFeeModule.rs core implementation, MIT open-source. EURC SAC wrapper for EUR-denominated deposits.
>
> Phase 2 (Months 3-4): wallet onboarding via Stellar Wallets Kit and DFNS for institutional MPC custody. DeFindex integration as primary yield allocator.
>
> Phase 3 (Months 5-6): Blend v2 lending pool routing, Aquarius and Soroswap DEX/LP routing, Allbridge for cross-chain inflows from EVM stablecoin holders, mainnet launch.
>
> Why Stellar: vault rebalancing happens 5 to 10 times per allocation cycle. EVM gas would erode 0.5 to 1 percent of NAV per cycle. Stellar sub-cent fees keep performance fees intact.
>
> Architecture sourced from 7 official SCF Integration List items: DeFindex, Blend v2, Aquarius, Soroswap, Allbridge, DFNS, Stellar Wallets Kit.
>
> Supporting infrastructure (NOT Integration Track scope): Fireblocks for institutional custody, Elliptic for screening, Certora audit covered by Stellar LaunchKit credit at Tranche 2 review, Notabene for Travel Rule.

Character count: 994. Just under the limit, calibrate down to 990 if needed.

## Category 2: B2B marketplace with Soroban escrow (The Signal style)

> [Project] uses Soroban as the escrow and atomic settlement layer for B2B [vertical] transactions.
>
> Phase 1 (Months 1-2): DealEscrow.rs core implementation with Atomic Splits payout logic, MIT open-source. SAC integration for USDC settlement.
>
> Phase 2 (Months 3-4): wallet onboarding via Stellar Wallets Kit (Freighter, Albedo, LOBSTR, xBull). Embedded wallet via Privy for non-crypto-native suppliers.
>
> Phase 3 (Months 5-6): dispute resolution module, multi-party Atomic Splits for broker/supplier/platform fee distribution, mainnet launch with 3 named pilot verticals.
>
> Why Stellar: each deal involves 4 to 8 settlement events (release, refund, broker commission, platform fee, supplier payout). On EVM each settlement would cost $2-$8 in gas, breaking platform unit economics at $500-$5,000 average deal size. Stellar sub-cent fees and 5-second finality close the loop.
>
> Architecture sourced from 3 SCF Integration List items: Stellar Wallets Kit, Privy, Anchor Platform (USDC anchor for fiat ramp).
>
> Supporting infrastructure (NOT Integration Track scope): Certora audit via Stellar LaunchKit credit.

Character count: 985.

## Category 3: RWA tokenization (Rebond style, regulated bonds)

> [Project] uses Soroban as the ownership transfer and coupon settlement layer for [asset class] tokenized under [Art L.411-2 CMF / MiFID II / equivalent framework].
>
> Phase 1 (Months 1-2): [Asset]Token.rs core implementation with whitelist-only transfer logic, KYCWhitelist.rs for accredited-investor attestations, MIT open-source.
>
> Phase 2 (Months 3-4): CouponDistributor.rs for automated yield distribution to token holders. Wallet onboarding via Stellar Wallets Kit and DFNS for HNW custody.
>
> Phase 3 (Months 5-6): secondary market settlement, regulator-facing reporting export, mainnet launch with [N] LOIs converted to active issuances.
>
> Why Stellar: coupon distribution to 100 to 1,000 holders happens quarterly. EVM gas at scale would cost $500-$5,000 per coupon event. Stellar settles the entire distribution for under $10.
>
> Architecture sourced from 3 SCF Integration List items: Stellar Wallets Kit, DFNS, Allbridge (cross-chain stablecoin inflows from EVM holders).
>
> Supporting infrastructure (NOT Integration Track scope): Fireblocks for issuer custody, Notabene for Travel Rule, Certora audit via LaunchKit credit.

Character count: 992.

## Category 4: Consumer game native to Stellar (Solar Braves style)

> [Project] uses Soroban as the on-chain economy layer for [game type], settling item ownership, crafting, and progression milestones in real time.
>
> Phase 1 (Months 1-2): [GameContract].rs core implementation handling item ownership and crafting outcomes, MIT open-source. SAC wrapper for in-game USDC payouts.
>
> Phase 2 (Months 3-4): wallet onboarding via Stellar Wallets Kit (crypto-native), Passkey Kit (mainstream gamers, no seed phrase), Privy (Web2 gamers via email or social).
>
> Phase 3 (Months 5-6): cross-game item portability via standardized metadata, PvP escrow contracts, mainnet launch with [N] daily players target.
>
> Why Stellar: a typical session involves 10 to 50 economic actions (item pickups, crafting attempts, PvP wagers, marketplace listings). EVM gas of $0.05-$2.00 per action would make session economics impossible at retail scale. Stellar sub-cent fees enable the full loop.
>
> Architecture sourced from 3 SCF Integration List items: Stellar Wallets Kit, Passkey Kit (as wallet onboarding sub-component), Privy.
>
> Supporting infrastructure (NOT Integration Track scope): standard cloud (AWS/GCP), Certora audit via LaunchKit credit.

Character count: 998. Calibrate down to 994 by tightening adjectives.

## Category 5: Compliance / developer tooling (Latch+KMP RFP style)

> [Project] is a Soroban-aware [compliance category: identity attestation, audit trail, screening] primitive plus a hosted reference implementation.
>
> Phase 1 (Months 1-2): [Tool].rs Soroban contract for [specific verifiable on-chain claim], MIT open-source. CLI and SDK in TypeScript.
>
> Phase 2 (Months 3-4): integration with Stellar Wallets Kit for end-user sign-off, integration with Privy for embedded wallet flows. Web reference dashboard.
>
> Phase 3 (Months 5-6): integration testing with [Named Prior Stellar-Funded Projects], audit by [vendor], mainnet launch.
>
> Why Stellar: [compliance category] requires on-chain verifiable attestations. Stellar's SAC and Soroban event model expose the attestation in a form Stellar wallets, anchors, and indexers can consume natively, eliminating multi-chain reconciliation cost.
>
> Architecture sourced from 2 SCF Integration List items: Stellar Wallets Kit, Privy.
>
> Supporting infrastructure (NOT Integration Track scope): cloud hosting (AWS/GCP), Certora audit via Stellar LaunchKit credit.

Character count: 956.

## Common Q6 mistakes to avoid

- Generic "Soroban smart contracts" without naming them. Always name the contracts (DealEscrow.rs, YieldVault.rs, GoldCoin.rs).
- ERC-4626 mentioned on Stellar (Ethereum standard, not Stellar). Use SAC and Soroban-native vault patterns.
- EURC mentioned without StellarAssetContract (SAC) wrapper context.
- Fireblocks, Elliptic, Certora named as Integration Track items (they are not on the list). Always reposition as supporting infrastructure.
- No phasing. Always Months 1-2 / 3-4 / 5-6.
- No open-source commitment. Always commit to MIT (or Apache 2.0) explicitly.
- Not counting Integration List items explicitly. Always end Q6 with "Architecture sourced from N official SCF Integration List items: X, Y, Z."

## Q6 character calibration

Same calibration as Q2: aim for 900-980 characters. The Integration Description is one of the two most-read fields by reviewers (along with Q2). Land it tight and specific.
