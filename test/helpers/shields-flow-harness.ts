// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { expect, type MockInstance, vi } from "vitest";
import YAML from "yaml";
import { buildMcpBridgePolicyYaml } from "../../src/lib/actions/sandbox/mcp-bridge-policy-render";
import type { SandboxEntry } from "../../src/lib/state/registry";

const shieldsModulePath = "./index.js";

export type ShieldsFlowHarness = {
  applyShieldsPolicySnapshot: typeof import("../../src/lib/shields/index.js").applyShieldsPolicySnapshot;
  auditSpy: MockInstance;
  cleanupTempDirSpy: MockInstance;
  dockerSpawnCalls: Array<{ args: string[]; timeout: number | undefined }>;
  errorSpy: MockInstance;
  getShieldsPosture: typeof import("../../src/lib/shields/index.js").getShieldsPosture;
  getOpenClawPosture: () => "locked" | "mutable";
  logSpy: MockInstance;
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
  timerAuthorityRevokedSequence?: readonly boolean[];
};

export function managedMcpPolicy(server: string, address = "8.8.8.8") {
  const content = buildMcpBridgePolicyYaml(
    server,
    `https://${server}.example.com/mcp`,
    "hermes-config",
    { addresses: [address] },
  );
  const entries = Object.entries(YAML.parse(content).network_policies as Record<string, unknown>);
  expect(entries, `rendered MCP policies for ${server}`).toHaveLength(1);
  const [key, networkPolicy] = entries[0]!;
  return { content, key, networkPolicy, server };
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
        policies.map(({ server }) => [
          server,
          {
            server,
            agent: "hermes",
            adapter: "hermes-config",
            url: `https://${server}.example.com/mcp`,
            env: ["MCP_SECRET"],
            policyName: `mcp-bridge-${server}`,
            addedAt: "2026-07-30T00:00:00.000Z",
          },
        ]),
      ),
    },
  };
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
  delete require.cache[requireDist.resolve("../sandbox/privileged-exec.js")];
  delete require.cache[requireDist.resolve("../cli/branding.js")];
  const timerControl = requireDist(
    "./timer-control.js",
  ) as typeof import("../../src/lib/shields/timer-control.js");
  if (options.processStartIdentity !== undefined) {
    vi.spyOn(timerControl, "readProcessStartIdentity").mockReturnValue(
      options.processStartIdentity,
    );
  }
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
  const privilegedExec = requireDist("../sandbox/privileged-exec.js");
  const dockerExec = requireDist("../adapters/docker/exec.js");
  const audit = requireDist("./audit.js");
  const tempFiles = requireDist("../onboard/temp-files.js");
  const stateDirLock = requireDist("./state-dir-lock.js");
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
  options.fork && vi.spyOn(childProcess, "fork").mockImplementation(options.fork);
  vi.spyOn(policy, "buildPolicyGetCommand").mockReturnValue(["openshell", "policy", "get"]);
  vi.spyOn(policy, "buildPolicySetCommand").mockImplementation((file: unknown) => {
    recordPolicySetBody(policySetBodies, file);
    return ["openshell", "policy", "set"];
  });
  vi.spyOn(policy, "parseCurrentPolicy").mockImplementation((raw: unknown) => String(raw));
  vi.spyOn(policy, "resolvePermissivePolicyPath").mockReturnValue(
    path.join(tmpDir, "permissive.yaml"),
  );
  fs.writeFileSync(path.join(tmpDir, "permissive.yaml"), "version: 1\nnetwork_policies: {}\n");
  vi.spyOn(agentConfig, "resolveAgentConfig").mockReturnValue({
    agentName: "openclaw",
    configDir: "/sandbox/.openclaw",
    configFile: "openclaw.json",
    configPath: "/sandbox/.openclaw/openclaw.json",
    format: "json",
    stateLockPlan,
    stateLockPlanInImage: true,
  });
  vi.spyOn(registry, "getSandbox").mockReturnValue(
    options.sandboxEntry ?? { name: "openclaw", openshellDriver: "docker" },
  );
  vi.spyOn(registry, "listSandboxes").mockReturnValue({ sandboxes: [{ name: "openclaw" }] });
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
    return options.dockerExecFileSync
      ? options.dockerExecFileSync(argv)
      : args.includes("sha256sum")
        ? "a".repeat(64) + "  /sandbox/.openclaw/openclaw.json\n"
        : args.includes("lsattr") && options.confirmOpenClawInodeFlags
          ? `${openClawPosture === "locked" ? "----i---------e-----" : "----------------------"} ${String(args.at(-1))}\n`
          : args.includes("stat")
            ? args.at(-1) === "/sandbox"
              ? openClawPosture === "locked"
                ? "1775 root:sandbox\n"
                : "755 sandbox:sandbox\n"
              : args.at(-1) === "/sandbox/.openclaw"
                ? openClawPosture === "locked"
                  ? "755 root:root\n"
                  : "2770 sandbox:sandbox\n"
                : openClawPosture === "locked"
                  ? "444 root:root\n"
                  : "660 sandbox:sandbox\n"
            : "";
  });
  const auditSpy = vi.spyOn(audit, "appendAuditEntry").mockImplementation(() => undefined);
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

  if (options.failPolicyRejectionStateClear) {
    const statePath = path.join(tmpDir, ".nemoclaw", "state", "shields-openclaw.json");
    const originalWriteFileSync = fs.writeFileSync.bind(fs);
    let stateWrites = 0;
    vi.spyOn(fs, "writeFileSync").mockImplementation(((file, data, writeOptions) => {
      if (String(file) === statePath && ++stateWrites === 2) {
        throw new Error("state cleanup denied");
      }
      return originalWriteFileSync(file, data, writeOptions);
    }) as typeof fs.writeFileSync);
  }

  if (options.failPolicyRejectionTransitionWrite) {
    const transitionPrefix = path.join(
      tmpDir,
      ".nemoclaw",
      "state",
      "shields-transition-openclaw-",
    );
    const originalRenameSync = fs.renameSync.bind(fs);
    let transitionWrites = 0;
    vi.spyOn(fs, "renameSync").mockImplementation((oldPath, newPath) => {
      if (String(newPath).startsWith(transitionPrefix) && ++transitionWrites === 2) {
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
    cleanupTempDirSpy,
    dockerSpawnCalls,
    errorSpy,
    getShieldsPosture: shields.getShieldsPosture,
    getOpenClawPosture: () => openClawPosture,
    logSpy,
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
