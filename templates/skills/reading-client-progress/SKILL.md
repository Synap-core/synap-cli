---
name: reading-client-progress
description: Methodology for reading a Stellar grant client's most recent messages and determining exactly where they stand in the Stellar Community Fund (SCF) process. Use when an extraction step needs to classify a client's latest CLIENT-COMMS messages into a strict {stage, grantStatus, excelUrl, advancement} JSON result. Triggers include syncing client progress, advancing a Stellar grant session from comms, or reading a company's recent messages to infer pipeline stage and health.
---

# Reading Client Progress

You read a Stellar grant client's most recent messages and decide where they are in the SCF process. You output a single strict JSON object — nothing else. This skill is the reference an extraction `command` node embeds; it is consumed by an automation, not a human, so prose, markdown fences, and commentary are forbidden in the output.

## Input

You receive the client's recent messages as an array of `{ role, content, authorName, createdAt }` (most recent last). These come from the client's CLIENT-COMMS channel — the external thread where the client shares their project, drafts, links, and replies. Read them in chronological order to understand the trajectory; weight the most recent messages most heavily for the current stage.

## Output — STRICT JSON, nothing else

Respond with NOTHING but a single JSON object, no prose, no markdown fences, exactly this shape:

```
{ "stage": "scope|abstract|build|awaiting-stellar|closed", "grantStatus": "not-responding|waiting-on-client|in-review|submitted|passed", "excelUrl": string|null, "advancement": string }
```

If you cannot determine a field, use the most conservative value: `stage` defaults to `"scope"`, `grantStatus` defaults to `"waiting-on-client"`, `excelUrl` defaults to `null`. Never invent a value.

## `stage` — pipeline position (where the work is)

`stage` is the client's position in the ordered SCF pipeline. Pick the FURTHEST stage the messages clearly support:

- **`scope`** — Default. The client has not yet shared a concrete project, or is still explaining what they're building. Use until they share the project (site / GitHub / deck / clear description) and the engagement starts working on the Abstract.
- **`abstract`** — The client is actively working the SCF **Project Abstract** (the 12-field abstract / interest form). Messages reference the Abstract, abstract fields, the interest form, or a draft Abstract being reviewed.
- **`build`** — The client is working the SCF **Build dossier** (Code URL, Video, Tech Architecture, 3-tranche budget). Messages reference the Build submission, the build dossier, tranches, the technical architecture, or the demo video. Build comes AFTER abstract.
- **`awaiting-stellar`** — The client has **submitted** to SCF and is waiting on the panel. Messages say they submitted, sent it in, or are waiting on Stellar / the panel / the vote. No further drafting.
- **`closed`** — The engagement is complete: the client was **awarded** (won the grant) or **rejected**. Messages confirm an award or a rejection decision.

Stages are monotonic — don't regress to an earlier stage on the strength of an old message if a later message shows they've moved on.

## `grantStatus` — comms / health sub-status (how it's going)

`grantStatus` is orthogonal to `stage`. It captures the health of the engagement from the comms, not the pipeline position:

- **`not-responding`** — The client has gone quiet; we're waiting and they haven't replied to our last asks.
- **`waiting-on-client`** — The ball is in the client's court (we asked for something — a draft, a link, info — and await their reply).
- **`in-review`** — We are actively reviewing / working the client's material right now.
- **`submitted`** — The dossier has been submitted to SCF (pairs naturally with stage `awaiting-stellar`).
- **`passed`** — The grant was awarded (pairs naturally with stage `closed`).

## `excelUrl` — the client's working dossier link

`excelUrl` is the client's working Excel / Google Sheet / dossier URL if one appears anywhere in the messages, else `null`. Look for:

- `.xlsx` file links
- Google Sheets links (`docs.google.com/spreadsheets/...`)
- Google Drive links (`drive.google.com/...`) to a sheet or dossier
- Any link the client calls their "abstract", "build", "dossier", "submission sheet", or "grant sheet"

If several appear, prefer the most recent one. If none appear, return `null` — do not guess or fabricate a URL.

## `advancement` — one-sentence note

`advancement` is a single plain-language sentence summarizing where the client is and what's next (e.g. "Client shared their GitHub and pitch deck; ready to start the Abstract." or "Abstract draft delivered for review; waiting on client to confirm the budget."). Keep it to one sentence. If genuinely unknown, use a short honest note like "No recent client activity to assess."

## Reminders

- Output ONLY the JSON object. No prose, no markdown fences, no leading or trailing text.
- Omit nothing — always return all four keys. Use the conservative defaults / `null` when unknown.
- `stage` = pipeline position; `grantStatus` = comms/health. They move independently.
