// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { createInMemoryRuntimeProviderBundle } from "../../../../test/helpers/runtime-provider-bundle";
import { PolicyAuthorityRefusalError } from "../../adapters/openshell/policy-authority";
import type { ContainerEngine } from "../../adapters/container-engine";
import type { PodmanContainerEngine } from "../../adapters/podman";
import type { RuntimeProviderWorkloadProfile } from "../../onboard/runtime-provider/contract";
import { createDockerRuntimeProviderBundle } from "../../onboard/runtime-provider/docker";
import type { DockerLlamaCppManagedLifecycle } from "../../onboard/runtime-provider/docker-llama-cpp-managed-lifecycle";
import {
  createDockerLlamaCppOperationAuthority as createManagedLlamaCppDockerAuthority,
  createManagedLlamaCppEngine,
  type DockerLlamaCppOperationAuthority as ManagedLlamaCppDockerAuthority,
  dockerLlamaCppBindingSha256 as managedLlamaCppBindingSha256,
} from "../../onboard/runtime-provider/docker-llama-cpp-operation";
import {
  createHostLocalCreateJournalStore,
  HOST_LOCAL_CREATE_JOURNAL_DIRECTORY,
} from "../../onboard/runtime-provider/host-local-create-journal";
import {
  type HostLocalInferenceOperation,
  type HostLocalInferenceReceipt,
  type HostLocalLlamaCppLifecycle,
  serializeHostLocalInferenceReceipt,
} from "../../onboard/runtime-provider/host-local-inference";
import { persistedEngineAuthorityPath } from "../../onboard/runtime-provider/persisted-engine-authority";
import { createPodmanRuntimeProviderBundle } from "../../onboard/runtime-provider/podman";
import { isLlamaCppServingRecipe } from "../serving/adapter-registry";
import { loadManagedInferenceCatalog } from "../serving/catalog-loader";
import type { ResolvedLlamaCppInferenceSelection } from "../serving/types";
import {
  inspectManagedLlamaCppRuntimeExact,
  installManagedLlamaCpp,
  MANAGED_LLAMA_CPP_NETWORK_NAME,
  rehydrateManagedLlamaCppLifecycle,
  resumeManagedLlamaCppRuntime,
} from "./managed-installer";
import {
  driftingDockerCapture,
  engineHarness,
  successfulDockerCapture,
} from "./managed-installer.test-support";
import {
  createManagedLlamaCppReceiptWriter,
  loadManagedLlamaCppApiKey,
  loadOrCreateManagedLlamaCppApiKey,
  managedLlamaCppStatePaths,
  reserveManagedLlamaCppOwner,
} from "./managed-state";

const TEST_WORKLOAD_PROFILE = {
  support: null,
  hostArchitectures: ["arm64"],
  managedImageSelectionPolicy: "prefer-managed",
  legacyDockerfileBuilds: false,
} as const satisfies RuntimeProviderWorkloadProfile;

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

function temporaryHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-managed-llama-cpp-"));
  const canonicalHome = fs.realpathSync(home);
  temporaryDirectories.push(canonicalHome);
  return canonicalHome;
}

function temporarySymlinkedHome(): { readonly alias: string; readonly canonical: string } {
  const root = temporaryHome();
  const canonical = path.join(root, "canonical-home");
  const alias = path.join(root, "symlinked-home");
  fs.mkdirSync(canonical, { mode: 0o700 });
  fs.symlinkSync(canonical, alias, "dir");
  return { alias, canonical: fs.realpathSync(canonical) };
}

function inertPodmanEngine(
  operation: "host-doctor" | "sandbox-lifecycle",
  capture: ContainerEngine["capture"],
  captureHost: ContainerEngine["captureHost"],
): PodmanContainerEngine {
  return {
    operation,
    engineId: "podman",
    displayName: "Podman",
    authorityId: "test:podman-socket",
    endpointAuthorityId: "test:podman-socket",
    capture,
    captureHost,
  };
}

function managedOperation(
  engine: HostLocalInferenceOperation["engine"],
  createLlamaCppLifecycle: (
    input: Parameters<HostLocalInferenceOperation["createLlamaCppLifecycle"]>[0],
  ) => HostLocalLlamaCppLifecycle,
): HostLocalInferenceOperation {
  return {
    providerId: "docker",
    engine,
    bindingSha256: managedLlamaCppBindingSha256(engine),
    assertAuthority: vi.fn(),
    spawn: vi.fn(() => ({}) as never),
    createLlamaCppLifecycle,
  };
}

function managedRuntimeProvider(
  engine: HostLocalInferenceOperation["engine"],
  createLlamaCppLifecycle: HostLocalInferenceOperation["createLlamaCppLifecycle"] = vi.fn(() => {
    throw new Error("Unexpected managed llama.cpp lifecycle construction");
  }),
) {
  const bundle = createDockerRuntimeProviderBundle();
  return {
    ...bundle,
    hostLocalInference: {
      providerId: "docker",
      supported: true as const,
      services: ["llama-cpp" as const],
      createOperation: vi.fn(() => managedOperation(engine, createLlamaCppLifecycle)),
    },
  };
}

function selection(): ResolvedLlamaCppInferenceSelection {
  const catalog = loadManagedInferenceCatalog();
  const recipe = catalog.recipes.find(
    ({ metadata }) => metadata.id === "llama-cpp.nemotron-3-nano-30b-a3b.spark-single.v1",
  );
  const preset = catalog.presets.find(
    ({ metadata }) => metadata.id === "llama-cpp.dgx-spark-gb10.single.nemotron-3-nano-30b-a3b",
  );
  expect(recipe, "managed llama.cpp recipe fixture is unavailable").toBeDefined();
  expect(isLlamaCppServingRecipe(recipe!), "managed llama.cpp recipe fixture is invalid").toBe(
    true,
  );
  expect(preset, "managed llama.cpp preset fixture is unavailable").toBeDefined();
  return {
    outcome: "selected",
    selection: "explicit",
    catalogDigest: catalog.catalogDigest,
    presetDigest: catalog.sources.find(
      ({ kind, id }) => kind === "ServingPreset" && id === preset!.metadata.id,
    )!.digest,
    recipeDigest: catalog.sources.find(
      ({ kind, id }) => kind === "ServingRecipe" && id === recipe!.metadata.id,
    )!.digest,
    preset: preset!,
    recipe: recipe! as ResolvedLlamaCppInferenceSelection["recipe"],
  };
}

function verifiedArtifact(selected: ResolvedLlamaCppInferenceSelection, homeDir: string) {
  const hostPath = path.join(homeDir, "model.gguf");
  fs.writeFileSync(hostPath, "fixture", { mode: 0o600 });
  const identity = fs.lstatSync(hostPath, { bigint: true });
  return {
    digest: selected.recipe.spec.model.files[0]!.digest,
    filesystemIdentity: {
      ctimeNs: identity.ctimeNs,
      dev: identity.dev,
      ino: identity.ino,
      mtimeNs: identity.mtimeNs,
      size: identity.size,
    },
    hostPath,
    sizeBytes: selected.recipe.spec.model.files[0]!.sizeBytes,
  };
}

