// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getExpectedState, probesForState } from "./expected-states.ts";
import { loadManifest } from "./manifests.ts";
import { requireScenarios } from "./registry.ts";
import type {
  AssertionGroup,
  ExpectedFailureContract,
  ExpectedFailurePhase,
  NemoClawInstanceManifest,
  PhaseAction,
  PhaseName,
  RunPlan,
  ScenarioDefinition,
  SutBoundary,
} from "./types.ts";

// Phase order. state-validation runs after onboarding and before
// runtime so gateway/sandbox/cli probes gate suite execution: a
// failed probe is a failed phase action, and the existing runner
// short-circuit reports runtime as skipped without re-running
// suite assertions against a missing/wedged environment.
const PHASES: PhaseName[] = [
  "environment",
  "onboarding",
  "state-validation",
  "lifecycle",
  "runtime",
];
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function groupsForPhase(scenario: ScenarioDefinition, phase: PhaseName): AssertionGroup[] {
  return scenario.assertionGroups.filter((group) => group.phase === phase);
}

function resolveScenarioInputs(inputs: Array<string | ScenarioDefinition>): ScenarioDefinition[] {
  const ids = inputs.filter((input): input is string => typeof input === "string");
  const resolvedById = requireScenarios(ids);
  let idCursor = 0;
  return inputs.map((input) => (typeof input === "string" ? resolvedById[idCursor++] : input));
}

function expectedPlatform(platformId: string): { os: string; executionTarget: string } | undefined {
  const mapping: Record<string, { os: string; executionTarget: string }> = {
    "ubuntu-local": { os: "ubuntu", executionTarget: "local" },
    "gpu-runner": { os: "ubuntu", executionTarget: "local" },
    "macos-local": { os: "macos", executionTarget: "local" },
    "wsl-local": { os: "wsl", executionTarget: "local" },
    "brev-launchable": { os: "ubuntu", executionTarget: "remote" },
  };
  return mapping[platformId];
}

function expectedRuntime(
  runtimeId: string,
): { containerEngine: string; containerDaemon: string } | undefined {
  const mapping: Record<string, { containerEngine: string; containerDaemon: string }> = {
    "docker-running": { containerEngine: "docker", containerDaemon: "running" },
    "gpu-docker-cdi": { containerEngine: "docker", containerDaemon: "running" },
    "macos-docker-optional": { containerEngine: "docker", containerDaemon: "optional" },
    "docker-missing": { containerEngine: "docker", containerDaemon: "missing" },
  };
  return mapping[runtimeId];
}

function validateManifestCompatibility(
  scenario: ScenarioDefinition,
  manifest?: NemoClawInstanceManifest,
) {
  if (!manifest || !scenario.environment) {
    return;
  }
  const platform = expectedPlatform(scenario.environment.platform);
  if (platform) {
    const actual = manifest.spec.setup.platform;
    if (actual.os !== platform.os || actual.executionTarget !== platform.executionTarget) {
      throw new Error(
        `Scenario ${scenario.id} incompatible with manifest platform: expected ${platform.os}/${platform.executionTarget}, got ${actual.os}/${actual.executionTarget}`,
      );
    }
  }
  const runtime = expectedRuntime(scenario.environment.runtime);
  if (runtime) {
    const actual = manifest.spec.setup.runtime;
    if (
      actual.containerEngine !== runtime.containerEngine ||
      actual.containerDaemon !== runtime.containerDaemon
    ) {
      throw new Error(
        `Scenario ${scenario.id} incompatible with manifest runtime: expected ${runtime.containerEngine}/${runtime.containerDaemon}, got ${actual.containerEngine}/${actual.containerDaemon}`,
      );
    }
  }
}

// Centralized paths to the existing shell helpers. Spec rule: shell
// scripts can remain as implementations, but invocation goes through
// typed assertion/action definitions, not bare workflow YAML or a
// resurrected bash runner.
const INSTALL_DISPATCH = "test/e2e-scenario/nemoclaw_scenarios/install/dispatch.sh";
const ONBOARD_DISPATCH = "test/e2e-scenario/nemoclaw_scenarios/onboard/dispatch.sh";
const PROBES_DISPATCH = "test/e2e-scenario/nemoclaw_scenarios/probes/dispatch.sh";
const LIFECYCLE_DISPATCH = "test/e2e-scenario/nemoclaw_scenarios/lifecycle/dispatch.sh";

