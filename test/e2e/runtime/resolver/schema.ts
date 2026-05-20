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

export interface SkippedCapability extends AnyRecord {
  id: string;
  reason: string;
  suites?: string[];
}

export interface BaseScenario extends AnyRecord {
  platform: string;
  install: string;
  runtime: string;
  runner_requirements?: string[];
  expected_failure?: AnyRecord;
  skipped_capabilities?: SkippedCapability[];
}

export interface TestPlan extends AnyRecord {
  base: string;
  onboarding: string;
  expected_state: string;
  onboarding_assertions?: string[];
  suites: string[];
  overrides?: AnyRecord;
  runner_requirements?: string[];
  required_secrets?: string[];
  expected_failure?: AnyRecord;
  skipped_capabilities?: SkippedCapability[];
}

export interface SetupScenario {
  alias_for_plan?: string;
  dimensions?: {
    platform: string;
    install: string;
    runtime: string;
    onboarding: string;
  };
  expected_state?: string;
  suites?: string[];
  overrides?: AnyRecord;
  /** Explicit CI/hardware requirements for non-default platforms. */
  runner_requirements?: string[];
  expected_failure?: AnyRecord;
  skipped_capabilities?: SkippedCapability[];
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
  base_scenarios?: Record<string, BaseScenario>;
  onboarding_profiles?: Record<string, OnboardingProfile>;
  test_plans?: Record<string, TestPlan>;
  onboarding_assertions?: Record<string, AnyRecord>;
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
  plan_id?: string;
  legacy_scenario_id?: string;
  base?: ResolvedDimension<BaseScenario>;
  onboarding?: ResolvedDimension<OnboardingProfile>;
  onboarding_assertions?: string[];
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
  required_secrets?: string[];
  expected_failure?: AnyRecord;
}
