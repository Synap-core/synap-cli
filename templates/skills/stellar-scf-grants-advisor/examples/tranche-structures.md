# Tranche structures with verifiable evidence

Three reference Tranche 1/2/3 structures by category. Each deliverable shows the level of specificity the panel expects: named contract, measurable completion criteria, verifiable reviewer evidence, estimated date, budget.

## Reference structure: 3 equivalent tranches

SCF mandates roughly equal tranches. Clean splits:

| Total budget | Tranche size | Use case |
|---|---|---|
| $75,000 | $25,000 each | Narrow pilot dossier (Bando style) |
| $90,000 | $30,000 each | Single-contract dossier |
| $108,000 | $36,000 each | Two-contract dossier |
| $121,200 | $40,400 each | The Signal anchor |
| $132,000 | $44,000 each | Rebond anchor |
| $135,000 | $45,000 each | Three-contract dossier |
| $144,000 | $48,000 each | For Yield anchor |

## Example A: B2B marketplace ($121,200 across 3 tranches of $40,400)

### Tranche 1 (MVP, T+8 weeks)

Deliverable 1.1: DealEscrow.rs contract development
- Description: Soroban contract with deposit, milestone-based release, dispute hold logic.
- Measure of completion: contract deployed to Stellar testnet with verifiable address; test suite covering 95 percent of paths passing in CI; security review pass by internal team.
- Reviewer evidence: testnet contract ID + transaction hashes for 10+ test transactions; GitHub PR link; CI run link.
- Budget: $25,000.

Deliverable 1.2: Atomic Splits payout module
- Description: Soroban submodule splitting one deposit across N recipients (buyer refund, supplier payout, broker commission, platform fee).
- Measure of completion: testnet contract with 5+ multi-party payouts executed.
- Reviewer evidence: testnet transaction hashes showing multi-recipient splits; integration test report.
- Budget: $15,400.

### Tranche 2 (Testnet, T+16 weeks)

Deliverable 2.1: Wallet onboarding via Stellar Wallets Kit
- Description: end-to-end flow from Freighter / Albedo / LOBSTR / xBull connection to first deposit.
- Measure of completion: 20+ beta users complete onboarding on testnet across 4 wallet types.
- Reviewer evidence: testnet activity dashboard URL; user feedback summary.
- Budget: $18,000.

Deliverable 2.2: Privy embedded wallet flow
- Description: non-crypto-native suppliers onboarded via email or social login.
- Measure of completion: 10+ suppliers onboarded via Privy on testnet.
- Reviewer evidence: testnet activity; Privy integration documentation.
- Budget: $12,000.

Deliverable 2.3: Internal QA and audit prep
- Description: full test coverage report; Certora-ready audit scope document.
- Measure of completion: 98 percent test coverage; audit scope document delivered for LaunchKit credit redemption.
- Reviewer evidence: coverage report; audit document.
- Budget: $10,400.

### Tranche 3 (Mainnet, T+24 weeks)

Deliverable 3.1: Mainnet deployment
- Description: contracts deployed to Stellar mainnet; first 3 production deals settled.
- Measure of completion: mainnet contract ID published; 3+ real-money deals settled.
- Reviewer evidence: mainnet transaction hashes; deal summary.
- Budget: $20,000.

Deliverable 3.2: Quantified mainnet activity
- Description: 50+ mainnet deals across 3 named B2B verticals; $250K+ GMV.
- Measure of completion: 50 deals confirmed; $250K cumulative GMV verifiable on Stellar Expert.
- Reviewer evidence: dashboard URL with mainnet activity; vertical breakdown.
- Budget: $20,400.

Note for Q16: SCF grant funds product development only. Marketing, paid distribution, content creator campaigns, and community rewards are self-funded by [Project] via existing revenue.

## Example B: Regulated DeFi yield ($144,000 across 3 tranches of $48,000)

### Tranche 1 (MVP, T+8 weeks)

Deliverable 1.1: YieldVault.rs core implementation
- Description: Soroban vault with deposit, withdrawal, NAV computation, EURC-denominated entry.
- Measure of completion: testnet deployment + 95 percent test coverage + ACCEIS-style internal review.
- Reviewer evidence: testnet contract ID; CI test report; internal security review document.
- Budget: $30,000.

Deliverable 1.2: PerfFeeModule.rs
- Description: Soroban submodule streaming performance fees to LPs and protocol treasury.
- Measure of completion: testnet contract with 3+ fee distribution events at different NAV levels.
- Reviewer evidence: testnet transaction hashes; fee model documentation.
- Budget: $18,000.

### Tranche 2 (Testnet, T+16 weeks)

Deliverable 2.1: DeFindex integration
- Description: vault allocator routes deposits across DeFindex strategies.
- Measure of completion: testnet vault successfully routing to DeFindex with NAV reflecting strategy returns.
- Reviewer evidence: testnet activity; DeFindex integration documentation.
- Budget: $18,000.

