// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ dockerSpawn: vi.fn() }));

/** Use a nondefault authority to detect hard-coded probe and publication addresses. */
vi.mock("./experimental/portable-profile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./experimental/portable-profile")>()),
  PORTABLE_LOCAL_REGISTRY: "127.0.0.1:54321",
}));

vi.mock("../adapters/docker/exec", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/docker/exec")>()),
  dockerSpawn: mocks.dockerSpawn,
}));

import {
  dockerBuildSubprocessEnv,
  dockerContextIsDefaultFromBuild,
  mergeIsolatedDockerClientEnv,
  prepareDockerBuildEnvironment,
} from "../adapters/docker/client-isolation";
import { withStdoutRedirectedToStderr } from "../cli/stdout-guard";
import { SANDBOX_BUILD_CONTEXT_PREFIX } from "../sandbox/build-context";
import {
  prebuildSandboxImageIfEligible,
  resolveSandboxPrebuildEnabled,
  sandboxLocalImageRef,
} from "./sandbox-prebuild";

const BUILD_ID = "1234567890";
const IMAGE_ID = `sha256:${"a".repeat(64)}`;
const temporaryDirectories: string[] = [];

/** Stage a generated context and register it for cleanup even when a test rejects. */
function createBuildContext(
  parent = os.tmpdir(),
  prefix = SANDBOX_BUILD_CONTEXT_PREFIX,
): {
  buildCtx: string;
  createArgs: string[];
  dockerfile: string;
} {
  const buildCtx = fs.mkdtempSync(path.join(parent, prefix));
  temporaryDirectories.push(buildCtx);
  const dockerfile = path.join(buildCtx, "Dockerfile");
  fs.writeFileSync(dockerfile, "FROM scratch\n");
  return {
    buildCtx,
    createArgs: ["--from", dockerfile, "--name", "alpha"],
    dockerfile,
  };
}

