# Client FAQ with model answers

Use this when a client asks a question. Each answer is approximately the length you would speak on a call.

## On Stellar and the protocol

### Q: Why Stellar and not Ethereum or Solana?

Stellar is optimized for payments and asset issuance. Three things matter for your project: sub-cent transaction fees (so use cases that involve many small transactions stay viable), five-second finality (so payments settle predictably), and native stablecoin support (USDC and EURC are first-class assets, not ERC-20 wrappers). Compared to Ethereum, your unit economics survive at scale. Compared to Solana, you get institutional reliability (no major network outages).

### Q: Is Stellar still a serious blockchain in 2026?

Yes. USDC volume on Stellar is in the billions per month. Circle treats Stellar as one of its two strategic chains (Solana for throughput, Stellar for payments). Real-world adoption is concrete: MoneyGram on-ramps, MiCA-aligned EUR stablecoin infrastructure for EU regulated finance, Brazil and LATAM stablecoin volume.

### Q: What is Soroban?

Soroban is Stellar's smart contract platform, launched on mainnet in 2024. Contracts are written in Rust and compiled to WebAssembly. They run on Stellar nodes. You can deploy a contract to testnet today and verify it on Stellar Expert at https://stellar.expert.

### Q: What is the Stellar Asset Contract (SAC)?

