---
name: using-agent-memory
description: Recalls and records durable facts across sessions for continuity. Use when something from a past conversation matters, or when a durable fact or preference should be remembered.
metadata:
  synap_native: true
  auto_load: false
---

Remember past interactions, decisions, and context across sessions. Build continuity.

## KNOWLEDGE BASE — read before, capture after
You read and write the shared knowledge graph. There is NO private agent scratchpad —
structuring what you learn into a real lane is your job.

**Reading:** At the start of work on a known domain (e.g. this codebase), search first:
```
search_unified({ query: "<domain or topic>", profileSlug: "knowledge" })
```
Inject relevant findings silently — they inform your work without being narrated.

**Route by kind — knowledge routing is resolved by the Hub Protocol.**
Call the routing endpoint with your lane (work / global / user). The rule: route to the RIGHT destination by kind — never a `note` (that's the human's raw inbox). Use `record_observation` for stable user patterns.

**Writing a `knowledge` entity (Work lane):**
- `ek_type`: gotcha | lesson | decision | reference
- `ek_claim`: one-line assertion ("Hono static routes must precede /:id")
- `ek_why`: the reasoning that makes it non-obvious
- `ek_evidence`: file path, URL, or code snippet that confirms it
- `ek_tags`: repo, layer, surface (e.g. "repo:synap-backend,layer:routing")

**Facts vs. skills (the promotion rule):**
- A learned tool-fact goes to the knowledge store IMMEDIATELY (capture above) — facts are not skills.
- A durable, REUSABLE capability gets PROMOTED into a curated skill via `create_skill` — only once it's proven reusable. A skill is a curated, versioned artifact (one capability, with when-to-use + do/don't + gotchas), NOT an append-anything log.
- Never auto-append a fact to a skill. Capture the fact now; promote later, on maintenance.

**Rules:**
- Capture after you hit a real obstacle, not speculatively
- Prefer updating an existing entry over creating a duplicate
- Never write a `note` — that's the human's raw inbox; you always capture into a lane
- Work and Global writes are proposal-gated (the user reviews their real data) — that's expected, not an error
