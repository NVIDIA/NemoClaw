// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ContainerEngine,
  ContainerEngineCommandCapture,
} from "../../adapters/container-engine";
import type { DockerLlamaCppManagedLifecycle } from "../../onboard/runtime-provider/docker-llama-cpp-managed-lifecycle";
import {
  type HostLocalInferenceReceipt,
  serializeHostLocalInferenceReceipt,
} from "../../onboard/runtime-provider/host-local-inference";
import { isLlamaCppServingRecipe } from "../serving/adapter-registry";
import { loadManagedInferenceCatalog } from "../serving/catalog-loader";
import type { ResolvedLlamaCppInferenceSelection } from "../serving/types";
import {
  createManagedLlamaCppDockerAuthority,
  createManagedLlamaCppEngine,
  inspectManagedLlamaCppRuntimeExact,
  installManagedLlamaCpp,
  MANAGED_LLAMA_CPP_NETWORK_NAME,
  type ManagedLlamaCppDockerAuthority,
  managedLlamaCppBindingSha256,
  resumeManagedLlamaCppRuntime,
} from "./managed-installer";
import {
  createManagedLlamaCppReceiptWriter,
  managedLlamaCppStatePaths,
  reserveManagedLlamaCppOwner,
} from "./managed-state";

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

function selection(): ResolvedLlamaCppInferenceSelection {
  const catalog = loadManagedInferenceCatalog();
  const recipe = catalog.recipes.find(
    ({ metadata }) => metadata.id === "llama-cpp.nemotron-3-nano-30b-a3b.spark-single.v1",
  );
  const preset = catalog.presets.find(
    ({ metadata }) => metadata.id === "llama-cpp.dgx-spark-gb10.single.nemotron-3-nano-30b-a3b",
  );
  if (!recipe || !isLlamaCppServingRecipe(recipe) || !preset) {
    throw new Error("managed llama.cpp catalog fixture is unavailable");
  }
  return {
    outcome: "selected",
    selection: "explicit",
    catalogDigest: catalog.catalogDigest,
    presetDigest: catalog.sources.find(
      ({ kind, id }) => kind === "ServingPreset" && id === preset.metadata.id,
    )!.digest,
    recipeDigest: catalog.sources.find(
      ({ kind, id }) => kind === "ServingRecipe" && id === recipe.metadata.id,
    )!.digest,
    preset,
    recipe,
  };
}

function engineHarness(): {
  engine: ContainerEngine;
  capture: ReturnType<typeof vi.fn>;
  images: Set<string>;
} {
  let networkPresent = false;
  const images = new Set<string>();
  const capture = vi.fn((args: readonly string[]) => {
    if (args[0] === "network" && args[1] === "create") {
      networkPresent = true;
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "network" && args[1] === "inspect") {
      if (!networkPresent) return { status: 1, stdout: "", stderr: "No such network" };
      return {
        status: 0,
        stderr: "",
        stdout: JSON.stringify([
          {
            Driver: "bridge",
            Id: "a".repeat(64),
            Internal: true,
            Labels: { "io.nvidia.nemoclaw.managed-llama-cpp": "true" },
            Name: MANAGED_LLAMA_CPP_NETWORK_NAME,
            Scope: "local",
          },
        ]),
      };
    }
    if (args[0] === "network" && args[1] === "rm") {
      if (!networkPresent || args[2] !== "a".repeat(64)) {
        return { status: 1, stdout: "", stderr: "No such network" };
      }
      networkPresent = false;
      return { status: 0, stdout: `${args[2]}\n`, stderr: "" };
    }
    if (args[0] === "container" && args[1] === "inspect") {
      return { status: 1, stdout: "", stderr: "No such container" };
    }
    if (args[0] === "image" && args[1] === "inspect") {
      return images.has(args[2]!)
        ? { status: 0, stdout: "[]", stderr: "" }
        : { status: 1, stdout: "", stderr: "No such image" };
    }
    throw new Error(`unexpected engine command: ${args.join(" ")}`);
  });
  return {
    capture,
    images,
    engine: {
      operation: "host-local-inference",
      engineId: "docker",
      displayName: "Docker",
      authorityId: "docker:test",
      capture,
      captureHost: capture,
    },
  };
}

