# Common winning patterns in past SCF rounds

Mirror image of `03-rejection-patterns.md`. These are the attributes that show up in the 79+ awarded SCF dossiers we have catalogued across rounds #40, #41, #42 and prior.

A dossier that hits all eight patterns has a near-deterministic shot at being funded. Most winners hit five or six.

## Pattern A: a fully doxxed founding team with verifiable past shipping

**What it looks like:** each named founder has a LinkedIn URL, the CTO has a GitHub URL with public code, and at least one founder has shipped a prior product (Web2 or Web3) that the panel can verify.

**Why this wins:** answers the "can you ship?" question definitively.

**Past winners with this pattern:**
- The Signal ($121K in SCF #42), Samir Touinssi (Arch Consulting, content creator 10+ years) + Leo Leung (Imperial Physics, Orichal Partners quant researcher) both fully doxxed.
- Bando ($75K in SCF #42), Mexican team fully doxxed with named pilot customer.
- TheXBank ($89.5K in SCF #40), Africa banking team doxxed with country pilot.
- DeFindex (prior), Palta Labs team verifiable, public Discord.

## Pattern B: a Soroban contract that is the project's net-new primitive

**What it looks like:** the dossier names a specific Soroban contract (DealEscrow.rs, YieldVault.rs, GreenBondToken.rs) that the team will develop and open-source under MIT. The contract is the core innovation; everything else (wallets, anchors, indexers) is integration.

**Why this wins:** anchors the dossier as an Integration Track or Open Track that builds reusable ecosystem infrastructure rather than a closed product.

**Past winners with this pattern:**
- The Signal, DealEscrow.rs with Atomic Splits payout logic.
- DeFindex, yield allocator routing contract.
- Bando, RWA tokenization contract.

## Pattern C: clear use of multiple SCF Integration List items

**What it looks like:** the Q6 Integration Description names at least 3 components from the official Stellar Integration List (Stellar Wallets Kit, Passkey Kit, Anchor Platform, Privy, DeFindex, Blend v2, Aquarius, Soroswap, Allbridge, Near Intents, etc.) with a clear role for each.

**Why this wins:** demonstrates the dossier understands the ecosystem and is wiring into existing primitives rather than building from scratch. This is exactly what Integration Track was designed to fund.

**Past winners with this pattern:**
- The Signal, used wallet connectors and routing primitives.
- Bando, Anchor Platform plus wallet stack.
- Future winners following For Yield (target $144K), 7 Integration List items named.

## Pattern D: a B2B distribution story with named customers or partners

**What it looks like:** the Q4 Traction or Q9 Traction Evidence names specific brands, pilot customers, signed Letters of Intent, or regulated partners. Not "in discussions with several X", but "signed LOI with [Named Entity]".

**Why this wins:** removes the "who will use this?" question from the panel's worry list.

**Past winners with this pattern:**
- The Signal, pre-launch but named the Web3 service provider categories and the bridge value proposition.
- Bando, named brokerage partner in Mexico.
- TheXBank, country pilot named with specifics.

## Pattern E: budget sub-max and anchored on a precedent

**What it looks like:** the requested budget is between $75K and $135K (sub-max), structured as 3 equivalent tranches, and the dossier explicitly references a past winner with comparable scope.

**Why this wins:** avoids the heightened scrutiny that applies to $145K-$150K asks, and signals the team has done the work of calibrating their request.

**Past winners with this pattern:**
- Bando ($75K), kept narrow scope.
- TheXBank ($89.5K), kept narrow scope.
- The Signal ($121K), sub-max with full scope.

## Pattern F: explicit alignment with SDF roadmap priorities

**What it looks like:** the dossier mentions one or more current SDF strategic priorities (x402 micropayments, Protocol 25 X-Ray ZK primitives, EURC adoption, MiCA EU institutional access, agentic payments) and explains how the project leverages or extends them.

**Why this wins:** signals the team is paying attention to where the foundation wants ecosystem growth.

**Past winners with this pattern:**
- DeFindex aligns with DeFi infrastructure growth.
- Bando aligns with RWA growth.

## Pattern G: open-source commitment on all Soroban contracts

**What it looks like:** Q6 Integration explicitly commits to publishing the Soroban contracts under MIT (or Apache 2.0) on a public GitHub repository.

**Why this wins:** SCF is a public-good fund. Open-source primitives multiply the grant's impact across the ecosystem.

**Past winners with this pattern:**
- DeFindex, open-source.
- Aquarius, open-source.
- Blend, open-source.

## Pattern H: a regulated category with a fully-named regulatory plan

**What it looks like:** for regulated categories (payments, lending, securities, RWA), the dossier names the specific framework (Art L.411-2 CMF, MiFID II, MiCA, PSCA AMF, BIN sponsor), the named licensing partner, and the KYC vendor.

**Why this wins:** turns a high-risk category into a credible execution plan.

**Past winners with this pattern:**
- The Signal, clear positioning as Integration Track wrapping existing primitives, no regulatory blocker.
- Bando, RWA real estate Mexico with brokerage partner named.
- Future winners following For Yield and Rebond, full regulatory framework cited.

## Combination winning profile

The dossiers that win most often combine patterns A + B + C + D + E. Adding F, G, H raises the probability further. Missing any of A, D, or H (when in a regulated category) is usually fatal regardless of other strengths.

## A specific reference case: The Signal ($121K SCF #42 winner)

Samir Touinssi and Leo Leung submitted The Signal as a Soroban-based escrow for Web3 service providers. The dossier hit:

- Pattern A: both founders fully doxxed with LinkedIn.
- Pattern B: DealEscrow.rs as the net-new Soroban primitive.
- Pattern C: named Stellar SDK, Freighter, Albedo wallets.
- Pattern D: named Web3 service provider categories with specific commission bounty mechanics.
- Pattern E: $121K (sub-max), three equivalent tranches.
- Pattern G: open-source commitment on the escrow contract.

It missed patterns F (no explicit x402 or Protocol 25 alignment) and H (no regulatory framework needed for B2B escrow). Five-of-eight pattern coverage was enough to win.

Use this as the working template for budget anchoring on the $100K-$130K range.

## How to surface these patterns in a client review

When you review a dossier, identify the winning patterns it already has. Tell the client. This is part of the value: clients often do not know their own strengths. Examples of plain-English framing for the client:

- *"Your team section already hits one of the patterns we see most often in past SCF winners: every co-founder has a verifiable LinkedIn URL and the CTO has a public GitHub. This is the single most reliable predictor of acceptance in our database."*

- *"Your traction section is in the top 10 percent of dossiers we have reviewed: signed LOIs with four named clients and two regulated distribution partners. This profile won The Signal $121K in SCF #42 and is what we're anchoring your budget recommendation on."*
