// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveOnboardOptions, runOnboardCommand } from "./command";
import type { OnboardFlags } from "./command-support";
import { invalidGatewayManagementDeclarationError } from "./gateway-management";
import { GatewayAuthorityError } from "./gateway-teardown-authority";

afterEach(() => {
  vi.unstubAllEnvs();
});

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

// Recreation is selected three ways and only the first sets the flag that
// `resolveOnboardOptions` records: the explicit flag, NEMOCLAW_RECREATE_SANDBOX
// read inside `runOnboard`, and drift detected mid-run. All three reach the same
// recreate journal, so all three must report an authority refusal (#8103).
const RECREATE_SELECTIONS: [string, OnboardFlags, Record<string, string>][] = [
  ["the explicit --recreate-sandbox flag", { "recreate-sandbox": true }, {}],
  ["NEMOCLAW_RECREATE_SANDBOX without the flag", {}, { NEMOCLAW_RECREATE_SANDBOX: "1" }],
  ["drift detected with neither the flag nor the environment request", {}, {}],
];

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
          "tool-disclosure": "direct",
          observability: true,
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
      toolDisclosure: "direct",
      observabilityEnabled: true,
      controlUiPort: 18790,
      gpu: true,
      noGpu: false,
      autoYes: true,
      noOllamaAutostart: true,
      experimentalProfile: null,
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
      toolDisclosure: null,
      observabilityEnabled: null,
      controlUiPort: null,
      gpu: false,
      noGpu: false,
      autoYes: false,
      noOllamaAutostart: false,
      experimentalProfile: null,
    });
  });

  it("resolves the portable profile to deterministic unattended defaults", () => {
    expect(resolve({ "experimental-profile": "portable" })).toMatchObject({
      experimentalProfile: "portable",
      nonInteractive: true,
      fresh: true,
      autoYes: true,
      noOllamaAutostart: true,
      noGpu: false,
      sandboxGpu: null,
    });
  });

  it("rejects resume when the portable profile requires a deterministic fresh install", () => {
    const errors: string[] = [];
    expect(() =>
      resolve(
        { "experimental-profile": "portable", resume: true },
        { error: (message = "") => errors.push(message) },
      ),
    ).toThrow("exit:1");
    expect(errors).toContain("  --resume cannot be combined with --experimental-profile portable.");
  });

  it("maps --no-observability to an explicit disabled request", () => {
    expect(
      resolve(
        { agent: "dcode", observability: false },
        { listAgents: () => ["openclaw", "hermes", "langchain-deepagents-code"] },
      ).observabilityEnabled,
    ).toBe(false);
  });

  it("accepts the environment-based third-party notice acknowledgement", () => {
    expect(
      resolve({}, { env: { NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1" } }).acceptThirdPartySoftware,
    ).toBe(true);
  });

  it("uses the agent-neutral tool-disclosure env and rejects unknown values", () => {
    expect(resolve({}, { env: { NEMOCLAW_TOOL_DISCLOSURE: " DIRECT " } }).toolDisclosure).toBe(
      "direct",
    );
    const errors: string[] = [];
    expect(() =>
      resolve(
        {},
        {
          env: { NEMOCLAW_TOOL_DISCLOSURE: "sometimes" },
          error: (message = "") => errors.push(message),
        },
      ),
    ).toThrow("exit:1");
    expect(errors.join("\n")).toContain("must be one of: progressive, direct");
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

  it("rejects observability for an explicitly unsupported agent", () => {
    const errors: string[] = [];
    expect(() =>
      resolve(
        { agent: "hermes", observability: true },
        {
          listAgents: () => ["openclaw", "hermes", "langchain-deepagents-code"],
          error: (message = "") => errors.push(message),
        },
      ),
    ).toThrow("exit:1");
    expect(errors.join("\n")).toContain(
      "--observability is supported only with --agent langchain-deepagents-code",
    );
  });

  it("allows an explicit observability opt-out while selecting another agent", () => {
    expect(
      resolve(
        { agent: "hermes", observability: false },
        { listAgents: () => ["openclaw", "hermes", "langchain-deepagents-code"] },
      ).observabilityEnabled,
    ).toBe(false);
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

  it("rejects an unknown NEMOCLAW_AGENT cleanly instead of throwing uncaught (#5972)", () => {
    // #5972: an unknown NEMOCLAW_AGENT must fail via the clean error/exit path,
    // matching --agent, not by throwing uncaught deep in runOnboard.
    const errors: string[] = [];
    expect(() =>
      resolve(
        {},
        {
          env: { NEMOCLAW_AGENT: "bogus-agent" },
          listAgents: () => ["openclaw", "hermes"],
          error: (message = "") => errors.push(message),
        },
      ),
    ).toThrow("exit:1");
    expect(errors.join("\n")).toContain("Unknown agent 'bogus-agent' (from NEMOCLAW_AGENT)");
    expect(errors.join("\n")).toContain("aliases: nemohermes → hermes");
  });

  it("accepts a valid NEMOCLAW_AGENT (and its aliases) without forcing the flag value", () => {
    const listAgents = () => ["openclaw", "hermes", "langchain-deepagents-code"];
    // Valid env agents resolve downstream, so resolveAgent leaves `agent` null.
    expect(resolve({}, { env: { NEMOCLAW_AGENT: "hermes" }, listAgents }).agent).toBeNull();
    expect(resolve({}, { env: { NEMOCLAW_AGENT: "nemohermes" }, listAgents }).agent).toBeNull();
    expect(resolve({}, { env: {}, listAgents }).agent).toBeNull();
  });

  it("prefers the --agent flag over NEMOCLAW_AGENT for validation", () => {
    const listAgents = () => ["openclaw", "hermes"];
    // Flag is valid even when the env var is bogus — flag takes precedence.
    expect(
      resolve({ agent: "hermes" }, { env: { NEMOCLAW_AGENT: "bogus" }, listAgents }).agent,
    ).toBe("hermes");
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

  it("prepares and scopes portable profile defaults around onboarding", async () => {
    vi.stubEnv("NEMOCLAW_EXPERIMENTAL_PROFILE", "previous-profile");
    vi.stubEnv("NEMOCLAW_PROVIDER", "previous-provider");
    vi.stubEnv("NEMOCLAW_MODEL", "previous-model");
    vi.stubEnv("NEMOCLAW_OLLAMA_NO_AUTOSTART", "0");
    const observed: Record<string, string | undefined> = {};
    await runOnboardCommand({
      flags: { "experimental-profile": "portable" },
      env: {},
      runOnboard: async () => {
        for (const key of [
          "NEMOCLAW_EXPERIMENTAL_PROFILE",
          "NEMOCLAW_PROVIDER",
          "NEMOCLAW_MODEL",
          "NEMOCLAW_OLLAMA_NO_AUTOSTART",
        ]) {
          observed[key] = process.env[key];
        }
      },
    });

    expect(observed).toEqual({
      NEMOCLAW_EXPERIMENTAL_PROFILE: "portable",
      NEMOCLAW_PROVIDER: "ollama",
      NEMOCLAW_MODEL: "qwen3-vl:4b",
      NEMOCLAW_OLLAMA_NO_AUTOSTART: "1",
    });
    expect(process.env).toMatchObject({
      NEMOCLAW_EXPERIMENTAL_PROFILE: "previous-profile",
      NEMOCLAW_PROVIDER: "previous-provider",
      NEMOCLAW_MODEL: "previous-model",
      NEMOCLAW_OLLAMA_NO_AUTOSTART: "0",
    });
  });

  it("treats a prompt EOF during onboarding as cancellation and exits non-zero (#5976)", async () => {
    const errors: string[] = [];
    await expect(
      runOnboardCommand({
        flags: {},
        env: {},
        runOnboard: async () => {
          throw Object.assign(new Error("Prompt closed before input"), { code: "EOF" });
        },
        error: (message = "") => errors.push(message),
        exit: exitWithCode,
      }),
    ).rejects.toThrow("exit:1");
    expect(errors.join("\n")).toContain("Installation cancelled");
  });

  it("prints a clean CLI error for an invalid gateway management contract (#7627)", async () => {
    const errors: string[] = [];
    await expect(
      runOnboardCommand({
        flags: {},
        env: {},
        runOnboard: async () => {
          throw invalidGatewayManagementDeclarationError(
            "unsupported gateway-management contract version; this NemoClaw build supports version 1",
          );
        },
        error: (message = "") => errors.push(message),
        exit: exitWithCode,
      }),
    ).rejects.toThrow("exit:1");
    const output = errors.join("\n");
    expect(output).toContain("Invalid gateway management declaration");
    expect(output).toContain("unsupported gateway-management contract version");
    // No stack frames leaked into the user-facing output.
    expect(output).not.toContain(".js:");
    expect(output).not.toContain("    at ");
  });

  it.each(
    RECREATE_SELECTIONS,
  )("reports a gateway authority refusal when recreation is selected by %s (#8103)", async (_selection, flags, env) => {
    const errors: string[] = [];
    await expect(
      runOnboardCommand({
        flags,
        env,
        runOnboard: async () => {
          throw new GatewayAuthorityError(
            "Gateway lifecycle authority changed since onboarding (packaged-service -> standalone).",
          );
        },
        error: (message = "") => errors.push(message),
        exit: exitWithCode,
      }),
    ).rejects.toThrow("exit:1");

    const output = errors.join("\n");
    expect(output).toContain(
      "Refusing sandbox recreate because the gateway lifecycle authority could not be revalidated.",
    );
    expect(output).toContain("packaged-service -> standalone");
    expect(output).toContain("Re-run onboarding to bind the current gateway authority");
    expect(output).not.toContain(".js:");
    expect(output).not.toContain("    at ");
  });

  it("escapes terminal controls in gateway declaration errors before printing (#7627)", async () => {
    const errors: string[] = [];
    await expect(
      runOnboardCommand({
        flags: {},
        env: {},
        runOnboard: async () => {
          throw invalidGatewayManagementDeclarationError(
            "unknown declaration field(s): forged\n\u001b[31mError: \u202efake failure",
          );
        },
        error: (message = "") => errors.push(message),
        exit: exitWithCode,
      }),
    ).rejects.toThrow("exit:1");

    expect(errors).toEqual([
      "  Invalid gateway management declaration: unknown declaration field(s): forged\\u000a\\u001b[31mError: \\u202efake failure",
    ]);
    expect(errors[0]?.split(/\r?\n/u)).toHaveLength(1);
    expect(errors[0]).not.toMatch(
      /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u,
    );
  });

  it("re-throws a non-cancellation, non-gateway error so genuine bugs still surface (#7627)", async () => {
    await expect(
      runOnboardCommand({
        flags: {},
        env: {},
        runOnboard: async () => {
          throw new Error("unexpected boom");
        },
        error: () => {},
        exit: exitWithCode,
      }),
    ).rejects.toThrow("unexpected boom");
  });

  it("returns without rethrowing when a prompt rejects with SIGINT (#7439)", async () => {
    const exit = vi.fn<(code: number) => never>();
    await expect(
      runOnboardCommand({
        flags: {},
        env: {},
        runOnboard: async () => {
          throw Object.assign(new Error("Prompt interrupted"), { code: "SIGINT" });
        },
        error: () => {},
        exit,
      }),
    ).resolves.toBeUndefined();
    expect(exit).not.toHaveBeenCalled();
  });

  it("rethrows non-cancellation onboarding failures unchanged (#5976)", async () => {
    await expect(
      runOnboardCommand({
        flags: {},
        env: {},
        runOnboard: async () => {
          throw new Error("docker is not reachable");
        },
        error: () => {},
        exit: exitWithCode,
      }),
    ).rejects.toThrow("docker is not reachable");
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
