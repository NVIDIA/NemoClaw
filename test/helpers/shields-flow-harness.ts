// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { expect, type MockInstance, vi } from "vitest";
import YAML from "yaml";
import { buildMcpBridgePolicyYaml } from "../../src/lib/actions/sandbox/mcp-bridge-policy-render";
import type { OpenShellPolicyInspection as SandboxPolicyInspection } from "../../src/lib/adapters/openshell/policy-boundary";
import type { AgentConfigTarget } from "../../src/lib/sandbox/agent-config";
import type { SandboxEntry } from "../../src/lib/state/registry";

const shieldsModulePath = "./index.js";

export const livePolicyMutationContext = {
  gatewayName: "nemoclaw",
  basePolicyDocument: "version: 1\nnetwork_policies:\n  test: {}\n",
  inspection: {
    policySource: "sandbox" as const,
    effectivePolicy: { version: 1, network_policies: {} },
    policyIdentity: { hash: "managed-policy-hash", activeVersion: 1 },
  },
};

export function bindLivePolicyMutationContext(
  policy: typeof import("../../src/lib/policy"),
  policyAdapter?: typeof import("../../src/lib/adapters/openshell/sandbox-policy-cli"),
): MockInstance[] {
  return [
    ...(policyAdapter
      ? [bindTypedPolicyReader(policyAdapter, () => livePolicyMutationContext.basePolicyDocument)]
      : []),
    vi.spyOn(policy, "inspectPolicyMutationContext").mockReturnValue(livePolicyMutationContext),
    vi.spyOn(policy, "recheckPolicyMutationContext").mockReturnValue(livePolicyMutationContext),
    vi.spyOn(policy, "verifyAppliedPolicyDocument").mockImplementation(() => undefined),
    bindPolicySubmissionConfirmation(policy),
  ];
}

export function bindPolicySubmissionConfirmation(
  policy: typeof import("../../src/lib/policy"),
): MockInstance {
  return vi
    .spyOn(policy, "confirmAppliedPolicySetSubmission")
    .mockImplementation((submission, sandboxName, desiredPolicyDocument, previous, operation) => {
      policy.rejectFinalPolicySetSubmission(submission, operation);
      policy.verifyAppliedPolicyDocument(sandboxName, desiredPolicyDocument, previous);
    });
}

export type ShieldsFlowHarness = {
  applyShieldsPolicySnapshot: typeof import("../../src/lib/shields/index.js").applyShieldsPolicySnapshot;
  auditSpy: MockInstance;
  clearShieldsState: typeof import("../../src/lib/shields/index.js").clearShieldsState;
  cleanupTempDirSpy: MockInstance;
  dockerSpawnCalls: Array<{ args: string[]; timeout: number | undefined }>;
  errorSpy: MockInstance;
  getShieldsPosture: typeof import("../../src/lib/shields/index.js").getShieldsPosture;
  getOpenClawPosture: () => "locked" | "mutable";
  logSpy: MockInstance;
  policyStateSpy: MockInstance;
  policyVerificationSpy: MockInstance;
  policyRecoveryAuthoritySpy: MockInstance;
  policySetBodies: string[];
  runCaptureSpy: MockInstance;
  runSpy: MockInstance;
  shieldsDown: typeof import("../../src/lib/shields/index.js").shieldsDown;
  shieldsStatus: typeof import("../../src/lib/shields/index.js").shieldsStatus;
  shieldsUp: typeof import("../../src/lib/shields/index.js").shieldsUp;
  isShieldsDown: typeof import("../../src/lib/shields/index.js").isShieldsDown;
  synchronizeAutoRestoreWithShieldsDown: typeof import("../../src/lib/shields/index.js").synchronizeAutoRestoreWithShieldsDown;
};