describe("sandbox BuildKit prebuild", () => {
  it("rejects every explicit Docker host before resolving a context", () => {
    const showContext = vi.fn(() => "default");

    expect(
      dockerContextIsDefaultFromBuild(
        { DOCKER_HOST: "unix:///run/user/1001/docker.sock" },
        showContext,
      ),
    ).toBe(false);
    expect(showContext).not.toHaveBeenCalled();
  });

  it.each([
    ["remote-builder", false],
    ["default", true],
  ] as const)("classifies an explicit %s context without invoking Docker", (context, expected) => {
    const showContext = vi.fn(() => "default");

    expect(dockerContextIsDefaultFromBuild({ DOCKER_CONTEXT: context }, showContext)).toBe(
      expected,
    );
    expect(showContext).not.toHaveBeenCalled();
  });

  it.each([
    ["persisted remote context", {}, "remote-builder", false],
    ["unreadable context", {}, null, false],
    ["default context", {}, "default", true],
  ] as const)(
    "classifies the %s at the Docker client boundary",
    (_case, env, context, expected) => {
      expect(dockerContextIsDefaultFromBuild(env, () => context)).toBe(expected);
    },
  );

  it("lets an explicit DOCKER_HOST override a context (#12223)", () => {
    const env = {
      DOCKER_HOST: "unix:///alternate.sock",
      DOCKER_CONTEXT: "default",
    };

    expect(dockerContextIsDefaultFromBuild(env)).toBe(false);
    expect(dockerBuildSubprocessEnv(env)).toMatchObject({
      DOCKER_HOST: "unix:///alternate.sock",
    });
    expect(dockerBuildSubprocessEnv(env)).not.toHaveProperty("DOCKER_CONTEXT");
  });

  afterEach(() => {
    mocks.dockerSpawn.mockReset();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps Docker runtime settings while dropping secrets and control-plane state", () => {
    vi.stubEnv("DOCKER_HOST", undefined);
    vi.stubEnv("PATH", "/usr/bin");
    vi.stubEnv("HOME", "/home/user");
    vi.stubEnv("CONTAINERS_CONF", "/home/user/.config/nemoclaw/portable/containers.conf");
    vi.stubEnv("DOCKER_CONFIG", "/home/user/.docker-ci");
    vi.stubEnv("DOCKER_CONTEXT", "remote-builder");
    vi.stubEnv("BUILDX_BUILDER", "external-builder");
    vi.stubEnv("XDG_CONFIG_HOME", "/home/user/.config");
    vi.stubEnv("HTTPS_PROXY", "http://proxy:8080");
    vi.stubEnv("NVIDIA_INFERENCE_API_KEY", "secret");
    vi.stubEnv("GITHUB_TOKEN", "secret");
    vi.stubEnv("KUBECONFIG", "/home/user/.kube/config");
    vi.stubEnv("SSH_AUTH_SOCK", "/tmp/agent.sock");
    vi.stubEnv("RUST_LOG", "debug");
    vi.stubEnv("RUST_BACKTRACE", "1");
    vi.stubEnv("OPENSHELL_GATEWAY", "nemoclaw");
    vi.stubEnv("GRPC_VERBOSITY", "debug");

    const env = dockerBuildSubprocessEnv();

    expect(env).toMatchObject({
      PATH: "/usr/bin",
      HOME: "/home/user",
      CONTAINERS_CONF: "/home/user/.config/nemoclaw/portable/containers.conf",
      DOCKER_CONFIG: "/home/user/.docker-ci",
      DOCKER_CONTEXT: "remote-builder",
      XDG_CONFIG_HOME: "/home/user/.config",
      HTTPS_PROXY: "http://proxy:8080",
    });
    expect(env).not.toHaveProperty("NVIDIA_INFERENCE_API_KEY");
    expect(env).not.toHaveProperty("GITHUB_TOKEN");
    expect(env).not.toHaveProperty("KUBECONFIG");
    expect(env).not.toHaveProperty("SSH_AUTH_SOCK");
    expect(env).not.toHaveProperty("RUST_LOG");
    expect(env).not.toHaveProperty("RUST_BACKTRACE");
    expect(env).not.toHaveProperty("OPENSHELL_GATEWAY");
    expect(env).not.toHaveProperty("GRPC_VERBOSITY");
    expect(env).not.toHaveProperty("BUILDX_BUILDER");
  });

  it("keeps Docker host precedence over an ambient context (#12223)", () => {
    vi.stubEnv("DOCKER_HOST", "unix:///selected-docker.sock");
    vi.stubEnv("DOCKER_CONTEXT", "ambient-remote");
    vi.stubEnv("DOCKER_CONFIG", "/home/user/.docker-ambient");

    const env = dockerBuildSubprocessEnv();
    expect(env).toMatchObject({
      DOCKER_HOST: "unix:///selected-docker.sock",
      DOCKER_CONFIG: "/home/user/.docker-ambient",
    });
    expect(env).not.toHaveProperty("DOCKER_CONTEXT");
  });

  it("never enables a local-image handoff for a remote gateway", () => {
    expect(resolveSandboxPrebuildEnabled({}, false)).toBe(false);
    expect(resolveSandboxPrebuildEnabled({ NEMOCLAW_SANDBOX_PREBUILD: "1" }, false)).toBe(false);
  });

  it("defaults on locally, honors opt-out, and requires opt-in under tests", () => {
    expect(resolveSandboxPrebuildEnabled({}, true)).toBe(true);
    expect(resolveSandboxPrebuildEnabled({ NEMOCLAW_SANDBOX_PREBUILD: "0" }, true)).toBe(false);
    expect(resolveSandboxPrebuildEnabled({ VITEST: "true" }, true)).toBe(false);
    expect(
      resolveSandboxPrebuildEnabled({ VITEST: "true", NEMOCLAW_SANDBOX_PREBUILD: "1" }, true),
    ).toBe(true);
  });

  it("derives a build-unique local image tag", () => {
    const imageRef = sandboxLocalImageRef("My Bot/2!", BUILD_ID);
    expect(imageRef).toBe("nemoclaw-sandbox-local:my-bot-2--1234567890");
    expect(sandboxLocalImageRef("My Bot/2!", "next-build")).not.toBe(imageRef);
    expect(sandboxLocalImageRef("a".repeat(128), "next-build")).not.toBe(
      sandboxLocalImageRef("a".repeat(128), "other-build"),
    );
  });

  it("rejects create arguments that do not use the staged Dockerfile", async () => {
    const { buildCtx } = createBuildContext();
    const buildImage = vi.fn(
      async (_args: readonly string[], _options: { env: NodeJS.ProcessEnv; stdio: "inherit" }) => 0,
    );
    await expect(
      prebuildSandboxImageIfEligible({
        buildCtx,
        buildId: BUILD_ID,
        origin: "generated",
        createArgs: ["--from", "/other/Dockerfile"],
        sandboxName: "alpha",
        dockerDriverGateway: true,
        env: {},
        buildImage,
      }),
    ).rejects.toThrow("requires the selected staged Dockerfile");
    expect(buildImage).not.toHaveBeenCalled();
  });

  it("builds a custom Dockerfile in the selected local Docker engine before create", async () => {
    const { buildCtx, createArgs } = createBuildContext();
    const buildImage = vi.fn(
      async (_args: readonly string[], _options: { env: NodeJS.ProcessEnv; stdio: "inherit" }) => 0,
    );
    const inspectImageId = vi.fn(() => IMAGE_ID);
    const log = vi.fn();

    const result = await prebuildSandboxImageIfEligible({
      buildCtx,
      buildId: BUILD_ID,
      origin: "custom",
      createArgs,
      sourceReference: path.join(buildCtx, "Dockerfile"),
      sandboxName: "alpha",
      dockerDriverGateway: true,
      gatewayDriver: "docker",
      env: { NEMOCLAW_SANDBOX_PREBUILD: "1", NVIDIA_INFERENCE_API_KEY: "private-value" },
      buildImage,
      inspectImageId,
      log,
    });

    expect(buildImage).toHaveBeenCalledWith(
      [
        "build",
        "-t",
        "nemoclaw-sandbox-local:alpha-1234567890",
        "-f",
        path.join(fs.realpathSync(buildCtx), "Dockerfile"),
        fs.realpathSync(buildCtx),
      ],
      expect.objectContaining({ stdio: "inherit" }),
    );
    expect(buildImage.mock.calls[0]?.[1].env).not.toHaveProperty("NVIDIA_INFERENCE_API_KEY");
    expect(inspectImageId).toHaveBeenCalledWith("nemoclaw-sandbox-local:alpha-1234567890");
    expect(result).toEqual({
      createArgs: ["--from", "nemoclaw-sandbox-local:alpha-1234567890", "--name", "alpha"],
      sourceReference: "nemoclaw-sandbox-local:alpha-1234567890",
      imageRef: "nemoclaw-sandbox-local:alpha-1234567890",
      imageId: IMAGE_ID,
    });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("Building sandbox image with BuildKit"),
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining("build completed"));
  });

  it.each([
    [
      "native Podman",
      {
        dockerDriverGateway: true,
        gatewayDriver: "podman",
        nativePodmanCapture: vi.fn(),
        env: {},
      },
      "unavailable with native Podman",
    ],
    [
      "remote gateway",
      { dockerDriverGateway: false, gatewayDriver: "remote", env: {} },
      "no image distribution path",
    ],
    [
      "remote Docker host",
      {
        dockerDriverGateway: true,
        gatewayDriver: "docker",
        env: { DOCKER_HOST: "tcp://remote:2375" },
      },
      "supported local Docker host",
    ],
    [
      "unmatched engine",
      {
        dockerDriverGateway: true,
        gatewayDriver: "docker",
        env: { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" },
      },
      "refusing a podman build",
    ],
    [
      "disabled prebuild",
      {
        dockerDriverGateway: true,
        gatewayDriver: "docker",
        env: { NEMOCLAW_SANDBOX_PREBUILD: "0" },
      },
      "image build is required",
    ],
  ] as const)(
    "rejects a custom Dockerfile on a %s before build",
    async (_reason, gate, message) => {
      const { buildCtx, createArgs } = createBuildContext();
      const buildImage = vi.fn(async () => 0);
      await expect(
        prebuildSandboxImageIfEligible({
          buildCtx,
          buildId: BUILD_ID,
          origin: "custom",
          createArgs,
          sandboxName: "alpha",
          ...gate,
          buildImage,
        }),
      ).rejects.toThrow(message);
      expect(buildImage).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["failed build", 1, IMAGE_ID, "build failed (exit 1)"],
    ["missing image", 0, "", "not visible in the selected docker engine"],
  ] as const)(
    "stops a custom Dockerfile after a %s",
    async (_reason, buildStatus, imageId, message) => {
      const { buildCtx, createArgs } = createBuildContext();
      await expect(
        prebuildSandboxImageIfEligible({
          buildCtx,
          buildId: BUILD_ID,
          origin: "custom",
          createArgs,
          sandboxName: "alpha",
          dockerDriverGateway: true,
          gatewayDriver: "docker",
          env: { NEMOCLAW_SANDBOX_PREBUILD: "1" },
          buildImage: async () => buildStatus,
          inspectImageId: () => imageId,
          log: () => {},
        }),
      ).rejects.toThrow(message);
    },
  );

  it("rejects a remote gateway before starting a generated build", async () => {
    const { buildCtx, createArgs } = createBuildContext();
    const buildImage = vi.fn(async () => 0);
    await expect(
      prebuildSandboxImageIfEligible({
        buildCtx,
        buildId: BUILD_ID,
        origin: "generated",
        createArgs,
        sandboxName: "alpha",
        dockerDriverGateway: false,
        env: {},
        buildImage,
      }),
    ).rejects.toThrow("requires a local Docker or Podman gateway");
    expect(buildImage).not.toHaveBeenCalled();
  });

  it("rejects an engine mismatch before starting a generated build", async () => {
    const { buildCtx, createArgs } = createBuildContext();
    const buildImage = vi.fn(async () => 0);
    await expect(
      prebuildSandboxImageIfEligible({
        buildCtx,
        buildId: BUILD_ID,
        origin: "generated",
        createArgs,
        sandboxName: "alpha",
        dockerDriverGateway: true,
        gatewayDriver: "docker",
        env: { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" },
        buildImage,
      }),
    ).rejects.toThrow("refusing a podman build");
    expect(buildImage).not.toHaveBeenCalled();
  });

  it("builds and inspects a generated image in the native Podman engine", async () => {
    const { buildCtx, createArgs } = createBuildContext();
    const nativePodmanCapture = vi.fn((args: readonly string[]) => {
      return {
        status: 0,
        stdout: args[0] === "image" ? IMAGE_ID.slice("sha256:".length) : "",
        stderr: "",
      };
    });
    const publishImage = vi.fn(async () => 0);
    const log = vi.fn();
    const result = await prebuildSandboxImageIfEligible({
      buildCtx,
      buildId: BUILD_ID,
      origin: "generated",
      createArgs,
      sandboxName: "alpha",
      dockerDriverGateway: true,
      gatewayDriver: "podman",
      env: {
        NEMOCLAW_SANDBOX_PREBUILD: "1",
        CONTAINER_HOST: "ssh://remote.invalid",
        CONTAINER_CONNECTION: "remote",
      },
      nativePodmanCapture,
      publishImage,
      log,
    });

    expect(nativePodmanCapture).toHaveBeenCalledWith(
      [
        "build",
        "--quiet",
        "-t",
        "nemoclaw-sandbox-local:alpha-1234567890",
        "-f",
        path.join(fs.realpathSync(buildCtx), "Dockerfile"),
        fs.realpathSync(buildCtx),
      ],
      20 * 60_000,
    );
    expect(nativePodmanCapture).toHaveBeenCalledWith(
      ["image", "inspect", "--format", "{{.Id}}", "nemoclaw-sandbox-local:alpha-1234567890"],
      5_000,
    );
    expect(publishImage).not.toHaveBeenCalled();
    expect(result.imageRef).toBe("nemoclaw-sandbox-local:alpha-1234567890");
    expect(result.imageId).toBe(IMAGE_ID);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("rootless Podman"));
  });

  it("stops a native Podman build when its selected gateway authority changes", async () => {
    const { buildCtx, createArgs } = createBuildContext();
    const nativePodmanCapture = vi.fn(() => {
      throw new Error("selected Podman socket changed");
    });
    await expect(
      prebuildSandboxImageIfEligible({
        buildCtx,
        buildId: BUILD_ID,
        origin: "generated",
        createArgs,
        sandboxName: "alpha",
        dockerDriverGateway: true,
        gatewayDriver: "podman",
        env: { NEMOCLAW_SANDBOX_PREBUILD: "1" },
        nativePodmanCapture,
      }),
    ).rejects.toThrow("Local rootless Podman build could not start");
    expect(nativePodmanCapture).toHaveBeenCalledTimes(1);
  });

  it("hands a receipt-bound Portable Hermes image to create only after Podman publication", async () => {
    const { buildCtx, dockerfile } = createBuildContext();
    const transactionId = "12345678-1234-1234-1234-123456789abc";
    const events: string[] = [];
    const assertCurrent = vi.fn(() => events.push("context"));
    const podman = vi.fn((args: readonly string[], timeoutMs: number) => {
      events.push(args[0] === "image" ? "inspect" : args[0]);
      expect(timeoutMs).toBeGreaterThan(0);
      return { status: 0, stdout: args[0] === "image" ? IMAGE_ID.slice(7) : "" };
    });
    const imageAvailable = vi.fn(async () => {
      events.push("available");
      return true;
    });
    const result = await prebuildSandboxImageIfEligible({
      buildCtx,
      buildId: transactionId,
      origin: "generated",
      sourceReference: dockerfile,
      sandboxName: "hermes",
      dockerDriverGateway: true,
      gatewayDriver: "podman",
      env: { NEMOCLAW_SANDBOX_PREBUILD: "1" },
      portableReceipt: {
        transactionId,
        context: { buildContextPath: buildCtx, dockerfilePath: dockerfile, assertCurrent },
        podman,
        imageAvailable,
      },
      log: () => {},
    });

    expect(events.indexOf("build")).toBeLessThan(events.indexOf("inspect"));
    expect(events.indexOf("inspect")).toBeLessThan(events.indexOf("push"));
    expect(events.indexOf("push")).toBeLessThan(events.indexOf("available"));
    expect(assertCurrent).toHaveBeenCalled();
    expect(result.sourceReference).toBe(`127.0.0.1:54321/nemoclaw-sandbox-local:${transactionId}`);
    expect(result.imageId).toBe(IMAGE_ID);
  });

  it("rejects a Docker context that may select a different daemon", async () => {
    const { buildCtx, createArgs } = createBuildContext();
    const buildImage = vi.fn(async () => 0);
    await expect(
      prebuildSandboxImageIfEligible({
        buildCtx,
        buildId: BUILD_ID,
        origin: "generated",
        createArgs,
        sandboxName: "alpha",
        dockerDriverGateway: true,
        gatewayDriver: "docker",
        env: { DOCKER_HOST: "   ", DOCKER_CONTEXT: " remote-builder " },
        buildImage,
      }),
    ).rejects.toThrow(
      "cannot prove that the selected Docker context shares the local gateway engine",
    );
    expect(buildImage).not.toHaveBeenCalled();
  });

  it("rejects an unsupported Docker host before building for the selected gateway", async () => {
    const { buildCtx, createArgs } = createBuildContext();
    const buildImage = vi.fn(async () => 0);
    await expect(
      prebuildSandboxImageIfEligible({
        buildCtx,
        buildId: BUILD_ID,
        origin: "generated",
        createArgs,
        sandboxName: "alpha",
        dockerDriverGateway: true,
        gatewayDriver: "docker",
        env: { DOCKER_HOST: "tcp://remote-builder:2375", DOCKER_CONTEXT: "default" },
        buildImage,
      }),
    ).rejects.toThrow("requires a supported local Docker host");
    expect(buildImage).not.toHaveBeenCalled();
  });

  it("builds with the same supported local Docker socket selected by the gateway", async () => {
    const { buildCtx, createArgs } = createBuildContext();
    const buildImage = vi.fn(
      async (_args: readonly string[], _options: { env: NodeJS.ProcessEnv; stdio: "inherit" }) => 0,
    );
    const inspectImageId = vi.fn(() => IMAGE_ID);
    await prebuildSandboxImageIfEligible({
      buildCtx,
      buildId: BUILD_ID,
      origin: "generated",
      createArgs,
      sandboxName: "alpha",
      dockerDriverGateway: true,
      gatewayDriver: "docker",
      env: { DOCKER_HOST: "unix:///run/user/1001/docker.sock", DOCKER_CONTEXT: "remote-builder" },
      buildImage,
      inspectImageId,
      log: () => {},
    });
    expect(buildImage).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({ DOCKER_HOST: "unix:///run/user/1001/docker.sock" }),
      }),
    );
    expect(buildImage.mock.calls[0]?.[1].env.DOCKER_CONTEXT).toBeUndefined();
    expect(inspectImageId).toHaveBeenCalled();
  });

  it("rejects a build that is absent from the selected engine", async () => {
    const { buildCtx, createArgs } = createBuildContext();
    const buildImage = vi.fn(async () => 0);
    await expect(
      prebuildSandboxImageIfEligible({
        buildCtx,
        buildId: BUILD_ID,
        origin: "generated",
        createArgs,
        sandboxName: "alpha",
        dockerDriverGateway: true,
        gatewayDriver: "docker",
        env: {},
        buildImage,
        inspectImageId: () => "",
        log: () => {},
      }),
    ).rejects.toThrow("not visible in the selected docker engine");
    expect(buildImage).toHaveBeenCalledOnce();
  });

  it("rejects a staged-looking context outside the OS temp directory", async () => {
    const { buildCtx, createArgs } = createBuildContext();
    const reportedTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-other-temp-"));
    temporaryDirectories.push(reportedTempRoot);
    vi.spyOn(os, "tmpdir").mockReturnValue(reportedTempRoot);
    const buildImage = vi.fn(async () => 0);

    await expect(
      prebuildSandboxImageIfEligible({
        buildCtx,
        buildId: BUILD_ID,
        origin: "generated",
        createArgs,
        sandboxName: "alpha",
        dockerDriverGateway: true,
        env: {},
        buildImage,
        log: () => {},
      }),
    ).rejects.toThrow("rejected the staged context trust boundary");
    expect(buildImage).not.toHaveBeenCalled();
  });

  it("rejects a temporary context without the staging prefix", async () => {
    const { buildCtx, createArgs } = createBuildContext(os.tmpdir(), "untrusted-build-");
    const buildImage = vi.fn(async () => 0);

    await expect(
      prebuildSandboxImageIfEligible({
        buildCtx,
        buildId: BUILD_ID,
        origin: "generated",
        createArgs,
        sandboxName: "alpha",
        dockerDriverGateway: true,
        env: {},
        buildImage,
        log: () => {},
      }),
    ).rejects.toThrow("rejected the staged context trust boundary");
    expect(buildImage).not.toHaveBeenCalled();
  });

  it("rejects a group-writable staged context", async () => {
    const { buildCtx, createArgs } = createBuildContext();
    fs.chmodSync(buildCtx, 0o770);
    const buildImage = vi.fn(async () => 0);
    const log = vi.fn();

    await expect(
      prebuildSandboxImageIfEligible({
        buildCtx,
        buildId: BUILD_ID,
        origin: "generated",
        createArgs,
        sandboxName: "alpha",
        dockerDriverGateway: true,
        env: {},
        buildImage,
        log,
      }),
    ).rejects.toThrow("rejected the staged context trust boundary");
    expect(buildImage).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("rejects a symlinked staged Dockerfile", async () => {
    const { buildCtx, createArgs, dockerfile } = createBuildContext();
    const target = path.join(buildCtx, "Dockerfile.regular");
    fs.renameSync(dockerfile, target);
    fs.symlinkSync(target, dockerfile);
    const buildImage = vi.fn(async () => 0);

    await expect(
      prebuildSandboxImageIfEligible({
        buildCtx,
        buildId: BUILD_ID,
        origin: "generated",
        createArgs,
        sandboxName: "alpha",
        dockerDriverGateway: true,
        env: {},
        buildImage,
        log: () => {},
      }),
    ).rejects.toThrow("could not inspect the staged context");
    expect(buildImage).not.toHaveBeenCalled();
  });

  it("rejects a non-regular staged Dockerfile", async () => {
    const { buildCtx, createArgs, dockerfile } = createBuildContext();
    fs.rmSync(dockerfile);
    fs.mkdirSync(dockerfile);
    const buildImage = vi.fn(async () => 0);

    await expect(
      prebuildSandboxImageIfEligible({
        buildCtx,
        buildId: BUILD_ID,
        origin: "generated",
        createArgs,
        sandboxName: "alpha",
        dockerDriverGateway: true,
        env: {},
        buildImage,
        log: () => {},
      }),
    ).rejects.toThrow("rejected the staged context trust boundary");
    expect(buildImage).not.toHaveBeenCalled();
  });

  it("rejects a staged Dockerfile that resolves outside its context", async () => {
    const { buildCtx, createArgs, dockerfile } = createBuildContext();
    const outsideDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-prebuild-outside-"));
    temporaryDirectories.push(outsideDirectory);
    const outside = path.join(outsideDirectory, "Dockerfile");
    fs.rmSync(dockerfile);
    fs.writeFileSync(outside, "FROM scratch\n");
    fs.symlinkSync(outside, dockerfile);
    const buildImage = vi.fn(async () => 0);

    await expect(
      prebuildSandboxImageIfEligible({
        buildCtx,
        buildId: BUILD_ID,
        origin: "generated",
        createArgs,
        sandboxName: "alpha",
        dockerDriverGateway: true,
        env: {},
        buildImage,
        log: () => {},
      }),
    ).rejects.toThrow("rejected the staged context trust boundary");
    expect(buildImage).not.toHaveBeenCalled();
  });

  it("fails closed when staged context inspection errors", async () => {
    const { buildCtx, createArgs } = createBuildContext();
    const buildImage = vi.fn(async () => 0);
    const log = vi.fn();
    vi.spyOn(fs, "openSync").mockImplementation(() => {
      throw Object.assign(new Error("too many open files"), { code: "EMFILE" });
    });

    await expect(
      prebuildSandboxImageIfEligible({
        buildCtx,
        buildId: BUILD_ID,
        origin: "generated",
        createArgs,
        sandboxName: "alpha",
        dockerDriverGateway: true,
        env: {},
        buildImage,
        log,
      }),
    ).rejects.toThrow("could not inspect the staged context");
    expect(buildImage).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("uses the argv-based Docker helper and returns the local image on success", async () => {
    const { buildCtx, createArgs, dockerfile } = createBuildContext();
    const buildImage = vi.fn(async () => 0);
    const resolvedBuildCtx = fs.realpathSync(buildCtx);
    const resolvedDockerfile = fs.realpathSync(dockerfile);
    const result = await prebuildSandboxImageIfEligible({
      buildCtx,
      buildId: BUILD_ID,
      origin: "generated",
      createArgs,
      sandboxName: "alpha",
      dockerDriverGateway: true,
      env: {},
      buildImage,
      inspectImageId: () => IMAGE_ID,
      log: () => {},
    });

    expect(buildImage).toHaveBeenCalledWith(
      [
        "build",
        "-t",
        "nemoclaw-sandbox-local:alpha-1234567890",
        "-f",
        resolvedDockerfile,
        resolvedBuildCtx,
      ],
      expect.objectContaining({
        env: expect.objectContaining({ DOCKER_BUILDKIT: "1" }),
        stdio: "inherit",
      }),
    );
    expect(result).toEqual({
      createArgs: ["--from", "nemoclaw-sandbox-local:alpha-1234567890", "--name", "alpha"],
      imageRef: "nemoclaw-sandbox-local:alpha-1234567890",
      imageId: IMAGE_ID,
    });
  });

  it("rebinds the typed ordinary source without constructing create arguments", async () => {
    const { buildCtx, dockerfile } = createBuildContext();
    const result = await prebuildSandboxImageIfEligible({
      buildCtx,
      buildId: BUILD_ID,
      origin: "generated",
      sourceReference: dockerfile,
      sandboxName: "alpha",
      dockerDriverGateway: true,
      env: {},
      buildImage: vi.fn(async () => 0),
      inspectImageId: () => IMAGE_ID,
      log: () => {},
    });

    expect(result).toEqual({
      createArgs: [],
      sourceReference: "nemoclaw-sandbox-local:alpha-1234567890",
      imageRef: "nemoclaw-sandbox-local:alpha-1234567890",
      imageId: IMAGE_ID,
    });
  });

  it("isolates a generated BuildKit build from an unavailable WSL Docker Desktop helper (#9748)", async () => {
    const { buildCtx, createArgs } = createBuildContext();
    const dockerConfig = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-wsl-docker-config-"));
    temporaryDirectories.push(dockerConfig);
    const originalConfig = JSON.stringify({
      auths: { "registry.example.com": { auth: "must-remain-private" } },
      credsStore: "desktop.exe",
    });
    fs.writeFileSync(path.join(dockerConfig, "config.json"), originalConfig);
    const credentialHelperResponds = vi.fn(() => false);
    const log = vi.fn();
    let isolatedConfig = "";
    const buildImage = vi.fn(async (_args, options) => {
      isolatedConfig = String(options.env.DOCKER_CONFIG);
      expect(isolatedConfig).toContain("nemoclaw-wsl-buildkit-docker-config-");
      expect(isolatedConfig).not.toBe(dockerConfig);
      expect(fs.statSync(isolatedConfig).mode & 0o777).toBe(0o700);
      expect(
        JSON.parse(fs.readFileSync(path.join(isolatedConfig, "config.json"), "utf-8")),
      ).toEqual({ auths: {} });
      expect(fs.statSync(path.join(isolatedConfig, "config.json")).mode & 0o777).toBe(0o600);
      return 0;
    });

    await expect(
      prebuildSandboxImageIfEligible({
        buildCtx,
        buildId: BUILD_ID,
        origin: "generated",
        createArgs,
        sandboxName: "alpha",
        dockerDriverGateway: true,
        env: {
          DOCKER_CONFIG: dockerConfig,
          NEMOCLAW_SANDBOX_PREBUILD: "1",
          WSL_DISTRO_NAME: "Ubuntu",
        },
        buildImage,
        credentialHelperResponds,
        dockerContextIsDefault: () => true,
        isWslHost: true,
        inspectImageId: () => IMAGE_ID,
        log,
      }),
    ).resolves.toMatchObject({
      imageRef: "nemoclaw-sandbox-local:alpha-1234567890",
    });

    expect(credentialHelperResponds).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("isolated credential-free config"));
    expect(fs.existsSync(isolatedConfig)).toBe(false);
    expect(fs.readFileSync(path.join(dockerConfig, "config.json"), "utf-8")).toBe(originalConfig);
  });

  it("keeps Docker credentials for a custom build when the WSL Desktop helper is unavailable", async () => {
    const { buildCtx, createArgs } = createBuildContext();
    const dockerConfig = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-wsl-docker-config-"));
    temporaryDirectories.push(dockerConfig);
    const originalConfig = JSON.stringify({
      auths: { "registry.example.com": { auth: "private-base-image" } },
      credsStore: "desktop.exe",
    });
    fs.writeFileSync(path.join(dockerConfig, "config.json"), originalConfig);
    const credentialHelperResponds = vi.fn(() => false);
    const log = vi.fn();
    const buildImage = vi.fn(async (_args, options) => {
      expect(options.env.DOCKER_CONFIG).toBe(dockerConfig);
      return 0;
    });

    await expect(
      prebuildSandboxImageIfEligible({
        buildCtx,
        buildId: BUILD_ID,
        origin: "custom",
        createArgs,
        sandboxName: "alpha",
        dockerDriverGateway: true,
        env: {
          DOCKER_CONFIG: dockerConfig,
          NEMOCLAW_SANDBOX_PREBUILD: "1",
          WSL_DISTRO_NAME: "Ubuntu",
        },
        buildImage,
        credentialHelperResponds,
        dockerContextIsDefault: () => true,
        isWslHost: true,
        inspectImageId: () => IMAGE_ID,
        log,
      }),
    ).resolves.toMatchObject({ imageRef: "nemoclaw-sandbox-local:alpha-1234567890" });

    expect(buildImage).toHaveBeenCalledOnce();
    expect(credentialHelperResponds).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("isolated credential-free"));
    expect(fs.readFileSync(path.join(dockerConfig, "config.json"), "utf-8")).toBe(originalConfig);
  });

  it("overlays the isolated Docker config onto a managed-image create env (#10349)", () => {
    const dockerConfig = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-wsl-docker-config-"));
    temporaryDirectories.push(dockerConfig);
    fs.writeFileSync(
      path.join(dockerConfig, "config.json"),
      JSON.stringify({ credsStore: "desktop.exe" }),
    );
    const prepared = prepareDockerBuildEnvironment({
      env: { DOCKER_CONFIG: dockerConfig, WSL_DISTRO_NAME: "Ubuntu" },
      credentialHelperResponds: () => false,
      dockerContextIsDefault: () => true,
      isWslHost: true,
    });
    const merged = mergeIsolatedDockerClientEnv(
      { PATH: "/usr/bin", OPENSHELL_GATEWAY: "1", DOCKER_CONFIG: dockerConfig },
      prepared,
    );
    const dockerOnly = mergeIsolatedDockerClientEnv({}, prepared);
    expect(prepared.isolatedCredentialConfig).toBe(true);
    expect(merged.DOCKER_CONFIG).toContain("nemoclaw-wsl-buildkit-docker-config-");
    expect(merged.DOCKER_CONFIG).not.toBe(dockerConfig);
    expect(merged.PATH).toBe("/usr/bin");
    expect(merged.OPENSHELL_GATEWAY).toBe("1");
    expect(dockerOnly).toEqual({ DOCKER_CONFIG: merged.DOCKER_CONFIG });
    expect(dockerOnly).not.toHaveProperty("NVIDIA_INFERENCE_API_KEY");
    prepared.cleanup();
    expect(fs.existsSync(String(merged.DOCKER_CONFIG))).toBe(false);
  });

  it("keeps the caller Docker config when the Desktop helper responds (#10349)", () => {
    const dockerConfig = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-wsl-docker-config-"));
    temporaryDirectories.push(dockerConfig);
    fs.writeFileSync(
      path.join(dockerConfig, "config.json"),
      JSON.stringify({ credsStore: "desktop.exe" }),
    );
    const prepared = prepareDockerBuildEnvironment({
      env: { DOCKER_CONFIG: dockerConfig, WSL_DISTRO_NAME: "Ubuntu" },
      credentialHelperResponds: () => true,
      isWslHost: true,
    });
    const merged = mergeIsolatedDockerClientEnv({ DOCKER_CONFIG: dockerConfig }, prepared);
    expect(prepared.isolatedCredentialConfig).toBe(false);
    expect(merged.DOCKER_CONFIG).toBe(dockerConfig);
    prepared.cleanup();
  });

  it("keeps the caller Docker config for a non-default Docker context (#10349)", () => {
    const dockerConfig = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-wsl-docker-config-"));
    temporaryDirectories.push(dockerConfig);
    fs.writeFileSync(
      path.join(dockerConfig, "config.json"),
      JSON.stringify({
        credsStore: "desktop.exe",
        currentContext: "remote-builder",
      }),
    );
    const prepared = prepareDockerBuildEnvironment({
      env: { DOCKER_CONFIG: dockerConfig, WSL_DISTRO_NAME: "Ubuntu" },
      credentialHelperResponds: () => false,
      dockerContextIsDefault: () => false,
      isWslHost: true,
    });
    const merged = mergeIsolatedDockerClientEnv({ DOCKER_CONFIG: dockerConfig }, prepared);
    expect(prepared.isolatedCredentialConfig).toBe(false);
    expect(merged.DOCKER_CONFIG).toBe(dockerConfig);
    prepared.cleanup();
  });

  it("keeps the caller Docker config for an explicit Unix-socket Docker host (#10349)", () => {
    const dockerConfig = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-wsl-docker-config-"));
    temporaryDirectories.push(dockerConfig);
    fs.writeFileSync(
      path.join(dockerConfig, "config.json"),
      JSON.stringify({ credsStore: "desktop.exe" }),
    );
    const helperResponds = vi.fn(() => false);
    const prepared = prepareDockerBuildEnvironment({
      env: {
        DOCKER_CONFIG: dockerConfig,
        DOCKER_HOST: "unix:///run/user/1001/docker.sock",
        WSL_DISTRO_NAME: "Ubuntu",
      },
      credentialHelperResponds: helperResponds,
      isWslHost: true,
    });
    const merged = mergeIsolatedDockerClientEnv({ DOCKER_CONFIG: dockerConfig }, prepared);
    expect(prepared.isolatedCredentialConfig).toBe(false);
    expect(prepared.env.DOCKER_CONFIG).toBe(dockerConfig);
    expect(merged.DOCKER_CONFIG).toBe(dockerConfig);
    expect(helperResponds).not.toHaveBeenCalled();
    expect(prepared.cleanup()).toEqual({ ok: true });
  });

  it("returns retained credential-free config details when cleanup fails (#10349)", () => {
    const dockerConfig = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-wsl-docker-config-"));
    temporaryDirectories.push(dockerConfig);
    fs.writeFileSync(
      path.join(dockerConfig, "config.json"),
      JSON.stringify({ credsStore: "desktop.exe" }),
    );
    const prepared = prepareDockerBuildEnvironment({
      env: { DOCKER_CONFIG: dockerConfig, WSL_DISTRO_NAME: "Ubuntu" },
      credentialHelperResponds: () => false,
      dockerContextIsDefault: () => true,
      isWslHost: true,
    });
    const isolatedConfig = String(prepared.env.DOCKER_CONFIG);
    temporaryDirectories.push(isolatedConfig);
    const remove = vi.spyOn(fs, "rmSync").mockImplementationOnce(() => {
      throw new Error("permission denied");
    });

    expect(prepared.cleanup()).toEqual({
      ok: false,
      directory: isolatedConfig,
      error: "permission denied",
    });
    expect(fs.existsSync(isolatedConfig)).toBe(true);
    remove.mockRestore();
    fs.rmSync(isolatedConfig, { recursive: true, force: true });
  });

  it("removes the isolated WSL Docker config after a failed required build (#9748)", async () => {
    const { buildCtx, createArgs } = createBuildContext();
    const dockerConfig = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-wsl-docker-config-"));
    temporaryDirectories.push(dockerConfig);
    fs.writeFileSync(
      path.join(dockerConfig, "config.json"),
      JSON.stringify({ credsStore: "desktop.exe" }),
    );
    let isolatedConfig = "";
    const buildImage = vi.fn(async (_args, options) => {
      isolatedConfig = String(options.env.DOCKER_CONFIG);
      expect(fs.existsSync(isolatedConfig)).toBe(true);
      return 1;
    });

    await expect(
      prebuildSandboxImageIfEligible({
        buildCtx,
        buildId: BUILD_ID,
        origin: "generated",
        createArgs,
        sandboxName: "alpha",
        dockerDriverGateway: true,
        env: { DOCKER_CONFIG: dockerConfig, WSL_DISTRO_NAME: "Ubuntu" },
        buildImage,
        credentialHelperResponds: () => false,
        dockerContextIsDefault: () => true,
        isWslHost: true,
        log: () => {},
      }),
    ).rejects.toThrow("Local BuildKit build failed (exit 1)");

    expect(fs.existsSync(isolatedConfig)).toBe(false);
  });

  it("preserves the active WSL Docker config when its Desktop helper responds (#9748)", async () => {
    const { buildCtx, createArgs } = createBuildContext();
    const dockerConfig = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-wsl-docker-config-"));
    temporaryDirectories.push(dockerConfig);
    fs.writeFileSync(
      path.join(dockerConfig, "config.json"),
      JSON.stringify({ credsStore: "desktop.exe" }),
    );
    const buildImage = vi.fn(async (_args, options) => {
      expect(options.env.DOCKER_CONFIG).toBe(dockerConfig);
      return 0;
    });

    await prebuildSandboxImageIfEligible({
      buildCtx,
      buildId: BUILD_ID,
      origin: "generated",
      createArgs,
      sandboxName: "alpha",
      dockerDriverGateway: true,
      env: {
        DOCKER_CONFIG: dockerConfig,
        NEMOCLAW_SANDBOX_PREBUILD: "1",
        WSL_DISTRO_NAME: "Ubuntu",
      },
      buildImage,
      credentialHelperResponds: () => true,
      isWslHost: true,
      inspectImageId: () => IMAGE_ID,
      log: () => {},
    });

    expect(fs.existsSync(dockerConfig)).toBe(true);
  });

  /** Keep publication credentials isolated after a successful registry readiness probe. */
  it("publishes portable-profile builds to the managed loopback registry", async () => {
    const fetchRegistry = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const { buildCtx, createArgs } = createBuildContext();
    const buildImage = vi.fn().mockResolvedValue(0);
    let credentialConfig = "";
    /** Inspect the temporary credential boundary before publication removes it. */
    const publishImage = vi.fn(async (_args, options) => {
      credentialConfig = String(options.env.DOCKER_CONFIG);
      expect(credentialConfig).toContain("nemoclaw-portable-docker-config-");
      expect(options.env.REGISTRY_AUTH_FILE).toBe(path.join(credentialConfig, "config.json"));
      expect(fs.statSync(credentialConfig).mode & 0o777).toBe(0o700);
      expect(
        JSON.parse(fs.readFileSync(path.join(credentialConfig, "config.json"), "utf-8")),
      ).toEqual({ auths: {} });
      expect(fs.statSync(path.join(credentialConfig, "config.json")).mode & 0o777).toBe(0o600);
      return 0;
    });
    const result = await prebuildSandboxImageIfEligible({
      buildCtx,
      buildId: BUILD_ID,
      origin: "generated",
      createArgs,
      sandboxName: "alpha",
      dockerDriverGateway: true,
      env: { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" },
      buildImage,
      publishImage,
      inspectImageId: () => IMAGE_ID.slice("sha256:".length),
      log: () => {},
    });

    expect(publishImage).toHaveBeenCalledWith(
      ["push", "127.0.0.1:54321/nemoclaw-sandbox-local:alpha-1234567890"],
      expect.objectContaining({ stdio: "inherit" }),
    );
    expect(fetchRegistry.mock.invocationCallOrder[0]).toBeLessThan(
      buildImage.mock.invocationCallOrder[0],
    );
    expect(fetchRegistry).toHaveBeenCalledWith(new URL("http://127.0.0.1:54321/v2/"), {
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
    expect(buildImage).toHaveBeenCalledWith(
      expect.arrayContaining(["build", "127.0.0.1:54321/nemoclaw-sandbox-local:alpha-1234567890"]),
      expect.objectContaining({
        env: expect.not.objectContaining({ DOCKER_BUILDKIT: "1" }),
      }),
    );
    expect(result.imageRef).toBe("127.0.0.1:54321/nemoclaw-sandbox-local:alpha-1234567890");
    expect(result.imageId).toBe(IMAGE_ID);
    expect(fs.existsSync(credentialConfig)).toBe(false);
  });

  /** Failed probes must leave both image construction and publication untouched. */
  it.each([
    ["connection refusal", new Error("connection refused")],
    ["timeout", new DOMException("timed out", "TimeoutError")],
    ["HTTP failure", new Response(null, { status: 503 })],
    ["authentication required", new Response(null, { status: 401 })],
    ["redirect", new Response(null, { status: 302 })],
  ] as const)("refuses a Portable build after registry %s (#11724)", async (_condition, probe) => {
    const fetchRegistry = vi
      .spyOn(globalThis, "fetch")
      .mockReturnValue(probe instanceof Response ? Promise.resolve(probe) : Promise.reject(probe));
    const { buildCtx, createArgs } = createBuildContext();
    const buildImage = vi.fn().mockResolvedValue(0);
    const publishImage = vi.fn().mockResolvedValue(125);

    await expect(
      prebuildSandboxImageIfEligible({
        buildCtx,
        buildId: "registry-reachability",
        createArgs,
        sandboxName: "alpha",
        dockerDriverGateway: true,
        origin: "generated",
        env: { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable", NEMOCLAW_SANDBOX_PREBUILD: "1" },
        buildImage,
        publishImage,
        log: vi.fn(),
      }),
    ).rejects.toThrow(/registry/i);
    expect(buildImage).not.toHaveBeenCalled();
    expect(publishImage).not.toHaveBeenCalled();
    expect(fetchRegistry).toHaveBeenCalledWith(new URL("http://127.0.0.1:54321/v2/"), {
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
  });

  it("suppresses unfiltered Docker build output in both output modes (#6403)", async () => {
    const { buildCtx, createArgs } = createBuildContext();
    mocks.dockerSpawn.mockImplementation(() => {
      const child = new EventEmitter();
      process.nextTick(() => child.emit("close", 0));
      return child;
    });
    const build = () =>
      prebuildSandboxImageIfEligible({
        buildCtx,
        buildId: BUILD_ID,
        origin: "generated",
        createArgs,
        sandboxName: "alpha",
        dockerDriverGateway: true,
        env: {},
        inspectImageId: () => IMAGE_ID,
        log: () => {},
      });

    await expect(build()).resolves.toEqual(
      expect.objectContaining({
        imageRef: "nemoclaw-sandbox-local:alpha-1234567890",
      }),
    );
    expect(mocks.dockerSpawn).toHaveBeenCalledWith(
      expect.arrayContaining(["build", "nemoclaw-sandbox-local:alpha-1234567890"]),
      expect.objectContaining({ shell: false, stdio: ["ignore", "ignore", "pipe"] }),
    );

    mocks.dockerSpawn.mockClear();
    await expect(withStdoutRedirectedToStderr(build)).resolves.toEqual(
      expect.objectContaining({
        imageRef: "nemoclaw-sandbox-local:alpha-1234567890",
      }),
    );
    expect(mocks.dockerSpawn).toHaveBeenCalledWith(
      expect.arrayContaining(["build", "nemoclaw-sandbox-local:alpha-1234567890"]),
      expect.objectContaining({
        shell: false,
        stdio: ["ignore", "ignore", "pipe"],
      }),
    );
  });

  it("classifies failed build output without exposing Dockerfile text or credentials", async () => {
    const { buildCtx, createArgs } = createBuildContext();
    const inspectImageId = vi.fn(() => IMAGE_ID);
    const stderr = new EventEmitter();
    mocks.dockerSpawn.mockImplementation(() => {
      const child = new EventEmitter();
      Object.assign(child, { stderr });
      process.nextTick(() => {
        stderr.emit(
          "data",
          Buffer.from("secret-token-123 COPY private.txt: not found in build context"),
        );
        child.emit("close", 1);
      });
      return child;
    });

    const failure = await prebuildSandboxImageIfEligible({
      buildCtx,
      buildId: BUILD_ID,
      origin: "generated",
      createArgs,
      sandboxName: "alpha",
      dockerDriverGateway: true,
      env: {},
      inspectImageId,
      log: () => {},
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("Check COPY sources and the permitted build context");
    expect(String(failure)).not.toContain("secret-token-123");
    expect(String(failure)).not.toContain("private.txt");
    expect(inspectImageId).not.toHaveBeenCalled();
  });

  it("stops a stalled local build before inspecting or handing off an image", async () => {
    const { buildCtx, createArgs } = createBuildContext();
    const child = new EventEmitter();
    const kill = vi.fn(() => true);
    Object.assign(child, { kill });
    mocks.dockerSpawn.mockReturnValue(child);
    const inspectImageId = vi.fn(() => IMAGE_ID);
    vi.useFakeTimers();
    try {
      const build = prebuildSandboxImageIfEligible({
        buildCtx,
        buildId: BUILD_ID,
        origin: "generated",
        createArgs,
        sandboxName: "alpha",
        dockerDriverGateway: true,
        env: {},
        inspectImageId,
        log: () => {},
      });
      const rejection = expect(build).rejects.toThrow(
        "Local BuildKit build timed out after 20 minutes",
      );
      await vi.advanceTimersByTimeAsync(20 * 60_000);
      await rejection;
      expect(kill).toHaveBeenCalledWith("SIGKILL");
      expect(inspectImageId).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects disabling a required local BuildKit build", async () => {
    const { buildCtx, createArgs } = createBuildContext();

    await expect(
      prebuildSandboxImageIfEligible({
        buildCtx,
        buildId: BUILD_ID,
        origin: "generated",
        createArgs,
        sandboxName: "alpha",
        dockerDriverGateway: true,
        env: { NEMOCLAW_SANDBOX_PREBUILD: "0" },
        log: () => {},
      }),
    ).rejects.toThrow("Generated Dockerfile image build is required");
  });

  it("rejects an untrusted context instead of handing a required build to the gateway", async () => {
    const { buildCtx, createArgs } = createBuildContext();
    fs.chmodSync(buildCtx, 0o770);

    await expect(
      prebuildSandboxImageIfEligible({
        buildCtx,
        buildId: BUILD_ID,
        origin: "generated",
        createArgs,
        sandboxName: "alpha",
        dockerDriverGateway: true,
        env: {},
        log: () => {},
      }),
    ).rejects.toThrow("Generated image build rejected the staged context trust boundary");
  });

  it("preserves a required staged-context inspection diagnosis", async () => {
    const { buildCtx, createArgs } = createBuildContext();
    vi.spyOn(fs, "openSync").mockImplementation(() => {
      throw new Error("descriptor limit reached");
    });

    await expect(
      prebuildSandboxImageIfEligible({
        buildCtx,
        buildId: BUILD_ID,
        origin: "generated",
        createArgs,
        sandboxName: "alpha",
        dockerDriverGateway: true,
        env: {},
        log: () => {},
      }),
    ).rejects.toThrow("Generated image build could not inspect the staged context");
  });

  it("rejects mismatched create arguments for a required build", async () => {
    const { buildCtx } = createBuildContext();

    await expect(
      prebuildSandboxImageIfEligible({
        buildCtx,
        buildId: BUILD_ID,
        origin: "generated",
        createArgs: ["--from", "/other/Dockerfile"],
        sandboxName: "alpha",
        dockerDriverGateway: true,
        env: {},
        log: () => {},
      }),
    ).rejects.toThrow("Generated image build requires the selected staged Dockerfile");
  });

  it.each([
    ["a nonzero result", async () => 1, "Local BuildKit build failed (exit 1)"],
    [
      "a missing exit status",
      async () => null,
      "Local BuildKit build failed without an exit status",
    ],
  ])("fails closed after %s from a required build", async (_label, buildImage, message) => {
    const { buildCtx, createArgs } = createBuildContext();

    await expect(
      prebuildSandboxImageIfEligible({
        buildCtx,
        buildId: BUILD_ID,
        origin: "generated",
        createArgs,
        sandboxName: "alpha",
        dockerDriverGateway: true,
        env: {},
        buildImage,
        log: () => {},
      }),
    ).rejects.toThrow(message);
  });

  it("preserves a required builder startup diagnosis", async () => {
    const { buildCtx, createArgs } = createBuildContext();

    await expect(
      prebuildSandboxImageIfEligible({
        buildCtx,
        buildId: BUILD_ID,
        origin: "generated",
        createArgs,
        sandboxName: "alpha",
        dockerDriverGateway: true,
        env: {},
        buildImage: async () => {
          throw new Error("builder unavailable");
        },
        log: () => {},
      }),
    ).rejects.toThrow("Local BuildKit build could not start");
  });

  it.each([
    ["nonzero result", async () => 1],
    ["missing exit status", async () => null],
  ])("stops sandbox creation after a %s", async (_label, buildImage) => {
    const { buildCtx, createArgs } = createBuildContext();
    await expect(
      prebuildSandboxImageIfEligible({
        buildCtx,
        buildId: BUILD_ID,
        origin: "generated",
        createArgs,
        sandboxName: "alpha",
        dockerDriverGateway: true,
        env: {},
        buildImage,
        log: () => {},
      }),
    ).rejects.toThrow("Local BuildKit build failed");
  });

  it("stops sandbox creation when the Docker helper throws", async () => {
    const { buildCtx, createArgs } = createBuildContext();
    await expect(
      prebuildSandboxImageIfEligible({
        buildCtx,
        buildId: BUILD_ID,
        origin: "generated",
        createArgs,
        sandboxName: "alpha",
        dockerDriverGateway: true,
        env: {},
        buildImage: async () => {
          throw new Error("unavailable");
        },
        log: () => {},
      }),
    ).rejects.toThrow("Local BuildKit build could not start");
  });
});
