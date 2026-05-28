// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type PhaseName = "environment" | "onboarding" | "runtime";

export type TransientClassifier =
  | "empty-event-capture"
  | "provider-transient"
  | "gateway-transient"
  | "external-tunnel"
  | "model-toolcall-transient"
  | "runner-infra"
  | "wrong-installed-ref";

export interface SutBoundary {
  id: "host-cli" | "gateway" | "sandbox" | "agent" | "provider" | "state";
  client: string;
}

export interface NemoClawInstanceManifest {
  apiVersion: "nemoclaw.io/v1";
  kind: "NemoClawInstance";
  metadata: {
    name: string;
  };
  spec: {
    setup: {
      install: Record<string, unknown>;
      runtime: Record<string, unknown>;
      platform: Record<string, unknown>;
    };
    onboarding: {
      agent: string;
      provider: string;
      modelRoute?: string;
      policyTier?: string;
      messaging?: string[];
      features?: Record<string, unknown>;
      lifecycle?: string;
      gateway?: Record<string, unknown>;
    };
    state?: {
      workspaceRef?: string;
      credentialRefs?: string[];
      [key: string]: unknown;
    };
  };
}

export interface AssertionStepReliability {
  timeoutSeconds?: number;
  retry?: {
    attempts: number;
    on: TransientClassifier[];
  };
  productRetry?: string;
}

export interface AssertionStep {
  id: string;
  phase: PhaseName;
  description?: string;
  implementation?: {
    kind: "shell" | "probe" | "pending";
    ref: string;
  };
  evidencePath?: string;
  reliability?: AssertionStepReliability;
}

export interface AssertionGroup {
  id: string;
  phase: PhaseName;
  description?: string;
  suiteId?: string;
  onboardingAssertionId?: string;
  migrationStatus?: "complete" | "pending";
  steps: AssertionStep[];
}

export interface ScenarioEnvironment {
  platform: string;
  install: string;
  runtime: string;
  onboarding: string;
}

export interface ScenarioDefinition {
  id: string;
  description?: string;
  manifestPath?: string;
  environment?: ScenarioEnvironment;
  assertionGroups: AssertionGroup[];
  expectedStateId?: string;
  suiteIds?: string[];
  onboardingAssertionIds?: string[];
  runnerRequirements?: string[];
  requiredSecrets?: string[];
  skippedCapabilities?: Array<Record<string, unknown>>;
  expectedFailure?: Record<string, unknown>;
}

export interface RunPlanPhase {
  name: PhaseName;
  actions: string[];
  assertionGroups: AssertionGroup[];
}

export interface RunPlan {
  scenarioId: string;
  status: "skeleton" | "compiled";
  note?: string;
  manifestPath?: string;
  manifest?: NemoClawInstanceManifest;
  environment?: ScenarioEnvironment;
  expectedStateId?: string;
  suiteIds: string[];
  onboardingAssertionIds: string[];
  phases: RunPlanPhase[];
  runnerRequirements: string[];
  requiredSecrets: string[];
  skippedCapabilities: Array<Record<string, unknown>>;
  expectedFailure?: Record<string, unknown>;
  sutBoundaries: SutBoundary[];
}

export interface RunContext {
  contextDir: string;
  dryRun: boolean;
}

export interface AssertionResult {
  id: string;
  status: "passed" | "failed" | "skipped";
  attempts: number;
  durationMs: number;
  classifier?: TransientClassifier;
  evidence?: string;
  message?: string;
}

export interface PhaseResult {
  phase: PhaseName;
  status: "passed" | "failed" | "skipped";
  assertions: AssertionResult[];
}