export type ShieldsFlowHarnessOptions = {
  beginContainment?: typeof import("../../src/lib/state/mcp-lifecycle-lock.js").beginCommittedMcpLifecycleContainmentSync;
  confirmOpenClawInodeFlags?: boolean;
  directSandboxUnavailable?: boolean;
  dockerExecFileSync?: (argv: unknown) => string;
  failOpenClawGuardActions?: Array<"preflight" | "lock" | "unlock">;
  failPolicyRejectionStateClear?: boolean;
  failPolicyRejectionTransitionWrite?: boolean;
  failStateSave?: boolean;
  initialOpenClawPosture?: "locked" | "mutable";
  invokedAs?: "nemoclaw" | "nemohermes";
  agentConfigTarget?: AgentConfigTarget;
  openClawGuardFailure?: {
    code: string;
    path: string;
    detail: string;
  };
  openClawGuardFailures?: Array<{
    code: string;
    path: string;
    detail: string;
  }>;
  processStartIdentity?: string;
  policyInspection?: SandboxPolicyInspection;
  timerAuthorizationOutcome?: "authorized" | "dies-before-proof";
  timerDiesAfterUnlock?: boolean;
  fork?: (...args: unknown[]) => {
    pid: number;
    disconnect: () => void;
    unref: () => void;
    send: () => boolean;
    kill: () => boolean;
  };
  livePolicyYaml?: string;
  run?: (cmd: unknown) => {
    status: number | null;
    stderr?: string | Buffer | null;
    error?: Error | null;
  };
  sandboxEntry?: SandboxEntry;
  sandboxName?: string;
  timerAuthorityRevokedSequence?: readonly boolean[];
};

export function managedMcpPolicy(server: string, address = "8.8.8.8") {
  const providerName = `openclaw-mcp-${server}`;
  const content = buildMcpBridgePolicyYaml(
    server,
    `https://${server}.example.com/mcp`,
    "hermes-config",
    { addresses: [address] },
    providerName,
  );
  const entries = Object.entries(YAML.parse(content).network_policies as Record<string, unknown>);
  expect(entries, `rendered MCP policies for ${server}`).toHaveLength(1);
  const [key, networkPolicy] = entries[0]!;
  return { address, content, key, networkPolicy, providerName, server };
}

export function managedMcpSandbox(
  policies: Array<ReturnType<typeof managedMcpPolicy>>,
): SandboxEntry {
  return {
    name: "openclaw",
    openshellDriver: "docker",
    mcp: {
      bridges: Object.fromEntries(
        policies.map(({ address, providerName, server }) => [
          server,
          {
            server,
            agent: "hermes",
            adapter: "hermes-config",
            url: `https://${server}.example.com/mcp`,
            env: ["MCP_SECRET"],
            allowedIps: [address],
            providerName,
            policyName: `mcp-bridge-${server}`,
            addedAt: "2026-07-30T00:00:00.000Z",
          },
        ]),
      ),
    },
  };
}

export function writeBoundPolicySnapshot(
  snapshotPath: string,
  content = "version: 1\nnetwork_policies:\n  test: {}\n",
) {
  fs.writeFileSync(snapshotPath, content, { mode: 0o600 });
  fs.chmodSync(snapshotPath, 0o600);
  const metadata = fs.statSync(snapshotPath);
  return {
    schemaVersion: 1 as const,
    path: snapshotPath,
    sha256: createHash("sha256").update(content).digest("hex"),
    size: Buffer.byteLength(content),
    mode: 0o600,
    uid: metadata.uid,
    gid: metadata.gid,
    nlink: 1 as const,
  };
}

export function writeActivePolicyTransition(
  stateDir: string,
  sandboxName: string,
  processToken: string,
  snapshotPath: string,
  snapshotPolicy: ReturnType<typeof writeBoundPolicySnapshot>,
): void {
  const forwardPolicy = writeBoundPolicySnapshot(
    path.join(stateDir, `policy-forward-${processToken.slice(0, 8)}.yaml`),
  );
  fs.writeFileSync(
    path.join(stateDir, `shields-transition-${sandboxName}-${processToken}.json`),
    JSON.stringify({
      version: 1,
      phase: "active",
      ownerPid: 2_147_483_647,
      ownerStartIdentity: "test-timer-owner",
      processToken,
      sandboxName,
      snapshotPath,
      snapshotPolicy,
      forwardPolicy,
    }),
    { mode: 0o600 },
  );
}

