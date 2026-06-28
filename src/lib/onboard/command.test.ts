// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { resolveOnboardOptions, runOnboardCommand } from "./command";
import type { OnboardFlags } from "./command-support";

function exitWithCode(code: number): never {
  throw new Error(`exit:${code}`);
}

function resolve(
  flags: OnboardFlags,
  overrides: Partial<Parameters<typeof resolveOnboardOptions>[1]> = {},
) {
  return resolveOnboardOptions(flags, {
    env: {},
    error: () => {},
    exit: exitWithCode,
    ...overrides,
  });
}

describe("onboard command options", () => {
  it("maps typed oclif flags to onboarding options", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-options-"));
    const dockerfilePath = path.join(tmpDir, "Custom.Dockerfile");
    fs.writeFileSync(dockerfilePath, "FROM scratch\n");

    expect(
      resolve(
        {
          "non-interactive": true,
          resume: true,
          "recreate-sandbox": true,
          from: dockerfilePath,
          name: "second-assistant",
          "sandbox-gpu": true,
          "sandbox-gpu-device": "nvidia.com/gpu=0",
          agent: "dcode",
          "control-ui-port": 18790,
          gpu: true,
          yes: true,
          "no-ollama-autostart": true,
          "yes-i-accept-third-party-software": true,
        },
        { listAgents: () => ["openclaw", "hermes", "langchain-deepagents-code"] },
      ),
    ).toEqual({
      nonInteractive: true,
      resume: true,
      fresh: false,
      recreateSandbox: true,
      fromDockerfile: dockerfilePath,
      sandboxName: "second-assistant",
      sandboxGpu: "enable",
      sandboxGpuDevice: "nvidia.com/gpu=0",
      acceptThirdPartySoftware: true,
      agent: "langchain-deepagents-code",
      agentsManifest: null,
      controlUiPort: 18790,
      gpu: true,
      noGpu: false,
      autoYes: true,
      noOllamaAutostart: true,
    });
  });

  it("uses explicit false/null defaults when flags are absent", () => {
    expect(resolve({})).toEqual({
      nonInteractive: false,
      resume: false,
      fresh: false,
      recreateSandbox: false,
      fromDockerfile: null,
      sandboxName: null,
      sandboxGpu: null,
      sandboxGpuDevice: null,
      acceptThirdPartySoftware: false,
      agent: null,
      agentsManifest: null,
      controlUiPort: null,
      gpu: false,
      noGpu: false,
      autoYes: false,
      noOllamaAutostart: false,
    });
  });

  it("accepts the environment-based third-party notice acknowledgement", () => {
    expect(
      resolve({}, { env: { NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1" } }).acceptThirdPartySoftware,
    ).toBe(true);
  });

  it("preserves the requested Dockerfile path after validating the resolved file", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-from-"));
    const dockerfilePath = path.join(tmpDir, "Custom.Dockerfile");
    fs.writeFileSync(dockerfilePath, "FROM scratch\n");
    const relativeDockerfilePath = path.relative(process.cwd(), dockerfilePath);

    expect(resolve({ from: relativeDockerfilePath }).fromDockerfile).toBe(relativeDockerfilePath);
  });

  it("rejects missing and non-file Dockerfile paths before onboarding", () => {
    const errors: string[] = [];
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-from-errors-"));
    const deps = { error: (message = "") => errors.push(message) };

    expect(() => resolve({ from: path.join(tmpDir, "missing") }, deps)).toThrow("exit:1");
    expect(errors.join("\n")).toContain("--from path not found:");

    errors.length = 0;
    expect(() => resolve({ from: tmpDir }, deps)).toThrow("exit:1");
    expect(errors.join("\n")).toContain("--from must point to a Dockerfile:");
  });

  it("canonicalizes known agent aliases", () => {
    const listAgents = () => ["openclaw", "hermes", "langchain-deepagents-code"];
    expect(resolve({ agent: "dcode" }, { listAgents }).agent).toBe("langchain-deepagents-code");
    expect(resolve({ agent: "nemohermes" }, { listAgents }).agent).toBe("hermes");
  });

  it("rejects unknown agents with the available aliases", () => {
    const errors: string[] = [];
    expect(() =>
      resolve(
        { agent: "bogus" },
        {
          listAgents: () => ["openclaw", "hermes"],
          error: (message = "") => errors.push(message),
        },
      ),
    ).toThrow("exit:1");
    expect(errors.join("\n")).toContain("Unknown agent 'bogus'");
    expect(errors.join("\n")).toContain("aliases: nemohermes → hermes");
  });

  it("runs onboard with resolved options", async () => {
    const runOnboard = vi.fn(async () => {});
    await runOnboardCommand({
      flags: { resume: true },
      env: {},
      runOnboard,
      error: () => {},
      exit: exitWithCode,
    });

    expect(runOnboard).toHaveBeenCalledWith(expect.objectContaining({ resume: true }));
  });

  it("sets the Ollama autostart override before onboarding", async () => {
    const previous = process.env.NEMOCLAW_OLLAMA_NO_AUTOSTART;
    delete process.env.NEMOCLAW_OLLAMA_NO_AUTOSTART;
    const restoreEnvironment =
      previous === undefined
        ? () => delete process.env.NEMOCLAW_OLLAMA_NO_AUTOSTART
        : () => {
            process.env.NEMOCLAW_OLLAMA_NO_AUTOSTART = previous;
          };
    let observed: string | undefined;
    try {
      await runOnboardCommand({
        flags: { "no-ollama-autostart": true },
        env: {},
        runOnboard: async () => {
          observed = process.env.NEMOCLAW_OLLAMA_NO_AUTOSTART;
        },
      });
      expect(observed).toBe("1");
    } finally {
      restoreEnvironment();
    }
  });
});
