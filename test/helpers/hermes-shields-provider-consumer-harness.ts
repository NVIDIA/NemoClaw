// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, type MockInstance, vi } from "vitest";
import type { SandboxEntry } from "../../src/lib/state/registry";

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
  runSpy: MockInstance;
  shields: typeof import("../../src/lib/shields/index");
  spies: MockInstance[];
  supportSpy: MockInstance;
  transitionSpy: MockInstance;
  verifyLockSpy: MockInstance;
  cleanup: () => void;
};

export type InterruptedHermesRecoveryState = {
  readonly statePath: string;
  readonly timerPath: string;
  readonly transitionPath: string;
};

export function writeInterruptedHermesRecoveryState(
  loadSource: NodeRequire,
): InterruptedHermesRecoveryState {
  const statePaths = loadSource("../state/paths.js") as typeof import("../../src/lib/state/paths");
  const stateDir = statePaths.resolveNemoclawStateDir();
  const processToken = "f".repeat(32);
  const snapshotPath = path.join(stateDir, "shields-policy-interrupted-recovery.yaml");
  const statePath = path.join(stateDir, `shields-${hermesProviderConsumerSandbox.name}.json`);
  const timerPath = path.join(stateDir, `shields-timer-${hermesProviderConsumerSandbox.name}.json`);
  const transitionPath = path.join(
    stateDir,
    `shields-transition-${hermesProviderConsumerSandbox.name}-${processToken}.json`,
  );
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(snapshotPath, "version: 1\nnetwork_policies:\n  restrictive: {}\n");
  const forwardPolicy = writeBoundForwardPolicy(
    stateDir,
    hermesProviderConsumerSandbox.name,
    processToken,
  );
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      shieldsDown: true,
      shieldsDownAt: "2026-08-09T00:10:00.000Z",
      shieldsDownTimeout: 300,
      shieldsDownReason: "interrupted recovery failure",
      shieldsDownPolicy: "permissive",
      shieldsPolicySnapshotPath: snapshotPath,
    }),
  );
  fs.writeFileSync(
    timerPath,
    JSON.stringify({
      pid: 4545,
      sandboxName: hermesProviderConsumerSandbox.name,
      snapshotPath,
      restoreAt: new Date(Date.now() + 60_000).toISOString(),
      processToken,
      timerProcessStartIdentity: "live-timer-start",
      allowLegacyHermesProtocol: false,
      agentName: "hermes",
      configPath: hermesProviderConsumerTarget.configPath,
      configDir: hermesProviderConsumerTarget.configDir,
    }),
  );
  writeTimerAuthorizationProof(loadSource, hermesProviderConsumerSandbox.name);
  fs.writeFileSync(
    transitionPath,
    JSON.stringify({
      version: 1,
      phase: "preparing",
      ownerPid: 4545,
      ownerStartIdentity: "dead-recovery-owner",
      processToken,
      sandboxName: hermesProviderConsumerSandbox.name,
      snapshotPath,
      forwardPolicy,
    }),
  );
  return { statePath, timerPath, transitionPath };
}

export function configureInterruptedHermesRecoverySimulation(
  harness: HermesShieldsProviderConsumerHarness,
): void {
  const simulation = createRetainedUnlockSimulation([], harness.commands);
  const defaultDockerExec = harness.dockerExecSpy.getMockImplementation();
  harness.runSpy.mockImplementation(simulation.run);
  harness.lifecycleGateSpy.mockImplementation(simulation.hasActiveClaim);
  harness.transitionSpy.mockImplementation(simulation.transition);
  harness.dockerExecSpy.mockImplementation((command: unknown) => {
    const args = command as string[];
    return args.includes(HERMES_PROVIDER_CAPABILITY_PATH)
      ? defaultDockerExec?.(command)
      : simulation.dockerExec(command);
  });
  harness.verifyLockSpy.mockReturnValue({ issues: ["lockdown verification failed"] });
}

