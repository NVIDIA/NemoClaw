// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { E2eExecutionMetadata } from "../../../tools/e2e/execution-coverage.mts";
import type { E2eGatewayRuntimeSupport } from "../../../tools/e2e/gateway-runtime.mts";

// Concrete probe ids the Vitest state-validation phase fixture can execute.
// Inference and credentials remain part of ExpectedState metadata but do not
// emit probe ids until typed fixture helpers cover those dimensions.
//
// `local-registry-entry-present` and `docker-sandbox-container-present`
// are host-side aspects of the sandbox: the local NemoClaw registry
// (`~/.nemoclaw/sandboxes.json`) and the Docker container labeled with
// `openshell.ai/sandbox-name=<name>` (running OR stopped, including
// `*-nemoclaw-gpu-backup-*` siblings). These probes let targets
// assert preservation invariants that diverge from the live gateway
// view of the sandbox, which is precisely the regression class
// covered by the post-reboot recovery work tracked in #4423.
export type StateProbeId =
  | "cli-installed"
  | "gateway-healthy"
  | "gateway-absent"
  | "sandbox-running"
  | "sandbox-absent"
  | "local-registry-entry-present"
  | "docker-sandbox-container-present";

// User-facing phase the negative-target contract advertises. The onboarding
// fixture resolves "preflight" failures as preflight errors.
// state-validation is intentionally omitted: targets express those
// expectations via expectedStateId + absent/forbidden-side-effect probes.
export type ExpectedFailurePhase = "environment" | "onboarding" | "runtime" | "preflight";

export interface ExpectedFailureContract {
  phase: ExpectedFailurePhase;
  errorClass: string;
  forbiddenSideEffects?: readonly string[];
}

// Expected-state contract owned by targets/expected-states.ts. Each
// dimension's `expected` field declares whether that aspect of the
// post-setup environment should be present, absent, or optional.
// Optional dimensions emit no fixture probes.
export type ExpectedPresence = "present" | "absent" | "optional";
export type ExpectedHealth = "healthy" | "absent" | "optional";
export type ExpectedSandboxStatus = "running" | "absent" | "optional";
export type ExpectedInferenceAvail = "available" | "absent" | "optional";

export interface ExpectedState {
  id: string;
  cli?: { installed?: boolean };
  gateway?: {
    expected: ExpectedPresence;
    health?: ExpectedHealth;
  };
  sandbox?: {
    expected: ExpectedPresence;
    status?: ExpectedSandboxStatus;
    agent?: string;
  };
  inference?: {
    expected: ExpectedInferenceAvail;
    provider?: string;
  };
  credentials?: {
    expected: ExpectedPresence;
  };
  // Host-side registry entry for the target's sandbox name.
  // "present" means `~/.nemoclaw/sandboxes.json` retains the entry,
  // even if the live gateway can no longer see the sandbox. This is
  // orthogonal to `sandbox.expected`: registry preservation is the
  // user-visible regression target for #4423.
  localRegistry?: { expected: ExpectedPresence };
  // Host-side Docker container labeled `openshell.ai/sandbox-name=<name>`.
  // "present" matches running OR stopped containers, including
  // `*-nemoclaw-gpu-backup-*` siblings produced by the GPU patch path.
  // Used to assert that recovery information remains available even
  // when the live OpenShell gateway returns NotFound.
  dockerSandboxContainer?: { expected: ExpectedPresence };
}

export interface TargetEnvironment {
  platform: string;
  install: string;
  runtime: string;
  onboarding: string;
  policyTier?: "balanced" | "open" | "personal";
  // Optional lifecycle profile id. When set to a profile supported by
  // LifecyclePhaseFixture, the live registry test runs that fixture between
  // onboarding and state-validation. Targets that do not need a post-onboard
  // state mutation omit this field.
  lifecycle?: string;
}

export interface TargetDefinition {
  id: string;
  description?: string;
  executionCoverage?: E2eExecutionMetadata;
  environment?: TargetEnvironment;
  expectedStateId?: string;
  runnerRequirements?: string[];
  requiredSecrets?: string[];
  expectedFailure?: ExpectedFailureContract;
  gatewayRuntimes?: E2eGatewayRuntimeSupport;
}
