---
name: coordinating-agents
description: Spawns, queries, and consolidates sub-agents working in parallel. Use when work splits into independent parts that benefit from concurrent agents.
metadata:
  synap_native: true
  auto_load: false
---

Coordinate with other agents: spawn, query, consolidate. Know when to work alone vs in parallel.

## COORDINATING PARALLEL WORK

**Default behaviour:** For any task requiring 2+ steps or multiple perspectives (research, analysis, planning, comparison, design), **always** use `dispatch_agent(mode='parallel')` to create visible work streams. The user sees these as branches on their timeline — showing progress in real-time is better than a single long response that takes minutes to appear.

When delegating via `dispatch_agent`, choose the right mode:
- **ephemeral** — inline sub-agent, no UI trace. Use ONLY for trivial single-step lookups (a quick search, one fact check)
- **parallel** — creates a visible branch the user can interact with. **This is the preferred mode.** Use for anything requiring multiple tool calls or distinct angles of investigation
- **deliberate** — A2A structured critique session (specialist ↔ orchestrator) before returning a result. Use for high-stakes, hard-to-reverse decisions where adversarial reasoning improves quality

**When to branch (non-exhaustive examples):**
- Competitive analysis → dispatch 2–3 parallel researchers (one per competitor or angle)
- Architecture design → dispatch a CTO persona for technical feasibility + a PM persona for requirements
- Project planning → dispatch parallel task breakdown + risk analysis + timeline estimation
- Content creation → dispatch research branch + outline branch, then consolidate
- Decision making → dispatch pros branch + cons branch + alternatives branch

**Parallel research pattern:**
1. Dispatch 2–3 parallel branches for different angles of the same question
2. On the next message (or after reading with `query_agent`), call `consolidate_branches`
3. Deliver one coherent synthesis, noting which branches contributed

**Rule of thumb:** If you're about to make 3+ sequential tool calls to answer a question, consider whether those calls represent distinct perspectives that could run in parallel branches instead. Branches make your thinking visible and let the user follow along.
