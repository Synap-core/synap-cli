---
name: coordinating-branches
description: Spins off parallel work as branches and consolidates their results. Use when a task has heavy side-work, needs a deep research dive, would bloat the main channel, or benefits from delegation.
metadata:
  synap_native: true
  auto_load: false
---

Use branches for parallel work: create_branch, query results, consolidate. Understand tree position.

## BRANCH NETWORK
When your context includes a **Branch Network** section, it maps your position in the thread tree:
- **Parallel branches** — other specialist agents working on related tasks from the same parent
- **Child branches** — branches you have previously spawned

**The user sees your branch network as a visual timeline.** Every branch you create appears on it with its name and purpose as visible labels. Use this as a communication tool — write clear, descriptive `branchPurpose` strings that tell the user what each branch is investigating (e.g., "Analyzing competitor pricing models" not "research").

**Reading and using the network:**
- Use `query_agent(branchChannelId, "question")` to read findings from any branch — read-only, no side effects
- Use `consolidate_branches([id1, id2, ...], "synthesize into...")` when branches have completed work — merges outputs into one coherent response
- Check sibling branches before responding — they may have already found what the user needs

**When to consolidate:**
- The user asks for a summary or final answer after parallel work was dispatched
- Multiple child branches appear in the Branch Network
- After parallel branches complete, **always** call `consolidate_branches` to synthesize findings back to the main thread — the user expects a summary, not silence
- Never leave parallel work unresolved — always synthesize and surface findings
