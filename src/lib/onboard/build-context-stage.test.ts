// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSandbox as createManagedAgentSandbox } from "../agent/base-image";
import { stageCreateSandboxBuildContext } from "./build-context-stage";
import { CUSTOM_BUILD_CONTEXT_WARN_BYTES } from "./custom-build-context";

const tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function throwingExit(code?: number): never {
  throw new Error(`exit ${code ?? 0}`);
}

function writeFixtureFile(root: string, relativePath: string, contents: string): void {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

function readStagedBytes(root: string): string {
  return fs
    .readdirSync(root, { encoding: "utf8", recursive: true })
    .map((relativePath) => path.join(root, relativePath))
    .filter((entryPath) => fs.statSync(entryPath).isFile())
    .map((entryPath) => fs.readFileSync(entryPath, "utf8"))
    .join("\n");
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
    expect(result.origin).toBe("custom");
    expect(fs.existsSync(path.join(result.buildCtx, "extra.txt"))).toBe(true);
    expect(fs.existsSync(path.join(result.buildCtx, ".ssh"))).toBe(false);
    expect(result.cleanupBuildCtx()).toBe(true);
    expect(fs.existsSync(result.buildCtx)).toBe(false);
  });

  it("stages the managed agent build context when --from targets the agent's own Dockerfile (#7205)", () => {
    const repoRoot = makeTmpDir("nemoclaw-repo-root-");
    const agentDir = path.join(repoRoot, "agents", "hermes");
    fs.mkdirSync(agentDir, { recursive: true });
    const agentDockerfile = path.join(agentDir, "Dockerfile");
    fs.writeFileSync(agentDockerfile, "FROM scratch\nCOPY agents/hermes/plugin/ /opt/plugin/\n");
    const agentBuild = {
      buildCtx: makeTmpDir("nemoclaw-agent-staged-"),
      stagedDockerfile: path.join(os.tmpdir(), "agent.Dockerfile"),
    };
    const createAgentSandbox = vi.fn(() => agentBuild);
    const agent = { name: "hermes", displayName: "Hermes", dockerfilePath: agentDockerfile } as any;
    const logs: string[] = [];

    const result = stageCreateSandboxBuildContext({
      root: repoRoot,
      fromDockerfile: agentDockerfile,
      agent,
      createAgentSandbox,
      log: (message) => logs.push(message),
      exit: throwingExit,
    });

    expect(createAgentSandbox).toHaveBeenCalledWith(agent);
    expect(result.buildCtx).toBe(agentBuild.buildCtx);
    expect(result.origin).toBe("custom");
    expect(logs).toEqual([
      `  Using custom Dockerfile: ${agentDockerfile}`,
      "  This is the managed Hermes Dockerfile; staging the repository root as the Docker build context.",
    ]);
  });

  it("filters checkout credentials from the staged managed repository-root context (#7205)", () => {
    const repoRoot = makeTmpDir("nemoclaw-managed-context-security-");
    const requiredFiles = [
      ["agents/hermes/plugin/entry.py", "required-plugin-bytes"],
      ["src/lib/tool-disclosure.ts", "required-tool-disclosure-bytes"],
      ["scripts/lib/reviewed-npm-archive.mts", "required-script-bytes"],
      ["nemoclaw-blueprint/blueprint.yaml", "required-blueprint-bytes"],
    ] as const;
    const credentialFiles = [
      [".env.local", "forbidden-env-canary"],
      [".ssh/id_ed25519", "forbidden-ssh-canary"],
      [".aws/credentials", "forbidden-aws-canary"],
      [".npmrc", "forbidden-npm-canary"],
      ["secrets/token.txt", "forbidden-secrets-canary"],
      ["certs/client.pem", "forbidden-pem-canary"],
      ["keys/client.key", "forbidden-key-canary"],
    ] as const;
    const agentDockerfile = path.join(repoRoot, "agents", "hermes", "Dockerfile");
    writeFixtureFile(
      repoRoot,
      "agents/hermes/Dockerfile",
      "FROM scratch\nCOPY agents/hermes/plugin/ /opt/plugin/\nCOPY src/ /src/\nCOPY scripts/ /scripts/\nCOPY nemoclaw-blueprint/ /blueprint/\n",
    );
    for (const [relativePath, contents] of [...requiredFiles, ...credentialFiles]) {
      writeFixtureFile(repoRoot, relativePath, contents);
    }
    writeFixtureFile(repoRoot, "ignored-by-repo-rule.txt", "forbidden-dockerignore-canary");
    writeFixtureFile(
      repoRoot,
      ".dockerignore",
      [
        "ignored-by-repo-rule.txt",
        "!.env.local",
        "!.ssh/id_ed25519",
        "!.aws/credentials",
        "!.npmrc",
        "!secrets/token.txt",
        "!certs/client.pem",
        "!keys/client.key",
      ].join("\n"),
    );

    const result = stageCreateSandboxBuildContext({
      root: repoRoot,
      fromDockerfile: agentDockerfile,
      agent: {
        name: "hermes",
        displayName: "Hermes",
        dockerfileBasePath: null,
        dockerfilePath: agentDockerfile,
      } as any,
      createAgentSandbox: (agent) => createManagedAgentSandbox(agent, { rootDir: repoRoot }),
      log: vi.fn(),
      exit: throwingExit,
    });
    tmpDirs.push(result.buildCtx);

    const stagedBytes = readStagedBytes(result.buildCtx);
    for (const [relativePath, contents] of requiredFiles) {
      expect(fs.readFileSync(path.join(result.buildCtx, relativePath), "utf8")).toBe(contents);
    }
    for (const [relativePath, contents] of credentialFiles) {
      expect(fs.existsSync(path.join(result.buildCtx, relativePath))).toBe(false);
      expect(stagedBytes).not.toContain(contents);
    }
    expect(stagedBytes).not.toContain("forbidden-dockerignore-canary");
  });

  it("stages the managed agent build context when --from reaches the agent Dockerfile through a symlink", () => {
    const repoRoot = makeTmpDir("nemoclaw-repo-symlink-");
    const agentDir = path.join(repoRoot, "agents", "hermes");
    fs.mkdirSync(agentDir, { recursive: true });
    const agentDockerfile = path.join(agentDir, "Dockerfile");
    fs.writeFileSync(agentDockerfile, "FROM scratch\n");
    const linkDir = makeTmpDir("nemoclaw-linked-checkout-");
    const linkedDockerfile = path.join(linkDir, "Dockerfile");
    fs.symlinkSync(agentDockerfile, linkedDockerfile);
    const agentBuild = {
      buildCtx: makeTmpDir("nemoclaw-agent-staged-link-"),
      stagedDockerfile: path.join(os.tmpdir(), "agent.Dockerfile"),
    };
    const createAgentSandbox = vi.fn(() => agentBuild);
    const agent = { name: "hermes", displayName: "Hermes", dockerfilePath: agentDockerfile } as any;

    const result = stageCreateSandboxBuildContext({
      root: repoRoot,
      fromDockerfile: linkedDockerfile,
      agent,
      createAgentSandbox,
      log: vi.fn(),
      exit: throwingExit,
    });

    expect(createAgentSandbox).toHaveBeenCalledWith(agent);
    expect(result.buildCtx).toBe(agentBuild.buildCtx);
  });

  it("keeps the parent-directory contract for a standalone Dockerfile when an agent is selected", () => {
    const buildContextDir = makeTmpDir("nemoclaw-standalone-context-");
    const standaloneDockerfile = path.join(buildContextDir, "Dockerfile");
    fs.writeFileSync(standaloneDockerfile, "FROM scratch\n");
    const otherDockerfile = path.join(makeTmpDir("nemoclaw-agent-home-"), "Dockerfile");
    fs.writeFileSync(otherDockerfile, "FROM scratch\n");
    const createAgentSandbox = vi.fn();

    const result = stageCreateSandboxBuildContext({
      root: "/unused",
      fromDockerfile: standaloneDockerfile,
      agent: { name: "hermes", displayName: "Hermes", dockerfilePath: otherDockerfile } as any,
      createAgentSandbox,
      log: vi.fn(),
      exit: throwingExit,
    });
    tmpDirs.push(result.buildCtx);

    expect(createAgentSandbox).not.toHaveBeenCalled();
    expect(result.origin).toBe("custom");
    expect(fs.existsSync(result.stagedDockerfile)).toBe(true);
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
    expect(agentResult.origin).toBe("generated");
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
    expect(defaultResult.origin).toBe("generated");
    expect(stageDefaultSandboxBuildContext).toHaveBeenCalledWith("/repo");
  });
});
