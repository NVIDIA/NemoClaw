// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SpawnSyncOptions } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { dockerSpawnSync } from "../adapters/docker/exec";
import type { PreparedOpenClawLegacyImage } from "./build-context-stage";
import {
  bindRetainedOpenClawGpuRoute,
  createRetainedOpenClawDockerRuntime,
} from "./rebuild/retained-openclaw-docker-runtime";
import type { SandboxCreateIntent } from "./sandbox-create-intent-types";

const IMAGE_ID = `sha256:${"a".repeat(64)}`;

function createIntent(): SandboxCreateIntent {
  return {
    sandboxName: "alpha",
    inferenceProvider: "nim",
    activeMessagingChannels: [],
    messagingProviderRequests: [],
    reusableMessagingProviders: [],
    extraProviders: [],
    staleExtraProviders: [],
    hermesToolGateways: [],
    policy: {
      basePolicyPath: "/tmp/policy.yaml",
      activeMessagingChannels: [],
      options: {
        directGpu: true,
        additionalPresets: [],
        policyTier: null,
        baselineExclusions: [],
      },
    },
    gpuCreateArgs: ["--gpu"],
    resourceCreateArgs: [],
    gpuRoutePlan: "native-only",
    sandboxGpuLogMessage: "ambient native route",
    disabledChannelNames: [],
    extraPlaceholderKeys: [],
  };
}

function dockerResult(stdout = "", status = 0): ReturnType<typeof dockerSpawnSync> {
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

function createImage(verifyForCreate: () => boolean = () => true): PreparedOpenClawLegacyImage {
  return {
    dockerEnv: Object.freeze({ DOCKER_CONTEXT: "engine-a", PATH: "/usr/bin" }),
    engineId: "engine-a-id",
    imageRef: "nemoclaw-sandbox-local:alpha-rebuild",
    imageId: IMAGE_ID,
    verify: vi.fn(() => true),
    retainForRecreate: vi.fn(() => true),
    verifyForCreate: vi.fn(verifyForCreate),
    finalizeAfterCreate: vi.fn(() => ({
      registryImageRef: null,
      mutableTagVerified: true,
    })),
    abort: vi.fn(() => true),
    dispose: vi.fn(() => true),
  };
}

afterEach(() => vi.unstubAllEnvs());

describe("retained OpenClaw Docker runtime", () => {
  it("keeps create-adjacent queries and mutations on engine A when ambient Docker selects B", () => {
    vi.stubEnv("DOCKER_CONTEXT", "engine-b");
    vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
    const image = createImage();
    const calls: Array<{ args: string[]; options: SpawnSyncOptions }> = [];
    const runDocker = vi.fn((args: readonly string[], options: SpawnSyncOptions = {}) => {
      calls.push({ args: [...args], options });
      if (args.join(" ") === "info --format {{json .OperatingSystem}}") {
        return dockerResult('"Docker Desktop"\n');
      }
      if (args[0] === "image" && args[1] === "inspect") return dockerResult("[]\n");
      if (args[0] === "logs") return dockerResult("engine-a logs\n");
      return dockerResult("engine-a-result\n");
    });
    const runtime = createRetainedOpenClawDockerRuntime(image, {
      runDocker: runDocker as typeof dockerSpawnSync,
      platform: "linux",
      env: { WSL_DISTRO_NAME: "Ubuntu" },
    });
    const deps = runtime.deps;

    expect(deps.dockerCapture?.(["ps", "-a"], { ignoreError: true })).toBe("engine-a-result");
    expect(deps.dockerRun?.(["inspect", "container-a"], { ignoreError: true }).status).toBe(0);
    expect(deps.dockerStop?.("container-a", { ignoreError: true }).status).toBe(0);
    expect(
      deps.dockerRename?.("container-a", "container-a-backup", { ignoreError: true }).status,
    ).toBe(0);
    expect(
      deps.dockerRunDetached?.(["--name", "container-a", IMAGE_ID], {
        ignoreError: true,
      }).status,
    ).toBe(0);
    expect(deps.dockerRm?.("container-a-backup", { ignoreError: true }).status).toBe(0);
    expect(deps.dockerStart?.("container-a", { ignoreError: true }).status).toBe(0);
    expect(deps.dockerLogs?.("container-a", { tail: 20 })).toBe("engine-a logs");
    expect(runtime.dockerDesktopWsl()).toBe(true);
    expect(runtime.dockerDesktopWsl()).toBe(true);
    expect(runtime.ensureImageCached("busybox:test")).toEqual({
      ok: true,
      alreadyCached: true,
    });

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(({ options }) => options.env === image.dockerEnv)).toBe(true);
    expect(calls.some(({ options }) => options.env?.DOCKER_CONTEXT === "engine-b")).toBe(false);
    expect(process.env.DOCKER_CONTEXT).toBe("engine-b");
    expect(image.verifyForCreate).toHaveBeenCalledTimes(calls.length);
  });

  it("rejects engine drift before the first mutation after an engine-A query", () => {
    let engineId = "engine-a-id";
    const image = createImage(() => engineId === "engine-a-id");
    const runDocker = vi.fn((_args: readonly string[], _options: SpawnSyncOptions = {}) =>
      dockerResult("container-a\n"),
    );
    const runtime = createRetainedOpenClawDockerRuntime(image, {
      runDocker: runDocker as typeof dockerSpawnSync,
      platform: "linux",
      env: { WSL_DISTRO_NAME: "Ubuntu" },
    });

    expect(runtime.deps.dockerCapture?.(["ps", "-a"], { ignoreError: true })).toBe("container-a");
    engineId = "engine-b-id";

    expect(() => runtime.deps.dockerStop?.("container-a", { ignoreError: true })).toThrow(
      "Retained OpenClaw rebuild Docker engine or image changed before a Docker operation.",
    );
    expect(runDocker).toHaveBeenCalledOnce();
    expect(runDocker.mock.calls[0]?.[0]).toEqual(["ps", "-a"]);
  });

  it("replaces an ambient native plan with engine A's Docker Desktop WSL route", () => {
    vi.stubEnv("DOCKER_CONTEXT", "engine-b");
    vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
    const image = createImage();
    const runDocker = vi.fn((args: readonly string[], _options: SpawnSyncOptions = {}) =>
      args.join(" ") === "info --format {{json .OperatingSystem}}"
        ? dockerResult('"Docker Desktop"\n')
        : dockerResult(),
    );
    const runtime = createRetainedOpenClawDockerRuntime(image, {
      runDocker: runDocker as typeof dockerSpawnSync,
      platform: "linux",
      env: { WSL_DISTRO_NAME: "Ubuntu" },
    });
    const ambientIntent = createIntent();

    const boundIntent = bindRetainedOpenClawGpuRoute(
      ambientIntent,
      { sandboxGpuEnabled: true, hostGpuDetected: true },
      true,
      runtime,
      {
        env: { NEMOCLAW_DOCKER_GPU_PATCH: "0" },
        platform: "linux",
      },
    );

    expect(ambientIntent.gpuRoutePlan).toBe("native-only");
    expect(boundIntent.gpuRoutePlan).toBe("compatibility-only");
    expect(boundIntent.sandboxGpuLogMessage).toContain("Docker-driver GPU patch active");
    expect(runDocker).toHaveBeenCalledOnce();
    expect(runDocker.mock.calls[0]?.[1]?.env).toBe(image.dockerEnv);
    expect(process.env.DOCKER_CONTEXT).toBe("engine-b");
  });
});