// Default action timeouts. Install and onboarding can take a while on
// cold runners (Docker pulls, image builds, sandbox bootstrap).
const INSTALL_TIMEOUT_SECONDS = 900;
const ONBOARD_TIMEOUT_SECONDS = 900;
// Lifecycle actions wrap state-mutation flows like `nemoclaw rebuild`,
// which can take longer than onboarding when an image rebuild is
// involved (workspace snapshot + recreate + verify).
const LIFECYCLE_TIMEOUT_SECONDS = 900;
// State-validation probes are cheap (`command -v`, single curl,
// `nemoclaw list`); a tight timeout keeps a wedged probe from
// consuming runner budget.
const PROBE_TIMEOUT_SECONDS = 30;

// Declared parent-env secrets each onboarding profile actually needs.
// Anything not listed here (and not in the framework allowlist) is
// dropped before spawn by buildChildEnv. Keep this list minimal —
// every entry widens the secret blast radius if the child or one of
// its descendants logs unredacted output.
const ONBOARD_PROFILE_SECRET_ENV: Readonly<Record<string, readonly string[]>> = {
  // Cloud profiles invoke `nemoclaw onboard` which authenticates to the
  // NVIDIA cloud provider via NVIDIA_API_KEY.
  "cloud-openclaw": ["NVIDIA_API_KEY"],
  "cloud-openclaw-custom-policies": ["NVIDIA_API_KEY"],
  "cloud-openclaw-invalid-nvidia-key": ["NVIDIA_API_KEY"],
  "cloud-openclaw-gateway-port-conflict": ["NVIDIA_API_KEY"],
  // Negative scenario: nemoclaw onboard runs against a docker shim that
  // exits non-zero. Onboard never reaches the cloud auth step, but the
  // CLI still loads NVIDIA_API_KEY when present — keep it in the secret
  // env so behavior matches a real user invocation.
  "cloud-openclaw-no-docker": ["NVIDIA_API_KEY"],
  "cloud-hermes": ["NVIDIA_API_KEY"],
  "cloud-hermes-discord": ["NVIDIA_API_KEY"],
  "cloud-hermes-slack": ["NVIDIA_API_KEY"],
  // Local profiles do not need any cloud secret.
  "local-ollama-openclaw": [],
};

