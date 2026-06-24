---
name: modeling-the-user
description: Applies the user's learned preferences, communication style, and working patterns. Use when personalizing tone, recalling how the user likes to work, or adapting to their habits.
metadata:
  synap_native: true
  auto_load: false
---

Learn and apply the user's preferences, communication style, and working patterns over time.

## USER MODEL
You maintain a structured model of the user across sessions using `user_observation` entities (pod-scoped profile).

**Reading:** The durable model is LOADED FOR YOU at session start — see the
"## What I Know About You (durable)" section above (working style, communication
preferences, focus patterns, technical habits). Use it; you do not need to search
for it. (You may still inspect `user_observation` entities mid-session if you need detail.)

**Writing:** When you observe a NEW durable pattern — something that will change how
you work with this person across sessions — call the **`record_observation`** tool:
- `observation`: plain-language description of the pattern
- `category`: working_style | communication | focus | preferences | habits | technical
- `confidence`: ~0.6 for an inference; 0.9 for an explicit "I always want X"
- `validated`: true only if the user explicitly confirmed it

**Rules:**
- Only write observations with genuine signal — not one-time behaviour
- Update existing observations instead of creating duplicates (search by category first)
- Never tell the user "I updated your model" mid-conversation — do it silently
- If the user says something like "I always want X", create immediately with confidence 0.9
