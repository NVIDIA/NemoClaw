// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { PhaseOrchestrator } from "./phase.ts";

// Typed replacement for the inline gateway/sandbox checks the legacy
// bash runner ran between onboarding and suite execution
// (e2e_gateway_assert_healthy / e2e_sandbox_assert_running) AND the
// post-failure side-effect checks for negative scenarios
// (`openshell sandbox list | grep -Fq ...`). The orchestrator inserts
// itself between onboarding and runtime; its phase actions are real
// probes (typed PhaseAction shell-fn entries the compiler emits from
// scenario.expectedStateId via the typed expected-state registry).
//
// Failure semantics: a probe action failure is just a phase-action
// failure, so the existing ScenarioRunner short-circuit logic kicks
// in and the runtime phase is reported as skipped. No new control
// flow is added; this orchestrator is only here to give the phase a
// dedicated identity in PhaseResult artifacts and in tests.
export class StateValidationOrchestrator extends PhaseOrchestrator {
  constructor() {
    super("state-validation");
  }
}
