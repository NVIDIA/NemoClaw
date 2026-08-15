// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentDefinition } from "../agent/defs";
import { SandboxBaseImageResolutionError } from "../sandbox-base-image";
import {
  type PrepareSandboxDockerfilePatchInput,
  prepareSandboxDockerfilePatch,
} from "./sandbox-dockerfile-patch-flow";
import type { SandboxGpuConfig } from "./sandbox-gpu-mode";

vi.mock("../inference/config", () => ({
  getSandboxInferenceConfig: (model: string) => ({
    providerKey: "inference",
    primaryModelRef: `inference/${model}`,
    inferenceBaseUrl: "https://inference.local",
    inferenceApi: "openai-completions",
    inferenceCompat: null,
  }),
}));

const sandboxGpuConfig: SandboxGpuConfig = {
  mode: "auto",
  hostGpuDetected: false,
  hostGpuPlatform: null,
  sandboxGpuEnabled: false,
  sandboxGpuDevice: null,
  errors: [],
};

const baseInput: Omit<PrepareSandboxDockerfilePatchInput, "deps"> = {
  agent: null,
  fromDockerfile: null,
  sandboxBaseImage: "ghcr.io/nvidia/nemoclaw/sandbox-base",
  sandboxBaseTag: "latest",
  stagedDockerfile: "/tmp/Dockerfile",
  model: "model-a",
  chatUiUrl: "http://127.0.0.1:7000",
  provider: null,
  preferredInferenceApi: null,
  webSearchConfig: null,
  hermesToolGateways: [],
  sandboxGpuConfig,
};

const dcodeAgent = { name: "langchain-deepagents-code" } as AgentDefinition;
const tempRoots: string[] = [];

function stagedDcodeDockerfile(): { path: string; source: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-provider-patch-"));
  tempRoots.push(directory);
  const dockerfilePath = path.join(directory, "Dockerfile");
  const source = "ARG NEMOCLAW_UPSTREAM_PROVIDER=old\n";
  fs.writeFileSync(dockerfilePath, source, "utf8");
  return { path: dockerfilePath, source };
}

afterEach(() => {
  for (const directory of tempRoots.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("prepareSandboxDockerfilePatch fail-closed base-image resolution", () => {
  it("propagates changed-input resolution errors without cached-latest fallback (#4680)", async () => {
    const resolutionError = new SandboxBaseImageResolutionError("changed inputs not rebuilt");
    const dockerImageInspect = vi.fn();
    const patchStagedDockerfile = vi.fn();

    await expect(
      prepareSandboxDockerfilePatch({
        ...baseInput,
        deps: {
          isLinuxDockerDriverGatewayEnabled: vi.fn(() => false),
          pullAndResolveBaseImageDigest: vi.fn(() => {
            throw resolutionError;
          }),
          dockerImageInspect,
          enforceDockerGpuPatchPreserveNetwork: vi.fn(async () => false),
          patchStagedDockerfile,
        },
      }),
    ).rejects.toBe(resolutionError);

    expect(dockerImageInspect).not.toHaveBeenCalled();
    expect(patchStagedDockerfile).not.toHaveBeenCalled();
  });

  it("rejects an unproven cached latest image when the OpenShell ABI is required (#4680)", async () => {
    const dockerImageInspect = vi.fn(() => ({ status: 0 }));
    const patchStagedDockerfile = vi.fn();

    await expect(
      prepareSandboxDockerfilePatch({
        ...baseInput,
        deps: {
          isLinuxDockerDriverGatewayEnabled: vi.fn(() => true),
          pullAndResolveBaseImageDigest: vi.fn(() => null),
          dockerImageInspect,
          enforceDockerGpuPatchPreserveNetwork: vi.fn(async () => false),
          patchStagedDockerfile,
        },
      }),
    ).rejects.toThrow(
      "No OpenShell ABI-compatible sandbox base image could be resolved. " +
        "Refusing to fall back to an unvalidated cached :latest image.",
    );

    expect(dockerImageInspect).not.toHaveBeenCalled();
    expect(patchStagedDockerfile).not.toHaveBeenCalled();
  });
});

describe("prepareSandboxDockerfilePatch DCode provider input", () => {
  const deps = {
    enforceDockerGpuPatchPreserveNetwork: vi.fn(async () => false),
    isLinuxDockerDriverGatewayEnabled: vi.fn(() => false),
    now: vi.fn(() => 1),
  };

  it.each(["-provider", "provider/name", "café", `a${"b".repeat(64)}`])(
    "rejects provider %s before changing the legacy Dockerfile (#7112)",
    async (provider) => {
      const dockerfile = stagedDcodeDockerfile();

      await expect(
        prepareSandboxDockerfilePatch({
          ...baseInput,
          agent: dcodeAgent,
          stagedDockerfile: dockerfile.path,
          provider,
          deps,
        }),
      ).rejects.toThrow(
        "NEMOCLAW_UPSTREAM_PROVIDER must start with an ASCII letter or digit and contain 1-64 ASCII letters, digits, dots, underscores, or hyphens for DCode.",
      );
      expect(fs.readFileSync(dockerfile.path, "utf8")).toBe(dockerfile.source);
    },
  );

  it("validates the managed inference provider fallback before changing the legacy Dockerfile (#7112)", async () => {
    const dockerfile = stagedDcodeDockerfile();

    await prepareSandboxDockerfilePatch({
      ...baseInput,
      agent: dcodeAgent,
      stagedDockerfile: dockerfile.path,
      deps,
    });

    const patched = fs.readFileSync(dockerfile.path, "utf8");
    expect(patched).toContain("ARG NEMOCLAW_UPSTREAM_PROVIDER=inference");
    expect(patched).not.toContain("ARG NEMOCLAW_UPSTREAM_PROVIDER=old");
  });
});
