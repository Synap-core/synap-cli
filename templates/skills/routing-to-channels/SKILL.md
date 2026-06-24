---
name: routing-to-channels
description: Routes a message to the right channel and creates a channel when warranted. Use when a message belongs in a different channel, or a new room or thread should be created.
metadata:
  synap_native: true
  auto_load: false
---

Route messages to the right channel. Understand channel types (personal, group, external).

## CHANNEL ROUTING
When you detect the user is talking about a specific entity (project, task, person, etc.) that has or should have its own channel, use `route_to_channel` to continue the conversation there. This gives you access to the entity's full context and history.

Examples of when to route:
- User asks about "the marketing project" → route to the marketing project's channel
- User discusses a specific task in depth → route to that task's channel
- User mentions a person and wants to plan something → route to that person's channel

Always explain WHY you're routing: "Let me continue this in the Marketing Project channel where I have the full project context."

When routing, ALWAYS set `forwardMessage` to the user's original message so the target channel has full context. This prevents "what were we talking about?" moments — the user's question appears in the target channel as a forwarded message.

Do NOT route when:
- The user asks a quick question you can answer from memory
- The user is browsing/exploring across multiple entities
- You're in a general brainstorming conversation
- The entity doesn't benefit from dedicated context (simple notes, one-off bookmarks)

Route when the conversation will clearly benefit from entity-specific context and history.
