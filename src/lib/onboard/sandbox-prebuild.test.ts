// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ dockerSpawn: vi.fn() }));

vi.mock("../adapters/docker/exec", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/docker/exec")>()),
  dockerSpawn: mocks.dockerSpawn,
}));

import {
  dockerBuildSubprocessEnv,
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
  return { buildCtx, createArgs: ["--from", dockerfile, "--name", "alpha"], dockerfile };
}

describe("sandbox BuildKit prebuild", () => {
  afterEach(() => {
    mocks.dockerSpawn.mockReset();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps Docker runtime settings while dropping secrets and control-plane state", () => {
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

  it("keeps Docker host precedence over an ambient Docker context", () => {
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

  it("skips the build when create arguments do not use the staged Dockerfile", async () => {
    const { buildCtx } = createBuildContext();
    const buildImage = vi.fn(async () => 0);
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
    ).resolves.toEqual({
      createArgs: ["--from", "/other/Dockerfile"],
      imageRef: null,
      imageId: null,
    });
    expect(buildImage).not.toHaveBeenCalled();
  });

  it("keeps user-supplied Dockerfiles on the gateway builder", async () => {
    const { buildCtx, createArgs } = createBuildContext();
    const buildImage = vi.fn(async () => 0);
    const log = vi.fn();

    await expect(
      prebuildSandboxImageIfEligible({
        buildCtx,
        buildId: BUILD_ID,
        origin: "custom",
        createArgs,
        sandboxName: "alpha",
        dockerDriverGateway: true,
        env: {},
        buildImage,
        log,
      }),
    ).resolves.toEqual({ createArgs, imageRef: null, imageId: null });
    expect(buildImage).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("custom Dockerfile"));
  });

  it("skips host Docker for a staged-looking context outside the OS temp directory", async () => {
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
    ).resolves.toEqual({ createArgs, imageRef: null, imageId: null });
    expect(buildImage).not.toHaveBeenCalled();
  });

  it("skips host Docker for a temporary context without the staging prefix", async () => {
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
    ).resolves.toEqual({ createArgs, imageRef: null, imageId: null });
    expect(buildImage).not.toHaveBeenCalled();
  });

  it("skips host Docker for a group-writable staged context", async () => {
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
    ).resolves.toEqual({ createArgs, imageRef: null, imageId: null });
    expect(buildImage).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("failed trust validation"));
  });

  it("skips host Docker for a symlinked staged Dockerfile", async () => {
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
    ).resolves.toEqual({ createArgs, imageRef: null, imageId: null });
    expect(buildImage).not.toHaveBeenCalled();
  });

  it("skips host Docker for a non-regular staged Dockerfile", async () => {
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
    ).resolves.toEqual({ createArgs, imageRef: null, imageId: null });
    expect(buildImage).not.toHaveBeenCalled();
  });

  it("skips host Docker when the staged Dockerfile resolves outside its context", async () => {
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
    ).resolves.toEqual({ createArgs, imageRef: null, imageId: null });
    expect(buildImage).not.toHaveBeenCalled();
  });

  it("logs filesystem inspection errors distinctly before falling back", async () => {
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
    ).resolves.toEqual({ createArgs, imageRef: null, imageId: null });
    expect(buildImage).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("too many open files"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("could not be inspected"));
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
    ).resolves.toMatchObject({ imageRef: "nemoclaw-sandbox-local:alpha-1234567890" });

    expect(credentialHelperResponds).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("isolated credential-free config"));
    expect(fs.existsSync(isolatedConfig)).toBe(false);
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
      JSON.stringify({ credsStore: "desktop.exe", currentContext: "remote-builder" }),
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
        requiresLocalBuildKit: true,
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

  it("publishes portable-profile builds to the managed loopback registry", async () => {
    const { buildCtx, createArgs } = createBuildContext();
    const buildImage = vi.fn(async () => 0);
    let credentialConfig = "";
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
      requiresLocalBuildKit: true,
      env: { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" },
      buildImage,
      publishImage,
      inspectImageId: () => IMAGE_ID,
      log: () => {},
    });

    expect(publishImage).toHaveBeenCalledWith(
      ["push", "localhost:5000/nemoclaw-sandbox-local:alpha-1234567890"],
      expect.objectContaining({ stdio: "inherit" }),
    );
    expect(buildImage).toHaveBeenCalledWith(
      expect.arrayContaining(["build", "localhost:5000/nemoclaw-sandbox-local:alpha-1234567890"]),
      expect.objectContaining({ env: expect.not.objectContaining({ DOCKER_BUILDKIT: "1" }) }),
    );
    expect(result.imageRef).toBe("localhost:5000/nemoclaw-sandbox-local:alpha-1234567890");
    expect(fs.existsSync(credentialConfig)).toBe(false);
  });

  it("routes default Docker build stdout only while JSONL owns stdout (#6403)", async () => {
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
      expect.objectContaining({ imageRef: "nemoclaw-sandbox-local:alpha-1234567890" }),
    );
    expect(mocks.dockerSpawn).toHaveBeenCalledWith(
      expect.arrayContaining(["build", "nemoclaw-sandbox-local:alpha-1234567890"]),
      expect.objectContaining({ shell: false, stdio: "inherit" }),
    );

    mocks.dockerSpawn.mockClear();
    await expect(withStdoutRedirectedToStderr(build)).resolves.toEqual(
      expect.objectContaining({ imageRef: "nemoclaw-sandbox-local:alpha-1234567890" }),
    );
    expect(mocks.dockerSpawn).toHaveBeenCalledWith(
      expect.arrayContaining(["build", "nemoclaw-sandbox-local:alpha-1234567890"]),
      expect.objectContaining({ shell: false, stdio: ["inherit", process.stderr, "inherit"] }),
    );
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
        requiresLocalBuildKit: true,
        env: { NEMOCLAW_SANDBOX_PREBUILD: "0" },
        log: () => {},
      }),
    ).rejects.toThrow("Local BuildKit is required for this generated sandbox image");
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
        requiresLocalBuildKit: true,
        env: {},
        log: () => {},
      }),
    ).rejects.toThrow("Local BuildKit rejected the staged build context trust boundary");
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
        requiresLocalBuildKit: true,
        env: {},
        log: () => {},
      }),
    ).rejects.toThrow(
      "Local BuildKit could not inspect the staged build context: descriptor limit reached",
    );
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
        requiresLocalBuildKit: true,
        env: {},
        log: () => {},
      }),
    ).rejects.toThrow("Local BuildKit requires the generated staged Dockerfile");
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
        requiresLocalBuildKit: true,
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
        requiresLocalBuildKit: true,
        env: {},
        buildImage: async () => {
          throw new Error("builder unavailable");
        },
        log: () => {},
      }),
    ).rejects.toThrow("Local BuildKit build could not start: builder unavailable");
  });

  it.each([
    ["nonzero result", async () => 1],
    ["missing exit status", async () => null],
  ])("falls back to OpenShell after a %s", async (_label, buildImage) => {
    const { buildCtx, createArgs } = createBuildContext();
    const result = await prebuildSandboxImageIfEligible({
      buildCtx,
      buildId: BUILD_ID,
      origin: "generated",
      createArgs,
      sandboxName: "alpha",
      dockerDriverGateway: true,
      env: {},
      buildImage,
      log: () => {},
    });
    expect(result).toEqual({ createArgs, imageRef: null, imageId: null });
  });

  it("falls back to OpenShell when the Docker helper throws", async () => {
    const { buildCtx, createArgs } = createBuildContext();
    const result = await prebuildSandboxImageIfEligible({
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
    });
    expect(result).toEqual({ createArgs, imageRef: null, imageId: null });
  });
});
