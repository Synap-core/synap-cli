# The Arch Consulting: Associate Onboarding Guide

**Read time: 90 to 120 minutes. Read once end-to-end, then use as a reference.**

This document onboards you to The Arch Consulting's Stellar Community Fund (SCF) grants advisory practice. By the end, you will understand Stellar as a protocol, the SCF program in detail, the methodology we use to win grants for our clients, our active client portfolio, and how to use the AI skill we built to do the work.

You do not need a prior crypto background. Where vocabulary matters, it is defined inline.

## Table of contents

1. Welcome and your role
2. Stellar protocol 101 (what it is, why it exists, what it does well)
3. The Stellar ecosystem (foundation, stablecoins, key infrastructure, funded projects)
4. The Stellar Community Fund (SCF) explained
5. The grant lifecycle (Abstract, Build, Tranches, statuses)
6. Our methodology in one chapter
7. The fourteen evaluation signals and what they actually measure
8. The twelve recurring rejection patterns explained
9. Our client portfolio (active and recent)
10. The frequently-asked client questions with model answers
11. How to use the AI skill in Claude
12. The associate's first thirty days

---

## 1. Welcome and your role

### What The Arch Consulting does

We help Web3 teams win Stellar Community Fund grants. The Stellar Foundation awards up to $150,000 USDC per Build Award submission. Approximately fifty to eighty teams submit per round. Approximately twenty-five to thirty percent get funded. The remaining seventy to seventy-five percent are rejected.

