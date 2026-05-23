// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const START_SCRIPT = path.join(import.meta.dirname, "..", "scripts", "nemoclaw-start.sh");

describe("agent identity reconciliation with provider (#3175)", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");

  function extractShellFunction(name: string): string {
    const match = src.match(new RegExp(`${name}\\(\\) \\{([\\s\\S]*?)^\\}`, "m"));
    if (!match) {
      throw new Error(`Expected ${name} in scripts/nemoclaw-start.sh`);
    }
    return `${name}() {${match[1]}\n}`;
  }

  function runReconcile(initialConfig: unknown, env: Record<string, string> = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-reconcile-"));
    const openclawDir = path.join(root, ".openclaw");
    fs.mkdirSync(openclawDir, { recursive: true });
    const configPath = path.join(openclawDir, "openclaw.json");
    const hashPath = path.join(openclawDir, ".config-hash");
    fs.writeFileSync(configPath, JSON.stringify(initialConfig));
    fs.writeFileSync(hashPath, "oldhash\n");
    fs.chmodSync(openclawDir, 0o2770);
    fs.chmodSync(configPath, 0o660);
    fs.chmodSync(hashPath, 0o660);

    const helperFns = [
      extractShellFunction("openclaw_config_dir_owner"),
      extractShellFunction("prepare_openclaw_config_for_write"),
      extractShellFunction("restore_openclaw_config_after_write"),
    ]
      .join("\n")
      .replaceAll("/sandbox", root);
    const fn = extractShellFunction("reconcile_agent_model_with_provider").replaceAll(
      "/sandbox",
      root,
    );
    const wrapper = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "id() { echo 0; }",
      "chown() { return 0; }",
      `stat() { if [ "$1" = "-c" ] && [ "$2" = "%U" ] && [ "$3" = ${JSON.stringify(openclawDir)} ]; then echo sandbox; return 0; fi; command stat "$@"; }`,
      'relax_config_for_write() { chmod 644 "$@"; }',
      'lock_config_after_write() { chmod 444 "$@"; }',
      helperFns,
      fn,
      "reconcile_agent_model_with_provider",
    ].join("\n");
    const script = path.join(root, "run.sh");
    fs.writeFileSync(script, wrapper, { mode: 0o700 });
    const result = spawnSync("bash", [script], {
      encoding: "utf-8",
      env: { ...process.env, ...env },
    });
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const hash = fs.readFileSync(hashPath, "utf-8");
    fs.rmSync(root, { recursive: true, force: true });
    return { result, config, hash };
  }

  it("aligns agents.defaults.model.primary to inference provider's first model when they drift", () => {
    const { result, config, hash } = runReconcile({
      agents: { defaults: { model: { primary: "inference/old-model" } } },
      models: {
        providers: {
          inference: {
            api: "openai-completions",
            models: [{ id: "nvidia/new-model", name: "inference/nvidia/new-model" }],
          },
        },
      },
    });

    expect(result.status).toBe(0);
    expect(config.agents.defaults.model.primary).toBe("inference/nvidia/new-model");
    expect(hash).not.toBe("oldhash\n");
    expect(hash).toContain("openclaw.json");
  });

  it("is a no-op when primary already matches the provider's model", () => {
    const { result, config, hash } = runReconcile({
      agents: { defaults: { model: { primary: "inference/nvidia/same-model" } } },
      models: {
        providers: {
          inference: {
            api: "openai-completions",
            models: [{ id: "nvidia/same-model", name: "inference/nvidia/same-model" }],
          },
        },
      },
    });

    expect(result.status).toBe(0);
    expect(config.agents.defaults.model.primary).toBe("inference/nvidia/same-model");
    expect(hash).toBe("oldhash\n");
  });

  it("falls back to an inference-qualified model ref when provider metadata lacks name", () => {
    const { result, config, hash } = runReconcile({
      agents: { defaults: { model: { primary: "inference/old-model" } } },
      models: {
        providers: {
          inference: {
            api: "openai-completions",
            models: [{ id: "nvidia/new-model" }],
          },
        },
      },
    });

    expect(result.status).toBe(0);
    expect(config.agents.defaults.model.primary).toBe("inference/nvidia/new-model");
    expect(hash).not.toBe("oldhash\n");
    expect(hash).toContain("openclaw.json");
  });

  it("is a no-op when openclaw.json has no inference provider", () => {
    const { result, config, hash } = runReconcile({
      agents: { defaults: { model: { primary: "inference/old-model" } } },
      models: { providers: {} },
    });

    expect(result.status).toBe(0);
    expect(config.agents.defaults.model.primary).toBe("inference/old-model");
    expect(hash).toBe("oldhash\n");
  });

  it("is a no-op when openclaw.json is missing required keys", () => {
    const { result, config, hash } = runReconcile({ unrelated: true });

    expect(result.status).toBe(0);
    expect(config).toEqual({ unrelated: true });
    expect(hash).toBe("oldhash\n");
  });
});
