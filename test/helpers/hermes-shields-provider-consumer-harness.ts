// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { type MockInstance, vi } from "vitest";
import type { SandboxEntry } from "../../src/lib/state/registry";
import { livePolicyMutationContext } from "./shields-flow-harness";

const INDEX_MODULE = "./index.js";
export const HERMES_PROVIDER_CAPABILITY_PATH =
  "/usr/local/share/nemoclaw/runtime-state-mutation-publisher-v1.json";
const HERMES_PROVIDER_CAPABILITY =
  '{"schemaVersion":1,"protocol":"nemoclaw-runtime-state-mutation-publisher-v1","agent":"hermes","providerId":"docker","stateRoot":"/sandbox/.hermes","planSchemaVersion":2,"entrypoint":"/usr/local/lib/nemoclaw/runtime_state_mutation_hermes_publisher.py"}';
const SEALED_PLAN_HELP = [
  "begin-shields-transition",
  "run-state-dir-transition",
  "apply-shields-transition",
  "finish-shields-transition",
  "prepare-shields-abort",
  "abort-shields-transition",
  "--rollback-shields-mode",
  "--state-lock-plan-json",
].join(" ");

export const hermesProviderConsumerTarget = {
  agentName: "hermes",
  configPath: "/sandbox/.hermes/config.yaml",
  configDir: "/sandbox/.hermes",
  configFile: "config.yaml",
  sensitiveFiles: ["/sandbox/.hermes/.config-hash", "/sandbox/.hermes/.env"],
  stateLockPlan: {
    version: 1 as const,
    readOnlyRoots: ["skills"],
    confidentialRoots: ["pairing"],
    readOnlyPrefixes: [],
    confidentialPrefixes: [],
    writableSubpaths: [],
  },
  stateLockPlanInImage: true,
};

export const hermesProviderConsumerSandbox: SandboxEntry = {
  name: "current-hermes",
  agent: "hermes",
  openshellDriver: "docker",
  lifecycleGeneration: "generation-1",
  workload: {
    schemaVersion: 1,
    kind: "managed-image",
    reference: "ghcr.io/nvidia/nemoclaw/hermes@sha256:abc",
    platform: "linux/amd64",
    release: "test",
    sourceRevision: "a".repeat(40),
    sourceCohort: "test",
    capabilityContractVersion: 1,
    startupProfileContractVersion: 1,
    encodedProfile: "e30",
    startupProfileSha256: "b".repeat(64),
    credentialProxyReplayRequired: true,
    shared: true,
  },
};

export type HermesShieldsProviderConsumerHarness = {
  auditSpy: MockInstance;
  capabilityProbe: {
    error: Error | null;
    presence: string;
  };
  commands: string[][];
  dockerExecSpy: MockInstance;
  lifecycleGateSpy: MockInstance;
  registrySpy: MockInstance;
  routeSpy: MockInstance;
  runCaptureSpy: MockInstance;
  runSpy: MockInstance;
  shields: typeof import("../../src/lib/shields/index");
  spies: MockInstance[];
  supportSpy: MockInstance;
  transitionSpy: MockInstance;
  verifyLockSpy: MockInstance;
  preflightStateDirLockSpy: MockInstance;
  verifyLockedStateDirPostureSpy: MockInstance;
  verifyStateDirMutablePostureSpy: MockInstance;
  cleanup: () => void;
};

export function writeBoundPolicySnapshot(
  policyPath: string,
  content = "version: 1\nnetwork_policies:\n  restrictive: {}\n",
) {
  fs.writeFileSync(policyPath, content, { mode: 0o600 });
  fs.chmodSync(policyPath, 0o600);
  const metadata = fs.statSync(policyPath);
  return {
    schemaVersion: 1 as const,
    path: policyPath,
    sha256: createHash("sha256").update(content).digest("hex"),
    size: Buffer.byteLength(content),
    mode: 0o600,
    uid: metadata.uid,
    gid: metadata.gid,
    nlink: 1 as const,
  };
}

