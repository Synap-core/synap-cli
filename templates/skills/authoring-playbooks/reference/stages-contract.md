# PlaybookStage — the stages contract

Stages are the first-class, ordered process steps of a playbook. They replaced the old "progress percentage only" model. A subject moving through a playbook is in **exactly one stage at a time**.

## Schema

```ts
type PlaybookStage = {
  key: string;                       // stable identifier; what currentStage holds. Required.
  name: string;                      // human label. Required.
  category: PlaybookStageCategory;   // closed rollup bucket. REQUIRED — see below.
  description?: string;              // what this stage is about
  goal?: string;                     // the concrete objective of this stage
  grants?: CapabilityRef[];          // advisory capability hints ({ kind: tool|skill|command, id }) — see note below
  expectedOutputs?: ExpectedOutput[];// deliverables expected before advancing ({ kind, label }; kind loosely typed)
  suggestedTasks?: string[];         // soft checklist the agent can turn into tasks
  position?: number;                 // order WITHIN this stage's category group — not a global order
  indefinite?: boolean;              // may a subject sit here forever? absent/false ⇒ a long dwell is worth surfacing
};

type PlaybookStageCategory =
  | "backlog"    // not committed
  | "planned"    // committed, not begun
  | "started"    // work under way
  | "paused"     // on hold
  | "completed"  // terminal, succeeded
  | "canceled";  // terminal, abandoned
```

- `category` is **required and validated** — a write with a stage missing it, or carrying a value outside the six, is REJECTED at the door. `key`/`name` are your playbook's own vocabulary; `category` is the shared axis every playbook rolls up onto, so a board spanning several playbooks can group them without reconciling names (two playbooks' key sets are disjoint by construction). Pick the bucket by what the stage MEANS, not by its position: a stage named "Review" is `started` if someone is working it and `paused` if it is waiting on an outsider.
- `key` values must be **unique within one playbook** — `currentStage` stores the bare key, so a duplicate makes the active stage ambiguous. Also rejected at the door.
- `position` orders a stage **within its category group**, not globally. This is why ordering never needs cross-playbook reconciliation.
- `key` is **stable** — `focus_sessions.currentStage` stores it, and `stage_changed` events carry it. Don't rename keys on a live playbook; add/deprecate instead.
- Stages are **ordered** by their position in the `stages[]` array.
- `grants` here are **advisory**: stored as opaque JSON and surfaced to the agent in the stage's kickoff prompt via `RunContext`, but NOT resolved into enforcement `capability` / `link` rows (hard enforcement is a documented follow-up). "Granting" a skill at a stage = telling the agent to use it there; the skill is already reachable via the pod skill catalog + `load_skill` regardless. Declare grants on stages, not at the playbook level — top-level playbook `grants` are dropped during materialization.

## Runtime semantics

- A `focus_session` starts with `currentStage` = the first stage's `key`.
- Calling `synap_update_session` with a new `currentStage` advances (or moves back) the subject.
- **Every change to `currentStage` emits a `focus_session.stage_changed` event.** Automations can subscribe with an event trigger on `focus_session.stage_changed.*` (optionally filtered by the new stage key) — this is how "when a deal reaches negotiation, notify the team" is wired.
- **Empty `stages` array = legacy behavior**: the session tracks only a 0→100% `progress` value and emits no stage events.

## Design rules

- Assign `category` honestly. Most working stages are `started`; reserve `paused` for genuinely blocked-on-someone-else, and use `completed`/`canceled` only for terminal stages. Marking every stage `started` makes a cross-playbook board useless.
- Keep stages **few and meaningful** (3–6 is typical). Each stage should represent a real change in what the agent is doing or waiting on.
- Give every stage a `goal` and at least one `expectedOutput` so "done with this stage" is observable.
- Use `suggestedTasks` for the soft checklist; use `expectedOutputs` for the hard deliverables that gate advancement. For `expectedOutputs[].kind`, keep to the shared (loosely typed) vocab `note` | `document` | `report`.
- Stage `grants` point the agent at the right capability per stage — name the LinkedIn tool in the "outreach" stage, not the "scope" stage. Remember they are advisory hints, not an access gate.