function dormantManagedLifecycle(): DockerLlamaCppManagedLifecycle {
  const receipt = { schemaVersion: 1 } as HostLocalInferenceReceipt;
  return {
    recoverUnfinished: vi.fn(() => ({ recovered: [], failures: [] })),
    resume: vi.fn(() => receipt),
    runtime: {} as DockerLlamaCppManagedLifecycle["runtime"],
    start: vi.fn(() => receipt),
  };
}

describe("managed llama.cpp Docker authority", () => {
  it("rejects a direct plaintext TCP daemon before spawning and never exposes HF_TOKEN", () => {
    const capture = successfulDockerCapture({});
    const spawnDocker = vi.fn<ManagedLlamaCppDockerAuthority["spawn"]>(() => ({}) as never);

    expect(() =>
      createManagedLlamaCppDockerAuthority(
        {
          DOCKER_HOST: "tcp://spark.example.test:2375",
          HF_TOKEN: "hf_secret_value",
        },
        capture,
        spawnDocker,
      ),
    ).toThrowError(/^Managed llama\.cpp requires verified TLS for remote Docker TCP endpoints\.$/u);
    expect(capture).not.toHaveBeenCalled();
    expect(spawnDocker).not.toHaveBeenCalled();
  });

  it("rejects a TCP context that skips TLS verification before a daemon command", () => {
    const capture = successfulDockerCapture({
      spark: {
        host: "tcp://spark.example.test:2376",
        skipTlsVerify: true,
        tlsMaterial: ["ca.pem", "cert.pem", "key.pem"],
      },
    });

    expect(() =>
      createManagedLlamaCppEngine({ HOME: "/tmp/nemoclaw-home", DOCKER_CONTEXT: "spark" }, capture),
    ).toThrow("requires verified TLS for remote Docker TCP endpoints");
    expect(capture.mock.calls.some(([, args]) => args.at(-1) === "info")).toBe(false);
  });

  it("rejects a TCP context without a trusted CA before a daemon command", () => {
    const capture = successfulDockerCapture({
      spark: {
        host: "tcp://spark.example.test:2376",
        skipTlsVerify: false,
        tlsMaterial: ["cert.pem", "key.pem"],
      },
    });

    expect(() =>
      createManagedLlamaCppEngine({ HOME: "/tmp/nemoclaw-home", DOCKER_CONTEXT: "spark" }, capture),
    ).toThrow("requires verified TLS for remote Docker TCP endpoints");
    expect(capture.mock.calls.some(([, args]) => args.at(-1) === "info")).toBe(false);
  });

  it("accepts a TCP context with verification enabled and trusted CA material", () => {
    const capture = successfulDockerCapture({
      spark: {
        host: "tcp://spark.example.test:2376",
        skipTlsVerify: false,
        tlsMaterial: ["key.pem", "ca.pem", "cert.pem"],
      },
    });
    const engine = createManagedLlamaCppEngine(
      { HOME: "/tmp/nemoclaw-home", DOCKER_CONTEXT: "spark" },
      capture,
    );

    expect(engine.capture(["info"]).status).toBe(0);
    expect(capture.mock.calls.map(([, args]) => args)).toContainEqual([
      "--config",
      "/tmp/nemoclaw-home/.docker",
      "--context",
      "spark",
      "info",
    ]);
  });

  it.each([
    ["unix socket", "unix:///var/run/docker.sock"],
    ["Windows named pipe", "npipe:////./pipe/docker_engine"],
    ["SSH", "ssh://nvidia@spark.example.test"],
  ])("accepts a direct %s daemon without Docker TLS flags", (_label, host) => {
    const capture = successfulDockerCapture({});
    const engine = createManagedLlamaCppEngine(
      { HOME: "/tmp/nemoclaw-home", DOCKER_HOST: host },
      capture,
    );

    expect(engine.capture(["info"]).status).toBe(0);
    expect(capture.mock.calls.at(-1)?.[1]).toEqual([
      "--config",
      "/tmp/nemoclaw-home/.docker",
      "--host",
      host,
      "info",
    ]);
  });

  it("prefixes streamed acquisition with the exact endpoint without exposing HF_TOKEN", () => {
    const capture = successfulDockerCapture({
      spark: "ssh://nvidia@spark.example.test",
    });
    const spawnDocker = vi.fn<ManagedLlamaCppDockerAuthority["spawn"]>(() => ({}) as never);
    const authority = createManagedLlamaCppDockerAuthority(
      {
        DOCKER_CONFIG: "/tmp/nemoclaw-docker-config",
        DOCKER_CONTEXT: "spark",
      },
      capture,
      spawnDocker,
    );

    authority.spawn(["run", "-e", "HF_TOKEN", "example.invalid/downloader@sha256:deadbeef"], {
      env: { HF_TOKEN: "hf_secret_value" },
    });

    const [args, options] = spawnDocker.mock.calls[0]!;
    expect(args).toEqual([
      "--config",
      "/tmp/nemoclaw-docker-config",
      "--context",
      "spark",
      "run",
      "-e",
      "HF_TOKEN",
      "example.invalid/downloader@sha256:deadbeef",
    ]);
    expect(args.join("\n")).not.toContain("hf_secret_value");
    expect(options?.env).toMatchObject({ HF_TOKEN: "hf_secret_value" });
    expect(capture.mock.calls.flatMap(([, command]) => command).join("\n")).not.toContain(
      "hf_secret_value",
    );
  });

  it("rechecks a qualified endpoint before forwarding HF_TOKEN to Docker", () => {
    const capture = driftingDockerCapture();
    const spawnDocker = vi.fn(() => ({}) as never);
    const authority = createManagedLlamaCppDockerAuthority(
      { HOME: "/tmp/nemoclaw-home", DOCKER_CONTEXT: "spark" },
      capture,
      spawnDocker,
    );

    expect(() =>
      authority.spawn(["run", "-e", "HF_TOKEN", "example.invalid/downloader"], {
        env: { HF_TOKEN: "hf_secret_value" },
      }),
    ).toThrow("Docker context endpoint changed after qualification");
    expect(spawnDocker).not.toHaveBeenCalled();
  });

  it("binds a named context to both the opaque authority and every daemon command", () => {
    const capture = successfulDockerCapture({
      "spark-a": "ssh://nvidia@spark-a.example.test",
      "spark-b": "ssh://nvidia@spark-b.example.test",
    });
    const configPath = "/tmp/nemoclaw-sensitive-docker-config";
    const first = createManagedLlamaCppEngine(
      { DOCKER_CONFIG: configPath, DOCKER_CONTEXT: "spark-a" },
      capture,
    );
    const second = createManagedLlamaCppEngine(
      { DOCKER_CONFIG: configPath, DOCKER_CONTEXT: "spark-b" },
      capture,
    );

    expect(first.authorityId).not.toBe(second.authorityId);
    expect(first.authorityId).not.toContain(configPath);
    expect(first.authorityId).not.toContain("spark-a");
    expect(first.capture(["info"]).status).toBe(0);
    expect(second.capture(["version"]).status).toBe(0);
    expect(capture.mock.calls.map(([, args]) => args)).toContainEqual([
      "--config",
      configPath,
      "--context",
      "spark-a",
      "info",
    ]);
    expect(capture.mock.calls.map(([, args]) => args)).toContainEqual([
      "--config",
      configPath,
      "--context",
      "spark-b",
      "version",
    ]);
  });

  it("binds DOCKER_HOST, config, and TLS material as explicit Docker arguments", () => {
    const capture = successfulDockerCapture({});
    const certPath = "/tmp/nemoclaw-sensitive-docker-certs";
    const first = createManagedLlamaCppEngine(
      {
        DOCKER_CERT_PATH: certPath,
        DOCKER_CONFIG: "/tmp/nemoclaw-docker-config",
        DOCKER_HOST: "tcp://spark-a.example.test:2376",
        DOCKER_TLS_VERIFY: "1",
      },
      capture,
    );
    const second = createManagedLlamaCppEngine(
      {
        DOCKER_CERT_PATH: certPath,
        DOCKER_CONFIG: "/tmp/nemoclaw-docker-config",
        DOCKER_HOST: "tcp://spark-b.example.test:2376",
        DOCKER_TLS_VERIFY: "1",
      },
      capture,
    );

    expect(first.authorityId).not.toBe(second.authorityId);
    expect(first.authorityId).not.toContain(certPath);
    expect(first.authorityId).not.toContain("spark-a.example.test");
    expect(first.capture(["info"]).status).toBe(0);
    expect(capture.mock.calls.at(-1)?.[1]).toEqual([
      "--config",
      "/tmp/nemoclaw-docker-config",
      "--host",
      "tcp://spark-a.example.test:2376",
      "--tlsverify",
      "--tlscacert",
      path.join(certPath, "ca.pem"),
      "--tlscert",
      path.join(certPath, "cert.pem"),
      "--tlskey",
      path.join(certPath, "key.pem"),
      "info",
    ]);
  });

  it("pins Docker's persisted current context instead of consulting it on later commands", () => {
    const capture = successfulDockerCapture(
      { "desktop-linux": "unix:///tmp/docker-desktop.sock" },
      "desktop-linux",
    );
    const engine = createManagedLlamaCppEngine({ HOME: "/tmp/nemoclaw-home" }, capture);

    expect(engine.capture(["info"]).status).toBe(0);
    expect(capture.mock.calls.map(([, args]) => args)).toContainEqual([
      "--config",
      "/tmp/nemoclaw-home/.docker",
      "--context",
      "desktop-linux",
      "info",
    ]);
  });

  it("fails closed before a daemon command when a qualified context endpoint drifts", () => {
    const capture = driftingDockerCapture();
    const engine = createManagedLlamaCppEngine(
      { HOME: "/tmp/nemoclaw-home", DOCKER_CONTEXT: "spark" },
      capture,
    );

    expect(() => engine.capture(["info"])).toThrow(
      "Docker context endpoint changed after qualification",
    );
    expect(capture.mock.calls.some(([, args]) => args.at(-1) === "info")).toBe(false);
  });
});

