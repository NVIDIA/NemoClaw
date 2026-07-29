// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SpawnSyncOptions } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { dockerSpawnSync } from "../../adapters/docker/exec";
import {
  captureOpenClawLegacyDockerBinding,
  createPreparedOpenClawLegacyImage,
  disposeOpenClawLegacyDockerImage,
  inspectOpenClawLegacyImageId,
  type OpenClawLegacyDockerBindingDeps,
} from "./rebuild/openclaw-legacy-image";

const IMAGE_ID = `sha256:${"a".repeat(64)}`;
const OTHER_IMAGE_ID = `sha256:${"b".repeat(64)}`;
const IMAGE_REF = "nemoclaw-sandbox-local:alpha-rebuild";
const CANONICAL_CWD = "/canonical/nemoclaw";

type DockerState = {
  context: string;
  contextStatus: number;
  engineId: string;
  infoStatus: number;
  tagImageId: string;
  directImageId: string;
  rmiStatus: number;
};

function dockerResult(stdout: string, status = 0): ReturnType<typeof dockerSpawnSync> {
  return {
    error: undefined,
    output: [null, stdout, ""],
    pid: 123,
    signal: null,
    status,
    stderr: "",
    stdout,
  };
}

function createDockerHarness(overrides: Partial<DockerState> = {}) {
  const state: DockerState = {
    context: "desktop-linux",
    contextStatus: 0,
    engineId: "engine-a",
    infoStatus: 0,
    tagImageId: IMAGE_ID,
    directImageId: IMAGE_ID,
    rmiStatus: 0,
    ...overrides,
  };
  const exitListeners = new Set<() => void>();
  const runDocker = vi.fn((args: readonly string[], _options: SpawnSyncOptions = {}) => {
    switch (args.join(" ")) {
      case "context show":
        return dockerResult(state.context, state.contextStatus);
      case "info --format {{.ID}}":
        return dockerResult(state.engineId, state.infoStatus);
      case `image inspect --format {{.Id}} ${IMAGE_REF}`:
        return dockerResult(state.tagImageId);
      case `image inspect --format {{.Id}} ${IMAGE_ID}`:
        return dockerResult(state.directImageId);
      case `image inspect --format {{.Id}} ${OTHER_IMAGE_ID}`:
        return dockerResult(OTHER_IMAGE_ID);
      case `rmi ${IMAGE_ID}`:
        return dockerResult("", state.rmiStatus);
      default:
        throw new Error(`Unexpected Docker command: ${args.join(" ")}`);
    }
  });
  const deps: OpenClawLegacyDockerBindingDeps = {
    cwd: CANONICAL_CWD,
    buildDockerEnv: () => ({ PATH: "/usr/bin" }),
    runDocker: runDocker as typeof dockerSpawnSync,
    addExitListener: (listener) => {
      exitListeners.add(listener);
    },
    removeExitListener: (listener) => {
      exitListeners.delete(listener);
    },
  };
  return { deps, exitListeners, runDocker, state };
}

function commandCalls(harness: ReturnType<typeof createDockerHarness>): string[][] {
  return harness.runDocker.mock.calls.map(([args]) => [...args]);
}

afterEach(() => vi.unstubAllEnvs());

