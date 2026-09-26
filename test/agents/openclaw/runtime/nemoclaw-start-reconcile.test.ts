// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const START_SCRIPT = path.join(
  import.meta.dirname,
  "..",
  "../../..",
  "scripts",
  "nemoclaw-start.sh",
);

interface RunReconcileOptions {
  /**
   * Model the stubbed `openshell inference get -g <gateway>` should print.
   * - undefined → no openshell on PATH (probe falls back to in-file logic).
   * - "" → openshell exists but returns an unconfigured inference section.
   * - non-empty string → openshell returns a configured inference section.
   * Ignored when `gatewayRawOutput` is set.
   */
  gatewayModel?: string;
  /**
   * Raw stdout the stub emits instead of a formatted inference section.
   * Takes precedence over `gatewayModel` when both are set.
   */
  gatewayRawOutput?: string;
  gatewayExitCode?: number;
  gatewayDelaySeconds?: number;
  gatewayName?: string;
  userId?: number;
  useActualUser?: boolean;
  symlink?: "config" | "hash" | "marker";
  configWritable?: boolean;
  hashFailure?: boolean | "once";
  customRoutePending?: boolean | "directory" | "invalid";
  retireCustomRouteBeforeRetry?: boolean;
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
    const customRouteMarkerPath = path.join(openclawDir, ".nemoclaw-custom-route-pending");
    const prepareCustomRouteMarker = new Map<
      boolean | "directory" | "invalid" | undefined,
      () => void
    >([
      [undefined, () => undefined],
      [false, () => undefined],
      ["directory", () => fs.mkdirSync(customRouteMarkerPath)],
      ["invalid", () => fs.writeFileSync(customRouteMarkerPath, "invalid\n")],
      [
        true,
        () => {
          const digest = createHash("sha256").update(fs.readFileSync(configPath)).digest("hex");
          fs.writeFileSync(customRouteMarkerPath, `${digest}  openclaw.json\n`);
        },
      ],
    ]).get(options.customRoutePending);
    prepareCustomRouteMarker!();
    fs.chmodSync(openclawDir, 0o2770);
    fs.chmodSync(configPath, options.configWritable === false ? 0o440 : 0o660);
    fs.chmodSync(hashPath, 0o660);
    const prepareSymlink = {
      config: () => {
        const target = path.join(openclawDir, "openclaw.real.json");
        fs.renameSync(configPath, target);
        fs.symlinkSync(target, configPath);
      },
      hash: () => {
        const target = path.join(openclawDir, ".config-hash.real");
        fs.renameSync(hashPath, target);
        fs.symlinkSync(target, hashPath);
      },
      marker: () => {
        const target = path.join(openclawDir, ".nemoclaw-custom-route-pending.real");
        fs.renameSync(customRouteMarkerPath, target);
        fs.symlinkSync(target, customRouteMarkerPath);
      },
      none: () => undefined,
    }[options.symlink ?? "none"];
    prepareSymlink();

    const binDir = path.join(root, "bin");
    fs.mkdirSync(binDir);
    const installStub =
      options.gatewayRawOutput !== undefined || options.gatewayModel !== undefined;
    if (installStub) {
      const gatewayName = options.gatewayName ?? "nemoclaw";
      const payload =
        options.gatewayRawOutput !== undefined
          ? options.gatewayRawOutput
          : options.gatewayModel === ""
            ? "Gateway Inference:\n  Not configured\n"
            : `Gateway Inference:\n  Provider: test-provider\n  Model: ${options.gatewayModel}\n`;
      const stub = [
        "#!/usr/bin/env bash",
        'if [ "$1" = "inference" ] && [ "$2" = "get" ]; then',
        `  [ "$#" -eq 4 ] && [ "$3" = "-g" ] && [ "$4" = ${JSON.stringify(gatewayName)} ] || exit 64`,
        options.gatewayDelaySeconds ? `  sleep ${options.gatewayDelaySeconds}` : "  :",
        `  printf '%b' ${JSON.stringify(payload)}`,
        `  exit ${options.gatewayExitCode ?? 0}`,
        "fi",
        "exit 1",
        "",
      ].join("\n");
      fs.writeFileSync(path.join(binDir, "openshell"), stub, { mode: 0o755 });
    }