export function expectInterruptedHermesRecoveryFailure(
  harness: HermesShieldsProviderConsumerHarness,
  recovery: InterruptedHermesRecoveryState,
  error: RegExp,
): void {
  expect(() =>
    harness.shields.shieldsDown(hermesProviderConsumerSandbox.name, { throwOnError: true }),
  ).toThrow(error);
  expect(JSON.parse(fs.readFileSync(recovery.transitionPath, "utf-8"))).toMatchObject({
    phase: "preparing",
  });
  expect(JSON.parse(fs.readFileSync(recovery.statePath, "utf-8"))).toMatchObject({
    shieldsDown: true,
  });
  expect(harness.auditSpy).not.toHaveBeenCalled();
  expect(vi.mocked(console.error).mock.calls.flat().map(String).join("\n")).toContain(
    "Interrupted config unlock recovery is incomplete",
  );
}

type InterruptedHermesRecoveryFailureSetup = (
  harness: HermesShieldsProviderConsumerHarness,
  recovery: InterruptedHermesRecoveryState,
) => void;

export const interruptedHermesRecoveryFailures: ReadonlyArray<
  readonly [string, InterruptedHermesRecoveryFailureSetup, RegExp]
> = [
  [
    "timer authority changes",
    (harness, recovery) => {
      harness.routeSpy.mockImplementation(() => {
        const marker = JSON.parse(fs.readFileSync(recovery.timerPath, "utf-8"));
        fs.writeFileSync(
          recovery.timerPath,
          JSON.stringify({ ...marker, timerProcessStartIdentity: "replacement-timer-start" }),
        );
        return { ok: true, attempts: 1, httpStatus: 200 };
      });
    },
    /auto-restore authority changed|timer generation/iu,
  ],
  [
    "the provider unlock fails",
    (harness) => {
      const retainedTransition = harness.transitionSpy.getMockImplementation();
      harness.transitionSpy.mockImplementation((input: { target: string; rollback: string }) => {
        if (input.target === "mutable" && input.rollback === "mutable") {
          throw new Error("provider unlock failed");
        }
        return retainedTransition?.(input);
      });
    },
    /provider unlock failed/u,
  ],
  [
    "inference route convergence fails",
    (harness) => {
      harness.routeSpy.mockReturnValue({ ok: false, attempts: 3, httpStatus: 503 });
    },
    /inference route did not converge/u,
  ],
];

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
  fs.writeFileSync(policyPath, content, { mode: 0o600 });
  fs.chmodSync(policyPath, 0o600);
  const metadata = fs.statSync(policyPath);
  return {
    schemaVersion: 1,
    path: policyPath,
    sha256: createHash("sha256").update(content).digest("hex"),
    size: Buffer.byteLength(content),
    mode: 0o600,
    uid: metadata.uid,
    gid: metadata.gid,
    nlink: 1,
  };
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
  const relockReconfirm = loadSource("./relock-reconfirm.js");
  const audit = loadSource("./audit.js");
  const timerControl = loadSource("./timer-control.js");

  const registrySpy = vi
    .spyOn(registry, "getSandbox")
    .mockReturnValue(hermesProviderConsumerSandbox);
  const verifyLockSpy = vi
    .spyOn(verifyLock, "verifyShieldsLockState")
    .mockReturnValue({ issues: [] });
  const runSpy = vi.spyOn(runner, "run").mockReturnValue({ status: 0 });
  spies.push(
    runSpy,
    vi.spyOn(runner, "validateName").mockImplementation((value: unknown) => String(value)),
    vi
      .spyOn(policy, "buildPolicySetCommand")
      .mockImplementation((file: unknown, name: unknown) => [
        "policy",
        "set",
        String(file),
        String(name),
      ]),
    registrySpy,
    vi
      .spyOn(privilegedExec, "privilegedSandboxExecArgv")
      .mockImplementation((_sandboxName: unknown, command: unknown) => command as string[]),
    verifyLockSpy,
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
    runSpy,
    shields,
    spies,
    supportSpy,
    transitionSpy,
    verifyLockSpy,
  };
}
