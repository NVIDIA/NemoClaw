// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

const requireSource = createRequire(import.meta.url);
const SHIELDS_MODULE = "./index.js";
const TRANSITION_LOCK_MODULE = "./transition-lock.js";

describe("shields policy transition", () => {
  let homeDir: string;
  let runSpy: MockInstance;
  let runCaptureSpy: MockInstance;
  let shields: typeof import("./index.js");

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-shields-policy-transition-"));
    vi.stubEnv("HOME", homeDir);
    delete require.cache[requireSource.resolve(SHIELDS_MODULE)];
    delete require.cache[requireSource.resolve(TRANSITION_LOCK_MODULE)];

    const runner = requireSource("../runner.js");
    const sandboxConfig = requireSource("../sandbox/config.js");
    vi.spyOn(runner, "validateName").mockImplementation((name: unknown) => String(name));
    runSpy = vi.spyOn(runner, "run").mockReturnValue({ status: 0 });
    runCaptureSpy = vi.spyOn(runner, "runCapture").mockImplementation(() => {
      throw new Error("policy get failed with status 42");
    });
    vi.spyOn(sandboxConfig, "resolveAgentConfig").mockReturnValue({
      agentName: "langchain-deepagents-code",
      configDir: "/sandbox/.deepagents",
      configFile: "config.json",
      configPath: "/sandbox/.deepagents/config.json",
      format: "json",
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    shields = requireSource(SHIELDS_MODULE);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    delete require.cache[requireSource.resolve(SHIELDS_MODULE)];
    delete require.cache[requireSource.resolve(TRANSITION_LOCK_MODULE)];
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("never relaxes policy or persists mutable state when the base-policy read fails", () => {
    expect(() => shields.shieldsDown("openclaw", { skipTimer: true, throwOnError: true })).toThrow(
      "Cannot capture current policy",
    );
    expect(runSpy).not.toHaveBeenCalled();

    const stateFiles = fs.readdirSync(path.join(homeDir, ".nemoclaw", "state"));
    expect(stateFiles.filter((name) => /^(policy-snapshot-|shields-openclaw)/.test(name))).toEqual(
      [],
    );
  });

  it.each([
    ["message", "message: gateway unavailable"],
    ["details", "details: grpc unavailable"],
    ["arbitrary diagnostic", "reason: gateway unavailable\nretryable: true"],
  ])("never relaxes policy or persists mutable state for exit-zero %s output", (_name, output) => {
    runCaptureSpy.mockReturnValue(output);

    expect(() => shields.shieldsDown("openclaw", { skipTimer: true, throwOnError: true })).toThrow(
      "Cannot capture current policy",
    );
    expect(runSpy).not.toHaveBeenCalled();

    const stateFiles = fs.readdirSync(path.join(homeDir, ".nemoclaw", "state"));
    expect(stateFiles.filter((name) => /^(policy-snapshot-|shields-openclaw)/.test(name))).toEqual(
      [],
    );
  });
});
