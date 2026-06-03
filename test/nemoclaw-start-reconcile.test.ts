// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const START_SCRIPT = path.join(import.meta.dirname, "..", "scripts", "nemoclaw-start.sh");

interface RunReconcileOptions {
  /**
   * Output the stubbed `openshell inference get --json` should print.
   * - undefined → no openshell on PATH (probe falls back to in-file logic).
   * - "" → openshell exists but returns empty JSON (probe yields no model).
   * - non-empty string → openshell returns `{"model": <string>}`.
   * Ignored when `gatewayRawOutput` is set.
   */
  gatewayModel?: string;
  /**
   * Raw stdout the stub emits instead of a JSON-formatted payload. Use to
   * exercise malformed-JSON or unexpected-shape paths. Takes precedence
   * over `gatewayModel` when both are set.
   */
  gatewayRawOutput?: string;
  env?: Record<string, string>;
}

describe("agent identity reconciliation with provider (#3175)", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");

  function extractShellFunction(name: string): string {
    const match = src.match(new RegExp(`${name}\\(\\) \\{([\\s\\S]*?)^\\}`, "m"));
    if (!match) {
      throw new Error(`Expected ${name} in scripts/nemoclaw-start.sh`);
    }
    return `${name}() {${match[1]}\n}`;
  }

  function runReconcile(initialConfig: unknown, options: RunReconcileOptions = {}) {
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

    const binDir = path.join(root, "bin");
    fs.mkdirSync(binDir);
    const installStub = options.gatewayRawOutput !== undefined || options.gatewayModel !== undefined;
    if (installStub) {
      const payload =
        options.gatewayRawOutput !== undefined
          ? options.gatewayRawOutput
          : options.gatewayModel === ""
            ? "{}"
            : JSON.stringify({ model: options.gatewayModel });
      const stub = [
        "#!/usr/bin/env bash",
        'if [ "$1" = "inference" ] && [ "$2" = "get" ]; then',
        `  printf '%s' ${JSON.stringify(payload)}`,
        "  exit 0",
        "fi",
        "exit 1",
        "",
      ].join("\n");
      fs.writeFileSync(path.join(binDir, "openshell"), stub, { mode: 0o755 });
    }

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
    // Build PATH: when the test installs an openshell stub, prepend its
    // bin dir; otherwise scrub openshell from the inherited PATH so the
    // probe deterministically reports "not installed".
    const inheritedPath = process.env.PATH ?? "/usr/bin:/bin";
    const scrubbedPath = inheritedPath
      .split(path.delimiter)
      .filter((dir) => {
        if (!dir) return false;
        try {
          fs.accessSync(path.join(dir, "openshell"), fs.constants.X_OK);
          return false;
        } catch {
          return true;
        }
      })
      .join(path.delimiter);
    const pathValue = installStub
      ? `${binDir}${path.delimiter}${scrubbedPath}`
      : scrubbedPath;
    const result = spawnSync("bash", [script], {
      encoding: "utf-8",
      env: { ...process.env, ...options.env, PATH: pathValue },
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

  // ── Gateway-as-source-of-truth path (the #3175 user-reported repro) ──

  it("patches primary AND models[0] to the live gateway model when both file fields are stale", () => {
    const { result, config, hash } = runReconcile(
      {
        agents: { defaults: { model: { primary: "inference/nvidia-routed" } } },
        models: {
          providers: {
            inference: {
              api: "openai-completions",
              models: [{ id: "nvidia-routed", name: "inference/nvidia-routed" }],
            },
          },
        },
      },
      { gatewayModel: "nvidia/nemotron-3-super-120b-a12b" },
    );

    expect(result.status).toBe(0);
    expect(config.agents.defaults.model.primary).toBe(
      "inference/nvidia/nemotron-3-super-120b-a12b",
    );
    expect(config.models.providers.inference.models[0].name).toBe(
      "inference/nvidia/nemotron-3-super-120b-a12b",
    );
    expect(config.models.providers.inference.models[0].id).toBe(
      "nvidia/nemotron-3-super-120b-a12b",
    );
    expect(hash).not.toBe("oldhash\n");
    expect(hash).toContain("openclaw.json");
  });

  it("accepts an inference-qualified gateway model without double-prefixing", () => {
    const { result, config } = runReconcile(
      {
        agents: { defaults: { model: { primary: "inference/nvidia-routed" } } },
        models: {
          providers: {
            inference: {
              api: "openai-completions",
              models: [{ id: "nvidia-routed", name: "inference/nvidia-routed" }],
            },
          },
        },
      },
      { gatewayModel: "inference/nvidia/nemotron-3-super-120b-a12b" },
    );

    expect(result.status).toBe(0);
    expect(config.agents.defaults.model.primary).toBe(
      "inference/nvidia/nemotron-3-super-120b-a12b",
    );
    expect(config.models.providers.inference.models[0].id).toBe(
      "nvidia/nemotron-3-super-120b-a12b",
    );
  });

  it("is a no-op when the live gateway model matches both file fields", () => {
    const { result, config, hash } = runReconcile(
      {
        agents: { defaults: { model: { primary: "inference/nvidia/synced" } } },
        models: {
          providers: {
            inference: {
              api: "openai-completions",
              models: [{ id: "nvidia/synced", name: "inference/nvidia/synced" }],
            },
          },
        },
      },
      { gatewayModel: "nvidia/synced" },
    );

    expect(result.status).toBe(0);
    expect(config.agents.defaults.model.primary).toBe("inference/nvidia/synced");
    expect(hash).toBe("oldhash\n");
  });

  it("falls back to the in-file reconcile when the gateway probe returns no model", () => {
    const { result, config } = runReconcile(
      {
        agents: { defaults: { model: { primary: "inference/old-model" } } },
        models: {
          providers: {
            inference: {
              api: "openai-completions",
              models: [{ id: "nvidia/new-model", name: "inference/nvidia/new-model" }],
            },
          },
        },
      },
      { gatewayModel: "" },
    );

    expect(result.status).toBe(0);
    expect(config.agents.defaults.model.primary).toBe("inference/nvidia/new-model");
    // models[0] is untouched in legacy-fallback mode.
    expect(config.models.providers.inference.models[0].id).toBe("nvidia/new-model");
  });

  it("falls back to the in-file reconcile when the gateway probe emits malformed JSON", () => {
    // A future packaging shift could ship an `openshell` shim that doesn't
    // implement `inference get --json` and returns junk on stdout. The
    // current absorb-via-SystemExit(0) path should still leave the user
    // in the legacy in-file reconcile state — pinning this so a refactor
    // of the probe parser can't silently degrade to "do nothing".
    const { result, config } = runReconcile(
      {
        agents: { defaults: { model: { primary: "inference/old-model" } } },
        models: {
          providers: {
            inference: {
              api: "openai-completions",
              models: [{ id: "nvidia/new-model", name: "inference/nvidia/new-model" }],
            },
          },
        },
      },
      { gatewayRawOutput: "<html>not json at all</html>" },
    );

    expect(result.status).toBe(0);
    // Legacy in-file path runs: primary is aligned to the file's first
    // model, models[0] stays untouched (same shape as the empty-probe case).
    expect(config.agents.defaults.model.primary).toBe("inference/nvidia/new-model");
    expect(config.models.providers.inference.models[0].id).toBe("nvidia/new-model");
  });
});
