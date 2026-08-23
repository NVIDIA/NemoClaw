// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  PodmanExecutableAuthorityDeps,
  PodmanExecutableStat,
  PodmanSocketAuthority,
} from "../../adapters/podman";
import type {
  ContainerEngineCommandCapture,
  ContainerEngineCommandResult,
} from "../../adapters/container-engine";
import {
  OPENSHELL_OPERATION_TIMEOUT_MS,
  OPENSHELL_PROBE_TIMEOUT_MS,
} from "../../adapters/openshell/timeouts";
import type { CheckpointPortableRuntimeAuthority } from "../../state/onboard-checkpoint-types";
import { createSession } from "../../state/onboard-session";
import { makeDeps, makeHostState, unexpected } from "../__test-helpers__/setup-nim-flow";
import { handleProviderInferenceState } from "../machine/handlers/provider-inference";
import { baseOptions, createDeps } from "../machine/handlers/provider-inference.test-support";
import {
  type HostLocalInferenceGatewayMutation,
  prepareHostLocalInferenceStartup,
} from "../runtime-provider/host-local-inference-routing";
import { createPortableOnboardEnvironmentScope } from "../session-bootstrap";
import type { SetupInference } from "../setup-inference";
import { createSetupNim } from "../setup-nim-flow";
import { createPodmanHostLocalInferenceTestHarness } from "../../../../test/helpers/podman-host-local-inference-test-harness";
import {
  createPortableGatewayProviderHarness,
  createPortablePodmanCapture,
  type PortablePodmanAuthorityState,
} from "../../../../test/helpers/hermes-portable-ollama-test-harness";
import {
  hermesPortableOllamaAuthorityInternals,
  PORTABLE_OLLAMA_IMAGE,
  PORTABLE_PROBE_IMAGE,
} from "./hermes-portable-ollama-authority";
import { prepareHermesPortableOllamaProviderRetirement } from "./hermes-portable-ollama-gateway-transaction";
import { createHermesPortableOllamaInferenceResolver } from "./hermes-portable-ollama-inference";
import { PORTABLE_HOST_GATEWAY_IP } from "./portable-profile";

const PODMAN_PATH = "/usr/bin/podman";
const PODMAN_BYTES = Buffer.from("portable-podman-5.7.0", "utf8");
const NETWORK_ID = "6".repeat(64);
const GPU_DEVICE = "nvidia.com/gpu=GPU-12345678-1234-1234-1234-123456789abc";
const temporaryDirectories: string[] = [];
const environmentRestorers: Array<() => void> = [];

interface PullFailure {
  readonly image: string;
  readonly result: ContainerEngineCommandResult;
}

const freshPortableInput = {
  application: "hermes" as const,
  sandboxName: "portable-hermes",
  provider: "ollama-local",
  model: "qwen3-vl:4b",
  acceleration: "nvidia-gpu" as const,
  requireToolCalling: true,
  allowPublishedResume: false,
  recover: false,
};

function runtimeAuthority(homeDir: string): CheckpointPortableRuntimeAuthority {
  const uid = process.getuid!();
  return {
    schemaVersion: 1,
    kind: "podman",
    ownership: "current-user",
    uid,
    homeDir,
    configHome: path.join(homeDir, ".config"),
    runtimeDir: `/run/user/${String(uid)}`,
    socketPath: `/run/user/${String(uid)}/podman/podman.sock`,
  };
}

