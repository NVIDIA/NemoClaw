// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { E2eExecutionMetadata } from "../../../tools/e2e/execution-coverage.mts";
import type { E2eGatewayRuntimeSupport } from "../../../tools/e2e/gateway-runtime.mts";

export type StateProbeId =
  | "cli-installed"
  | "gateway-healthy"
  | "gateway-absent"
  | "sandbox-running"
  | "sandbox-absent"
  | "local-registry-entry-present"
  | "docker-sandbox-container-present";

type ExpectedPresence = "present" | "absent" | "optional";
type ExpectedHealth = "healthy" | "absent" | "optional";
type ExpectedSandboxStatus = "running" | "absent" | "optional";
type ExpectedInferenceAvailability = "available" | "absent" | "optional";

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
    expected: ExpectedInferenceAvailability;
    provider?: string;
  };
  credentials?: {
    expected: ExpectedPresence;
  };
  localRegistry?: { expected: ExpectedPresence };
  dockerSandboxContainer?: { expected: ExpectedPresence };
}

export interface TargetEnvironment {
  platform: string;
  install: string;
  runtime: string;
  onboarding: string;
  policyTier?: "balanced" | "open" | "personal";
  lifecycle?: string;
}

export interface TargetDefinition {
  id: string;
  description: string;
  executionCoverage: E2eExecutionMetadata;
  environment: TargetEnvironment;
  expectedStateId: string;
  requiredSecrets: string[];
  gatewayRuntimes: E2eGatewayRuntimeSupport;
}