Our value to clients is the difference between the rejected bucket and the awarded bucket. We have built a database of every visible SCF Build Award submission since SCF round forty (#40), including which dossiers won, which lost, why, and how the winners structured their dossier. From this data, fourteen evaluation signals and twelve recurring rejection patterns emerge consistently. We turn this pattern intelligence into a rewrite plus checklist plus budget recommendation that the client uses to submit.

### What you will do

As an associate at The Arch Consulting your weekly mix typically includes:

- Reviewing client dossiers (Abstracts and Build submissions) and producing the Excel deliverable.
- Drafting outreach to prospective clients (Web3 teams about to submit to SCF or just rejected).
- Sourcing and tracking new SCF submissions across rounds as they open.
- Maintaining the corpus database of past winners and rejects.
- Participating in client kickoff and review calls.

You will spend roughly forty percent of your time on review work, twenty percent on outreach, twenty percent on database maintenance, twenty percent on client communication.

### What success looks like

A successful associate produces reviews that clients can act on without follow-up questions. Every deliverable contains: a probability estimate (before and after fixes), a prioritized checklist with effort estimates, paste-ready rewrites in English, a budget recommendation anchored on a named past winner, and an audit of Stellar Integration List usage.

If a client asks you "what should I do tomorrow morning?" after reading your review, the answer is in the deliverable. If not, the review is incomplete.

### Internal vocabulary vs client-facing language

We have internal shorthand we use in team chat ("kill signature", "corpus", "doxxing depth", "bolt-on rejection"). None of these words go to clients. The full translation table is in `reference/12-client-communication.md`. The single most important rule: never use the term "kill signature" in any client deliverable. Use plain English phrases like "recurring rejection pattern" or "red flag for SCF reviewers" and pair them with named past dossiers.

---

## 2. Stellar protocol 101

### What Stellar is, in plain English

Stellar is a public blockchain network designed for fast, cheap, cross-border payments and asset issuance. It was launched in 2014 by Jed McCaleb, who co-founded Ripple (XRP) and previously created the early Mt. Gox exchange. Stellar forked from Ripple in 2014 over disagreements about open-source values. The Stellar Foundation (SDF) was created the same year as a non-profit to steward the protocol.

Stellar's core differentiation has stayed consistent for a decade: it is fast, cheap, and built to settle real-world money flows. Transactions confirm in roughly five seconds. Average transaction cost is well under one cent. Stablecoins (USDC, EURC, BRL) are first-class citizens of the network rather than bolted on as ERC-20 wrappers.

### How Stellar differs from Ethereum and Solana

- **Ethereum** is a general-purpose smart contract platform. Transaction costs vary from a few dollars to many dollars depending on network demand. Smart contracts run on the Ethereum Virtual Machine (EVM) in Solidity. The model is "world computer".
- **Solana** is a high-throughput chain optimized for speed (sub-second finality, sub-cent fees, but periodically halts under load). Smart contracts run on the Solana Virtual Machine in Rust. The model is "fastest chain".
- **Stellar** is optimized for payments and asset issuance with sub-cent fees, five-second finality, and a Federated Byzantine Agreement consensus (no proof of work, no proof of stake). Smart contracts (Soroban) launched in 2024 and run in Rust+WebAssembly. The model is "payments and tokenized assets settlement layer".

The differentiation matters for SCF because:
- Many dossiers we review come from teams that built on EVM or Solana and want to port. Reviewers care about why Stellar specifically rather than as a third deployment target. Sub-cent fees enable use cases that EVM gas (multiple dollars) would break: peer-to-peer gold trades, ticket secondary markets, microcurrency payouts, content royalties.
- The Soroban runtime is Rust+WASM (not EVM Solidity). This matters when reviewing technical architecture: contracts are written in Rust, audited differently than Solidity contracts, and integrate via the Soroban SDK.

### Soroban: Stellar's smart contract platform

Soroban launched on Stellar mainnet in 2024 (Protocol 20). Key facts you need:

- Soroban contracts are written in Rust and compiled to WebAssembly (WASM).
- Each contract has a unique contract ID (a Stellar address). You can look up any contract on Stellar Expert (https://stellar.expert) and see the state, the WASM hash, and recent transactions.
- Soroban supports standard primitives: tokens (SAC, the Stellar Asset Contract), AMMs, vaults, escrows, identity, oracles.
- Native USDC, EURC, and other Stellar assets can be wrapped as Soroban tokens via SAC for use in smart contracts.

When reviewing a dossier, you will often hear:
- "Atomic Splits" = a Soroban payout pattern that automatically routes a single incoming payment across multiple recipients in one transaction. Used by The Signal escrow, planned for Tickie ticketing royalties, etc.
- "SAC wrapper" = the Stellar Asset Contract bridges a native Stellar asset (USDC, EURC) into Soroban so smart contracts can manipulate it.
- "Passkey Kit" = a Soroban-aware passwordless authentication primitive that lets users sign transactions with their device's biometric authentication (no seed phrase).

### Protocol versions and what they mean

Stellar advances via Protocol versions. Reviewers expect dossiers to align with the current and upcoming Protocol roadmap.

- **Protocol 20 (early 2024)**: Soroban smart contracts launch on mainnet.
- **Protocol 21, 22, 23, 24**: incremental Soroban improvements (multi-contract upgrade, archived state, performance).
- **Protocol 25 (codename "X-Ray")**: native ZK primitives. This means privacy and compliance features will be at the protocol level, not at the wallet level. Dossiers that propose wallet-level ZK MFA (Stellaray, zkVault) get rejected because Protocol 25 is doing it natively.

### Strategic priorities at the foundation level

When you advise clients, you want to align dossiers with what SDF is currently prioritizing. The current themes (as of 2026):

- **x402**: an HTTP-native micropayments standard. Stellar is a key adopter. Dossiers that build x402 infrastructure (especially for agentic AI payments) get positive panel signal.
- **Protocol 25 X-Ray**: native ZK primitives. Dossiers that leverage these (rather than duplicate) get positive signal.
- **EURC adoption and MiCA EU access**: the European stablecoin market is the foundation's growth theater. Regulated DeFi for EU institutional investors (For Yield), tokenized RWA in EU jurisdictions (Rebond, Antevorta), MiCA-compliant on-ramps all align.
- **Agentic payments**: AI agents paying for services autonomously. Some emerging dossiers position here (ASGCard tried; got rejected for lack of BIN sponsor).
- **Real-World Assets (RWA)**: real estate, bonds, gold, securities tokenization. Bando ($75K winner SCF #42 Mexican real estate) is the bellwether.

If a dossier you are reviewing aligns with one of these themes, surface it in the review as a strength.

---

## 3. The Stellar ecosystem

### The Stellar Development Foundation (SDF)

SDF is the non-profit that maintains the Stellar protocol and runs the SCF grants program. Based in San Francisco. Funded by a portion of the original 100 billion XLM (Stellar's native asset) at network genesis.

SDF's mandate is ecosystem growth. They build core infrastructure (Stellar Lab, scaffold-soroban, Freighter wallet, Anchor Platform, Stellar Disbursement Platform, Stellar SDK). They publish standards (SEPs, Stellar Ecosystem Proposals). They run SCF.

You will hear "SDF" mentioned as the panel decision-making body for SCF Build Awards. In practice, SCF panels are a rotating committee of senior engineers, BD leads, and ecosystem partners. SDF approves the framework and budget envelope.

### The native asset: XLM

XLM (Stellar Lumens) is the native asset. It is used to pay transaction fees and serves as the reserve asset for accounts. You will rarely interact with XLM in SCF review work because:
- Grants are paid in USDC, not XLM.
- Most user-facing applications hold and transact stablecoins, not XLM.
- XLM price movement does not factor into SCF dossiers.

### Stablecoins on Stellar

The stablecoin story is the single most important commercial fact about Stellar.

- **USDC on Stellar**: Circle's stablecoin issued natively on Stellar since 2021. Stellar is one of Circle's two preferred chains (along with Solana for high-throughput, Ethereum for DeFi). USDC volume on Stellar is in the billions per month. The grant from SCF is paid in USDC on Stellar.
- **EURC**: Circle's euro stablecoin. Less liquid than USDC but a strategic priority for EU adoption.
- **BRL** and other regional stablecoins: smaller but growing in Brazil, Africa, LATAM.

When a client asks "where do I keep the USDC?" the answer involves a Stellar wallet (Freighter, LOBSTR, Albedo, xBull, Hana) holding their public address. The grant is sent from SDF's address to the client's address in tranches.

### Key ecosystem infrastructure

You will see these names in nearly every dossier. Memorize them.

- **Freighter**: SDF's browser extension wallet. Stellar-native.
- **LOBSTR**: a popular mobile wallet for Stellar.
- **Albedo, xBull, Hana**: other community wallets connected via Stellar Wallets Kit.
- **Stellar Wallets Kit**: an open-source multi-wallet connector. Default for any consumer-facing dossier. On the SCF Integration List.
- **Privy**: an embedded wallet provider (email or social login). Used for non-crypto-native distribution (financial advisors, family offices, mainstream gamers). On the SCF Integration List.
- **DFNS**: wallet-as-a-service with MPC custody. Used for institutional custody requirements. On the SCF Integration List.
- **Passkey Kit**: passwordless biometric authentication on Soroban. Used for mainstream consumer onboarding (no seed phrase).
- **Anchor Platform**: SDF's framework for building your own anchor (the bridge between fiat and Stellar assets). Required for any project that needs to convert EUR or USD to USDC. On the SCF Integration List.
- **Bridge**: a Stripe-acquired payment processor with Stellar integration. Alternative to Anchor Platform for some use cases. On the Integration List.
- **MoneyGram**: cash-in cash-out for emerging markets. On the Integration List.
- **Soroswap**: a DEX aggregator on Soroban (built by Palta Labs, who also built DeFindex). On the Integration List.
- **Aquarius**: a Stellar DEX with around $40M TVL. On the Integration List.
- **Blend (Blend v2)**: a lending protocol on Soroban. On the Integration List.
- **DeFindex**: a yield aggregator middleware (also Palta Labs). On the Integration List.
- **Allbridge, Axelar, Near Intents**: cross-chain bridges. On the Integration List.
- **Stellar Disbursement Platform (SDP)**: SDF's bulk payment rail. On the Integration List.
- **Stellar Expert** (https://stellar.expert): the block explorer. Verify any contract or transaction here.
- **Stellar Lab** (https://lab.stellar.org): SDF's dev playground for testing transactions and contracts.
- **scaffold-soroban**: SDF's Soroban project scaffold.

### Past SCF-funded projects you should know

These are reference points you will cite often.

- **DeFindex**: yield aggregator middleware. Funded in earlier SCF rounds. Now an Integration List item. Used by For Yield as yield routing layer.
- **Blend (v2)**: lending pool primitive. Funded in earlier rounds. Integration List item. Used by For Yield.
- **Aquarius**: Stellar DEX. Funded in earlier rounds. Integration List item.
- **Soroswap**: DEX aggregator. Funded. Integration List item.
- **The Signal**: B2B marketplace with Soroban escrow. Won $121K in SCF #42. The most useful $115K-$125K anchor.
- **Bando**: Mexican RWA real estate. Won $75K in SCF #42. The most useful $75K-$90K anchor.
- **TheXBank**: Africa banking infrastructure. Won $89.5K in SCF #40.
- **Helix Labs / Reactor Trade**: trading infrastructure SCF #41 RFP winner.
- **Rumble Fish, OBSRVR Prism**: SCF #41 RFP block explorer winners.
- **Latch + KMP**: SCF #41 RFP compliance tooling winners (for C-Address).
- **Orion + OctoPos**: SCF #41 RFP DeFi Positions API winners.
- **Sorobanhooks**: a reference dossier mentioned in SCF guidance for Technical Architecture documentation quality.

The full annotated catalog is in `reference/10-corpus-winners.md`.

---

## 4. The Stellar Community Fund (SCF) explained

### What SCF is

The Stellar Community Fund is SDF's grants program. It exists to fund teams building on Stellar. There are multiple award types; the one we focus on is the **Build Award**.

The Build Award pays up to $150,000 in USDC per accepted submission. Funds are released in three "tranches" over the project lifecycle. Each tranche is roughly equivalent (a third of the total budget) and is released after a milestone review.

### The Build Award tracks

A Build Award submission picks one of three tracks. The track defines what the panel is evaluating.

- **Integration Track**: the dossier extends or wraps existing Stellar primitives (Stellar Wallets Kit, Anchor Platform, Soroswap, DeFindex, Privy, etc.). The strongest dossiers in this track leverage three to seven Integration List items. Most of our clients submit here.
- **Open Track**: the dossier develops a net-new primitive not yet in the ecosystem (a new oracle, a new bridge architecture, a confidential-payments protocol). Panel scrutiny on Open Track is higher because "is this really net-new?" gets investigated.
- **RFP Track**: SCF publishes specific Requests For Proposal (compliance tooling, DeFi Positions API, block explorer) and teams submit specifically for these. Won by Latch+KMP, Orion+OctoPos, Rumble Fish, OBSRVR Prism in SCF #41.

When in doubt, Integration Track is the safer choice. Detail on track choice in `reference/02-scoring-framework.md` and the per-track guide in `reference/07-integration-list.md`.

### The cadence of rounds

SCF runs in numbered rounds. Each round opens for submissions, closes, goes through a pre-screen, then panel review, then awards.

Recent rounds:
- **SCF #40**: closed and awarded. Used as historical corpus.
- **SCF #41**: closed and awarded. Includes RFP track winners.
- **SCF #42**: closed and awarded. The Signal $121K, Bando $75K are key wins from this round.
- **SCF #43**: a specific round we've tracked.
- **SCF #44**: the active round for current clients (Rebond, For Yield, Solar Braves, Tickie, Antevorta, Grindy).

Rounds open roughly every six to ten weeks. The deadline is hard. After deadline, dossiers cannot be edited.

### The Build Award lifecycle

A team's path through SCF Build Award:

1. **Abstract submission**: a high-level pitch with twelve fields (project title, description, traction, integration plan, team, budget envelope). Reviewed for Abstract acceptance.
2. **Abstract acceptance or rejection**: panel decides whether the team can proceed to the Build phase. Many dossiers die here.
3. **Build submission**: a detailed proposal with seventeen fields (code URL, video, technical architecture, three tranches of deliverables, budget total, go-to-market plan). This is the full proposal.
4. **Pre-screen by SCF team**: the SCF team checks for completeness (mandatory fields, video, thumbnail, code URL, architecture URL). Incomplete dossiers go to "Information Collection" status and often die there.
5. **Panel review**: the panel evaluates and votes.
6. **Award decision**: the dossier is funded, rejected, or sent to community vote.
7. **Tranche 1 milestone**: after the team delivers Tranche 1 deliverables, they submit for review.
8. **Tranche 2 milestone**: same.
9. **Tranche 3 milestone**: same. Mainnet typically targeted here.

The lifecycle from initial Abstract submission to Tranche 3 mainnet delivery is roughly six to nine months for a healthy project.

### Award statuses

You will see these on dossier records.

- **Awarded**: funded.
- **Rejected**: panel rejected.
- **Panel Review Failed**: explicit panel-level rejection. The strongest rejection signal.
- **Information Collection**: dossier never reached panel review because mandatory items were missing. Many teams never respond and the dossier dies in this status.
- **Pre-screen Rejected**: SCF team rejected before panel.
- **Community Vote**: rare, when the panel sends the decision to a wider community vote.

### Disbursement mechanics

When a tranche is approved:
- USDC on Stellar is sent to the project's verified wallet address.
- The team uses the funds per the proposal.
- Funds are not subject to KYC at the moment of disbursement (the team's entity was KYBed at Abstract or pre-Tranche-1 stage).
- The team owes the panel deliverable verification at the next tranche review.

### Costs the grant cannot pay for

This is critically important. The SCF grant funds product development. It does NOT fund:
- Marketing or paid distribution.
- User acquisition costs.
- Creator campaigns or paid AMA hosts.
- Cosmetic or art assets unrelated to the technical build.
- Office space, payroll outside the dev work.

When you write a review, the dossier should include a clear "grant note" in Q16 (Build phase) that states: "The SCF grant funds product development only. Marketing and user acquisition are self-funded by the team." This single sentence blocks the most common reviewer suspicion about budget misuse.

---

## 5. The grant lifecycle in more detail

This section walks through what happens at each stage so you can advise clients precisely.

### Stage 1: pre-Abstract reconnaissance

Before submitting an Abstract, the team should:
- Verify project name does not collide with major unrelated brands (Google search + crypto news).
- Verify the Track choice (Integration vs Open vs RFP).
- Check if the same category has been funded recently (Lend.xyz lost to Bando in SCF #42 RWA real estate; they could have picked a sharper sub-niche).
- Draft the team section with verifiable LinkedIn URLs for every named founder.
- Decide on a budget anchor (we recommend $75K to $135K range, sub-max).

We typically engage at this stage if the client comes to us early.

### Stage 2: Abstract submission

Twelve fields. Field-by-field guide in `reference/08-abstract-fields.md`. The single most consequential field is **Q2 Description** (1000 characters): the elevator pitch that decides whether the panel reads the rest with enthusiasm or skepticism.

Other key fields:
- Q4 Traction: live URLs, metrics, named clients, recognitions.
- Q6 Integration Description: phased timeline with named Soroban contracts and Integration List items.
- Q10 Team: full names, LinkedIn URLs, GitHub for CTO, verifiable experience.

### Stage 3: Abstract review by SCF

The Abstract is reviewed for fit. Approved Abstracts move to Build phase. Rejected Abstracts can be reapplied in a future round if the issues are addressed.

### Stage 4: Build submission

Seventeen fields. Field-by-field guide in `reference/09-build-fields.md`. The most blocker-prone fields:
- Q5 Code URL: must be a public GitHub repository (ideally with testnet contract deployed before submission).
- Q6 Video URL: under 3 minutes, founder on camera, live demo of testnet contract.
- Q10 Technical Architecture: public Notion or GitHub markdown with C4-style diagrams.

Empty Q5, Q6, or Q10 is pre-screen rejection. Multiple past dossiers died this way (The Strategists, Cushion, Payala, Neon Wallet, SendbyKatika).

### Stage 5: pre-screen

SCF team checks completeness. If any mandatory field is missing or the dossier is unclear, the SCF team puts the dossier in "Information Collection" status and contacts the team. Many teams never respond and the dossier dies.

### Stage 6: panel review

The panel reads, scores, and votes. Panel members are senior SDF engineers, BD leads, and rotating ecosystem partners. The panel applies the same patterns we have catalogued: doxxing depth, budget realism, scope clarity, regulatory framing, Integration List usage.

### Stage 7: award decision

Awarded, Rejected, or Panel Review Failed. PRF is the strongest rejection signal (panel was confident enough to reject explicitly).

### Stage 8: Tranche 1 delivery and review

The team delivers the Tranche 1 milestones (typically MVP scope) and submits for review. The reviewer checks the deliverables against the proposal. Verifiable evidence (contract addresses, test suite passing, walkthrough video) makes the review fast.

### Stage 9: Tranche 2 delivery and review

Tranche 2 typically covers testnet end-to-end flows. Tranche 2 unlocks the Stellar LaunchKit audit credit (paid for by SDF, often Certora).

### Stage 10: Tranche 3 delivery and review

Mainnet target. The final review checks mainnet deployment plus quantified metrics (transactions, wallets, TVL).

After Tranche 3 the grant is complete. The team retains ownership of the open-source contracts they shipped (typically MIT or Apache 2.0). SDF tracks ecosystem outcomes (volume, users, ecosystem fork usage).

---

## 6. Our methodology in one chapter

This chapter is a brief recap. Full detail in `reference/01-methodology.md` and `reference/12-client-communication.md`.

### The seven-step review process

1. **Read what the client submitted** carefully. Every field.
2. **Read every public source** about the project: website, deck, founder LinkedIns, prior GitHub repos.
3. **Score against the 14 signals** (next chapter).
4. **Identify recurring rejection patterns** triggered by the dossier and cite past examples by name.
5. **Surface winning patterns** the dossier already has, so we preserve them in any rewrite.
6. **Compare to 10-15 corpus comparables** side-by-side.
7. **Generate the Excel deliverable** plus the chat summary.

### The four sheets we always produce

- Sheet 1: Field-by-field review (Status, Review commentary, Paste-ready English rewrite).
- Sheet 2: Pre-submission checklist (Priority, Item, Field, Effort, Why it matters, Done).
- Sheet 3: Corpus comparables (10-15 past dossiers side-by-side with the client).
- Sheet 4: Integration List audit (each Stellar Integration List item with status: Mentioned, To Add, Optional, Not Relevant).

Full Excel spec in `reference/13-excel-output-spec.md`. Templates ready to customize in `templates/`.

### The communication rule

The client never sees our internal vocabulary. "Kill signature" stays internal. To the client we say "common rejection pattern we have observed in past SCF rounds" or "recurring red flag for SCF reviewers" followed by the named past dossiers that triggered it.

The client also never sees em-dashes in our deliverables. They read as machine-generated and dilute the perceived craft. Use commas, colons, parentheses, or single hyphens instead.

---

## 7. The fourteen evaluation signals

Brief version. Full detail in `reference/02-scoring-framework.md`.

When you score a dossier, you assign each signal a number from 1 (critical weakness) to 10 (best in class). The lowest signal is the limiting factor. Fixing it lifts the dossier more than any other action.

### 1. Team identity (doxxing depth)

Can the panel verify every named team member? LinkedIn URLs for everyone, GitHub for CTO, real names not handles.

### 2. Stellar-native traction

Has the team shipped on Stellar before? A deployed testnet or mainnet contract address is the strongest evidence. Otherwise, prior Stellar hackathon, dev community participation, or a credible Stellar integration commitment.

### 3. Budget realism vs scope

Does the requested budget match the scope? Maximum ask ($150K) triggers heightened scrutiny. Sub-max ($75K-$135K) is the safer zone.

### 4. Scope clarity

Are the Soroban contracts named (DealEscrow.rs, YieldVault.rs)? Are Integration List items named? Is there a phased timeline?

### 5. Differentiation

Has SCF funded a similar project recently? If yes, does this dossier position as complement rather than duplicate?

### 6. Track choice fit

Integration vs Open vs RFP. Is the choice defensible?

### 7. Go-to-market specificity

Named countries, named partners, named first customers, named distribution channel. Not "Pan-Africa" or "global".

### 8. Milestone precision

Do the Build deliverables include verifiable evidence (contract IDs, test suites, dashboard URLs) and quantified targets ($1M AUM, 100 wallets, 500 transactions)?

### 9. Traction evidence

Live URLs, contract addresses, named pilot customers, signed Letters of Intent, real revenue, real user counts.

### 10. Regulatory framing

For regulated categories (payments, lending, securities, RWA, gold): named regulatory framework, named license partner, named KYC vendor.

### 11. Open-source posture

Explicit MIT or Apache 2.0 commitment on Soroban contracts.

### 12. Brand non-collision

Does the project name conflict with a well-known unrelated company?

### 13. SDF roadmap alignment

Does the project align with current SDF strategic priorities (x402, Protocol 25 X-Ray, EURC, MiCA, agentic payments)?

### 14. Comeback signal

For reapplying teams: did the dossier acknowledge prior gaps and explain what changed?

---

## 8. The twelve recurring rejection patterns explained

Brief plain-English version. Full detail with named examples in `reference/03-rejection-patterns.md`.

### Pattern 1: founders not publicly identifiable for a high-ask request

The dossier asks $100K+ but at least one founder is only a handle, has no LinkedIn URL, or the CTO has no GitHub URL. The panel cannot verify accountability. Example fail: Sorotrack ($150K rejected three times), AION_FI ($146.5K PRF), Tessera Labs ($150K).

### Pattern 2: maximum budget ($150K) without proportionate scope

Small team, feature-level deliverable, no named pilot customer. Examples: reb.cash, Stellar Fintech OS, StellarRead, Cicero, Payala, Paenote, ViFi Labs.

### Pattern 3: generic project name

The project name is the literal category ("Stellar Fintech OS", "Soroban Block Explorer", "Galactic Playground"). Examples: Stellar Playground v2, Stellar Fintech OS, Galactic Playground, Stableyard.

### Pattern 4: brand collision with a major unrelated company

The project name overlaps with a major unrelated brand. Examples: Tessera Labs (vs a16z's Tessera), Theo (vs theo.xyz Hack VC trading firm), Neon Wallet (vs Neo blockchain Neon), Solo (vs SatoshiPay Solar), Stellar Fintech OS (vs Romanian core-banking FintechOS).

### Pattern 5: multi-chain port without a Stellar-specific reason

The team is established on Solana or EVM and proposes a "Stellar integration" with no Stellar-native commitment. Examples: Nuvolari.ai (Sonic), $NRG Token (Solana), Nomadz (Solana), Astrix (Algorand), WOWMAX (EVM), Kima (multi-chain), All Access Fans (Nigeria Web2), PathPulse AI (rejected twice).

### Pattern 6: duplicates SDF roadmap work

The project proposes work SDF is shipping at protocol level. Examples: Nebula Wallet (post-quantum crypto while SDF explores at protocol layer), zkVault, StellaRay, Galeon (ZK MFA while Protocol 25 X-Ray ships), Move-to-Stellar (alternate VM contradicting Rust+WASM choice), Tessera Labs (confidential payments duplicating X-Ray).

### Pattern 7: overlap with already-funded SCF projects in recent rounds

Examples: Lend.xyz (RWA real estate while Bando $75K won the same round), C-Address Toolkit (lost to Latch + KMP same RFP), StellarScope (lost to Orion + OctoPos same RFP), Soroban-first Block Explorer (lost to Rumble Fish + OBSRVR Prism), Reactor Trade (lost to Helix Labs same round with same co-founder).

### Pattern 8: regulated product without a regulatory plan

Payments, lending, identity, RWA, securities-adjacent without jurisdiction-specific compliance. Examples: StellarCredit (invoice factoring), AION_FI (credit cards no BIN sponsor), ASGCard (virtual cards no BIN sponsor), Resolva (Africa crypto-to-fiat no license), Stablpay (India stablecoin no FIU details), Kyros OS (Spanish tax no AEAT partner), Easner (no banking partner), Goated App (predictions no licensing).

### Pattern 9: vague TAM ("Pan-Africa", "Global", "2 Billion Users")

Examples: StellaRay ("2 Billion Google Users"), Joblad ("Africa's informal workforce"), Azawire ("Web3 Banking for Africa"), Paenote ("Africa B2B"), MOJA ("group savings for refugees"), Resolva ("Africa remittance corridors"), Stableyard ("Asia's QR networks").

### Pattern 10: earn-via-low-effort-activity (read-to-earn, learn-to-earn, watch-to-earn, fan-token-rewards)

100 percent rejection rate in our corpus. Examples: StellarRead, Gameduk (gamified EdTech), Stellar Nexus Experience (XP/badges), EduAfrica, $NRG Token.

### Pattern 11: incomplete dossier (Information Collection status)

Empty mandatory fields, missing thumbnails, missing video URL, missing architecture URL. The dossier dies before panel review. Examples: The Strategists ($150K), Cushion ($118.4K), Payala ($150K), Neon Wallet ($129K), SendbyKatika ($150K).

### Pattern 12: explicit Panel Review Failed (the cluster)

The hardest fail. The panel explicitly rejected. Sorotrack, Payala, StellarRead, Cicero, Solar, MOJA, Easner, Riwe, Paenote, OverSync, Galeon, Remitance, StellarCredit, PhishGuard, Offer-Hub.

---

## 9. Our client portfolio (active and recent)

Each profile gives you what you need to discuss the client in a meeting or write a follow-up message. Read the row that matters before any client call.

### The Signal (SCF #42 winner, $121K)

- **Category**: B2B marketplace with Soroban escrow.
- **Founders**: Samir Touinssi (CEO, Arch Consulting, content creator 10+ years) and Leo Leung (COO, Imperial College Physics, Orichal Partners quant researcher).
- **Build**: DealEscrow.rs (Soroban) with Atomic Splits payout. Stellar SDK, Freighter, Albedo wallets. Prior Stripe Connect product (50+ verified service providers).
- **Why it won**: doxxed team, named Soroban primitive (DealEscrow.rs), Atomic Splits as a clear ecosystem-relevant pattern, B2B clarity, sub-max $121K budget.
- **Use as anchor for**: B2B marketplaces, escrow protocols, B2B settlement infrastructure, dossiers at $115K-$125K.

### Rebond (SCF #44 target, $132K)

- **Category**: Green bond tokenization on Soroban.
- **Founders**: Manuel Vigier (CEO, ex-Credit Agricole + Amarenco 1+ GW solar deployment), Bertrand Lagarde (CTO, prior multi-chain tokenization platform).
- **Build**: GreenBondToken.rs, KYCWhitelist.rs, CouponDistributor.rs. Art L.411-2 CMF framework (French placement privé), MiFID II.
- **Traction**: 4 signed LOIs (LANGA International, Enervivo, Next Solar, Valorem) representing roughly €30M pipeline. Distribution partners Black Manta (BaFin licensed) and Brickken (DORA compliant).
- **Use as anchor for**: RWA bond tokenization, dossiers at $125K-$135K with named LOIs.

### For Yield (SCF #44 target, $144K)

- **Category**: Regulated DeFi yield vault.
- **Founders**: 11-person team. Quentin Hopp (CEO, ex-AXA Wealth Services), Julien Daubert (HEC, 10H11), Saturnin Paulet (Crypto and Macro media, 35K subscribers).
- **Build**: YieldVault.rs, PerfFeeModule.rs, EURC SAC wrapper. Wraps DeFindex, Blend v2, Aquarius, Soroswap, Allbridge, DFNS, Stellar Wallets Kit (7 Integration List items).
- **Traction**: PSCA AMF dossier filed April 2026, EP simplifie filed parallel, ACCEIS audit passed, 50 HNW clients onboarded with €7-8M AUM.
- **Use as anchor for**: regulated DeFi yield with regulatory filing, dossiers at $135K-$145K.

### Antevorta Gold (SCF #44 target, $100K-$115K)

- **Category**: French gold coin NFT tokenization on Soroban with Swiss-grade vault custody.
- **Founders**: Vincent (CEO, SKEMA Track Finance and Quants, Nordea Asset Management institutional clients Europe/Singapore/Latam, BNP Paribas Client Advisor, Bitget COO Apprentice), Jules (COO, SKEMA Master Finance Strategy Entrepreneurship, Toronto Metropolitan exchange International Finance, Banque Populaire Corporate Account Manager intern), William Muller (CTO, KU Leuven Master Financial Economics, Top 0.1 percent IMC Worldwide Quant Trading Competition, Bitget Builder 1+ year, certifications DeFi/PE-VC/Bloomberg Market Concepts).
- **Build**: GoldCoin.rs (Soroban). Bankruptcy-proof gold ownership with LBMA-certified Swiss vault partners (Loomis, Brinks, MKS PAMP, Malca-Amit Geneva). French placement privé framework Art L.411-2 CMF + MiFID II.
- **Status (as of last review)**: Abstract reviewed v2. Estimated 35-45 percent acceptance probability, lifting to 65-75 percent after seven priority fixes.
- **Use as anchor for**: gold or commodity-RWA tokenization dossiers at $100K-$115K.

### Solar Braves (SCF #44 target, $121K-$132K)

- **Studio**: AveForge.
- **Category**: Stellar-native risk-progression dungeon RPG.
- **Prior traction**: live game RPS (Rock Paper Scissors) on MegaETH, 1100+ paying users, $25K revenue.
- **Team**: Gabriel Pires (CEO), Simone Mancini (COO), Tudor Stomff (Tech Lead, Bountyhive 100k + HYVE 80M USD peak + Codemelt 30+ projects), Alexandru (Frontend / Blockchain, 5+ years EVM/Solana/MultiversX, Bucharest Hackathon winner), Vitalii Molokanov (Art Director, Bloomtown shipped credit).
- **Use as anchor for**: Stellar-native consumer games at $121K-$132K. The Solar Braves dossier itself is a pivot from MegaETH to Stellar-native; cite when advising other gaming dossiers.

### Tickie (SCF #44 target, $130K-$145K)

- **Category**: B2B event ticketing with Soroban secondary market and Atomic Splits royalties.
- **Founders**: Alexandre Maiolini (CEO), Sofiane-Henri Henocq (CMO), Nidhal Sabbah (CTO).
- **Traction**: 70+ B2B clients (sports clubs, festivals, etc.), 814K EUR GMV 2025, 30K EUR MRR, 1M EUR+ secured revenue, profitable since 2024, French Tech Tremplin laureate, ControlTick certified, Future of Sport laureate Viva Technology.
- **Advisors**: Eddie Aubin (30 years ticketing, Forum Billetterie founder), Duong Phan (Music Tech PIMS Ticketr).
- **Use as anchor for**: B2B platforms with deep commercial traction extending to Stellar.

### Grindy (SCF #44 in flight)

- **Category**: Creator economy campaign rails on Stellar.
- **Status**: targeting SCF #44 with positioning around DeFindex as campaign routing.

(Add new clients to this section as we engage them. Keep one-line profile + budget anchor + role for clarity.)

---

## 10. Frequently-asked client questions with model answers

These are the questions clients ask most. Have these answers ready.

### "What is Stellar and why am I building on it?"

Stellar is a public blockchain optimized for payments and asset issuance. Compared to Ethereum and Solana, Stellar has sub-cent transaction fees, five-second finality, and stablecoins (USDC, EURC) issued natively rather than wrapped. You build on Stellar because:
- Your unit economics break on EVM gas costs (multi-dollar fees for actions you do thousands of times).
- You issue or settle stablecoins (USDC, EURC) at scale.
- You target use cases where finality matters (payments, marketplaces, atomic settlements).
- You want institutional-grade reliability (Stellar has not had network outages comparable to Solana's).

### "What is SCF and what does it actually give us?"

The Stellar Community Fund is SDF's grants program. The Build Award pays up to $150,000 in USDC on Stellar across three roughly-equal tranches. The grant funds product development. Marketing and user acquisition are explicitly NOT funded.

In exchange for the grant, you commit to delivering specific Soroban primitives, ideally open-sourced under MIT or Apache 2.0, plus a phased timeline (testnet by Tranche 2, mainnet by Tranche 3).

### "Why are you recommending $121K and not $150K?"

The maximum $150K ask triggers heightened scrutiny by design. Reviewers expect the strongest possible justification at the max. When the scope or team does not back the ask, the dossier gets cut or rejected entirely. In our database of past rejected dossiers, five maximum-ask dossiers were rejected specifically because they could not justify the maximum: StellarRead $150K, Easner $150K, Tessera Labs $150K, AION_FI $146.5K, $NRG Token $150K.

We anchor your budget on a specific past winner with a comparable profile. The Signal won $121K in SCF #42 as a B2B marketplace with two doxxed cofounders and one Soroban contract. Bando won $75K as a Mexican real estate pilot. Sizing your ask between these anchors (or above For Yield's $144K target if regulated) signals to reviewers that you have done the calibration work.

### "Why does my team's anonymity worry you so much?"

The grant is public money paid in USDC. SCF panels need to know who they would follow up with if the project goes off the rails. Onchain contracts cannot answer that question; only a verifiable real identity can.

In our database, the most reliable predictor of rejection is unidentifiable founders at a high ask. Sorotrack was rejected three times across SCF #40, #41, and #42 because the only founder was a handle ("Gemy"). AION_FI Protocol was Panel Review Failed at $146.5K for the same reason. Tessera Labs was rejected at $150K for the same reason in a regulated category.

Even one verifiable LinkedIn URL per named co-founder, with the CTO additionally on GitHub, is enough to remove this red flag.

### "What is the Integration List and why do you keep mentioning it?"

The Integration List is SDF's official catalog of building blocks: wallets (Stellar Wallets Kit, Privy, DFNS), DeFi primitives (DeFindex, Blend, Aquarius, Soroswap), cross-chain bridges (Allbridge, Near Intents), on-ramps (Anchor Platform, Bridge, MoneyGram), and payment rails (Stellar Disbursement Platform).

For Integration Track submissions, SCF reviewers expect dossiers to leverage at least one item from this list. The strongest dossiers leverage three to seven. The list is at https://stellar.gitbook.io/scf-handbook/scf-awards/build-award/integration-track/integration-list.

We audit your dossier against this list in Sheet 4 of every review.

### "Why is the video so important?"

Q6 Video URL is a mandatory field in the Build phase. An empty Q6 triggers pre-screen rejection: the SCF team will not forward an incomplete dossier to the panel. We have catalogued five past dossiers that died in "Information Collection" status before panel review for this reason.

A good video also moves the dossier from "this might be vaporware" to "this is real". When the CTO shows the testnet contract live on Stellar Expert with a real transaction hash in the demo, the dossier becomes credible in 90 seconds. Production time after the testnet contract is shipped is six to eight hours.

### "Will SCF make me pay back the grant if we fail?"

No. SCF Build Awards are grants, not loans. There is no clawback for missed milestones. However, missing milestones at tranche reviews delays the next tranche. If you miss substantially, the panel can pause the grant and reallocate remaining funds.

What matters most: your reputation with SDF. Future grants (if you reapply) depend on having delivered on prior grants.

### "What happens after Tranche 3?"

After Tranche 3 the grant is complete. You retain ownership of the open-source contracts you shipped. SDF tracks ecosystem outcomes (transaction volume, users, ecosystem fork usage). You can reapply for a future grant if you propose net-new scope.

### "How long does the full grant lifecycle take?"

From initial Abstract submission to Tranche 3 mainnet delivery is roughly six to nine months for a healthy project. The Abstract phase alone is usually four to eight weeks (submission, panel review, decision). Each Tranche cycle is six to twelve weeks (deliver, submit for review, get approval, receive funds, start next tranche).

### "Can I submit to other grant programs while also pursuing SCF?"

Yes. SCF does not prohibit parallel applications. Many of our clients pursue SCF alongside other grants (Optimism, Arbitrum, etc.). The Web3 grants market is non-exclusive.

However, when you have a deliverable funded by SCF, do not double-fund the same deliverable from another program. Reviewers cross-check.

### "What if I get rejected? Can I reapply?"

Yes. Many teams in our database went from rejected to awarded in a later round. The pattern of changes is consistent (see `reference/05-comeback-patterns.md`).

The single highest-impact comeback move is replacing anonymous handles with verifiable LinkedIn URLs. The second is reducing the budget ask and tightening the deliverable. The third is adding a named pilot customer with a signed LOI before resubmitting.

A reapplying dossier should explicitly acknowledge the prior gap in one sentence: "We addressed the prior panel feedback by [specific change]." Panels respect teams that learn.

### "Why no em-dashes in our deliverable?"

Em-dashes (the long dash) read as machine-generated to many readers and dilute the perceived craft of the deliverable. We use commas, colons, parentheses, periods, or single hyphens instead. This rule does not change based on content type or audience.

### "Why are you not recommending Fireblocks / Elliptic / Certora as Integration items?"

Those are not on the official Stellar Integration List. They are supporting infrastructure: institutional custody (Fireblocks), wallet screening (Elliptic), formal verification (Certora). They can be mentioned in your dossier as supporting infrastructure (typically funded by your own resources or by the Stellar LaunchKit credit at Tranche 2), but they should not be presented as Integration Track items.

Common reviewer flag: "this dossier names Fireblocks and Certora as Stellar integrations". Reviewers know they are not.

### "How do you know all of this?"

We have catalogued every visible SCF Build Award submission since SCF #40, including the winner amounts, the rejection reasons (when public), and the team profiles. We have analyzed the patterns that correlate with awards versus rejections across 79+ winners and 130+ rejects. The patterns are stable across rounds because the SCF panel is broadly stable across rounds (rotating committee with consistent evaluation criteria).

We do not have inside information. We have pattern recognition built from a large public dataset.

---

## 11. How to use the AI skill in Claude

We built a Claude skill called `stellar-scf-grants-advisor` that encodes the methodology and corpus knowledge. Any associate using Claude (Cowork mode or the API) can install this skill and immediately produce work at our standard.

### Installing

The skill ships as a single file: `stellar-scf-grants-advisor-v2.skill`.

In Cowork mode:
1. Click the skill file.
2. Click "Save skill" in the file card.
3. The skill installs into your Cowork skills directory.

For other environments, drop the unzipped folder into your Claude Skills directory (or your equivalent context-injection workflow). The `SKILL.md` file at the root is the entry point.

### Verifying it works

After installation, ask Claude:

> "Can you review my client's SCF Abstract? Here's the link to the Google Sheet: [URL]"

Claude should:
1. Recognize the SCF context and invoke the skill.
2. Read the relevant reference docs (`01-methodology.md`, `02-scoring-framework.md`, `03-rejection-patterns.md`, etc.).
3. Web-fetch the URL.
4. Score the dossier.
5. Generate the four-sheet Excel deliverable.
6. Reply with a chat summary including probability range, top fixes, and the file link.

### Best prompts to get started

For a review:
> "Review this SCF Abstract: [paste content or URL]. Client is [name]. Round is SCF #[number]. Give me a four-sheet Excel review with field-by-field analysis, pre-submit checklist, corpus comparables, and Integration List audit. Estimated probability before and after fixes."

For a budget recommendation only:
> "We have a client building [category] with [team size] founders. Traction: [details]. What budget should we recommend? Anchor on a named past winner with comparable profile."

For a quick triage:
> "Look at this dossier and tell me the top three recurring rejection patterns it triggers. Cite specific past dossiers."

For a comeback strategy:
> "Client lost SCF #[N] with [budget] ask. Profile: [team + scope]. What did the prior panel likely flag, and what changes should we make for re-submission?"

For drafting from scratch:
> "Client wants to submit to SCF #[N]. They build [project] in [category]. Team is [names + LinkedIn URLs]. Traction is [metrics]. Draft the Abstract field-by-field (Q1 through Q12)."

### How to read the skill's outputs

Claude will produce a chat summary plus an Excel file link. Open the Excel file (Sheet 1, "Field-by-field review") first. The banner row at the top gives the headline verdict: probability before fixes, probability after, recommended budget anchor.

Each field row has: the field name (Q-number), a status (STRONG/SOLID/UNDERSELLING/WEAK/BLOCKER), a commentary column (French or English), and a paste-ready English rewrite column. Send the client the file.

Sheet 2 is the prioritized checklist. The client uses this as their pre-submit work plan.

Sheet 3 shows them where they sit in the corpus. Sheet 4 audits Integration List usage.

### When the skill output needs review

The AI is excellent at applying the methodology but is fallible at:
- Specific project-fact verification (does the team really have IMC Top 0.1 percent? Verify on the LinkedIn URL before delivering).
- Current Integration List changes (the list updates quarterly; check the live URL).
- Round-specific deadlines (always confirm with the client).
- Regulatory framework details (when in doubt, recommend the client consults counsel).

Always review the AI's output before sending to the client. Spot-check three things: (1) the budget anchor is a real past winner with the cited amount, (2) the named past rejects in the review actually had the cited rejection reason (consult `reference/11-corpus-rejects.md`), (3) the chat summary has the probability range and top fixes.

### Debugging the AI's output

If the AI produces a review that misses something (forgot to flag a rejection pattern, anchored on the wrong budget, missed a corpus comparable), tell it specifically:

> "You missed [pattern]. This dossier triggers it because [specific evidence]. Three past rejects had the same: [names]. Add to Sheet 1 row Q[N] and Sheet 2 priority CRITICAL."

The AI iterates quickly. The skill is built for iteration.

### When NOT to use the skill

- Pure conversational questions ("explain Stellar to me"). The skill won't trigger; that's fine, use normal Claude.
- Drafting outreach messages to prospects. The skill is for review work, not for sales prospecting.
- Internal team strategy discussions. The skill assumes client-facing output.

---

## 12. The associate's first thirty days

A suggested ramp-up.

### Days 1 to 3: Reading

Read this guide end to end. Then read the skill reference docs in order:
1. `SKILL.md`
2. `reference/01-methodology.md`
3. `reference/02-scoring-framework.md`
4. `reference/03-rejection-patterns.md`
5. `reference/12-client-communication.md`

This is roughly six to eight hours of reading. Take notes.

### Days 4 to 7: Shadow a review

Pick an active client engagement. Read the client's submitted Abstract or Build. Read our most recent Excel review. See how the score/pattern/comparable/budget translates to the deliverable. Read `reference/14-worked-examples.md` alongside.

### Week 2: Your first review

Take a client dossier (real or training). Run the seven-step methodology yourself before consulting Claude or the skill. Write your own scores and identify the patterns you see. Then use the AI skill. Compare your output to the AI's. Identify what you saw and what the AI saw that you missed.

### Week 3: Your first client deliverable

Produce a real client review using the skill plus your judgment. A senior reviews before delivery.

### Week 4: Independent

You are reviewing dossiers solo with quality checks at delivery. You can answer client FAQ from memory or reference quickly. You can run a client kickoff call.

### Beyond the first month

- Maintain the corpus database (add new submissions as they come into rounds).
- Develop a specialization (regulated finance, gaming, infrastructure, RWA).
- Improve the skill (write new patterns discovered, add new corpus entries, propose new templates).

---

## Closing note

The grants market is a pattern recognition game. The corpus is what we sell. Treat it like the asset it is.

When you find a new pattern (a new rejection cause, a new winning structure, a new regulatory development that affects dossiers in a category), document it in the skill and update the corpus. The next associate (and the next AI session) will be sharper because of you.

When you have a question this guide does not answer, write the answer down after you find it and add it to the FAQ.

The goal is for every associate to operate at a level indistinguishable from the founder. That requires you, this guide, the skill, and the corpus to compound.

Welcome.