function phaseActions(phase: PhaseName, scenario: ScenarioDefinition): PhaseAction[] {
  if (phase === "environment") {
    if (!scenario.environment) {
      // Scenarios without any environment dimension (skeleton scenarios)
      // legitimately have no actions yet. Don't fail-fast here.
      return [];
    }
    const installId = scenario.environment.install;
    if (!installId) {
      // Environment is declared but install is missing - that IS a
      // malformed scenario; fail fast so the caller sees a clear error
      // rather than a phase that silently no-ops setup work.
      throw new Error(`Scenario ${scenario.id} is missing environment.install`);
    }
    return [
      {
        id: `environment.install.${installId}`,
        phase: "environment",
        description: `Run e2e_install ${installId} to set up the host control plane.`,
        kind: "shell-fn",
        scriptRef: INSTALL_DISPATCH,
        fn: "e2e_install",
        arg: installId,
        timeoutSeconds: INSTALL_TIMEOUT_SECONDS,
        evidencePath: `.e2e/actions/environment.install.${installId}.log`,
      },
    ];
  }
  if (phase === "onboarding") {
    if (!scenario.environment) {
      return [];
    }
    const baseOnboardingId = scenario.environment.onboarding;
    if (!baseOnboardingId) {
      throw new Error(`Scenario ${scenario.id} is missing environment.onboarding`);
    }
    // Negative-runtime scenarios route to a dedicated onboarding profile
    // that sets up the failure condition (e.g. docker-missing) BEFORE
    // invoking `nemoclaw onboard` and captures the resulting output to
    // the log file the assertion phase reads. The profile id convention
    // is `<base>-no-docker`. New negative profiles register a worker in
    // nemoclaw_scenarios/onboard/dispatch.sh and a secret-env mapping
    // above.
    const onboardingId =
      scenario.environment.runtime === "docker-missing"
        ? `${baseOnboardingId}-no-docker`
        : baseOnboardingId;
    // secretEnv defaults to [] (no parent-env secrets pass through)
    // unless the profile is explicitly listed above. Unknown profiles
    // get the safest setting and surface the gap loudly the first
    // time they actually need a secret to authenticate.
    const secretEnv = ONBOARD_PROFILE_SECRET_ENV[onboardingId] ?? [];
    return [
      {
        id: `onboarding.profile.${onboardingId}`,
        phase: "onboarding",
        description: `Run e2e_onboard ${onboardingId} to bring the gateway and sandbox online.`,
        kind: "shell-fn",
        scriptRef: ONBOARD_DISPATCH,
        fn: "e2e_onboard",
        arg: onboardingId,
        timeoutSeconds: ONBOARD_TIMEOUT_SECONDS,
        evidencePath: `.e2e/actions/onboarding.profile.${onboardingId}.log`,
        // Legacy preflight assertions look for ${E2E_CONTEXT_DIR}/onboard.log;
        // publish a stable alias so they keep working without rewiring.
        aliasPath: "onboard.log",
        secretEnv,
      },
    ];
  }
  if (phase === "state-validation") {
    // State-validation actions are emitted from the typed expected-state
    // registry, NOT from the legacy expected-states.yaml. The compiler
    // stays a pure function over typed inputs; YAML-vs-typed parity is
    // enforced by a framework test, not by re-reading the YAML at
    // compile time.
    if (!scenario.expectedStateId) {
      // Scenarios without an expected state (older skeleton scenarios)
      // legitimately have no probes; do not fail-fast.
      return [];
    }
    const state = getExpectedState(scenario.expectedStateId);
    if (!state) {
      // The compiler treats an unknown expected_state id as a hard
      // error: typed scenarios must reference a typed state. The
      // legacy YAML resolver has its own validation path; this is a
      // separate (and stricter) contract for the typed runner.
      throw new Error(
        `Scenario ${scenario.id} references unknown expected_state '${scenario.expectedStateId}'`,
      );
    }
    return probesForState(state).map((probeId) => ({
      id: `state-validation.${probeId}`,
      phase: "state-validation",
      description: `Probe ${probeId} from expected_state '${state.id}'.`,
      kind: "shell-fn",
      scriptRef: PROBES_DISPATCH,
      fn: "e2e_state_probe",
      arg: probeId,
      timeoutSeconds: PROBE_TIMEOUT_SECONDS,
      evidencePath: `.e2e/actions/state-validation.${probeId}.log`,
    }));
  }
  if (phase === "lifecycle") {
    // Lifecycle is the post-onboarding state-mutation phase: rebuild,
    // upgrade, snapshot+restore, etc. Scenarios opt in by declaring
    // `environment.lifecycle = <profile-id>`; everything else gets
    // an empty action list and runs no lifecycle assertions. The
    // profile id routes through nemoclaw_scenarios/lifecycle/dispatch.sh
    // to a worker that mutates state and seeds context.env keys
    // (E2E_REBUILD_MARKER_PATH, E2E_REBUILD_MARKER_EXPECTED, ...) the
    // runtime-phase assertions in rebuild_upgrade.sh consume.
    if (!scenario.environment?.lifecycle) {
      return [];
    }
    const lifecycleId = scenario.environment.lifecycle;
    const secretEnv = LIFECYCLE_PROFILE_SECRET_ENV[lifecycleId] ?? [];
    return [
      {
        id: `lifecycle.profile.${lifecycleId}`,
        phase: "lifecycle",
        description: `Run e2e_lifecycle ${lifecycleId} to drive the post-onboard state mutation.`,
        kind: "shell-fn",
        scriptRef: LIFECYCLE_DISPATCH,
        fn: "e2e_lifecycle",
        arg: lifecycleId,
        timeoutSeconds: LIFECYCLE_TIMEOUT_SECONDS,
        evidencePath: `.e2e/actions/lifecycle.profile.${lifecycleId}.log`,
        secretEnv,
      },
    ];
  }
  // Runtime phase has no actions; suites are assertion groups.
  return [];
}

// Declared parent-env secrets each lifecycle profile needs. Mirrors
// ONBOARD_PROFILE_SECRET_ENV: minimal allowlist; widen only when a
// profile actually invokes a CLI that authenticates upstream.
const LIFECYCLE_PROFILE_SECRET_ENV: Readonly<Record<string, readonly string[]>> = {
  // `nemoclaw rebuild` re-reads NVIDIA_API_KEY when the post-rebuild
  // sandbox is brought back up; keep it in the secret env so behavior
  // matches a real user invocation.
  "rebuild-current-version": ["NVIDIA_API_KEY"],
};

