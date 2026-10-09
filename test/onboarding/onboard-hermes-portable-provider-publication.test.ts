// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, it, vi } from "vitest";

import { runBoundedOnboardScript } from "../helpers/onboard-child-process-harness";
import { writeOkOpenshell } from "../helpers/onboard-openshell-fixture";
import { onboardScriptMocksPath } from "../helpers/onboard-split-context";

const repoRoot = path.join(import.meta.dirname, "../..");

beforeEach(() => {
  vi.stubEnv("NEMOCLAW_TEST_MANAGED_IMAGE_CATALOG", "1");
  vi.stubEnv("NEMOCLAW_SANDBOX_PREBUILD", "1");
});

type ProviderBoundaryMode =
  | "create"
  | "deferred"
  | "ollama-create"
  | "ordinary-resume"
  | "superseded";

type ProviderBoundaryResult = {
  events: string[];
  firstError: string | null;
  gpuCreateCalls: number;
  portableLockInvocations: number;
  portableTransactions: number;
  providerCalls: string[][];
  result: string;
};

const expectedProviderCalls = [
  ["provider", "get", "-g", "nemoclaw", "nvidia-prod"],
  ["provider", "update", "-g", "nemoclaw", "nvidia-prod"],
];

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function writePortableLifecycleOpenShell(
  executablePath: string,
  statePath: string,
  invocationPath: string,
): void {
  fs.writeFileSync(
    executablePath,
    `#!/bin/bash
set -eu
printf '%s\\n' "PWD=$PWD MARKER=\${OPENSHELL_TEST_MARKER:-} ARGS=$*" >> ${shellQuote(invocationPath)}
if [ "\${1:-}" = "--version" ]; then
  printf '%s\\n' 'openshell 0.0.116'
  exit 0
fi
if [ "\${1:-}" = "sandbox" ] && [ "\${2:-}" = "list" ]; then
  printf '%s\\n' '[]'
  exit 0
fi
if [ "\${1:-}" = "sandbox" ] && [ "\${2:-}" = "get" ]; then
  if [ -f ${shellQuote(statePath)} ]; then
    printf '%s\\n' '{"name":"my-assistant","id":"sandbox-id-1","phase":"Ready"}'
    exit 0
  fi
  printf '%s\\n' "Error: sandbox 'my-assistant' not found" >&2
  exit 1
fi
if [ "\${1:-}" = "sandbox" ] && [ "\${2:-}" = "create" ]; then
  : > ${shellQuote(statePath)}
  printf '%s\\n' 'Created sandbox: my-assistant'
  exit 0
fi
if [ "\${1:-}" = "policy" ] && [ "\${2:-}" = "get" ]; then
  printf 'version: 1\\nnetwork_policies: {}\\n'
  exit 0
fi
if [ "\${1:-}" = "sandbox" ] && [ "\${2:-}" = "exec" ]; then
  printf '%s\\n' '200'
  exit 0
fi
printf '%s\\n' "unexpected openshell invocation: $*" >&2
exit 1
`,
    { mode: 0o700 },
  );
}

