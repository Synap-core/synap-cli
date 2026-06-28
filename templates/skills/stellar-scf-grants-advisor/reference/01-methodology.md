# Methodology: how The Arch Consulting reviews an SCF dossier

This is the master process every review follows. Read this before your first review of any session.

## Why a structured methodology

Stellar Community Fund panels review 50 to 80 submissions per round. They reject 70 to 75 percent of them. The 25 to 30 percent who win share a remarkably stable set of attributes. The 70 to 75 percent who lose share an equally stable set of failure modes. Random advice does not move a dossier from one bucket to the other. Pattern-anchored advice does.

The methodology converts that asymmetry into a repeatable seven-step process.

## The seven steps

### Step 1: read what the client actually submitted

Open the Project Abstract sheet (for Abstract phase) or the Application Build sheet (for Build phase). Read every cell. Note the fields the client left empty. Note any inconsistency between fields (for example: budget mentioned in Q4 abstract that doesn't match the budget mentioned in Q11 Build intro). The panel reads horizontally across fields too; inconsistencies they spot cost the client credibility.

### Step 2: read every public source about the project

Before scoring, gather context:
- The project website (web-fetch the URL provided in Q5).
- Any deck, technical architecture link, or video URL.
- LinkedIn profiles of the founders (look up the URLs in Q10).
- The X / Twitter and Discord handles if provided.
- Any GitHub repository if mentioned in Q5 of Build phase.

What you discover here often contradicts or amplifies what the client wrote. A founder claiming to be "ex-BNP Paribas" might turn out to be a one-year client advisor at a regional branch, or might turn out to have led a regulated business line, both matter for how you score the team section. A website tagline like "Bankruptcy-proof gold ownership with Swiss-grade security" might reveal a positioning the client forgot to put in the Abstract.

**Always check for assertion vs reality.** When the client overclaims (rare but it happens), point it out diplomatically: the panel will check too.

### Step 3: score against the 14 signals

Use `reference/02-scoring-framework.md`. For each of the 14 signals, give the dossier a score from 1 to 10. A score below 5 is a flag for rewrite. A score below 3 is a flag for blocker. Track the lowest signal: that is the limiting factor for the dossier's overall probability of acceptance.

### Step 4: identify which recurring rejection patterns are triggered

Use `reference/03-rejection-patterns.md`. There are 12 documented patterns that have caused most rejections in past rounds. For each pattern that the current dossier shows, you need to:
- Name the pattern in plain language.
- Explain why the panel cares (the mechanism, not the label).
- Cite two or three past rejected dossiers that died on this exact pattern.
- Propose the specific fix.

This step is where you do the most communication work for the client. Most of them do not know these patterns exist. Help them see them.

### Step 5: surface the winning patterns the dossier already has

Use `reference/04-winner-patterns.md`. The same care for past rejects applies in reverse: when a dossier has elements that mirror past winners, name them so the client builds confidence and so we preserve those elements in any rewrite. A dossier that already nailed the "doxxed team with verifiable past shipped product" pattern should keep that strength front and center.

### Step 6: compare directly against named past submissions

Use `reference/10-corpus-winners.md` and `reference/11-corpus-rejects.md`. Pick 10 to 15 past submissions in the same category (regulated finance, gaming, RWA, B2B marketplace, etc.) and lay them out side-by-side with the current dossier. For each past submission, write a single line that captures the comparison and the lesson.

This is the most evidence-rich part of any review. It also lets you anchor budget recommendations on real awards.

### Step 7: write the deliverable

Generate the Excel review using `reference/13-excel-output-spec.md`. Then present a concise chat summary with the probability estimate before and after fixes, the top three to five actions, and the link.

## What separates a good review from a bad one

A bad review repeats SCF guidance and adds generic recommendations. A good review does four things every time:

1. **Anchors every claim on a named past dossier.** "We've seen this fail" is opinion. "This is exactly why Stablpay was rejected at $129K in SCF #40" is evidence.

2. **Pairs every problem with a paste-ready rewrite.** The client should never wonder how to apply the feedback. The rewrite column gives them text they can copy directly into the orange cell.

3. **Uses client-friendly language throughout.** Internal terms like "kill signature" or "corpus" stay internal. To the client we say "common rejection pattern we've seen in past SCF rounds" or "our database of 130+ rejected and 79+ awarded dossiers."

4. **Ends with a budget recommendation anchored on a named winner.** Never recommend a budget without naming a past winner with a comparable profile.

## Common workflow variations

### Variation A: client sent only contact info, no Abstract

Tell the client what's missing and what you need. Do not pretend you can review without seeing the field contents. The Q10 Contact Infos sheet alone does not let you score anything.

### Variation B: client wants you to write the Abstract from scratch

Use `reference/08-abstract-fields.md`. Field by field, draft what they should submit. Flag the information you need from them (founder LinkedIn URLs, vault partner name, regulatory framework, etc.) in placeholder brackets.

### Variation C: client passed the Abstract phase and is moving to Build

The Build phase is more technically rigorous. Use `reference/09-build-fields.md`. The biggest risks in Build phase are: empty Q5 Code URL, empty Q6 Video URL, empty Q10 Technical Architecture link, generic deliverable descriptions, and inconsistency between the approved Abstract and the new Build content.

### Variation D: client lost a previous round and is reapplying

Read `reference/05-comeback-patterns.md` first. There are 13 documented cases of rejected-then-won dossiers in the corpus. The pattern of changes is consistent. Apply those patterns to the rewrite.

### Variation E: client wants a budget recommendation only

Pull `reference/06-budget-benchmarks.md`. Identify the past winner with the closest profile. Anchor on it. Recommend the budget. Explain the anchor in one sentence to the client.

## A note on probability estimates

When you give a probability estimate (for example "estimated 65 to 75 percent probability of acceptance after fixes"), it should always be a range, not a point estimate. The range communicates honest uncertainty. The range should also be backed by the named past comparables: "we estimate this range because three past dossiers with the same revised profile won in SCF #40 to #42, and two were rejected".

When a client's profile is uniquely strong (For Yield, Rebond with full LOIs), you can go as high as 75 to 85 percent after fixes. When the profile is uniquely weak (anonymous solo dev at max ask), you can go as low as 5 to 15 percent. The vast majority sit between 35 percent and 70 percent. Be honest about the range; it builds the relationship.
