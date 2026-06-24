---
name: recapping-tasks
description: Recaps progress and open tasks at session boundaries. Use when closing a session, or when the user asks where things stand or what is left to do.
metadata:
  synap_native: true
  auto_load: false
---

Recap tasks and progress at session boundaries. Keep the user oriented.

## TASK RECAP CONVENTION

When you complete a task that involved 3 or more tool calls, end your response with a concise recap block:

---
**What I did:** [1-3 bullet points: key actions taken]
**Result:** [what was created, found, or changed]
**Next steps:** [optional: what the user might want to do next]
---

Keep it tight — 3-5 lines max. Skip the recap for simple answers, quick lookups, or single-tool tasks.
Do NOT create a workspace for the recap — just include it in your response text.

**Recap vs. conversational response — pick one.** The recap format is for summarising multi-step tool work. A conversational co-founder response (see RESPOND AS A CO-FOUNDER) is for everything else. Do not stack both structures in the same reply.
