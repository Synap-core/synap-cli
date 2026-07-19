# The 14-signal scoring framework

Every SCF dossier is scored against 14 signals. Each signal weighs in the panel's review with empirically observable correlation to the final outcome.

For each signal, score the dossier from 1 to 10 where 10 is best in class and 1 is critically weak. The lowest signal is usually the limiting factor.

## Why 14 signals (and not 100, or 5)

Fourteen signals is the number that lets us capture every recurring decision factor in past rounds without producing redundant categories. Below ten, you lose specificity. Above twenty, signals start to overlap and weighting becomes arbitrary.

## The 14 signals

### 1. Team identity (doxxing depth)

What you measure: are every named team member's LinkedIn URLs verifiable, and do they show roles consistent with what the dossier claims? Are GitHub URLs provided for technical roles?

**Score 9 to 10:** all founders fully doxxed, LinkedIn URLs and GitHub URLs verifiable, public credentials match the dossier claims.

**Score 7 to 8:** founders doxxed but missing one piece (no GitHub for CTO, or LinkedIn URL formatted but no https prefix).

**Score 5 to 6:** at least one founder partially anonymous (only handle, no real name) and the dossier asks $100K or more.

**Score 1 to 4:** anonymous-ish team OR clear misrepresentation between dossier claim and verifiable LinkedIn.

Why the panel weighs this: the grant is public money. The panel needs to know who to follow up with if the project goes off the rails. They cannot follow up with a Discord handle.

### 2. Stellar-native traction

What you measure: is there a deployed Soroban testnet or mainnet contract address verifiable on Stellar Expert? Does the dossier name an existing Stellar product live, or is everything "to be built"?

**Score 9 to 10:** contracts already deployed to testnet or mainnet with verifiable addresses.

**Score 7 to 8:** team is Stellar-experienced (prior Stellar projects, Stellar dev community member, Stellar Hackathon).

**Score 5 to 6:** team is crypto-experienced but on other chains (EVM, Solana), Stellar planned but no on-chain artifact yet.

**Score 1 to 4:** zero crypto experience visible.

Why the panel weighs this: this answers "can you actually ship on Stellar?" Demos and screenshots are persuasive; promises are not.

### 3. Budget realism vs scope

What you measure: does the requested budget match the deliverable scope, and is the per-tranche allocation realistic?

**Score 9 to 10:** budget anchored on a named past winner with comparable scope, sub-max ($120K-$135K), structure 3 equivalent tranches.

**Score 7 to 8:** budget reasonable but not anchored, scope clear.

**Score 5 to 6:** budget at $140K-$150K maximum without clear scope justification.

**Score 1 to 4:** maximum $150K ask with a small team or vague scope.

Why the panel weighs this: maximum-ask submissions trigger heightened scrutiny because past rounds have seen abuse. Submissions below the maximum get less skepticism.

### 4. Scope clarity

What you measure: does the integration description name specific Soroban contract files (DealEscrow.rs, YieldVault.rs, GreenBond.rs), specific SCF Integration List items, and a phased timeline?

**Score 9 to 10:** named contracts, named Integration List items, 3 phases with timeline.

**Score 5 to 6:** description is generic, no named contracts or specific items.

**Score 1 to 4:** the description is a wish list of features with no architecture.

Why the panel weighs this: scope clarity is the proxy for execution clarity. Vague descriptions correlate with vague execution.

### 5. Differentiation from previously-funded teams

What you measure: is the dossier in a category where SCF has already funded a similar project recently, and does it explain how it complements rather than duplicates?

**Score 9 to 10:** the dossier explicitly cites past Stellar-funded projects (DeFindex, Aquarius, Blend) and positions as complementary.

**Score 5 to 6:** the dossier is in a recently-funded category but no explicit acknowledgment.

**Score 1 to 4:** direct duplication of an already-funded project.

Why the panel weighs this: SCF wants ecosystem coverage, not redundancy.

### 6. Track choice fit

What you measure: did the dossier pick Integration Track, Open Track or RFP Track correctly?

**Score 9 to 10:** Track choice obviously correct (Integration Track when extending existing primitives, Open Track when net-new).

**Score 5 to 6:** Track choice defensible but could go either way.

**Score 1 to 4:** Track choice mismatched (Open Track for a wrap of existing primitives).

Why the panel weighs this: the wrong Track means the wrong evaluation criteria; reviewers notice when scope and Track don't fit.

### 7. Go-to-market specificity

What you measure: does the GTM plan name specific countries, customer personas, distribution partners, and a credible first-100-users plan?

**Score 9 to 10:** named partners (Black Manta, Brickken, etc.), named first customers (LANGA International, Metz Handball), named user acquisition channel.

**Score 5 to 6:** GTM is described but partners are generic or unnamed.

**Score 1 to 4:** GTM is "we will target [region]" or "for crypto-native users" or any other unspecific phrasing.

