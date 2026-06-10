// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type PhaseName = "environment" | "onboarding" | "state-validation" | "lifecycle" | "runtime";

// Synthetic phase appended by the scenario runner when a scenario
// declares plan.expectedFailure. Distinct from PhaseName so a scenario
// builder cannot accidentally declare an assertion or action against
// it. Only the runner emits PhaseResult entries with this name.
export type NegativeContractPhase = "negative-contract";

export type PhaseResultName = PhaseName | NegativeContractPhase;

// Concrete probe ids the state-validation orchestrator emits as phase
// actions. Each id maps to a probe script under
// nemoclaw_scenarios/probes/. Inference and credentials probes are
// declared but not yet implemented; the compiler skips emitting actions
// for them until the probe scripts land.
//
// `local-registry-entry-present` and `docker-sandbox-container-present`
// are host-side aspects of the sandbox: the local NemoClaw registry
// (`~/.nemoclaw/sandboxes.json`) and the Docker container labeled with
// `openshell.ai/sandbox-name=<name>` (running OR stopped, including
// `*-nemoclaw-gpu-backup-*` siblings). These probes let scenarios
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

// User-facing phase the negative-scenario contract advertises. Wider
// than PhaseName because manifests may declare "preflight" failures,
// which the matcher resolves to the onboarding phase orchestrator.
// state-validation is intentionally omitted: it is an internal phase
// the framework inserts after onboarding; scenarios cannot declare
// expected failures against it (those are expressed via
// expectedStateId + the absent/forbidden-side-effect probes).
export type ExpectedFailurePhase = "environment" | "onboarding" | "runtime" | "preflight";

export interface ExpectedFailureContract {
  phase: ExpectedFailurePhase;
  errorClass: string;
  forbiddenSideEffects?: readonly string[];
}

// Expected-state contract. Mirrors the structural shape of
// nemoclaw_scenarios/expected-states.yaml so the typed registry can
// remain a verifiable mirror of the legacy YAML during transition.
// Each dimension's `expected` field declares whether that aspect of
// the post-setup environment should be present, absent, or optional.
// Optional dimensions emit no probe actions; present/absent dimensions
// emit a real probe that gates the runtime phase.
//
// Spec ownership: the typed registry (scenarios/expected-states.ts) is
// the source of truth for the TS runner; expected-states.yaml stays
// alongside until the legacy resolver is fully retired, with a contract
// test that the typed registry mirrors the YAML.
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
  // Host-side registry entry for the scenario's sandbox name.
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
  // Declared parent-env keys this step requires beyond the framework's
  // allowlist. Anything not allowlisted and not declared here is
  // dropped before spawn. See orchestrators/redaction.ts. Each entry
  // must match the secret-key shape; the framework rejects non-secret
  // names to keep the allowlist-vs-declared-secret boundary honest.
  secretEnv?: readonly string[];
  // When true, a probe/pending step that resolves as "skipped" is
  // reclassified as "failed" by the phase orchestrator. Required
  // steps fail closed when their underlying implementation isn't
  // available yet (probe registry not landed, expected-failure
  // side-effect validator not implemented, ...) instead of silently
  // producing fake green. Defaults to false; set true for security-
  // sensitive suites and expected-failure validators that the run
  // is not safe without.
  required?: boolean;
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
  // Optional lifecycle profile id. When set, the compiler emits a
  // dedicated `lifecycle` phase action between state-validation and
  // runtime. The action is implemented by a worker under
  // nemoclaw_scenarios/lifecycle/, dispatched by
  // nemoclaw_scenarios/lifecycle/dispatch.sh, and routes by profile
  // id (e.g. "rebuild-current-version"). Scenarios that don't need a
  // post-onboard state mutation simply omit this field; their
  // lifecycle phase emits no actions and runs no assertions.
  lifecycle?: string;
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
  expectedFailure?: ExpectedFailureContract;
}

// A phase action is real, deterministic setup work the phase orchestrator
// performs BEFORE running its assertions: install nemoclaw, run
// onboarding, emit context.env, etc. Actions short-circuit assertions on
// failure (assertions don't run if the action they depend on failed).
//
// Spec ownership: phase orchestrators own actions. The top-level runner
// must not execute actions; clients must not embed action policy.
export interface PhaseAction {
  id: string;
  phase: PhaseName;
  description?: string;
  // "shell-fn" sources the bash dispatcher and invokes the named function.
  // "shell"    runs an executable script (used for context-emit helper).
  kind: "shell-fn" | "shell";
  // Repo-relative path to the script.
  scriptRef: string;
  // For "shell-fn": the bash function to invoke after sourcing scriptRef.
  fn?: string;
  // Single positional arg passed to the function/script (install method or
  // onboarding profile id today). Kept as a single string to keep stable
  // ids predictable; multi-arg variants can extend this later.
  arg?: string;
  // Per-action timeout. No retry by default - install/onboard must fail
  // loudly so the regression is visible. Retry stays a property of
  // assertion steps, not actions.
  timeoutSeconds?: number;
  // Repo-relative evidence log path.
  evidencePath?: string;
  // Optional stable alias the orchestrator copies the evidence log to
  // after a successful action. Lets legacy shell assertions that
  // reference well-known filenames (e.g. ${E2E_CONTEXT_DIR}/onboard.log)
  // keep working without coupling them to the action's stable id.
  aliasPath?: string;
  // Declared parent-env keys this action requires beyond the
  // framework's allowlist (PATH, HOME, E2E_*, NEMOCLAW_*, ...).
  // Anything not allowlisted and not declared here is dropped before
  // spawn. See orchestrators/redaction.ts. Each entry must match the
  // secret-key shape; the framework rejects non-secret names so the
  // allowlist-vs-declared-secret boundary stays honest. Cloud install
  // declares ["NVIDIA_API_KEY"]; slack onboarding declares the slack
  // tokens it actually needs; etc.
  secretEnv?: readonly string[];
}

export interface RunPlanPhase {
  name: PhaseName;
  actions: PhaseAction[];
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
  expectedFailure?: ExpectedFailureContract;
  sutBoundaries: SutBoundary[];
}

export interface RunContext {
  contextDir: string;
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

export interface PhaseActionResult {
  id: string;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  evidence?: string;
  message?: string;
}

export interface PhaseResult {
  phase: PhaseResultName;
  status: "passed" | "failed" | "skipped";
  // Action results are recorded distinctly from assertion results so
  // failure-layer attribution stays unambiguous: a failure in actions
  // means setup never completed; assertions did not have a fair chance.
  actions: PhaseActionResult[];
  assertions: AssertionResult[];
}
