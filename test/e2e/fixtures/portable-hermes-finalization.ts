// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  capturePodmanSocketAuthority,
  createPodmanContainerEngine,
} from "../../../src/lib/adapters/podman/index.ts";
import { captureHermesPortableOpenShellExecutableAuthority } from "../../../src/lib/adapters/openshell/resolve-shared.ts";
import { loadAgent } from "../../../src/lib/agent/defs.ts";
import {
  handleFinalizationState,
  handlePostVerifyState,
  type FinalizationStateOptions,
} from "../../../src/lib/onboard/machine/handlers/finalization.ts";
import { finalizationHandlerDeps } from "../../../src/lib/onboard/machine/finalization-deps.ts";
import { buildDockerDriverGatewayEnv } from "../../../src/lib/onboard/docker-driver-gateway-env.ts";
import { ensureDockerDriverGatewayLocalTlsBundle } from "../../../src/lib/onboard/docker-driver-gateway-local-tls.ts";
import { ensureManagedGatewayStateRoot } from "../../../src/lib/onboard/gateway/state-dir.ts";
import { enrollHermesPortableContainer } from "../../../src/lib/onboard/experimental/hermes-portable-container.ts";
import { resolveHermesPortableStartupContract } from "../../../src/lib/onboard/experimental/hermes-portable-contract.ts";
import { defaultPortableDemoStateDir } from "../../../src/lib/onboard/experimental/portable-agent-lifecycle.ts";
import {
  createHermesPortableChildEnvironment,
  createHermesPortableContainerDeps,
} from "../../../src/lib/onboard/experimental/hermes-portable-onboarding.ts";
import { captureHermesPortablePodmanExecutableAuthority } from "../../../src/lib/onboard/experimental/hermes-portable-podman-authority.ts";
import {
  captureHermesPortablePolicySource,
  publishHermesPortableDurablePolicySource,
  publishHermesPortableLifecycleReceipt,
  type HermesPortableConfiguredReceipt,
  type HermesPortablePendingReceipt,
} from "../../../src/lib/onboard/experimental/hermes-portable-receipt.ts";
import { withMcpLifecycleLock } from "../../../src/lib/state/mcp-lifecycle-lock-acquisition.ts";
import { nemoclawStateRoot } from "../../../src/lib/state/state-root.ts";
import type { SessionUpdates } from "../../../src/lib/state/onboard-session.ts";
import type { SandboxEntry } from "../../../src/lib/state/registry/types.ts";
import {
  liveE2eManagedImageCatalog,
  readLiveE2eManagedImageCatalogContracts,
} from "../../../src/lib/onboard/workload/preparation.ts";
import { buildAvailabilityProbeEnv } from "./availability-env.ts";
import type { ArtifactSink } from "./artifacts.ts";
import { CLI_ENTRYPOINT, REPO_ROOT } from "./paths.ts";
import { OPENSHELL_V0116_QUALIFICATION } from "./openshell-v0116-qualification.ts";
import type { TestProgress } from "./progress.ts";
import type { ShellProbe } from "./shell-probe.ts";
import {
  cleanupPodmanLifecycle,
  executableOnPath,
  GATEWAY_NAME,
  inspectContainer,
  runCommand,
  SOCKET_PATH,
  startPinnedGateway,
  waitForHealthyGateway,
} from "../live/podman-cpu-lifecycle-helpers.ts";

const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-hm-portable-final";
const GATEWAY_PORT = 18_080;
const LIFECYCLE_GENERATION = "portable-hermes-finalization-e2e";
const POLICY_PATH = path.join(REPO_ROOT, "test/e2e/live/hermes-portable-lifecycle-policy.yaml");
export const PORTABLE_HERMES_FINALIZATION_PHASES = [
  "prove x86-64 NVIDIA GPU and rootless Podman",
  "start the receipt-owned OpenShell gateway",
  "activate the managed Hermes gateway from the candidate image",
  "publish receipt and registry authority",
  "complete onboarding finalization through native readiness",
  "confirm doctor reports the same healthy readiness",
  "record Portable Hermes readiness evidence",
] as const;

