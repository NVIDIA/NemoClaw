// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { PhaseOrchestrator } from "./phase.ts";

/**
 * Lifecycle phase orchestrator.
 *
 * Sits between state-validation and runtime. Drives post-onboard
 * state mutations (rebuild, upgrade, snapshot+restore, ...) by
 * executing the action(s) the compiler emits when a scenario declares
 * `environment.lifecycle = <profile-id>`. The action's worker (under
 * test/e2e-scenario/nemoclaw_scenarios/lifecycle/) seeds context.env
 * keys (E2E_REBUILD_MARKER_PATH, E2E_REBUILD_MARKER_EXPECTED, ...)
 * which the runtime-phase rebuild_upgrade.sh assertions consume.
 *
 * Scenarios without a lifecycle profile see this phase as a no-op:
 * the compiler emits an empty action list, the orchestrator runs no
 * assertions, and the runtime phase proceeds as before.
 */
export class LifecycleOrchestrator extends PhaseOrchestrator {
  constructor() {
    super("lifecycle");
  }
}
