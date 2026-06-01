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

/**
 * Phases where setup is permitted to fail in negative scenarios.
 *
 * Aligned with `nemoclaw` setup stages and the wording in NemoClaw issue
 * #3608. `preflight` is the only phase whose side-effect probes are wired
 * in this initial cut; the rest are accepted by the schema so that future
 * negative scenarios can declare them without churning YAML again.
 */
export const EXPECTED_FAILURE_PHASES = [
  "preflight",
  "install",
  "onboard",
  "readiness",
  "suite",
] as const;
export type ExpectedFailurePhase = (typeof EXPECTED_FAILURE_PHASES)[number];

/**
 * Structured failure reason. Open-ended on purpose - new negative scenarios
 * may need new classes, but every value here MUST be enumerated so reports
 * have a stable vocabulary.
 */
export const EXPECTED_FAILURE_ERROR_CLASSES = [
  "docker-missing",
  "credentials-missing",
  "gpu-missing",
  "unsupported-platform",
] as const;
export type ExpectedFailureErrorClass = (typeof EXPECTED_FAILURE_ERROR_CLASSES)[number];

/**
 * Side effects that a successful setup would normally leave behind. A
 * negative scenario asserts that NONE of the listed effects are observed
 * after the failure.
 */
export const EXPECTED_FAILURE_SIDE_EFFECTS = [
  "sandbox-created",
  "gateway-started",
  "credentials-written",
] as const;
export type ExpectedFailureSideEffect = (typeof EXPECTED_FAILURE_SIDE_EFFECTS)[number];

export interface ExpectedFailure {
  phase: ExpectedFailurePhase;
  error_class: ExpectedFailureErrorClass;
  /** RE2/POSIX-compatible regex matched against the captured setup log. */
  message_pattern?: string;
  /** Effects that must NOT be observed after the failure. */
  forbidden_side_effects?: ExpectedFailureSideEffect[];
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
  expected_failure?: Partial<ExpectedFailure>;
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
  expected_failure?: Partial<ExpectedFailure>;
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
  skipped_capabilities?: SkippedCapability[];
  /**
   * Per-scenario override of the expected-state failure contract. Fields
   * present here win over the state-level `expected_failure`; absent
   * fields fall back to the state. Negative scenarios MUST resolve to a
   * complete `ExpectedFailure` (state + override merged).
   */
  expected_failure?: Partial<ExpectedFailure>;
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
  /**
   * Present only for negative scenarios that declare an `expected_failure`
   * (either at scenario level or via their expected state). Absence means
   * the runner expects setup to succeed.
   */
  expected_failure?: ExpectedFailure;
}