describe("OpenClaw legacy-image Docker binding", () => {
  it("pins the current Docker context when no selector is explicit", () => {
    const harness = createDockerHarness();

    const binding = captureOpenClawLegacyDockerBinding(harness.deps);

    expect(binding).toEqual({
      dockerEnv: { DOCKER_CONTEXT: "desktop-linux", PATH: "/usr/bin" },
      engineId: "engine-a",
    });
    expect(Object.isFrozen(binding)).toBe(true);
    expect(Object.isFrozen(binding.dockerEnv)).toBe(true);
    expect(commandCalls(harness)).toEqual([
      ["context", "show"],
      ["info", "--format", "{{.ID}}"],
    ]);
    const contextOptions = harness.runDocker.mock.calls[0]?.[1] as SpawnSyncOptions;
    const infoOptions = harness.runDocker.mock.calls[1]?.[1] as SpawnSyncOptions;
    expect(Object.isFrozen(contextOptions.env)).toBe(true);
    expect(infoOptions.env).toBe(binding.dockerEnv);
    expect(infoOptions).toMatchObject({
      encoding: "utf-8",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
  });

  it("preserves an explicit Docker host without consulting ambient context", () => {
    const harness = createDockerHarness();
    harness.deps.buildDockerEnv = () => ({
      DOCKER_HOST: "unix:///var/run/docker.sock",
      PATH: "/usr/bin",
    });

    const binding = captureOpenClawLegacyDockerBinding(harness.deps);

    expect(binding.dockerEnv).toEqual({
      DOCKER_HOST: "unix:///var/run/docker.sock",
      PATH: "/usr/bin",
    });
    expect(commandCalls(harness)).toEqual([["info", "--format", "{{.ID}}"]]);
  });

  it("uses the Docker subprocess allowlist before freezing the selector", () => {
    vi.stubEnv("DOCKER_HOST", "unix:///var/run/docker.sock");
    vi.stubEnv("KUBECONFIG", "/secret/kubeconfig");
    vi.stubEnv("OPENSHELL_SECRET", "secret");
    vi.stubEnv("GITHUB_TOKEN", "secret");
    const harness = createDockerHarness();
    delete harness.deps.buildDockerEnv;

    const binding = captureOpenClawLegacyDockerBinding(harness.deps);

    expect(binding.dockerEnv.DOCKER_HOST).toBe("unix:///var/run/docker.sock");
    expect(binding.dockerEnv).not.toHaveProperty("KUBECONFIG");
    expect(binding.dockerEnv).not.toHaveProperty("OPENSHELL_SECRET");
    expect(binding.dockerEnv).not.toHaveProperty("GITHUB_TOKEN");
  });

  it("keeps a relative Docker config on canonical engine A for identity and cleanup", () => {
    const harness = createDockerHarness();
    const runEngineA = harness.runDocker.getMockImplementation()!;
    const engineBCalls: string[][] = [];
    harness.deps.buildDockerEnv = () => ({
      DOCKER_CONFIG: "relative/docker-config",
      PATH: "/usr/bin",
    });
    harness.runDocker.mockImplementation(
      (args: readonly string[], options: SpawnSyncOptions = {}) => {
        const runEngineB = () => {
          engineBCalls.push([...args]);
          switch (args.join(" ")) {
            case "context show":
              return dockerResult("ambient-context");
            case "info --format {{.ID}}":
              return dockerResult("engine-b");
            case `image inspect --format {{.Id}} ${IMAGE_REF}`:
            case `image inspect --format {{.Id}} ${IMAGE_ID}`:
              return dockerResult(OTHER_IMAGE_ID);
            case `rmi ${IMAGE_ID}`:
              return dockerResult("");
            default:
              throw new Error(`Unexpected engine B Docker command: ${args.join(" ")}`);
          }
        };
        return options.cwd === CANONICAL_CWD ? runEngineA(args, options) : runEngineB();
      },
    );

    const binding = captureOpenClawLegacyDockerBinding(harness.deps);
    const imageId = inspectOpenClawLegacyImageId(binding, IMAGE_REF);
    const removed = disposeOpenClawLegacyDockerImage(binding, IMAGE_REF, imageId);

    expect(binding).toEqual({
      dockerEnv: {
        DOCKER_CONFIG: "relative/docker-config",
        DOCKER_CONTEXT: "desktop-linux",
        PATH: "/usr/bin",
      },
      engineId: "engine-a",
    });
    expect(imageId).toBe(IMAGE_ID);
    expect(removed).toBe(true);
    expect(engineBCalls).toEqual([]);
    expect(commandCalls(harness)).toEqual([
      ["context", "show"],
      ["info", "--format", "{{.ID}}"],
      ["info", "--format", "{{.ID}}"],
      ["image", "inspect", "--format", "{{.Id}}", IMAGE_REF],
      ["image", "inspect", "--format", "{{.Id}}", IMAGE_ID],
      ["info", "--format", "{{.ID}}"],
      ["image", "inspect", "--format", "{{.Id}}", IMAGE_REF],
      ["image", "inspect", "--format", "{{.Id}}", IMAGE_ID],
      ["rmi", IMAGE_ID],
    ]);
    for (const [, options] of harness.runDocker.mock.calls) {
      expect(options?.cwd).toBe(CANONICAL_CWD);
    }
  });

  it.each([
    ["a malformed explicit selector", { DOCKER_CONTEXT: "bad\ncontext" }, {}, /malformed/],
    ["a failed context query", {}, { contextStatus: 1 }, /context could not be captured/],
    ["an empty context", {}, { context: "" }, /context could not be captured/],
    ["a failed engine query", {}, { infoStatus: 1 }, /engine identity/],
    ["a malformed engine identity", {}, { engineId: "engine a" }, /engine identity/],
  ] as const)("fails closed for %s", (_scenario, env, overrides, expected) => {
    const harness = createDockerHarness(overrides);
    harness.deps.buildDockerEnv = () => ({ ...env });

    expect(() => captureOpenClawLegacyDockerBinding(harness.deps)).toThrow(expected);
  });
});

describe("OpenClaw legacy-image identity and lifecycle", () => {
  it("inspects a mutable tag and its direct immutable ID using the exact bound environment", () => {
    const harness = createDockerHarness();
    const binding = captureOpenClawLegacyDockerBinding(harness.deps);
    harness.runDocker.mockClear();

    expect(inspectOpenClawLegacyImageId(binding, IMAGE_REF)).toBe(IMAGE_ID);

    expect(commandCalls(harness)).toEqual([
      ["info", "--format", "{{.ID}}"],
      ["image", "inspect", "--format", "{{.Id}}", IMAGE_REF],
      ["image", "inspect", "--format", "{{.Id}}", IMAGE_ID],
    ]);
    for (const [, options] of harness.runDocker.mock.calls) {
      expect(options?.env).toBe(binding.dockerEnv);
    }
  });

  it("constructs only a verified frozen lease from an authentic binding", () => {
    const harness = createDockerHarness();
    const binding = captureOpenClawLegacyDockerBinding(harness.deps);
    harness.runDocker.mockClear();

    const lease = createPreparedOpenClawLegacyImage(binding, IMAGE_REF, IMAGE_ID.toUpperCase());

    expect(lease).toMatchObject({
      dockerEnv: binding.dockerEnv,
      engineId: "engine-a",
      imageId: IMAGE_ID,
      imageRef: IMAGE_REF,
    });
    expect(Object.isFrozen(lease)).toBe(true);
    expect(harness.exitListeners.size).toBe(1);
    expect(commandCalls(harness)).toEqual([
      ["info", "--format", "{{.ID}}"],
      ["image", "inspect", "--format", "{{.Id}}", IMAGE_REF],
      ["image", "inspect", "--format", "{{.Id}}", IMAGE_ID],
    ]);
  });

  it("rejects counterfeit bindings, non-tag references, and mismatched image identity", () => {
    const harness = createDockerHarness();
    const binding = captureOpenClawLegacyDockerBinding(harness.deps);

    expect(() =>
      createPreparedOpenClawLegacyImage(
        Object.freeze({ dockerEnv: Object.freeze({}), engineId: "engine-a" }),
        IMAGE_REF,
        IMAGE_ID,
      ),
    ).toThrow(/not authentic/);
    expect(() => createPreparedOpenClawLegacyImage(binding, IMAGE_ID, IMAGE_ID)).toThrow(
      /mutable Docker tag/,
    );
    harness.state.tagImageId = OTHER_IMAGE_ID;
    expect(() => createPreparedOpenClawLegacyImage(binding, IMAGE_REF, IMAGE_ID)).toThrow(
      /identity changed/,
    );
    expect(harness.exitListeners.size).toBe(0);
  });

  it("guards method receivers and finalizes only after create verification", () => {
    const harness = createDockerHarness();
    const binding = captureOpenClawLegacyDockerBinding(harness.deps);
    const lease = createPreparedOpenClawLegacyImage(binding, IMAGE_REF, IMAGE_ID);
    harness.runDocker.mockClear();

    expect(lease.verifyForCreate()).toBe(false);
    expect(lease.finalizeAfterCreate()).toBeNull();
    expect(lease.verify.call({ ...lease })).toBe(false);
    expect(lease.retainForRecreate.call({ ...lease })).toBe(false);
    expect(lease.abort.call({ ...lease })).toBe(false);
    expect(harness.runDocker).not.toHaveBeenCalled();

    expect(lease.verify()).toBe(true);
    expect(lease.retainForRecreate()).toBe(true);
    expect(harness.exitListeners.size).toBe(1);
    expect(lease.verify()).toBe(false);
    expect(lease.retainForRecreate()).toBe(false);
    expect(lease.finalizeAfterCreate()).toBeNull();
    expect(lease.verifyForCreate()).toBe(true);
    expect(lease.finalizeAfterCreate.call({ ...lease })).toBeNull();
    expect(lease.finalizeAfterCreate()).toEqual({
      mutableTagVerified: true,
      registryImageRef: null,
    });
    expect(lease.finalizeAfterCreate()).toBeNull();
    expect(harness.exitListeners.size).toBe(0);
    expect(lease.dispose()).toBe(true);
    expect(commandCalls(harness)).not.toContainEqual(["rmi", IMAGE_ID]);
  });

  it("refuses retention when the directly addressed immutable image no longer agrees", () => {
    const harness = createDockerHarness();
    const binding = captureOpenClawLegacyDockerBinding(harness.deps);
    const lease = createPreparedOpenClawLegacyImage(binding, IMAGE_REF, IMAGE_ID);
    harness.runDocker.mockClear();
    harness.state.directImageId = OTHER_IMAGE_ID;

    expect(lease.retainForRecreate()).toBe(false);
    expect(commandCalls(harness)).toEqual([
      ["info", "--format", "{{.ID}}"],
      ["image", "inspect", "--format", "{{.Id}}", IMAGE_REF],
      ["image", "inspect", "--format", "{{.Id}}", IMAGE_ID],
    ]);
    expect(harness.exitListeners.size).toBe(1);
  });

  it.each([
    ["the named context is repointed", (state: DockerState) => (state.engineId = "engine-b")],
    ["the mutable tag is retargeted", (state: DockerState) => (state.tagImageId = OTHER_IMAGE_ID)],
    ["the immutable image is removed", (state: DockerState) => (state.directImageId = "")],
  ])("refuses creation after %s", (_scenario, mutate) => {
    const harness = createDockerHarness();
    const binding = captureOpenClawLegacyDockerBinding(harness.deps);
    const lease = createPreparedOpenClawLegacyImage(binding, IMAGE_REF, IMAGE_ID);
    expect(lease.retainForRecreate()).toBe(true);
    harness.runDocker.mockClear();

    mutate(harness.state);

    expect(lease.verifyForCreate()).toBe(false);
    expect(lease.finalizeAfterCreate()).toBeNull();
    expect(commandCalls(harness)).not.toContainEqual(["rmi", IMAGE_ID]);
  });

  it.each([
    ["removed", ""],
    ["retargeted", OTHER_IMAGE_ID],
  ])("suppresses registry cleanup when the mutable tag is %s after create", (_scenario, tagImageId) => {
    const harness = createDockerHarness();
    const binding = captureOpenClawLegacyDockerBinding(harness.deps);
    const lease = createPreparedOpenClawLegacyImage(binding, IMAGE_REF, IMAGE_ID);
    expect(lease.retainForRecreate()).toBe(true);
    expect(lease.verifyForCreate()).toBe(true);
    harness.runDocker.mockClear();
    harness.state.tagImageId = tagImageId;

    expect(lease.finalizeAfterCreate()).toEqual({
      mutableTagVerified: false,
      registryImageRef: null,
    });
    expect(commandCalls(harness)).toEqual([
      ["info", "--format", "{{.ID}}"],
      ["image", "inspect", "--format", "{{.Id}}", IMAGE_ID],
      ["image", "inspect", "--format", "{{.Id}}", IMAGE_REF],
    ]);
    expect(lease.abort()).toBe(true);
    expect(commandCalls(harness)).not.toContainEqual(["rmi", IMAGE_ID]);
  });

  it("fails finalization on engine drift and keeps exact abort cleanup retryable", () => {
    const harness = createDockerHarness();
    const binding = captureOpenClawLegacyDockerBinding(harness.deps);
    const lease = createPreparedOpenClawLegacyImage(binding, IMAGE_REF, IMAGE_ID);
    expect(lease.retainForRecreate()).toBe(true);
    expect(lease.verifyForCreate()).toBe(true);
    harness.runDocker.mockClear();
    harness.state.engineId = "engine-b";

    expect(lease.finalizeAfterCreate()).toBeNull();
    expect(lease.abort()).toBe(false);
    expect(commandCalls(harness)).toEqual([
      ["info", "--format", "{{.ID}}"],
      ["info", "--format", "{{.ID}}"],
    ]);
    expect(harness.exitListeners.size).toBe(1);

    harness.state.engineId = "engine-a";
    expect(lease.abort()).toBe(true);
    expect(commandCalls(harness)).toContainEqual(["rmi", IMAGE_ID]);
    expect(harness.exitListeners.size).toBe(0);
  });

  it.each([
    ["removed", ""],
    ["retargeted", OTHER_IMAGE_ID],
  ])("aborts a retained unused image by exact ID when its tag is %s", (_scenario, tagImageId) => {
    const harness = createDockerHarness();
    const binding = captureOpenClawLegacyDockerBinding(harness.deps);
    const lease = createPreparedOpenClawLegacyImage(binding, IMAGE_REF, IMAGE_ID);
    expect(lease.retainForRecreate()).toBe(true);
    harness.runDocker.mockClear();
    harness.state.tagImageId = tagImageId;

    expect(lease.abort()).toBe(true);
    expect(lease.abort()).toBe(true);
    expect(commandCalls(harness)).toEqual([
      ["info", "--format", "{{.ID}}"],
      ["image", "inspect", "--format", "{{.Id}}", IMAGE_ID],
      ["rmi", IMAGE_ID],
    ]);
    expect(harness.exitListeners.size).toBe(0);
  });

  it("cleans an unretained lease by immutable ID exactly once", () => {
    const harness = createDockerHarness();
    const binding = captureOpenClawLegacyDockerBinding(harness.deps);
    const lease = createPreparedOpenClawLegacyImage(binding, IMAGE_REF, IMAGE_ID);
    harness.runDocker.mockClear();

    expect(lease.dispose()).toBe(true);
    expect(lease.dispose()).toBe(true);

    expect(commandCalls(harness)).toEqual([
      ["info", "--format", "{{.ID}}"],
      ["image", "inspect", "--format", "{{.Id}}", IMAGE_REF],
      ["image", "inspect", "--format", "{{.Id}}", IMAGE_ID],
      ["rmi", IMAGE_ID],
    ]);
    expect(harness.exitListeners.size).toBe(0);
  });

  it("disposes a retained lease that never reached finalization", () => {
    const harness = createDockerHarness();
    const binding = captureOpenClawLegacyDockerBinding(harness.deps);
    const lease = createPreparedOpenClawLegacyImage(binding, IMAGE_REF, IMAGE_ID);
    expect(lease.retainForRecreate()).toBe(true);
    harness.runDocker.mockClear();

    expect(lease.dispose()).toBe(true);

    expect(commandCalls(harness)).toEqual([
      ["info", "--format", "{{.ID}}"],
      ["image", "inspect", "--format", "{{.Id}}", IMAGE_ID],
      ["rmi", IMAGE_ID],
    ]);
    expect(harness.exitListeners.size).toBe(0);
  });

  it("refuses cleanup on engine drift and leaves exit cleanup retryable", () => {
    const harness = createDockerHarness();
    const binding = captureOpenClawLegacyDockerBinding(harness.deps);
    const lease = createPreparedOpenClawLegacyImage(binding, IMAGE_REF, IMAGE_ID);
    harness.runDocker.mockClear();
    harness.state.engineId = "engine-b";

    expect(lease.dispose()).toBe(false);
    expect(commandCalls(harness)).toEqual([["info", "--format", "{{.ID}}"]]);
    expect(harness.exitListeners.size).toBe(1);

    harness.state.engineId = "engine-a";
    const [exitListener] = harness.exitListeners;
    exitListener?.();
    expect(commandCalls(harness)).toContainEqual(["rmi", IMAGE_ID]);
    expect(harness.exitListeners.size).toBe(0);
  });

  it("cleans a pre-lease image only after same-engine tag and captured direct-ID proof", () => {
    const harness = createDockerHarness();
    const binding = captureOpenClawLegacyDockerBinding(harness.deps);
    harness.runDocker.mockClear();

    expect(disposeOpenClawLegacyDockerImage(binding, IMAGE_REF, IMAGE_ID)).toBe(true);
    expect(commandCalls(harness)).toEqual([
      ["info", "--format", "{{.ID}}"],
      ["image", "inspect", "--format", "{{.Id}}", IMAGE_REF],
      ["image", "inspect", "--format", "{{.Id}}", IMAGE_ID],
      ["rmi", IMAGE_ID],
    ]);

    harness.runDocker.mockClear();
    harness.state.tagImageId = OTHER_IMAGE_ID;
    expect(disposeOpenClawLegacyDockerImage(binding, IMAGE_REF, IMAGE_ID)).toBe(false);
    expect(commandCalls(harness)).not.toContainEqual(["rmi", IMAGE_ID]);
  });

  it("refuses tag-authorized cleanup when no immutable ID was captured", () => {
    const harness = createDockerHarness();
    const binding = captureOpenClawLegacyDockerBinding(harness.deps);
    harness.runDocker.mockClear();
    harness.state.tagImageId = OTHER_IMAGE_ID;

    expect(disposeOpenClawLegacyDockerImage(binding, IMAGE_REF)).toBe(false);
    expect(commandCalls(harness)).toEqual([]);
  });
});