function withoutPodmanConnectionSelectors(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const blocked = new Set([
    "CONTAINER_CONNECTION",
    "CONTAINER_CERT_PATH",
    "CONTAINER_HOST",
    "CONTAINER_SSHKEY",
    "CONTAINER_TLS_VERIFY",
    "CONTAINERS_CONF",
    "CONTAINERS_STORAGE_CONF",
    "DOCKER_CONTEXT",
    "DOCKER_HOST",
    "DOCKER_TLS",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
    "PODMAN_CONNECTIONS_CONF",
    "REGISTRY_AUTH_FILE",
  ]);
  return Object.fromEntries(Object.entries(env).filter(([name]) => !blocked.has(name)));
}

function managedHermesImage(): string {
  const selected = liveE2eManagedImageCatalog(process.env);
  return readLiveE2eManagedImageCatalogContracts(selected!).get("hermes")?.reference ?? "";
}

function writeRegistry(home: string, entry: SandboxEntry): void {
  const registryPath = path.join(nemoclawStateRoot(home), "sandboxes.json");
  fs.mkdirSync(path.dirname(registryPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    registryPath,
    `${JSON.stringify({ defaultSandbox: SANDBOX_NAME, sandboxes: { [SANDBOX_NAME]: entry } }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

interface PortableHermesFinalizationInput {
  readonly artifacts: ArtifactSink;
  readonly phases: {
    readonly proveEnvironment: () => void;
    readonly startGateway: () => void;
    readonly activateHermes: () => void;
    readonly publishAuthority: () => void;
    readonly finalizeOnboarding: () => void;
    readonly confirmDoctor: () => void;
    readonly recordEvidence: () => void;
  };
  readonly progress: TestProgress;
  readonly shellProbe: ShellProbe;
}

export async function runPortableHermesFinalization(
  input: PortableHermesFinalizationInput,
): Promise<void> {
  const { artifacts, phases, progress, shellProbe } = input;
  await artifacts.target.declare({
    id: "portable-hermes-finalization",
    boundary: "x86-64 NVIDIA GPU + rootless Podman + receipt-qualified OpenShell gateway",
    sandboxName: SANDBOX_NAME,
    inference: "authenticated managed Hermes health endpoint",
  });

  phases.proveEnvironment();
  await runCommand(shellProbe, "nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"], {
    artifactName: "phase-1-nvidia-gpu",
    timeoutMs: 60_000,
  });
  await runCommand(
    shellProbe,
    "podman",
    ["--url", `unix://${SOCKET_PATH}`, "info", "--format", "{{.Host.Security.Rootless}}"],
    { artifactName: "phase-1-rootless-podman", timeoutMs: 60_000 },
  );

  const uid = process.getuid?.() ?? -1;
  const root = fs.mkdtempSync(path.join(os.homedir(), ".nemoclaw-portable-finalization-"));
  const home = path.join(root, "home");
  const gatewayStateDir = path.join(root, "gateway-state");
  const runtimeAuthority = {
    schemaVersion: 1,
    kind: "podman",
    ownership: "current-user",
    uid,
    homeDir: home,
    configHome: path.join(home, ".config"),
    runtimeDir: path.join("/run/user", String(uid)),
    socketPath: SOCKET_PATH,
  } as const;
  fs.mkdirSync(runtimeAuthority.configHome, { recursive: true, mode: 0o700 });
  ensureManagedGatewayStateRoot({
    gatewayName: GATEWAY_NAME,
    gatewayPort: GATEWAY_PORT,
    stateDir: gatewayStateDir,
  });
  const openshellBin = executableOnPath("openshell");
  const gatewayBin = executableOnPath("openshell-gateway");
  const sandboxBin = executableOnPath("openshell-sandbox");
  const cliEnv: NodeJS.ProcessEnv = {
    ...buildAvailabilityProbeEnv(),
    HOME: home,
    XDG_CONFIG_HOME: runtimeAuthority.configHome,
    XDG_RUNTIME_DIR: runtimeAuthority.runtimeDir,
    NEMOCLAW_EXPERIMENTAL_PROFILE: "portable",
  };
  const gatewayEnv = buildDockerDriverGatewayEnv({
    platform: "linux",
    gatewayPort: GATEWAY_PORT,
    stateDir: gatewayStateDir,
    podmanSocketPath: SOCKET_PATH,
    getDockerSupervisorImage: () => OPENSHELL_V0116_QUALIFICATION.supervisorImage,
    resolveSandboxBin: () => sandboxBin,
  });
  const tls = ensureDockerDriverGatewayLocalTlsBundle({ gatewayBin, stateDir: gatewayStateDir });
  cliEnv.OPENSHELL_LOCAL_TLS_DIR = tls.localTlsDir;
  const lifecycleEnv = withoutPodmanConnectionSelectors(cliEnv);
  const receiptStateDir = defaultPortableDemoStateDir(lifecycleEnv);
  const socketAuthority = capturePodmanSocketAuthority(SOCKET_PATH);
  const podmanAuthority = captureHermesPortablePodmanExecutableAuthority(
    socketAuthority,
    runtimeAuthority,
    lifecycleEnv,
  );
  const childEnv = createHermesPortableChildEnvironment(lifecycleEnv, runtimeAuthority);
  const openshellAuthority = captureHermesPortableOpenShellExecutableAuthority(
    openshellBin,
    childEnv,
    lifecycleEnv,
  );
  const createdSandboxes = [SANDBOX_NAME];
  const engine = createPodmanContainerEngine({
    operation: "sandbox-lifecycle",
    socketAuthority,
  });
  const previousPortableProfile = process.env.NEMOCLAW_EXPERIMENTAL_PROFILE;
  let gateway: ChildProcess | null = null;
  let completed = false;

  try {
    phases.startGateway();
    gateway = await startPinnedGateway(gatewayBin, gatewayEnv, progress, artifacts.rootDir);
    await runCommand(
      shellProbe,
      openshellBin,
      [
        "gateway",
        "add",
        `https://127.0.0.1:${String(GATEWAY_PORT)}`,
        "--local",
        "--name",
        GATEWAY_NAME,
      ],
      { artifactName: "phase-2-add-gateway", env: cliEnv },
    );
    await waitForHealthyGateway(shellProbe, openshellBin, cliEnv, gateway);

    phases.activateHermes();
    const startupArgv = [
      "env",
      "NEMOCLAW_HERMES_API_PORT=8642",
      `NEMOCLAW_SANDBOX_NAME=${SANDBOX_NAME}`,
      "/usr/local/bin/nemoclaw-start",
    ];
    await runCommand(
      shellProbe,
      openshellBin,
      [
        "sandbox",
        "create",
        "-g",
        GATEWAY_NAME,
        "--name",
        SANDBOX_NAME,
        "--from",
        managedHermesImage(),
        "--policy",
        POLICY_PATH,
        "--no-tty",
        "--",
        ...startupArgv,
      ],
      {
        artifactName: "phase-3-create-managed-hermes-gateway",
        env: cliEnv,
        timeoutMs: 240_000,
      },
    );
    const liveContainer = inspectContainer(engine, SANDBOX_NAME);
    const sandboxId = liveContainer.Config.Labels["openshell.ai/sandbox-id"]!;

    phases.publishAuthority();
    const transactionId = randomUUID();
    const policy = publishHermesPortableDurablePolicySource({
      sandboxName: SANDBOX_NAME,
      transactionId,
      stateDir: receiptStateDir,
      source: captureHermesPortablePolicySource(POLICY_PATH),
    });
    const pending: HermesPortablePendingReceipt = {
      schemaVersion: 7,
      agent: "hermes",
      phase: "pending",
      transactionId,
      createIntentSha256: "5".repeat(64),
      sandboxName: SANDBOX_NAME,
      gatewayName: GATEWAY_NAME,
      lifecycleGeneration: LIFECYCLE_GENERATION,
      runtimeAuthority,
      openshellExecutableAuthority: openshellAuthority,
      podmanExecutableAuthority: podmanAuthority,
      socketAuthority,
      startup: resolveHermesPortableStartupContract({
        agent: loadAgent("hermes"),
        sandboxName: SANDBOX_NAME,
        startupArgv,
      }),
      policy,
    };
    await withMcpLifecycleLock(
      SANDBOX_NAME,
      () => {
        const publishedPending = publishHermesPortableLifecycleReceipt(pending, receiptStateDir);
        const enrolled = enrollHermesPortableContainer(
          pending,
          sandboxId,
          createHermesPortableContainerDeps(
            socketAuthority,
            runtimeAuthority,
            podmanAuthority,
            lifecycleEnv,
          ),
        );
        const { policy: _policy, ...configuredTransaction } = pending;
        const configuring: HermesPortableConfiguredReceipt = {
          ...configuredTransaction,
          phase: "configuring",
          previousPhaseSha256: publishedPending.sha256,
          container: enrolled.authority,
        };
        const publishedConfiguring = publishHermesPortableLifecycleReceipt(
          configuring,
          receiptStateDir,
        );
        return publishHermesPortableLifecycleReceipt(
          {
            ...configuring,
            phase: "active",
            previousPhaseSha256: publishedConfiguring.sha256,
          },
          receiptStateDir,
        );
      },
      { stateDir: path.join(receiptStateDir, "state") },
    );
    const liveIdentityFingerprint = createHash("sha256").update(sandboxId).digest("hex");
    const entry: SandboxEntry = {
      name: SANDBOX_NAME,
      agent: "hermes",
      gatewayName: GATEWAY_NAME,
      gatewayPort: GATEWAY_PORT,
      lifecycleGeneration: LIFECYCLE_GENERATION,
      lifecycleLiveIdentityFingerprint: liveIdentityFingerprint,
      openshellDriver: "docker",
      openshellVersion: openshellAuthority.version,
      portableLifecycleProfile: "hermes",
      provider: "custom",
      model: "e2e-readiness",
    };
    writeRegistry(home, entry);

    phases.finalizeOnboarding();
    const agent = loadAgent("hermes");
    type VerifyChain = { boundary: string };
    type VerificationResult = { healthy: boolean };
    const deps: FinalizationStateOptions<typeof agent, VerifyChain, VerificationResult>["deps"] = {
      setDefaultSandbox: () => undefined,
      toSessionUpdates: (updates) => updates as SessionUpdates,
      removeLegacyCredentialsFile: () => undefined,
      cleanupStaleHostFiles: () => undefined,
      checkAndRecoverSandboxProcesses: async (name) =>
        await finalizationHandlerDeps.checkHermesPortableSandboxReadiness(name, lifecycleEnv),
      settleOrdinaryOpenClawPairing: async () => ({ kind: "settled" as const }),
      ordinaryOpenClawPairingIncompleteMessage: () => "ordinary pairing incomplete",
      readRegistryAgent: () => "hermes",
      settlePortablePairing: async () => ({ kind: "settled" as const }),
      portablePairingIncompleteMessage: () => "portable pairing incomplete",
      getChatUiUrl: () => "http://127.0.0.1:18789",
      buildVerifyChain: () => ({ boundary: "receipt-qualified" }),
      verifyDeployment: async () => ({ healthy: true }),
      formatVerificationDiagnostics: () => ["receipt-qualified readiness verified"],
      isDeploymentHealthy: (result: { healthy: boolean }) => result.healthy,
      reportDeploymentReadiness: () => undefined,
      verifyWebSearchInsideSandbox: async () => true,
      printDashboard: async () => undefined,
      error: (message) => {
        throw new Error(message ?? "Portable Hermes finalization reported an error.");
      },
      log: () => undefined,
    };
    const options: FinalizationStateOptions<typeof agent, VerifyChain, VerificationResult> = {
      sandboxName: SANDBOX_NAME,
      model: "e2e-readiness",
      provider: "custom",
      nimContainer: null,
      agent,
      hermesAuthMethod: null,
      hermesToolGateways: [],
      stagedLegacyKeys: [],
      migratedLegacyKeys: new Set<string>(),
      webSearchEnabled: false,
      webSearchProvider: null,
      portableProfileSelected: true,
      deps,
    };
    await handleFinalizationState(options);
    await handlePostVerifyState(options);

    phases.confirmDoctor();
    await runCommand(
      shellProbe,
      process.execPath,
      [CLI_ENTRYPOINT, SANDBOX_NAME, "doctor", "--json"],
      {
        artifactName: "phase-6-portable-hermes-doctor",
        env: lifecycleEnv,
        timeoutMs: 240_000,
      },
    );

    phases.recordEvidence();
    completed = true;
    await artifacts.target.complete({
      id: "portable-hermes-finalization",
      assertions: {
        x86_64: true,
        nvidiaGpuPresent: true,
        rootlessPodman: true,
        receiptQualifiedGateway: true,
        finalizationAdvanced: true,
        onboardingCompleted: true,
        doctorHealthy: true,
      },
    });
  } finally {
    await cleanupPodmanLifecycle({
      cliEnv,
      completed,
      createdSandboxes,
      engine,
      gateway,
      openshellBin,
      previousPortableProfile,
      root,
      shellProbe,
    });
  }
}
