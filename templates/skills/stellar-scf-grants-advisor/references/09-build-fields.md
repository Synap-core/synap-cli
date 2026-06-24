# Field-by-field guide: SCF Build phase

The Application Build sheet has seventeen fields. This document walks each one, with the panel intent, the common mistakes, and the winning structure.

The Build phase is where most of the budget conversation happens. It is more technically rigorous than the Abstract. Empty fields and inconsistencies are punished here.

## Q1 Project Title

Same as Abstract Q1. Keep identical between Abstract and Build (no drift).

## Q2 Submission Title (max 40 chars)

**Panel intent:** a unique handle for this submission, different from the project name, focused on what the funding builds.

**Common mistakes:**
- Same as project title (defeats the purpose).
- Generic ("Stellar Integration").
- Too long, gets truncated.

**Winning examples:**
- "Stellar-Native Yield Vault for EU DeFi" (For Yield)
- "Green Bond Settlement on Soroban" (Rebond)
- "EU MiCA Capital Layer for Soroban DeFi"
- "Stellar-Native Onchain Dungeon RPG" (Solar Braves)
- "Stellar Campaign Rails for Grindy"

## Q3 One Sentence Description (max 130 chars)

**Panel intent:** the elevator pitch in one breath.

**Format SCF recommends:** "Develops/Offers/Gives [defined offering] to help/support [defined audience] [solve problem] with [secret sauce]."

**Common mistakes:**
- Too long (gets truncated).
- Generic verbs ("creates a platform").
- Uses pattern-matching vocabulary (gamified, earn, click-RPG) that triggers rejection patterns.

**Winning examples:**
- "Builds the first French MiCA-regulated DeFi yield vault on Stellar, channelling licensed EU capital into Soroban via DeFindex." (For Yield, 124 chars)
- "Tokenizes EU green bonds on Stellar, settling coupon and redemption flows automatically via Soroban for mid-market issuers." (Rebond, 122 chars)

## Q4 Project URL

Same as Abstract Q5. If the project is live on another chain, this URL points to that live product as proof of execution.

## Q5 Code URL

**Panel intent:** verifiable engineering capability.

**Common mistakes:**
- "TBD" or "will be created by friday", sometimes fatal.
- Private repo URL the panel cannot access.
- Empty field for a CTO-led submission.

**Winning structure:** public GitHub URL with at minimum a README, MIT license, and scaffold of the planned contracts. Shipping a minimal testnet deploy before submission lifts the dossier significantly (we recommend this for every Build submission).

## Q6 Video URL (mandatory)

**Panel intent:** elevator pitch in motion. Under 3 minutes, YouTube or Vimeo, 16:9.

**Common mistakes:**
- Empty field. Pre-screen rejects the submission before panel review.
- Slideshow-only (no live demo).
- Too long.
- Bad audio.

**Winning 5-segment script:**
- 0:00 to 0:30 Hook: founder on camera names the project, the traction, and the proposal.
- 0:30 to 1:00 Problem: what the dossier addresses.
- 1:00 to 2:00 Live demo: CTO shows the actual testnet contract on Stellar Expert with a real transaction hash. This single move converts the video from liability to asset.
- 2:00 to 2:35 Team and traction: named cofounders, named clients or LOIs, recognitions.
- 2:35 to 3:00 Closer: budget, tranches, mainnet target.

Production time: 6 to 8 hours after the testnet contract is shipped.

## Q7 Soroban

**Choices:** Yes / No / "Maybe in the future, but not in this submission".

**Guidance:** Yes if the dossier uses Soroban contracts. If unsure, Yes is the safe choice for any contract-based dossier.

## Q8 Product and Services (multi-paragraph)

**Panel intent:** what is built, in detail, with the Stellar role and the impact for each component.

**Required structure per component:**
1. Name and short description.
2. Stellar use: which specific Stellar primitive or SCF Integration List item.
3. Impact: how this changes the project.

**Common mistakes:**
- Generic "Soroban contracts" without naming them.
- Listing planned features but no Stellar mapping.
- Mentioning items not on the Integration List as if they were (Fireblocks, Wirex, Elliptic).
- Earn-to-X language.

**Winning template:**
```
This submission funds [the specific scope].

1. [Component 1 name]
   Description: [what it does].
   Stellar use: [specific Soroban contract, specific Integration List item].
   Impact: [how this changes the project or the ecosystem].

[Repeat for each component, 3 to 6 components total.]

Supporting institutional infrastructure (NOT funded by this grant): [Fireblocks for X, Certora audit covered by Stellar LaunchKit credit at Tranche 2 review].
```

## Q9 Traction Evidence

Same panel intent as Abstract Q4 but with more space and more recent updates. Add: any new pilot signed, any new recognition, any team additions, any onchain proof from the prior Abstract phase.

## Q10 Technical Architecture (mandatory)

**Panel intent:** "do you have a credible engineering plan?"

**Common mistakes:**
- Empty field.
- Generic Google Doc that is restricted access (panel cannot view).
- One-paragraph description instead of a diagram.

