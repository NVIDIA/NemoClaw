// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../..");

describe("Pi managed model catalog generation", () => {
  function generate(env: Record<string, string>): {
    home: string;
    status: number | null;
    stderr: string;
  } {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pi-config-"));
    const result = spawnSync(process.execPath, [path.join(root, "agents/pi/generate-config.ts")], {
      cwd: root,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: home, ...env },
    });
    return { home, status: result.status, stderr: result.stderr };
  }

  it("writes an owner-only catalog that routes the managed model", () => {
    const { home, status, stderr } = generate({
      NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
      NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
      NEMOCLAW_INFERENCE_API: "openai-completions",
    });
    expect(status, stderr).toBe(0);
    const configPath = path.join(home, ".pi", "agent", "models.json");
    const configFd = fs.openSync(configPath, "r");
    let config: {
      defaultModel: string;
      providers: Record<string, { baseUrl: string; api: string; apiKey: string }>;
    };
    try {
      expect(fs.fstatSync(configFd).mode & 0o777).toBe(0o600);
      config = JSON.parse(fs.readFileSync(configFd, "utf8"));
    } finally {
      fs.closeSync(configFd);
    }
    expect(config.defaultModel).toBe("nvidia/nemotron-3-super-120b-a12b");
    expect(config.providers.openshell.baseUrl).toBe("https://inference.local/v1");
    expect(config.providers.openshell.api).toBe("openai-completions");
    expect(config.providers.openshell.apiKey).toBe("nemoclaw-managed-inference");
  });

  it("rejects a model name that is empty after trimming", () => {
    const { status, stderr } = generate({
      NEMOCLAW_MODEL: "   ",
    });
    expect(status).not.toBe(0);
    expect(stderr).toContain("NEMOCLAW_MODEL must not be empty.");
  });

  it("keeps every provider credential out of the generated catalog", () => {
    const { home } = generate({
      NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
      NVIDIA_API_KEY: "nvapi-should-never-be-written",
      OPENAI_API_KEY: "sk-proj-should-never-be-written",
    });
    const config = fs.readFileSync(path.join(home, ".pi", "agent", "models.json"), "utf8");
    expect(config).not.toContain("nvapi-");
    expect(config).not.toContain("sk-proj-");
  });

  it("rejects an inference API family other than openai-completions", () => {
    const { status, stderr } = generate({
      NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
      NEMOCLAW_INFERENCE_API: "openai-responses",
    });
    expect(status).not.toBe(0);
    expect(stderr).toContain("NEMOCLAW_INFERENCE_API must be openai-completions for Pi.");
  });

  it("rejects an inference base URL that carries credentials", () => {
    const { status, stderr } = generate({
      NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
      NEMOCLAW_INFERENCE_BASE_URL: "https://user:secret@inference.local/v1",
    });
    expect(status).not.toBe(0);
    expect(stderr).toContain("NEMOCLAW_INFERENCE_BASE_URL must not include credentials.");
  });

  function readManagedModel(home: string): Record<string, unknown> {
    const config = JSON.parse(
      fs.readFileSync(path.join(home, ".pi", "agent", "models.json"), "utf8"),
    ) as { providers: Record<string, { models: Record<string, unknown>[] }> };
    return config.providers.openshell.models[0] as Record<string, unknown>;
  }

  it("writes the context window, output limit, and reasoning support Pi documents (#7930)", () => {
    const { home, status, stderr } = generate({
      NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
      NEMOCLAW_CONTEXT_WINDOW: "262144",
      NEMOCLAW_MAX_TOKENS: "32000",
      NEMOCLAW_REASONING: "true",
    });
    expect(status, stderr).toBe(0);
    expect(readManagedModel(home)).toEqual({
      id: "nvidia/nemotron-3-super-120b-a12b",
      contextWindow: 262_144,
      maxTokens: 32_000,
      reasoning: true,
    });
  });

  it("omits unset model tuning so Pi keeps its own defaults (#7930)", () => {
    const { home, status, stderr } = generate({
      NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
      NEMOCLAW_CONTEXT_WINDOW: "",
      NEMOCLAW_MAX_TOKENS: "",
      NEMOCLAW_REASONING: "",
    });
    expect(status, stderr).toBe(0);
    expect(readManagedModel(home)).toEqual({ id: "nvidia/nemotron-3-super-120b-a12b" });
  });

  it("records a disabled reasoning decision instead of dropping it (#7930)", () => {
    const { home, status, stderr } = generate({
      NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
      NEMOCLAW_REASONING: "false",
    });
    expect(status, stderr).toBe(0);
    expect(readManagedModel(home)).toEqual({
      id: "nvidia/nemotron-3-super-120b-a12b",
      reasoning: false,
    });
  });

  it.each([
    ["NEMOCLAW_CONTEXT_WINDOW", "128k", "NEMOCLAW_CONTEXT_WINDOW must be a positive integer."],
    ["NEMOCLAW_MAX_TOKENS", "0", "NEMOCLAW_MAX_TOKENS must be a positive integer."],
    ["NEMOCLAW_REASONING", "yes", 'NEMOCLAW_REASONING must be "true" or "false".'],
  ])("rejects %s=%s before writing a catalog (#7930)", (name, value, message) => {
    const { home, status, stderr } = generate({
      NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
      [name]: value,
    });
    expect(status).not.toBe(0);
    expect(stderr).toContain(message);
    expect(fs.existsSync(path.join(home, ".pi", "agent", "models.json"))).toBe(false);
  });
});

describe("Pi managed image validation", () => {
  const script = path.join(root, "scripts/checks/validate-pi-managed-image.sh");

  function validate(args: string[], labels: Record<string, string>) {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pi-image-validation-"));
    const calls = path.join(fixture, "docker-calls");
    fs.mkdirSync(path.join(fixture, "bin"));
    fs.writeFileSync(
      path.join(fixture, "bin", "docker"),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${calls}"\n` +
        `if [ "$1 $2" = "image inspect" ]; then printf '%s\\n' '${JSON.stringify([
          { Config: { Labels: labels, Entrypoint: ["/usr/local/bin/nemoclaw-start"] } },
        ])}'; exit 0; fi\nexit 97\n`,
      { mode: 0o755 },
    );
    try {
      const result = spawnSync("bash", [script, ...args], {
        encoding: "utf8",
        env: {
          PATH: `${path.join(fixture, "bin")}:${process.env.PATH ?? ""}`,
          RUNNER_TEMP: fixture,
        },
      });
      return {
        calls: fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n") : [],
        status: result.status,
        stderr: result.stderr,
      };
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  }

  it.each([
    ["no arguments", []],
    ["an unsupported platform", ["--reference", "image", "--platform", "linux/s390x"]],
    ["an unknown option", ["--reference", "image", "--platform", "linux/amd64", "--push"]],
  ])("refuses %s before inspecting an image", (_label, args) => {
    const result = validate(args, {});

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("usage:");
    expect(result.calls).toEqual([]);
  });

  it("refuses an image that is not the Pi managed image before starting it", () => {
    const result = validate(
      ["--reference", "nemoclaw-managed-pr/pi:head", "--platform", "linux/amd64"],
      {
        "io.nvidia.nemoclaw.agent": "hermes",
        "io.nvidia.nemoclaw.managed-image.platform": "linux/amd64",
        "io.nvidia.nemoclaw.managed-image.startup-profile": "1",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "the Pi image does not carry the managed-image runtime contract",
    );
    expect(result.calls).toEqual(["image inspect nemoclaw-managed-pr/pi:head"]);
  });
});
