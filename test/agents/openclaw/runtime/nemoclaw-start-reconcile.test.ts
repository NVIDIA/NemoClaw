// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { prepareNonRootChildProcess } from "../../../helpers/non-root-child-process";

const START_SCRIPT = path.join(
  import.meta.dirname,
  "..",
  "../../..",
  "scripts",
  "nemoclaw-start.sh",
);

interface RunReconcileOptions {
  /**
   * Model the stubbed `openshell inference get -g nemoclaw` should print.
   * - undefined → no openshell on PATH (probe falls back to in-file logic).
   * - "" → openshell exists but returns an unconfigured inference section.
   * - non-empty string → openshell returns a configured inference section.
   * Ignored when `gatewayRawOutput` is set.
   */
  gatewayModel?: string;
  /**
   * Raw stdout the stub emits instead of a formatted inference section. Use to
   * exercise malformed or unexpected-shape paths. Takes precedence
   * over `gatewayModel` when both are set.
   */
  gatewayRawOutput?: string;
  configWritable?: boolean;
  customRouteReceipt?: "valid" | "invalid";
  env?: Record<string, string>;
  uid?: number;
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
    const receiptPath = path.join(openclawDir, ".nemoclaw-custom-route-pending");
    fs.writeFileSync(configPath, JSON.stringify(initialConfig));
    fs.writeFileSync(hashPath, "oldhash\n");
    const receiptDigest =
      options.customRouteReceipt === "valid"
        ? createHash("sha256").update(fs.readFileSync(configPath)).digest("hex")
        : options.customRouteReceipt === "invalid"
          ? "0".repeat(64)
          : null;
    receiptDigest && fs.writeFileSync(receiptPath, `${receiptDigest}  openclaw.json\n`);
    fs.chmodSync(openclawDir, 0o2770);
    fs.chmodSync(configPath, options.configWritable === false ? 0o440 : 0o660);
    fs.chmodSync(hashPath, 0o660);
    receiptDigest && fs.chmodSync(receiptPath, 0o660);

    const binDir = path.join(root, "bin");
    fs.mkdirSync(binDir);
    const installStub =
      options.gatewayRawOutput !== undefined || options.gatewayModel !== undefined;
    if (installStub) {
      const model = options.gatewayRawOutput === undefined ? options.gatewayModel : undefined;
      const payload =
        options.gatewayRawOutput !== undefined
          ? options.gatewayRawOutput
          : model === ""
            ? "Inference:\n  Not configured\n"
            : `Inference:\n  Provider: compatible-endpoint\n  Model: ${model}\n`;
      const stub = [
        "#!/usr/bin/env bash",
        'if [ "$1" = "inference" ] && [ "$2" = "get" ]; then',
        '  [ "$#" -eq 4 ] && [ "$3" = "-g" ] && [ "$4" = "nemoclaw" ] || exit 64',
        `  printf '%b' ${JSON.stringify(payload)}`,
        "  exit 0",
        "fi",
        "exit 1",
        "",
      ].join("\n");
      fs.writeFileSync(path.join(binDir, "openshell"), stub, { mode: 0o755 });
    }