export function writeBoundForwardPolicy(
  stateDir: string,
  sandboxName: string,
  processToken: string,
  content = "version: 1\nnetwork_policies:\n  permissive: {}\n",
) {
  const policyPath = path.join(
    stateDir,
    `shields-forward-policy-${sandboxName}-${processToken}.yaml`,
  );
  return writeBoundPolicySnapshot(policyPath, content);
}

export function writeTimerAuthorizationProof(loadSource: NodeRequire, sandboxName: string): void {
  const timerControl = loadSource(
    "./timer-control.js",
  ) as typeof import("../../src/lib/shields/timer-control");
  const marker = timerControl.readTimerMarker(sandboxName);
  if (!marker?.processToken || !marker.timerProcessStartIdentity) {
    throw new Error("Test timer marker is missing exact proof authority");
  }
  fs.writeFileSync(
    timerControl.timerAuthorizationProofPath(sandboxName, marker.processToken),
    JSON.stringify({
      schemaVersion: 1,
      pid: marker.pid,
      sandboxName,
      processToken: marker.processToken,
      timerProcessStartIdentity: marker.timerProcessStartIdentity,
      authoritySha256: timerControl.timerAuthoritySha256(marker),
    }),
    { mode: 0o600 },
  );
}

export function createTimerAuthorizationSender(
  loadSource: NodeRequire,
  sandboxName: string,
): (message: unknown) => boolean {
  const timerControl = loadSource(
    "./timer-control.js",
  ) as typeof import("../../src/lib/shields/timer-control");
  return (message) => {
    const request = message as { type?: unknown; processToken?: unknown };
    if (request.type === "authorize" && typeof request.processToken === "string") {
      const marker = timerControl.readTimerMarker(sandboxName);
      if (marker?.timerProcessStartIdentity) {
        fs.writeFileSync(
          timerControl.timerAuthorizationProofPath(sandboxName, request.processToken),
          JSON.stringify({
            schemaVersion: 1,
            pid: marker.pid,
            sandboxName,
            processToken: request.processToken,
            timerProcessStartIdentity: marker.timerProcessStartIdentity,
            authoritySha256: timerControl.timerAuthoritySha256(marker),
          }),
          { mode: 0o600 },
        );
      }
    }
    return true;
  };
}

export function createFailingCapabilityProbeResponse(
  isCapabilityProbe: (command: string[]) => boolean,
  error: Error,
): (command: string[]) => string {
  return (command) => {
    if (isCapabilityProbe(command)) throw error;
    return "";
  };
}

export function createRetainedUnlockSimulation(
  events: string[],
  commands: string[][],
): {
  readonly activeClaim: () => boolean;
  readonly dockerExec: (commandValue: unknown) => string;
  readonly hasActiveClaim: () => boolean;
  readonly livePosture: () => "locked" | "mutable";
  readonly run: (commandValue: unknown) => { readonly status: 0 };
  readonly transition: (input: {
    readonly target: "locked" | "mutable";
    readonly rollback: string;
  }) => { readonly fence: Record<string, never>; readonly proof: Record<string, never> };
} {
  let activeClaim = true;
  let livePosture: "locked" | "mutable" = "mutable";
  return {
    activeClaim: () => activeClaim,
    dockerExec: (commandValue) => {
      const command = commandValue as string[];
      commands.push(command);
      if (command[0] === "stat" && command.at(-1) === "/sandbox/.hermes") {
        if (livePosture === "mutable") events.push("verified-mutable");
        return livePosture === "locked" ? "755 root:root\n" : "3770 sandbox:sandbox\n";
      }
      if (command[0] === "stat") {
        return livePosture === "locked" ? "444 root:root\n" : "640 sandbox:sandbox\n";
      }
      if (command[0] === "lsattr") {
        return `${livePosture === "locked" ? "----i---------------" : "--------------------"} ${String(command.at(-1))}\n`;
      }
      return "";
    },
    hasActiveClaim: () => activeClaim,
    livePosture: () => livePosture,
    run: (commandValue) => {
      const command = commandValue as string[];
      if (command[0] === "policy" && command[1] === "set") events.push("policy");
      return { status: 0 };
    },
    transition: (input) => {
      events.push(`provider:${input.target}/${input.rollback}`);
      if (activeClaim) {
        // Recovering the interrupted mutable target restores its retained
        // restrictive rollback before releasing direct-exec exclusion.
        activeClaim = false;
        livePosture = "locked";
      } else if (input.target !== input.rollback) {
        livePosture = input.target;
      }
      return { fence: {}, proof: {} };
    },
  };
}

