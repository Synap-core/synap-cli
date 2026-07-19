# Partner handover: The Arch Consulting SCF grants advisory

This document is the single-file briefing for any new partner joining The Arch Consulting's SCF grants advisory practice. Read this first. The deeper reference docs in `reference/` go beyond what this briefing covers; consult them as needed.

## What we do

The Arch Consulting helps Web3 teams win Stellar Community Fund (SCF) grants. SCF awards up to $150,000 in USDC per Build Award submission. Approximately 50 to 80 dossiers are submitted per round; approximately 25 to 30 percent are awarded. The remaining 70 to 75 percent are rejected.

Our job is to move client dossiers from the rejected bucket to the awarded bucket. We do this by applying a pattern-anchored methodology built on a continuously curated database of past winners and rejects.

## Why this works

We have catalogued and analyzed every visible SCF Build Award submission since SCF #40. As of the most recent round, this includes 79+ winners, 130+ rejects, and dozens of pre-screen failures. From this data, fourteen evaluation signals and twelve recurring rejection patterns emerge consistently. These are the levers we pull when we advise.

## The methodology in one paragraph

For every client dossier, we score against fourteen signals (team identity, Stellar-native traction, budget realism, scope clarity, differentiation, track choice, GTM specificity, milestone precision, traction evidence, regulatory framing, open-source posture, brand non-collision, SDF roadmap alignment, comeback signal). We then identify which of twelve recurring rejection patterns the dossier triggers and surface them to the client with specific past examples by name. We rewrite weak fields with paste-ready text, anchor the budget on a named past winner with a comparable profile, and audit the dossier against the official Stellar Integration List. The output is a four-sheet Excel review the client uses as their pre-submit checklist.

## The cardinal rule of client communication

Never use internal vocabulary in any output the client reads. Specifically, never use the term "kill signature" in any client deliverable. Instead, describe the pattern in plain English, explain why SCF reviewers care, and cite two or three specific past dossiers by name.

The same rule applies to any other internal shorthand: "corpus", "doxxing depth", "bolt-on rejection", "TAM-grandiose" all stay internal. The client deserves the diagnosis in plain language with specific evidence, not jargon.

The full vocabulary translation table is in `reference/12-client-communication.md`.

## The fourteen evaluation signals

We score every dossier on these signals from 1 (critical weakness) to 10 (best in class).

The signals are: team identity, Stellar-native traction, budget realism vs scope, scope clarity, differentiation from previously-funded teams, track choice fit, go-to-market specificity, milestone precision, traction evidence, regulatory framing, open-source posture, brand non-collision, SDF roadmap alignment, and comeback signal (only for reapplying teams).

The lowest signal is the limiting factor for any dossier's probability of acceptance. Always fix the lowest signal first. Full descriptions and scoring rubrics in `reference/02-scoring-framework.md`.

## The twelve recurring rejection patterns

We have documented twelve patterns that account for nearly all rejections in past rounds. Each pattern is described in plain language in `reference/03-rejection-patterns.md`, with specific past dossiers named and the proven fix detailed.

In summary the patterns are: founders not publicly identifiable for a high-ask request, maximum budget without proportionate scope, generic project name, brand collision with a major unrelated company, existing project on another chain proposing a Stellar bolt-on, work that duplicates SDF roadmap, overlap with already-funded SCF projects, regulated product without a regulatory plan, vague TAM, earn-via-low-effort-activity, incomplete dossier (Information Collection status), and the cluster pattern that triggers explicit Panel Review Failed verdicts.

## Budget anchoring

We never recommend a budget without anchoring on a named past winner. The Signal won $121K in SCF #42 as a B2B marketplace with two doxxed cofounders and one Soroban contract. Bando won $75K in SCF #42 as a narrow Mexican RWA pilot. TheXBank won $89.5K in SCF #40 as Africa banking. Rebond targets $132K in SCF #44 as green bond tokenization with four signed LOIs. For Yield targets $144K as a regulated DeFi yield vault with an eleven-person team and a PSCA AMF filing.

Match the client's profile to the closest anchor, then position one tier up or down based on team size, contract scope, and traction depth. The full budget table and rules in `reference/06-budget-benchmarks.md`.

The single most important budget rule: avoid the maximum $150K ask unless the team profile and traction unambiguously justify it. Maximum ask triggers heightened scrutiny. Five past dossiers were rejected specifically at the maximum in our database (StellarRead, Easner, Tessera Labs, AION_FI Protocol, $NRG Token).

## The standard deliverable

For every review we produce a four-sheet Excel file:

Sheet 1 is the field-by-field review with three columns: status, review commentary, and paste-ready English rewrite or action. The client reads this top to bottom.

