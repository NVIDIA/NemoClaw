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

import { withStdoutRedirectedToStderr } from "../cli/stdout-guard";
import { SANDBOX_BUILD_CONTEXT_PREFIX } from "../sandbox/build-context";
import {
  dockerBuildSubprocessEnv,
  issueManagedHermesBuildFailureCapability,
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
    vi.stubEnv("DOCKER_HOST", "unix:///var/run/docker.sock");
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
      DOCKER_HOST: "unix:///var/run/docker.sock",
      DOCKER_CONFIG: "/home/user/.docker-ci",
      DOCKER_CONTEXT: "remote-builder",
      XDG_CONFIG_HOME: "/home/user/.config",
      HTTPS_PROXY: "http://proxy:8080",
    });
    for (const key of [
      "NVIDIA_INFERENCE_API_KEY",
      "GITHUB_TOKEN",
      "KUBECONFIG",
      "SSH_AUTH_SOCK",
      "RUST_LOG",
      "RUST_BACKTRACE",
      "OPENSHELL_GATEWAY",
      "GRPC_VERBOSITY",
      "BUILDX_BUILDER",
    ]) {
      expect(env[key], key).toBeUndefined();
    }
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

  it("preserves optional fallback when an exact managed Hermes build cannot start", async () => {
    const { buildCtx, createArgs, dockerfile } = createBuildContext();
    const managedHermesBuildFailureCapability = issueManagedHermesBuildFailureCapability({
      agentName: "hermes",
      origin: "generated",
      dockerDriverGateway: true,
      buildCtx,
      stagedDockerfile: dockerfile,
      buildId: BUILD_ID,
    });
    const result = await prebuildSandboxImageIfEligible({
      buildCtx,
      buildId: BUILD_ID,
      origin: "generated",
      createArgs,
      sandboxName: "alpha",
      dockerDriverGateway: true,
      managedHermesBuildFailureCapability,
      env: {},
      buildImage: async () => {
        throw new Error("unavailable");
      },
      log: () => {},
    });
    expect(result).toEqual({ createArgs, imageRef: null, imageId: null });
  });

  it("issues failure capability only for an exact managed local Hermes context (#7140)", () => {
    const { buildCtx, dockerfile } = createBuildContext();
    const base = {
      agentName: "hermes",
      origin: "generated",
      dockerDriverGateway: true,
      buildCtx,
      stagedDockerfile: dockerfile,
      buildId: BUILD_ID,
    } as const;

    expect(issueManagedHermesBuildFailureCapability(base)).toBeDefined();
    expect(
      issueManagedHermesBuildFailureCapability({ ...base, agentName: "openclaw" }),
    ).toBeUndefined();
    expect(issueManagedHermesBuildFailureCapability({ ...base, origin: "custom" })).toBeUndefined();
    expect(
      issueManagedHermesBuildFailureCapability({ ...base, dockerDriverGateway: false }),
    ).toBeUndefined();
    expect(
      issueManagedHermesBuildFailureCapability({
        ...base,
        stagedDockerfile: path.join(buildCtx, "missing-Dockerfile"),
      }),
    ).toBeUndefined();
  });

  it("preserves optional fallback when the exact managed Hermes prebuild is disabled (#7140)", async () => {
    const { buildCtx, createArgs, dockerfile } = createBuildContext();
    const buildImage = vi.fn(async () => 0);
    const managedHermesBuildFailureCapability = issueManagedHermesBuildFailureCapability({
      agentName: "hermes",
      origin: "generated",
      dockerDriverGateway: true,
      buildCtx,
      stagedDockerfile: dockerfile,
      buildId: BUILD_ID,
    });

    await expect(
      prebuildSandboxImageIfEligible({
        buildCtx,
        buildId: BUILD_ID,
        origin: "generated",
        createArgs,
        sandboxName: "alpha",
        dockerDriverGateway: true,
        managedHermesBuildFailureCapability,
        env: { NEMOCLAW_SANDBOX_PREBUILD: "0" },
        buildImage,
      }),
    ).resolves.toEqual({ createArgs, imageRef: null, imageId: null });
    expect(buildImage).not.toHaveBeenCalled();
  });

  it.each([
    [
      "exits nonzero",
      async (): Promise<number> => 1,
      /local BuildKit build failed \(exit 1\).*Inspect the preceding BuildKit output/,
    ],
    [
      "returns no exit status",
      async (): Promise<null> => null,
      /local BuildKit build failed without an exit status.*Inspect the preceding BuildKit output/,
    ],
  ] as const)("preserves an exact managed Hermes BuildKit failure when the build %s (#7140)", async (_label, buildImage, message) => {
    const { buildCtx, createArgs, dockerfile } = createBuildContext();
    const managedHermesBuildFailureCapability = issueManagedHermesBuildFailureCapability({
      agentName: "hermes",
      origin: "generated",
      dockerDriverGateway: true,
      buildCtx,
      stagedDockerfile: dockerfile,
      buildId: BUILD_ID,
    });
    const failure = prebuildSandboxImageIfEligible({
      buildCtx,
      buildId: BUILD_ID,
      origin: "generated",
      createArgs,
      sandboxName: "alpha",
      dockerDriverGateway: true,
      managedHermesBuildFailureCapability,
      env: {},
      buildImage,
      log: () => {},
    });

    await expect(failure).rejects.toThrow(message);
  });

  it("does not authorize fail-fast after managed Hermes build identity drift (#7140)", async () => {
    const { buildCtx, createArgs, dockerfile } = createBuildContext();
    const buildImage = vi.fn(async () => 1);
    const managedHermesBuildFailureCapability = issueManagedHermesBuildFailureCapability({
      agentName: "hermes",
      origin: "generated",
      dockerDriverGateway: true,
      buildCtx,
      stagedDockerfile: dockerfile,
      buildId: BUILD_ID,
    });

    await expect(
      prebuildSandboxImageIfEligible({
        buildCtx,
        buildId: "different-build",
        origin: "generated",
        createArgs,
        sandboxName: "alpha",
        dockerDriverGateway: true,
        managedHermesBuildFailureCapability,
        env: {},
        buildImage,
        log: () => {},
      }),
    ).resolves.toEqual({ createArgs, imageRef: null, imageId: null });
    expect(buildImage).toHaveBeenCalledOnce();
  });

  it("does not authorize fail-fast for another staged context (#7140)", async () => {
    const issued = createBuildContext();
    const selected = createBuildContext();
    const buildImage = vi.fn(async () => 1);
    const managedHermesBuildFailureCapability = issueManagedHermesBuildFailureCapability({
      agentName: "hermes",
      origin: "generated",
      dockerDriverGateway: true,
      buildCtx: issued.buildCtx,
      stagedDockerfile: issued.dockerfile,
      buildId: BUILD_ID,
    });

    await expect(
      prebuildSandboxImageIfEligible({
        buildCtx: selected.buildCtx,
        buildId: BUILD_ID,
        origin: "generated",
        createArgs: selected.createArgs,
        sandboxName: "alpha",
        dockerDriverGateway: true,
        managedHermesBuildFailureCapability,
        env: {},
        buildImage,
        log: () => {},
      }),
    ).resolves.toEqual({
      createArgs: selected.createArgs,
      imageRef: null,
      imageId: null,
    });
    expect(buildImage).toHaveBeenCalledOnce();
  });

  it("does not authorize fail-fast after the staged Dockerfile identity changes (#7140)", async () => {
    const { buildCtx, createArgs, dockerfile } = createBuildContext();
    const buildImage = vi.fn(async () => 1);
    const managedHermesBuildFailureCapability = issueManagedHermesBuildFailureCapability({
      agentName: "hermes",
      origin: "generated",
      dockerDriverGateway: true,
      buildCtx,
      stagedDockerfile: dockerfile,
      buildId: BUILD_ID,
    });
    fs.renameSync(dockerfile, `${dockerfile}.original`);
    fs.writeFileSync(dockerfile, "FROM scratch\n");

    await expect(
      prebuildSandboxImageIfEligible({
        buildCtx,
        buildId: BUILD_ID,
        origin: "generated",
        createArgs,
        sandboxName: "alpha",
        dockerDriverGateway: true,
        managedHermesBuildFailureCapability,
        env: {},
        buildImage,
        log: () => {},
      }),
    ).resolves.toEqual({ createArgs, imageRef: null, imageId: null });
    expect(buildImage).toHaveBeenCalledOnce();
  });

  it("does not authorize fail-fast for a copied capability token (#7140)", async () => {
    const { buildCtx, createArgs, dockerfile } = createBuildContext();
    const buildImage = vi.fn(async () => 1);
    const issuedCapability = issueManagedHermesBuildFailureCapability({
      agentName: "hermes",
      origin: "generated",
      dockerDriverGateway: true,
      buildCtx,
      stagedDockerfile: dockerfile,
      buildId: BUILD_ID,
    });
    expect(issuedCapability).toBeDefined();
    const copiedCapability = { ...issuedCapability } as NonNullable<typeof issuedCapability>;

    await expect(
      prebuildSandboxImageIfEligible({
        buildCtx,
        buildId: BUILD_ID,
        origin: "generated",
        createArgs,
        sandboxName: "alpha",
        dockerDriverGateway: true,
        managedHermesBuildFailureCapability: copiedCapability,
        env: {},
        buildImage,
        log: () => {},
      }),
    ).resolves.toEqual({ createArgs, imageRef: null, imageId: null });
    expect(buildImage).toHaveBeenCalledOnce();
  });
});
