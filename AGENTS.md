<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Agent Instructions

## Project Overview

NVIDIA NemoClaw is an open-source reference stack for running always-on AI agents such as [OpenClaw](https://openclaw.ai) and [Hermes](https://get-hermes.ai/) inside [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) sandboxes more safely. It provides CLI tooling, a blueprint for sandbox orchestration, and security hardening.

Status: Active development. Interfaces may change without notice.

## Product Scope Gate

Technical correctness, passing tests, and green CI do not establish product approval.
Before implementing or approving a change that creates a supported integration, solution recipe, custom image, third-party stack, or other product surface, confirm that an accepted issue or design decision establishes the scope and that ownership, lifecycle, compatibility, security, and validation expectations are defined.
The recorded decision must be `Accept` before implementation begins. The record must state the reason, placement, accountable maintainer, and validation plan. `Request changes`, `Defer`, and `Decline` do not authorize implementation. Small documentation corrections and low-risk fixes do not require this decision.
If the product decision is missing, do not approve or document the contribution as canonical NemoClaw behavior.
Stop and request maintainer direction, or route an independent solution through [Community Solutions](docs/resources/community-contributions.mdx).

## Agent Skills

This repo ships agent skills under `.agents/skills/`.
Use `nemoclaw-user-guide` for end-user documentation routing, `nemoclaw-contributor-*` for contributor workflows, and `nemoclaw-maintainer-*` for maintainer workflows.
The contributor lifecycle has one owner for each stage: `nemoclaw-contributor-onboard` for checkout setup, `nemoclaw-contributor-plan-issue` for planning, `nemoclaw-contributor-implement-issue` for implementation and its tests, and `nemoclaw-contributor-create-pr` for publication and review follow-up.
Component-specific guidance belongs in the `AGENTS.md` file of the package it describes, not in a skill.
Use `nemoclaw-skills-guide` only when choosing a skill or browsing the catalog. Go directly to a known skill.
Load supporting references only when their described condition applies; do not preload a lifecycle stack.
When editing a skill, keep its description short and specific to the task that needs it. Put conditional
procedures in references and keep completion criteria in the entrypoint. Preserve concrete security,
publication, and release constraints; avoid generic checklists and fixed report formats without a consumer.
Skills that write or review explanatory text must follow the shared [Documentation Writing and Review](.agents/skills/_shared/documentation-writing-review.md) contract.
Keep repository skill workflows agent-harness agnostic. State required capabilities, actions, and observable results instead of requiring harness-specific tool names. A skill may name a client or command when that client or command is the user-visible subject. Harness-specific automation may assist with a workflow, but it does not define or replace the skill's requirements.

## Development guidance

For source, test, build-tooling, or hook changes, read the applicable sections of the
[development reference](.agents/references/development.md). It owns the architecture map, language
conventions, test lanes, and hook behavior. For messaging changes, also use
[`src/lib/messaging/AGENTS.md`](src/lib/messaging/AGENTS.md).

## Quick Reference

| Task | Command or guidance |
|---|---|
| Set up or diagnose a contributor checkout | `npm run dev:setup` / `npm run dev:doctor` |
| Validate changed behavior | `npm run test:changed`; placement and evidence in `test/README.md` |
| Validate a committed PR diff | `npm run validate:pr`; follow `CONTRIBUTING.md` for when it is needed |
| Build documentation | `npm run docs`; use [documentation validation](docs/CONTRIBUTING.md#validate-the-change) for additional checks that apply to the change |
| Find component builds, test lanes, and hook commands | [Development reference](.agents/references/development.md#quick-reference) and `package.json` |

## Working with This Repo

### Scope and completion

Follow the user's requested outcome and existing authorization. Repository skills supply task
knowledge and operational constraints; they must not add unrequested work or require the user to
repeat an authorization. A specific confirmation bound to an irreversible action still applies.
When an instruction requires a pause, name the file, quote the requirement, and explain the missing
decision. Continue independent authorized work while that decision is pending.

Use `CONTRIBUTING.md` for contribution requirements and the nearest guidance for changed paths.
Use `nemoclaw-contributor-onboard` when setup or repair is needed. Read the smallest sufficient source
set. Ask only when a missing choice changes the required outcome or constraints.

Complete implementation, inspection, and applicable validation for the requested change. Fix failures
caused by that change and rerun affected checks without asking at each step. Continue into PR
publication and review follow-up when requested. A first patch or lifecycle handoff is not completion.
Keep local verification within the test's documented effects; live E2E and external writes retain
their own authorization boundaries. Use `./scripts/dev-setup.sh --expose-cli` only with explicit approval.

### E2E Selection and Authoring

When adding or extending E2E tests, read the [E2E authoring reference](.agents/references/e2e-authoring.md).
It owns behavior selection, coverage granularity, and bounded retry requirements. Use
`nemoclaw-maintainer-e2e` for execution or evidence inspection.

### Plain Language

Follow [WRITING.md](WRITING.md) for all agent-written text.

### Direct Design

Add mechanisms only for a current requirement and consumer, with validation appropriate to the changed behavior. Complete the smallest requested outcome and report its evidence.

### Git and GitHub Access Failures

Follow `.agents/skills/_shared/git-github-hard-stop.md`, which owns access failures and mechanical Git recovery.

### Pull Request Follow-Up

Follow `.agents/skills/_shared/pr-follow-up.md`.

### Common Patterns

**Adding a CLI command:**

- Entry point: `bin/nemoclaw.js` (launches the compiled CLI in `dist/`)
- Main CLI implementation lives in `src/lib/` and compiles to `dist/lib/`
- Add tests in `test/`

**Adding a plugin feature:**

- Source: `nemoclaw/src/`
- Co-locate tests as `*.test.ts`
- Build with `cd nemoclaw && npm run build`

**Adding a network policy preset:**

- Add YAML to `nemoclaw-blueprint/policies/presets/`
- Follow existing preset structure (see `github.yaml`, `brave.yaml`)

**Adding model-specific sandbox compatibility:**

- Add a declarative manifest under `nemoclaw-blueprint/model-specific-setup/<agent>/`
- Use one `agent` per manifest (`openclaw`, `hermes`, etc.); do not make shared multi-agent manifests
- Put OpenClaw executable wrappers under `nemoclaw-blueprint/openclaw-plugins/`
- Put Hermes executable wrappers under `agents/hermes/`
- Keep `agents/hermes/generate-config.ts` as a thin build-time entrypoint; add Hermes env parsing, config construction, registry handling, and serialization under `agents/hermes/config/`
- Do not add Hermes behavior for an OpenClaw issue without a Hermes-specific repro or acceptance test

### Blueprint Image Pins

When the managed sandbox image changes, update `digest` and `components.sandbox.image` in
`nemoclaw-blueprint/blueprint.yaml` with the same immutable SHA-256 digest. Release tooling must
update both fields together. `test/onboarding/validate-blueprint.test.ts` rejects mutable tags and
mismatched digests.

### Gotchas

- `npm install` at root triggers `prek install` which sets up git hooks. If hooks fail, check that `core.hooksPath` is unset: `git config --unset core.hooksPath`
- The `nemoclaw/` subdirectory has its own `package.json` and `node_modules`.
  It is a separate npm project that shares the root Oxlint and Oxfmt configuration files.
- Coverage thresholds are ratcheted in `ci/coverage-threshold-*.json` — new code should not decrease CLI or plugin coverage
- The `.claude/skills` symlink points to `.agents/skills` — both paths resolve to the same content

## Documentation

- Treat `docs/` as the source of truth for public-facing documentation. Follow the [Documentation Agent Guide](docs/AGENTS.md) for the documentation-agent workflow, including DORI routing.
- Ordinary code PRs may defer only `docs/**`, `fern/docs.yml`, and `fern/assets/**` changes to `Docs / Author Post-Merge Catch-Up`.
  Keep all other owning repository guidance in the same PR, including active `AGENTS.md` files, `.agents/skills/**`, and `test/e2e/**/README.md`.
- Direct documentation-only changes follow `docs/AGENTS.md`, the shared [Documentation Writing and Review](.agents/skills/_shared/documentation-writing-review.md) contract, documented validation, and independent review.

## PR Requirements

Follow `nemoclaw-contributor-create-pr` for publication.

- PRs that change `scripts/prepare-dgx-station-host.sh` must include reviewable DGX Station test evidence identifying the tested commit, Station profile or scenario, result, and a supporting link. Any maintainer may review the evidence; without acceptable evidence, the PR is not ready to approve or merge. Treat the evidence as human-reviewed, not authenticated hardware provenance. Exceptional bypasses use existing repository governance and must document the reason on the PR.
- No secrets, API keys, or credentials committed
- Check `.github/pr-limits.json` for the contributor's open PR limit.
