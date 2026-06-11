// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ExpectedState, StateProbeId } from "./types.ts";

// Source of truth for expected state in the live Vitest scenario path.
// Inference and credentials remain declared in metadata, but the
// state-validation phase fixture only emits probes for dimensions with typed
// helpers today.

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
// stops the labeled sandbox container, the host-side invariants this
// scenario locks down are:
//
//   * `cli` still installed.
//   * `localRegistry` entry preserved: this is the user-visible
//     regression target. The destructive `missing` branch wipes the
//     entry; preservation here proves #4578's mitigation holds AND
//     that PR-A's Docker-corroboration path (when added) does not
//     regress that invariant.
//   * `dockerSandboxContainer` still present: any recovery path must
//     not delete the labeled container or its `*-nemoclaw-gpu-backup-*`
//     sibling as a side effect.
//
// Gateway/sandbox runtime state are intentionally OMITTED from this
// expected state. The user-visible bug is host-side state
// destruction; gateway/sandbox liveness on a `ubuntu-latest` runner
// after `docker stop` is environmental and varies independently of
// the regression target. Once PR-A lands its Docker-driver recovery
// helper, a follow-up scenario can extend the expected state with
// runtime invariants on a more controlled runner.
const postRebootRecoveryReady: ExpectedState = {
  id: "post-reboot-recovery-ready",
  cli: { installed: true },
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
  // Host-side aspects run BEFORE runtime-derived gateway/sandbox
  // probes. The state-validation orchestrator short-circuits on the
  // first probe failure, so host-side preservation invariants —
  // which are the user-visible regression targets for #4423-class
  // bugs — must be observed first. A regression that destroys the
  // registry while leaving the gateway in a transient state would
  // otherwise be masked by a noisy gateway-healthy failure.
  // "absent" deliberately emits no probe today: it would require
  // asserting the registry/container does NOT exist, which has no
  // scenario in flight. Add when a negative scenario needs it.
  if (state.localRegistry?.expected === "present") {
    probes.push("local-registry-entry-present");
  }
  if (state.dockerSandboxContainer?.expected === "present") {
    probes.push("docker-sandbox-container-present");
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
  return probes;
}
