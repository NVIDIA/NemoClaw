// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { vi } from "vitest";

import type {
  PodmanExecutableAuthorityDeps,
  PodmanExecutableStat,
  PodmanSocketAuthority,
} from "../../src/lib/adapters/podman";
import {
  fingerprintOpenShellSandboxLiveIdentity,
  parseOpenShellSandboxId,
} from "../../src/lib/adapters/openshell/sandbox-identity";
import { loadAgent } from "../../src/lib/agent/defs";
import { writeConfigFile } from "../../src/lib/state/config-io";
import type { SandboxEntry } from "../../src/lib/state/registry/types";
import { createPortableOnboardEnvironmentScope } from "../../src/lib/onboard/session-bootstrap";
import {
  prepareHostLocalInferenceStartup,
  type HostLocalInferenceGatewayMutation,
} from "../../src/lib/onboard/runtime-provider/host-local-inference-routing";
import { HOST_LOCAL_INFERENCE_APPLICATION_BASE_URL } from "../../src/lib/onboard/runtime-provider/host-local-inference-routing";
import {
  captureHermesPortablePodmanExecutableAuthority,
  type HermesPortablePodmanAuthorityDeps,
} from "../../src/lib/onboard/experimental/hermes-portable-podman-authority";
import { hermesPortableContainerInternals } from "../../src/lib/onboard/experimental/hermes-portable-container";
import { resolveHermesPortableStartupContract } from "../../src/lib/onboard/experimental/hermes-portable-contract";
import { hermesPortableCreatePolicySemanticDigest } from "../../src/lib/onboard/experimental/hermes-portable-policy-authority";
import {
  captureHermesPortablePolicySource,
  publishHermesPortableDurablePolicySource,
  publishHermesPortableLifecycleReceipt,
  type HermesPortableConfiguredReceipt,
  type HermesPortablePendingReceipt,
} from "../../src/lib/onboard/experimental/hermes-portable-receipt";
import { createHermesPortableOllamaInferenceResolver } from "../../src/lib/onboard/experimental/hermes-portable-ollama-inference";
import {
  PORTABLE_OLLAMA_IMAGE,
  PORTABLE_PROBE_IMAGE,
} from "../../src/lib/onboard/experimental/hermes-portable-ollama-authority";
import type { HermesPortableUninstallDeps } from "../../src/lib/actions/uninstall/hermes-portable-uninstall";
import {
  HERMES_PORTABLE_UNINSTALL_JOURNAL_FILE,
  type HermesPortableUninstallPhase,
} from "../../src/lib/actions/uninstall/hermes-portable-uninstall-transaction";
import type { PortableRuntimeCleanupInput } from "../../src/lib/actions/uninstall/portable-runtime-cleanup";
import { createPodmanHostLocalInferenceTestHarness } from "./podman-host-local-inference-test-harness";
import {
  createPortableGatewayProviderHarness,
  createPortablePodmanCapture,
  type PortablePodmanAuthorityState,
} from "./hermes-portable-ollama-test-harness";
import { hermesPortableTestOpenShellAuthority } from "./hermes-portable-onboarding-fixture";

const SANDBOX_NAME = "portable-hermes";
const GATEWAY_NAME = "nemoclaw";
const LIFECYCLE_GENERATION = "generation-1";
const SANDBOX_CONTAINER_ID = "b".repeat(64);
const SANDBOX_IMAGE_ID = "c".repeat(64);
const SANDBOX_ID = "sandbox-id-1";
const NETWORK_ID = "6".repeat(64);
const GPU_DEVICE = "nvidia.com/gpu=GPU-12345678-1234-1234-1234-123456789abc";
const PODMAN_PATH = "/usr/bin/podman";
const PODMAN_BYTES = Buffer.from("portable-podman-5.7.0", "utf8");
const POLICY = "version: 1\nnetwork_policies: {}\n";
const LIVE_SANDBOX = `Name: ${SANDBOX_NAME}\nID: ${SANDBOX_ID}\nPhase: Ready\n`;
const SANDBOX_LABELS = {
  "openshell.managed": "true",
  "openshell.ai/sandbox-id": SANDBOX_ID,
  "openshell.ai/sandbox-name": SANDBOX_NAME,
  "openshell.ai/sandbox-namespace": "",
  "openshell.ai/sandbox-workspace": "default",
};

