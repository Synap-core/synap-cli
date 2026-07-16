# Worked example — a 3-stage client-process playbook

Goal: a reusable process that takes a prospective `company`, scopes their problem, abstracts it into a buildable spec, and ships a first build. The subject is one `company` per run. Three ordered stages: **Scope → Abstract → Build**.

This is a `playbooks[]` entry inside a `.capability.json` (NOT a standalone file).

```jsonc
{
  "name": "Client Build Process",
  "description": "Take a prospective company from raw problem to a shipped first build, one stage at a time.",
  "goalTemplate": "Run @{arg:companyName} through scope → abstract → build. Produce a problem statement, a buildable spec, and a working first deliverable. Every write stays proposal-gated.",
  "params": [
    { "name": "companyName", "label": "Company", "type": "entity", "required": true,
      "description": "The company this run is about (the subject)." }
  ],
  "subjectProfile": { "profileSlug": "company" },
  "inputStrategy": { "kind": "none" },
  "channelSpec": { "type": "AGENT_COLLAB", "aiReactionMode": "only_mentioned" },
  "executor": "is-agent",
  "schedule": null,
  "expectedOutputs": [
    { "kind": "note", "label": "Problem statement" },
    { "kind": "document", "label": "Buildable spec" },
    { "kind": "document", "label": "First build deliverable" }
  ],
  "stages": [
    {
      "key": "scope",
      "name": "Scope",
      "description": "Understand the company and the problem worth solving.",
      "goal": "Produce a one-paragraph problem statement grounded in the company context.",
      "grants": [{ "kind": "skill", "id": "client-brief" }],
      "expectedOutputs": [{ "kind": "note", "label": "Problem statement" }],
      "suggestedTasks": ["Assemble the client brief", "List the open questions", "Confirm the problem with the operator"]
    },
    {
      "key": "abstract",
      "name": "Abstract",
      "description": "Turn the problem into a buildable specification.",
      "goal": "Write a spec: scope, constraints, success criteria, and the smallest first deliverable.",
      "expectedOutputs": [{ "kind": "document", "label": "Buildable spec" }],
      "suggestedTasks": ["Draft the spec", "Define success criteria", "Get spec sign-off"]
    },
    {
      "key": "build",
      "name": "Build",
      "description": "Ship the first deliverable against the spec.",
      "goal": "Produce a working first build and link it to the company.",
      "grants": [{ "kind": "tool", "id": "gdrive" }],
      "expectedOutputs": [{ "kind": "document", "label": "First build deliverable" }],
      "suggestedTasks": ["Build the first deliverable", "Link it to the company", "Hand off for review"]
    }
  ]
}
```

## How a run flows

1. Operator (or an automation via `flowAutomationId`) starts the playbook with `companyName` = a specific company. The `focus_session` opens with `currentStage = "scope"`.
2. The agent works the **scope** stage, producing the problem-statement note. When done, `synap_update_session({ currentStage: "abstract" })` advances it — emitting `focus_session.stage_changed` (new stage `abstract`).
3. An automation could trigger on `focus_session.stage_changed.*` filtered to `build` to post "X has reached the build stage" in the team channel.
4. When the build deliverable lands and is linked, `synap_complete_session` closes the session.

Note on `grants`: declare them on **stages**, not at the playbook level — top-level playbook `grants` are dropped during materialization. Stage `grants` are **advisory** (surfaced to the agent in the stage kickoff prompt, not resolved into enforcement rows — see the SKILL.md grants section). Keep the surface tight — only point at `gdrive` in the build stage where it is actually used, so the agent knows that is the stage's tool.