function socketAuthority(runtime: CheckpointPortableRuntimeAuthority): PodmanSocketAuthority {
  return {
    device: "1",
    inode: "2",
    mode: String(0o140600),
    ownerUid: String(runtime.uid),
    socketPath: runtime.socketPath,
    directoryChain: [],
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

function createRuntimeFixture(pullFailure?: PullFailure) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-inference-"));
  temporaryDirectories.push(homeDir);
  const runtime = runtimeAuthority(homeDir);
  vi.stubEnv("HOME", homeDir);
  vi.stubEnv("PATH", "/usr/bin");
  const environmentScope = createPortableOnboardEnvironmentScope(process.env, null);
  environmentRestorers.push(() => environmentScope.restore());
  environmentScope.installRuntime({
    containersConf: path.join(runtime.configHome, "nemoclaw", "portable", "containers.conf"),
    socketPath: runtime.socketPath,
  });
  const events: string[] = [];
  const authorityState: PortablePodmanAuthorityState = {
    networkId: NETWORK_ID,
    images: new Set<string>(),
    failPull: pullFailure?.image ?? null,
  };
  const gatewayProvider = createPortableGatewayProviderHarness(events);
  const runGatewayOpenshell = vi.fn(gatewayProvider.run);
  const assertSocketAuthority = vi.fn();
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
  let cdiDevices = ["nvidia.com/gpu=all", GPU_DEVICE];
  const capture = createPortablePodmanCapture(events, authorityState, harness.engine.capture);
  const injectedCapture: ContainerEngineCommandCapture = pullFailure
    ? (executable, args, timeoutMs, input, environment) => {
        const result = capture(executable, args, timeoutMs, input, environment);
        return args[2] === "pull" && args[3] === pullFailure.image ? pullFailure.result : result;
      }
    : capture;
  const resolverOptions = {
    runtimeContext: { authority: runtime, environmentScope },
    credentialEnv: "NEMOCLAW_OLLAMA_PROXY_TOKEN",
    getReservationSessionId: () => "portable-session",
    runGatewayOpenshell,
    stateDir: path.join(homeDir, "state"),
    captureSocketAuthority: () => socketAuthority(runtime),
    captureGpuDevices: () => [GPU_DEVICE],
    captureCdiDevices: () => cdiDevices,
    podmanAuthorityDeps: {
      capture: injectedCapture,
      executableAuthorityDeps: executableAuthorityDeps(),
      assertSocketAuthority,
      resolveExecutablePath: () => PODMAN_PATH,
      platform: "linux",
      architecture: "x64",
      uid: runtime.uid,
    },
  } as const;
  return {
    assertSocketAuthority,
    authorityState,
    events,
    gatewayProvider,
    harness,
    homeDir,
    resolverOptions,
    runtime,
    resolve: (input = freshPortableInput) =>
      createHermesPortableOllamaInferenceResolver(resolverOptions)(input),
    setCdiDevices: (devices: string[]) => {
      cdiDevices = devices;
    },
  };
}

function prepareManagedRoute(
  fixture: ReturnType<typeof createRuntimeFixture>,
  selection = fixture.resolve()!,
) {
  const bundle = selection.resolveRuntimeProvider("portable-hermes")!;
  expect(bundle.hostLocalInference.supported).toBe(true);
  const hostLocalInference = bundle.hostLocalInference as Extract<
    typeof bundle.hostLocalInference,
    { supported: true }
  >;
  const operation = hostLocalInference.createOperation({
    env: {},
    acceleration: "nvidia-gpu",
  });
  return prepareHostLocalInferenceStartup(operation, selection.request);
}

const gatewayMutationInput = {
  gatewayName: "nemoclaw",
  sandboxName: "portable-hermes",
  provider: "ollama-local",
  model: "qwen3-vl:4b",
  providerBaseUrl: "http://host.openshell.internal:11434/v1",
} as const;

function createExactGatewayProvider(
  mutation: HostLocalInferenceGatewayMutation,
  baseUrl: string = gatewayMutationInput.providerBaseUrl,
) {
  return mutation.upsertProvider!(
    gatewayMutationInput.provider,
    "openai",
    "NEMOCLAW_OLLAMA_PROXY_TOKEN",
    baseUrl,
    { NEMOCLAW_OLLAMA_PROXY_TOKEN: "ollama" },
  );
}

function gatewayJournalPath(fixture: ReturnType<typeof createRuntimeFixture>): string {
  const root = path.join(fixture.homeDir, "state", "portable-inference");
  const directories = fs.readdirSync(root);
  expect(directories).toHaveLength(1);
  return path.join(root, directories[0]!, "portable-gateway-provider.json");
}

function gatewayJournal(fixture: ReturnType<typeof createRuntimeFixture>) {
  return JSON.parse(fs.readFileSync(gatewayJournalPath(fixture), "utf8")) as {
    phase: string;
    intent: {
      providerCredentialEnv: string;
      transactionId: string;
      targetSha256: string;
      sandboxName: string;
      model: string;
      credentialEnv: string;
    };
    providerAuthority: { id: string; resourceVersion: number } | null;
  };
}

function inferenceReceiptPath(fixture: ReturnType<typeof createRuntimeFixture>): string {
  return path.join(path.dirname(gatewayJournalPath(fixture)), "portable-inference.json");
}

async function publishPortableInference(fixture: ReturnType<typeof createRuntimeFixture>) {
  const selection = fixture.resolve()!;
  const route = prepareManagedRoute(fixture, selection);
  route.prepared.validateBeforeCommit();
  const mutation = await selection.prepareGatewayMutation(gatewayMutationInput);
  createExactGatewayProvider(mutation);
  await mutation.commit();
  route.prepared.commit();
  return gatewayJournal(fixture);
}

afterEach(() => {
  for (const restore of environmentRestorers.splice(0).reverse()) restore();
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("Hermes Portable Ollama inference activation", () => {
  it("retires the exact committed provider and reconciles a repeated absence (#9608)", async () => {
    const fixture = createRuntimeFixture();
    const journal = await publishPortableInference(fixture);
    const options = {
      directory: path.dirname(gatewayJournalPath(fixture)),
      ...journal.intent,
      runGatewayOpenshell: fixture.gatewayProvider.run,
    };

    const prepared = prepareHermesPortableOllamaProviderRetirement(options);
    expect(prepared.present).toBe(true);
    expect(prepared.authority).toMatchObject({
      id: "portable-ollama-provider",
      resourceVersion: 1,
    });
    prepared.removeAndVerify();
    expect(fixture.gatewayProvider.isPresent()).toBe(false);

    const retry = prepareHermesPortableOllamaProviderRetirement({
      ...options,
      allowAbsent: true,
    });
    expect(retry.present).toBe(false);
    retry.removeAndVerify();
    retry.verifyAbsent();
    expect(
      fixture.gatewayProvider
        .calls()
        .filter(({ args }) => args[0] === "provider" && args[1] === "delete"),
    ).toHaveLength(1);
  });

  it("rejects provider revision drift and delimiter-spoofed profile output before delete (#9608)", async () => {
    const generationFixture = createRuntimeFixture();
    const generationJournal = await publishPortableInference(generationFixture);
    generationFixture.gatewayProvider.bumpResourceVersion();
    expect(() =>
      prepareHermesPortableOllamaProviderRetirement({
        directory: path.dirname(gatewayJournalPath(generationFixture)),
        ...generationJournal.intent,
        runGatewayOpenshell: generationFixture.gatewayProvider.run,
      }),
    ).toThrow("provider authority changed");
    expect(
      generationFixture.gatewayProvider
        .calls()
        .some(({ args }) => args[0] === "provider" && args[1] === "delete"),
    ).toBe(false);

    const delimiterFixture = createRuntimeFixture();
    const delimiterJournal = await publishPortableInference(delimiterFixture);
    delimiterFixture.gatewayProvider.setCredentialEnv(
      `${delimiterFixture.gatewayProvider.credentialEnv()},SPOOFED_ENV`,
    );
    expect(() =>
      prepareHermesPortableOllamaProviderRetirement({
        directory: path.dirname(gatewayJournalPath(delimiterFixture)),
        ...delimiterJournal.intent,
        runGatewayOpenshell: delimiterFixture.gatewayProvider.run,
      }),
    ).toThrow("ambiguous gateway provider authority");
    expect(
      delimiterFixture.gatewayProvider
        .calls()
        .some(({ args }) => args[0] === "provider" && args[1] === "delete"),
    ).toBe(false);
  });

  it("rejects ambiguous Portable registry authority before selection (#9596)", () => {
    const capture = createPortablePodmanCapture([], {
      networkId: NETWORK_ID,
      registryCopies: 2,
    });
    const engine = {
      capture: (args: readonly string[], timeoutMs = 30_000) =>
        capture(
          PODMAN_PATH,
          ["--url", "unix:///run/user/1000/podman/podman.sock", ...args],
          timeoutMs,
        ),
    };

    expect(() =>
      hermesPortableOllamaAuthorityInternals.capturePortableNetworkAuthority(engine as never),
    ).toThrow("registry authority is missing or ambiguous");
  });

  it("canonicalizes Portable authority labels without locale-dependent ordering (#9596)", () => {
    const state: PortablePodmanAuthorityState = {
      networkId: NETWORK_ID,
      networkLabels: { z: "last", a: "first" },
    };
    const capture = createPortablePodmanCapture([], state);
    const engine = {
      capture: (args: readonly string[], timeoutMs = 30_000) =>
        capture(
          PODMAN_PATH,
          ["--url", "unix:///run/user/1000/podman/podman.sock", ...args],
          timeoutMs,
        ),
    };
    const localeCompare = vi.spyOn(String.prototype, "localeCompare").mockReturnValue(-1);
    try {
      const first = hermesPortableOllamaAuthorityInternals.capturePortableNetworkAuthority(
        engine as never,
      );
      localeCompare.mockReturnValue(1);
      const second = hermesPortableOllamaAuthorityInternals.capturePortableNetworkAuthority(
        engine as never,
      );

      expect(second.authoritySha256).toBe(first.authoritySha256);
      expect(localeCompare).not.toHaveBeenCalled();
    } finally {
      localeCompare.mockRestore();
    }
  });

  it("rejects a malformed gateway provider create command in its test harness (#9596)", () => {
    const harness = createPortableGatewayProviderHarness([]);

    expect(() =>
      harness.run(["provider", "create", "--name", "ollama-local"], {
        ignoreError: true,
        suppressOutput: true,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: OPENSHELL_OPERATION_TIMEOUT_MS,
      }),
    ).toThrow("without a credential value");
  });

  it("rejects an unknown Podman global command prefix in its test harness (#9596)", () => {
    const capture = createPortablePodmanCapture([], { networkId: NETWORK_ID });

    expect(() => capture(PODMAN_PATH, ["--connection", "ambient", "version"], 30_000)).toThrow(
      "Unexpected Podman global arguments",
    );
  });

  it("fails closed when a fresh Portable selection has no runtime receipt (#9596)", () => {
    vi.stubEnv("NEMOCLAW_EXPERIMENTAL_PROFILE", "portable");
    const resolverOptions = {
      runtimeContext: null,
      credentialEnv: "NEMOCLAW_OLLAMA_PROXY_TOKEN",
      getReservationSessionId: () => null,
      runGatewayOpenshell: () => ({ status: 1, stdout: "", stderr: "" }),
    } as const;
    const resolver = createHermesPortableOllamaInferenceResolver(resolverOptions);

    expect(() => resolver(freshPortableInput)).toThrow("no current-user Podman runtime authority");
    expect(resolver({ ...freshPortableInput, application: "openclaw" })).toBeNull();
    expect(
      resolver({ ...freshPortableInput, application: "langchain-deepagents-code" }),
    ).toBeNull();
    expect(resolver({ ...freshPortableInput, provider: "compatible-endpoint" })).toBeNull();
  });

  it("creates managed Ollama through Podman before recording provider selection (#9596)", async () => {
    const fixture = createRuntimeFixture();
    const session = createSession();
    const resolver = createHermesPortableOllamaInferenceResolver({
      ...fixture.resolverOptions,
      getReservationSessionId: () => session.sessionId,
    });
    const setupNim = createSetupNim(
      makeDeps({
        isNonInteractive: () => true,
        getNonInteractiveProvider: () => process.env.NEMOCLAW_PROVIDER ?? null,
        getNonInteractiveModel: () => process.env.NEMOCLAW_MODEL ?? null,
        localModelProfileIntegration: {
          resolvePlan: () => null,
          onboard: async () => unexpected("local model profile onboarding"),
        },
        detectInferenceProviderHostState: (input) => {
          fixture.events.push(`host-probe:${String(input.probeOllama)}`);
          return makeHostState();
        },
        handleRunningOllamaSelection: async () => unexpected("legacy host Ollama selection"),
        handleInstallOllamaSelection: async () => unexpected("host Ollama installation"),
      }),
    );
    const setupInference = vi.fn<SetupInference>(async (...args) => {
      fixture.events.push("setup-inference");
      const inferenceOptions = args[7];
      expect(inferenceOptions?.reservationSessionId).toBe(session.sessionId);
      const selection = inferenceOptions!.hostLocalInference!;
      expect(selection.request).toMatchObject({
        application: "hermes",
        service: "ollama",
        managed: {
          model: "qwen3-vl:4b",
          networkName: "openshell-docker",
          networkId: NETWORK_ID,
          networkGatewayIp: "10.87.0.1",
          networkListenerIp: PORTABLE_HOST_GATEWAY_IP,
          gpuDevices: [GPU_DEVICE],
        },
      });
      const route = prepareManagedRoute(fixture, selection);
      route.prepared.validateBeforeCommit();
      const gatewayMutation = await selection.prepareGatewayMutation(gatewayMutationInput);
      createExactGatewayProvider(gatewayMutation);
      await gatewayMutation.commit();
      route.prepared.commit();
      fixture.events.push("provider-operation");
      return { ok: true as const };
    });
    const recordStepComplete = vi.fn(async (stepName: string) => {
      fixture.events.push(`complete:${stepName}`);
      return session;
    });
    const { deps, calls } = createDeps({
      setupNim: setupNim as never,
      setupInference: setupInference as never,
      resolveHostLocalInferenceStartupSelection: resolver,
      recordStepComplete: recordStepComplete as never,
    });

    await handleProviderInferenceState({
      ...baseOptions(deps, session),
      agent: { name: "hermes" },
      gpu: { type: "nvidia" },
      gpuPassthrough: true,
      sandboxName: "portable-hermes",
    });

    expect(fixture.events.some((event) => event.startsWith("host-probe:"))).toBe(false);
    expect(fixture.events.indexOf("provider-operation")).toBeLessThan(
      fixture.events.indexOf("complete:provider_selection"),
    );
    expect(fixture.events.indexOf("complete:provider_selection")).toBeLessThan(
      fixture.events.indexOf("complete:inference"),
    );
    expect(calls.prepareLocalProviderForInference).not.toHaveBeenCalled();
    const podmanEvents = fixture.events.filter((event) => event.startsWith("podman:"));
    expect(podmanEvents.length).toBeGreaterThan(0);
    expect(
      podmanEvents.every((event) =>
        event.endsWith(`executable=${PODMAN_PATH} socket=unix://${fixture.runtime.socketPath}`),
      ),
    ).toBe(true);
    expect(podmanEvents.some((event) => event.includes("executable=docker"))).toBe(false);
    expect(
      fixture.gatewayProvider
        .calls()
        .every(({ args, timeout }) =>
          args[1] === "get"
            ? timeout === OPENSHELL_PROBE_TIMEOUT_MS
            : timeout === OPENSHELL_OPERATION_TIMEOUT_MS,
        ),
    ).toBe(true);
  });

  it("binds an explicit Portable model through runtime and gateway authority (#9596)", async () => {
    const fixture = createRuntimeFixture();
    const model = "llama3.2:1b";
    fixture.harness.state.ollamaPsModels = [
      {
        name: model,
        model,
        size: 2 * 1024 ** 3,
        size_vram: 2 * 1024 ** 3,
        digest: "7".repeat(64),
      },
    ];
    const selection = fixture.resolve({ ...freshPortableInput, model })!;
    expect(selection.request).toMatchObject({ managed: { model } });
    const route = prepareManagedRoute(fixture, selection);
    route.prepared.validateBeforeCommit();
    const mutation = await selection.prepareGatewayMutation({ ...gatewayMutationInput, model });
    createExactGatewayProvider(mutation);
    await mutation.commit();
    route.prepared.commit();
    expect(route.receipt).toMatchObject({ inference: { model } });
    const published = fixture.resolve({
      ...freshPortableInput,
      model,
      allowPublishedResume: true,
      recover: true,
    })!;
    await expect(
      published.prepareGatewayMutation({ ...gatewayMutationInput, model }),
    ).resolves.toBeDefined();
    await expect(published.prepareGatewayMutation(gatewayMutationInput)).rejects.toThrow(
      "gateway mutation authority changed",
    );
  });

  it("fails before runtime mutation when current CDI authority drifts (#9596)", () => {
    const fixture = createRuntimeFixture();
    const initialPulls = fixture.events.filter((event) => event.includes("podman:pull ")).length;
    fixture.setCdiDevices(["nvidia.com/gpu=all"]);
    expect(() => fixture.resolve()).toThrow("GPU and CDI authority disagree");
    expect(fixture.events.filter((event) => event.includes("podman:pull "))).toHaveLength(
      initialPulls,
    );
  });

  it.each([
    [
      "network identity",
      (state: PortablePodmanAuthorityState) => (state.networkId = "8".repeat(64)),
      "network or registry authority drifted",
    ],
    [
      "registry identity",
      (state: PortablePodmanAuthorityState) => (state.registryId = "9".repeat(64)),
      "network or registry authority drifted",
    ],
    [
      "registry label",
      (state: PortablePodmanAuthorityState) => (state.registryLabel = "0"),
      "registry authority changed after host preparation",
    ],
    [
      "registry network",
      (state: PortablePodmanAuthorityState) => (state.registryNetworkId = "5".repeat(64)),
      "registry authority changed after host preparation",
    ],
  ])("fails before runtime mutation when current %s drifts (#9596)", (_label, mutate, error) => {
    const fixture = createRuntimeFixture();
    const initialPulls = fixture.events.filter((event) => event.includes("podman:pull ")).length;
    const selection = fixture.resolve()!;
    mutate(fixture.authorityState);
    expect(() => selection.resolveRuntimeProvider("portable-hermes")).toThrow(error);
    expect(fixture.events.filter((event) => event.includes("podman:pull "))).toHaveLength(
      initialPulls,
    );
  });

  it.each([
    [
      "network backend",
      (state: PortablePodmanAuthorityState) => (state.networkBackend = "cni"),
      "network backend must be 'netavark'",
    ],
    [
      "subordinate IDs",
      (state: PortablePodmanAuthorityState) => (state.subordinateIdSize = 1),
      "subordinate UID range for the API service user",
    ],
  ])("rejects changed Portable %s after runtime resolution (#9596)", (_label, mutate, error) => {
    const fixture = createRuntimeFixture();
    const selection = fixture.resolve()!;
    const runtime = selection.resolveRuntimeProvider("portable-hermes")!;
    expect(runtime.hostLocalInference.supported).toBe(true);
    const hostLocalInference = runtime.hostLocalInference as Extract<
      typeof runtime.hostLocalInference,
      { supported: true }
    >;
    mutate(fixture.authorityState);
    expect(() =>
      hostLocalInference.createOperation({
        env: {},
        acceleration: "nvidia-gpu",
      }),
    ).toThrow(error);
  });

  it.each([
    ["Ollama", PORTABLE_OLLAMA_IMAGE],
    ["curl probe", PORTABLE_PROBE_IMAGE],
  ])("reports a bounded redacted exit failure for the pinned %s image (#9701)", (_label, image) => {
    const injectedSecret = ["issue9701", "credential", "canary"].join("-");
    const controlSecret = ["issue9701", "control", "canary"].join("-");
    const standaloneToken = `hf_${"a".repeat(40)}`;
    const jwtToken = ["eyJ" + "c".repeat(12), "d".repeat(12), "e".repeat(12)].join(".");
    const fixture = createRuntimeFixture({
      image,
      result: {
        status: 125,
        stdout: "",
        stderr: `registry refused OPENAI_API_KEY=${injectedSecret} OPENAI_API_\u001bKEY=${controlSecret} Authori\u001bzation: Be\u001barer ${controlSecret} ${standaloneToken} ${jwtToken} https://registry-user:${injectedSecret}@registry.example/v2 ${"detail ".repeat(80)}`,
      },
    });

    let message = "";
    try {
      prepareManagedRoute(fixture);
    } catch (error) {
      message = (error as Error).message;
    }
    const detail = message.split(" Detail: ")[1] ?? "";
    expect(message).toContain(
      `immutable runtime image ${image}: Podman pull exited with status 125`,
    );
    expect(message).toContain("OPENAI_API_KEY=<REDACTED>");
    expect(message).toContain("https://****:****@registry.example/v2");
    expect(message).not.toContain(injectedSecret);
    expect(message).not.toContain(controlSecret);
    expect(message).not.toContain(standaloneToken);
    expect(message).not.toContain(standaloneToken.slice(0, 4));
    expect(message).not.toContain(jwtToken);
    expect(message).not.toContain(jwtToken.slice(0, 4));
    expect(message).not.toContain(jwtToken.split(".")[0]);
    expect(message).not.toContain("registry-user");
    expect(detail.length).toBeGreaterThan(0);
    expect(detail.length).toBeLessThanOrEqual(240);
    expect(fixture.events.filter((event) => event.includes(`podman:pull ${image} `))).toHaveLength(
      1,
    );
    expect(fixture.events.some((event) => event.includes("podman:run "))).toBe(false);
    expect(fixture.harness.container()).toBeNull();
  });

  it.each([
    {
      name: "spawn error",
      image: PORTABLE_OLLAMA_IMAGE,
      code: "ENOENT",
      expected: "Podman pull spawn failed",
    },
    {
      name: "timeout",
      image: PORTABLE_PROBE_IMAGE,
      code: "ETIMEDOUT",
      expected: "Podman pull timed out after 1800000 ms",
    },
  ])("reports a redacted $name before managed container creation (#9701)", (scenario) => {
    const injectedSecret = ["issue9701", "error", "canary"].join("-");
    const controlSecret = ["issue9701", "error", "control", "canary"].join("-");
    const standaloneToken = `hf_${"b".repeat(40)}`;
    const jwtToken = ["eyJ" + "f".repeat(12), "g".repeat(12), "h".repeat(12)].join(".");
    const error = Object.assign(
      new Error(
        `injected ${scenario.name} OPENAI_API_KEY=${injectedSecret} OPENAI_API_\u001bKEY=${controlSecret} ${standaloneToken} ${jwtToken}`,
      ),
      { code: scenario.code },
    );
    const fixture = createRuntimeFixture({
      image: scenario.image,
      result: { status: 1, stdout: "", stderr: "", error },
    });

    let message = "";
    try {
      prepareManagedRoute(fixture);
    } catch (caught) {
      message = (caught as Error).message;
    }
    expect(message).toContain(`immutable runtime image ${scenario.image}: ${scenario.expected}`);
    expect(message).toContain("OPENAI_API_KEY=<REDACTED>");
    expect(message).not.toContain(injectedSecret);
    expect(message).not.toContain(controlSecret);
    expect(message).not.toContain(standaloneToken);
    expect(message).not.toContain(standaloneToken.slice(0, 4));
    expect(message).not.toContain(jwtToken);
    expect(message).not.toContain(jwtToken.slice(0, 4));
    expect(message).not.toContain(jwtToken.split(".")[0]);
    expect(
      fixture.events.filter((event) => event.includes(`podman:pull ${scenario.image} `)),
    ).toHaveLength(1);
    expect(fixture.events.some((event) => event.includes("podman:run "))).toBe(false);
    expect(fixture.harness.container()).toBeNull();
  });

  it("retains immutable image cache while recovering the exact interrupted runtime (#9596)", async () => {
    const fixture = createRuntimeFixture();
    const selection = fixture.resolve()!;
    const request = selection.request as Extract<typeof selection.request, { managed: unknown }>;
    fixture.authorityState.failPull = request.managed.probeImageRef;
    expect(() => prepareManagedRoute(fixture, selection)).toThrow(
      "could not acquire an immutable runtime image",
    );
    expect(fixture.authorityState.images).toContain(request.managed.imageRef);
    expect(fixture.authorityState.images).not.toContain(request.managed.probeImageRef);
    expect(fixture.harness.container()).toBeNull();
    fixture.authorityState.failPull = null;
    prepareManagedRoute(fixture, selection).prepared.validateBeforeCommit();
    const interrupted = fixture.resolve()!;
    expect(interrupted.request).toMatchObject({ recover: true });
    const recovered = prepareManagedRoute(fixture, interrupted);
    recovered.prepared.validateBeforeCommit();
    const gatewayMutation = await interrupted.prepareGatewayMutation(gatewayMutationInput);
    createExactGatewayProvider(gatewayMutation);
    await gatewayMutation.commit();
    recovered.prepared.commit();
    const published = fixture.resolve({
      ...freshPortableInput,
      allowPublishedResume: true,
      recover: true,
    })!;
    expect(published.request).toMatchObject({
      resumeReceipt: { service: "ollama", runtime: { kind: "container" } },
    });
    expect(recovered.receipt).toMatchObject({
      service: "ollama",
      runtime: { modelDigest: `sha256:${"8".repeat(64)}` },
    });
    expect(fixture.harness.events.filter((event) => event.includes("ollama pull"))).toHaveLength(2);
    expect(fixture.events.some((event) => event.includes("image rm"))).toBe(false);
  });

  it("refuses ambiguous gateway metadata and rolls back only its exact provider (#9596)", async () => {
    const fixture = createRuntimeFixture();
    const selection = fixture.resolve()!;
    fixture.gatewayProvider.setMalformed(true);
    await expect(selection.prepareGatewayMutation(gatewayMutationInput)).rejects.toThrow(
      "ambiguous gateway provider authority",
    );
    fixture.gatewayProvider.setMalformed(false);
    const mutation = await selection.prepareGatewayMutation(gatewayMutationInput);
    expect(createExactGatewayProvider(mutation)).toEqual({ ok: true });
    await mutation.commit();
    await mutation.rollback();
    expect(fixture.gatewayProvider.isPresent()).toBe(false);
  });

  it("resumes the journaled provider-create crash window and publishes exact ownership (#9596)", async () => {
    // Crash-window state transitions:
    // S0 has no runtime, provider, journal, or receipt. Runtime preparation creates the container.
    // S1 durably records the exact create intent before issuing `provider create`.
    // S2 has the provider, but crashes before its generated ID is added to the journal.
    // A rerun may adopt only the exact version-1 provider reserved by S1, records its ID, then
    // publishes the route receipt and commits the journal as durable provider ownership.
    const fixture = createRuntimeFixture();
    const selection = fixture.resolve()!;
    const route = prepareManagedRoute(fixture, selection);
    route.prepared.validateBeforeCommit();
    const mutation = await selection.prepareGatewayMutation(gatewayMutationInput);
    const renameSync = fs.renameSync.bind(fs);
    const rename = vi
      .spyOn(fs, "renameSync")
      .mockImplementationOnce(renameSync)
      .mockImplementationOnce(() => {
        throw new Error("injected death before provider identity persistence");
      });
    expect(() => createExactGatewayProvider(mutation)).toThrow(
      "injected death before provider identity persistence",
    );
    rename.mockRestore();
    expect(gatewayJournal(fixture)).toMatchObject({ phase: "creating", providerAuthority: null });

    const restarted = fixture.resolve()!;
    expect(restarted.request).toMatchObject({ recover: true });
    const recoveredRoute = prepareManagedRoute(fixture, restarted);
    recoveredRoute.prepared.validateBeforeCommit();
    const resumedMutation = await restarted.prepareGatewayMutation(gatewayMutationInput);
    expect(createExactGatewayProvider(resumedMutation)).toEqual({ ok: true });
    await resumedMutation.commit();
    recoveredRoute.prepared.commit();
    const published = fixture.resolve({
      ...freshPortableInput,
      allowPublishedResume: true,
      recover: true,
    });

    expect(published?.request).toHaveProperty("resumeReceipt");
    expect(gatewayJournal(fixture)).toMatchObject({
      phase: "committed",
      providerAuthority: { id: "portable-ollama-provider", resourceVersion: 1 },
    });
    expect(gatewayJournal(fixture).intent.providerCredentialEnv).toMatch(
      /^NEMOCLAW_OLLAMA_PROXY_TOKEN_[A-F0-9]{64}$/u,
    );
    expect(
      fixture.events.filter((event) =>
        event.startsWith(
          "openshell:provider create --name ollama-local --type openai --credential NEMOCLAW_OLLAMA_PROXY_TOKEN_",
        ),
      ),
    ).toHaveLength(1);
    expect(fixture.gatewayProvider.isPresent()).toBe(true);
    expect(fixture.harness.container()).not.toBeNull();
  });

  it("recovers the exact route-publication gap before receipt commit (#9596)", async () => {
    const fixture = createRuntimeFixture();
    const selection = fixture.resolve()!;
    const route = prepareManagedRoute(fixture, selection);
    route.prepared.validateBeforeCommit();
    const mutation = await selection.prepareGatewayMutation(gatewayMutationInput);
    createExactGatewayProvider(mutation);
    await mutation.commit();

    const restarted = fixture.resolve({
      ...freshPortableInput,
      allowPublishedResume: true,
      recover: true,
    })!;
    expect(restarted.request).toMatchObject({ recover: true });
    const recoveredRoute = prepareManagedRoute(fixture, restarted);
    recoveredRoute.prepared.validateBeforeCommit();
    const resumedMutation = await restarted.prepareGatewayMutation(gatewayMutationInput);
    expect(createExactGatewayProvider(resumedMutation)).toEqual({ ok: true });
    await resumedMutation.commit();
    recoveredRoute.prepared.commit();

    expect(
      fixture.events.filter((event) => event.includes("provider create --name ollama-local")),
    ).toHaveLength(1);
    expect(gatewayJournal(fixture)).toMatchObject({ phase: "committed" });
    expect(fs.existsSync(inferenceReceiptPath(fixture))).toBe(true);
  });

  it("accepts only the exact hard-link residue from durable file publication (#9596)", async () => {
    const fixture = createRuntimeFixture();
    const selection = fixture.resolve()!;
    const route = prepareManagedRoute(fixture, selection);
    route.prepared.validateBeforeCommit();
    const mutation = await selection.prepareGatewayMutation(gatewayMutationInput);
    createExactGatewayProvider(mutation);
    await mutation.commit();
    route.prepared.commit();
    const journalPath = gatewayJournalPath(fixture);
    const receiptPath = inferenceReceiptPath(fixture);
    fs.linkSync(
      journalPath,
      path.join(
        path.dirname(journalPath),
        ".portable-gateway-provider.json.00000000-0000-4000-8000-000000000001.tmp",
      ),
    );
    fs.linkSync(
      receiptPath,
      path.join(
        path.dirname(receiptPath),
        ".portable-inference.json.00000000-0000-4000-8000-000000000002.tmp",
      ),
    );

    const resumed = fixture.resolve({
      ...freshPortableInput,
      allowPublishedResume: true,
      recover: true,
    })!;

    expect(resumed.request).toHaveProperty("resumeReceipt");
    await expect(resumed.prepareGatewayMutation(gatewayMutationInput)).resolves.toBeDefined();
  });

  it("rejects a hard link outside the exact durable publication name (#9596)", async () => {
    const fixture = createRuntimeFixture();
    const selection = fixture.resolve()!;
    await selection.prepareGatewayMutation(gatewayMutationInput);
    const journalPath = gatewayJournalPath(fixture);
    fs.linkSync(journalPath, path.join(path.dirname(journalPath), "foreign-hard-link"));

    expect(() => fixture.resolve()).toThrow(
      "gateway provider journal lacks private file authority",
    );
  });

  it("rejects gateway lookup failure and changed provider generations (#9596)", async () => {
    const fixture = createRuntimeFixture();
    const selection = fixture.resolve()!;
    fixture.gatewayProvider.setLookupFailure(true);
    await expect(selection.prepareGatewayMutation(gatewayMutationInput)).rejects.toThrow(
      "could not prove gateway provider absence",
    );
    fixture.gatewayProvider.setLookupFailure(false);
    const mutation = await selection.prepareGatewayMutation(gatewayMutationInput);
    expect(() => createExactGatewayProvider(mutation, "http://192.0.2.2:11434/v1")).toThrow(
      "provider mutation authority changed",
    );
    createExactGatewayProvider(mutation);
    fixture.gatewayProvider.bumpResourceVersion();
    expect(() => mutation.commit()).toThrow("gateway provider authority changed");
    expect(() => mutation.rollback()).toThrow("refused to delete changed gateway authority");
    expect(fixture.gatewayProvider.isPresent()).toBe(true);
  });

  it("rejects a same-name foreign create across the ambiguous create boundary (#9596)", async () => {
    const fixture = createRuntimeFixture();
    const selection = fixture.resolve()!;
    const mutation = await selection.prepareGatewayMutation(gatewayMutationInput);
    fixture.gatewayProvider.setForeignCreateCredentialEnv(
      "NEMOCLAW_OLLAMA_PROXY_TOKEN_FOREIGN_TRANSACTION",
    );

    expect(() => createExactGatewayProvider(mutation)).toThrow(
      "ambiguous gateway provider authority",
    );

    expect(gatewayJournal(fixture)).toMatchObject({
      phase: "creating",
      providerAuthority: null,
    });
    expect(fixture.gatewayProvider.isPresent()).toBe(true);
    expect(fixture.events.some((event) => event.includes("provider delete"))).toBe(false);
  });

  it("adopts an exact transaction-marked provider after create transport ambiguity (#9596)", async () => {
    const fixture = createRuntimeFixture();
    const selection = fixture.resolve()!;
    const mutation = await selection.prepareGatewayMutation(gatewayMutationInput);
    fixture.gatewayProvider.setCreateTransportAmbiguity(true);

    expect(createExactGatewayProvider(mutation)).toEqual({ ok: true });
    expect(gatewayJournal(fixture)).toMatchObject({
      phase: "created",
      providerAuthority: { id: "portable-ollama-provider", resourceVersion: 1 },
    });
    expect(fixture.gatewayProvider.credentialEnv()).toBe(
      gatewayJournal(fixture).intent.providerCredentialEnv,
    );
    expect(fixture.gatewayProvider.credentialEnv()).toMatch(
      /^NEMOCLAW_OLLAMA_PROXY_TOKEN_[A-F0-9]{64}$/u,
    );
  });

  it.each([
    {
      name: "missing journal",
      mutate: (fixture: ReturnType<typeof createRuntimeFixture>) =>
        fs.rmSync(gatewayJournalPath(fixture)),
      expected: "unowned existing gateway provider",
    },
    {
      name: "missing provider",
      mutate: (fixture: ReturnType<typeof createRuntimeFixture>) =>
        fixture.gatewayProvider.setPresent(false),
      expected: "recorded gateway provider authority changed",
    },
    {
      name: "changed generation",
      mutate: (fixture: ReturnType<typeof createRuntimeFixture>) =>
        fixture.gatewayProvider.bumpResourceVersion(),
      expected: "recorded gateway provider authority changed",
    },
    {
      name: "ambiguous provider output",
      mutate: (fixture: ReturnType<typeof createRuntimeFixture>) =>
        fixture.gatewayProvider.setMalformed(true),
      expected: "ambiguous gateway provider authority",
    },
  ])("fails closed with zero gateway mutation for $name (#9596)", async ({ mutate, expected }) => {
    const fixture = createRuntimeFixture();
    const selection = fixture.resolve()!;
    const mutation = await selection.prepareGatewayMutation(gatewayMutationInput);
    createExactGatewayProvider(mutation);
    mutate(fixture);
    const mutationsBefore = fixture.events.filter(
      (event) => event.includes("provider create") || event.includes("provider delete"),
    );

    expect(() => fixture.resolve()).toThrow(expected);

    expect(
      fixture.events.filter(
        (event) => event.includes("provider create") || event.includes("provider delete"),
      ),
    ).toEqual(mutationsBefore);
  });

  it("retains runtime authority when exact gateway provider deletion fails (#9596)", async () => {
    const fixture = createRuntimeFixture();
    const selection = fixture.resolve()!;
    const mutation = await selection.prepareGatewayMutation(gatewayMutationInput);
    createExactGatewayProvider(mutation);
    await mutation.commit();
    fixture.gatewayProvider.setDeleteFailure(true);
    expect(() => mutation.rollback()).toThrow("could not resume its gateway provider rollback");
    expect(fixture.gatewayProvider.isPresent()).toBe(true);
    expect(gatewayJournal(fixture)).toMatchObject({ phase: "rolling-back" });

    fixture.gatewayProvider.setDeleteFailure(false);
    const restarted = fixture.resolve()!;
    const resumed = await restarted.prepareGatewayMutation(gatewayMutationInput);
    expect(fixture.gatewayProvider.isPresent()).toBe(false);
    expect(gatewayJournal(fixture)).toMatchObject({ phase: "prepared" });
    expect(createExactGatewayProvider(resumed)).toEqual({ ok: true });
    expect(fixture.gatewayProvider.isPresent()).toBe(true);
  });
});
