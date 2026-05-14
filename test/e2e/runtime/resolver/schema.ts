// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Types for the E2E scenario metadata schema.
 *
 * These mirror the shape of `scenarios.yaml`, `expected-states.yaml`, and
 * `suites.yaml`. The resolver validates unknown references and returns a
 * normalized `ResolvedPlan` suitable for the shell runner and JSON artifact.
 */

export type AnyRecord = Record<string, unknown>;

export interface PlatformProfile extends AnyRecord {
  os?: string;
  execution_target?: string;
}
export type InstallProfile = AnyRecord;
export type RuntimeProfile = AnyRecord;
export interface OnboardingProfile extends AnyRecord {
  path?: string;
  agent?: string;
  provider?: string;
  inference_route?: string;
}

export interface SetupScenario {
  dimensions: {
    platform: string;
    install: string;
    runtime: string;
    onboarding: string;
  };
  expected_state: string;
  suites: string[];
  overrides?: AnyRecord;
  /** Explicit CI/hardware requirements for non-default platforms. */
  runner_requirements?: string[];
  /**
   * Guard: the legacy array form `expected_states: [...]` must not reappear.
   * If present, the loader fails.
   */
  expected_states?: never;
}

export interface ScenariosFile {
  platforms: Record<string, PlatformProfile>;
  installs: Record<string, InstallProfile>;
  runtimes: Record<string, RuntimeProfile>;
  onboarding: Record<string, OnboardingProfile>;
  setup_scenarios: Record<string, SetupScenario>;
}

export type ExpectedStateConfig = AnyRecord;

export interface ExpectedStatesFile {
  expected_states: Record<string, ExpectedStateConfig>;
}

export interface SuiteStep {
  id: string;
  script: string;
}

export interface SuiteDefinition {
  requires_state?: Record<string, unknown>;
  steps: SuiteStep[];
}

export interface SuitesFile {
  suites: Record<string, SuiteDefinition>;
}

export interface ResolvedDimension<T = AnyRecord> {
  id: string;
  profile: T;
}

export interface ResolvedSuite {
  id: string;
  requires_state: Record<string, unknown>;
  steps: SuiteStep[];
}

export interface ResolvedExpectedState {
  id: string;
  config: ExpectedStateConfig;
}

export interface ResolvedPlan {
  scenario_id: string;
  dimensions: {
    platform: ResolvedDimension<PlatformProfile>;
    install: ResolvedDimension<InstallProfile>;
    runtime: ResolvedDimension<RuntimeProfile>;
    onboarding: ResolvedDimension<OnboardingProfile>;
  };
  expected_state: ResolvedExpectedState;
  suites: ResolvedSuite[];
  overrides?: AnyRecord;
  runner_requirements?: string[];
}
