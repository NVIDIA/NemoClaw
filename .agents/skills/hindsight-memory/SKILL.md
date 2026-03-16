---
name: hindsight-memory
description: Give sandboxed agents persistent memory across sessions using Hindsight. Use to recall context before starting work, store learnings after completing tasks, and maintain continuity across ephemeral sandbox sessions. Trigger keywords - remember, recall, retain, memory, context, what did we learn, previous session, store knowledge, hindsight, persistent memory, cross-session context.
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Hindsight Memory

Give sandboxed agents persistent memory across ephemeral sandbox sessions using [Hindsight](https://github.com/vectorize-io/hindsight).

Sandboxes are isolated and disposable. When a sandbox is destroyed, everything the agent learned is lost. Hindsight solves this by providing a structured memory API that agents can call from inside the sandbox to recall past context and store new learnings.

## Overview

Hindsight is an agent memory system that provides long-term memory using biomimetic data structures. Memories are organized as:

- **World facts**: General knowledge ("The project uses ESLint with Airbnb config")
- **Experience facts**: Personal experiences ("Build failed when using Node 18, works with Node 20")
- **Mental models**: Consolidated knowledge synthesized from facts ("User prefers functional programming patterns")

This skill teaches agents when and how to use Hindsight memory from inside a NemoClaw sandbox.

## Prerequisites

- The `hindsight` CLI must be installed in the sandbox image
- The sandbox network policy must allow egress to the Hindsight API (see Network Policy)
- A memory bank must exist (the user provides the bank ID)

## Setup

### Add Hindsight to the Sandbox Network Policy

NemoClaw manages network policies through its blueprint. Add a Hindsight policy block to the sandbox policy file or apply it dynamically after sandbox creation.

**Option A — Edit the baseline policy**

Add the `hindsight_memory` block to `nemoclaw-blueprint/policies/openclaw-sandbox.yaml`, then re-apply:

```console
$ openclaw nemoclaw migrate
```

**Option B — Apply dynamically after launch**

```console
$ openshell policy set --sandbox my-assistant --file hindsight-policy.yaml
```

See `example-policy.yaml` in this skill directory for a ready-to-use policy template.

### Configure Credentials Inside the Sandbox

Connect to the sandbox and set the Hindsight API credentials:

```console
$ nemoclaw my-assistant connect
sandbox@my-assistant:~$ export HINDSIGHT_API_URL=https://api.hindsight.vectorize.io
sandbox@my-assistant:~$ export HINDSIGHT_API_KEY=hs-your-api-key
```

To persist the configuration across sessions:

```console
sandbox@my-assistant:~$ hindsight configure --api-url "$HINDSIGHT_API_URL" --api-key "$HINDSIGHT_API_KEY"
```

If the `hindsight` CLI is not available in the base image, install it:

```console
sandbox@my-assistant:~$ curl -fsSL https://hindsight.vectorize.io/get-cli | bash
```

## Workflow 1 — Recall Before Starting Work

**Always recall relevant context before starting any non-trivial task.** This is the most important workflow. Without it, the agent starts from zero every time.

```console
$ hindsight memory recall <bank-id> "authentication module architecture"
$ hindsight memory recall <bank-id> "issues encountered with database migrations"
$ hindsight memory recall <bank-id> "coding standards and project conventions"
$ hindsight memory recall <bank-id> "Alice preferences for code review"
```

### When to Recall

- Before starting any non-trivial task
- Before making implementation decisions
- When working in an unfamiliar area of the codebase
- When answering questions about the project
- When a previous sandbox session worked on the same topic

### Recall Options

```console
$ hindsight memory recall <bank-id> "query" --budget high
$ hindsight memory recall <bank-id> "query" --max-tokens 4096
$ hindsight memory recall <bank-id> "query" --fact-type world,experience
$ hindsight memory recall <bank-id> "query" -o json
```

## Workflow 2 — Retain After Completing Work

**Store what you learned immediately after discovering it.** Do not wait until the end of the session. Sandboxes can be destroyed at any time.

```console
$ hindsight memory retain <bank-id> "Project uses 2-space indentation with Prettier"
$ hindsight memory retain <bank-id> "Build failed when using Node 18, works with Node 20" --context "learnings from CI pipeline"
$ hindsight memory retain <bank-id> "Running integration tests requires Docker and POSTGRES_URL set" --context "setup procedures"
$ hindsight memory retain <bank-id> "The auth timeout was caused by missing CONNECTION_POOL_SIZE env var, default of 5 was too low" --context "debugging auth timeout"
```

### What to Store

| Category | Examples | Context |
|----------|----------|---------|
| Project conventions | Coding standards, branch naming, PR conventions | `"project conventions"` |
| Procedures | Steps that completed a task, required env vars | `"setup procedures"` |
| Learnings | Bugs and solutions, what worked and what didn't | `"learnings from debugging"` |
| Architecture | Design decisions, component relationships | `"architecture decisions"` |
| Team knowledge | Onboarding info, domain knowledge, pitfalls | `"team knowledge"` |
| Individual preferences | "Alice prefers explicit type annotations" | `"Alice preferences"` |

### Retain Best Practices

1. **Store immediately** — do not batch. The sandbox could be destroyed.
2. **Be specific** — store "npm test requires --experimental-vm-modules flag" not "tests need a flag".
3. **Include outcomes** — store what worked AND what did not work.
4. **Use `--context`** — provide descriptive context to help Hindsight understand the memory's purpose.
5. **Attribute preferences** — store "Alice prefers X" not "user prefers X".

## Workflow 3 — Reflect for Synthesized Answers

Use `reflect` when you need Hindsight to synthesize an answer from multiple memories rather than returning raw recall results.

```console
$ hindsight memory reflect <bank-id> "How should I approach adding a new API endpoint based on past experience?"
$ hindsight memory reflect <bank-id> "What do we know about the payment processing module?"
$ hindsight memory reflect <bank-id> "Summarize all architecture decisions" --budget high
```

## Workflow 4 — Retain Files for Bulk Knowledge

When a sandbox session produces artifacts (logs, reports, investigation notes), retain the files directly:

```console
$ hindsight memory retain-files <bank-id> investigation-notes.txt
$ hindsight memory retain-files <bank-id> ./reports/
$ hindsight memory retain-files <bank-id> debug-log.txt --context "debugging auth timeout issue"
$ hindsight memory retain-files <bank-id> ./large-dataset/ --async
```

## Workflow 5 — Cross-Sandbox Continuity

This is the core value of Hindsight in NemoClaw. When a sandbox is destroyed and a new one is created, the agent can pick up where the previous session left off.

**Previous sandbox session:**

```console
$ hindsight memory retain my-project "The retry logic in api/client.rs has no backoff jitter, causing thundering herd under load" --context "learnings from load testing"
$ hindsight memory retain my-project "Fixed retry backoff in api/client.rs by adding exponential jitter. Still need to add circuit breaker logic." --context "progress on retry backoff fix"
```

**New sandbox session:**

```console
$ hindsight memory recall my-project "retry logic and backoff changes"
```

### Pattern — Session Bookends

Adopt this pattern for every sandbox session:

1. **Session start**: `hindsight memory recall <bank-id> "<topic of current task>"`
2. **During work**: `hindsight memory retain <bank-id> "<learning>" --context "learnings"` (as discoveries happen)
3. **Session end**: `hindsight memory retain <bank-id> "<summary of progress and next steps>" --context "session progress and next steps"`

## Network Policy

The sandbox must have a network policy allowing egress to the Hindsight API. Add this block to `nemoclaw-blueprint/policies/openclaw-sandbox.yaml` or apply it with `openshell policy set`:

```yaml
  hindsight_memory:
    name: hindsight_memory
    endpoints:
      - host: api.hindsight.vectorize.io
        port: 443
        protocol: rest
        enforcement: enforce
        tls: terminate
        rules:
          - allow: { method: GET, path: "/v1/**" }
          - allow: { method: POST, path: "/v1/**" }
    binaries:
      - { path: /usr/local/bin/hindsight }
      - { path: /usr/bin/curl }
```

For self-hosted Hindsight instances on private networks, add `allowed_ips`:

```yaml
  hindsight_memory:
    name: hindsight_memory
    endpoints:
      - host: hindsight.internal.corp
        port: 8888
        protocol: rest
        enforcement: enforce
        rules:
          - allow: { method: GET, path: "/v1/**" }
          - allow: { method: POST, path: "/v1/**" }
        allowed_ips:
          - "10.0.5.0/24"
    binaries:
      - { path: /usr/local/bin/hindsight }
```

See `example-policy.yaml` in this skill directory for a complete standalone policy template.

## Bank Management

Banks are isolated memory stores. Each project or team typically has its own bank.

```console
$ hindsight bank list
$ hindsight bank stats <bank-id>
$ hindsight bank disposition <bank-id>
```

## Companion Skills

| Skill | When to Use |
|-------|-------------|
| `update-docs-from-commits` | Update documentation after adding Hindsight-related features |

## CLI Quick Reference

| Command | Description |
|---------|-------------|
| `hindsight memory retain <bank> "text"` | Store a memory |
| `hindsight memory retain <bank> "text" --context "desc"` | Store with context |
| `hindsight memory retain-files <bank> <path>` | Retain from files |
| `hindsight memory recall <bank> "query"` | Search memories |
| `hindsight memory recall <bank> "query" --budget high` | Thorough search |
| `hindsight memory reflect <bank> "question"` | Synthesized answer |
| `hindsight bank list` | List banks |
| `hindsight bank stats <bank>` | Bank statistics |
| `hindsight configure` | Interactive CLI setup |