const SUT_BOUNDARIES: SutBoundary[] = [
  { id: "host-cli", client: "HostCliClient" },
  { id: "gateway", client: "GatewayClient" },
  { id: "sandbox", client: "SandboxClient" },
  { id: "agent", client: "AgentClient" },
  { id: "provider", client: "ProviderClient" },
  { id: "state", client: "StateClient" },
];

// Negative scenarios advertise their failure mode against one of these
// user-facing phases. "preflight" is intentionally distinct from the
// internal PhaseName union: scenario manifests speak the user's vocab
// ("preflight failed") and the matcher resolves preflight to the
// onboarding phase orchestrator. See orchestrators/negative-matcher.ts.
const EXPECTED_FAILURE_PHASES: readonly ExpectedFailurePhase[] = [
  "environment",
  "onboarding",
  "runtime",
  "preflight",
];

function validateExpectedFailure(scenarioId: string, contract: ExpectedFailureContract): void {
  if (!EXPECTED_FAILURE_PHASES.includes(contract.phase)) {
    throw new Error(
      `Scenario ${scenarioId} expectedFailure.phase invalid: ${String(contract.phase)} (allowed: ${EXPECTED_FAILURE_PHASES.join(", ")})`,
    );
  }
  if (typeof contract.errorClass !== "string" || contract.errorClass.trim().length === 0) {
    throw new Error(`Scenario ${scenarioId} expectedFailure.errorClass must be a non-empty string`);
  }
  if (contract.forbiddenSideEffects !== undefined) {
    if (!Array.isArray(contract.forbiddenSideEffects)) {
      throw new Error(
        `Scenario ${scenarioId} expectedFailure.forbiddenSideEffects must be an array`,
      );
    }
    for (const entry of contract.forbiddenSideEffects) {
      if (typeof entry !== "string" || entry.trim().length === 0) {
        throw new Error(
          `Scenario ${scenarioId} expectedFailure.forbiddenSideEffects entries must be non-empty strings`,
        );
      }
    }
  }
}

export function validateRunPlan(plan: RunPlan): void {
  if (!plan.scenarioId) {
    throw new Error("RunPlan missing scenarioId");
  }
  for (const phase of PHASES) {
    if (!plan.phases.some((entry) => entry.name === phase)) {
      throw new Error(`RunPlan ${plan.scenarioId} missing phase ${phase}`);
    }
  }
  if (plan.sutBoundaries.length === 0) {
    throw new Error(`RunPlan ${plan.scenarioId} missing SUT boundaries`);
  }
  if (plan.expectedFailure) {
    validateExpectedFailure(plan.scenarioId, plan.expectedFailure);
  }
}

export function compileRunPlans(inputs: Array<string | ScenarioDefinition>): RunPlan[] {
  return resolveScenarioInputs(inputs).map((scenario) => {
    const manifest = scenario.manifestPath
      ? loadManifest(path.resolve(REPO_ROOT, scenario.manifestPath)).document
      : undefined;
    validateManifestCompatibility(scenario, manifest);
    const plan: RunPlan = {
      scenarioId: scenario.id,
      status: "compiled",
      note: "compiled plan; phase orchestrators execute actions then assertions",
      manifestPath: scenario.manifestPath,
      manifest,
      environment: scenario.environment,
      expectedStateId: scenario.expectedStateId,
      suiteIds: scenario.suiteIds ?? [],
      onboardingAssertionIds: scenario.onboardingAssertionIds ?? [],
      phases: PHASES.map((phase) => ({
        name: phase,
        actions: phaseActions(phase, scenario),
        assertionGroups: groupsForPhase(scenario, phase),
      })),
      runnerRequirements: scenario.runnerRequirements ?? [],
      requiredSecrets: scenario.requiredSecrets ?? [],
      skippedCapabilities: scenario.skippedCapabilities ?? [],
      expectedFailure: scenario.expectedFailure,
      sutBoundaries: SUT_BOUNDARIES,
    };
    validateRunPlan(plan);
    return plan;
  });
}

