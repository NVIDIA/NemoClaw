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
5. Let the handler return an explicit state result such as advance, retry, branch, pause, complete, or failed.
6. Apply the result through `OnboardRuntime`, which validates the transition, updates the persisted session snapshot, and emits redacted machine events.
7. Continue until the machine reaches `complete` or `failed`, or a handler pauses at a retryable non-terminal state.

In that final shape, `src/lib/onboard.ts` should be a thin entrypoint. State handlers should own state-specific prompts, resume validation, repair decisions, and side effects.

`flow-handoff.ts` validates required data and constructs context at the initial-to-core and core-to-final boundaries. The entrypoint supplies process-bound dependencies and reserved-name output.

The strict runner owns `init`, `preflight`, `provider_selection`, `inference`, and `sandbox` entry. If the durable state is later than a slice entry, earlier phases run as evented prerequisite repairs. A repair must return a legal, update-free transition chain and must not change the durable entry state.

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

The persisted onboarding session tracks step-level progress for resumability.

- `OnboardRuntime` owns normal machine transitions, revision increments, terminal state, and machine events.
- Session step helpers record step-progress bookkeeping and context updates accepted by `filterSafeUpdates`. They cannot change the machine snapshot.
- State handlers return explicit results. They do not move the machine through step helpers.
- Explicit session recovery and the process-exit failure backstop are narrow exceptions.

## Handler contract

Each state handler should eventually follow this shape:

```ts
type OnboardStateHandler = (
  context: OnboardContext,
) => Promise<OnboardStateResult | readonly OnboardStateResult[]>;
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

Handlers may return a result sequence only when one composite handler deliberately owns the
covered state transitions, such as provider selection plus inference retry. Every result in a
sequence must declare its source state in `metadata.state`, and that source must match the
machine's current state when the result is applied. The runner also checks the handler's sequence
ownership allowlist; add a new entry in `DEFAULT_SEQUENCE_OWNERSHIP` before introducing another
composite handler that crosses into a later state. Terminal results (`complete` or `failed`) end
the sequence immediately. A `pause` result persists any supplied safe context and returns control
without a state transition so a later process can resume the same non-terminal state.

## Runtime responsibilities

`OnboardRuntime` is the authority for:

- validating result source, target, kind, and graph transitions;
- applying safe session context updates;
- marking terminal states;
- emitting redacted lifecycle, state, repair, resume-conflict, and hook events;
- normalizing older sessions before strict execution.

Step helpers record step-progress bookkeeping and context updates accepted by `filterSafeUpdates`. They cannot change the machine snapshot or emit machine events. Explicit session recovery and the process-exit failure backstop are separate recovery boundaries. They validate their snapshot changes and run before or outside handler execution.

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

## Characterization traces

`transition-traces.test.ts` in this directory pins fresh, resumed, recreate, and failed path-level event streams that the unit suites (`transitions.test.ts`, `runtime.test.ts`, `runner.test.ts`) do not already cover (#6225). The recreate trace composes the runner with the real sandbox handler seam; detailed selection and repair cases remain in `handlers/sandbox-resume.test.ts` and `handlers/sandbox.test.ts`. Update a pinned trace only in the same PR as an intentional behavior change (for example #6226, #6227, or #6228), never as a side effect. The journey-level lifecycle contract map lives in [`../lifecycle-contracts.md`](../lifecycle-contracts.md).