Deliverable 2.2: Blend v2 and Aquarius routing
- Description: vault allocator extends to Blend lending pools and Aquarius LP positions.
- Measure of completion: testnet vault with 3-venue allocation (DeFindex + Blend + Aquarius).
- Reviewer evidence: testnet contract activity; allocation strategy document.
- Budget: $18,000.

Deliverable 2.3: Certora audit completion (via LaunchKit credit)
- Description: full security audit by Certora.
- Measure of completion: Certora audit report delivered with mitigations applied.
- Reviewer evidence: audit report PDF; mitigation PRs.
- Budget: $12,000 (covered by Stellar LaunchKit credit, not by grant funds).

### Tranche 3 (Mainnet, T+24 weeks)

Deliverable 3.1: Mainnet launch
- Description: contracts deployed to Stellar mainnet; first cohort of HNW clients onboarded.
- Measure of completion: mainnet contract ID; 5+ named HNW clients with active vault positions.
- Reviewer evidence: mainnet transaction hashes; client summary (anonymized aggregate).
- Budget: $30,000.

Deliverable 3.2: Quantified mainnet AUM and reporting export
- Description: €1M+ AUM in mainnet vault; PSCA-aligned reporting export.
- Measure of completion: AUM verifiable on Stellar Expert; reporting export delivered.
- Reviewer evidence: AUM dashboard; reporting document.
- Budget: $18,000.

Note for Q16: SCF grant funds product development and security audit only. Marketing, paid distribution, AMA hosts, content creator campaigns, and community rewards are self-funded by For Yield via the existing fundraising round.

## Example C: RWA bond tokenization ($132,000 across 3 tranches of $44,000)

### Tranche 1 (MVP, T+8 weeks)

Deliverable 1.1: GreenBondToken.rs core
- Description: whitelisted Soroban token contract with restricted transfer logic.
- Measure of completion: testnet deployment + 95 percent test coverage + restricted-transfer test cases.
- Reviewer evidence: testnet contract ID; CI report.
- Budget: $25,000.

Deliverable 1.2: KYCWhitelist.rs
- Description: Soroban whitelist contract integrating accredited-investor attestation.
- Measure of completion: testnet contract with 10+ test attestations applied to bond transfers.
- Reviewer evidence: testnet activity; attestation model document.
- Budget: $19,000.

### Tranche 2 (Testnet, T+16 weeks)

Deliverable 2.1: CouponDistributor.rs
- Description: Soroban contract distributing quarterly coupons to whitelisted holders.
- Measure of completion: testnet contract with 3+ coupon events to 50+ test holders.
- Reviewer evidence: testnet transaction hashes; coupon distribution report.
- Budget: $22,000.

Deliverable 2.2: Stellar Wallets Kit + DFNS integration
- Description: wallet onboarding for retail-accredited and HNW investors.
- Measure of completion: testnet flow tested with 4 wallet types + DFNS custody.
- Reviewer evidence: testnet activity; integration documentation.
- Budget: $22,000.

### Tranche 3 (Mainnet, T+24 weeks)

Deliverable 3.1: Mainnet launch with first issuance
- Description: first regulated bond issuance under Art L.411-2 CMF on Stellar mainnet.
- Measure of completion: mainnet issuance contract; first €X,000,000 raised.
- Reviewer evidence: mainnet transaction hashes; placement document.
- Budget: $26,000.

Deliverable 3.2: Quantified mainnet activity
- Description: 3+ issuances converted from LOI pipeline (€10M+ cumulative); first coupon distribution on mainnet.
- Measure of completion: issuances verifiable on Stellar Expert; coupon distribution executed.
- Reviewer evidence: dashboard URL; issuance summary.
- Budget: $18,000.

Note for Q16: SCF grant funds product development and regulatory audit only. Marketing, distribution partner integrations, and community education are self-funded by [Project] via the LOI pipeline economics.

## Tranche common mistakes

- "Phase 1 build the contract" without a specific deliverable name or measure. The panel needs verifiable evidence per deliverable.
- "Internal community testing" or "creator campaigns" as a Tranche deliverable. Reviewers read this as marketing budget misuse. Reframe as "internal QA + automated test coverage."
- Tranche 3 with vague mainnet target. Always quantify: "X transactions, Y wallets, $Z TVL, N named clients."
- Missing the Q16 grant note. Always include "SCF grant funds dev work only. Marketing self-funded."
- Tranche sizes wildly unequal ($60K + $30K + $30K). Stay within roughly equal splits.
- Audit cost inside the grant budget. The Stellar LaunchKit credit covers the audit; it should be flagged as such and not double-counted in grant disbursement.
