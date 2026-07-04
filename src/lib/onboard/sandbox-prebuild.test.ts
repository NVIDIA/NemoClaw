// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  dockerBuildSubprocessEnv,
  prebuildSandboxImageIfEligible,
  resolveSandboxPrebuildEnabled,
  sandboxLocalImageRef,
} from "./sandbox-prebuild";

const BUILD_CONTEXT = "/tmp/nemoclaw-build-abc";
const BUILD_ID = "1234567890";
const DOCKERFILE = `${BUILD_CONTEXT}/Dockerfile`;
const CREATE_ARGS = ["--from", DOCKERFILE, "--name", "alpha"];

describe("sandbox BuildKit prebuild", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps Docker runtime settings while dropping secrets and control-plane state", () => {
    vi.stubEnv("PATH", "/usr/bin");
    vi.stubEnv("HOME", "/home/user");
    vi.stubEnv("DOCKER_HOST", "unix:///var/run/docker.sock");
    vi.stubEnv("DOCKER_CONFIG", "/home/user/.docker-ci");
    vi.stubEnv("DOCKER_CONTEXT", "remote-builder");
    vi.stubEnv("XDG_CONFIG_HOME", "/home/user/.config");
    vi.stubEnv("HTTPS_PROXY", "http://proxy:8080");
    vi.stubEnv("NVIDIA_INFERENCE_API_KEY", "secret");
    vi.stubEnv("GITHUB_TOKEN", "secret");
    vi.stubEnv("KUBECONFIG", "/home/user/.kube/config");
    vi.stubEnv("SSH_AUTH_SOCK", "/tmp/agent.sock");
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
      "OPENSHELL_GATEWAY",
      "GRPC_VERBOSITY",
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
    const buildImage = vi.fn(async () => 0);
    await expect(
      prebuildSandboxImageIfEligible({
        buildCtx: BUILD_CONTEXT,
        buildId: BUILD_ID,
        createArgs: ["--from", "/other/Dockerfile"],
        sandboxName: "alpha",
        dockerDriverGateway: true,
        env: {},
        buildImage,
      }),
    ).resolves.toEqual({ createArgs: ["--from", "/other/Dockerfile"], imageRef: null });
    expect(buildImage).not.toHaveBeenCalled();
  });

  it("uses the argv-based Docker helper and returns the local image on success", async () => {
    const buildImage = vi.fn(async () => 0);
    const result = await prebuildSandboxImageIfEligible({
      buildCtx: BUILD_CONTEXT,
      buildId: BUILD_ID,
      createArgs: CREATE_ARGS,
      sandboxName: "alpha",
      dockerDriverGateway: true,
      env: {},
      buildImage,
      log: () => {},
    });

    expect(buildImage).toHaveBeenCalledWith(
      [
        "build",
        "--progress=plain",
        "-t",
        "nemoclaw-sandbox-local:alpha-1234567890",
        "-f",
        DOCKERFILE,
        BUILD_CONTEXT,
      ],
      expect.objectContaining({
        env: expect.objectContaining({ DOCKER_BUILDKIT: "1" }),
        stdio: "inherit",
      }),
    );
    expect(result).toEqual({
      createArgs: ["--from", "nemoclaw-sandbox-local:alpha-1234567890", "--name", "alpha"],
      imageRef: "nemoclaw-sandbox-local:alpha-1234567890",
    });
  });

  it.each([
    ["nonzero result", async () => 1],
    ["missing exit status", async () => null],
  ])("falls back to OpenShell after a %s", async (_label, buildImage) => {
    const result = await prebuildSandboxImageIfEligible({
      buildCtx: BUILD_CONTEXT,
      buildId: BUILD_ID,
      createArgs: CREATE_ARGS,
      sandboxName: "alpha",
      dockerDriverGateway: true,
      env: {},
      buildImage,
      log: () => {},
    });
    expect(result).toEqual({ createArgs: CREATE_ARGS, imageRef: null });
  });

  it("falls back to OpenShell when the Docker helper throws", async () => {
    const result = await prebuildSandboxImageIfEligible({
      buildCtx: BUILD_CONTEXT,
      buildId: BUILD_ID,
      createArgs: CREATE_ARGS,
      sandboxName: "alpha",
      dockerDriverGateway: true,
      env: {},
      buildImage: async () => {
        throw new Error("unavailable");
      },
      log: () => {},
    });
    expect(result).toEqual({ createArgs: CREATE_ARGS, imageRef: null });
  });
});
