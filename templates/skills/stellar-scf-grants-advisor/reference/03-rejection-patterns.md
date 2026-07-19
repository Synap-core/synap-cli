# Common rejection patterns in past SCF rounds

This document catalogs the twelve recurring patterns that have caused most rejections in SCF rounds #40, #41, #42 and #44. For each pattern, you get:

- The plain-English description.
- Why SCF panels treat it as a red flag (the mechanism).
- Specific past rejected dossiers, named, with budget and round.
- The proven fix.

**Use this document with client-friendly vocabulary.** In your output to clients, never use the term "kill signature". Use phrases like:

- *"This is a recurring rejection pattern we've observed in past SCF rounds."*
- *"In our database of 130+ rejected dossiers, this is the single most reliable predictor of panel rejection."*
- *"Three past dossiers were rejected for this exact reason: [names]."*

## Pattern 1: founders not publicly identifiable for a high-ask request

**What it looks like:** the dossier asks $100K or more, but at least one named team member is only identified by a handle (e.g., "DX", "Skyfox"), has no LinkedIn URL, or has no GitHub URL despite being labelled CTO.

**Why panels treat it as a red flag:** the grant is public money. SCF needs to know who to follow up with if the project goes off the rails. Onchain contracts cannot answer that question; only a verifiable real identity can. The panel's mental model is "if something goes wrong, who picks up the phone".

