# Budget benchmarks: how to recommend the right ask

Every review ends with a budget recommendation. This document gives you the anchors.

## The corpus budget table

Past winners and target budgets, ordered by size, with the profile that justified each amount.

| Project | SCF round | Budget | Team size | Contracts | Key justifier |
|---|---|---|---|---|---|
| Bando | #42 | $75,000 | 3-4 doxxed | 1 RWA tokenizer | Mexican real-estate pilot named, brokerage partner named |
| TheXBank | #40 | $89,500 | doxxed | banking infra | Africa country pilot named, doxxed team |
| The Signal | #42 | $121,000 | 2 doxxed | 1 escrow (DealEscrow.rs) + Atomic Splits | B2B marketplace with named verticals, ecosystem integrations |
| Rebond | #44 (target) | $132,000 | 2 doxxed | 3 (GreenBondToken, KYCWhitelist, CouponDistributor) | 4 LOIs signed, 2 distribution partners, Art L.411-2 framework |
| For Yield | #44 (target) | $144,000 | 11 doxxed | 3 (YieldVault, PerfFeeModule, EURC SAC wrapper) | PSCA AMF filed, €7-8M AUM, 50 HNW clients onboarded |

Maximum permitted ask is $150K. Anything between $145K and $150K triggers heightened scrutiny. Most winners sit between $75K and $135K.

## How to pick the right anchor for a new dossier

Match the new dossier to its closest profile in the table above, then position it one tier up or down depending on three factors:

1. **Team size.** Each additional doxxed team member with verifiable credentials supports roughly +$3K to +$5K of ask.

2. **Contract scope.** Each additional named Soroban contract supports roughly +$8K to +$12K of ask (one contract: $80K to $90K floor; three contracts: $130K to $145K range).

3. **Traction and partner depth.** Each named pilot customer (with signed LOI) or named regulated distribution partner supports roughly +$5K to +$10K.

## Worked anchors for current categories

### B2B marketplace or escrow with Soroban Atomic Splits

Anchor: The Signal $121K winner.

Recommended range: $115,000 to $135,000.
- Sub-$120K if smaller team or single contract.
- $130K+ if multiple contracts plus named B2B partners.

### Regulated DeFi yield or vault

Anchor: For Yield $144K target (PSCA AMF, 11-team, €7-8M AUM).

Recommended range: $115,000 to $144,000.
- $115K-$125K if no regulatory filing in progress.
- $130K-$144K if AMF or comparable regulator filing in progress and named LOIs.

### RWA tokenization (real estate, gold, bonds)

Anchor: Bando $75K winner for narrow pilot; Rebond $132K target for broader scope.

Recommended range: $75,000 to $132,000.
- $75K-$95K if single pilot customer or narrow geography.
- $100K-$132K if 3+ pilots, distribution partners, regulatory framework named.

### Gaming or consumer earn-adjacent

Anchor: zero pure-play game has won in our corpus. Closest comparable is AveForge / Solar Braves target $121K-$132K.

Recommended range: $100,000 to $132,000.
- Strongly recommend sub-$135K given the high rejection rate for the category.
- The dossier must avoid the play-to-earn rejection pattern (see `03-rejection-patterns.md` Pattern 10).

### DeFi infrastructure (yield, AMM, lending)

Anchor: DeFindex, Aquarius, Blend (all prior winners; budgets not always public).

Recommended range: $90,000 to $130,000.
- Soroban primitive plus ecosystem integrations.
- Open-source mandatory.

### Compliance and tooling

Anchor: Latch + KMP (RFP winners SCF #41).

Recommended range: $70,000 to $110,000.
- Often narrow scope, more easily anchored on RFP-track precedent.

## The sub-max rule

Almost no dossier in our corpus has won at $145K or $150K. Five recent rejected dossiers all maxed:
- StellarRead $150K, Easner $150K, Tessera Labs $150K, AION_FI $146.5K, $NRG Token $150K.

When in doubt, drop the ask by $5K-$10K below $145K. The signal cost of "max ask" is higher than the dollar value gained.

## Tranche structure

SCF mandates three "equivalent" tranches. Equivalent means roughly equal, with reviewer flexibility on a few hundred dollars of variation.

Clean structures we recommend:
- $90,000 = 3 x $30,000.
- $99,000 = 3 x $33,000.
- $108,000 = 3 x $36,000.
- $120,000 = 3 x $40,000.
- $121,200 = 3 x $40,400.
- $132,000 = 3 x $44,000.
- $135,000 = 3 x $45,000.
- $144,000 = 3 x $48,000.

Avoid odd numbers like $123,500 that don't split cleanly; reviewers notice.

## How to phrase a budget recommendation to the client

Always anchor on a named precedent. Example:

> *"Recommended budget: $121,200, structured as 3 tranches of $40,400. This matches The Signal exactly ($121K in SCF #42), which had a comparable profile: 2 cofounders fully doxxed, one Soroban contract with Atomic Splits, and B2B distribution. Staying at this exact anchor signals to reviewers that you have done the corpus-anchoring work. Going to $144K would push you toward the For Yield benchmark which requires a larger team and a regulatory filing, neither of which apply to your current profile. Going below $115K would underprice the scope: with three contracts plus a full game frontend plus a wallet onboarding stack, $115K is too low."*

That format (named anchor, scope justification, comparison to next-tier-up, floor justification) is the gold standard.

## Special cases

### A client who insists on $150K

Some clients want the maximum. Be honest:

> *"At $150K, your dossier enters the heightened scrutiny bucket. In our corpus, five dossiers were rejected at $145K-$150K specifically because they could not justify the maximum ask. The math: dropping to $132K loses you $18K but it shifts your rejection probability down by roughly 10 to 15 percentage points (worth roughly $14K to $20K of expected value). You probably want to take the lower ask."*

### A client who insists on $50K (under-asking)

Some clients fear rejection so they under-ask. Also honest:

> *"At $50K, you may signal to the panel that you don't have a real plan. Our smallest funded comparable is Bando at $75K, and even that came with a fully named pilot customer. If your scope justifies $90K-$120K (named contracts plus ecosystem integrations plus a distribution channel), ask for it. Under-asking is sometimes worse than the right ask."*

### A client at a "weird" amount like $127,300

Round to the nearest thousand and prefer clean tranche splits. The panel notices odd numbers.