The SAC bridges a native Stellar asset (USDC, EURC, XLM, your project's token) into Soroban so smart contracts can manipulate it. When you see "EURC SAC wrapper" in a dossier, this is what is meant.

### Q: What are Atomic Splits?

A Soroban pattern that automatically routes a single incoming payment across multiple recipients in one transaction. The Signal won SCF #42 partially because they introduced this for B2B escrow. Tickie plans the same pattern for ticketing royalties. Useful for any "one payment, multiple beneficiaries" scenario.

## On the SCF program

### Q: What is SCF and what does it give us?

The Stellar Community Fund is the Stellar Foundation's grants program. The Build Award pays up to $150,000 USDC across three roughly-equal tranches over six to nine months. The grant funds product development. Marketing and user acquisition are explicitly NOT funded.

### Q: Why do you keep saying "sub-max" or "$121K instead of $150K"?

In our database of past SCF rounds, maximum-ask submissions get heightened scrutiny by design. Reviewers expect the strongest possible justification at $150K. When the scope or team does not back the ask, the dossier gets cut or rejected entirely. Five recent rejected dossiers all maxed at $145K-$150K specifically because they could not justify the maximum: StellarRead, Easner, Tessera Labs, AION_FI Protocol, $NRG Token.

We anchor your budget on a named past winner with a comparable profile. The Signal won $121K with two cofounders and one Soroban contract. Bando won $75K with a Mexican real estate pilot. Sizing your ask in that anchored range signals that you have done the calibration work.

### Q: When is the next round?

Rounds open every six to ten weeks. The deadline is hard. We track the active round and recommend a submission window. Ask us for the specific current deadline.

### Q: Can we apply to multiple rounds?

You can reapply to a future round if you are rejected. Reapplication is common: thirteen documented cases in our database went from rejected to awarded by addressing the prior gap. You cannot apply to two rounds simultaneously.

### Q: What is the Integration List and why do you mention it?

It is SDF's official catalog of building blocks for Soroban projects: wallets (Stellar Wallets Kit, Privy, DFNS), DeFi primitives (DeFindex, Blend v2, Aquarius, Soroswap), cross-chain (Allbridge, Near Intents), on-ramps (Anchor Platform, Bridge, MoneyGram), payments (SDP). For Integration Track submissions, reviewers expect at least one item from this list. The strongest dossiers leverage three to seven. We audit your dossier against the list in Sheet 4 of every review.

### Q: Can we name Fireblocks, Elliptic, Certora as Integration items?

No. They are not on the official Integration List. They are supporting infrastructure (institutional custody, wallet screening, formal verification). Mention them in your dossier as supporting infrastructure (paid for by your own resources or by the Stellar LaunchKit credit at Tranche 2 review), but do not present them as Integration Track items.

### Q: What is the Stellar LaunchKit?

A credit that SDF provides at Tranche 2 review for a security audit (often Certora). It is separate from the grant budget. You do not pay for the audit out of the grant. You should explicitly mention that the audit will be covered by LaunchKit in your Q11 or Q13 fields.

### Q: What does "Track" mean? Integration vs Open vs RFP?

- **Integration Track**: you extend or wrap existing Stellar primitives. Most of our clients submit here.
- **Open Track**: you develop a net-new primitive not yet in the ecosystem (a new oracle, a new bridge architecture). Panel scrutiny is higher.
- **RFP Track**: SDF publishes specific Requests For Proposal and teams submit specifically for these. Less common.

We recommend Integration Track unless your dossier is truly net-new infrastructure.

## On our methodology

### Q: How did you build your evaluation framework?

We catalogued every visible SCF Build Award submission since SCF round #40 across multiple rounds. We tracked which dossiers won, which lost, the public reasons, the budget, the team profile, the category, the regulatory framing. From 79+ winners and 130+ rejects, fourteen evaluation signals and twelve recurring rejection patterns emerged consistently. We turn this pattern intelligence into the field-by-field review and budget recommendation you receive.

### Q: How accurate is your probability estimate?

It is a range, not a point estimate, anchored on past dossiers with comparable profiles. When we say "estimated 65 to 75 percent probability of acceptance after fixes", we mean that in our database, dossiers with the same revised profile won at roughly that rate in SCF #40 to #42. We do not predict outcomes; we estimate probability based on past evidence.

### Q: Why are you so direct in your reviews?

The grant decision is binary. Soft feedback ("you may want to consider") does not move the needle. Specific, evidence-anchored feedback ("Q10 currently triggers the unidentifiable-founder pattern, three past dossiers were rejected for this exact reason at the same budget tier, and the fix is to add LinkedIn URLs") does.

### Q: What if I disagree with your assessment?

Tell us. Often our pattern recognition surfaces something we wrote in haste, or your context (a partner we did not know about, traction not yet public) changes the assessment. We update the deliverable.

What we will not do: soften a recommendation we believe is correct. Our job is the unvarnished assessment.

## On the deliverable

### Q: What do I get from working with you?

A four-sheet Excel review with a field-by-field analysis (Status, Review, paste-ready English rewrite for each field), a prioritized pre-submission checklist (Blocker / Critical / Important / Strategic), a corpus comparables sheet (10-15 past dossiers with the lesson for yours), and an Integration List audit.

Plus the chat summary: probability range, top three to five fixes, budget recommendation anchored on a named past winner.

We also iterate. After v1, you tell us what you want to refine, and we produce v2.

### Q: How long does a review take?

For a clean Abstract: roughly 4 to 8 hours of senior advisory time. For a complex Build phase with multiple regulatory questions: 1 to 2 days.

You receive the deliverable plus the iteration cycle.

### Q: What if my dossier is excellent and you don't find much to fix?

We tell you. We name the patterns you already nail and explain why preserving them is critical. Strong dossiers still benefit from corpus anchoring on budget and SDF roadmap alignment.

### Q: What if my dossier is weak and you tell me my probability is low?

We name the patterns triggered and the fixes that move the needle. If the fundamental positioning is wrong (you are duplicating a recently-funded project, or your category is in the 100 percent rejection cluster), we tell you and recommend the pivot rather than just polish.

## On reapplying after rejection

### Q: We lost the prior round. Can we win this time?

Many teams have. Thirteen documented cases in our database went from rejected to awarded. The pattern of changes is consistent: replace anonymous handles with verifiable LinkedIn URLs, reduce the budget ask and tighten the deliverable, add a named pilot customer before resubmitting, explicitly acknowledge the prior gap in one sentence ("We addressed the prior panel feedback by [specific change]").

### Q: How do you know what the prior panel flagged?

Sometimes the panel sends explicit feedback. Sometimes the rejection reason is visible in the dossier itself (empty fields, anonymous team, max budget without scope). When the reason is not public, we infer from the pattern: if your dossier had anonymous founders at $150K, the unidentifiable-founder + max-budget pattern combination is the high-probability cause.

### Q: How much work is a comeback dossier?

Typically two to six weeks of focused work. Six weeks if the team needs to ship a testnet contract, secure a pilot customer LOI, or file a regulatory dossier. Two weeks if the fixes are mostly textual (rewrites, budget reduction, LinkedIn URLs).

## On grants logistics

### Q: How does the grant actually get paid?

USDC on Stellar is sent from SDF's address to your verified wallet address. The grant is paid in three tranches, each roughly a third of the total budget. Each tranche is released after the previous tranche's deliverables are reviewed and approved.

### Q: Do we need a legal entity?

You can submit as Entity, Individual, or Team of Individuals. Entity submissions go through KYB (know your business). Individuals go through KYC. We typically recommend Entity for tax efficiency and recipient clarity.

### Q: Do we pay taxes on the grant?

That depends on your jurisdiction. The grant is income in most jurisdictions. Some have specific innovation grant tax treatment. Consult your accountant.

### Q: What if we miss a tranche milestone?

The grant pauses. The panel can extend the timeline if the team explains and proposes a revised plan. Repeated misses can lead to the panel reallocating remaining funds.

### Q: Will SCF make us pay back the grant if the project fails?

No. SCF Build Awards are grants, not loans. There is no clawback for missed milestones. But missing milestones substantially affects your reputation with SDF and your ability to receive future grants.

## On post-grant

### Q: What happens after Tranche 3?

The grant is complete. You retain ownership of the open-source contracts you shipped (typically MIT or Apache 2.0). SDF tracks ecosystem outcomes (transaction volume, users, ecosystem fork usage). You can reapply for a future grant if you propose net-new scope.

### Q: Will my Soroban contract be used by other teams?

If you publish under MIT, yes. Past winners (DeFindex, Aquarius, Blend, Soroswap) have all been forked or extended by subsequent grant recipients. Reusable primitives multiply the grant's impact and increase your standing in the ecosystem.

### Q: Can I commercialize on top of the open-source contract?

Yes. The contract is open-source; your hosted instance, your frontend, your partnerships are yours. Many funded teams run a hosted SaaS on top of their open-source primitive.

## On The Arch Consulting

### Q: What do you charge?

Pricing is per engagement and depends on scope (Abstract phase only, or Abstract plus Build, or full lifecycle including reapplication). Reach out for a quote.

### Q: What is your win rate?

We track every engagement. We share specifics on a per-meeting basis. The headline: we have moved multiple dossiers from initial rejection-prone profiles into awarded outcomes (The Signal $121K SCF #42 with our founder team is the most public).

### Q: Why work with you instead of submitting on our own?

You can submit on your own. Many teams do. Roughly 70 to 75 percent of those submissions are rejected. The pattern intelligence that lifts a dossier from rejected to awarded is built from a large dataset of past rounds, which we have built and maintain. We turn that into specific, anchored rewrites and budget recommendations. You can absorb the methodology yourself (the cheatsheet covers it). What we add is the corpus and the speed.

### Q: Do you have conflicts of interest with other clients in the same round?

We disclose at engagement start. We can advise multiple non-competing dossiers in the same round (e.g., a regulated DeFi yield vault and a B2B ticketing platform). We avoid representing two dossiers in the same RFP track or the same narrow vertical (e.g., two RWA real estate dossiers in the same round).

### Q: How do I get started?

Send us your draft Abstract or Build (Google Sheet link, or PDF, or even the deck if you have not started writing). We respond with a quick triage and propose engagement scope.
