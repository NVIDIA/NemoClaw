// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ExpectedState, StateProbeId } from "./types.ts";

// Typed mirror of nemoclaw_scenarios/expected-states.yaml.
//
// During the transition this registry is the source of truth for the
// TS runner. expected-states.yaml stays in place for the legacy bash
// resolver; a framework test verifies the typed registry covers the
// YAML's expected-state ids and matches their structural shape on the
// dimensions the typed runner probes today (cli, gateway, sandbox).
// Inference and credentials remain declared in YAML and in this typed
// registry, but the compiler skips emitting probe actions for them
// until the corresponding probe scripts land — see
// nemoclaw_scenarios/probes/.

const cloudOpenclawReady: ExpectedState = {
  id: "cloud-openclaw-ready",
  cli: { installed: true },
  gateway: { expected: "present", health: "healthy" },
  sandbox: { expected: "present", status: "running", agent: "openclaw" },
  inference: { expected: "available", provider: "nvidia" },
  credentials: { expected: "present" },
};

const cloudOpenclawCustomPoliciesReady: ExpectedState = {
  ...cloudOpenclawReady,
  id: "cloud-openclaw-custom-policies-ready",
};

const cloudHermesReady: ExpectedState = {
  id: "cloud-hermes-ready",
  cli: { installed: true },
  gateway: { expected: "present", health: "healthy" },
  sandbox: { expected: "present", status: "running", agent: "hermes" },
  inference: { expected: "available", provider: "nvidia" },
  credentials: { expected: "present" },
};

const localOllamaOpenclawReady: ExpectedState = {
  id: "local-ollama-openclaw-ready",
  cli: { installed: true },
  gateway: { expected: "present", health: "healthy" },
  sandbox: { expected: "present", status: "running", agent: "openclaw" },
  inference: { expected: "available", provider: "ollama" },
  credentials: { expected: "present" },
};

const macosCliReadyDockerOptional: ExpectedState = {
  id: "macos-cli-ready-docker-optional",
  cli: { installed: true },
  gateway: { expected: "optional", health: "optional" },
  sandbox: { expected: "optional", status: "optional", agent: "openclaw" },
  inference: { expected: "optional", provider: "nvidia" },
  credentials: { expected: "optional" },
};

const preflightFailureNoSandbox: ExpectedState = {
  id: "preflight-failure-no-sandbox",
  cli: { installed: true },
  gateway: { expected: "absent" },
  sandbox: { expected: "absent" },
};

const onboardingFailureInvalidNvidiaKey: ExpectedState = {
  id: "onboarding-failure-invalid-nvidia-key",
  cli: { installed: true },
  gateway: { expected: "absent" },
  sandbox: { expected: "absent" },
};

const onboardingFailureGatewayPortConflict: ExpectedState = {
  id: "onboarding-failure-gateway-port-conflict",
  cli: { installed: true },
  gateway: { expected: "absent" },
  sandbox: { expected: "absent" },
};

// Post-reboot recovery contract for #4423. After the lifecycle phase
// stops the OpenShell gateway runtime + the labeled sandbox container,
// the user-visible invariants are:
//
//   * `cli` still installed.
//   * `gateway` healthy: the user-systemd unit from #4580 brings the
//     gateway back up before status runs.
//   * `sandbox` running by the time validation completes: a correct
//     fix performs Docker-backed recovery before responding.
//   * `localRegistry` entry preserved: this is the user-visible
//     regression target. On unfixed code, the destructive `missing`
//     branch wipes the entry; on fixed code it survives because
//     Docker corroborated the sandbox container existence.
//   * `dockerSandboxContainer` still present: the recovery path must
//     not delete the labeled container or its `*-nemoclaw-gpu-backup-*`
//     sibling as a side effect.
const postRebootRecoveryReady: ExpectedState = {
  id: "post-reboot-recovery-ready",
  cli: { installed: true },
  gateway: { expected: "present", health: "healthy" },
  sandbox: { expected: "present", status: "running", agent: "openclaw" },
  localRegistry: { expected: "present" },
  dockerSandboxContainer: { expected: "present" },
};

const REGISTRY: readonly ExpectedState[] = [
  cloudOpenclawReady,
  cloudOpenclawCustomPoliciesReady,
  cloudHermesReady,
  localOllamaOpenclawReady,
  macosCliReadyDockerOptional,
  preflightFailureNoSandbox,
  onboardingFailureInvalidNvidiaKey,
  onboardingFailureGatewayPortConflict,
  postRebootRecoveryReady,
];

const BY_ID: ReadonlyMap<string, ExpectedState> = new Map(
  REGISTRY.map((state) => [state.id, state]),
);

export function listExpectedStates(): readonly ExpectedState[] {
  return REGISTRY;
}

export function getExpectedState(id: string): ExpectedState | undefined {
  return BY_ID.get(id);
}

export function requireExpectedState(id: string): ExpectedState {
  const state = BY_ID.get(id);
  if (!state) {
    const available = Array.from(BY_ID.keys()).join(", ");
    throw new Error(`Unknown expected_state id '${id}' (available: ${available})`);
  }
  return state;
}

// Translate the typed expected-state contract into the concrete probe
// ids the state-validation orchestrator emits. Inference and
// credentials probes are intentionally omitted today (probe scripts
// not yet implemented); their declarations remain in ExpectedState so
// the contract is visible in plan output and a future change can
// switch on emission without touching scenario data. "optional"
// dimensions emit no probe actions.
export function probesForState(state: ExpectedState): readonly StateProbeId[] {
  const probes: StateProbeId[] = [];
  if (state.cli?.installed === true) {
    probes.push("cli-installed");
  }
  if (state.gateway?.expected === "present" && state.gateway.health === "healthy") {
    probes.push("gateway-healthy");
  } else if (state.gateway?.expected === "absent") {
    probes.push("gateway-absent");
  }
  if (state.sandbox?.expected === "present" && state.sandbox.status === "running") {
    probes.push("sandbox-running");
  } else if (state.sandbox?.expected === "absent") {
    probes.push("sandbox-absent");
  }
  // Host-side aspects. "absent" deliberately emits no probe today: it
  // would require asserting the registry/container does NOT exist,
  // which has no scenario in flight. Add when a negative scenario
  // needs it.
  if (state.localRegistry?.expected === "present") {
    probes.push("local-registry-entry-present");
  }
  if (state.dockerSandboxContainer?.expected === "present") {
    probes.push("docker-sandbox-container-present");
  }
  return probes;
}