export function createTransitionFailureForPosture(
  posture: "locked" | "mutable",
  message: string,
): (input: { readonly target: string; readonly rollback: string }) => {
  readonly fence: Record<string, never>;
  readonly proof: Record<string, never>;
} {
  return (input) => {
    if (input.target === posture && input.rollback === posture) throw new Error(message);
    return { fence: {}, proof: {} };
  };
}

export function createHermesShieldsProviderConsumerHarness(
  loadSource: NodeRequire,
): HermesShieldsProviderConsumerHarness {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-provider-consumer-"));
  vi.stubEnv("HOME", homeDir);
  const spies: MockInstance[] = [];
  const commands: string[][] = [];
  const capabilityProbe = { presence: "present", error: null as Error | null };
  delete require.cache[loadSource.resolve(INDEX_MODULE)];

  const runner = loadSource("../runner.js");
  const policy = loadSource("../policy/index.js");
  const registry = loadSource("../state/registry.js");
  const privilegedExec = loadSource("../sandbox/privileged-exec.js");
  const dockerExec = loadSource("../adapters/docker/exec.js");
  const transition = loadSource("./hermes-runtime-state-mutation.js");
  const runtimeProvider = loadSource("../onboard/runtime-provider/persisted-engine-lifecycle.js");
  const verifyLock = loadSource("./verify-lock.js");
  const stateDirLock = loadSource("./state-dir-lock.js");
  const relockReconfirm = loadSource("./relock-reconfirm.js");
  const audit = loadSource("./audit.js");
  const timerControl = loadSource("./timer-control.js");

  const registrySpy = vi
    .spyOn(registry, "getSandbox")
    .mockReturnValue(hermesProviderConsumerSandbox);
  const verifyLockSpy = vi
    .spyOn(verifyLock, "verifyShieldsLockState")
    .mockReturnValue({ issues: [] });
  const preflightStateDirLockSpy = vi
    .spyOn(stateDirLock, "preflightStateDirLock")
    .mockReturnValue([]);
  const verifyLockedStateDirPostureSpy = vi
    .spyOn(stateDirLock, "verifyLockedStateDirPosture")
    .mockReturnValue([]);
  const verifyStateDirMutablePostureSpy = vi
    .spyOn(stateDirLock, "verifyStateDirMutablePosture")
    .mockImplementation(() => []);
  const runSpy = vi.spyOn(runner, "run").mockReturnValue({ status: 0 });
  // #10104: default to an empty `sandbox list` capture (no matching row, so
  // the runtime-provider phase probe resolves to null and fails open) so
  // every existing scenario proceeds exactly as before this spy existed.
  const runCaptureSpy = vi.spyOn(runner, "runCapture").mockReturnValue("");
  spies.push(
    runSpy,
    runCaptureSpy,
    vi.spyOn(runner, "validateName").mockImplementation((value: unknown) => String(value)),
    vi
      .spyOn(policy, "buildPolicySetCommand")
      .mockImplementation((file: unknown, name: unknown) => [
        "policy",
        "set",
        String(file),
        String(name),
      ]),
    vi.spyOn(policy, "inspectPolicyMutationContext").mockReturnValue(livePolicyMutationContext),
    vi.spyOn(policy, "inspectPolicyMutationContext").mockReturnValue(livePolicyMutationContext),
    vi.spyOn(policy, "recheckPolicyMutationContext").mockReturnValue(livePolicyMutationContext),
    vi.spyOn(policy, "verifyAppliedPolicyDocument").mockImplementation(() => undefined),
    registrySpy,
    vi
      .spyOn(privilegedExec, "capturePrivilegedSandboxCommand")
      .mockImplementation((_sandboxName: unknown, command: unknown) =>
        Buffer.from(dockerExec.dockerExecFileSync(command as string[])),
      ),
    verifyLockSpy,
    preflightStateDirLockSpy,
    verifyLockedStateDirPostureSpy,
    verifyStateDirMutablePostureSpy,
    vi.spyOn(console, "log").mockImplementation(() => undefined),
    vi.spyOn(console, "error").mockImplementation(() => undefined),
    vi.spyOn(console, "warn").mockImplementation(() => undefined),
    vi.spyOn(timerControl, "isProcessAlive").mockReturnValue(true),
    vi.spyOn(timerControl, "readProcessStartIdentity").mockReturnValue("live-timer-start"),
    vi.spyOn(timerControl, "verifyTimerMarkerIdentity").mockReturnValue({ verified: true }),
  );
  const transitionSpy = vi
    .spyOn(transition, "runHermesRuntimeProviderStateMutation")
    .mockReturnValue({ fence: {}, proof: {} });
  const supportSpy = vi
    .spyOn(transition, "supportsHermesRuntimeProviderStateMutation")
    .mockReturnValue(true);
  const lifecycleGateSpy = vi.spyOn(runtimeProvider, "hasActivePersistedEngineStateMutationTarget");
  const routeSpy = vi
    .spyOn(relockReconfirm, "waitForHermesInferenceRouteConvergence")
    .mockReturnValue({ ok: true, attempts: 1, httpStatus: 200 });
  const auditSpy = vi.spyOn(audit, "appendAuditEntry").mockImplementation(() => undefined);
  const dockerExecSpy = vi
    .spyOn(dockerExec, "dockerExecFileSync")
    .mockImplementation((commandValue: unknown) => {
      const command = commandValue as string[];
      commands.push(command);
      if (
        command.includes("-c") &&
        command.some((entry) => entry.includes("os.lstat")) &&
        command.at(-1) === HERMES_PROVIDER_CAPABILITY_PATH
      ) {
        if (capabilityProbe.error) throw capabilityProbe.error;
        return `${capabilityProbe.presence}\n`;
      }
      if (command[0] === "stat" && command.at(-1) === HERMES_PROVIDER_CAPABILITY_PATH) {
        return "444 0 0 1 regular file\n";
      }
      if (command[0] === "cat" && command.at(-1) === HERMES_PROVIDER_CAPABILITY_PATH) {
        return `${HERMES_PROVIDER_CAPABILITY}\n`;
      }
      if (
        command.some((entry) => entry.endsWith("/hermes-runtime-config-guard.py")) &&
        command.includes("--help")
      ) {
        return `${SEALED_PLAN_HELP}\n`;
      }
      const gatewayControlIndex = command.indexOf("/usr/local/bin/nemoclaw-gateway-control");
      if (gatewayControlIndex >= 0 && command[gatewayControlIndex + 1] === "restart") {
        const nonce = String(command[gatewayControlIndex + 2]);
        return `v1 ${nonce} complete ok 10 11\nGATEWAY_PID=11\n`;
      }
      if (command[0] === "stat" && command.at(-1) === hermesProviderConsumerTarget.configDir) {
        return "3770 sandbox:sandbox\n";
      }
      if (command[0] === "stat") return "640 sandbox:sandbox\n";
      if (command[0] === "lsattr") return `---------------- ${String(command.at(-1))}\n`;
      if (command[0] === "sha256sum") {
        return `${"c".repeat(64)}  ${String(command.at(-1))}\n`;
      }
      return "";
    });
  spies.push(transitionSpy, supportSpy, lifecycleGateSpy, routeSpy, auditSpy, dockerExecSpy);

  const shields = loadSource(INDEX_MODULE) as typeof import("../../src/lib/shields/index");

  return {
    auditSpy,
    capabilityProbe,
    cleanup: () => {
      for (const spy of spies) spy.mockRestore();
      vi.unstubAllEnvs();
      delete require.cache[loadSource.resolve(INDEX_MODULE)];
      fs.rmSync(homeDir, { recursive: true, force: true });
    },
    commands,
    dockerExecSpy,
    lifecycleGateSpy,
    registrySpy,
    routeSpy,
    runCaptureSpy,
    runSpy,
    shields,
    spies,
    supportSpy,
    transitionSpy,
    verifyLockSpy,
    preflightStateDirLockSpy,
    verifyLockedStateDirPostureSpy,
    verifyStateDirMutablePostureSpy,
  };
}