export function writeShieldsTimerAuthorizationProof(
  requireDist: NodeRequire,
  sandboxName: string,
): void {
  const timerControl = requireDist(
    "./timer-control.js",
  ) as typeof import("../../src/lib/shields/timer-control.js");
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

function throwHarnessError(error: Error): never {
  throw error;
}

function recordPolicySetBody(policySetBodies: string[], file: unknown): void {
  policySetBodies.push(fs.readFileSync(String(file), "utf-8"));
}

export function bindTypedPolicyWriter(
  adapter: typeof import("../../src/lib/adapters/openshell/sandbox-policy-cli"),
  execute: (
    command: string[],
    options: { ignoreError: true },
  ) => {
    status?: number | null;
    stderr?: string | Buffer | null;
    error?: Error | null;
  },
  policySetBodies?: string[],
  commandPrefix: readonly string[] = ["openshell", "policy", "set"],
): MockInstance {
  return vi
    .spyOn(adapter.syncCliOpenShellSandboxPolicyWriter, "setSandboxPolicy")
    .mockImplementation((request) => {
      if (policySetBodies) recordPolicySetBody(policySetBodies, request.policyPath);
      const result = execute(
        [
          ...commandPrefix,
          ...(request.target.kind === "named" ? ["-g", request.target.gatewayName] : []),
        ],
        { ignoreError: true },
      );
      const status = typeof result.status === "number" ? result.status : null;
      return {
        outcome: adapter.classifyCliOpenShellSandboxPolicySetResult({
          status,
          ...(result.error ? { error: result.error } : {}),
          ...(result.stderr === null || result.stderr === undefined
            ? {}
            : {
                stderr: Buffer.isBuffer(result.stderr)
                  ? result.stderr.toString("utf8")
                  : result.stderr,
              }),
        }),
        status,
      };
    });
}

export function bindTypedPolicyReader(
  adapter: typeof import("../../src/lib/adapters/openshell/sandbox-policy-cli"),
  readDocument: (
    request: Parameters<typeof adapter.syncCliOpenShellSandboxPolicyReader.readSandboxPolicy>[0],
  ) => string,
): MockInstance {
  return vi
    .spyOn(adapter.syncCliOpenShellSandboxPolicyReader, "readSandboxPolicy")
    .mockImplementation((request) => ({
      ok: true,
      value: { document: readDocument(request), appliedRevision: null },
    }));
}

export function createShieldsFlowHarness(
  requireDist: NodeRequire,
  tmpDir: string,
  options: ShieldsFlowHarnessOptions = {},
): ShieldsFlowHarness {
  vi.stubEnv("NEMOCLAW_INVOKED_AS", options.invokedAs ?? "nemoclaw");
  delete require.cache[requireDist.resolve(shieldsModulePath)];
  delete require.cache[requireDist.resolve("./timer-bound-lock.js")];
  delete require.cache[requireDist.resolve("./transition-lock.js")];
  delete require.cache[requireDist.resolve("./permissive-runtime.js")];
  delete require.cache[requireDist.resolve("../actions/sandbox/mcp-bridge-policy.js")];
  delete require.cache[requireDist.resolve("../adapters/openshell/policy-state.js")];
  delete require.cache[requireDist.resolve("../sandbox/privileged-exec.js")];
  delete require.cache[requireDist.resolve("../cli/branding.js")];
  const timerControl = requireDist(
    "./timer-control.js",
  ) as typeof import("../../src/lib/shields/timer-control.js");
  const readProcessStartIdentity = vi.isMockFunction(timerControl.readProcessStartIdentity)
    ? (vi.mocked(timerControl.readProcessStartIdentity).getMockImplementation() ??
      timerControl.readProcessStartIdentity)
    : timerControl.readProcessStartIdentity;
  const isProcessAlive = vi.isMockFunction(timerControl.isProcessAlive)
    ? (vi.mocked(timerControl.isProcessAlive).getMockImplementation() ??
      timerControl.isProcessAlive)
    : timerControl.isProcessAlive;
  const verifyTimerMarkerIdentity = vi.isMockFunction(timerControl.verifyTimerMarkerIdentity)
    ? (vi.mocked(timerControl.verifyTimerMarkerIdentity).getMockImplementation() ??
      timerControl.verifyTimerMarkerIdentity)
    : timerControl.verifyTimerMarkerIdentity;
  const forkTimer =
    options.fork ??
    (() => ({
      pid: 4242,
      disconnect: () => undefined,
      unref: () => undefined,
      send: () => true,
      kill: () => true,
    }));
  let fakeTimerPid: number | undefined;
  let fakeTimerAlive = true;
  vi.spyOn(timerControl, "readProcessStartIdentity").mockImplementation((pid: number) =>
    pid === fakeTimerPid
      ? fakeTimerAlive
        ? (options.processStartIdentity ?? "test-process-start-identity")
        : null
      : (options.processStartIdentity ?? readProcessStartIdentity(pid)),
  );
  vi.spyOn(timerControl, "isProcessAlive").mockImplementation((pid: number) =>
    pid === fakeTimerPid ? fakeTimerAlive : isProcessAlive(pid),
  );
  vi.spyOn(timerControl, "verifyTimerMarkerIdentity").mockImplementation((marker) =>
    marker.pid === fakeTimerPid
      ? fakeTimerAlive
        ? { verified: true }
        : { verified: false, warning: "fake timer exited" }
      : verifyTimerMarkerIdentity(marker),
  );
  const lifecycleLock = requireDist(
    "../state/mcp-lifecycle-lock.js",
  ) as typeof import("../../src/lib/state/mcp-lifecycle-lock.js");
  const beginContainment =
    options.beginContainment ?? lifecycleLock.beginCommittedMcpLifecycleContainmentSync;
  vi.spyOn(lifecycleLock, "beginCommittedMcpLifecycleContainmentSync").mockImplementation(
    beginContainment,
  );
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);

  const runner = requireDist("../runner.js");
  const policy = requireDist("../policy/index.js");
  const policyAdapter = requireDist("../adapters/openshell/sandbox-policy-cli.js");
  const agentConfig = requireDist("../sandbox/agent-config.js");
  const registry = requireDist("../state/registry.js");
  const privilegedExec = requireDist("../sandbox/privileged-exec.js");
  const dockerExec = requireDist("../adapters/docker/exec.js");
  const audit = requireDist("./audit.js");
  const tempFiles = requireDist("../onboard/temp-files.js");
  const stateDirLock = requireDist("./state-dir-lock.js");
  const relockReconfirm = requireDist("./relock-reconfirm.js");
  const childProcess = requireDist("node:child_process");
  const policySetBodies: string[] = [];
  let openClawPosture: "locked" | "mutable" = options.initialOpenClawPosture ?? "mutable";
  const stateLockPlan = {
    version: 1 as const,
    readOnlyRoots: ["skills"],
    confidentialRoots: [],
    readOnlyPrefixes: [],
    confidentialPrefixes: [],
    writableSubpaths: [],
  };

  vi.spyOn(runner, "validateName").mockImplementation((name: unknown) => String(name));
  const runCaptureSpy = vi
    .spyOn(runner, "runCapture")
    .mockReturnValue(options.livePolicyYaml ?? "version: 1\nnetwork_policies:\n  test: {}\n");
  const runSpy = vi.spyOn(runner, "run").mockImplementation((cmd: unknown) => {
    return options.run ? options.run(cmd) : { status: 0 };
  });
  {
    vi.spyOn(childProcess, "fork").mockImplementation((...args: unknown[]) => {
      const child = forkTimer(...args);
      const timerArgs = Array.isArray(args[1]) ? args[1] : [];
      const timerSandboxName = String(timerArgs[0] ?? "openclaw");
      fakeTimerPid = child.pid;
      const send = child.send as (message?: unknown) => boolean;
      return {
        ...child,
        send: (message?: unknown) => {
          const sent = send(message);
          const request = message as { type?: unknown; processToken?: unknown } | undefined;
          if (sent && request?.type === "authorize" && typeof request.processToken === "string") {
            if (options.timerAuthorizationOutcome === "dies-before-proof") {
              fakeTimerAlive = false;
              return sent;
            }
            const marker = timerControl.readTimerMarker(timerSandboxName);
            if (marker?.processToken === request.processToken && marker.timerProcessStartIdentity) {
              fs.writeFileSync(
                timerControl.timerAuthorizationProofPath(timerSandboxName, request.processToken),
                JSON.stringify({
                  schemaVersion: 1,
                  pid: marker.pid,
                  sandboxName: marker.sandboxName,
                  processToken: request.processToken,
                  timerProcessStartIdentity: marker.timerProcessStartIdentity,
                  authoritySha256: timerControl.timerAuthoritySha256(marker),
                }),
                { mode: 0o600 },
              );
            }
          }
          return sent;
        },
      };
    });
  }
  bindTypedPolicyWriter(
    policyAdapter,
    (command, runOptions) => runner.run(command, runOptions),
    policySetBodies,
  );
  bindTypedPolicyReader(
    policyAdapter,
    (request) =>
      policySetBodies.at(-1) ??
      String(
        runner.runCapture([
          "policy",
          "get",
          ...(request.target.kind === "named" ? ["-g", request.target.gatewayName] : []),
          "--base",
          request.sandboxName,
        ]),
      ),
  );
  vi.spyOn(policy, "parseCurrentPolicy").mockImplementation((raw: unknown) => String(raw));
  vi.spyOn(policy, "resolvePermissivePolicyPath").mockReturnValue(
    path.join(tmpDir, "permissive.yaml"),
  );
  fs.writeFileSync(path.join(tmpDir, "permissive.yaml"), "version: 1\nnetwork_policies: {}\n");
  const resolvedAgentConfig = options.agentConfigTarget ?? {
    agentName: "openclaw",
    configDir: "/sandbox/.openclaw",
    configFile: "openclaw.json",
    configPath: "/sandbox/.openclaw/openclaw.json",
    format: "json",
    stateLockPlan,
    stateLockPlanInImage: true,
  };
  vi.spyOn(agentConfig, "resolveAgentConfig").mockReturnValue(resolvedAgentConfig);
  vi.spyOn(registry, "getSandbox").mockReturnValue(
    options.sandboxEntry
      ? { ...options.sandboxEntry }
      : {
          name: options.sandboxName ?? "openclaw",
          agent: resolvedAgentConfig.agentName,
          openshellDriver: "docker",
        },
  );
  vi.spyOn(registry, "updateSandbox").mockReturnValue(true);
  const livePolicyYaml = options.livePolicyYaml ?? "version: 1\nnetwork_policies:\n  test: {}\n";
  const policyInspection = options.policyInspection ?? {
    policySource: "sandbox" as const,
    effectivePolicy: YAML.parse(livePolicyYaml) as Record<string, unknown>,
    policyIdentity: { hash: "managed-policy-hash", activeVersion: 1 },
  };
  const gatewayName = options.sandboxEntry?.gatewayName ?? "nemoclaw";
  const sandboxName = options.sandboxName ?? "openclaw";
  const policyMutationAuthority = () => ({
    gatewayName,
    basePolicyDocument: String(
      runner.runCapture(["policy", "get", "-g", gatewayName, "--base", sandboxName]),
    ),
    inspection: policyInspection,
  });
  const policyStateSpy = vi
    .spyOn(policy, "inspectPolicyMutationContext")
    .mockImplementation(policyMutationAuthority);
  const policyRecoveryAuthoritySpy = vi
    .spyOn(policy, "inspectPolicyMutationContext")
    .mockImplementation(policyMutationAuthority);
  vi.spyOn(policy, "recheckPolicyMutationContext").mockImplementation(policyMutationAuthority);
  const policyVerificationSpy = vi.spyOn(policy, "confirmAppliedPolicySetSubmission");
  vi.spyOn(registry, "listSandboxes").mockReturnValue({
    sandboxes: [{ name: options.sandboxName ?? "openclaw", agent: resolvedAgentConfig.agentName }],
  });
  const permissiveRuntime = requireDist(
    "./permissive-runtime.js",
  ) as typeof import("../../src/lib/shields/permissive-runtime.js");
  const directSandboxUnavailableError = new Error(
    "No running direct OpenShell sandbox container found for 'openclaw' (driver: docker). Expected a running container named openshell-openclaw or openshell-openclaw-*. Is the sandbox running?",
  );
  vi.spyOn(privilegedExec, "isDirectSandboxFallbackUnavailableError").mockReturnValue(
    Boolean(options.directSandboxUnavailable),
  );
  const privilegedArgv = (cmd: unknown) =>
    options.directSandboxUnavailable
      ? throwHarnessError(directSandboxUnavailableError)
      : [
          "exec",
          "--user",
          "root",
          "openshell-openclaw",
          ...(Array.isArray(cmd) ? cmd.map(String) : []),
        ];
  vi.spyOn(privilegedExec, "capturePrivilegedSandboxCommand").mockImplementation(
    (_sandboxName: unknown, cmd: unknown, rawOptions: unknown) =>
      Buffer.from(
        dockerExec.dockerExecFileSync(privilegedArgv(cmd), {
          stdio: ["ignore", "pipe", "pipe"],
          timeout:
            rawOptions && typeof rawOptions === "object" && "timeout" in rawOptions
              ? Number((rawOptions as { timeout?: unknown }).timeout)
              : undefined,
        }),
      ),
  );
  vi.spyOn(privilegedExec, "executePrivilegedSandboxCommand").mockImplementation(
    (_sandboxName: unknown, cmd: unknown, rawOptions: unknown) => {
      const result = dockerExec.dockerSpawnSync(privilegedArgv(cmd), {
        encoding: "utf-8",
        input:
          rawOptions && typeof rawOptions === "object" && "input" in rawOptions
            ? (rawOptions as { input?: unknown }).input
            : undefined,
        timeout:
          rawOptions && typeof rawOptions === "object" && "timeout" in rawOptions
            ? Number((rawOptions as { timeout?: unknown }).timeout)
            : undefined,
      });
      return {
        status: result.status,
        signal: result.signal,
        stdout: Buffer.from(String(result.stdout ?? "")),
        stderr: Buffer.from(String(result.stderr ?? "")),
        ...(result.error ? { error: result.error } : {}),
      };
    },
  );
  const dockerSpawnCalls: Array<{ args: string[]; timeout: number | undefined }> = [];
  vi.spyOn(dockerExec, "dockerSpawnSync").mockImplementation(
    (argv: unknown, rawOptions: unknown) => {
      const args = Array.isArray(argv) ? argv.map(String) : [];
      const timeout =
        rawOptions && typeof rawOptions === "object" && "timeout" in rawOptions
          ? Number((rawOptions as { timeout?: unknown }).timeout)
          : undefined;
      dockerSpawnCalls.push({ args, timeout });
      const hermesGuard = args.some((arg) => arg.endsWith("hermes-runtime-config-guard.py"));
      const hermesLockToken = "a".repeat(64);
      if (hermesGuard && args.includes("--help")) {
        return {
          status: 0,
          signal: null,
          stdout: [
            "begin-shields-transition",
            "run-state-dir-transition",
            "apply-shields-transition",
            "finish-shields-transition",
            "prepare-shields-abort",
            "abort-shields-transition",
            "--rollback-shields-mode",
            "--state-lock-plan-json",
          ].join("\n"),
          stderr: "",
          pid: 0,
          output: [],
        } as never;
      }
      if (hermesGuard && args.includes("begin-shields-transition")) {
        return {
          status: 0,
          signal: null,
          stdout: `lock_token=${hermesLockToken} original_locked=1`,
          stderr: "",
          pid: 0,
          output: [],
        } as never;
      }
      if (hermesGuard && args.includes("apply-shields-transition")) {
        return {
          status: 0,
          signal: null,
          stdout: "shields_mode=mutable chattr_applied=0",
          stderr: "",
          pid: 0,
          output: [],
        } as never;
      }
      const readsStateLockPlan =
        args.includes("cat") && args.includes("/usr/local/share/nemoclaw/state-lock-plan.json");
      const action = ["preflight", "lock", "unlock", "unlock-failed-startup"].find((candidate) =>
        args.includes(candidate),
      );
      const openClawGuard = args.some((arg) => arg.endsWith("openclaw-config-guard.py"));
      const shouldFailOpenClawGuard = Boolean(
        openClawGuard &&
        (action === "preflight" || action === "lock" || action === "unlock") &&
        options.failOpenClawGuardActions?.includes(action),
      );
      const failures = options.openClawGuardFailures ?? [
        options.openClawGuardFailure ?? {
          code: "startup-not-ready",
          path: "/run/nemoclaw/openclaw-config-ready.json",
          detail: "OpenClaw startup is not ready for host config mutations",
        },
      ];
      const failureResult = {
        status: 1,
        signal: null,
        stdout: `${failures
          .map((failure) => JSON.stringify({ type: "issue", ...failure }))
          .join("\n")}\n${JSON.stringify({ type: "result", action, status: "failed" })}\n`,
        stderr: "",
        pid: 0,
        output: [],
      };
      openClawPosture = shouldFailOpenClawGuard
        ? openClawPosture
        : openClawGuard && action === "lock"
          ? "locked"
          : openClawGuard && (action === "unlock" || action === "unlock-failed-startup")
            ? "mutable"
            : openClawPosture;
      if (openClawGuard && action === "unlock" && options.timerDiesAfterUnlock) {
        fakeTimerAlive = false;
      }
      const successResult = {
        status: 0,
        signal: null,
        stdout: readsStateLockPlan
          ? `${JSON.stringify(stateLockPlan)}\n`
          : action
            ? `${JSON.stringify({
                type: "result",
                action,
                status: "ok",
                ...(openClawGuard
                  ? {
                      configDir: "/sandbox/.openclaw",
                      files: ["openclaw.json", ".config-hash"],
                      chattrApplied: action === "lock",
                    }
                  : { issueCount: 0 }),
              })}\n`
            : "",
        stderr: "",
        pid: 0,
        output: [],
      };
      return (shouldFailOpenClawGuard ? failureResult : successResult) as never;
    },
  );
  vi.spyOn(dockerExec, "dockerExecFileSync").mockImplementation((argv: unknown) => {
    const args = Array.isArray(argv) ? argv.map(String) : [];
    const hermesGuard = args.some((arg) => arg.endsWith("hermes-runtime-config-guard.py"));
    const hermesLockToken = "a".repeat(64);
    if (hermesGuard && args.includes("--help")) {
      return [
        "begin-shields-transition",
        "run-state-dir-transition",
        "apply-shields-transition",
        "finish-shields-transition",
        "prepare-shields-abort",
        "abort-shields-transition",
        "--rollback-shields-mode",
        "--state-lock-plan-json",
      ].join("\n");
    }
    if (hermesGuard && args.includes("begin-shields-transition")) {
      return `lock_token=${hermesLockToken} original_locked=1`;
    }
    if (hermesGuard && args.includes("apply-shields-transition")) {
      return "shields_mode=mutable chattr_applied=0";
    }
    return options.dockerExecFileSync
      ? options.dockerExecFileSync(argv)
      : args.includes("sha256sum")
        ? "a".repeat(64) + `  ${resolvedAgentConfig.configPath}\n`
        : args.includes("lsattr") && options.confirmOpenClawInodeFlags
          ? `${openClawPosture === "locked" ? "----i---------e-----" : "----------------------"} ${String(args.at(-1))}\n`
          : args.includes("stat")
            ? args.at(-1) === "/sandbox"
              ? openClawPosture === "locked"
                ? "1775 root:sandbox\n"
                : "755 sandbox:sandbox\n"
              : args.at(-1) === resolvedAgentConfig.configDir
                ? openClawPosture === "locked"
                  ? "755 root:root\n"
                  : resolvedAgentConfig.agentName === "hermes"
                    ? "3770 sandbox:sandbox\n"
                    : "2770 sandbox:sandbox\n"
                : openClawPosture === "locked"
                  ? "444 root:root\n"
                  : resolvedAgentConfig.agentName === "hermes"
                    ? "640 sandbox:sandbox\n"
                    : "660 sandbox:sandbox\n"
            : "";
  });
  const auditSpy = vi.spyOn(audit, "appendAuditEntry").mockImplementation(() => undefined);
  vi.spyOn(relockReconfirm, "waitForHermesInferenceRouteConvergence").mockReturnValue({
    ok: true,
    attempts: 1,
    httpStatus: 200,
  });
  if (options.timerAuthorityRevokedSequence) {
    const timerAuthorityRevocations = [...options.timerAuthorityRevokedSequence];
    const finalTimerAuthorityRevocation = timerAuthorityRevocations.at(-1) ?? true;
    const nextTimerAuthorityRevocation = () =>
      timerAuthorityRevocations.shift() ?? finalTimerAuthorityRevocation;
    vi.spyOn(timerControl, "killTimer").mockImplementation(() => {
      const authorityRevoked = nextTimerAuthorityRevocation();
      return {
        authorityRevoked,
        markerFound: true,
        markerPid: 4242,
        wasAlive: false,
        terminated: false,
        warnings: authorityRevoked
          ? []
          : ["Failed to remove shields timer marker: permission denied"],
      };
    });
    vi.spyOn(timerControl, "clearTimerMarkerGeneration").mockImplementation(() =>
      nextTimerAuthorityRevocation()
        ? { status: "removed" }
        : {
            status: "failed",
            warning: "Failed to remove shields timer marker: permission denied",
          },
    );
  }
  const cleanupTempDirSpy = vi.spyOn(tempFiles, "cleanupTempDir");
  vi.spyOn(stateDirLock, "stateLockPlanCompatibilityIssues").mockReturnValue([]);
  const prepareStateSaveFailure = options.failStateSave
    ? () =>
        fs.mkdirSync(path.join(tmpDir, ".nemoclaw", "state", "shields-openclaw.json"), {
          recursive: true,
        })
    : () => undefined;
  const buildRuntimePermissivePolicy = permissiveRuntime.buildRuntimePermissivePolicy;
  vi.spyOn(permissiveRuntime, "buildRuntimePermissivePolicy").mockImplementation(
    (basePath, deps) => {
      const runtimePolicy = buildRuntimePermissivePolicy(basePath, deps);
      prepareStateSaveFailure();
      return runtimePolicy;
    },
  );

  if (options.failPolicyRejectionStateClear || options.failPolicyRejectionTransitionWrite) {
    const statePath = path.join(tmpDir, ".nemoclaw", "state", "shields-openclaw.json");
    const transitionPrefix = path.join(
      tmpDir,
      ".nemoclaw",
      "state",
      "shields-transition-openclaw-",
    );
    const originalRenameSync = fs.renameSync.bind(fs);
    let stateWrites = 0;
    let transitionWrites = 0;
    vi.spyOn(fs, "renameSync").mockImplementation((oldPath, newPath) => {
      const destination = String(newPath);
      if (
        options.failPolicyRejectionStateClear &&
        destination === statePath &&
        ++stateWrites === 2
      ) {
        throw new Error("state cleanup denied");
      }
      if (
        options.failPolicyRejectionTransitionWrite &&
        destination.startsWith(transitionPrefix) &&
        ++transitionWrites === 2
      ) {
        throw new Error("transition update denied");
      }
      return originalRenameSync(oldPath, newPath);
    });
  }

  const shields = requireDist(shieldsModulePath);
  logSpy.mockClear();
  errorSpy.mockClear();
  auditSpy.mockClear();
  runCaptureSpy.mockClear();
  return {
    applyShieldsPolicySnapshot: shields.applyShieldsPolicySnapshot,
    auditSpy,
    clearShieldsState: shields.clearShieldsState,
    cleanupTempDirSpy,
    dockerSpawnCalls,
    errorSpy,
    getShieldsPosture: shields.getShieldsPosture,
    getOpenClawPosture: () => openClawPosture,
    logSpy,
    policyStateSpy,
    policyVerificationSpy,
    policyRecoveryAuthoritySpy,
    policySetBodies,
    runCaptureSpy,
    runSpy,
    shieldsDown: shields.shieldsDown,
    shieldsStatus: shields.shieldsStatus,
    shieldsUp: shields.shieldsUp,
    isShieldsDown: shields.isShieldsDown,
    synchronizeAutoRestoreWithShieldsDown: shields.synchronizeAutoRestoreWithShieldsDown,
  };
}
