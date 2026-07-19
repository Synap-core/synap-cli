# Associate cheatsheet (1 page)

Print this. Keep it next to you during reviews and client calls.

## The 7-step review process

1. Read the client's submitted content (every field).
2. Web-fetch website, deck, founder LinkedIns, GitHub.
3. Score against 14 signals (1 to 10 each).
4. Identify rejection patterns + cite past examples.
5. Surface winning patterns (don't erase strengths in rewrites).
6. Compare to 10-15 corpus comparables.
7. Generate Excel + chat summary with probability range.

## The Excel deliverable (4 sheets, always)

| Sheet | Content |
|---|---|
| 1. Field-by-Field Review | Q-numbers, Status, Review (FR or EN), Rewrite (EN paste-ready) |
| 2. Pre-submission Checklist | Priority, Item, Field, Effort, Why, Status |
| 3. Corpus Comparables | 10-15 past dossiers side-by-side with current |
| 4. Integration List Audit | Each Stellar item: MENTIONED / TO ADD / OPTIONAL / NOT RELEVANT |

## Banner row formula

> "[Project] [Phase] Review v[N]: estimated XX to YY pct probability now, AA to BB pct after fixes. Budget anchor $[X],000 [Track], anchored on [Named Past Winner] ($YYK SCF #NN)."

## Vocabulary translation (NEVER use left column with clients)

| Internal | Client-friendly |
|---|---|
| kill signature | common rejection pattern, recurring red flag |
| corpus | our database of 130+ rejected and 79+ awarded dossiers |
| doxxing depth | whether founders are publicly identifiable |
| bolt-on | port from another chain without a Stellar-specific reason |
| TAM-grandiose | vague total addressable market claims |
| sub-max | below the $150K maximum |
| heightened scrutiny | extra scrutiny applied at maximum-ask submissions |

## The 14 signals (memorize order)

1. Team identity (doxxing depth)
2. Stellar-native traction
3. Budget realism vs scope
4. Scope clarity (named contracts + Integration items)
5. Differentiation from previously-funded teams
6. Track choice fit (Integration vs Open vs RFP)
7. Go-to-market specificity (named partners + customers)
8. Milestone precision (verifiable evidence + quantified targets)
9. Traction evidence (live URLs + LOIs + revenue)
10. Regulatory framing (named framework + license partner)
11. Open-source posture (MIT/Apache 2.0)
12. Brand non-collision
13. SDF roadmap alignment (x402, Protocol 25 X-Ray, EURC, MiCA, agentic payments)
14. Comeback signal (only for reapplying teams)

## The 12 rejection patterns (memorize by name)

1. Unidentifiable-founder pattern
2. Maximum-budget-without-scope pattern
3. Generic-name pattern
4. Brand-collision pattern
5. Multi-chain-bolt-on pattern
6. SDF-roadmap-overlap pattern
7. Already-funded-competitor pattern
8. Regulated-product-without-regulatory-plan pattern
9. Vague-TAM pattern
10. Earn-via-low-effort-activity pattern
11. Incomplete-dossier pattern (Information Collection status)
12. Cluster-of-issues rejection (Panel Review Failed)

## Budget anchors (memorize)

| Anchor | Profile | Budget range |
|---|---|---|
| Bando (SCF #42 won) | RWA single-pilot, doxxed, regulated partner named | $75K-$90K |
| TheXBank (SCF #40 won) | Africa banking with country pilot | $80K-$100K |
| The Signal (SCF #42 won) | B2B marketplace, 2 doxxed, 1 contract | $115K-$125K |
| Rebond (target SCF #44) | RWA bonds, 2 doxxed, 4 LOIs, regulatory framework | $125K-$135K |
| For Yield (target SCF #44) | Regulated DeFi yield, 11-team, AMF filed | $135K-$145K |

Tranche structure (always 3 equivalent tranches):
- $90K = 3 x $30K
- $108K = 3 x $36K
- $121.2K = 3 x $40.4K
- $132K = 3 x $44K
- $144K = 3 x $48K

## Pre-screen blockers (NEVER ship a Build phase dossier without these)

- Q5 Code URL: public GitHub with README + MIT + scaffold (ideally testnet contract deployed)
- Q6 Video URL: YouTube/Vimeo, under 3 min, 5-segment script, live demo on Stellar Expert
- Q10 Technical Architecture: public Notion or GitHub markdown with C4 L1 + L2 + flows
- Q8 Thumbnail: 1200x630 image uploaded

## SCF Integration List essentials

- **Wallets**: Stellar Wallets Kit (default), Privy (mainstream), DFNS (institutional), Freighter Connect
- **Off-ramp**: Anchor Platform (EU), Bridge (Stripe-acquired), MoneyGram (emerging markets), Mercuryo
- **DeFi**: DeFindex (yield), Blend v2 (lending), Aquarius (DEX), Soroswap (aggregator)
- **Cross-chain**: Allbridge, Near Intents, Axelar
- **Payments**: Stellar Disbursement Platform (SDP)

Items NOT on the list (Fireblocks, Elliptic, Certora, Wirex) = supporting infra, not Integration Track items.

## Em-dash rule

Never use the long-dash punctuation character (the wide horizontal line, Unicode U+2014) in any client deliverable. Use commas, colons, parentheses, periods, or single hyphens instead. The long-dash reads as machine-generated.

## QA before sending any deliverable

1. Zero em-dashes anywhere in the file.
2. Zero use of "kill signature" anywhere in the file.
3. Every flagged problem cites at least one named past dossier.
4. Budget recommendation cites a named past winner with comparable profile.
5. Every paste-ready rewrite (Column D) is in English, not French.
6. Banner row contains specific numbers (not "TBD").
7. Sheet names: "Abstract Review" or "Build Review" / "Checklist Pre-Submit" / "Comparables Corpus" / "Audit Integration List".

## The chat summary after every delivery

> "Dossier livré, fichier v[N] sauvegardé.
> Verdict: estimated XX-YY pct probability now, AA-BB pct after fixes.
> Top 5 fixes (in priority order): [list].
> Recommended budget: $[X],000 [Track], 3 tranches of $[X/3].
> [Open the file](computer://path/to/file.xlsx)"

## Quick prompts for Claude with the skill

- Review: "Review this SCF Abstract: [URL]. Round SCF #[N]. Give me the 4-sheet Excel deliverable."
- Budget only: "Recommend budget for [category] dossier with [team] and [traction]."
- Triage: "Top 3 rejection patterns this dossier triggers. Cite past dossiers."
- Comeback: "Lost SCF #[N] at $[X]. Profile: [details]. What changed? What to fix?