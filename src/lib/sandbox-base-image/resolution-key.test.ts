// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dockerMocks = vi.hoisted(() => ({
  infoFormat: vi.fn(),
}));

vi.mock("../adapters/docker", () => ({
  dockerInfoFormat: dockerMocks.infoFormat,
}));

import { createSandboxBaseImageResolutionKey } from "./resolution-key";

const roots: string[] = [];

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-resolution-key-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "nemoclaw-blueprint"), { recursive: true });
  fs.writeFileSync(path.join(root, "Dockerfile.base"), "FROM node:22\n");
  fs.writeFileSync(path.join(root, "nemoclaw-blueprint", "blueprint.yaml"), "version: 1\n");
  return root;
}

function options(root: string) {
  return {
    imageName: "ghcr.io/nvidia/nemoclaw/sandbox-base",
    dockerfilePath: path.join(root, "Dockerfile.base"),
    localTag: "nemoclaw-sandbox-base-local:test",
    rootDir: root,
    env: { GITHUB_SHA: "1234567890abcdef1234567890abcdef12345678" },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  dockerMocks.infoFormat.mockReturnValue("linux/amd64\n");
});

describe("sandbox base-image resolution key", () => {
  it("changes when a relevant base input changes (#4680)", () => {
    const root = fixture();
    const before = createSandboxBaseImageResolutionKey(options(root));
    fs.writeFileSync(path.join(root, "Dockerfile.base"), "FROM node:22\nRUN echo changed\n");
    expect(createSandboxBaseImageResolutionKey(options(root))).not.toBe(before);
  });

  it("changes when an agent-specific dependency lock changes (#6456)", () => {
    const root = fixture();
    const lockfile = path.join(root, "agents", "langchain-deepagents-code", "requirements.lock");
    fs.mkdirSync(path.dirname(lockfile), { recursive: true });
    fs.writeFileSync(lockfile, "deepagents-code==0.1.34\n");
    const keyedOptions = { ...options(root), inputPaths: [lockfile] };
    const before = createSandboxBaseImageResolutionKey(keyedOptions);

    fs.writeFileSync(lockfile, "deepagents-code==0.1.34\ntransitive-dependency==2.0.0\n");

    expect(createSandboxBaseImageResolutionKey(keyedOptions)).not.toBe(before);
  });

  it("isolates explicit base-image overrides (#4680)", () => {
    const root = fixture();
    const base = { ...options(root), envVar: "NEMOCLAW_SANDBOX_BASE_IMAGE_REF" };
    const first = createSandboxBaseImageResolutionKey({
      ...base,
      env: { ...base.env, NEMOCLAW_SANDBOX_BASE_IMAGE_REF: "example/base@sha256:first" },
    });
    const second = createSandboxBaseImageResolutionKey({
      ...base,
      env: { ...base.env, NEMOCLAW_SANDBOX_BASE_IMAGE_REF: "example/base@sha256:second" },
    });
    expect(second).not.toBe(first);
  });

  it("isolates custom runtime validation requirements (#4680)", () => {
    const root = fixture();
    const base = options(root);

    const mcpKey = createSandboxBaseImageResolutionKey({
      ...base,
      validationDescription: "the native MCP Streamable HTTP runtime",
    });
    const legacyKey = createSandboxBaseImageResolutionKey({
      ...base,
      validationDescription: "the legacy MCP runtime",
    });

    expect(legacyKey).not.toBe(mcpKey);
  });

  it("isolates Dockerfile-pinned remote references (#4680)", () => {
    const root = fixture();
    const base = options(root);

    const first = createSandboxBaseImageResolutionKey({
      ...base,
      pinnedRemoteRef: "example/base@sha256:first",
    });
    const second = createSandboxBaseImageResolutionKey({
      ...base,
      pinnedRemoteRef: "example/base@sha256:second",
    });

    expect(second).not.toBe(first);
  });

  it("isolates pinned-first resolution policy", () => {
    const root = fixture();
    const base = {
      ...options(root),
      pinnedRemoteRef: "example/base@sha256:first",
    };

    expect(createSandboxBaseImageResolutionKey({ ...base, preferPinnedRemoteRef: true })).not.toBe(
      createSandboxBaseImageResolutionKey(base),
    );
  });

  it("keeps an explicit false policy compatible with callers that omit it", () => {
    const root = fixture();
    const base = options(root);

    expect(createSandboxBaseImageResolutionKey({ ...base, preferPinnedRemoteRef: false })).toBe(
      createSandboxBaseImageResolutionKey(base),
    );
  });

  it("bounds Docker platform detection before using the host fallback (#4680)", () => {
    const root = fixture();
    dockerMocks.infoFormat.mockReturnValue("");

    const fallbackKey = createSandboxBaseImageResolutionKey(options(root));
    dockerMocks.infoFormat.mockReturnValue(`${process.platform}/${process.arch}`);
    const explicitHostKey = createSandboxBaseImageResolutionKey(options(root));

    expect(fallbackKey).toBe(explicitHostKey);
    expect(dockerMocks.infoFormat).toHaveBeenCalledTimes(2);
    expect(dockerMocks.infoFormat).toHaveBeenCalledWith("{{.OSType}}/{{.Architecture}}", {
      ignoreError: true,
      timeout: 2_000,
    });
  });
});