Why the panel weighs this: SCF wants to fund projects that will actually find users, not infrastructure that will sit idle.

### 8. Milestone precision

What you measure: do the Build deliverables include specific verifiable evidence (contract IDs, transaction hashes, video walkthroughs, dashboard URLs) and quantified targets (e.g., "$1M AUM", "100 wallets connected", "500 transactions")?

**Score 9 to 10:** each deliverable has a measurable, verifiable evidence requirement.

**Score 5 to 6:** deliverables described but evidence is vague.

**Score 1 to 4:** deliverables described as phases ("Phase 1, Phase 2") without measurable evidence.

Why the panel weighs this: every tranche review depends on the panel being able to verify a deliverable. Unverifiable milestones make every tranche review subjective.

### 9. Traction evidence

What you measure: does Q4 (Abstract) or Q9 (Build) contain verifiable evidence: live URLs, contract addresses on other chains, named pilot customers, signed LOIs, real revenue figures, real user counts?

**Score 9 to 10:** signed LOIs with named entities, real revenue, deployed contracts, named industry recognitions (French Tech, BaFin, etc.).

**Score 5 to 6:** some metrics shared but not externally verifiable.

**Score 1 to 4:** "we are in discussions with X" or "early interest from Y" without any verifiable artifact.

Why the panel weighs this: hand-wavy traction claims correlate strongly with later non-delivery.

### 10. Regulatory framing

What you measure (only for regulated-category dossiers like payments, lending, security tokens, gold, real estate): does the dossier name the specific regulatory framework (Art L.411-2 CMF, MiFID II, MiCA, EP simplifie, PSCA AMF, BIN sponsor, etc.) and the named licensing partner?

**Score 9 to 10:** named framework, named partner, dossier filed proof (For Yield-style PSCA AMF dossier filed).

**Score 5 to 6:** named framework but no named partner.

**Score 1 to 4:** "we will comply" or "subject to regulation" without specifics.

Why the panel weighs this: regulated products without regulatory plans have a near-100 percent failure rate in deployment.

### 11. Open-source posture

What you measure: does the dossier commit to publishing the Soroban contracts under MIT or Apache 2.0?

**Score 9 to 10:** explicit MIT commitment with planned GitHub URL.

**Score 5 to 6:** mention of "open-source" without license specified.

**Score 1 to 4:** no mention of open-source.

Why the panel weighs this: SCF is a public-good fund; reusable primitives are the highest return for the ecosystem.

### 12. Brand non-collision

What you measure: does the project name conflict with a well-known unrelated company (Tessera Labs vs a16z's Tessera, Neon Wallet vs Neo Wallet vs Neon EVM, Solo vs SatoshiPay Solar) that would create SEO confusion or panel mistrust?

**Score 9 to 10:** project name is unique and searchable.

**Score 5 to 6:** mild name overlap but unlikely to cause confusion.

**Score 1 to 4:** direct overlap with a major brand in the same or adjacent vertical.

Why the panel weighs this: panel members do their own Google searches.

### 13. SDF roadmap alignment

What you measure: does the project align with the Stellar Development Foundation's current strategic priorities (x402 micropayments, Protocol 25 X-Ray ZK primitives, EURC adoption, MiCA EU institutional access, agentic payments)?

**Score 9 to 10:** explicit mention of how the project leverages or complements SDF's roadmap.

**Score 5 to 6:** alignment is implicit but not stated.

**Score 1 to 4:** the project would have looked the same with no awareness of SDF roadmap.

Why the panel weighs this: SDF priorities reflect where the foundation wants ecosystem growth.

### 14. Comeback signal (only for reapplying teams)

What you measure (only if the dossier is a reapplication after a previous rejection): does the dossier explicitly acknowledge the prior gap and explain what changed?

**Score 9 to 10:** explicit "we addressed the previous panel's concerns by X".

**Score 5 to 6:** no mention but the changes are visible.

**Score 1 to 4:** no mention and the same gaps remain.

Why the panel weighs this: SCF panels respect teams that learn. They distrust teams that re-submit unchanged dossiers.

## How to use the scores

After scoring all 14, three numbers matter:

1. **Lowest signal**: this is the limiting factor. Fixing this lifts overall probability more than any other action.
2. **Average score**: gives a rough probability of acceptance (avg 8.0+ = high probability, avg 5.0 to 7.0 = medium, below 5.0 = low).
3. **Count of signals below 5**: the more sub-5 signals, the more blockers in the dossier.

Always report the lowest signal explicitly in your review. Make the client see what the panel will see.

## A note on weights

The 14 signals are not weighted equally. In practice, signals 1 (team identity), 9 (traction evidence) and 10 (regulatory framing for regulated categories) carry the most weight. A dossier with weak team identity rarely recovers regardless of other strengths. The order in which we list signals is roughly the order of weight.
