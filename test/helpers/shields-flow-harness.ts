// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { expect, type MockInstance, vi } from "vitest";
import YAML from "yaml";
import { buildMcpBridgePolicyYaml } from "../../src/lib/actions/sandbox/mcp-bridge-policy-render";
import type { SandboxPolicyAuthorityInspection } from "../../src/lib/adapters/openshell/policy-authority";
import type { AgentConfigTarget } from "../../src/lib/sandbox/agent-config";
import type { SandboxEntry } from "../../src/lib/state/registry";

const shieldsModulePath = "./index.js";

export const externalPolicyAuthorityInspection = {
  authority: "externally-managed" as const,
  effectivePolicy: { version: 1, network_policies: {} },
  policyIdentity: { hash: "external-policy-hash", activeVersion: 1 },
};

const managedPolicyCreationReceipt = {
  schemaVersion: 1 as const,
  origin: "sandbox-create" as const,
  gatewayName: "nemoclaw",
  gatewayPort: 50_065,
  sandboxName: "openclaw",
  lifecycleGeneration: "11111111-1111-4111-8111-111111111111",
  sandboxIdentityFingerprint: "a".repeat(64),
  policyHash: "managed-policy-hash",
  policyVersion: 1,
};

export const managedPolicyMutationAuthority = {
  authority: "nemoclaw-managed" as const,
  authorityRecordedNow: false,
  gatewayName: "nemoclaw",
  inspection: {
    authority: "nemoclaw-managed" as const,
    effectivePolicy: { version: 1, network_policies: {} },
    policyIdentity: { hash: "managed-policy-hash", activeVersion: 1 },
  },
  policyCreationReceipt: managedPolicyCreationReceipt,
};

export function bindManagedPolicyMutationAuthority(
  policy: typeof import("../../src/lib/policy"),
): MockInstance[] {
  return [
    vi
      .spyOn(policy, "inspectPolicyMutationAuthority")
      .mockReturnValue(managedPolicyMutationAuthority),
    vi
      .spyOn(policy, "inspectPolicyRecoveryAuthority")
      .mockReturnValue(managedPolicyMutationAuthority),
    vi
      .spyOn(policy, "recheckPolicyMutationAuthority")
      .mockReturnValue(managedPolicyMutationAuthority),
    vi.spyOn(policy, "finalizePolicyMutationReceipt").mockImplementation(() => undefined),
  ];
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
  policyAuthoritySpy: MockInstance;
  policyReceiptFinalizeSpy: MockInstance;
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
  policyAuthorityInspection?: SandboxPolicyAuthorityInspection;
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
  run?: (cmd: unknown) => { status: number };
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
  return { content, key, networkPolicy, providerName, server };
}

export function managedMcpSandbox(
  policies: Array<ReturnType<typeof managedMcpPolicy>>,
): SandboxEntry {
  return {
    name: "openclaw",
    openshellDriver: "docker",
    customPolicies: policies.map(({ content, server }) => ({
      name: `mcp-bridge-${server}`,
      content,
      sourcePath: "generated:nemoclaw-mcp-bridge",
    })),
    mcp: {
      bridges: Object.fromEntries(
        policies.map(({ providerName, server }) => [
          server,
          {
            server,
            agent: "hermes",
            adapter: "hermes-config",
            url: `https://${server}.example.com/mcp`,
            env: ["MCP_SECRET"],
            providerName,
            policyName: `mcp-bridge-${server}`,
            addedAt: "2026-07-30T00:00:00.000Z",
          },
        ]),
      ),
    },
  };
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
  delete require.cache[requireDist.resolve("../adapters/openshell/policy-authority.js")];
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
  const agentConfig = requireDist("../sandbox/agent-config.js");
  const registry = requireDist("../state/registry.js");
  const policyAuthority = requireDist(
    "../adapters/openshell/policy-authority.js",
  ) as typeof import("../../src/lib/adapters/openshell/policy-authority.js");
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
  vi.spyOn(policy, "buildPolicyGetCommand").mockImplementation(
    (_sandboxName: unknown, gatewayName: unknown) => [
      "openshell",
      "policy",
      "get",
      ...(typeof gatewayName === "string" ? ["-g", gatewayName] : []),
    ],
  );
  vi.spyOn(policy, "buildPolicySetCommand").mockImplementation(
    (file: unknown, _sandbox, gateway) => {
      recordPolicySetBody(policySetBodies, file);
      return [
        "openshell",
        "policy",
        "set",
        ...(typeof gateway === "string" ? ["-g", gateway] : []),
      ];
    },
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
      ? { policyAuthority: "nemoclaw-managed", ...options.sandboxEntry }
      : {
          name: options.sandboxName ?? "openclaw",
          agent: resolvedAgentConfig.agentName,
          openshellDriver: "docker",
          policyAuthority: "nemoclaw-managed",
        },
  );
  vi.spyOn(registry, "updateSandbox").mockReturnValue(true);
  const policyAuthorityInspection = options.policyAuthorityInspection ?? {
    authority: "nemoclaw-managed" as const,
    effectivePolicy: YAML.parse(
      options.livePolicyYaml ?? "version: 1\nnetwork_policies:\n  test: {}\n",
    ) as Record<string, unknown>,
    policyIdentity: { hash: "managed-policy-hash", activeVersion: 1 },
  };
  vi.spyOn(policyAuthority, "inspectSandboxPolicyAuthority").mockReturnValue(
    policyAuthorityInspection,
  );
  const policyMutationAuthority = {
    authority: policyAuthorityInspection.authority,
    authorityRecordedNow: false,
    gatewayName: options.sandboxEntry?.gatewayName ?? "nemoclaw",
    inspection: policyAuthorityInspection,
    policyCreationReceipt:
      policyAuthorityInspection.authority === "nemoclaw-managed"
        ? managedPolicyCreationReceipt
        : null,
  };
  const policyAuthoritySpy = vi
    .spyOn(policy, "inspectPolicyMutationAuthority")
    .mockReturnValue(policyMutationAuthority);
  const policyRecoveryAuthoritySpy = vi
    .spyOn(policy, "inspectPolicyRecoveryAuthority")
    .mockReturnValue(policyMutationAuthority);
  vi.spyOn(policy, "recheckPolicyMutationAuthority").mockReturnValue(policyMutationAuthority);
  const policyReceiptFinalizeSpy = vi
    .spyOn(policy, "finalizePolicyMutationReceipt")
    .mockImplementation(() => undefined);
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
  vi.spyOn(privilegedExec, "privilegedSandboxExecArgv").mockImplementation(
    (_sandboxName: unknown, cmd: unknown) =>
      options.directSandboxUnavailable
        ? throwHarnessError(directSandboxUnavailableError)
        : [
            "exec",
            "--user",
            "root",
            "openshell-openclaw",
            ...(Array.isArray(cmd) ? cmd.map(String) : []),
          ],
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
    vi.spyOn(timerControl, "killTimer").mockImplementation(() => {
      const authorityRevoked = timerAuthorityRevocations.shift() ?? finalTimerAuthorityRevocation;
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
    policyAuthoritySpy,
    policyReceiptFinalizeSpy,
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