function runProviderBoundary(mode: ProviderBoundaryMode): ProviderBoundaryResult {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-provider-boundary-"));
  const fakeBin = path.join(tmpDir, "bin");
  const scriptPath = path.join(tmpDir, "provider-boundary.js");
  fs.mkdirSync(fakeBin, { recursive: true });
  writeOkOpenshell(fakeBin);

  const modulePath = (relativePath: string) =>
    JSON.stringify(path.join(repoRoot, "src", "lib", relativePath));
  const script = String.raw`
const fixtureMocks = require(${onboardScriptMocksPath});
fixtureMocks.mockStandaloneGatewayTeardownAuthority();
fixtureMocks.installForwardServiceReachabilityFixture();
const assert = require("node:assert/strict");
const fs = require("node:fs");
const runner = require(${modulePath("runner.ts")});
const registry = require(${modulePath("state/registry.ts")});
const preflight = require(${modulePath("onboard/preflight.ts")});
const credentials = require(${modulePath("credentials/store.ts")});
const agentOnboardId = require.resolve(${modulePath("agent/onboard.ts")});
const createdSandboxFinalizationId = require.resolve(${modulePath("onboard/created-sandbox-finalization.ts")});
const dashboardPortId = require.resolve(${modulePath("onboard/dashboard-port.ts")});
const dashboardRuntimeId = require.resolve(${modulePath("onboard/dashboard-runtime.ts")});
const sandboxGpuCreateFlowId = require.resolve(${modulePath("onboard/sandbox-gpu-create-flow.ts")});
const lifecycleLock = require(${modulePath("state/mcp-lifecycle-lock.ts")});
const sandboxProviderCleanupId = require.resolve(${modulePath("onboard/sandbox-provider-cleanup.ts")});
const normalize = (command) => Array.isArray(command) ? command.map(String) : [String(command)];
const events = [];
const providerCalls = [];
let gpuCreateCalls = 0;
let portableLockInvocations = 0;
let portableTransactions = 0;
const portableMode = ${JSON.stringify(mode !== "ordinary-resume")};
const inferenceProvider = ${JSON.stringify(
    mode === "ollama-create" ? "ollama-local" : "nvidia-prod",
  )};
const customDockerfile = process.env.HOME + "/Dockerfile";
fs.writeFileSync(customDockerfile, [
  "FROM scratch",
  "ARG NEMOCLAW_TOOL_DISCLOSURE=progressive",
  "ENV NEMOCLAW_TOOL_DISCLOSURE=" + "$" + "{NEMOCLAW_TOOL_DISCLOSURE}",
  "",
].join("\n"));
const sandboxName = "my-assistant";
const gatewayName = "nemoclaw";
const createdSandbox = fixtureMocks.createCreatedSandboxFixture({
  sandboxName,
  sandboxId: "sbx-hermes-provider-boundary",
  gatewayName,
});
createdSandbox.installRuntimeObservation();

runner.run = (command) => {
  const args = normalize(command);
  const providerIndex = args.indexOf("provider");
  const providerArgs = providerIndex < 0 ? null : args.slice(providerIndex);
  const text = providerArgs?.join(" ") ?? args.join(" ");
  if (providerArgs) providerCalls.push(providerArgs);
  const providerGet = fixtureMocks.mockNvidiaProviderGetRun(command, gatewayName);
  if (providerGet !== null) return providerGet;
  if (text === "provider update -g nemoclaw nvidia-prod") {
    events.push("provider:update");
    return { status: 0, stdout: "" };
  }
  return createdSandbox.run(command) ?? { status: 0, stdout: "" };
};
runner.runCapture = (command) => {
  const captured = createdSandbox.capture(command);
  if (captured !== null) return captured;
  const mocked = fixtureMocks.mockOnboardRunCapture(command, { defaultCurlOutput: "ok" });
  if (mocked !== null) return mocked;
  if (normalize(command).join(" ").includes("forward list")) return "";
  return "";
};
fixtureMocks.mockDockerSandboxLifecycleReleaseFromRunner();
preflight.checkPortAvailable = async () => ({ ok: true });
credentials.prompt = async () => "";
registry.registerSandbox = () => true;
registry.updateSandbox = () => true;
registry.setDefault = () => true;
registry.removeSandbox = () => true;
const createFixture = fixtureMocks.installVerifiedSandboxCreateFixture(registry, {
  sandboxName,
  gatewayName,
  agentName: portableMode ? "hermes" : "langchain-deepagents-code",
  provider: inferenceProvider,
  model: "gpt-5.4",
});
if (!portableMode) {
  const getSandbox = registry.getSandbox;
  registry.getSandbox = (name) => {
    const entry = getSandbox(name);
    return entry ? { ...entry, gatewayPort: 8080 } : entry;
  };
}
const registerSandbox = registry.registerSandbox;
let rejectRegistration = !portableMode;
registry.registerSandbox = (entry) => {
  if (rejectRegistration) {
    rejectRegistration = false;
    throw new Error("injected registry publication failure");
  }
  return registerSandbox(entry);
};

const portableRuntimeContext = {
  authority: {
    schemaVersion: 1,
    kind: "podman",
    ownership: "current-user",
    uid: typeof process.getuid === "function" ? process.getuid() : 1000,
    homeDir: process.env.HOME,
    configHome: process.env.HOME + "/.config",
    runtimeDir: process.env.HOME + "/runtime",
    socketPath: process.env.HOME + "/runtime/podman.sock",
  },
  environmentScope: {},
};
const dashboardPort = require(dashboardPortId);
require.cache[dashboardPortId].exports = {
  ...dashboardPort,
  reserveCreateSandboxDashboardPort: async (input) => {
    const effectivePort = input.controlUiPort ?? input.defaultPort ?? 18789;
    return {
      preferredPort: effectivePort,
      effectivePort,
      chatUiUrl: "http://127.0.0.1:" + effectivePort,
      reservation: null,
    };
  },
};
const dashboardRuntime = require(dashboardRuntimeId);
require.cache[dashboardRuntimeId].exports = {
  ...dashboardRuntime,
  shouldManageDashboardForAgent: () => false,
};
const createdSandboxFinalization = require(createdSandboxFinalizationId);
require.cache[createdSandboxFinalizationId].exports = {
  ...createdSandboxFinalization,
  completeOrdinaryOnboardSandboxCreation: ({ sandboxName }) => sandboxName,
};
const sandboxProviderCleanup = require(sandboxProviderCleanupId);
require.cache[sandboxProviderCleanupId].exports = {
  ...sandboxProviderCleanup,
  runSandboxProviderPreDeleteCleanup: () => ({ detached: [], failures: [] }),
};
const agentOnboard = require(agentOnboardId);
const createScopedEntryPoints = agentOnboard.createHermesApiPortScopedSandboxEntryPoints;
require.cache[agentOnboardId].exports = {
  ...agentOnboard,
  createHermesApiPortScopedSandboxEntryPoints: (deps) => createScopedEntryPoints({
    ...deps,
    resolvePortableRuntimeContext: () => portableRuntimeContext,
  }),
};

const sandboxGpuCreateFlow = require(sandboxGpuCreateFlowId);
require.cache[sandboxGpuCreateFlowId].exports = {
  ...sandboxGpuCreateFlow,
  runHermesPortableOnboardingFromOnboard: async (input) => {
    portableTransactions += 1;
    events.push("portable:transaction");
    await input.withLifecycleLock(sandboxName, async () => {
      portableLockInvocations += 1;
      const portableStateDir = process.env.HOME + "/.nemoclaw/state";
      assert.equal(lifecycleLock.isMcpLifecycleLockHeld(sandboxName, portableStateDir), true);
    });
    if (${JSON.stringify(mode)} === "superseded") return { created: false };
    const attemptRequest = {
      ...input.createRequest,
      labels: {
        ...input.createRequest.labels,
        "ai.nvidia.nemoclaw.create-attempt": "a".repeat(62),
      },
    };
    const created = await input.createSandbox(
      attemptRequest,
      undefined,
      undefined,
      async () => ({ status: 0, output: "created", sawProgress: true }),
      input.createPolicyPath,
    );
    return { created: true, value: created };
  },
  runSandboxGpuCreateFlow: async (input) => {
    gpuCreateCalls += 1;
    events.push(input.resumeVerifiedCreate ? "sandbox:resume" : "sandbox:create");
    if (!input.resumeVerifiedCreate) {
      const observedCreateArgv = [
            "openshell",
            "sandbox",
            "create",
            "-g",
            input.createRequest.target.gatewayName,
            "--from",
            input.createRequest.source.reference,
            "--name",
            input.createRequest.sandboxName,
            ...Object.entries(input.createRequest.labels ?? {}).flatMap(([name, value]) => [
              "--label",
              name + "=" + value,
            ]),
            "--",
            ...input.createRequest.startupCommand,
          ];
      if (!observedCreateArgv.some((value) => value.startsWith("ai.nvidia.nemoclaw.create-attempt="))) {
        const separator = observedCreateArgv.indexOf("--");
        observedCreateArgv.splice(
          separator < 0 ? observedCreateArgv.length : separator,
          0,
          "--label",
          "ai.nvidia.nemoclaw.create-attempt=" + "a".repeat(62),
        );
      }
      createdSandbox.create(observedCreateArgv);
    }
    const identity = {
      sandboxId: createdSandbox.state.sandboxId,
      liveIdentityFingerprint: require("node:crypto")
        .createHash("sha256")
        .update(createdSandbox.state.sandboxId)
        .digest("hex"),
      createAttemptNonce: "a".repeat(62),
      route: "native",
    };
    await input.verifyCreatedSandboxBeforeEffects(identity);
    events.push("sandbox:identity-verified");
    return {
      ...(input.resumeVerifiedCreate
        ? { origin: "resumed" }
        : {
            origin: "created",
            createResult: { status: 0, output: "created", sawProgress: true },
            firstCreateOutput: "created",
          }),
      runtimePatch: { applied: false },
      route: "native",
      registryImageRef: null,
      lifecycleRegistrationFields: input.lifecycleGeneration
        ? { lifecycleGeneration: input.lifecycleGeneration }
        : {},
    };
  },
};

const { createSandbox } = require(${modulePath("onboard.ts")});
const { loadAgent } = require(${modulePath("agent/defs.ts")});
const { resolveSandboxCreateIntent } = require(${modulePath("onboard/sandbox-create-intent.ts")});
const { resolveSandboxGpuConfig } = require(${modulePath("onboard/sandbox-gpu-mode.ts")});
(async () => {
  process.env.OPENSHELL_GATEWAY = gatewayName;
  const createArgs = fixtureMocks.sandboxCreateArgsWithVerifiedReservation(
    [null, "gpt-5.4", "nvidia-prod", null, sandboxName, null, null, portableMode ? null : customDockerfile, loadAgent(portableMode ? "hermes" : "langchain-deepagents-code"), null, null, null, []],
    createFixture,
  );
  if (portableMode) {
    createArgs[15] = {
      ...createArgs[15],
      deferSandboxEffectsUntilIdentityVerification: ${JSON.stringify(mode === "deferred")},
      resolved: resolveSandboxCreateIntent({
        basePolicyPath: ${JSON.stringify(path.join(repoRoot, "agents/hermes/policy-additions.yaml"))},
        sandboxName,
        inferenceProvider,
        channels: [],
        enabledChannels: [],
        disabledChannelNames: new Set(),
        messagingProviderRequests: [],
        primaryMessagingCredentialEnvKeys: [],
        reusableMessagingChannels: [],
        reusableMessagingProviders: [],
        hermesToolGateways: [],
        sandboxGpuConfig: resolveSandboxGpuConfig(null, { env: {} }),
        gpuCreateArgs: [],
        gpuRoutePlan: "none",
        sandboxGpuLogMessage: null,
        agentName: "hermes",
      }),
    };
  }
  let firstError = null;
  if (!portableMode) {
    try {
      await createSandbox(...createArgs);
    } catch (error) {
      firstError = error instanceof Error ? error.message : String(error);
    }
    if (!firstError) throw new Error("expected the first verified create to fail");
  }
  const result = await createSandbox(...createArgs);
  console.log(
    JSON.stringify({
      events,
      firstError,
      gpuCreateCalls,
      portableLockInvocations,
      portableTransactions,
      providerCalls,
      result,
    }),
  );
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
  fs.writeFileSync(scriptPath, script);

  const result = runBoundedOnboardScript(scriptPath, {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: tmpDir,
      XDG_CONFIG_HOME: path.join(tmpDir, ".config"),
      XDG_RUNTIME_DIR: path.join(tmpDir, "runtime"),
      PATH: `${fakeBin}:${process.env.PATH || ""}`,
      NEMOCLAW_EXPERIMENTAL_PROFILE: mode === "ordinary-resume" ? "default" : "portable",
      NEMOCLAW_NON_INTERACTIVE: "1",
      NEMOCLAW_SANDBOX_PREBUILD: "0",
      NEMOCLAW_TEST_MANAGED_IMAGE_CATALOG: "0",
    },
  });

  assert.equal(result.status, 0, result.output);
  return JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "null") as ProviderBoundaryResult;
}

describe("sandbox-create provider publication branches", () => {
  it(
    "carries the real Portable caller request through the receipt-owned lifecycle adapter (#12119)",
    { timeout: 60_000 },
    async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-real-boundary-"));
      const executablePath = path.join(tmpDir, "openshell");
      const statePath = path.join(tmpDir, "sandbox-created");
      const invocationPath = path.join(tmpDir, "openshell-invocations.log");
      const policyPath = path.join(tmpDir, "create-policy.yaml");
      const sandboxName = "my-assistant";
      const gatewayName = "nemoclaw";
      const containerId = "a".repeat(64);
      const imageId = "b".repeat(64);
      const sandboxId = "sandbox-id-1";
      const liveIdentityFingerprint = createHash("sha256").update(sandboxId).digest("hex");
      const startupCommand = [
        "env",
        "NEMOCLAW_HERMES_API_PORT=8642",
        `NEMOCLAW_SANDBOX_NAME=${sandboxName}`,
        "/usr/local/bin/nemoclaw-start",
      ];
      const routeSelection = {
        provider: "nvidia-prod",
        model: "gpt-5.4",
        endpointUrl: null,
        endpointSource: null,
        credentialEnv: null,
        preferredInferenceApi: null,
        compatibleEndpointReasoning: null,
        compatibleEndpointReasoningEffort: null,
        nimContainer: null,
      } as const;
      const routeRegistryFields = {
        provider: routeSelection.provider,
        model: routeSelection.model,
        endpointUrl: routeSelection.endpointUrl,
        endpointSource: routeSelection.endpointSource,
        credentialEnv: routeSelection.credentialEnv,
        preferredInferenceApi: routeSelection.preferredInferenceApi,
      };
      const reservationSessionId = "portable-session";
      const uid = process.getuid?.() ?? 0;
      const authorityDirectoryChain = (target: string) => {
        const entries = [];
        let directory = path.dirname(target);
        do {
          entries.push({
            device: "1",
            inode: String(entries.length + 10),
            mode: String(0o40700),
            ownerUid: String(uid),
            path: directory,
          });
          directory = path.dirname(directory);
        } while (directory !== entries.at(-1)?.path);
        return entries;
      };
      const runtimeDir = path.join("/run/user", String(uid));
      const socketPath = path.join(runtimeDir, "podman", "podman.sock");
      const socketAuthority = {
        directoryChain: authorityDirectoryChain(socketPath),
        device: "1",
        inode: "2",
        mode: String(0o140600),
        ownerUid: String(uid),
        socketPath,
      };
      const executableAuthority = {
        changedTimeNanoseconds: "1",
        device: "1",
        directoryChain: authorityDirectoryChain(executablePath),
        executablePath,
        inode: "3",
        mode: String(0o100700),
        modifiedTimeNanoseconds: "1",
        ownerUid: String(uid),
        sha256: "f".repeat(64),
        size: "1",
      };
      const podmanExecutableAuthority = {
        version: "5.7.0" as const,
        executable: {
          ...executableAuthority,
          executablePath: path.join(tmpDir, "podman"),
          directoryChain: authorityDirectoryChain(path.join(tmpDir, "podman")),
        },
      };
      let restartPolicy = "no";
      const podman = (args: readonly string[]) => {
        const operation = args[0] === "ps" ? "ps" : args.slice(0, 2).join(" ");
        const handlers = new Map([
          ["ps", () => ({ status: 0, stdout: `${containerId}\n`, stderr: "" })],
          [
            "container inspect",
            () => ({
              status: 0,
              stdout: JSON.stringify([
                {
                  Id: containerId,
                  Image: imageId,
                  Name: `openshell-default--${sandboxName}-${sandboxId}`,
                  Config: {
                    Labels: {
                      "openshell.managed": "true",
                      "openshell.ai/sandbox-id": sandboxId,
                      "openshell.ai/sandbox-name": sandboxName,
                      "openshell.ai/sandbox-namespace": "",
                      "openshell.ai/sandbox-workspace": "default",
                    },
                  },
                  State: { Running: true, Paused: false, Status: "running" },
                  HostConfig: { RestartPolicy: { Name: restartPolicy } },
                },
              ]),
              stderr: "",
            }),
          ],
          [
            "container update",
            () => {
              restartPolicy = "unless-stopped";
              return { status: 0, stdout: "", stderr: "" };
            },
          ],
        ]);
        return (
          handlers.get(operation)?.() ??
          (() => {
            throw new Error(`unexpected podman invocation: ${args.join(" ")}`);
          })()
        );
      };

      fs.chmodSync(tmpDir, 0o700);
      writePortableLifecycleOpenShell(executablePath, statePath, invocationPath);
      fs.writeFileSync(policyPath, "version: 1\nnetwork_policies: {}\n", { mode: 0o600 });
      vi.stubEnv("HOME", tmpDir);
      vi.stubEnv("XDG_CONFIG_HOME", path.join(tmpDir, ".config"));
      vi.stubEnv("XDG_RUNTIME_DIR", runtimeDir);
      const originalLstat = fs.lstatSync;
      const sharedTemporaryRoots = new Set([path.resolve("/tmp"), fs.realpathSync("/tmp")]);
      vi.spyOn(fs, "lstatSync").mockImplementation(((target, options) => {
        const stat = originalLstat(target, options as never);
        return sharedTemporaryRoots.has(path.resolve(String(target)))
          ? new Proxy(stat, {
              get(value, property) {
                const mode = BigInt(Reflect.get(value, "mode", value));
                return property === "mode" ? mode & ~0o22n : Reflect.get(value, property, value);
              },
            })
          : stat;
      }) as typeof fs.lstatSync);
      vi.resetModules();
      vi.doMock("../../src/lib/adapters/openshell/resolve-shared", async (importOriginal) => {
        const actual =
          await importOriginal<typeof import("../../src/lib/adapters/openshell/resolve-shared")>();
        return {
          ...actual,
          captureHermesPortableOpenShellExecutableAuthority: () => ({
            executable: executableAuthority,
            version: actual.HERMES_PORTABLE_OPENSHELL_VERSION,
          }),
          assertHermesPortableOpenShellExecutableAuthority: () => executablePath,
        };
      });
      vi.doMock("../../src/lib/adapters/podman", async (importOriginal) => {
        const actual = await importOriginal<typeof import("../../src/lib/adapters/podman")>();
        return {
          ...actual,
          capturePodmanSocketAuthority: () => socketAuthority,
          assertPodmanSocketAuthority: () => undefined,
        };
      });
      vi.doMock(
        "../../src/lib/onboard/experimental/hermes-portable-podman-authority",
        async (importOriginal) => {
          const actual =
            await importOriginal<
              typeof import("../../src/lib/onboard/experimental/hermes-portable-podman-authority")
            >();
          return {
            ...actual,
            captureHermesPortablePodmanExecutableAuthority: () => podmanExecutableAuthority,
            createHermesPortablePodmanCommandAuthority: () => ({
              engine: { capture: podman, assertAuthority: () => undefined },
              assertTransactionCurrent: () => undefined,
              assertCurrent: () => undefined,
            }),
          };
        },
      );

      try {
        const [{ loadAgent }, { registryEntryGatewayPort }, portable, lifecycleLock] =
          await Promise.all([
            import("../../src/lib/agent/defs"),
            import("../../src/lib/state/gateway-registry"),
            import("../../src/lib/onboard/experimental/hermes-portable-onboarding"),
            import("../../src/lib/state/mcp-lifecycle-lock-acquisition"),
          ]);
        const runtimeAuthority = {
          schemaVersion: 1 as const,
          kind: "podman" as const,
          ownership: "current-user" as const,
          uid,
          homeDir: tmpDir,
          configHome: path.join(tmpDir, ".config"),
          runtimeDir,
          socketPath: socketAuthority.socketPath,
        };
        const childEnv = {
          HOME: tmpDir,
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          XDG_CONFIG_HOME: runtimeAuthority.configHome,
          XDG_RUNTIME_DIR: runtimeAuthority.runtimeDir,
        };
        let registryEntry: Record<string, unknown> | null = {
          name: sandboxName,
          pendingRouteReservation: true,
          reservationSessionId,
          ...routeRegistryFields,
          gatewayName,
          hostLocalInferenceReceipt: "receipt-1",
        };
        let lifecycleRequest: Record<string, unknown> | null = null;
        const result = await portable.runHermesPortableOnboardingFromOnboard({
          sandboxName,
          gatewayName,
          lifecycleGeneration: "generation-1",
          portableRuntime: {
            authority: runtimeAuthority,
            environmentScope: {
              env: childEnv,
              createHermesPortablePodmanSourceEnvironment: () => childEnv,
              installRuntime: () => undefined,
              restore: () => undefined,
            },
          },
          createRequest: {
            sandboxName,
            target: { kind: "named", gatewayName },
            source: { reference: path.join(repoRoot, "agents/hermes/Dockerfile") },
            policyPath,
            startupCommand,
            environment: {
              HOME: tmpDir,
              PATH: process.env.PATH ?? "/usr/bin:/bin",
              OPENSHELL_TEST_MARKER: "typed-boundary",
            },
          },
          createPolicyPath: policyPath,
          startup: { agent: loadAgent("hermes"), sandboxName, startupArgv: startupCommand },
          inferenceRouteReservation: { sessionId: reservationSessionId, selection: routeSelection },
          withLifecycleLock: portable.bindHermesPortableOnboardingLifecycleLock(
            lifecycleLock.withMcpLifecycleLock,
          ),
          childEnv,
          openshellArgv: (args) => [executablePath, ...args],
          createSandbox: async (
            request,
            _readyCapture,
            _readyRunner,
            lifecycleCreateSandbox,
            effectivePolicySourcePath,
          ) => {
            lifecycleRequest = structuredClone(request) as Record<string, unknown>;
            assert.equal(request.target.gatewayName, gatewayName);
            assert.equal(request.source.reference.startsWith(tmpDir), true);
            assert.equal(request.workingDirectory?.startsWith(tmpDir), true);
            assert.equal(request.policyPath, effectivePolicySourcePath);
            assert.equal(request.policyPath?.startsWith(tmpDir), true);
            assert.deepEqual(request.startupCommand, startupCommand);
            assert.equal(request.environment.OPENSHELL_TEST_MARKER, "typed-boundary");
            const created = await lifecycleCreateSandbox(request);
            assert.equal(created.status, 0, created.output);
            return created;
          },
          readRegistry: () => registryEntry as never,
          compareAndSetRegistryGatewayPort: (name, expected, gatewayPort) => {
            assert.equal(name, sandboxName);
            assert.ok(registryEntry);
            assert.deepEqual(registryEntry, expected);
            registryEntry = { ...registryEntry, gatewayPort };
            return true;
          },
          registerSandbox: async (
            _created,
            receipt,
            fingerprint,
            revalidate,
            _routeReservation,
          ) => {
            await revalidate();
            registryEntry = {
              name: sandboxName,
              agent: "hermes",
              ...routeRegistryFields,
              gatewayName,
              lifecycleGeneration: receipt.lifecycleGeneration,
              openshellDriver: "docker",
              lifecycleLiveIdentityFingerprint: fingerprint,
              openshellVersion: receipt.openshellExecutableAuthority.version,
              pendingRouteReservation: true,
              reservationSessionId,
            };
            return registryEntry as never;
          },
          sourceRoot: repoRoot,
          buildContextSettings: {
            model: "gpt-5.4",
            provider: "nvidia-prod",
            preferredInferenceApi: null,
            toolDisclosure: "progressive",
          },
          cleanupTemporaryPolicy: () => {
            fs.unlinkSync(policyPath);
            return true;
          },
          createPolicySourceBytes: Buffer.from("version: 1\nnetwork_policies: {}\n"),
        });

        assert.equal(result.created, true);
        assert.equal(result.active.receipt.phase, "active");
        assert.equal(result.active.receipt.container.sandboxId, sandboxId);
        assert.equal(registryEntry?.lifecycleLiveIdentityFingerprint, liveIdentityFingerprint);
        assert.ok(lifecycleRequest);
        assert.ok(fs.existsSync(statePath), "the independent OpenShell fixture observed create");
        assert.equal(
          registryEntry?.gatewayPort,
          registryEntryGatewayPort({ name: sandboxName, gatewayName }),
        );
        const invocations = fs.readFileSync(invocationPath, "utf8");
        assert.match(invocations, /ARGS=sandbox create -g nemoclaw --from /u);
        assert.match(invocations, /--policy .*\/policy\.[a-f0-9-]+\.yaml/u);
        assert.match(invocations, /-- env NEMOCLAW_HERMES_API_PORT=8642/u);
        assert.match(invocations, /MARKER=typed-boundary/u);
        assert.match(invocations, new RegExp(`PWD=${tmpDir.replaceAll("/", "\\/")}`, "u"));
        assert.ok(
          fs.existsSync(path.join(path.dirname(result.active.path), "active.json")),
          "the receipt transaction published active authority",
        );
      } finally {
        vi.restoreAllMocks();
        vi.doUnmock("../../src/lib/adapters/openshell/resolve-shared");
        vi.doUnmock("../../src/lib/adapters/podman");
        vi.doUnmock("../../src/lib/onboard/experimental/hermes-portable-podman-authority");
        vi.resetModules();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );

  it(
    "publishes providers before non-deferred Hermes portable creation (#9806)",
    { timeout: 60_000 },
    () => {
      const payload = runProviderBoundary("create");

      assert.equal(payload.result, "my-assistant");
      assert.deepEqual(payload.providerCalls, expectedProviderCalls);
      assert.equal(payload.portableLockInvocations, 1);
      assert.equal(payload.portableTransactions, 1);
      assert.ok(
        payload.events.indexOf("portable:transaction") < payload.events.indexOf("provider:update"),
      );
      assert.ok(
        payload.events.indexOf("provider:update") < payload.events.indexOf("sandbox:create"),
      );
    },
  );

  it(
    "keeps the transaction-bound Ollama provider at its committed version (#11336)",
    { timeout: 60_000 },
    () => {
      const payload = runProviderBoundary("ollama-create");

      assert.equal(payload.result, "my-assistant");
      assert.deepEqual(payload.providerCalls, []);
      assert.equal(payload.portableTransactions, 1);
      assert.equal(payload.gpuCreateCalls, 1);
      assert.equal(payload.events.filter((event) => event === "provider:update").length, 0);
      assert.ok(payload.events.includes("sandbox:create"));
      assert.ok(payload.events.includes("sandbox:identity-verified"));
      assert.ok(
        payload.events.indexOf("portable:transaction") < payload.events.indexOf("sandbox:create"),
      );
    },
  );

  it(
    "publishes deferred Hermes portable providers after identity verification (#9806)",
    { timeout: 60_000 },
    () => {
      const payload = runProviderBoundary("deferred");

      assert.equal(payload.result, "my-assistant");
      assert.deepEqual(payload.providerCalls, expectedProviderCalls);
      assert.equal(payload.portableTransactions, 1);
      assert.ok(
        payload.events.indexOf("portable:transaction") < payload.events.indexOf("provider:update"),
      );
      assert.ok(
        payload.events.indexOf("sandbox:create") < payload.events.indexOf("provider:update"),
      );
      assert.ok(
        payload.events.indexOf("provider:update") <
          payload.events.indexOf("sandbox:identity-verified"),
      );
    },
  );

  it(
    "does not replay provider publication when ordinary creation resumes (#9806)",
    { timeout: 60_000 },
    () => {
      const payload = runProviderBoundary("ordinary-resume");

      assert.equal(payload.result, "my-assistant");
      assert.deepEqual(payload.providerCalls, expectedProviderCalls);
      assert.equal(payload.portableTransactions, 0);
      assert.match(payload.firstError ?? "", /registry publication/u);
      assert.equal(payload.gpuCreateCalls, 2);
      assert.equal(payload.events.filter((event) => event === "provider:update").length, 1);
      assert.ok(payload.events.includes("sandbox:resume"));
      assert.ok(
        payload.events.indexOf("provider:update") < payload.events.indexOf("sandbox:create"),
      );
    },
  );

  it(
    "does not publish providers for a superseded Hermes portable transaction (#9806)",
    { timeout: 60_000 },
    () => {
      const payload = runProviderBoundary("superseded");

      assert.equal(payload.result, "my-assistant");
      assert.deepEqual(payload.providerCalls, []);
      assert.equal(payload.portableTransactions, 1);
      assert.equal(payload.gpuCreateCalls, 0);
      assert.deepEqual(payload.events, ["portable:transaction"]);
    },
  );
});