function sandboxListJson(liveSandbox: string): string {
  const sandboxId = parseOpenShellSandboxId(liveSandbox);
  const phase = liveSandbox.match(/^Phase:\s*(\S+)\s*$/mu)?.[1];
  if (!sandboxId || !phase) throw new Error("Hermes Portable test sandbox list is malformed");
  return JSON.stringify([
    {
      id: sandboxId,
      name: SANDBOX_NAME,
      labels: {},
      resource_version: 1,
      created_at: "2026-01-01T00:00:00Z",
      phase,
      current_policy_version: 1,
    },
  ]);
}

function directoryChain(directory: string): string[] {
  const parent = path.dirname(directory);
  return parent === directory ? [directory] : [directory, ...directoryChain(parent)];
}

function runtimeAuthority(homeDir: string) {
  const uid = process.getuid!();
  return {
    schemaVersion: 1 as const,
    kind: "podman" as const,
    ownership: "current-user" as const,
    uid,
    homeDir,
    configHome: path.join(homeDir, ".config"),
    runtimeDir: `/run/user/${String(uid)}`,
    socketPath: `/run/user/${String(uid)}/podman/podman.sock`,
  };
}

function socketAuthority(runtime: ReturnType<typeof runtimeAuthority>): PodmanSocketAuthority {
  return {
    device: "1",
    inode: "2",
    mode: String(0o140600),
    ownerUid: String(runtime.uid),
    socketPath: runtime.socketPath,
    directoryChain: directoryChain(path.dirname(runtime.socketPath)).map((directory, index) => ({
      device: "1",
      inode: String(index + 3),
      mode: String(index === 0 ? 0o40700 : 0o40755),
      ownerUid: String(index === 0 ? runtime.uid : 0),
      path: directory,
    })),
  };
}

function executableAuthorityDeps(): PodmanExecutableAuthorityDeps {
  const executable = (): PodmanExecutableStat => ({
    dev: 1n,
    ino: 10n,
    mode: 0o100755n,
    uid: 0n,
    size: BigInt(PODMAN_BYTES.byteLength),
    mtimeNs: 10n,
    ctimeNs: 11n,
    isDirectory: () => false,
    isFile: () => true,
    isSymbolicLink: () => false,
  });
  return {
    uid: process.getuid!(),
    lstat: (filePath) =>
      filePath === PODMAN_PATH
        ? executable()
        : {
            ...executable(),
            ino: filePath === "/usr/bin" ? 20n : 30n,
            mode: 0o40755n,
            size: 0n,
            isDirectory: () => true,
            isFile: () => false,
          },
    readFile: () => PODMAN_BYTES,
    realpath: (filePath) => filePath,
  };
}