**Past rejected dossiers with this exact pattern:**
- Sorotrack ($150K in SCF #40, $50K in #41, $50K in #42, rejected all three times), solo dev, only known by handle "Gemy".
- AION_FI Protocol ($146.5K in SCF #40 PRF), no team disclosed beyond a generic .xyz domain.
- Tessera Labs ($150K in SCF #42), anonymous team for a regulated category.
- REAPP ($115K in SCF #42), anonymous x402 implementation.
- Cicero ($150K in SCF #40 PRF), no team for C++ Soroban project.

**The proven fix:** every named founder gets a verifiable LinkedIn URL added to Q10 before submission. If someone refuses to be publicly identified, reposition them as "core contributor" or "advisor" rather than co-founder. The CTO must have a verifiable GitHub URL.

## Pattern 2: maximum budget ask ($150K) without proportionate scope

**What it looks like:** the dossier requests $145K to $150K but the team is small (1 to 2 people), the deliverable is feature-level rather than primitive-level, and there is no named pilot customer.

**Why panels treat it as a red flag:** the maximum budget triggers heightened scrutiny by design. Reviewers expect the strongest possible justification at the max. When the scope or team does not back the ask, the budget gets cut or the dossier gets rejected entirely.

**Past rejected dossiers with this exact pattern:**
- reb.cash ($150K in SCF #42), anonymous, no website.
- Stellar Fintech OS ($140K in SCF #41), generic naming, no team.
- StellarRead ($150K in SCF #40 PRF), read-to-earn at max budget.
- Cicero ($150K in SCF #40 PRF), C++ Soroban with no team.
- Payala ($150K in SCF #40 PRF), 14-year-old unfunded company at max.
- Paenote ($150K in SCF #40 PRF), Africa B2B at max with only $100K processed.
- ViFi Labs ($150K in SCF #41), already-funded multi-chain team at max.

**The proven fix:** anchor the budget on a named past winner with comparable profile, then stay 5 to 15 percent below that anchor. The Signal won $121K with 2 co-founders and one escrow contract; Rebond targets $132K with 3 contracts; For Yield targets $144K with an 11-person team and PSCA AMF filing. Place your dossier accordingly.

## Pattern 3: generic project name (category as name)

**What it looks like:** the project name is the literal category ("Stellar Fintech OS", "Soroban Block Explorer"), or contains words like "OS / Platform / Framework / Engine / Hub" with no specific deliverable.

**Why panels treat it as a red flag:** a generic name reads as a generic vision, which reads as a generic execution plan. Specific names communicate specific deliverables.

**Past rejected dossiers with this exact pattern:**
- Stellar Fintech OS ($140K in SCF #41), collision with Romanian core-banking FintechOS.
- Stellar Playground v2 ($90K in SCF #40), overlaps with SDF's scaffold-soroban + Stellar Lab + Okashi.
- Soroban-first Block Explorer ($75K in SCF #41), direct competitor of Rumble Fish ($131K winner).
- Galactic Playground ($150K in SCF #40), generic name for an established forum.
- Traction3 / Straction ($55K in SCF #40), "Stellar Growth Engine Infra" with no product.
- Alzent Digital ($145K in SCF #42), "Wealth Tech Command Center" too abstract.

**The proven fix:** name the specific deliverable and the specific user segment in the project title. "AntevortaCoin: Non-Fungible Gold Certificates on Soroban" beats "Antevorta Gold Platform".

## Pattern 4: brand collision with a well-known unrelated company

**What it looks like:** the project name overlaps with a major brand in a related sector, creating SEO confusion and panel mistrust during their own Google search.

**Why panels treat it as a red flag:** panel members search the project name. If the top results are unrelated companies (a16z's Tessera, Neo blockchain's Neon, US AutoFi Inc.), the panel either gets confused or assumes the project is trying to ride on someone else's brand.

**Past rejected dossiers with this exact pattern:**
- Tessera Labs (SCF #42) vs Tessera Labs AI (a16z $60M ERP company).
- Theo: USDC for Haitian Businesses (SCF #44 live) vs theo.xyz Hack VC $20M trading firm.
- Neon Wallet (SCF #40) vs COZ Neon Wallet (Neo blockchain) AND Neon EVM (Solana).
- AION_FI Protocol (SCF #40) vs multiple unrelated "Aion" fintechs.
- Solo (SCF #40 and #44) vs SatoshiPay Solar Wallet (Stellar ecosystem).
- Stableyard (SCF #40) vs Stables/Stable token.
- BelugaSwap (SCF #41) vs BSC BelugaSwap (pre-existing).
- AutoFi (SCF #40, eventually won SCF #41) vs US AutoFi Inc (Kevin Singerman).

**The proven fix:** Google the project name plus "crypto" plus "fintech" before submitting. If the top results are unrelated companies, rebrand or qualify the title (e.g., "Tessera Soroban Labs" instead of "Tessera Labs").

## Pattern 5: existing project on another chain proposes a "Stellar integration" with no Stellar-native engineering history

**What it looks like:** the team is well-established on Solana, EVM or another chain and proposes a port or integration to Stellar without showing any Stellar-specific commitment (no Soroban contract deployed, no Stellar ecosystem partner discussions named, no specific Stellar-only reason).

**Why panels treat it as a red flag:** SCF funds Stellar-native growth, not Stellar bolt-ons that exist to access a grant. The panel wants to fund teams that will stay on Stellar, not teams that are shopping for funding.

**Past rejected dossiers with this exact pattern:**
- Nuvolari.ai ($84K in SCF #42), Sonic-native AI yield, port to Stellar.
- $NRG Token by BLOND:ISH ($150K in SCF #41), Solana fan token porting.
- Nomadz ($150K in SCF #42), Solana travel app.
- Astrix ($95K in SCF #41), Algorand fan platform porting.
- WOWMAX ($109K in SCF #41), EVM DEX aggregator.
- Kima ($133K in SCF #40), multi-chain interop adding Stellar as one of N chains.
- All Access Fans ($150K in SCF #42), Nigerian Web2 OnlyFans-alt bolt-on.
- PathPulse AI ($137K in SCF #41 and $128K in SCF #42), computer-vision data network bolt-on.

**The proven fix:** the Q2 Description and Q6 Integration must lead with WHY Stellar specifically (not just "we're multi-chain"). Show a Stellar-native commitment: a Soroban deployed contract address, a named Stellar ecosystem partner discussion, a Stellar-only economic argument that EVM gas would break.

## Pattern 6: duplicates SDF roadmap work

**What it looks like:** the project proposes work that the Stellar Development Foundation is shipping at the protocol level (post-quantum cryptography, ZK primitives, Protocol 25 X-Ray features).

**Why panels treat it as a red flag:** funding redundant work wastes ecosystem resources.

**Past rejected dossiers with this exact pattern:**
- Nebula Wallet (SCF #41 and #42), wallet-level post-quantum cryptography while SDF explores PQC at protocol layer.
- zkVault ZK MFA ($130K in SCF #42), wallet-level ZK MFA while Protocol 25 X-Ray ships native ZK primitives.
- StellaRay ZK Wallets ($80K in SCF #42), same X-Ray duplication.
- Galeon ($88K in SCF #42 PRF), privacy/compliance tooling overlapping X-Ray.
- Tessera Labs ($150K in SCF #42), confidential payments duplicating X-Ray rollout.
- Move-to-Stellar ($115K in SCF #42), alternate VM contradicting SDF's deliberate Rust+WASM choice.
- Stellar Playground v2 ($90K in SCF #40), duplicates scaffold-soroban + Stellar Lab + Okashi.

**The proven fix:** check SDF's recent roadmap announcements. If your work overlaps, position as a complement (e.g., "leverages Protocol 25 X-Ray primitives to add X") instead of a replacement.

## Pattern 7: overlap with already-funded SCF projects in same or prior round

**What it looks like:** the dossier asks for funding to build what another team already won funding to build.

**Why panels treat it as a red flag:** the same as Pattern 6 but for projects rather than SDF features. The panel curates the ecosystem for coverage, not redundancy.

**Past rejected dossiers with this exact pattern:**
- Lend.xyz ($120K in SCF #42), RWA real estate while Bando ($75K) won the same round for Mexican RWA.
- All competing Hummingbot bidders (SCF #41 + #42), three teams bid per round, none won either round.
- C-Address Toolkit ($120K in SCF #41), lost to Latch + KMP same RFP.
- StellarScope ($90K in SCF #41), DeFi Positions API RFP, lost to Orion + OctoPos.
- Soroban-first Block Explorer ($75K in SCF #41), lost to Rumble Fish and OBSRVR Prism.
- Reactor Trade ($115K in SCF #41), same co-founder as winner Helix Labs same round.
- Solar ($60K in SCF #40 PRF), Africa unbanked banking, vs TheXBank ($89.5K awarded same round).

**The proven fix:** audit awarded teams in the prior two rounds. If your category is covered, find a sharper sub-niche or pivot.

## Pattern 8: regulated product without a regulatory plan

**What it looks like:** payments, lending, identity, RWA, securities-adjacent product with no jurisdiction-specific compliance plan, no named license partner, and no KYC/AML vendor mentioned.

**Why panels treat it as a red flag:** the panel knows regulated products without regulatory plans almost never ship. They have seen this fail too many times.

**Past rejected dossiers with this exact pattern:**
- StellarCredit ($55K in SCF #42 PRF), invoice factoring is regulated lending, no plan.
- AION_FI Protocol ($146.5K in SCF #40), credit cards require BIN sponsors not disclosed.
- ASGCard ($120K in SCF #42), virtual card issuance for AI agents, no BIN sponsor named.
- Resolva ($120K in SCF #42), Africa crypto-to-fiat with no license disclosed.
- Stablpay ($129.1K in SCF #40), regulated stablecoin rail for India, no FIU details.
- Kyros OS ($135K in SCF #41), Spanish tax compliance, no AEAT/Hacienda partnership.
- Easner ($150K in SCF #40 PRF), "Stripe for Stablecoins", no banking partner.
- Goated App ($120K in SCF #41), predictions/gambling, no licensing plan.

**The proven fix:** for any regulated category, the dossier must include jurisdiction, named license partner (or specific license held), KYC/AML vendor, and a "go-to-market without breaking the law" paragraph.

## Pattern 9: vague TAM ("Pan-Africa", "Global", "2 Billion Users")

**What it looks like:** the GTM section flexes a hand-wavy total addressable market with no country sequencing, no first-100-users plan, and no named distribution partner.

**Why panels treat it as a red flag:** vague TAM communicates vague go-to-market execution. The panel has seen many "Pan-Africa" dossiers fail to ship anywhere.

**Past rejected dossiers with this exact pattern:**
- StellaRay "ZK Wallets for 2 Billion Google Users" ($80K in SCF #42).
- Joblad "Africa's informal skilled workforce" (SCF #44 live).
- Azawire "Web3 Banking for Africa" ($80K in SCF #40).
- Paenote "Africa B2B" ($150K in SCF #40 PRF).
- MOJA "Group savings for refugees" ($110K in SCF #40 PRF).
- Resolva "Africa remittance corridors" ($120K in SCF #42).
- Stableyard "Asia's QR networks" ($119.5K in SCF #40).

**The proven fix:** replace "Africa / Global / Pan-X / N billion users" phrasing with country one, city/segment, specific user persona, and a named partner that gives you that distribution.

## Pattern 10: read-to-earn, learn-to-earn, play-to-earn, fan-token-rewards category

**What it looks like:** the product economic model has consumers earning tokens or rewards for low-effort activities (reading, watching, playing).

**Why panels treat it as a red flag:** post-STEPN and post-Helium panel skepticism. Token-incentive consumer apps have a 100 percent rejection rate in our corpus.

**Past rejected dossiers with this exact pattern:**
- StellarRead ($150K in SCF #40 PRF), read-to-earn.
- Gameduk ($60K in SCF #40), gamified EdTech.
- Stellar Nexus Experience ($60K in SCF #40), XP/badges learn-to-earn.
- EduAfrica Learning App ($89K in SCF #40), emotional title, learn-to-earn.
- $NRG Token by BLOND:ISH ($150K in SCF #41), fan token rewards.

**The proven fix:** reframe as "creator royalties" (utility, not speculation) or "verifiable credentials" (provable outcomes), and pair with a non-token revenue source. Or reposition the customer as the protocol (B2B) instead of the user (B2C earning).

## Pattern 11: "Information Collection" status (incomplete dossier)

**What it looks like:** the dossier is incomplete to the point that SCF could not even compile it for panel review. Empty fields, broken thumbnails, missing mandatory items.

**Why panels treat it as a red flag:** they don't. They simply leave the dossier in "Information Collection" status until the team responds, and many teams never respond. The dossier dies without ever being reviewed.

**Past rejected dossiers with this exact pattern:**
- The Strategists ($150K in SCF #42), Information Collection status.
- Cushion ($118.4K in SCF #41), Information Collection.
- Payala to Stellar Integration ($150K in SCF #41), Information Collection.
- Neon Wallet ($129K in SCF #41), Information Collection.
- SendbyKatika ($150K in SCF #40), submitted, never passed pre-screen completion.

**The proven fix:** before submitting, walk the entire SCF Build dossier checklist. Verify every mandatory field has content. Pay special attention to thumbnail uploads and URL field formatting.

## Pattern 12: "Panel Review Failed" (explicit panel rejection)

**What it looks like:** the hardest fail. Panel explicitly rejected the dossier (vs falling short on community vote).

**Why panels treat it as a red flag:** they did the rejecting themselves. This is not a pattern you can fix in real time; this is the cluster of all patterns above acting together.

**Cases (high signal):**
- Sorotrack ($150K in SCF #40 plus $50K in #42).
- Payala ($150K in SCF #40).
- StellarRead ($150K in SCF #40).
- Cicero ($150K in SCF #40).
- Solar ($60K in SCF #40).
- MOJA ($110K in SCF #40).
- Easner ($150K in SCF #40).
- Riwe ($115K in SCF #40, $96K in #42 also failed).
- Paenote ($150K in SCF #40).
- OverSync ($100K in SCF #40).
- Galeon ($88K in SCF #42).
- Remitance ($150K in SCF #42).
- StellarCredit ($55K in SCF #42).
- PhishGuard ($65K in SCF #40).
- Offer-Hub ($90K in SCF #40).

**The proven fix:** when a dossier triggered Panel Review Failed, fix the underlying patterns that caused it before reapplying. See `reference/05-comeback-patterns.md` for documented rejected-then-won case studies.

## Quick diagnostic table

Use this when scanning a dossier for the first time:

| Symptom in dossier | Pattern triggered |
|---|---|
| Anonymous handle or first name only in Q10 | Pattern 1 (founders not identifiable) |
| Budget $145K-$150K with small team | Pattern 2 (max ask without scope) |
| Category words in title (OS, framework, engine, hub) | Pattern 3 (generic name) |
| Project name matches major unrelated brand | Pattern 4 (brand collision) |
| "We will deploy on Stellar" with no Soroban testnet | Pattern 5 (bolt-on) |
| Wallet-level PQC or ZK feature | Pattern 6 (duplicates SDF roadmap) |
| Same vertical as a recent winner | Pattern 7 (overlap with funded project) |
| Regulated product, no jurisdiction or license partner | Pattern 8 (no regulatory plan) |
| "Pan-Africa", "Global", "N billion users" | Pattern 9 (vague TAM) |
| "Earn rewards by [low-effort activity]" | Pattern 10 (earn-to-X) |
| Empty mandatory fields | Pattern 11 (Information Collection risk) |
| Re-submitting identical dossier after prior rejection | Pattern 12 (Panel Review Failed cluster) |