**Winning structure:** public Notion page or GitHub markdown with:
1. C4 Level 1 (System Context): users to frontend to backend to Stellar network.
2. C4 Level 2 (Containers): named Soroban contracts plus wallet adapter plus indexer plus frontend modules.
3. Data flows for each major operation (issuance, settlement, redemption, etc.).
4. Integration points with named SCF Integration List items.
5. Security model (pause logic, upgrade pattern, audit plan).

Reference benchmark: Sorobanhooks TA (cited in SCF guidance) shows the expected level of detail. Effort 4 to 6 hours for an experienced CTO.

## Q11 SCF Build Tranche Deliverables (intro)

**Panel intent:** how the team thinks about money.

**Winning structure:**
```
This submission requests [$X], structured as 3 equivalent tranches of [$X/3] each.

Budget scope: [specific dev work funded].

Out of scope (NOT funded): marketing, paid distribution, user acquisition, creator campaigns, Certora audit (covered by Stellar LaunchKit credit at Tranche 2 review).

Budget anchored on [Named Past Winner] (SCF #X, $XK awarded) which had a comparable profile of [team size] + [contract scope].
```

The phrase "NOT funded by this grant" must appear. It is one of the most effective rejection-pattern prevention signals.

## Q12 Tranche 1 (MVP)

**Format per deliverable:**
- Brief description.
- How to measure completion (verifiable evidence).
- Estimated date.
- Budget.

**Recommended count:** 2 to 3 deliverables per tranche.

**Common mistakes:**
- Vague completion criteria ("the contract is built").
- No reviewer evidence cited.
- Budget too tight for the deliverable.

**Winning template per deliverable:**
```
Deliverable [N]: [Specific Soroban contract or feature name]

Description: [what the team does in this deliverable].

Measure of completion: [contract deployed to testnet with verifiable address X], [test suite Y passing], [walkthrough video Z]. Reviewer evidence: [testnet contract IDs, transaction hashes, GitHub PRs].

Estimated date: T+[N] weeks.
Budget: [$amount].
```

## Q13 Tranche 2 (Testnet)

Same format as Q12, with deliverables focused on testnet end-to-end flows. Tranche 2 unlocks the Stellar LaunchKit audit credit.

Common high-risk items: "Genesis testing with community" can be misread as marketing-adjacent. Reframe as "internal QA + automated test coverage" to keep it clearly dev work.

## Q14 Tranche 3 (Mainnet)

Same format. The last deliverable is the right place to add quantified mainnet metrics: "X mainnet transactions, Y wallets connected, $Z TVL". Quantified targets give the panel something to verify at the final tranche review.

## Q15 Budget Total

**Format:** "$XXX,XXX".

Use the budget table in `reference/06-budget-benchmarks.md`. Always sub-max ($150K).

## Q16 Go-To-Market Plan

**Panel intent:** "will anyone actually use this?"

**Required elements:**
1. Specific distribution channels (named partners, named B2B segments).
2. Conversion path from awareness to first transaction.
3. The grant note: explicitly say the grant funds dev work only, marketing self-funded.

**Common mistakes:**
- Vague TAM phrasing.
- Listing community campaigns or creator activations without flagging that the grant does not fund them.

**Winning structure:**
```
Phase 1: [B2B sales motion or partner-led distribution, named channels].
Phase 2: [product-led acquisition, named user segments].
Phase 3: [scale through ecosystem partnerships].
Phase 4: [international expansion].

Grant note: the SCF grant funds product development only. Marketing, paid distribution, content creator campaigns, AMA hosts, and community rewards are self-funded by [the project] via [existing revenue / fundraising round / partner economics]. No SCF funds are used for paid user acquisition.
```

The grant note is what blocks the rejection pattern of "budget misuse".

## Q17 Success Criteria

**Panel intent:** how the team and the panel will know this worked.

**Required structure:** three-tier (MVP, Testnet, Mainnet) plus ecosystem impact plus business impact plus long-term vision.

**Winning template:**
```
MVP success (Tranche 1):
- [specific technical milestones].
- [specific product milestones].

Testnet success (Tranche 2):
- [specific testnet flow milestones].
- [Certora audit completed via Stellar LaunchKit credit].

Mainnet success (Tranche 3):
- [specific mainnet deployment milestones].
- Quantified mainnet activity: [X wallets, Y transactions, $Z TVL].

Ecosystem impact:
- [first-of-its-kind primitive in the ecosystem].
- [USDC or EURC adoption uplift].
- [open-source primitive forkable by N other studios].

Business impact:
- [revenue or AUM trajectory].
- [client acquisition trajectory].

Long-term vision:
- [post-grant continuity].
```

## The 5 most common Build-phase mistakes

In order of frequency:

1. **Q5 Code URL or Q6 Video URL or Q10 Architecture left empty.** Pre-screen rejection.
2. **Inconsistency between Abstract and Build.** Contract names, project category, distribution claims that don't match.
3. **Vague deliverables.** "Build the contract" without verifiable evidence per deliverable.
4. **Budget mismatched with scope.** Maximum ask with single-contract scope.
5. **Missing grant note in Q16.** Reviewers default to suspicion about marketing budget misuse.