function publishLifecycleReceipt(
  stateDir: string,
  runtime: ReturnType<typeof runtimeAuthority>,
  socket: PodmanSocketAuthority,
  podmanAuthority: ReturnType<typeof captureHermesPortablePodmanExecutableAuthority>,
  lifecycleGeneration: string,
): HermesPortableConfiguredReceipt {
  const policyPath = path.join(stateDir, "portable-uninstall-policy.yaml");
  fs.writeFileSync(policyPath, POLICY, { mode: 0o600 });
  const transactionId = randomUUID();
  const policyBytes = fs.readFileSync(policyPath);
  const policy = publishHermesPortableDurablePolicySource({
    sandboxName: SANDBOX_NAME,
    transactionId,
    stateDir,
    intendedSemanticSha256: hermesPortableCreatePolicySemanticDigest(policyBytes),
    source: captureHermesPortablePolicySource(policyPath),
    hooks: { assertLifecycleLock: () => undefined },
  });
  const pending: HermesPortablePendingReceipt = {
    schemaVersion: 5,
    agent: "hermes",
    phase: "pending",
    transactionId,
    createIntentSha256: "d".repeat(64),
    sandboxName: SANDBOX_NAME,
    gatewayName: GATEWAY_NAME,
    lifecycleGeneration,
    runtimeAuthority: runtime,
    openshellExecutableAuthority: hermesPortableTestOpenShellAuthority(),
    podmanExecutableAuthority: podmanAuthority,
    socketAuthority: socket,
    startup: resolveHermesPortableStartupContract({
      agent: loadAgent("hermes"),
      sandboxName: SANDBOX_NAME,
      startupArgv: [
        "env",
        "NEMOCLAW_HERMES_API_PORT=8642",
        `NEMOCLAW_SANDBOX_NAME=${SANDBOX_NAME}`,
        "/usr/local/bin/nemoclaw-start",
      ],
    }),
    policy,
  };
  const first = publishHermesPortableLifecycleReceipt(pending, stateDir, {
    assertLifecycleLock: () => undefined,
  });
  const configuring: HermesPortableConfiguredReceipt = {
    ...pending,
    phase: "configuring",
    previousPhaseSha256: first.sha256,
    verifiedLivePolicySemanticSha256: policy.intendedSemanticSha256,
    container: {
      containerId: SANDBOX_CONTAINER_ID,
      sandboxId: SANDBOX_ID,
      imageId: `sha256:${SANDBOX_IMAGE_ID}`,
      labelsSha256: hermesPortableContainerInternals.labelsDigest(SANDBOX_LABELS),
      name: `openshell-default--${SANDBOX_NAME}-${SANDBOX_ID}`,
      running: true,
      restartPolicy: "no",
    },
  };
  const second = publishHermesPortableLifecycleReceipt(configuring, stateDir, {
    assertLifecycleLock: () => undefined,
  });
  const active: HermesPortableConfiguredReceipt = {
    ...configuring,
    phase: "active",
    previousPhaseSha256: second.sha256,
    container: { ...configuring.container, restartPolicy: "unless-stopped" },
  };
  publishHermesPortableLifecycleReceipt(active, stateDir, {
    assertLifecycleLock: () => undefined,
  });
  return active;
}

function sandboxInspect(
  receipt: HermesPortableConfiguredReceipt,
  containerId: string,
  labels: Readonly<Record<string, string>>,
): string {
  return JSON.stringify([
    {
      Id: containerId,
      Image: SANDBOX_IMAGE_ID,
      Name: receipt.container.name,
      Config: { Labels: labels },
      State: { Running: true, Paused: false, Status: "running" },
      HostConfig: { RestartPolicy: { Name: "unless-stopped" } },
    },
  ]);
}

function createGatewayMutation(mutation: HostLocalInferenceGatewayMutation): void {
  mutation.upsertProvider!(
    "ollama-local",
    "openai",
    "NEMOCLAW_OLLAMA_PROXY_TOKEN",
    "http://host.openshell.internal:11434/v1",
    { NEMOCLAW_OLLAMA_PROXY_TOKEN: "ollama" },
  );
}

export interface HermesPortableUninstallFixture {
  readonly cleanupInput: PortableRuntimeCleanupInput;
  readonly deps: HermesPortableUninstallDeps;
  readonly gatewayProvider: ReturnType<typeof createPortableGatewayProviderHarness>;
  readonly harness: ReturnType<typeof createPodmanHostLocalInferenceTestHarness>;
  readonly journalPath: string;
  readonly lifecycleReceiptRoot: string;
  readonly registryFile: string;
  readonly stateDir: string;
  readonly targetRow: SandboxEntry;
  readonly unrelatedFile: string;
  readonly authorityState: PortablePodmanAuthorityState;
  readonly inferenceDirectory: string;
  readonly operationEvents: readonly string[];
  readonly sandboxDeleteCount: () => number;
  readonly sandboxPresent: () => boolean;
  readonly replaceSandbox: () => void;
  readonly setNetworkDrift: () => void;
  readonly setRegistryGenerationDrift: () => void;
  readonly setSandboxContainerIdDrift: () => void;
  readonly setSandboxLabelDelimiterDrift: () => void;
  readonly setSandboxPhase: (phase: string) => void;
  readonly setSocketDrift: () => void;
  readonly restore: () => void;
}

