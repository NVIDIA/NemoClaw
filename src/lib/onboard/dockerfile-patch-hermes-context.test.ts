// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Closes the onboard loop for #6177: once the compatible-endpoint probe sets
// NEMOCLAW_CONTEXT_WINDOW, dockerfile-patch must rewrite the Hermes Dockerfile's
// ARG so the baked value reaches build-env/config generation. This stages the
// real agents/hermes/Dockerfile so a future ARG rename cannot silently regress.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { patchStagedDockerfile } from "./dockerfile-patch";

const HERMES_DOCKERFILE = path.join(import.meta.dirname, "../../../agents/hermes/Dockerfile");
const tmpRoots: string[] = [];

function stageHermesDockerfile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-ctx-patch-"));
  tmpRoots.push(dir);
  const file = path.join(dir, "Dockerfile");
  fs.copyFileSync(HERMES_DOCKERFILE, file);
  return file;
}

function contextWindowArg(dockerfilePath: string): string | undefined {
  return fs
    .readFileSync(dockerfilePath, "utf8")
    .split("\n")
    .find((line) => line.startsWith("ARG NEMOCLAW_CONTEXT_WINDOW="));
}

function patchHermes(dockerfilePath: string): void {
  patchStagedDockerfile(
    dockerfilePath,
    "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4",
    "http://127.0.0.1:18789",
    "build-hermes-context",
    "compatible-endpoint",
    "openai-completions",
  );
}

// Each test controls NEMOCLAW_CONTEXT_WINDOW via vi.stubEnv, and afterEach
// restores the real environment through vi.unstubAllEnvs (no manual delete,
// no branching — keeps the file within the changed-test-file if-statement guard).
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tmpRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("patchStagedDockerfile :: Hermes NEMOCLAW_CONTEXT_WINDOW (#6177)", () => {
  it("declares an empty context-window ARG that defaults to Hermes auto-detect", () => {
    expect(contextWindowArg(HERMES_DOCKERFILE)).toBe("ARG NEMOCLAW_CONTEXT_WINDOW=");
  });

  it("bakes a probed/explicit context window into the staged Hermes Dockerfile", () => {
    const dockerfilePath = stageHermesDockerfile();
    vi.stubEnv("NEMOCLAW_CONTEXT_WINDOW", "65536");
    patchHermes(dockerfilePath);
    expect(contextWindowArg(dockerfilePath)).toBe("ARG NEMOCLAW_CONTEXT_WINDOW=65536");
  });

  it("leaves the empty default when no context window is configured", () => {
    const dockerfilePath = stageHermesDockerfile();
    vi.stubEnv("NEMOCLAW_CONTEXT_WINDOW", "");
    patchHermes(dockerfilePath);
    expect(contextWindowArg(dockerfilePath)).toBe("ARG NEMOCLAW_CONTEXT_WINDOW=");
  });

  it("ignores a malformed context window and preserves auto-detect", () => {
    const dockerfilePath = stageHermesDockerfile();
    vi.stubEnv("NEMOCLAW_CONTEXT_WINDOW", "not-a-number");
    patchHermes(dockerfilePath);
    expect(contextWindowArg(dockerfilePath)).toBe("ARG NEMOCLAW_CONTEXT_WINDOW=");
  });

  it("ignores an over-ceiling context window instead of baking an implausible value (#6293)", () => {
    const dockerfilePath = stageHermesDockerfile();
    vi.stubEnv("NEMOCLAW_CONTEXT_WINDOW", "9999999999");
    patchHermes(dockerfilePath);
    expect(contextWindowArg(dockerfilePath)).toBe("ARG NEMOCLAW_CONTEXT_WINDOW=");
  });
});