    const hashHelper =
      options.hashFailure === true
        ? "ensure_mutable_openclaw_config_hash() { return 19; }"
        : options.hashFailure === "once"
          ? [
              "_hash_refresh_attempt=0",
              "ensure_mutable_openclaw_config_hash() {",
              "  _hash_refresh_attempt=$((_hash_refresh_attempt + 1))",
              '  [ "$_hash_refresh_attempt" -gt 1 ] || return 19',
              `  (cd ${JSON.stringify(openclawDir)} && sha256sum openclaw.json >.config-hash)`,
              "}",
            ].join("\n")
          : `ensure_mutable_openclaw_config_hash() { (cd ${JSON.stringify(openclawDir)} && sha256sum openclaw.json >.config-hash); }`;
    const helperFns = [
      "normalize_mutable_config_perms() { :; }",
      options.useActualUser
        ? extractShellFunction("run_openclaw_config_as_owner")
        : 'run_openclaw_config_as_owner() { "$@"; }',
      hashHelper,
    ].join("\n");
    const fn = extractShellFunction("reconcile_agent_model_with_provider").replaceAll(
      "/sandbox",
      root,
    );
    const retireFn = extractShellFunction("retire_custom_route_reconcile_marker").replaceAll(
      "/sandbox",
      root,
    );
    const wrapper = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      ...(options.useActualUser ? [] : [`id() { echo ${options.userId ?? 0}; }`]),
      helperFns,
      fn,
      retireFn,
      ...(options.hashFailure === "once"
        ? [
            "_first_reconcile_rc=0",
            "reconcile_agent_model_with_provider || _first_reconcile_rc=$?",
            '[ "$_first_reconcile_rc" -eq 19 ] || exit 91',
          ]
        : []),
      ...(options.retireCustomRouteBeforeRetry
        ? ["reconcile_agent_model_with_provider", "retire_custom_route_reconcile_marker"]
        : []),
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
    const pathValue = installStub ? `${binDir}${path.delimiter}${scrubbedPath}` : scrubbedPath;
    const result = spawnSync("bash", [script], {
      encoding: "utf-8",
      env: {
        ...process.env,
        ...(options.gatewayName ? { NEMOCLAW_OPENSHELL_GATEWAY_NAME: options.gatewayName } : {}),
        ...options.env,
        PATH: pathValue,
      },
    });
    const configRaw = fs.readFileSync(configPath, "utf-8");
    const config = JSON.parse(configRaw);
    const hash = fs.readFileSync(hashPath, "utf-8");
    const customRoutePending = fs.existsSync(customRouteMarkerPath);
    const expectedHash = `${createHash("sha256").update(configRaw).digest("hex")}  openclaw.json\n`;
    fs.rmSync(root, { recursive: true, force: true });
    return { result, config, hash, expectedHash, customRoutePending };
  }

  function runCustomRouteSettlement(gatewayReady: boolean) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-route-settlement-"));
    const openclawDir = path.join(root, ".openclaw");
    const markerPath = path.join(openclawDir, ".nemoclaw-custom-route-pending");
    fs.mkdirSync(openclawDir, { recursive: true });
    fs.writeFileSync(markerPath, `${"a".repeat(64)}  openclaw.json\n`);
    const retireFn = extractShellFunction("retire_custom_route_reconcile_marker").replaceAll(
      "/sandbox",
      root,
    );
    const settleFn = extractShellFunction("settle_custom_route_reconcile_marker").replaceAll(
      "/sandbox",
      root,
    );
    const script = path.join(root, "run.sh");
    fs.writeFileSync(
      script,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'run_openclaw_config_as_owner() { "$@"; }',
        `wait_for_openclaw_gateway_internal() { return ${gatewayReady ? 0 : 23}; }`,
        retireFn,
        settleFn,
        'settle_custom_route_reconcile_marker "123" "pid-identity"',
      ].join("\n"),
      { mode: 0o700 },
    );
    const result = spawnSync("bash", [script], { encoding: "utf-8" });
    const markerPending = fs.existsSync(markerPath);
    fs.rmSync(root, { recursive: true, force: true });
    return { result, markerPending };
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
    const { result, config, hash, expectedHash } = runReconcile({
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
    expect(hash).toBe(expectedHash);
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

  it("keeps the staged custom-image route authoritative for its first launch (#12033)", () => {
    const selected = {
      agents: { defaults: { model: { primary: "inference/custom/selected" } } },
      models: {
        providers: {
          inference: {
            api: "openai-completions",
            models: [{ id: "custom/selected", name: "inference/custom/selected" }],
          },
        },
      },
    };
    const { result, config, hash, expectedHash, customRoutePending } = runReconcile(selected, {
      customRoutePending: true,
      gatewayModel: "nvidia/nemotron-3-super-120b-a12b",
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(config).toEqual(selected);
    expect(hash).toBe(expectedHash);
    expect(customRoutePending).toBe(true);
  });

  it("fails closed when the staged custom-image route receipt does not match the config", () => {
    const initial = {
      agents: { defaults: { model: { primary: "inference/custom/selected" } } },
      models: {
        providers: {
          inference: {
            models: [{ id: "custom/selected", name: "inference/custom/selected" }],
          },
        },
      },
    };
    const { result, config, hash, customRoutePending } = runReconcile(initial, {
      customRoutePending: "invalid",
      gatewayModel: "nvidia/nemotron-3-super-120b-a12b",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("invalid custom-image route receipt");
    expect(config).toEqual(initial);
    expect(hash).toBe("oldhash\n");
    expect(customRoutePending).toBe(true);
  });

  it("fails closed when the staged custom-image route receipt is a symlink", () => {
    const initial = {
      agents: { defaults: { model: { primary: "inference/custom/selected" } } },
      models: {
        providers: {
          inference: {
            models: [{ id: "custom/selected", name: "inference/custom/selected" }],
          },
        },
      },
    };
    const { result, config, hash, customRoutePending } = runReconcile(initial, {
      customRoutePending: true,
      gatewayModel: "nvidia/nemotron-3-super-120b-a12b",
      symlink: "marker",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("config, hash, or receipt path is a symlink");
    expect(config).toEqual(initial);
    expect(hash).toBe("oldhash\n");
    expect(customRoutePending).toBe(true);
  });

  it("fails closed when the staged custom-image route receipt is not a regular file", () => {
    const initial = {
      agents: { defaults: { model: { primary: "inference/custom/selected" } } },
      models: {
        providers: {
          inference: {
            models: [{ id: "custom/selected", name: "inference/custom/selected" }],
          },
        },
      },
    };
    const { result, config, hash, customRoutePending } = runReconcile(initial, {
      customRoutePending: "directory",
      gatewayModel: "nvidia/nemotron-3-super-120b-a12b",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("custom-image route receipt is not a regular file");
    expect(config).toEqual(initial);
    expect(hash).toBe("oldhash\n");
    expect(customRoutePending).toBe(true);
  });

  it("uses the live gateway after the first custom-image launch retires its receipt", () => {
    const { result, config, hash, customRoutePending } = runReconcile(
      {
        agents: { defaults: { model: { primary: "inference/custom/selected" } } },
        models: {
          providers: {
            inference: {
              models: [{ id: "custom/selected", name: "inference/custom/selected" }],
            },
          },
        },
      },
      {
        customRoutePending: true,
        gatewayModel: "provider/switched",
        retireCustomRouteBeforeRetry: true,
      },
    );

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(config.agents.defaults.model.primary).toBe("inference/provider/switched");
    expect(config.models.providers.inference.models[0]).toMatchObject({
      id: "provider/switched",
      name: "inference/provider/switched",
    });
    expect(hash).not.toBe("oldhash\n");
    expect(customRoutePending).toBe(false);
  });

  it.each([
    { gatewayReady: true, markerPending: false },
    { gatewayReady: false, markerPending: true },
  ])(
    "retires the custom-image route receipt only after gateway readiness: $gatewayReady",
    ({ gatewayReady, markerPending }) => {
      const settled = runCustomRouteSettlement(gatewayReady);

      expect(settled.result.status, settled.result.stderr || settled.result.stdout).toBe(0);
      expect(settled.markerPending).toBe(markerPending);
      expect(settled.result.stderr).toContain(
        gatewayReady ? "" : "first gateway launch did not become ready",
      );
    },
  );

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

  it.runIf(typeof process.getuid === "function" && process.getuid() !== 0)(
    "reconciles an actually owned config as the current non-root user (#12033)",
    () => {
      const { result, config, hash } = runReconcile(
        {
          agents: { defaults: { model: { primary: "inference/nvidia-routed" } } },
          models: {
            providers: {
              inference: {
                api: "openai-completions",
                models: [
                  {
                    id: "nvidia-routed",
                    name: "inference/nvidia-routed",
                    contextWindow: 131072,
                    maxTokens: 4096,
                  },
                ],
              },
            },
          },
        },
        {
          gatewayModel: "nvidia/nemotron-3-super-120b-a12b",
          useActualUser: true,
        },
      );

      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(config.agents.defaults.model.primary).toBe(
        "inference/nvidia/nemotron-3-super-120b-a12b",
      );
      expect(config.models.providers.inference.models[0].name).toBe(
        "inference/nvidia/nemotron-3-super-120b-a12b",
      );
      expect(config.models.providers.inference.models[0].id).toBe(
        "nvidia/nemotron-3-super-120b-a12b",
      );
      expect(config.models.providers.inference.models[0]).not.toHaveProperty("contextWindow");
      expect(config.models.providers.inference.models[0]).not.toHaveProperty("maxTokens");
      expect(hash).not.toBe("oldhash\n");
      expect(hash).toContain("openclaw.json");
    },
  );

  it("preserves a later model switch when the live gateway probe is unavailable", () => {
    const switched = {
      agents: { defaults: { model: { primary: "inference/nvidia/switched-model" } } },
      models: {
        providers: {
          inference: {
            models: [
              {
                id: "nvidia/switched-model",
                name: "inference/nvidia/switched-model",
                contextWindow: 262_144,
                maxTokens: 16_384,
              },
            ],
          },
        },
      },
    };
    const { result, config, hash, expectedHash } = runReconcile(switched);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(config).toEqual(switched);
    expect(hash).toBe(expectedHash);
  });

  it.runIf(typeof process.getuid === "function" && process.getuid() !== 0)(
    "explains why an actual non-root user cannot reconcile a sealed config (#12033)",
    () => {
      const initial = {
        agents: { defaults: { model: { primary: "inference/old-model" } } },
        models: {
          providers: {
            inference: {
              models: [{ id: "old-model", name: "inference/old-model" }],
            },
          },
        },
      };
      const { result, config, hash } = runReconcile(initial, {
        gatewayModel: "new-model",
        useActualUser: true,
        configWritable: false,
      });

      expect(result.status).toBe(0);
      expect(config).toEqual(initial);
      expect(hash).toBe("oldhash\n");
      expect(result.stderr).toContain("OpenClaw config is not writable by the sandbox user");
    },
  );

  it("patches primary AND models[0] to the live gateway model when both file fields are stale", () => {
    const { result, config, hash } = runReconcile(
      {
        agents: { defaults: { model: { primary: "inference/nvidia-routed" } } },
        models: {
          providers: {
            inference: {
              api: "openai-completions",
              models: [
                {
                  id: "nvidia-routed",
                  name: "inference/nvidia-routed",
                  contextWindow: 131072,
                  maxTokens: 4096,
                },
              ],
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
    expect(config.models.providers.inference.models[0]).not.toHaveProperty("contextWindow");
    expect(config.models.providers.inference.models[0]).not.toHaveProperty("maxTokens");
    expect(hash).not.toBe("oldhash\n");
    expect(hash).toContain("openclaw.json");
  });

  it("queries the selected nondefault OpenShell gateway", () => {
    const { result, config } = runReconcile(
      {
        agents: { defaults: { model: { primary: "inference/old-model" } } },
        models: {
          providers: {
            inference: {
              api: "openai-completions",
              models: [{ id: "old-model", name: "inference/old-model" }],
            },
          },
        },
      },
      { gatewayModel: "new-model", gatewayName: "nemoclaw-18081" },
    );

    expect(result.status).toBe(0);
    expect(config.agents.defaults.model.primary).toBe("inference/new-model");
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
    const { result, config, hash, expectedHash } = runReconcile(
      {
        agents: { defaults: { model: { primary: "inference/nvidia/synced" } } },
        models: {
          providers: {
            inference: {
              api: "openai-completions",
              models: [
                {
                  id: "nvidia/synced",
                  name: "inference/nvidia/synced",
                  contextWindow: 131072,
                  maxTokens: 4096,
                },
              ],
            },
          },
        },
      },
      { gatewayModel: "nvidia/synced" },
    );

    expect(result.status).toBe(0);
    expect(config.agents.defaults.model.primary).toBe("inference/nvidia/synced");
    expect(config.models.providers.inference.models[0]).toMatchObject({
      contextWindow: 131072,
      maxTokens: 4096,
    });
    expect(hash).toBe(expectedHash);
  });

  it("preserves explicit limits when only the primary model reference is stale", () => {
    const { result, config, hash } = runReconcile(
      {
        agents: { defaults: { model: { primary: "inference/stale-primary" } } },
        models: {
          providers: {
            inference: {
              api: "openai-completions",
              models: [
                {
                  id: "nvidia/synced",
                  name: "inference/nvidia/synced",
                  contextWindow: 131072,
                  maxTokens: 4096,
                },
              ],
            },
          },
        },
      },
      { gatewayModel: "nvidia/synced" },
    );

    expect(result.status).toBe(0);
    expect(config.agents.defaults.model.primary).toBe("inference/nvidia/synced");
    expect(config.models.providers.inference.models[0]).toMatchObject({
      contextWindow: 131072,
      maxTokens: 4096,
    });
    expect(hash).not.toBe("oldhash\n");
  });

  it("preserves explicit limits when the provider ID matches but its name is stale", () => {
    const { result, config, hash } = runReconcile(
      {
        agents: { defaults: { model: { primary: "inference/nvidia/synced" } } },
        models: {
          providers: {
            inference: {
              api: "openai-completions",
              models: [
                {
                  id: "nvidia/synced",
                  name: "inference/stale-name",
                  contextWindow: 131072,
                  maxTokens: 4096,
                },
              ],
            },
          },
        },
      },
      { gatewayModel: "nvidia/synced" },
    );

    expect(result.status).toBe(0);
    expect(config.models.providers.inference.models[0]).toMatchObject({
      id: "nvidia/synced",
      name: "inference/nvidia/synced",
      contextWindow: 131072,
      maxTokens: 4096,
    });
    expect(hash).not.toBe("oldhash\n");
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

  it("warns and falls back to the in-file reconcile for malformed gateway output", () => {
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
    expect(result.stderr).toContain("openshell returned malformed inference output");
    expect(result.stderr).not.toContain("<html>");
  });

  it.each([
    ["unsafe characters", "model;unsafe"],
    ["an oversized identifier", "m".repeat(513)],
  ])("rejects %s from the gateway without logging the value", (_, gatewayModel) => {
    const { result, config, hash } = runReconcile(
      {
        agents: { defaults: { model: { primary: "inference/old-model" } } },
        models: {
          providers: {
            inference: {
              models: [{ id: "safe-file-model", name: "inference/safe-file-model" }],
            },
          },
        },
      },
      { gatewayModel },
    );

    expect(result.status).toBe(0);
    expect(config.agents.defaults.model.primary).toBe("inference/safe-file-model");
    expect(hash).not.toBe("oldhash\n");
    expect(result.stderr).toContain("rejected an unsafe model identifier");
    expect(result.stderr).not.toContain(gatewayModel);
  });

  it("warns and falls back when the gateway probe command fails", () => {
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
      { gatewayRawOutput: "provider-secret-output", gatewayExitCode: 7 },
    );

    expect(result.status).toBe(0);
    expect(config.agents.defaults.model.primary).toBe("inference/file-model");
    expect(result.stderr).toContain("exited with status 7");
    expect(result.stderr).not.toContain("provider-secret-output");
  });

  it("warns and falls back when the gateway probe times out", () => {
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
      { gatewayModel: "delayed-model", gatewayDelaySeconds: 4 },
    );

    expect(result.status).toBe(0);
    expect(config.agents.defaults.model.primary).toBe("inference/file-model");
    expect(result.stderr).toContain("timed out");
  });

  it.each(["config", "hash"] as const)("fails closed for a symlinked %s path", (symlink) => {
    const { result, config, hash } = runReconcile(
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
      { gatewayModel: "gateway-model", symlink },
    );

    expect(result.status).toBe(1);
    expect(config.agents.defaults.model.primary).toBe("inference/old-model");
    expect(hash).toBe("oldhash\n");
    expect(result.stderr).toContain("config, hash, or receipt path is a symlink");
  });

  it("propagates a hash refresh failure after the config write", () => {
    const { result, config, hash } = runReconcile(
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
      { gatewayModel: "gateway-model", hashFailure: true },
    );

    expect(result.status).toBe(19);
    expect(config.agents.defaults.model.primary).toBe("inference/gateway-model");
    expect(hash).toBe("oldhash\n");
  });

  it("repairs the stale hash when reconciliation retries after a hash refresh failure", () => {
    const { result, config, hash, expectedHash } = runReconcile(
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
      { gatewayModel: "gateway-model", hashFailure: "once" },
    );

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(config.agents.defaults.model.primary).toBe("inference/gateway-model");
    expect(hash).toBe(expectedHash);
  });
});