export async function createHermesPortableUninstallFixture(
  homeDir: string,
  options: {
    readonly shared?: boolean;
    readonly providerOnlyShared?: boolean;
    readonly interruptAfter?: HermesPortableUninstallPhase;
    readonly lifecycleGeneration?: string;
  } = {},
): Promise<HermesPortableUninstallFixture> {
  const stateDir = path.join(homeDir, ".nemoclaw");
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const runtime = runtimeAuthority(homeDir);
  const socket = socketAuthority(runtime);
  const env: NodeJS.ProcessEnv = {
    HOME: homeDir,
    PATH: "/usr/bin",
    XDG_CONFIG_HOME: runtime.configHome,
    XDG_RUNTIME_DIR: runtime.runtimeDir,
  };
  const environmentScope = createPortableOnboardEnvironmentScope(env, null);
  environmentScope.installRuntime({
    containersConf: path.join(runtime.configHome, "nemoclaw", "portable", "containers.conf"),
    socketPath: runtime.socketPath,
  });
  const podmanEnv = environmentScope.createHermesPortablePodmanSourceEnvironment(runtime);
  const events: string[] = [];
  const authorityState: PortablePodmanAuthorityState = {
    networkId: NETWORK_ID,
    images: new Set<string>(),
  };
  const gatewayProvider = createPortableGatewayProviderHarness(events);
  const harness = createPodmanHostLocalInferenceTestHarness({
    probeImageRef: PORTABLE_PROBE_IMAGE,
  });
  harness.state.networkId = NETWORK_ID;
  harness.state.networkName = "openshell-docker";
  harness.state.networkGatewayIp = "10.87.0.1";
  harness.state.ollamaPsModels = [
    {
      name: "qwen3-vl:4b",
      model: "qwen3-vl:4b",
      size: 8 * 1024 ** 3,
      size_vram: 8 * 1024 ** 3,
      digest: "8".repeat(64),
    },
  ];
  const capture = createPortablePodmanCapture(events, authorityState, harness.engine.capture);
  let socketDrift = false;
  const podmanAuthorityDeps: HermesPortablePodmanAuthorityDeps = {
    capture,
    executableAuthorityDeps: executableAuthorityDeps(),
    assertSocketAuthority: vi.fn(() => {
      if (socketDrift) throw new Error("injected Podman socket authority drift");
    }),
    resolveExecutablePath: () => PODMAN_PATH,
    platform: "linux",
    architecture: "x64",
    uid: runtime.uid,
  };
  const podmanAuthority = captureHermesPortablePodmanExecutableAuthority(
    socket,
    runtime,
    podmanEnv,
    podmanAuthorityDeps,
  );
  const resolver = createHermesPortableOllamaInferenceResolver({
    runtimeContext: { authority: runtime, environmentScope },
    credentialEnv: "NEMOCLAW_OLLAMA_PROXY_TOKEN",
    getReservationSessionId: () => "portable-session",
    runGatewayOpenshell: gatewayProvider.run,
    stateDir,
    captureSocketAuthority: () => socket,
    captureGpuDevices: () => [GPU_DEVICE],
    captureCdiDevices: () => ["nvidia.com/gpu=all", GPU_DEVICE],
    podmanAuthorityDeps,
  });
  const selection = resolver({
    application: "hermes",
    sandboxName: SANDBOX_NAME,
    provider: "ollama-local",
    model: "qwen3-vl:4b",
    acceleration: "nvidia-gpu",
    requireToolCalling: true,
    allowPublishedResume: false,
    recover: false,
  });
  if (!selection) throw new Error("Hermes Portable test inference selection is missing");
  const bundle = selection.resolveRuntimeProvider(SANDBOX_NAME);
  if (!bundle || !bundle.hostLocalInference.supported) {
    throw new Error("Hermes Portable test runtime provider is missing");
  }
  const operation = bundle.hostLocalInference.createOperation({
    env: {},
    acceleration: "nvidia-gpu",
  });
  const route = prepareHostLocalInferenceStartup(operation, selection.request);
  route.prepared.validateBeforeCommit();
  const mutation = await selection.prepareGatewayMutation({
    gatewayName: GATEWAY_NAME,
    sandboxName: SANDBOX_NAME,
    provider: "ollama-local",
    model: "qwen3-vl:4b",
    providerBaseUrl: "http://host.openshell.internal:11434/v1",
  });
  createGatewayMutation(mutation);
  await mutation.commit();
  route.prepared.commit();
  const inferenceStateRoot = path.join(stateDir, "portable-inference");
  const inferenceDirectories = fs.readdirSync(inferenceStateRoot);
  if (inferenceDirectories.length !== 1) {
    throw new Error("Hermes Portable test inference state is ambiguous");
  }
  const inferenceDirectory = path.join(inferenceStateRoot, inferenceDirectories[0]!);
  const serializedInferenceReceipt = fs.readFileSync(
    path.join(inferenceDirectory, "portable-inference.json"),
    "utf8",
  );
  const lifecycleGeneration = options.lifecycleGeneration ?? LIFECYCLE_GENERATION;
  const lifecycleReceipt = publishLifecycleReceipt(
    stateDir,
    runtime,
    socket,
    podmanAuthority,
    lifecycleGeneration,
  );
  const targetRow: SandboxEntry = {
    name: SANDBOX_NAME,
    agent: "hermes",
    openshellDriver: "docker",
    openshellVersion: lifecycleReceipt.openshellExecutableAuthority.version,
    gatewayName: GATEWAY_NAME,
    gatewayPort: 8080,
    lifecycleGeneration,
    lifecycleLiveIdentityFingerprint: fingerprintOpenShellSandboxLiveIdentity(LIVE_SANDBOX)!,
    provider: "ollama-local",
    model: "qwen3-vl:4b",
    credentialEnv: null,
    endpointUrl: HOST_LOCAL_INFERENCE_APPLICATION_BASE_URL,
    endpointSource: null,
    preferredInferenceApi: null,
    hostLocalInferenceReceipt: serializedInferenceReceipt,
  };
  const siblingRow: SandboxEntry = {
    ...targetRow,
    name: "portable-sibling",
    lifecycleGeneration: "sibling-generation",
    lifecycleLiveIdentityFingerprint: "sibling-live-identity",
  };
  const providerOnlySiblingRow: SandboxEntry = {
    name: "provider-sibling",
    agent: "hermes",
    openshellDriver: "docker",
    gatewayName: GATEWAY_NAME,
    gatewayPort: 8080,
    lifecycleGeneration: "provider-sibling-generation",
    lifecycleLiveIdentityFingerprint: "provider-sibling-live-identity",
    provider: "ollama-local",
    model: "qwen3-vl:4b",
    credentialEnv: null,
    endpointUrl: HOST_LOCAL_INFERENCE_APPLICATION_BASE_URL,
  };
  const registryFile = path.join(stateDir, "sandboxes.json");
  writeConfigFile(registryFile, {
    defaultSandbox: SANDBOX_NAME,
    sandboxes: {
      [SANDBOX_NAME]: targetRow,
      ...(options.shared ? { [siblingRow.name]: siblingRow } : {}),
      ...(options.providerOnlyShared
        ? { [providerOnlySiblingRow.name]: providerOnlySiblingRow }
        : {}),
    },
  });
  let sandboxPresent = true;
  let sandboxContainerPresent = true;
  let sandboxDeleteCount = 0;
  let sandboxContainerId = SANDBOX_CONTAINER_ID;
  let sandboxLabels: Readonly<Record<string, string>> = SANDBOX_LABELS;
  let liveSandbox = LIVE_SANDBOX;
  const sandboxPodman = vi.fn((args: readonly string[]) => {
    if (args[0] === "container" && args[1] === "inspect") {
      return sandboxContainerPresent
        ? {
            status: 0,
            stdout: sandboxInspect(lifecycleReceipt, sandboxContainerId, sandboxLabels),
            stderr: "",
          }
        : { status: 125, stdout: "", stderr: "no such container" };
    }
    if (args[0] === "ps") {
      return {
        status: 0,
        stdout: sandboxContainerPresent ? `${sandboxContainerId}\n` : "",
        stderr: "",
      };
    }
    throw new Error(`Unexpected sandbox Podman command: ${args.join(" ")}`);
  });
  const runOpenShell: NonNullable<HermesPortableUninstallDeps["runOpenShell"]> = (
    _executable,
    args,
    _commandEnv,
    timeout,
  ) => {
    if (args[0] === "provider") {
      return gatewayProvider.run([...args], {
        ignoreError: true,
        suppressOutput: true,
        stdio: ["ignore", "pipe", "pipe"],
        timeout,
      });
    }
    const command = args.slice(0, 2).join(":");
    if (command === "policy:get") return { status: 0, stdout: POLICY, stderr: "" };
    if (command === "sandbox:list") {
      return {
        status: 0,
        stdout: args.includes("json")
          ? sandboxPresent
            ? sandboxListJson(liveSandbox)
            : "[]"
          : liveSandbox,
        stderr: "",
      };
    }
    if (command === "sandbox:get") {
      return sandboxPresent
        ? { status: 0, stdout: liveSandbox, stderr: "" }
        : {
            status: 1,
            stdout: "",
            stderr: `Error: sandbox '${SANDBOX_NAME}' not found`,
          };
    }
    if (command === "sandbox:delete") {
      sandboxDeleteCount += 1;
      sandboxPresent = false;
      sandboxContainerPresent = false;
      return { status: 0, stdout: "", stderr: "" };
    }
    throw new Error(`Unexpected OpenShell command: ${args.join(" ")}`);
  };
  const unrelatedFile = path.join(stateDir, "unrelated-authority.txt");
  fs.writeFileSync(unrelatedFile, "unrelated\n", { mode: 0o600 });
  let interrupted = false;
  return {
    cleanupInput: {
      env: podmanEnv,
      gatewayName: GATEWAY_NAME,
      gatewayPort: 8080,
      homeDir,
      registryFile,
      stateDir,
    },
    deps: {
      lifecycle: {
        container: { podman: sandboxPodman, assertSocketAuthority: vi.fn() },
        assertOpenShellExecutableAuthority: vi.fn(() => PODMAN_PATH.replace("podman", "openshell")),
        captureOpenShell: (args, timeout) =>
          runOpenShell(PODMAN_PATH.replace("podman", "openshell"), args, podmanEnv, timeout),
      },
      podmanAuthorityDeps,
      captureGpuDevices: () => [GPU_DEVICE],
      captureCdiDevices: () => ["nvidia.com/gpu=all", GPU_DEVICE],
      runOpenShell,
      afterPhaseAction: (phase) => {
        if (!interrupted && phase === options.interruptAfter) {
          interrupted = true;
          throw new Error(`interrupted after ${phase}`);
        }
      },
    },
    gatewayProvider,
    harness,
    journalPath: path.join(stateDir, HERMES_PORTABLE_UNINSTALL_JOURNAL_FILE),
    lifecycleReceiptRoot: path.join(stateDir, "hermes-portable-lifecycle"),
    registryFile,
    stateDir,
    targetRow,
    unrelatedFile,
    authorityState,
    inferenceDirectory,
    operationEvents: events,
    sandboxDeleteCount: () => sandboxDeleteCount,
    sandboxPresent: () => sandboxPresent,
    replaceSandbox: () => {
      sandboxPresent = true;
      sandboxContainerPresent = true;
      sandboxContainerId = "f".repeat(64);
      liveSandbox = `Name: ${SANDBOX_NAME}\nID: replacement-id\nPhase: Ready\n`;
    },
    setNetworkDrift: () => {
      authorityState.networkId = "7".repeat(64);
    },
    setRegistryGenerationDrift: () => {
      const registry = JSON.parse(fs.readFileSync(registryFile, "utf8")) as {
        sandboxes: Record<string, SandboxEntry>;
      };
      registry.sandboxes[SANDBOX_NAME] = {
        ...registry.sandboxes[SANDBOX_NAME]!,
        lifecycleGeneration: "replacement-generation",
      };
      writeConfigFile(registryFile, registry);
    },
    setSandboxContainerIdDrift: () => {
      sandboxContainerId = "e".repeat(64);
    },
    setSandboxLabelDelimiterDrift: () => {
      sandboxLabels = {
        ...SANDBOX_LABELS,
        "openshell.ai/sandbox-name": `${SANDBOX_NAME},spoofed`,
      };
    },
    setSandboxPhase: (phase) => {
      liveSandbox = `Name: ${SANDBOX_NAME}\nID: ${SANDBOX_ID}\nPhase: ${phase}\n`;
    },
    setSocketDrift: () => {
      socketDrift = true;
    },
    restore: () => environmentScope.restore(),
  };
}

export const hermesPortableUninstallFixtureConstants = Object.freeze({
  inferenceImage: PORTABLE_OLLAMA_IMAGE,
  sandboxName: SANDBOX_NAME,
});
