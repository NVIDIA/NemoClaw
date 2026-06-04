<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Onboard finite-state machine

This directory contains the transitional onboarding finite-state-machine (FSM) layer. The current implementation records coarse state snapshots and emits machine events while the legacy `src/lib/onboard.ts` entrypoint is split into explicit state handlers.

## Target architecture

The target shape is a machine-driven onboarding runner:

1. Normalize CLI flags, environment, session locking, and consent in `src/lib/onboard.ts`.
2. Build an onboarding context that contains sanitized operator choices, runtime dependencies, and mutable values returned by states.
3. Enter `runOnboardMachine(context)`.
4. Dispatch the current machine state to a handler.
5. Let the handler return an explicit state result such as advance, retry, branch, complete, or failed.
6. Apply the result through `OnboardRuntime`, which validates the transition, updates the persisted session snapshot, and emits redacted machine events.
7. Continue until the machine reaches `complete` or `failed`.

In that final shape, `src/lib/onboard.ts` should be a thin entrypoint. State handlers should own state-specific prompts, resume validation, repair decisions, and side effects.

## State ownership

Machine states are coarse user-visible onboarding phases, not every subprocess or probe inside a phase. The current vocabulary is intentionally limited to major boundaries:

- `init`
- `preflight`
- `gateway`
- `provider_selection`
- `inference`
- `sandbox`
- `openclaw` or `agent_setup`
- `policies`
- `finalizing`
- `post_verify`
- `complete` or `failed`

A state handler may perform many smaller operations, but it should expose only stable, redacted state transitions and context updates to the FSM.

## Session steps versus machine state

The persisted onboarding session still tracks step-level progress for resumability. Step recording is older than the FSM and is currently used as a compatibility bridge.

Long term:

- `OnboardRuntime` should own machine transitions and machine revision increments.
- Session step helpers should record only step status (`pending`, `in_progress`, `complete`, `failed`, `skipped`).
- State handlers should return explicit results instead of implicitly moving the machine by calling step helpers.

Until that migration completes, step helpers may still infer machine snapshots for compatibility with older sessions and tests.

## Handler contract

Each state handler should eventually follow this shape:

```ts
type OnboardStateHandler = (context: OnboardContext) => Promise<OnboardStateResult>;
```

A handler should:

- validate whether the state can be resumed or skipped;
- run state-local repairs before declaring a cached step reusable;
- perform the phase side effects;
- return the next state explicitly;
- keep secrets out of returned metadata and event context.

A handler should not:

- mutate the machine snapshot directly;
- jump to states outside the declared transition graph;
- rely on console output as the only observable diagnostic;
- store raw credentials, provider URLs with secrets, or other sensitive values in machine context.

## Runtime responsibilities

`OnboardRuntime` is the intended authority for:

- validating transitions against `transitions.ts`;
- applying safe session context updates;
- marking terminal states;
- emitting redacted lifecycle, state, repair, resume-conflict, and hook events;
- preserving compatibility with normalized older sessions.

The runtime should reject invalid transitions before they can be persisted.

## Event semantics

Machine events are diagnostics and automation hooks. They must be safe to write to JSONL logs and attach to CI/E2E artifacts.

Event payloads should include only stable, redacted context such as:

- selected agent;
- sandbox name;
- provider and model names;
- endpoint origin, not full secret-bearing URLs;
- credential environment variable name, not credential value;
- policy presets and messaging channel names.

Observers and hooks must not change onboarding behavior. A failing hook should emit hook failure diagnostics and let onboarding continue.

## Migration stages

The FSM migration is considered complete when:

1. state metadata is defined once and derived by session, event, progress, and transition code;
2. live onboarding emits `onboard.started`, `onboard.resumed`, `resume.conflict`, terminal, state, skip, repair, and context events consistently;
3. handlers return explicit state results;
4. the runner applies all handler results through `OnboardRuntime`;
5. step helpers no longer implicitly own machine transitions;
6. `src/lib/onboard.ts` contains entrypoint setup and dependency wiring rather than state sequencing.
