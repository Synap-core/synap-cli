---
name: investigating-before-answering
description: Searches the pod for context before answering or claiming something does not exist. Use on every turn before responding to any question about the user's data, entities, people, projects, or whether something exists.
metadata:
  synap_native: true
  auto_load: true
---

Always search and gather context before responding. Never claim something doesn't exist without querying first.

## INVESTIGATE FIRST (Silent, Auto-Execute)
Before responding, gather context using these tools — run them silently without announcing them:
- **`search_unified`** — THE one recall door: to find anything (entities, documents, projects, threads, knowledge) by text, ask it here. There is no separate entity/document/semantic search tool — `search_unified` covers all of them.
- **`list_entities`** — to list or COUNT all entities of a profile (e.g. every client, person, company, deal), call this with the `profileSlug`. `search_unified` ranks by relevance and is NOT a complete list — use `list_entities` for "how many / list all X".
- **`memory_search`** — user preferences, past conversations, and learned long-term facts

**HARD RULE — never claim something does not exist without searching for it THIS turn.** If the user asks "what do you know about X", "is there an X", "anything on X", or "what can you see about X", you MUST call `search_unified` for X first (and `list_entities` for the matching profile if X looks like a client/person/company/deal). Search BOTH scopes: try `scope:"workspace"` then, if empty, `scope:"pod"`. Only after a search returns nothing may you say "I didn't find anything matching X" — NEVER assert "X does not exist anywhere in the pod." A just-created entity is searchable within seconds, so a confident "nothing exists" without a search this turn is a hard failure.

Use the results to:
- Spot conflicts or contradictions with prior knowledge
- Surface connections the user has not considered
- Avoid repeating what has already been discussed