Sheet 2 is the prioritized pre-submission checklist (BLOCKER, CRITICAL, IMPORTANT, STRATEGIC) with effort estimates so the client can plan their work.

Sheet 3 is the corpus comparables sheet: ten to fifteen past dossiers side-by-side with the current one, with verdict, budget, and the one-line lesson for the current dossier.

Sheet 4 is the Integration List audit: each item on the official SCF Integration List with status (MENTIONED, TO ADD, OPTIONAL, NOT RELEVANT) and specific recommendation.

The full Excel spec is in `reference/13-excel-output-spec.md`. Templates are in `templates/abstract-review-builder.py` and `templates/build-review-builder.py`.

## The chat summary that goes with every deliverable

After producing the Excel, send the client a concise chat summary with three things: the estimated probability of acceptance before fixes and after fixes (as a range, never a point estimate), the top three to five fixes in priority order, and the link to the Excel.

Anchor every number you give the client. "Estimated 65 to 75 percent probability after fixes because three past dossiers with the same revised profile won in SCF #40 to #42" is honest. "65 to 75 percent" alone is not.

## When the client is reapplying after a previous rejection

Apply the comeback pattern playbook in `reference/05-comeback-patterns.md`. Thirteen moves are documented. Most successful comebacks apply two to four moves at once. The single highest-impact move is replacing anonymous handles with verifiable LinkedIn URLs. The second is reducing the budget ask and tightening the deliverable.

## The em-dash rule

Em-dashes (the long dash) read as machine-generated to many readers and dilute the perceived craft of the deliverable. Never use em-dashes in any client deliverable: Excel cells, Markdown documents, emails, or chat summaries.

Use commas, colons, parentheses, periods, or single hyphens instead. This rule does not change based on content type or audience.

## What we do not do

We do not write the actual SCF dossier in the client's voice without their final review. Every paste-ready rewrite we provide is a starting point; the client makes the final edit.

We do not promise outcomes. Probabilities, anchored on past data, are honest. Predictions are not.

We do not name confidential client identity, budget, or strategy in another client's review. The corpus is anonymized in our communications; only published winners and rejects are named.

We do not advise on regulated activities beyond pointing out the regulatory framework that applies. If a client needs the actual legal opinion, they hire counsel.

## How to use this skill in an AI environment

This folder is a Claude Skill. Drop the entire folder into your Claude Skills directory (or your equivalent context-injection workflow). The `SKILL.md` file is the entry point; the `reference/` folder contains the deep references the AI loads as needed.

For the most reliable AI behavior:

1. The AI should read `SKILL.md` at the start of any session that may involve an SCF dossier.
2. When a client dossier comes in, the AI should read `reference/01-methodology.md` if it has not already.
3. For Abstract reviews, the AI reads `reference/08-abstract-fields.md`. For Build reviews, `reference/09-build-fields.md`.
4. For every review, the AI reads `reference/02-scoring-framework.md`, `reference/03-rejection-patterns.md`, `reference/12-client-communication.md`.
5. The AI then uses the templates in `templates/` as the build-script starting point.

The skill is self-contained. The AI does not need any further context about The Arch Consulting; everything required is encoded in the docs.

## The single test of a good review

Before delivering, ask: would the client know what to do tomorrow morning, and would they understand why?

If yes, the review is good. If the client closes the Excel and still does not have a clear pre-submit checklist with paste-ready text, the review is incomplete.

## Reference index

| File | When to read |
|---|---|
| `SKILL.md` | Entry point, always first. |
| `PARTNER-HANDOVER.md` (this file) | Briefing for any new partner. |
| `reference/01-methodology.md` | Before your first review. |
| `reference/02-scoring-framework.md` | Every review. |
| `reference/03-rejection-patterns.md` | Every review. |
| `reference/04-winner-patterns.md` | Every review. |
| `reference/05-comeback-patterns.md` | Reapplying clients. |
| `reference/06-budget-benchmarks.md` | Every budget recommendation. |
| `reference/07-integration-list.md` | Q6 Integration review. |
| `reference/08-abstract-fields.md` | Abstract reviews. |
| `reference/09-build-fields.md` | Build reviews. |
| `reference/10-corpus-winners.md` | Citing past winners. |
| `reference/11-corpus-rejects.md` | Citing past rejects. |
| `reference/12-client-communication.md` | Always. The vocabulary and tone rules. |
| `reference/13-excel-output-spec.md` | Generating the Excel deliverable. |
| `reference/14-worked-examples.md` | When in doubt about review structure. |
| `templates/abstract-review-builder.py` | Scaffold for Abstract reviews. |
| `templates/build-review-builder.py` | Scaffold for Build reviews. |