export function renderPlanText(plans: RunPlan[]): string {
  const lines = ["Hybrid scenario run plan", ""];
  for (const plan of plans) {
    lines.push(`Scenario: ${plan.scenarioId}`);
    lines.push(`Status: ${plan.status}`);
    lines.push(`Note: ${plan.note ?? ""}`);
    lines.push(`Manifest: ${plan.manifestPath ?? "not-yet-defined"}`);
    if (plan.environment) {
      lines.push(
        `Environment: platform=${plan.environment.platform} install=${plan.environment.install} runtime=${plan.environment.runtime} onboarding=${plan.environment.onboarding}`,
      );
    }
    if (plan.expectedStateId) {
      lines.push(`Expected state: ${plan.expectedStateId}`);
    }
    if (plan.suiteIds.length > 0) {
      lines.push(`Suites: ${plan.suiteIds.join(", ")}`);
    }
    if (plan.requiredSecrets.length > 0) {
      lines.push(`Required secrets: ${plan.requiredSecrets.join(", ")}`);
    }
    if (plan.runnerRequirements.length > 0) {
      lines.push(`Runner requirements: ${plan.runnerRequirements.join(", ")}`);
    }
    if (plan.skippedCapabilities.length > 0) {
      lines.push(
        `Skipped capabilities: ${plan.skippedCapabilities.map((entry) => entry.id ?? "unnamed").join(", ")}`,
      );
    }
    if (plan.expectedFailure) {
      lines.push(`Expected failure: ${JSON.stringify(plan.expectedFailure)}`);
    }
    if (plan.sutBoundaries.length > 0) {
      lines.push(
        `SUT boundaries: ${plan.sutBoundaries.map((boundary) => `${boundary.id}:${boundary.client}`).join(", ")}`,
      );
    }
    if (plan.manifest) {
      const setup = plan.manifest.spec.setup;
      const onboarding = plan.manifest.spec.onboarding;
      lines.push(
        `Setup: install=${setup.install.source ?? "unknown"} runtime=${setup.runtime.containerEngine ?? "unknown"}/${setup.runtime.containerDaemon ?? "unknown"} platform=${setup.platform.os ?? "unknown"}/${setup.platform.executionTarget ?? "unknown"}`,
      );
      lines.push(
        `Onboarding: agent=${onboarding.agent} provider=${onboarding.provider} modelRoute=${onboarding.modelRoute ?? "unknown"}`,
      );
    }
    for (const phase of plan.phases) {
      lines.push(`Phase: ${phase.name}`);
      for (const action of phase.actions) {
        const policy: string[] = [];
        if (action.timeoutSeconds) {
          policy.push(`timeout=${action.timeoutSeconds}s`);
        }
        const target =
          action.kind === "shell-fn"
            ? `${action.fn ?? ""}${action.arg ? ` ${action.arg}` : ""}`.trim()
            : action.scriptRef;
        const policySuffix = policy.length > 0 ? ` (${policy.join(", ")})` : "";
        const targetSuffix = target ? ` -> ${target}` : "";
        lines.push(`  Action: ${action.id}${policySuffix}${targetSuffix}`);
      }
      for (const group of phase.assertionGroups) {
        lines.push(`  Group: ${group.id}`);
        for (const step of group.steps) {
          const policy: string[] = [];
          if (step.reliability?.timeoutSeconds) {
            policy.push(`timeout=${step.reliability.timeoutSeconds}s`);
          }
          if (step.reliability?.retry && step.reliability.retry.attempts > 1) {
            policy.push(
              `retry=${step.reliability.retry.attempts} on ${step.reliability.retry.on.join("+")}`,
            );
          }
          lines.push(`    Step: ${step.id}${policy.length > 0 ? ` (${policy.join(", ")})` : ""}`);
        }
      }
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function writePlanArtifacts(
  plans: RunPlan[],
  contextDir: string,
): { jsonPath: string; summaryPath: string } {
  const outputDir = path.join(contextDir, ".e2e");
  fs.mkdirSync(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, "run-plan.json");
  const summaryPath = path.join(outputDir, "plan.txt");
  fs.writeFileSync(jsonPath, `${JSON.stringify(plans, null, 2)}\n`);
  fs.writeFileSync(summaryPath, renderPlanText(plans));
  return { jsonPath, summaryPath };
}