describe("managed llama.cpp installer", () => {
  it("stops after acquisition when policy authority refuses activation (#9833)", async () => {
    const selected = selection();
    const homeDir = temporaryHome();
    const paths = managedLlamaCppStatePaths(homeDir);
    const harness = engineHarness();
    harness.images.add(selected.recipe.spec.runtime.image);
    harness.images.add(selected.recipe.spec.readiness.probeImage);
    const lifecycle = dormantManagedLifecycle();
    const revalidatePolicyRequirements = vi
      .fn<(operation: string) => void>()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new PolicyAuthorityRefusalError(
          "External policy authority must supply the managed llama.cpp entry.",
        );
      });

    await expect(
      installManagedLlamaCpp(selected, {
        sandboxName: "spark-agent",
        homeDir,
        runtimeProvider: managedRuntimeProvider(harness.engine, () => lifecycle),
        verifyGguf: vi.fn(async () => verifiedArtifact(selected, homeDir)),
        checkPort: vi.fn(async () => ({ ok: true })),
        log: vi.fn(),
        revalidatePolicyRequirements,
      }),
    ).rejects.toBeInstanceOf(PolicyAuthorityRefusalError);

    expect(revalidatePolicyRequirements).toHaveBeenNthCalledWith(
      1,
      "reserve the managed llama.cpp runtime",
    );
    expect(revalidatePolicyRequirements).toHaveBeenNthCalledWith(
      2,
      "activate the managed llama.cpp runtime",
    );
    expect(fs.existsSync(paths.ownerPath)).toBe(false);
    expect(
      fs.existsSync(persistedEngineAuthorityPath(paths.stateDir, "host-local-inference")),
    ).toBe(false);
    expect(loadManagedLlamaCppApiKey(paths)).toBeNull();
    expect(lifecycle.recoverUnfinished).not.toHaveBeenCalled();
    expect(lifecycle.start).not.toHaveBeenCalled();
    expect(lifecycle.resume).not.toHaveBeenCalled();
  });

  it("rechecks a resumed runtime before lifecycle recovery or credentials (#9833)", async () => {
    const selected = selection();
    const homeDir = temporaryHome();
    const paths = managedLlamaCppStatePaths(homeDir);
    reserveManagedLlamaCppOwner(paths, {
      schemaVersion: 1,
      sandboxName: "spark-agent",
      catalogDigest: selected.catalogDigest,
      presetDigest: selected.presetDigest,
      recipeDigest: selected.recipeDigest,
      recipeId: selected.recipe.metadata.id,
    });
    const harness = engineHarness();
    harness.images.add(selected.recipe.spec.runtime.image);
    harness.images.add(selected.recipe.spec.readiness.probeImage);
    const lifecycle = dormantManagedLifecycle();
    const revalidatePolicyRequirements = vi
      .fn<(operation: string) => void>()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new PolicyAuthorityRefusalError(
          "External policy authority must supply the managed llama.cpp entry.",
        );
      });

    await expect(
      resumeManagedLlamaCppRuntime("spark-agent", {
        homeDir,
        runtimeProvider: managedRuntimeProvider(harness.engine, () => lifecycle),
        verifyGguf: vi.fn(async () => verifiedArtifact(selected, homeDir)),
        checkPort: vi.fn(async () => ({ ok: true })),
        revalidatePolicyRequirements,
      }),
    ).rejects.toBeInstanceOf(PolicyAuthorityRefusalError);

    expect(revalidatePolicyRequirements).toHaveBeenNthCalledWith(
      1,
      "inspect the managed llama.cpp runtime",
    );
    expect(revalidatePolicyRequirements).toHaveBeenNthCalledWith(
      2,
      "recover the managed llama.cpp runtime",
    );
    expect(loadManagedLlamaCppApiKey(paths)).toBeNull();
    expect(lifecycle.recoverUnfinished).not.toHaveBeenCalled();
    expect(lifecycle.start).not.toHaveBeenCalled();
    expect(lifecycle.resume).not.toHaveBeenCalled();
  });

  it.each(["podman", "unsupported-runtime"])(
    "rejects the %s provider before any Docker or installer mutation",
    async (providerId) => {
      const selected = selection();
      const homeDir = temporaryHome();
      const acquireGguf = vi.fn();
      const verifyGguf = vi.fn();
      const checkPort = vi.fn();
      const runtimeProvider = createInMemoryRuntimeProviderBundle({
        providerId,
        workloadProfile: TEST_WORKLOAD_PROFILE,
      });

      await expect(
        installManagedLlamaCpp(selected, {
          sandboxName: "spark-agent",
          homeDir,
          runtimeProvider,
          acquireGguf: acquireGguf as never,
          verifyGguf: verifyGguf as never,
          checkPort: checkPort as never,
          log: vi.fn(),
        }),
      ).resolves.toEqual({
        ok: false,
        reason: `Runtime provider '${providerId}' does not provide the host-local-inference capability required for llama-cpp: Unsupported by this in-memory contract fixture.`,
      });

      expect(acquireGguf).not.toHaveBeenCalled();
      expect(verifyGguf).not.toHaveBeenCalled();
      expect(checkPort).not.toHaveBeenCalled();
      expect(fs.existsSync(managedLlamaCppStatePaths(homeDir).stateDir)).toBe(false);
    },
  );

  it("rejects the real Podman provider before engine, acquisition, or state mutation", async () => {
    const selected = selection();
    const homeDir = temporaryHome();
    const engineCapture = vi.fn<ContainerEngine["capture"]>();
    const hostCapture = vi.fn<ContainerEngine["captureHost"]>();
    const acquireGguf = vi.fn();
    const verifyGguf = vi.fn();
    const checkPort = vi.fn();
    const runtimeProvider = createPodmanRuntimeProviderBundle({
      engines: {
        hostDoctor: inertPodmanEngine("host-doctor", engineCapture, hostCapture),
        sandboxLifecycle: inertPodmanEngine("sandbox-lifecycle", engineCapture, hostCapture),
      },
    });

    await expect(
      installManagedLlamaCpp(selected, {
        sandboxName: "spark-agent",
        homeDir,
        runtimeProvider,
        acquireGguf: acquireGguf as never,
        verifyGguf: verifyGguf as never,
        checkPort: checkPort as never,
        log: vi.fn(),
      }),
    ).resolves.toEqual({
      ok: false,
      reason:
        "Runtime provider 'podman' does not provide the host-local-inference capability required for llama-cpp: Podman host-local inference remains disabled without injected candidate authority.",
    });

    expect(engineCapture).not.toHaveBeenCalled();
    expect(hostCapture).not.toHaveBeenCalled();
    expect(acquireGguf).not.toHaveBeenCalled();
    expect(verifyGguf).not.toHaveBeenCalled();
    expect(checkPort).not.toHaveBeenCalled();
    expect(fs.existsSync(managedLlamaCppStatePaths(homeDir).stateDir)).toBe(false);
  });

  it("rejects a group/world-writable shared cache parent before pull or acquisition", async () => {
    const selected = selection();
    const homeDir = temporaryHome();
    const cacheParent = path.join(homeDir, ".cache");
    fs.mkdirSync(cacheParent, { mode: 0o700 });
    fs.chmodSync(cacheParent, 0o777);
    const harness = engineHarness();
    const acquireGguf = vi.fn();

    const result = await installManagedLlamaCpp(selected, {
      sandboxName: "spark-agent",
      homeDir,
      runtimeProvider: managedRuntimeProvider(harness.engine),
      acquireGguf: acquireGguf as never,
      checkPort: vi.fn(async () => ({ ok: true })),
      log: vi.fn(),
    });

    expect(result).toEqual({
      ok: false,
      reason: "The shared cache parent is not current-user filesystem authority.",
    });
    expect(harness.pulledImages).toEqual([]);
    expect(acquireGguf).not.toHaveBeenCalled();
    expect(harness.capture.mock.calls.some(([args]) => args[0] === "image")).toBe(false);
  });

  it("rejects a symlinked shared cache parent before pull or acquisition", async () => {
    const selected = selection();
    const homeDir = temporaryHome();
    const cacheTarget = temporaryHome();
    fs.symlinkSync(cacheTarget, path.join(homeDir, ".cache"), "dir");
    const harness = engineHarness();
    const acquireGguf = vi.fn();

    const result = await installManagedLlamaCpp(selected, {
      sandboxName: "spark-agent",
      homeDir,
      runtimeProvider: managedRuntimeProvider(harness.engine),
      acquireGguf: acquireGguf as never,
      checkPort: vi.fn(async () => ({ ok: true })),
      log: vi.fn(),
    });

    expect(result).toEqual({
      ok: false,
      reason: "The shared cache parent is not current-user filesystem authority.",
    });
    expect(harness.pulledImages).toEqual([]);
    expect(acquireGguf).not.toHaveBeenCalled();
    expect(harness.capture.mock.calls.some(([args]) => args[0] === "image")).toBe(false);
  });

  it("canonicalizes a symlinked home and reuses its existing safe shared cache", async () => {
    const selected = selection();
    const home = temporarySymlinkedHome();
    const cacheRoot = path.join(home.canonical, ".cache", "huggingface");
    fs.mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(cacheRoot), 0o700);
    fs.chmodSync(cacheRoot, 0o700);
    const cacheIdentity = fs.lstatSync(cacheRoot, { bigint: true });
    const modelPath = path.join(home.canonical, "cached-model.gguf");
    fs.writeFileSync(modelPath, "fixture", { mode: 0o600 });
    const modelIdentity = fs.lstatSync(modelPath, { bigint: true });
    const artifact = {
      digest: selected.recipe.spec.model.files[0]!.digest,
      filesystemIdentity: {
        ctimeNs: modelIdentity.ctimeNs,
        dev: modelIdentity.dev,
        ino: modelIdentity.ino,
        mtimeNs: modelIdentity.mtimeNs,
        size: modelIdentity.size,
      },
      hostPath: modelPath,
      sizeBytes: selected.recipe.spec.model.files[0]!.sizeBytes,
    };
    const harness = engineHarness();
    harness.images.add(selected.recipe.spec.runtime.image);
    harness.images.add(selected.recipe.spec.readiness.probeImage);
    const receipt = { schemaVersion: 1 } as HostLocalInferenceReceipt;
    const lifecycle = {
      recoverUnfinished: vi.fn(() => ({ recovered: [], failures: [] })),
      resume: vi.fn(() => receipt),
      runtime: {} as DockerLlamaCppManagedLifecycle["runtime"],
      start: vi.fn(() => receipt),
    } satisfies DockerLlamaCppManagedLifecycle;
    const createLifecycle = vi.fn(() => lifecycle);
    const verifyGguf = vi.fn(async () => artifact);
    const acquireGguf = vi.fn();

    await expect(
      installManagedLlamaCpp(selected, {
        sandboxName: "spark-agent",
        homeDir: home.alias,
        runtimeProvider: managedRuntimeProvider(harness.engine, createLifecycle),
        acquireGguf: acquireGguf as never,
        verifyGguf,
        checkPort: vi.fn(async () => ({ ok: true })),
        log: vi.fn(),
      }),
    ).resolves.toMatchObject({ ok: true, receipt });

    expect(verifyGguf).toHaveBeenCalledWith(expect.any(Object), cacheRoot);
    expect(createLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ cacheRootHostPath: cacheRoot }),
    );
    expect(fs.lstatSync(cacheRoot, { bigint: true }).ino).toBe(cacheIdentity.ino);
    expect(fs.existsSync(managedLlamaCppStatePaths(home.canonical).ownerPath)).toBe(true);
    expect(harness.pulledImages).toEqual([]);
    expect(acquireGguf).not.toHaveBeenCalled();
  });

  it("reconstructs current canonical model identity for the lifecycle exact inspector", () => {
    const selected = selection();
    const homeDir = temporaryHome();
    const source = selected.recipe.spec.model;
    const file = source.files[0]!;
    const modelPath = path.join(
      homeDir,
      ".cache",
      "huggingface",
      "hub",
      `models--${source.id.replaceAll("/", "--")}`,
      "snapshots",
      source.revision,
      file.path,
    );
    fs.mkdirSync(path.dirname(modelPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(modelPath, "status-fixture", { mode: 0o600 });
    const receipt = { schemaVersion: 1 } as HostLocalInferenceReceipt;
    const inspectManaged = vi.fn(() => ({ running: true, receipt }));
    const createLifecycle = vi.fn(
      () =>
        ({
          recoverUnfinished: vi.fn(),
          resume: vi.fn(),
          start: vi.fn(),
          runtime: { inspectManaged } as unknown as DockerLlamaCppManagedLifecycle["runtime"],
        }) satisfies DockerLlamaCppManagedLifecycle,
    );
    const harness = engineHarness();

    expect(
      inspectManagedLlamaCppRuntimeExact({
        homeDir,
        operation: managedOperation(harness.engine, createLifecycle),
        paths: managedLlamaCppStatePaths(homeDir),
        receipt,
        selection: selected,
      }),
    ).toEqual({ running: true, receipt });
    expect(createLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        readinessTimeoutSeconds: selected.recipe.spec.readiness.timeoutSeconds,
        bindings: expect.objectContaining({
          model: expect.objectContaining({
            digest: file.digest,
            hostPath: fs.realpathSync(modelPath),
            sizeBytes: file.sizeBytes,
            filesystemIdentity: expect.objectContaining({
              ino: fs.lstatSync(modelPath, { bigint: true }).ino,
            }),
          }),
        }),
      }),
    );
    expect(inspectManaged).toHaveBeenCalledWith(receipt);
  });

  it("rehydrates the exact lifecycle without rewriting owner, journal, API key, or receipt", () => {
    const selected = selection();
    const homeDir = temporaryHome();
    const paths = managedLlamaCppStatePaths(homeDir);
    const source = selected.recipe.spec.model;
    const file = source.files[0]!;
    const modelPath = path.join(
      homeDir,
      ".cache",
      "huggingface",
      "hub",
      `models--${source.id.replaceAll("/", "--")}`,
      "snapshots",
      source.revision,
      file.path,
    );
    fs.mkdirSync(path.dirname(modelPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(modelPath, "rehydration-fixture", { mode: 0o600 });
    reserveManagedLlamaCppOwner(paths, {
      schemaVersion: 1,
      sandboxName: "spark-agent",
      catalogDigest: selected.catalogDigest,
      presetDigest: selected.presetDigest,
      recipeDigest: selected.recipeDigest,
      recipeId: selected.recipe.metadata.id,
    });
    loadOrCreateManagedLlamaCppApiKey(paths);
    const harness = engineHarness();
    const transactionId = "a".repeat(64);
    const engineAuthority = {
      schemaVersion: 1 as const,
      providerId: "docker",
      operation: "host-local-inference" as const,
      engineId: harness.engine.engineId,
      authorityId: harness.engine.authorityId,
      bindingSha256: managedLlamaCppBindingSha256(harness.engine),
    };
    const receipt = {
      schemaVersion: 1,
      providerId: "docker",
      service: "llama-cpp",
      engineAuthority,
      endpoint: {
        host: "host.openshell.internal",
        port: 8081,
        networkName: MANAGED_LLAMA_CPP_NETWORK_NAME,
      },
      runtime: {
        kind: "container",
        runtimeId: "b".repeat(64),
        name: "nemoclaw-llama-cpp",
        imageRef: selected.recipe.spec.runtime.image,
        probeImageRef: selected.recipe.spec.readiness.probeImage,
        specSha256: "c".repeat(64),
        model: {
          planDigest: `sha256:${"d".repeat(64)}`,
          recipeId: selected.recipe.metadata.id,
          generation: transactionId,
          digest: file.digest,
          sizeBytes: file.sizeBytes,
        },
        gpu: { vendor: "nvidia", count: 1 },
      },
    } as const satisfies HostLocalInferenceReceipt;
    const writer = createManagedLlamaCppReceiptWriter(paths, transactionId);
    writer.writeExact(serializeHostLocalInferenceReceipt(receipt));
    createHostLocalCreateJournalStore(paths.stateDir).create({
      schemaVersion: 1,
      transactionId,
      phase: "prepared",
      providerId: "docker",
      service: "llama-cpp",
      containerName: "nemoclaw-llama-cpp",
      runtimeId: null,
      createIntentUnixMs: null,
      specSha256: receipt.runtime.specSha256,
      networkId: "e".repeat(64),
      apiKeyIdentitySha256: "f".repeat(64),
      apiKeyRootIdentitySha256: "1".repeat(64),
      engineAuthority,
      receiptTargetSha256: writer.targetSha256,
      serializedReceipt: null,
      receiptSha256: null,
    });
    const journalDirectory = path.join(paths.stateDir, HOST_LOCAL_CREATE_JOURNAL_DIRECTORY);
    const protectedFiles = [
      paths.ownerPath,
      paths.apiKeyPath,
      paths.receiptPath,
      ...fs.readdirSync(journalDirectory).map((entry) => path.join(journalDirectory, entry)),
    ];
    const before = new Map(protectedFiles.map((target) => [target, fs.readFileSync(target)]));
    const lifecycle = {
      recoverUnfinished: vi.fn(() => ({ recovered: [], failures: [] })),
      resume: vi.fn(() => receipt),
      runtime: {} as DockerLlamaCppManagedLifecycle["runtime"],
      start: vi.fn(() => receipt),
    } satisfies DockerLlamaCppManagedLifecycle;
    const createLifecycle = vi.fn(() => lifecycle);
    const operation = managedOperation(harness.engine, createLifecycle);
    const runtimeProvider = managedRuntimeProvider(harness.engine, createLifecycle);
    const mismatchedOperation = managedOperation(
      { ...harness.engine, engineId: "other-engine" },
      createLifecycle,
    );

    expect(() =>
      rehydrateManagedLlamaCppLifecycle({
        runtimeProvider,
        runtimeOwnerSandboxName: "spark-agent",
        homeDir,
        operation: mismatchedOperation,
      }),
    ).toThrow("returned mismatched host-local-inference authority");
    expect(createLifecycle).not.toHaveBeenCalled();

    const rehydrated = rehydrateManagedLlamaCppLifecycle({
      runtimeProvider,
      runtimeOwnerSandboxName: "spark-agent",
      homeDir,
      operation,
    });

    expect(rehydrated.lifecycle).toBe(lifecycle);
    expect(rehydrated.operation).toBe(operation);
    expect(rehydrated.receipt).toEqual(receipt);
    expect(rehydrated.owner.sandboxName).toBe("spark-agent");
    expect(rehydrated.selection.recipe.metadata.id).toBe(selected.recipe.metadata.id);
    expect(createLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKeyRootHostPath: paths.stateDir,
        bindings: expect.objectContaining({
          apiKeyHostPath: paths.apiKeyPath,
          model: expect.objectContaining({ hostPath: fs.realpathSync(modelPath) }),
        }),
      }),
    );
    [...before].forEach(([target, contents]) => {
      expect(fs.readFileSync(target)).toEqual(contents);
    });
  });

  it("reuses YAML-pinned images, the shared Hugging Face cache, and the durable lifecycle", async () => {
    const baseSelection = selection();
    const selected = {
      ...baseSelection,
      recipe: {
        ...baseSelection.recipe,
        spec: {
          ...baseSelection.recipe.spec,
          serve: {
            ...baseSelection.recipe.spec.serve,
            chatTemplate: "container-jinja-file",
            chatTemplateFile:
              "/usr/local/share/nemoclaw/llama-cpp/chat-templates/model-canonical.jinja",
            reasoning: { format: "deepseek", mode: "auto" },
          },
        },
      },
    } satisfies ResolvedLlamaCppInferenceSelection;
    const homeDir = temporaryHome();
    const modelPath = path.join(homeDir, "model.gguf");
    fs.writeFileSync(modelPath, "fixture", { mode: 0o600 });
    const status = fs.lstatSync(modelPath, { bigint: true });
    const artifact = {
      digest: selected.recipe.spec.model.files[0]!.digest,
      filesystemIdentity: {
        ctimeNs: status.ctimeNs,
        dev: status.dev,
        ino: status.ino,
        mtimeNs: status.mtimeNs,
        size: status.size,
      },
      hostPath: modelPath,
      sizeBytes: selected.recipe.spec.model.files[0]!.sizeBytes,
    };
    const receipt = { schemaVersion: 1 } as HostLocalInferenceReceipt;
    const lifecycle = {
      recoverUnfinished: vi.fn(() => ({ recovered: [], failures: [] })),
      resume: vi.fn(() => receipt),
      runtime: {} as DockerLlamaCppManagedLifecycle["runtime"],
      start: vi.fn(() => receipt),
    } satisfies DockerLlamaCppManagedLifecycle;
    const createLifecycle = vi.fn(() => lifecycle);
    const harness = engineHarness();
    const acquireGguf = vi.fn(async () => artifact);
    const verifyGguf = vi.fn(async () => {
      throw new Error("not cached");
    });
    const runtimeProvider = managedRuntimeProvider(harness.engine, createLifecycle);

    const result = await installManagedLlamaCpp(selected, {
      sandboxName: "spark-agent",
      homeDir,
      runtimeProvider,
      acquireGguf,
      verifyGguf,
      checkPort: vi.fn(async () => ({ ok: true })),
      log: vi.fn(),
    });

    expect(result).toMatchObject({
      ok: true,
      model: "nvidia-nemotron-3-nano-30b-a3b",
      receipt,
    });
    expect(harness.pulledImages).toHaveLength(2);
    expect(acquireGguf).toHaveBeenCalledWith(
      expect.objectContaining({
        execution: expect.objectContaining({
          downloaderImage: selected.recipe.spec.model.acquisition.downloaderImage,
          hostCacheDir: path.join(homeDir, ".cache", "huggingface"),
        }),
      }),
    );
    expect(verifyGguf).toHaveBeenCalledWith(
      expect.any(Object),
      path.join(homeDir, ".cache", "huggingface"),
    );
    expect(runtimeProvider.hostLocalInference.createOperation).toHaveBeenCalledWith({
      env: process.env,
    });
    expect(createLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        bindings: expect.objectContaining({
          hostPort: selected.recipe.spec.serve.port,
          imageReference: selected.recipe.spec.runtime.image,
        }),
        contract: expect.objectContaining({
          runtime: expect.objectContaining({ restartPolicy: "unless-stopped" }),
          serve: expect.objectContaining({
            batchSize: selected.recipe.spec.serve.batchSize,
            chatTemplate: "container-jinja-file",
            chatTemplateFile:
              "/usr/local/share/nemoclaw/llama-cpp/chat-templates/model-canonical.jinja",
            contextSize: selected.recipe.spec.serve.contextSize,
            port: selected.recipe.spec.serve.port,
            reasoning: { format: "deepseek", mode: "auto" },
          }),
        }),
        probeImageReference: selected.recipe.spec.readiness.probeImage,
        readinessTimeoutSeconds: selected.recipe.spec.readiness.timeoutSeconds,
      }),
    );
    expect(lifecycle.start).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "authentication",
      { status: 1, stderr: "unauthorized: authentication required" },
      "authentication-failure",
    ],
    ["storage", { status: 1, stderr: "no space left on device" }, "runner-storage-exhaustion"],
    [
      "runner network",
      { status: 1, stderr: "dial tcp: temporary failure in name resolution" },
      "runner-network-failure",
    ],
    [
      "invalid dependency",
      { status: 1, stderr: "manifest unknown: manifest not found" },
      "image-manifest-unavailable",
    ],
    [
      "registry availability",
      { status: 1, stderr: "registry returned 503 Service Unavailable" },
      "registry-availability-failure",
    ],
    [
      "daemon behavior",
      { status: 1, error: new Error("error during connect: dial tcp: connection refused") },
      "container-runtime-failure",
    ],
    ["unclassified", { status: 7, stderr: "opaque pull failure" }, "unclassified-pull-failure"],
  ])(
    "classifies a failed image pull from diagnostic signatures as %s (#10558)",
    async (layer, pullResult, expectedCode) => {
      const selected = selection();
      const homeDir = temporaryHome();
      const harness = engineHarness();
      harness.pullResults.push({ stdout: "", stderr: "", ...pullResult });

      const result = await installManagedLlamaCpp(selected, {
        sandboxName: "spark-agent",
        homeDir,
        runtimeProvider: managedRuntimeProvider(harness.engine),
        verifyGguf: vi.fn(async () => {
          throw new Error("not cached");
        }),
        checkPort: vi.fn(async () => ({ ok: true })),
        log: vi.fn(),
      });

      expect(result).toMatchObject({
        ok: false,
        reason: expect.stringContaining(
          `Failure classification: ${layer}. Diagnostic code: ${expectedCode}.`,
        ),
      });
    },
  );

  it("suppresses untrusted pull output from the failure reason and installer log (#10558)", async () => {
    const selected = selection();
    const homeDir = temporaryHome();
    const harness = engineHarness();
    const secret = "opaque-value-with-no-credential-shape";
    const terminalControls = "\u001b]0;forged title\u0007\u001b[31m\u202e";
    const pullOutput =
      `${"x".repeat(1_000)} stdout cause ${terminalControls}unauthorized: ` +
      `https://pull-user:${secret}@registry.example/v2/image?token=${secret}`;
    const pullStderr = `stderr cause token=${secret}`;
    const pullError = new Error(`error cause Authorization: Bearer ${secret}`);
    const log = vi.fn();
    harness.pullResults.push({
      status: 1,
      stdout: pullOutput,
      stderr: pullStderr,
      error: pullError,
    });
    const result = await installManagedLlamaCpp(selected, {
      sandboxName: "spark-agent",
      homeDir,
      runtimeProvider: managedRuntimeProvider(harness.engine),
      verifyGguf: vi.fn(async () => {
        throw new Error("not cached");
      }),
      checkPort: vi.fn(async () => ({ ok: true })),
      log,
    });

    const failure = result as Extract<typeof result, { readonly ok: false }>;
    expect(failure.reason).toContain(
      "Failure classification: authentication. Diagnostic code: authentication-failure. Exit status: 1. Raw pull output suppressed.",
    );
    expect(failure.reason).not.toContain(secret);
    expect(log.mock.calls.flat().join("\n")).not.toContain(secret);
    expect(log.mock.calls.flat().join("\n")).not.toContain("unauthorized");
  });

  it("resumes an exact cached runtime without image pulls or Hugging Face acquisition", async () => {
    const selected = selection();
    const homeDir = temporaryHome();
    const paths = managedLlamaCppStatePaths(homeDir);
    const harness = engineHarness();
    harness.images.add(selected.recipe.spec.runtime.image);
    harness.images.add(selected.recipe.spec.readiness.probeImage);
    const modelPath = path.join(homeDir, "cached-model.gguf");
    fs.writeFileSync(modelPath, "fixture", { mode: 0o600 });
    const status = fs.lstatSync(modelPath, { bigint: true });
    const artifact = {
      digest: selected.recipe.spec.model.files[0]!.digest,
      filesystemIdentity: {
        ctimeNs: status.ctimeNs,
        dev: status.dev,
        ino: status.ino,
        mtimeNs: status.mtimeNs,
        size: status.size,
      },
      hostPath: modelPath,
      sizeBytes: selected.recipe.spec.model.files[0]!.sizeBytes,
    };
    reserveManagedLlamaCppOwner(paths, {
      schemaVersion: 1,
      sandboxName: "spark-agent",
      catalogDigest: selected.catalogDigest,
      presetDigest: selected.presetDigest,
      recipeDigest: selected.recipeDigest,
      recipeId: selected.recipe.metadata.id,
    });
    const generation = "a".repeat(64);
    const receipt = {
      schemaVersion: 1,
      providerId: "docker",
      service: "llama-cpp",
      engineAuthority: {
        schemaVersion: 1,
        providerId: "docker",
        operation: "host-local-inference",
        engineId: "docker",
        authorityId: harness.engine.authorityId,
        bindingSha256: managedLlamaCppBindingSha256(harness.engine),
      },
      endpoint: {
        host: "host.openshell.internal",
        port: 8081,
        networkName: MANAGED_LLAMA_CPP_NETWORK_NAME,
      },
      runtime: {
        kind: "container",
        runtimeId: "b".repeat(64),
        name: "nemoclaw-llama-cpp",
        imageRef: selected.recipe.spec.runtime.image,
        probeImageRef: selected.recipe.spec.readiness.probeImage,
        specSha256: "c".repeat(64),
        model: {
          planDigest: `sha256:${"d".repeat(64)}`,
          recipeId: selected.recipe.metadata.id,
          generation,
          digest: selected.recipe.spec.model.files[0]!.digest,
          sizeBytes: selected.recipe.spec.model.files[0]!.sizeBytes,
        },
        gpu: { vendor: "nvidia", count: 1 },
      },
    } as const satisfies HostLocalInferenceReceipt;
    createManagedLlamaCppReceiptWriter(paths, generation).writeExact(
      serializeHostLocalInferenceReceipt(receipt),
    );
    const lifecycle = {
      recoverUnfinished: vi.fn(() => ({ recovered: [], failures: [] })),
      resume: vi.fn(() => receipt),
      runtime: {} as DockerLlamaCppManagedLifecycle["runtime"],
      start: vi.fn(() => receipt),
    } satisfies DockerLlamaCppManagedLifecycle;
    const acquireGguf = vi.fn();
    const checkPort = vi.fn();

    await expect(
      installManagedLlamaCpp(selected, {
        sandboxName: "spark-agent",
        homeDir,
        runtimeProvider: managedRuntimeProvider(harness.engine, () => lifecycle),
        acquireGguf: acquireGguf as never,
        verifyGguf: vi.fn(async () => artifact),
        checkPort: checkPort as never,
        log: vi.fn(),
      }),
    ).resolves.toMatchObject({ ok: true, receipt });

    expect(harness.pulledImages).toEqual([]);
    expect(acquireGguf).not.toHaveBeenCalled();
    expect(checkPort).not.toHaveBeenCalled();
    expect(lifecycle.resume).toHaveBeenCalledWith(receipt);
    expect(lifecycle.start).not.toHaveBeenCalled();
  });

  it("rejects a second sandbox owner before any engine, pull, or acquisition effect", async () => {
    const selected = selection();
    const homeDir = temporaryHome();
    reserveManagedLlamaCppOwner(managedLlamaCppStatePaths(homeDir), {
      schemaVersion: 1,
      sandboxName: "first-sandbox",
      catalogDigest: selected.catalogDigest,
      presetDigest: selected.presetDigest,
      recipeDigest: selected.recipeDigest,
      recipeId: selected.recipe.metadata.id,
    });
    const harness = engineHarness();
    const acquireGguf = vi.fn();

    const result = await installManagedLlamaCpp(selected, {
      sandboxName: "second-sandbox",
      homeDir,
      runtimeProvider: managedRuntimeProvider(harness.engine),
      acquireGguf: acquireGguf as never,
      log: vi.fn(),
    });

    expect(result).toEqual({
      ok: false,
      reason: "Managed llama.cpp on this gateway is already reserved by sandbox 'first-sandbox'.",
    });
    expect(harness.capture).not.toHaveBeenCalled();
    expect(acquireGguf).not.toHaveBeenCalled();
  });

  it("rejects a foreign port 8081 listener before image or model acquisition", async () => {
    const selected = selection();
    const homeDir = temporaryHome();
    const harness = engineHarness();
    const acquireGguf = vi.fn();

    const result = await installManagedLlamaCpp(selected, {
      sandboxName: "spark-agent",
      homeDir,
      runtimeProvider: managedRuntimeProvider(harness.engine),
      acquireGguf: acquireGguf as never,
      checkPort: vi.fn(async () => ({
        ok: false,
        process: "foreign-server",
        pid: 4242,
        reason: "foreign-server is listening",
      })),
      log: vi.fn(),
    });

    expect(result).toEqual({
      ok: false,
      reason: "Managed llama.cpp port 8081 is unavailable: foreign-server is listening",
    });
    expect(harness.pulledImages).toEqual([]);
    expect(acquireGguf).not.toHaveBeenCalled();
    expect(harness.capture.mock.calls.every(([args]) => args[0] !== "image")).toBe(true);
    expect(fs.existsSync(managedLlamaCppStatePaths(homeDir).stateDir)).toBe(false);
  });

  it("rechecks port 8081 after preparation and rolls back fresh ownership exactly", async () => {
    const selected = selection();
    const homeDir = temporaryHome();
    const harness = engineHarness();
    harness.images.add(selected.recipe.spec.runtime.image);
    harness.images.add(selected.recipe.spec.readiness.probeImage);
    const modelPath = path.join(homeDir, "cached-model.gguf");
    fs.writeFileSync(modelPath, "fixture", { mode: 0o600 });
    const status = fs.lstatSync(modelPath, { bigint: true });
    const artifact = {
      digest: selected.recipe.spec.model.files[0]!.digest,
      filesystemIdentity: {
        ctimeNs: status.ctimeNs,
        dev: status.dev,
        ino: status.ino,
        mtimeNs: status.mtimeNs,
        size: status.size,
      },
      hostPath: modelPath,
      sizeBytes: selected.recipe.spec.model.files[0]!.sizeBytes,
    };
    const checkPort = vi.fn().mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({
      ok: false,
      process: "late-listener",
      pid: 4242,
      reason: "late-listener is listening",
    });
    const start = vi.fn();

    const result = await installManagedLlamaCpp(selected, {
      sandboxName: "spark-agent",
      homeDir,
      runtimeProvider: managedRuntimeProvider(
        harness.engine,
        () =>
          ({
            recoverUnfinished: vi.fn(() => ({ recovered: [], failures: [] })),
            resume: vi.fn(),
            runtime: {} as DockerLlamaCppManagedLifecycle["runtime"],
            start,
          }) as DockerLlamaCppManagedLifecycle,
      ),
      verifyGguf: vi.fn(async () => artifact),
      checkPort,
      log: vi.fn(),
    });

    expect(result).toEqual({
      ok: false,
      reason: "Managed llama.cpp port 8081 is unavailable: late-listener is listening",
    });
    expect(checkPort).toHaveBeenCalledTimes(2);
    expect(start).not.toHaveBeenCalled();
    expect(
      harness.capture.mock.calls.some(
        ([args]) => args[0] === "network" && (args[1] === "create" || args[1] === "rm"),
      ),
    ).toBe(false);
    expect(fs.existsSync(managedLlamaCppStatePaths(homeDir).stateDir)).toBe(false);
  });

  it("reconstructs a matching managed owner during normal resume", async () => {
    const selected = selection();
    const home = temporarySymlinkedHome();
    reserveManagedLlamaCppOwner(managedLlamaCppStatePaths(home.canonical), {
      schemaVersion: 1,
      sandboxName: "spark-agent",
      catalogDigest: selected.catalogDigest,
      presetDigest: selected.presetDigest,
      recipeDigest: selected.recipeDigest,
      recipeId: selected.recipe.metadata.id,
    });
    const modelPath = path.join(home.canonical, "resume-model.gguf");
    fs.writeFileSync(modelPath, "fixture", { mode: 0o600 });
    const status = fs.lstatSync(modelPath, { bigint: true });
    const artifact = {
      digest: selected.recipe.spec.model.files[0]!.digest,
      filesystemIdentity: {
        ctimeNs: status.ctimeNs,
        dev: status.dev,
        ino: status.ino,
        mtimeNs: status.mtimeNs,
        size: status.size,
      },
      hostPath: modelPath,
      sizeBytes: selected.recipe.spec.model.files[0]!.sizeBytes,
    };
    const harness = engineHarness();
    harness.images.add(selected.recipe.spec.runtime.image);
    harness.images.add(selected.recipe.spec.readiness.probeImage);
    const receipt = { schemaVersion: 1 } as HostLocalInferenceReceipt;
    const lifecycle = {
      recoverUnfinished: vi.fn(() => ({ recovered: [], failures: [] })),
      resume: vi.fn(() => receipt),
      runtime: {} as DockerLlamaCppManagedLifecycle["runtime"],
      start: vi.fn(() => receipt),
    } satisfies DockerLlamaCppManagedLifecycle;
    const env: NodeJS.ProcessEnv = {};
    const verifyGguf = vi.fn(async () => artifact);

    await expect(
      resumeManagedLlamaCppRuntime("spark-agent", {
        homeDir: home.alias,
        env,
        runtimeProvider: managedRuntimeProvider(harness.engine, () => lifecycle),
        verifyGguf,
        checkPort: vi.fn(async () => ({ ok: true })),
      }),
    ).resolves.toBe(true);
    expect(lifecycle.start).toHaveBeenCalledOnce();
    expect(verifyGguf).toHaveBeenCalledWith(
      expect.any(Object),
      path.join(home.canonical, ".cache", "huggingface"),
    );
    expect(env.NEMOCLAW_LLAMACPP_LOCAL_TOKEN).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("rejects resume for a different sandbox owner before engine effects", async () => {
    const selected = selection();
    const homeDir = temporaryHome();
    reserveManagedLlamaCppOwner(managedLlamaCppStatePaths(homeDir), {
      schemaVersion: 1,
      sandboxName: "first-sandbox",
      catalogDigest: selected.catalogDigest,
      presetDigest: selected.presetDigest,
      recipeDigest: selected.recipeDigest,
      recipeId: selected.recipe.metadata.id,
    });
    const harness = engineHarness();

    await expect(
      resumeManagedLlamaCppRuntime("second-sandbox", {
        homeDir,
        runtimeProvider: managedRuntimeProvider(harness.engine),
      }),
    ).rejects.toThrow(
      "Managed llama.cpp on this gateway is owned by sandbox 'first-sandbox', not 'second-sandbox'.",
    );
    expect(harness.capture).not.toHaveBeenCalled();
  });
});
