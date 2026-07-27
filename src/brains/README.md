# Multi-Brain Orchestration

A distributed AI team inside the extension host. One goal in, a reviewed change
set out. No backend, no database, no network beyond the providers the user
already configured.

## Flow

```
goal ──▶ TaskPlanner ──▶ Scheduler ──▶ BrainRunner ×N ──▶ ConflictResolver
                            │              │                     │
                            │              └── staged writes ────┘
                            ▼                                    ▼
                      ConsensusEngine ◀── Reviewer         StagingWorkspace
                            │                                    │
                            └──────▶ Orchestrator ──▶ user approval ──▶ Executor ──▶ disk
```

Nothing reaches disk until `Executor.apply()`, which runs once, after approval.
A cancelled, failed or rejected run leaves the working tree untouched.

## Modules

| File | Owns |
| --- | --- |
| `types.ts` | Every shape the modules exchange. Nothing else is shared. |
| `defaults.ts` | The built-in team, as data. |
| `registry.ts` | Brain Registry: defaults + installed packs + user overrides. |
| `memory.ts` | Private / shared / session / workspace scopes. |
| `bus.ts` | Conversation Bus — structured messages, and the run transcript. |
| `context.ts` | Context Builder — per-brain slice of the repo, capped. |
| `staging.ts` | Tool policy, write scope, and the staged filesystem. |
| `router.ts` | Provider Router, price table, budget guard, cost ledger. |
| `runner.ts` | One brain, one task, one isolated turn. |
| `planner.ts` | Goal → DAG, plus repair of a model-authored plan. |
| `scheduler.ts` | Concurrency-capped DAG execution. |
| `consensus.ts` | Reviewer scoring and weighted consensus. |
| `conflicts.ts` | Overlapping-edit detection and three-way merge. |
| `executor.ts` | The only code here that writes files. |
| `orchestrator.ts` | Lifecycle and the Decision Engine. |
| `index.ts` | Composition root — the one place that wires the graph. |

There is no brains panel. Team mode is the **Team** toggle beside the model
picker in the chat input, and the roster lives in **Settings → Brains**. Each
task renders as a tool block in the normal assistant message, and the change set
goes through the same inline approval cards a single-agent turn uses — one
approval UI in this extension, not two.

Each takes its collaborators through its constructor and reaches for nothing
global, which is why `orchestration.test.ts` can build the same graph with fakes.

## Isolation

A brain gets a private system prompt, a private tool allow/deny list, a private
write scope, a private slice of the workspace and a private memory view. The tool
schema it is offered is filtered, and dispatch re-checks — a model can call a tool
it was never given.

Write scope comes from `contextRules.include`: the Backend brain edits `server/**`,
the Frontend brain `src/**`, and a write outside scope comes back as a refusal the
model can act on rather than an exception.

## Installing a brain

A brain is a folder, not code. Drop it under `~/.infinity-coder/brains/` and press
**Reload brain packs**.

```
<id>/
  brain.json          required — id, name, role, description, model, provider, weights
  prompt.md           required — the system prompt
  capabilities.json   optional — { tools: {allow, deny}, contextRules, memory }
  settings.json       optional — temperature, maxTokens, priority, costWeight
  icon.svg            optional
```

Anything omitted inherits from the built-in brain sharing the same `role`, so a
two-field `brain.json` plus a prompt is a working brain. Packs are deliberately
data-only: installing one must never be equivalent to running arbitrary code in
the extension host.

## Not built

- **Telemetry.** The spec marked it optional and disabled by default, so it does
  not exist. There is nothing to disable and nothing to audit.
- **Shell for brains.** Every default brain denies `run_command`. An unattended
  brain running shell commands is a blast radius nobody asked for; the user can
  grant it per-brain in the roster.
