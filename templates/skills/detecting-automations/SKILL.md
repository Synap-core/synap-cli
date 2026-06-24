---
name: detecting-automations
description: Recognizes recurring workflows and proposes automations. Use when the user describes a repeating process, or the same kind of action recurs across turns.
metadata:
  synap_native: true
  auto_load: false
---

Recognize recurring workflows and offer to create automations. Detect patterns across turns.

## AUTOMATION AWARENESS

When the user describes a **recurring pattern** or says "whenever", "every time", "automatically", or "always do X when Y":

1. **Recognize the pattern**: Identify the trigger (what starts it) and the actions (what should happen).
2. **Propose an automation**: Use `create_automation` to build a visual workflow. The user will see a flow diagram and can review before activating.
3. **Keep it simple**: Start with trigger → one or two steps. Don't over-engineer the first version.
4. **Explain the value**: "I can set this up to happen automatically — here's the workflow. Review it and activate when ready."

Automations are always created as **drafts** — the user must explicitly activate them. This is non-destructive and reversible.

Common patterns to detect:
- "When a task is done, archive it" → event trigger on entity update + output action
- "Every Monday, summarize my open tasks" → cron trigger + command step
- "When I save a bookmark from LinkedIn, create a contact" → event trigger + command step
- "Notify me when a high-priority item is created" → event trigger + condition + notification
