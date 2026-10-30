---
name: create-verification-skill
description: Generate a project-local skill that drives a NemoClaw surface the way a user does, from launch through evidence and cleanup. Use when a feature has no scripted way for an agent to prove its user-visible behavior.
disable-model-invocation: true
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-FileCopyrightText: Copyright (c) 2026 Lauren Tan -->
<!-- SPDX-License-Identifier: Apache-2.0 AND MIT -->
<!-- Adapted from pstack's create-verification-skill; see ../NOTICE.md. -->

# Create a Verification Skill

This skill generates `.agents/skills/verify-<surface>/`, a scripted way for an agent to drive NemoClaw the way a user does and capture evidence.
Write it for an agent who reads it cold, mid-task.
It complements the [live tests](../../../docs/contributing/live-tests.md), which stay the gate: when a journey must hold on every change, turn it into a Rust live test instead.

## 1. Interview the Repository

Answer from the code and docs; ask the user only what you cannot observe.

- **Surface:** what the user touches, such as the `nemoclaw` CLI (`plan`, `apply`, `export`, `destroy`), onboarding, the SDK, or an agent's interfaces reached through OpenShell.
  Pick one surface per skill and note the rest.
- **Run:** how a verified bundle, images, and a deployment document reach a usable deployment, per [Usage](../../../docs/usage.md) and the matching live-test section.
  Note the gateway port, subnet, images by digest, and the credentials the deployment needs.
- **Drive:** reuse `nemoclaw-e2e` fixtures, the reference dummy image, and existing commands first.
  Only then add a terminal session for a TUI or HTTP requests for a service.
- **Observe:** command output and exit codes, `nemoclaw` state, provider resources, sandbox files through OpenShell, and agent replies.
- **Isolate:** a fresh deployment UID, state directory, gateway port, and subnet per run, as live tests require.
  The skill must refuse to drive a deployment it didn't create.

If the checkout doesn't build or the surface doesn't start, fix that or report it precisely before generating.

## 2. Generate the Skill

Write `.agents/skills/verify-<surface>/SKILL.md` with `name`, a `description` that names the surface and when to use it, `disable-model-invocation: true`, and the SPDX header.
Ground each section in what the interview found, with no placeholders:

- **Launch:** the exact commands from an empty state directory to a usable deployment, how to tell it is ready, and teardown.
  Ready means usable: an agent that answers, not a process that runs.
- **Doctor:** one read-only check that the deployment is the one this run created, at the expected bundle and image digests, and healthy.
  Run it before the first drive and after any surprise.
- **Drive:** real commands and stable handles from this repository, not examples.
- **Evidence:** what proves each journey and where it goes, outside the checkout and the state directory.
  Exercise the user's path, not internal setters or test-only endpoints.
  Capture the action and the resulting state, and check side effects such as files written, resources created, and retained storage.
  Never write credential or token values into evidence.
- **Cleanup:** `nemoclaw destroy --state-dir PATH`, then removal of only the resources labeled with the run's UID; for retained storage, follow [Remove Retained Resources](../../../docs/usage.md#remove-retained-resources).
  Never stop processes or containers by name.
  Cleanup keeps the evidence.
- **Helpers:** prefer commands in the skill body.
  A helper the skill ships is Rust tooling, as `AGENTS.md` requires, and the skill shows how to invoke it.

The skill asks before runs that need credentials, paid services, or GPUs.

## 3. Seed the Feature Map

Create `features/README.md` and one file for each of the top three to five user-facing features.
The README lists baseline preconditions, driving conventions, proof rules, and an index of feature files.
Each feature file starts with a title and one paragraph on the user-visible behavior, then has exactly these sections:

1. `Sub-features`: a short ID and one line for each behavior.
2. `How to get to it (user POV)`: every user entry point.
3. `Driving it with <harness>`: preconditions, then each user action paired with its exact command and observable result.
4. `Gotchas`: traps that waste or invalidate a run.

When a journey's precondition is missing, the journey fails and the reason goes in `Gotchas`; never weaken the journey.
A proof through one entry point doesn't cover the others the map lists.

## 4. Prove It Before Handoff

Follow the generated skill once: launch, doctor, drive one mapped feature, capture evidence, and clean up.
Confirm the evidence still exists after cleanup and that no resource with the run's UID remains.
Run cleanup after every failed attempt too.
If you proved it on a stand-in, such as Docker for Kubernetes, list the steps the real target still needs.

## 5. Hand Off

Point the user to the `maintain-verification-skill` skill for keeping the map current.