    const helperFns = [
      "normalize_mutable_config_perms() { :; }",
      'run_openclaw_config_as_owner() { "$@"; }',
      `ensure_mutable_openclaw_config_hash() { (cd ${JSON.stringify(openclawDir)} && sha256sum openclaw.json >.config-hash); }`,
    ].join("\n");
    const fn = extractShellFunction("reconcile_agent_model_with_provider").replaceAll(
      "/sandbox",
      root,
    );
    const runAsActualNonRoot = options.uid !== undefined && options.uid !== 0;
    const wrapper = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      runAsActualNonRoot
        ? 'id() { command /usr/bin/id "$@"; }'
        : `id() { echo ${options.uid ?? 0}; }`,
      helperFns,
      fn,
      "reconcile_agent_model_with_provider",
    ].join("\n");
    const script = path.join(root, "run.sh");
    fs.writeFileSync(script, wrapper, { mode: 0o700 });
    const childCredentials = prepareNonRootChildProcess({
      enabled: runAsActualNonRoot,
      ownedPaths: [
        openclawDir,
        configPath,
        hashPath,
        ...(receiptDigest ? [receiptPath] : []),
        script,
      ],
      traversalRoot: root,
    });
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
    const pathValue = installStub ? `${binDir}${path.delimiter}${scrubbedPath}` : scrubbedPath;
    const result = spawnSync("bash", [script], {
      encoding: "utf-8",
      env: { ...process.env, ...options.env, PATH: pathValue },
      ...childCredentials,
    });
    const configRaw = fs.readFileSync(configPath, "utf-8");
    const config = JSON.parse(configRaw);
    const hash = fs.readFileSync(hashPath, "utf-8");
    const expectedHash = `${createHash("sha256").update(configRaw).digest("hex")}  openclaw.json\n`;
    fs.rmSync(root, { recursive: true, force: true });
    return { result, config, hash, expectedHash };
  }

  it("aligns agents.defaults.model.primary to inference provider's first model when they drift", () => {
    const { result, config, hash, expectedHash } = runReconcile({
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
    expect(hash).toBe(expectedHash);
  });

  it("is a no-op when primary already matches the provider's model", () => {
    const { result, config, hash } = runReconcile({
      agents: {
        defaults: { model: { primary: "inference/nvidia/same-model" } },
      },
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
    const { result, config, hash, expectedHash } = runReconcile({
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
    expect(hash).toBe(expectedHash);
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

  it("preserves an explicit model override when the live gateway reports a conflicting model", () => {
    const initial = {
      agents: {
        defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } },
      },
      models: {
        providers: {
          inference: {
            api: "openai-completions",
            models: [
              {
                id: "anthropic/claude-sonnet-4-6",
                name: "anthropic/claude-sonnet-4-6",
              },
            ],
          },
        },
      },
    };
    const { result, config, hash } = runReconcile(initial, {
      env: { NEMOCLAW_MODEL_OVERRIDE: "anthropic/claude-sonnet-4-6" },
      gatewayModel: "nvidia/nemotron-3-super-120b-a12b",
    });

    expect(result.status).toBe(0);
    expect(config).toEqual(initial);
    expect(hash).toBe("oldhash\n");
  });

  it("still reconciles from the live gateway when no explicit model override is set", () => {
    const { result, config, hash, expectedHash } = runReconcile(
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
    expect(hash).toBe(expectedHash);
  });

  it("preserves an integrity-bound custom route when the selected model is not models[0]", () => {
    const { result, config, hash, expectedHash } = runReconcile(
      {
        agents: { defaults: { model: { primary: "inference/selected-model" } } },
        models: {
          providers: {
            inference: {
              models: [
                {
                  id: "baked-model",
                  name: "inference/baked-model",
                  contextWindow: 131_072,
                  maxTokens: 4096,
                },
                { id: "selected-model", name: "inference/selected-model" },
              ],
            },
          },
        },
      },
      {
        customRouteReceipt: "valid",
        gatewayModel: "nvidia/nemotron-3-super-120b-a12b",
        uid: 1000,
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(config.agents.defaults.model.primary).toBe("inference/selected-model");
    expect(config.models.providers.inference.models[0].id).toBe("baked-model");
    expect(config.models.providers.inference.models[1].id).toBe("selected-model");
    expect(hash).toBe(expectedHash);
  });

  it("fails closed when a custom image route receipt does not match its config", () => {
    const initial = {
      agents: { defaults: { model: { primary: "inference/selected-model" } } },
      models: {
        providers: {
          inference: {
            models: [{ id: "selected-model", name: "inference/selected-model" }],
          },
        },
      },
    };
    const { result, config, hash } = runReconcile(initial, {
      customRouteReceipt: "invalid",
      gatewayModel: "nvidia/nemotron-3-super-120b-a12b",
      uid: 1000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Refusing invalid custom-image route receipt");
    expect(config).toEqual(initial);
    expect(hash).toBe("oldhash\n");
  });

  it("reconciles a writable config when startup runs as a non-root sandbox user", () => {
    const { result, config, hash, expectedHash } = runReconcile(
      {
        agents: { defaults: { model: { primary: "inference/baked-model" } } },
        models: {
          providers: {
            inference: {
              models: [
                {
                  id: "baked-model",
                  name: "inference/baked-model",
                  contextWindow: 131_072,
                  maxTokens: 4096,
                },
              ],
            },
          },
        },
      },
      { gatewayModel: "selected-model", uid: 1000 },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(config.agents.defaults.model.primary).toBe("inference/selected-model");
    expect(config.models.providers.inference.models[0]).toEqual({
      id: "selected-model",
      name: "inference/selected-model",
    });
    expect(hash).toBe(expectedHash);
  });

  it("preserves explicit limits when only the provider model name is stale", () => {
    const { result, config, hash, expectedHash } = runReconcile(
      {
        agents: { defaults: { model: { primary: "inference/selected-model" } } },
        models: {
          providers: {
            inference: {
              models: [
                {
                  id: "selected-model",
                  name: "inference/stale-display-name",
                  contextWindow: 200_000,
                  maxTokens: 8192,
                },
              ],
            },
          },
        },
      },
      { gatewayModel: "selected-model", uid: 1000 },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(config.models.providers.inference.models[0]).toEqual({
      id: "selected-model",
      name: "inference/selected-model",
      contextWindow: 200_000,
      maxTokens: 8192,
    });
    expect(hash).toBe(expectedHash);
  });

  it("leaves a sealed config unchanged for non-root startup", () => {
    const initial = {
      agents: { defaults: { model: { primary: "inference/baked-model" } } },
      models: {
        providers: {
          inference: {
            models: [{ id: "baked-model", name: "inference/baked-model" }],
          },
        },
      },
    };
    const { result, config, hash } = runReconcile(initial, {
      configWritable: false,
      gatewayModel: "selected-model",
      uid: 1000,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(config).toEqual(initial);
    expect(hash).toBe("oldhash\n");
  });

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

  // ── Explicit override wins over gateway reconciliation (#6065) ──
  //
  // #5874 re-architected gateway recovery and left reconcile running after
  // apply_model_override with no guard, so its inference/-qualifying pass
  // silently overwrote the user's explicit NEMOCLAW_MODEL_OVERRIDE. That
  // regression only surfaced in the live `runtime-overrides` E2E, which does
  // not run on PR CI. These mocked shell-units pin the guard in the PR gate.

  it("leaves an explicit NEMOCLAW_MODEL_OVERRIDE untouched even when the gateway reports a divergent model", () => {
    const { result, config, hash } = runReconcile(
      {
        agents: {
          defaults: { model: { primary: "inference/user/explicit-choice" } },
        },
        models: {
          providers: {
            inference: {
              api: "openai-completions",
              models: [
                {
                  id: "user/explicit-choice",
                  name: "inference/user/explicit-choice",
                },
              ],
            },
          },
        },
      },
      {
        env: { NEMOCLAW_MODEL_OVERRIDE: "user/explicit-choice" },
        gatewayModel: "nvidia/nemotron-3-super-120b-a12b",
      },
    );

    expect(result.status).toBe(0);
    // Without the guard, the gateway probe would rewrite primary AND models[0]
    // to the divergent inference/-qualified value; the override must survive.
    expect(config.agents.defaults.model.primary).toBe("inference/user/explicit-choice");
    expect(config.models.providers.inference.models[0].id).toBe("user/explicit-choice");
    expect(hash).toBe("oldhash\n");
  });

  it("does not fall back to the in-file reconcile when NEMOCLAW_MODEL_OVERRIDE is set", () => {
    // Even the legacy no-gateway path must be skipped: apply_model_override has
    // already written the user's choice, so a stale file model must not win.
    const { result, config, hash } = runReconcile(
      {
        agents: {
          defaults: { model: { primary: "inference/user/explicit-choice" } },
        },
        models: {
          providers: {
            inference: {
              api: "openai-completions",
              models: [
                {
                  id: "nvidia/stale-file-model",
                  name: "inference/nvidia/stale-file-model",
                },
              ],
            },
          },
        },
      },
      { env: { NEMOCLAW_MODEL_OVERRIDE: "user/explicit-choice" } },
    );

    expect(result.status).toBe(0);
    expect(config.agents.defaults.model.primary).toBe("inference/user/explicit-choice");
    expect(hash).toBe("oldhash\n");
  });

  it("still reconciles to the gateway model when NEMOCLAW_MODEL_OVERRIDE is unset", () => {
    // Guard is scoped to explicit overrides only; the normal drift-correction
    // path must keep working (regression fence around the early return itself).
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
    expect(hash).not.toBe("oldhash\n");
  });

  it("falls back to the in-file reconcile when the gateway probe emits malformed output", () => {
    // A future packaging shift could ship an `openshell` shim that returns
    // junk on stdout. The
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
      { gatewayRawOutput: "<html>not gateway output at all</html>" },
    );

    expect(result.status).toBe(0);
    // Legacy in-file path runs: primary is aligned to the file's first
    // model, models[0] stays untouched (same shape as the empty-probe case).
    expect(config.agents.defaults.model.primary).toBe("inference/nvidia/new-model");
    expect(config.models.providers.inference.models[0].id).toBe("nvidia/new-model");
  });

  it("rejects a gateway inference section without a provider", () => {
    const { result, config } = runReconcile(
      {
        agents: { defaults: { model: { primary: "inference/old-model" } } },
        models: {
          providers: {
            inference: {
              models: [{ id: "file-model", name: "inference/file-model" }],
            },
          },
        },
      },
      { gatewayRawOutput: "Inference:\n  Model: untrusted-gateway-model\n" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(config.agents.defaults.model.primary).toBe("inference/file-model");
    expect(config.models.providers.inference.models[0].id).toBe("file-model");
  });
});
