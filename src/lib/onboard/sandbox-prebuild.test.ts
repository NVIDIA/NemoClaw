// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildKitBuildCommand,
  dockerBuildSubprocessEnv,
  prebuildSandboxImageIfEligible,
  resolveSandboxPrebuildEnabled,
  rewriteCreateArgsWithImage,
  sandboxLocalImageRef,
} from "./sandbox-prebuild";

const CTX = "/tmp/nemoclaw-build-abc";
const DF = `${CTX}/Dockerfile`;

function baseCreateArgs(): string[] {
  return ["--from", DF, "--name", "alpha", "--policy", "/p.yaml"];
}

describe("dockerBuildSubprocessEnv", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps only the Docker-build boundary env and drops broader host/control-plane vars", () => {
    // Docker-build boundary: system, Docker daemon (+ XDG the docker CLI reads),
    // proxy, locale, temp, TLS CA.
    vi.stubEnv("PATH", "/usr/bin");
    vi.stubEnv("HOME", "/home/u");
    vi.stubEnv("DOCKER_HOST", "unix:///var/run/docker.sock");
    vi.stubEnv("XDG_CONFIG_HOME", "/home/u/.config");
    vi.stubEnv("HTTPS_PROXY", "http://proxy:8080");
    vi.stubEnv("LANG", "en_US.UTF-8");
    vi.stubEnv("TMPDIR", "/tmp");
    vi.stubEnv("NODE_EXTRA_CA_CERTS", "/etc/ca.pem");
    // Host secrets — already default-denied by the shared allowlist (#1874).
    vi.stubEnv("NVIDIA_INFERENCE_API_KEY", "secret");
    vi.stubEnv("GITHUB_TOKEN", "ghs_secret");
    // Broader-than-needed env a `docker build` must not inherit.
    vi.stubEnv("KUBECONFIG", "/home/u/.kube/config");
    vi.stubEnv("SSH_AUTH_SOCK", "/tmp/ssh-agent.sock");
    vi.stubEnv("OPENSHELL_GATEWAY", "nemoclaw");
    vi.stubEnv("GRPC_VERBOSITY", "debug");
    vi.stubEnv("RUST_LOG", "trace");

    const env = dockerBuildSubprocessEnv();

    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/u");
    expect(env.DOCKER_HOST).toBe("unix:///var/run/docker.sock");
    expect(env.XDG_CONFIG_HOME).toBe("/home/u/.config");
    expect(env.HTTPS_PROXY).toBe("http://proxy:8080");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.TMPDIR).toBe("/tmp");
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/etc/ca.pem");

    expect(env.NVIDIA_INFERENCE_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.KUBECONFIG).toBeUndefined();
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(env.OPENSHELL_GATEWAY).toBeUndefined();
    expect(env.GRPC_VERBOSITY).toBeUndefined();
    expect(env.RUST_LOG).toBeUndefined();
  });
});

describe("resolveSandboxPrebuildEnabled", () => {
  it("defaults on for the managed docker-driver path", () => {
    expect(resolveSandboxPrebuildEnabled({}, true)).toBe(true);
  });

  it("defaults off when not docker-driver (image not visible to a remote gateway)", () => {
    expect(resolveSandboxPrebuildEnabled({}, false)).toBe(false);
  });

  it("honours explicit overrides", () => {
    expect(resolveSandboxPrebuildEnabled({ NEMOCLAW_SANDBOX_PREBUILD: "0" }, true)).toBe(false);
    expect(resolveSandboxPrebuildEnabled({ NEMOCLAW_SANDBOX_PREBUILD: "1" }, false)).toBe(true);
  });

  it("is inert under the Vitest runner unless explicitly forced", () => {
    expect(resolveSandboxPrebuildEnabled({ VITEST: "true" }, true)).toBe(false);
    expect(resolveSandboxPrebuildEnabled({ NODE_ENV: "test" }, true)).toBe(false);
    // Explicit opt-in still wins under the test runner.
    expect(
      resolveSandboxPrebuildEnabled({ VITEST: "true", NEMOCLAW_SANDBOX_PREBUILD: "1" }, true),
    ).toBe(true);
  });
});

