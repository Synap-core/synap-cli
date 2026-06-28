# Chat summary templates by delivery scenario

Templates for the chat message that accompanies every Excel deliverable. Always includes probability range (before and after fixes), top 3 to 5 priority fixes, budget recommendation, and the file link.

## Template 1: First Abstract review (v1)

Use when delivering the first review for a new client.

> Dossier livré, fichier v1 sauvegardé.
>
> Verdict: estimated [XX] to [YY] percent probability of acceptance as currently drafted, lifting to [AA] to [BB] percent after the [N] priority fixes below.
>
> Top 5 fixes (in priority order):
> 1. [Q-number] [Field]: [specific action]. Effort [time]. Impact: lifts probability by roughly [X] to [Y] points.
> 2. [Q-number] [Field]: [specific action]. Effort [time]. Impact: [specific impact].
> 3. [Q-number] [Field]: [specific action]. Effort [time]. Impact: [specific impact].
> 4. [Q-number] [Field]: [specific action]. Effort [time].
> 5. [Q-number] [Field]: [specific action]. Effort [time].
>
> Recommended budget: $[X],000 [Track], 3 tranches of $[X/3]. Anchored on [Named Past Winner] ($YY,000 SCF #NN, comparable profile of [team size] + [contract scope]).
>
> Three biggest risks if not addressed: [list the highest-impact rejection patterns triggered, in plain language, with one named past dossier per pattern].
>
> [Open the file](computer://path/to/file.xlsx)

## Template 2: Revision (v2 after client feedback)

Use when delivering a revised review after client iteration.

> Dossier mis a jour, fichier v[N] sauvegardé. Probabilité revisitée a [XX] a [YY] percent maintenant, [AA] a [BB] percent apres les [N] derniers fixes.
>
> Changes vs v[N-1]:
> 1. [Specific change made]: [impact on score and probability].
> 2. [Specific change made]: [impact].
> 3. [Specific change made]: [impact].
>
> Top remaining fixes:
> 1. [Q-number] [Field]: [specific action]. Effort [time].
> 2. [Q-number] [Field]: [specific action]. Effort [time].
> 3. [Q-number] [Field]: [specific action]. Effort [time].
>
> Budget unchanged at $[X],000 [Track] anchored on [Named Past Winner].
>
> [Open the file](computer://path/to/file_v[N].xlsx)

## Template 3: Build phase review (after Abstract approval)

Use when transitioning from Abstract to Build review.

> Build phase review livre, fichier v1 sauvegardé.
>
> Verdict: estimated [XX] to [YY] percent probability of full Build award as currently drafted, lifting to [AA] to [BB] percent after the priority fixes.
>
> The Build phase introduces three new blocker categories that the Abstract did not surface. Address these first:
>
> 1. Q5 Code URL: [current status]. Action: [specific action]. Effort [time].
> 2. Q6 Video URL: [current status]. Action: 5-segment script under 3 minutes, founder on camera, live demo of testnet contract on Stellar Expert. Effort 6 to 8 hours after testnet contract is shipped.
> 3. Q10 Technical Architecture: [current status]. Action: public Notion or GitHub markdown with C4 Level 1 + Level 2 + data flows. Effort 4 to 6 hours.
>
> Then the field-level rewrites in Sheet 1.
>
> Budget: $[X],000 across 3 tranches of $[X/3]. Tranche 1 [scope summary]. Tranche 2 [scope summary]. Tranche 3 mainnet + quantified targets.
>
> [Open the file](computer://path/to/Build_Review_v1.xlsx)

## Template 4: Comeback strategy (client lost prior round)

Use when advising a client who was rejected in a prior round.

> Dossier comeback livré, fichier v1 sauvegardé.
>
> Verdict: prior dossier was rejected at $[prior budget] in SCF #[prior round]. Likely panel concerns based on the prior dossier's profile: [pattern 1 in plain language], [pattern 2], [pattern 3]. Named past comparables that died for the same patterns: [Past Reject 1 ($X,000)], [Past Reject 2 ($Y,000)].
>
> Proposed comeback moves (in priority order):
> 1. [Move N from `reference/05-comeback-patterns.md`]: [specific implementation]. Effort [time]. Lifts probability by roughly [X] to [Y] points.
> 2. [Move N]: [specific implementation]. Effort [time].
> 3. [Move N]: [specific implementation]. Effort [time].
>
> Recommended new budget: $[X],000 (down from prior $[prior]). Anchored on [Named Past Winner].
>
> Recommended Q9 acknowledgment sentence: "We addressed the prior panel feedback by [specific change]."
>
> Estimated probability with comeback moves applied: [AA] to [BB] percent.
>
> [Open the file](computer://path/to/Comeback_Review_v1.xlsx)

## Template 5: Drafting Abstract from scratch (client has nothing yet)

Use when the client asks us to draft the Abstract rather than review one.

> Abstract drafted, fichier v1 sauvegardé. The file contains all 12 Q-fields as paste-ready English text plus a placeholder list of items I need from you before final submission.
>
> Information I need from you to finalize:
> 1. LinkedIn URLs for all named co-founders (verifiable, slug exactly matching profile).
> 2. GitHub URL for the CTO.
> 3. Legal entity name and RCS registry number (e.g., RCS Paris 940 123 456).
> 4. Specific named pilot customers or LOIs (with status: signed / verbal / pipeline).
> 5. Vault partner name / banking partner name / regulatory partner name (if regulated category).
> 6. Discord usernames for Q12 (comma-separated).
> 7. Thumbnail asset (1200x630 px PNG or JPG); if you have an og-image.png on the website, that often works.
>
> Estimated probability if you fill these in and submit as drafted: [XX] to [YY] percent.
>
> Recommended budget: $[X],000 [Track], 3 tranches of $[X/3]. Anchored on [Named Past Winner].
>
> [Open the draft](computer://path/to/Abstract_Draft_v1.xlsx)

## Template 6: Quick triage (client asks "is my dossier ready?")

Use when the client wants a fast yes/no plus top concerns, not a full review.

> Quick triage on the current draft:
>
> Verdict: [READY TO SUBMIT / FIX TOP 3 BLOCKERS FIRST / DO NOT SUBMIT YET].
>
> Top 3 issues that would worry me as a reviewer:
> 1. [Specific issue]: [reason]. Named past dossiers rejected for similar reason: [Name 1, Name 2].
> 2. [Specific issue]: [reason].
> 3. [Specific issue]: [reason].
>
> If you address these before [deadline], I would put your probability at [XX] to [YY] percent. As currently drafted, [AA] to [BB] percent.
>
> Want me to produce a full field-by-field review? Reply yes and I will deliver in [N] hours.

## Template 7: Post-submission update (after client has submitted)

Use after the client tells you they have submitted.

> Submission noted. Tracking status on SCF #[round]:
>
> - Expected pre-screen window: [date range]. If your dossier moves to Information Collection, contact me immediately so we can fix the missing item within 48 hours.
> - Expected panel decision: [date range].
> - Expected award notification: [date range].
>
> What I will do during this period:
> - Monitor Information Collection status.
> - Watch for SCF policy updates that affect your dossier.
> - Prepare Tranche 1 deliverables checklist for post-award.
>
> What you should do:
> - Continue product development on the Tranche 1 scope (testnet contract, video walkthrough, architecture doc).
> - Reply quickly to any SCF team email.
> - Hold off any major scope changes until the panel decides.
>
> If approved, we engage on Tranche 1 review prep. If rejected, we trigger the comeback strategy.

## Common chat summary mistakes

- Probability stated as a point estimate rather than a range. Always range.
- "Likely" or "probably" without anchoring on a named past dossier.
- More than 5 fixes in the top list. Above 5, the client loses focus.
- Missing the budget recommendation. Always include the anchor.
- Long preamble before the verdict. Start with the verdict.
- Em-dashes in the chat. Same rule as for the file.

## Calibration

Chat summary should be readable on a phone in 30 to 45 seconds. If the client has to scroll three times, it is too long. Aim for under 250 words for a v1 delivery.
