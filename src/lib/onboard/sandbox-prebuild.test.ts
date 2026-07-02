// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  buildKitBuildCommand,
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
