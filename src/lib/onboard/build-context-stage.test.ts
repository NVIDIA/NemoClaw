// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CUSTOM_BUILD_CONTEXT_WARN_BYTES } from "../../../dist/lib/onboard/custom-build-context";
import { stageCreateSandboxBuildContext } from "../../../dist/lib/onboard/build-context-stage";

const tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function throwingExit(code?: number): never {
  throw new Error(`exit ${code ?? 0}`);
}

describe("stageCreateSandboxBuildContext", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stages a custom Dockerfile context, filters ignored entries, and returns cleanup", () => {
    const buildContextDir = makeTmpDir("nemoclaw-custom-context-");
    const customDockerfile = path.join(buildContextDir, "Containerfile");
    fs.writeFileSync(customDockerfile, "FROM scratch\n");
    fs.writeFileSync(path.join(buildContextDir, "extra.txt"), "included\n");
    fs.mkdirSync(path.join(buildContextDir, ".ssh"));
    fs.writeFileSync(path.join(buildContextDir, ".ssh", "id_rsa"), "secret\n");
    const logs: string[] = [];

    const result = stageCreateSandboxBuildContext({
      root: "/unused",
      fromDockerfile: customDockerfile,
      agent: null,
      createAgentSandbox: vi.fn(),
      log: (message) => logs.push(message),
      exit: throwingExit,
    });
    tmpDirs.push(result.buildCtx);

    expect(logs).toEqual([
      `  Using custom Dockerfile: ${customDockerfile}`,
      `  Docker build context: ${buildContextDir}`,
    ]);
    expect(fs.readFileSync(result.stagedDockerfile, "utf-8")).toBe("FROM scratch\n");
    expect(fs.existsSync(path.join(result.buildCtx, "extra.txt"))).toBe(true);
    expect(fs.existsSync(path.join(result.buildCtx, ".ssh"))).toBe(false);
    expect(result.cleanupBuildCtx()).toBe(true);
    expect(fs.existsSync(result.buildCtx)).toBe(false);
  });

  it("exits when the custom Dockerfile path is missing", () => {
    const errors: string[] = [];
    const missingDockerfile = path.join(makeTmpDir("nemoclaw-missing-context-"), "Dockerfile");

    expect(() =>
      stageCreateSandboxBuildContext({
        root: "/unused",
        fromDockerfile: missingDockerfile,
        agent: null,
        createAgentSandbox: vi.fn(),
        error: (message) => errors.push(message),
        exit: throwingExit,
      }),
    ).toThrow("exit 1");

    expect(errors).toEqual([`  Custom Dockerfile not found: ${missingDockerfile}`]);
  });

  it("exits when the custom Dockerfile path is a directory", () => {
    const errors: string[] = [];
    const dockerfileDir = path.join(makeTmpDir("nemoclaw-dir-context-"), "Dockerfile");
    fs.mkdirSync(dockerfileDir);

    expect(() =>
      stageCreateSandboxBuildContext({
        root: "/unused",
        fromDockerfile: dockerfileDir,
        agent: null,
        createAgentSandbox: vi.fn(),
        error: (message) => errors.push(message),
        exit: throwingExit,
      }),
    ).toThrow("exit 1");

    expect(errors).toEqual([`  Custom Dockerfile path is not a file: ${dockerfileDir}`]);
  });

  it("exits when the custom Dockerfile is inside an ignored build-context path", () => {
    const errors: string[] = [];
    const ignoredContextDir = path.join(makeTmpDir("nemoclaw-ignored-context-"), ".ssh");
    fs.mkdirSync(ignoredContextDir);
    const ignoredDockerfile = path.join(ignoredContextDir, "Dockerfile");
    fs.writeFileSync(ignoredDockerfile, "FROM scratch\n");

    expect(() =>
      stageCreateSandboxBuildContext({
        root: "/unused",
        fromDockerfile: ignoredDockerfile,
        agent: null,
        createAgentSandbox: vi.fn(),
        error: (message) => errors.push(message),
        exit: throwingExit,
      }),
    ).toThrow("exit 1");

    expect(errors).toEqual([
      `  Custom Dockerfile is inside an ignored build-context path: ${ignoredContextDir}`,
      "  Move your Dockerfile to a dedicated directory and retry.",
    ]);
  });

  it("warns when the custom Dockerfile build context is large", () => {
    const buildContextDir = makeTmpDir("nemoclaw-large-context-");
    const dockerfile = path.join(buildContextDir, "Dockerfile");
    const largeFile = path.join(buildContextDir, "large.bin");
    fs.writeFileSync(dockerfile, "FROM scratch\n");
    fs.closeSync(fs.openSync(largeFile, "w"));
    fs.truncateSync(largeFile, CUSTOM_BUILD_CONTEXT_WARN_BYTES + 1);
    const warnings: string[] = [];

    const result = stageCreateSandboxBuildContext({
      root: "/unused",
      fromDockerfile: dockerfile,
      agent: null,
      createAgentSandbox: vi.fn(),
      log: vi.fn(),
      warn: (message) => warnings.push(message),
      exit: throwingExit,
    });
    tmpDirs.push(result.buildCtx);

    expect(warnings).toEqual([
      "  WARN: build context contains about 100.0 MB across 2 files.",
      "  The --from flag sends the Dockerfile's parent directory to Docker; use a dedicated directory if this is not intentional.",
    ]);
  });

  it("cleans up the temporary build context when copying fails with EACCES", () => {
    const buildContextDir = makeTmpDir("nemoclaw-eacces-context-");
    const dockerfile = path.join(buildContextDir, "Dockerfile");
    fs.writeFileSync(dockerfile, "FROM scratch\n");
    const stagedBuildCtx = makeTmpDir("nemoclaw-staged-eacces-");
    const errors: string[] = [];
    vi.spyOn(fs, "mkdtempSync").mockReturnValueOnce(stagedBuildCtx);
    vi.spyOn(fs, "cpSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    });

    expect(() =>
      stageCreateSandboxBuildContext({
        root: "/unused",
        fromDockerfile: dockerfile,
        agent: null,
        createAgentSandbox: vi.fn(),
        log: vi.fn(),
        error: (message) => errors.push(message),
        exit: throwingExit,
      }),
    ).toThrow("exit 1");

    expect(errors).toEqual([
      `  Permission denied while copying build context from: ${buildContextDir}`,
      "  The --from flag uses the Dockerfile's parent directory as the Docker build context.",
      "  Move your Dockerfile to a dedicated directory and retry.",
    ]);
    expect(fs.existsSync(stagedBuildCtx)).toBe(false);
  });

  it("delegates to agent or default build-context staging when no custom Dockerfile is supplied", () => {
    const agentBuild = {
      buildCtx: makeTmpDir("nemoclaw-agent-build-"),
      stagedDockerfile: path.join(os.tmpdir(), "agent.Dockerfile"),
    };
    const defaultBuild = {
      buildCtx: makeTmpDir("nemoclaw-default-build-"),
      stagedDockerfile: path.join(os.tmpdir(), "default.Dockerfile"),
    };
    const createAgentSandbox = vi.fn(() => agentBuild);
    const stageDefaultSandboxBuildContext = vi.fn(() => defaultBuild);

    const agentResult = stageCreateSandboxBuildContext({
      root: "/repo",
      fromDockerfile: null,
      agent: { name: "hermes" } as any,
      createAgentSandbox,
      stageDefaultSandboxBuildContext,
    });

    expect(agentResult.buildCtx).toBe(agentBuild.buildCtx);
    expect(createAgentSandbox).toHaveBeenCalledWith({ name: "hermes" });
    expect(stageDefaultSandboxBuildContext).not.toHaveBeenCalled();

    const defaultResult = stageCreateSandboxBuildContext({
      root: "/repo",
      fromDockerfile: null,
      agent: null,
      createAgentSandbox,
      stageDefaultSandboxBuildContext,
    });

    expect(defaultResult.buildCtx).toBe(defaultBuild.buildCtx);
    expect(stageDefaultSandboxBuildContext).toHaveBeenCalledWith("/repo");
  });
});
