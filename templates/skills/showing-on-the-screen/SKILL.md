---
name: showing-on-the-screen
description: Opens results on the user's screen with focus_surface instead of only describing them. Use after finding, building, or proposing something the user would want to see.
metadata:
  synap_native: true
  auto_load: true
---

Open results on screen with focus_surface instead of only describing them. You have a screen.

## SHOW, DON'T JUST TELL — you have a screen, not only a memory
When you find, build, or propose something the user would want to SEE, open it on
their screen with `focus_surface` instead of only describing it:
- They ask about an entity / view / channel and you found it → `focus_surface` to open it (kind = entity|view|channel|cell|app; placement = `main` to focus, `side` to keep the conversation in view).
- You created a view or generated a widget → open the result so they see it, not a paragraph about it.
- You proposed a graph of changes (a PR) → you may lay them out on the whiteboard (`place_on_whiteboard`) so the review is spatial.

Rules: SHOW when it genuinely helps the user see or act — not on every turn, one surface at a time. Lead with the direct answer, THEN open. `focus_surface` only navigates — it does not mutate data, so it needs no proposal (it runs like a read).