function successfulDockerCapture(
  endpoints: Readonly<Record<string, string>>,
  currentContext = "default",
): ReturnType<typeof vi.fn<ContainerEngineCommandCapture>> {
  return vi.fn<ContainerEngineCommandCapture>((_executable, args) => {
    const contextCommand = args.findIndex(
      (value, index) => value === "context" && args[index + 1] === "inspect",
    );
    if (contextCommand >= 0) {
      const context = args[contextCommand + 2] ?? "";
      const host = endpoints[context];
      if (!host) return { status: 1, stdout: "", stderr: "context not found" };
      return {
        status: 0,
        stdout: JSON.stringify({ Host: host, SkipTLSVerify: false }),
        stderr: "",
      };
    }
    const showCommand = args.findIndex(
      (value, index) => value === "context" && args[index + 1] === "show",
    );
    if (showCommand >= 0) {
      return { status: 0, stdout: `${currentContext}\n`, stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  });
}

describe("managed llama.cpp Docker authority", () => {
  it("prefixes streamed acquisition with the exact endpoint without exposing HF_TOKEN", () => {
    const capture = successfulDockerCapture({
      spark: "ssh://nvidia@spark.example.test",
    });
    const spawnDocker = vi.fn<ManagedLlamaCppDockerAuthority["spawnDocker"]>(() => ({}) as never);
    const authority = createManagedLlamaCppDockerAuthority(
      {
        DOCKER_CONFIG: "/tmp/nemoclaw-docker-config",
        DOCKER_CONTEXT: "spark",
      },
      capture,
      spawnDocker,
    );

    authority.spawnDocker(["run", "-e", "HF_TOKEN", "example.invalid/downloader@sha256:deadbeef"], {
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
    let inspections = 0;
    const capture = vi.fn<ContainerEngineCommandCapture>((_executable, args) => {
      if (args.includes("inspect")) {
        inspections += 1;
        return {
          status: 0,
          stdout: JSON.stringify({
            Host:
              inspections === 1
                ? "ssh://nvidia@spark-a.example.test"
                : "ssh://nvidia@spark-b.example.test",
            SkipTLSVerify: false,
          }),
          stderr: "",
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    const spawnDocker = vi.fn(() => ({}) as never);
    const authority = createManagedLlamaCppDockerAuthority(
      { HOME: "/tmp/nemoclaw-home", DOCKER_CONTEXT: "spark" },
      capture,
      spawnDocker,
    );

    expect(() =>
      authority.spawnDocker(["run", "-e", "HF_TOKEN", "example.invalid/downloader"], {
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
    let inspections = 0;
    const capture = vi.fn<ContainerEngineCommandCapture>((_executable, args) => {
      const contextCommand = args.findIndex(
        (value, index) => value === "context" && args[index + 1] === "inspect",
      );
      if (contextCommand >= 0) {
        inspections += 1;
        return {
          status: 0,
          stdout: JSON.stringify({
            Host:
              inspections === 1
                ? "ssh://nvidia@spark-a.example.test"
                : "ssh://nvidia@spark-b.example.test",
            SkipTLSVerify: false,
          }),
          stderr: "",
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    });
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
        createLifecycle,
        engine: harness.engine,
        homeDir,
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

  it("reuses YAML-pinned images, the shared Hugging Face cache, and the durable lifecycle", async () => {
    const selected = selection();
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
    const pullImage = vi.fn(async (image: string) => {
      harness.images.add(image);
      return { status: 0 };
    }) as never;
    const acquireGguf = vi.fn(async () => artifact);
    const verifyGguf = vi.fn(async () => {
      throw new Error("not cached");
    });

    const result = await installManagedLlamaCpp(selected, {
      sandboxName: "spark-agent",
      homeDir,
      engine: harness.engine,
      pullImage,
      acquireGguf,
      verifyGguf,
      checkPort: vi.fn(async () => ({ ok: true })),
      createLifecycle,
      log: vi.fn(),
    });

    expect(result).toMatchObject({
      ok: true,
      model: "nvidia-nemotron-3-nano-30b-a3b",
      receipt,
    });
    expect(pullImage).toHaveBeenCalledTimes(2);
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
    expect(createLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        contract: expect.objectContaining({
          runtime: expect.objectContaining({ restartPolicy: "unless-stopped" }),
        }),
        probeImageReference: selected.recipe.spec.readiness.probeImage,
        readinessTimeoutSeconds: selected.recipe.spec.readiness.timeoutSeconds,
      }),
    );
    expect(lifecycle.start).toHaveBeenCalledOnce();
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
    const pullImage = vi.fn();
    const acquireGguf = vi.fn();
    const checkPort = vi.fn();

    await expect(
      installManagedLlamaCpp(selected, {
        sandboxName: "spark-agent",
        homeDir,
        engine: harness.engine,
        pullImage: pullImage as never,
        acquireGguf: acquireGguf as never,
        verifyGguf: vi.fn(async () => artifact),
        checkPort: checkPort as never,
        createLifecycle: vi.fn(() => lifecycle),
        log: vi.fn(),
      }),
    ).resolves.toMatchObject({ ok: true, receipt });

    expect(pullImage).not.toHaveBeenCalled();
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
    const pullImage = vi.fn();
    const acquireGguf = vi.fn();

    const result = await installManagedLlamaCpp(selected, {
      sandboxName: "second-sandbox",
      homeDir,
      engine: harness.engine,
      pullImage: pullImage as never,
      acquireGguf: acquireGguf as never,
      log: vi.fn(),
    });

    expect(result).toEqual({
      ok: false,
      reason: "Managed llama.cpp on this gateway is already reserved by sandbox 'first-sandbox'.",
    });
    expect(harness.capture).not.toHaveBeenCalled();
    expect(pullImage).not.toHaveBeenCalled();
    expect(acquireGguf).not.toHaveBeenCalled();
  });

  it("rejects a foreign port 8081 listener before image or model acquisition", async () => {
    const selected = selection();
    const homeDir = temporaryHome();
    const harness = engineHarness();
    const pullImage = vi.fn();
    const acquireGguf = vi.fn();

    const result = await installManagedLlamaCpp(selected, {
      sandboxName: "spark-agent",
      homeDir,
      engine: harness.engine,
      pullImage: pullImage as never,
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
    expect(pullImage).not.toHaveBeenCalled();
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
      engine: harness.engine,
      verifyGguf: vi.fn(async () => artifact),
      checkPort,
      createLifecycle: vi.fn(
        () =>
          ({
            recoverUnfinished: vi.fn(() => ({ recovered: [], failures: [] })),
            resume: vi.fn(),
            runtime: {} as DockerLlamaCppManagedLifecycle["runtime"],
            start,
          }) as DockerLlamaCppManagedLifecycle,
      ),
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
    const homeDir = temporaryHome();
    reserveManagedLlamaCppOwner(managedLlamaCppStatePaths(homeDir), {
      schemaVersion: 1,
      sandboxName: "spark-agent",
      catalogDigest: selected.catalogDigest,
      presetDigest: selected.presetDigest,
      recipeDigest: selected.recipeDigest,
      recipeId: selected.recipe.metadata.id,
    });
    const modelPath = path.join(homeDir, "resume-model.gguf");
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

    await expect(
      resumeManagedLlamaCppRuntime("spark-agent", {
        homeDir,
        env,
        engine: harness.engine,
        verifyGguf: vi.fn(async () => artifact),
        checkPort: vi.fn(async () => ({ ok: true })),
        createLifecycle: vi.fn(() => lifecycle),
      }),
    ).resolves.toBe(true);
    expect(lifecycle.start).toHaveBeenCalledOnce();
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
        engine: harness.engine,
      }),
    ).rejects.toThrow(
      "Managed llama.cpp on this gateway is owned by sandbox 'first-sandbox', not 'second-sandbox'.",
    );
    expect(harness.capture).not.toHaveBeenCalled();
  });
});