describe("sandboxLocalImageRef", () => {
  it("derives a stable, docker-valid tag from the sandbox name", () => {
    expect(sandboxLocalImageRef("alpha")).toBe("nemoclaw-sandbox-local:alpha");
  });

  it("sanitises invalid tag characters", () => {
    expect(sandboxLocalImageRef("My Bot/2!")).toBe("nemoclaw-sandbox-local:my-bot-2-");
    expect(sandboxLocalImageRef("")).toBe("nemoclaw-sandbox-local:sandbox");
  });
});

describe("buildKitBuildCommand", () => {
  it("enables BuildKit inline and targets the staged Dockerfile", () => {
    const cmd = buildKitBuildCommand(CTX, "nemoclaw-sandbox-local:alpha");
    expect(cmd).toContain("DOCKER_BUILDKIT=1");
    expect(cmd).toContain("docker build");
    expect(cmd).toContain("'nemoclaw-sandbox-local:alpha'");
    expect(cmd).toContain(`'${DF}'`);
    expect(cmd).toContain(`'${CTX}'`);
  });
});

describe("rewriteCreateArgsWithImage", () => {
  it("replaces the --from Dockerfile path with the image ref", () => {
    const out = rewriteCreateArgsWithImage(baseCreateArgs(), CTX, "nemoclaw-sandbox-local:alpha");
    expect(out).toEqual([
      "--from",
      "nemoclaw-sandbox-local:alpha",
      "--name",
      "alpha",
      "--policy",
      "/p.yaml",
    ]);
  });

  it("leaves args untouched when --from does not point at the staged Dockerfile", () => {
    const args = ["--from", "/other/Dockerfile", "--name", "alpha"];
    expect(rewriteCreateArgsWithImage(args, CTX, "img:tag")).toEqual(args);
  });
});

describe("prebuildSandboxImageIfEligible", () => {
  it("builds with BuildKit and rewrites --from on success", async () => {
    const streamBuild = vi.fn(async (_command: string) => ({ status: 0, output: "" }));
    const result = await prebuildSandboxImageIfEligible({
      buildCtx: CTX,
      createArgs: baseCreateArgs(),
      sandboxName: "alpha",
      dockerDriverGateway: true,
      env: {},
      streamBuild,
      log: () => {},
    });

    expect(streamBuild).toHaveBeenCalledOnce();
    expect(streamBuild.mock.calls[0][0]).toContain("DOCKER_BUILDKIT=1");
    expect(result.imageRef).toBe("nemoclaw-sandbox-local:alpha");
    expect(result.createArgs.slice(0, 2)).toEqual(["--from", "nemoclaw-sandbox-local:alpha"]);
  });

  it("skips the build and keeps the Dockerfile --from when ineligible", async () => {
    const streamBuild = vi.fn(async (_command: string) => ({ status: 0, output: "" }));
    const result = await prebuildSandboxImageIfEligible({
      buildCtx: CTX,
      createArgs: baseCreateArgs(),
      sandboxName: "alpha",
      dockerDriverGateway: false, // remote gateway → ineligible
      env: {},
      streamBuild,
      log: () => {},
    });

    expect(streamBuild).not.toHaveBeenCalled();
    expect(result.imageRef).toBeNull();
    expect(result.createArgs).toEqual(baseCreateArgs());
  });

  it("falls back to the openshell build when the local build fails (non-zero exit)", async () => {
    const streamBuild = vi.fn(async () => ({ status: 1, output: "boom" }));
    const result = await prebuildSandboxImageIfEligible({
      buildCtx: CTX,
      createArgs: baseCreateArgs(),
      sandboxName: "alpha",
      dockerDriverGateway: true,
      env: {},
      streamBuild,
      log: () => {},
    });

    expect(streamBuild).toHaveBeenCalledOnce();
    expect(result.imageRef).toBeNull();
    // Original Dockerfile --from preserved so onboarding still builds via openshell.
    expect(result.createArgs).toEqual(baseCreateArgs());
  });

  it("falls back when the build command throws before producing a result", async () => {
    const streamBuild = vi.fn(async () => {
      throw new Error("spawn failed");
    });
    const result = await prebuildSandboxImageIfEligible({
      buildCtx: CTX,
      createArgs: baseCreateArgs(),
      sandboxName: "alpha",
      dockerDriverGateway: true,
      env: {},
      streamBuild,
      log: () => {},
    });

    expect(result.imageRef).toBeNull();
    expect(result.createArgs).toEqual(baseCreateArgs());
  });
});
