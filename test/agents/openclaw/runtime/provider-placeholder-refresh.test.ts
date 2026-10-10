// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSON5 from "json5";
import { describe, expect, it, vi } from "vitest";
import { extractShellFunctionFromSource } from "../../../helpers/shell-source";

const START_SCRIPT = path.resolve(import.meta.dirname, "../../../../scripts/nemoclaw-start.sh");
const JSON5_MODULE = path.resolve(import.meta.dirname, "../../../../nemoclaw/node_modules/json5");

vi.setConfig({ maxConcurrency: 4 });

function execFileResult(file, args, options) {
  return new Promise((resolve) =>
    execFile(file, args, options, (error, stdout, stderr) =>
      resolve({
        status: Number(error?.code) || (error ? -1 : 0),
        stdout,
        stderr,
      }),
    ),
  );
}

describe.concurrent("provider placeholder refresh (#4251)", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  const extraPlaceholderKeys = require(
    path.join(
      import.meta.dirname,
      "../../../..",
      "src",
      "lib",
      "onboard",
      "extra-placeholder-keys.ts",
    ),
  );
  const canonicalKeys: string[] = Array.from(
    extraPlaceholderKeys.canonicalPlaceholderKeys(),
  ).sort();
  async function runRefresh(
    config: unknown,
    env: Record<string, string> = {},
    rootMode = false,
    runtimePlan: unknown = { credentialBindings: [] },
  ) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-provider-placeholders-"));
    try {
      const openclawDir = path.join(tmpDir, ".openclaw");
      const configPath = path.join(openclawDir, "openclaw.json");
      const handoffEnvPath = path.join(tmpDir, "handoff-env");
      const runtimePlanPath = path.join(tmpDir, "messaging-runtime-plan.json");
      const scriptPath = path.join(tmpDir, "run.sh");
      fs.mkdirSync(openclawDir, { recursive: true });
      fs.writeFileSync(
        configPath,
        `// Native OpenClaw JSON5\n${JSON.stringify(config, null, 2)}\n`,
      );
      fs.writeFileSync(runtimePlanPath, JSON.stringify(runtimePlan));
      const fn = extractShellFunctionFromSource(src, "refresh_openclaw_provider_placeholders")
        .replaceAll("/sandbox/.openclaw", openclawDir)
        .replaceAll("/usr/local/share/nemoclaw/messaging-runtime-plan.json", runtimePlanPath)
        .replaceAll("/usr/local/lib/node_modules/openclaw/node_modules/json5", JSON5_MODULE)
        .replaceAll("/usr/local/bin/node", process.execPath);
      fs.writeFileSync(
        scriptPath,
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail\nrefresh_openclaw_wechat_account_placeholder() { :; }",
          ...(rootMode
            ? [
                "id() { printf '0\\n'; }",
                `STEP_DOWN_PREFIX_SANDBOX=(/bin/bash -c 'env >${JSON.stringify(handoffEnvPath)}; exec "$@"' sandbox-step-down)`,
                extractShellFunctionFromSource(src, "run_openclaw_config_as_owner"),
              ]
            : ['run_openclaw_config_as_owner() { "$@"; }']),
          fn,
          "refresh_openclaw_provider_placeholders",
        ].join("\n"),
        { mode: 0o700 },
      );
      const result = await execFileResult("bash", [scriptPath], {
        encoding: "utf-8",
        env: { PATH: process.env.PATH || "", ...env },
        timeout: 5000,
      });
      const updatedConfig = JSON5.parse(fs.readFileSync(configPath, "utf-8"));
      const handoffEnv = fs.existsSync(handoffEnvPath)
        ? fs.readFileSync(handoffEnvPath, "utf-8")
        : "";
      return { config: updatedConfig, handoffEnv, result };
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  function placeholderPlan(envKeys: string[]): string {
    return Buffer.from(
      JSON.stringify({
        credentialBindings: envKeys.map((envKey) => ({
          providerEnvKey: envKey,
        })),
      }),
    ).toString("base64");
  }

  it("withholds raw provider values from the root-to-sandbox config handoff", async () => {
    const rawToken = "SENTINEL_RAW_PROVIDER_VALUE";
    const run = await runRefresh(
      {
        channels: {
          telegram: {
            accounts: {
              default: { botToken: "openshell:resolve:env:TELEGRAM_BOT_TOKEN" },
            },
          },
        },
      },
      {
        NEMOCLAW_MESSAGING_PLAN_B64: placeholderPlan(["TELEGRAM_BOT_TOKEN"]),
        TELEGRAM_BOT_TOKEN: rawToken,
      },
      true,
    );

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.config.channels.telegram.accounts.default.botToken).toBe(
      "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
    );
    expect(run.result.stderr).toContain("refusing to write raw credentials");
    expect(run.handoffEnv).not.toContain(rawToken);
    expect(run.handoffEnv).not.toContain("TELEGRAM_BOT_TOKEN");
  });

  it("rewrites Telegram canonical placeholders to OpenShell runtime-scoped placeholders", async () => {
    const scoped = "openshell:resolve:env:v42_TELEGRAM_BOT_TOKEN";
    const run = await runRefresh(
      {
        channels: {
          telegram: {
            accounts: {
              default: {
                botToken: "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
              },
            },
          },
        },
      },
      { TELEGRAM_BOT_TOKEN: scoped },
    );

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.config.channels.telegram.accounts.default.botToken).toBe(scoped);
    expect(run.result.stderr).toContain(
      "Refreshed provider placeholders from OpenShell runtime env: TELEGRAM_BOT_TOKEN",
    );
    expect(run.result.stderr).not.toContain("v42_TELEGRAM_BOT_TOKEN");
  });

  it.each([false, true])(
    "refreshes a persisted native NVIDIA handle after provider revision and supervisor restart (root=%s)",
    async (rootMode) => {
      const oldHandle = "openshell:resolve:env:v42_NVIDIA_INFERENCE_API_KEY";
      const currentHandle = "openshell:resolve:env:v43_NVIDIA_INFERENCE_API_KEY";
      const run = await runRefresh(
        {
          models: {
            providers: {
              inference: {
                baseUrl: "https://integrate.api.nvidia.com/v1",
                apiKey: oldHandle,
              },
            },
          },
          channels: { telegram: { botToken: oldHandle } },
        },
        { NVIDIA_INFERENCE_API_KEY: currentHandle },
        rootMode,
      );

      expect(run.result.status, run.result.stderr).toBe(0);
      expect(run.config.models.providers.inference.apiKey).toBe(currentHandle);
      expect(run.config.channels.telegram.botToken).toBe(oldHandle);
      expect(run.result.stderr).toContain(
        "Refreshed provider placeholders from OpenShell runtime env: NVIDIA_INFERENCE_API_KEY",
      );
    },
  );

  it.each([
    {
      reason: "raw credential in root environment",
      endpoint: "https://integrate.api.nvidia.com/v1",
      runtime: "nvapi-raw-secret",
      rootMode: true,
    },
    {
      reason: "different endpoint",
      endpoint: "https://example.com/v1",
      runtime: "openshell:resolve:env:v43_NVIDIA_INFERENCE_API_KEY",
      rootMode: false,
    },
    {
      reason: "missing runtime handle",
      endpoint: "https://integrate.api.nvidia.com/v1",
      runtime: "",
      rootMode: false,
    },
  ])(
    "keeps a persisted native NVIDIA handle when refresh has $reason",
    async ({ endpoint, runtime, rootMode }) => {
      const saved = "openshell:resolve:env:v42_NVIDIA_INFERENCE_API_KEY";
      const run = await runRefresh(
        { models: { providers: { inference: { baseUrl: endpoint, apiKey: saved } } } },
        runtime ? { NVIDIA_INFERENCE_API_KEY: runtime } : {},
        rootMode,
      );

      expect(run.result.status, run.result.stderr).toBe(0);
      expect(run.config.models.providers.inference.apiKey).toBe(saved);
      expect(JSON.stringify(run.config)).not.toContain("nvapi-raw-secret");
      expect(run.result.stderr).not.toContain("nvapi-raw-secret");
      expect(run.handoffEnv).not.toContain("nvapi-raw-secret");
    },
  );

  it("does not write raw provider credentials into openclaw.json", async () => {
    const run = await runRefresh(
      {
        channels: {
          telegram: {
            accounts: {
              default: {
                botToken: "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
              },
            },
          },
        },
      },
      { TELEGRAM_BOT_TOKEN: "123456:SECRET" },
    );

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.config.channels.telegram.accounts.default.botToken).toBe(
      "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
    );
    expect(JSON.stringify(run.config)).not.toContain("123456:SECRET");
    expect(run.result.stderr).toContain("refusing to write raw credentials");
  });

  it("warns when Telegram is configured but the runtime placeholder env is missing", async () => {
    const run = await runRefresh({
      channels: {
        telegram: {
          accounts: {
            default: {
              botToken: "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
            },
          },
        },
      },
    });

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.result.stderr).toContain(
      "telegram.default.botToken is an OpenShell placeholder but TELEGRAM_BOT_TOKEN is missing",
    );
  });

  it("warns when the Slack config alias is present but SLACK_BOT_TOKEN is missing", async () => {
    const run = await runRefresh({
      channels: {
        slack: {
          accounts: {
            default: {
              botToken: "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
              appToken: "xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN",
            },
          },
        },
      },
    });

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.result.stderr).toContain(
      "slack.default.botToken expects the SLACK_BOT_TOKEN provider placeholder but it is missing",
    );
    expect(run.result.stderr).toContain(
      "slack.default.appToken expects the SLACK_APP_TOKEN provider placeholder but it is missing",
    );
  });

  it.each(["v42", `s${"a".repeat(64)}`])(
    "does not warn when the Slack config alias matches an OpenShell %s runtime placeholder",
    async (credentialHandle) => {
      const run = await runRefresh(
        {
          channels: {
            slack: {
              accounts: {
                default: {
                  botToken: "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
                  appToken: "xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN",
                },
              },
            },
          },
        },
        {
          SLACK_BOT_TOKEN: `openshell:resolve:env:${credentialHandle}_SLACK_BOT_TOKEN`,
          SLACK_APP_TOKEN: `openshell:resolve:env:${credentialHandle}_SLACK_APP_TOKEN`,
        },
      );

      expect(run.result.status, run.result.stderr).toBe(0);
      expect(run.result.stderr).not.toContain("slack.default");
      expect(run.config.channels.slack.accounts.default.botToken).toBe(
        `xoxb-OPENSHELL-RESOLVE-ENV-${credentialHandle}_SLACK_BOT_TOKEN`,
      );
      expect(run.config.channels.slack.accounts.default.appToken).toBe(
        `xapp-OPENSHELL-RESOLVE-ENV-${credentialHandle}_SLACK_APP_TOKEN`,
      );
    },
  );

  it("does not warn when the Slack runtime env holds a genuine xoxb-/xapp- token", async () => {
    const run = await runRefresh(
      {
        channels: {
          slack: {
            accounts: {
              default: {
                botToken: "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
                appToken: "xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN",
              },
            },
          },
        },
      },
      {
        SLACK_BOT_TOKEN: "xoxb-1-real-bot-token",
        SLACK_APP_TOKEN: "xapp-1-real-app-token",
      },
    );

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.result.stderr).not.toContain("slack.default");
    expect(JSON.stringify(run.config)).not.toContain("xoxb-1-real-bot-token");
  });

  it("warns when the Slack runtime env holds neither a placeholder nor a Slack token", async () => {
    const run = await runRefresh(
      {
        channels: {
          slack: {
            accounts: {
              default: {
                botToken: "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
              },
            },
          },
        },
      },
      { SLACK_BOT_TOKEN: "garbage-not-a-token" },
    );

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.result.stderr).toContain(
      "slack.default.botToken runtime SLACK_BOT_TOKEN is neither the SLACK_BOT_TOKEN OpenShell placeholder nor a xoxb- token",
    );
  });

  it("warns when the Slack runtime env resolves a different key than expected", async () => {
    const run = await runRefresh(
      {
        channels: {
          slack: {
            accounts: {
              default: {
                botToken: "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
              },
            },
          },
        },
      },
      { SLACK_BOT_TOKEN: "openshell:resolve:env:v51_OTHER_KEY" },
    );

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.result.stderr).toContain(
      "slack.default.botToken runtime SLACK_BOT_TOKEN is neither the SLACK_BOT_TOKEN OpenShell placeholder nor a xoxb- token",
    );
  });

  it("emits the accepted-extras signal from canonical keys in the default runtime plan (#10967)", async () => {
    const run = await runRefresh(
      {},
      {
        NEMOCLAW_MESSAGING_RUNTIME_PLAN_PATH: "",
        NEMOCLAW_EXTRA_PLACEHOLDER_KEYS: "TELEGRAM_BOT_TOKEN_AGENT_A",
      },
      false,
      { credentialBindings: [{ providerEnvKey: "TELEGRAM_BOT_TOKEN" }] },
    );

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.result.stderr).toMatch(/accepted 1 entry\(ies\): TELEGRAM_BOT_TOKEN_AGENT_A/u);
  });

  it("does not emit the accepted-extras breadcrumb when NEMOCLAW_EXTRA_PLACEHOLDER_KEYS is unset", async () => {
    const run = await runRefresh(
      {
        channels: {
          telegram: {
            accounts: {
              default: { botToken: "openshell:resolve:env:TELEGRAM_BOT_TOKEN" },
            },
          },
        },
      },
      {},
    );

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.result.stderr).not.toContain("[config] NEMOCLAW_EXTRA_PLACEHOLDER_KEYS accepted");
  });

  it("splits NEMOCLAW_EXTRA_PLACEHOLDER_KEYS on commas the same way as whitespace", async () => {
    const scopedA = "openshell:resolve:env:v42_TELEGRAM_BOT_TOKEN_AGENT_A";
    const scopedB = "openshell:resolve:env:v42_TELEGRAM_BOT_TOKEN_AGENT_B";
    const run = await runRefresh(
      {
        channels: {
          telegram: {
            accounts: {
              a: {
                botToken: "openshell:resolve:env:TELEGRAM_BOT_TOKEN_AGENT_A",
              },
              b: {
                botToken: "openshell:resolve:env:TELEGRAM_BOT_TOKEN_AGENT_B",
              },
            },
          },
        },
      },
      {
        // Comma- and whitespace-mixed input — the bash for-loop only splits on
        // default IFS (whitespace), so without the comma->space normalization
        // both keys would arrive concatenated as a single token and fail the
        // regex check.
        NEMOCLAW_EXTRA_PLACEHOLDER_KEYS: "TELEGRAM_BOT_TOKEN_AGENT_A,TELEGRAM_BOT_TOKEN_AGENT_B",
        TELEGRAM_BOT_TOKEN_AGENT_A: scopedA,
        TELEGRAM_BOT_TOKEN_AGENT_B: scopedB,
      },
    );

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.config.channels.telegram.accounts.a.botToken).toBe(scopedA);
    expect(run.config.channels.telegram.accounts.b.botToken).toBe(scopedB);
    expect(run.result.stderr).toContain(
      "Refreshed provider placeholders from OpenShell runtime env: TELEGRAM_BOT_TOKEN_AGENT_A,TELEGRAM_BOT_TOKEN_AGENT_B",
    );
  });

  it("revision-collapses NEMOCLAW_EXTRA_PLACEHOLDER_KEYS entries the same way as canonical keys", async () => {
    const scoped = "openshell:resolve:env:v42_TELEGRAM_BOT_TOKEN_AGENT_A";
    const run = await runRefresh(
      {
        channels: {
          telegram: {
            accounts: {
              default: {
                botToken: "openshell:resolve:env:TELEGRAM_BOT_TOKEN_AGENT_A",
              },
            },
          },
        },
      },
      {
        NEMOCLAW_EXTRA_PLACEHOLDER_KEYS: "TELEGRAM_BOT_TOKEN_AGENT_A",
        TELEGRAM_BOT_TOKEN_AGENT_A: scoped,
      },
    );

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.config.channels.telegram.accounts.default.botToken).toBe(scoped);
    expect(run.result.stderr).toContain(
      "Refreshed provider placeholders from OpenShell runtime env: TELEGRAM_BOT_TOKEN_AGENT_A",
    );
  });

  it("does not let canonical TELEGRAM_BOT_TOKEN rewrite the suffixed extra placeholder", async () => {
    // Pre-fix bug: the python rewrite did `if old in value: value.replace(old, new)`,
    // so the canonical replacement for `openshell:resolve:env:TELEGRAM_BOT_TOKEN`
    // greedily rewrote the prefix of `openshell:resolve:env:TELEGRAM_BOT_TOKEN_AGENT_A`,
    // routing the per-profile placeholder to the wrong canonical revision and
    // making rotation of an extra key unsafe. The grammar-aware regex now
    // matches each placeholder as an exact token only.
    const canonicalScoped = "openshell:resolve:env:v42_TELEGRAM_BOT_TOKEN";
    const extraScoped = "openshell:resolve:env:v51_TELEGRAM_BOT_TOKEN_AGENT_A";
    const run = await runRefresh(
      {
        channels: {
          telegram: {
            accounts: {
              default: { botToken: "openshell:resolve:env:TELEGRAM_BOT_TOKEN" },
              agentA: {
                botToken: "openshell:resolve:env:TELEGRAM_BOT_TOKEN_AGENT_A",
              },
            },
          },
        },
      },
      {
        TELEGRAM_BOT_TOKEN: canonicalScoped,
        NEMOCLAW_EXTRA_PLACEHOLDER_KEYS: "TELEGRAM_BOT_TOKEN_AGENT_A",
        TELEGRAM_BOT_TOKEN_AGENT_A: extraScoped,
      },
    );

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.config.channels.telegram.accounts.default.botToken).toBe(canonicalScoped);
    expect(run.config.channels.telegram.accounts.agentA.botToken).toBe(extraScoped);
  });

  it("leaves the suffixed extra placeholder unchanged when only the canonical revision is set", async () => {
    // Companion to the canonical-vs-extra collision test: when the operator
    // staged a revision for TELEGRAM_BOT_TOKEN but not for the extra key,
    // the extra placeholder must stay on its canonical form rather than be
    // partially rewritten by the prefix replacement.
    const canonicalScoped = "openshell:resolve:env:v42_TELEGRAM_BOT_TOKEN";
    const run = await runRefresh(
      {
        channels: {
          telegram: {
            accounts: {
              default: { botToken: "openshell:resolve:env:TELEGRAM_BOT_TOKEN" },
              agentA: {
                botToken: "openshell:resolve:env:TELEGRAM_BOT_TOKEN_AGENT_A",
              },
            },
          },
        },
      },
      {
        TELEGRAM_BOT_TOKEN: canonicalScoped,
        NEMOCLAW_EXTRA_PLACEHOLDER_KEYS: "TELEGRAM_BOT_TOKEN_AGENT_A",
      },
    );

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.config.channels.telegram.accounts.default.botToken).toBe(canonicalScoped);
    expect(run.config.channels.telegram.accounts.agentA.botToken).toBe(
      "openshell:resolve:env:TELEGRAM_BOT_TOKEN_AGENT_A",
    );
  });

  it("rejects malformed and canonical-collision NEMOCLAW_EXTRA_PLACEHOLDER_KEYS entries without faulting", async () => {
    const run = await runRefresh(
      {
        channels: {
          telegram: {
            accounts: {
              default: {
                botToken: "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
              },
            },
          },
        },
      },
      {
        TELEGRAM_BOT_TOKEN: "openshell:resolve:env:v42_TELEGRAM_BOT_TOKEN",
        NEMOCLAW_EXTRA_PLACEHOLDER_KEYS:
          "telegram_bot_token 9NUM_START Path$Bad TELEGRAM_BOT_TOKEN TELEGRAM_BOT_TOKEN_VALID",
      },
    );

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.result.stderr).toContain(
      "[config] Ignoring NEMOCLAW_EXTRA_PLACEHOLDER_KEYS entry 'telegram_bot_token'",
    );
    expect(run.result.stderr).toContain(
      "[config] Ignoring NEMOCLAW_EXTRA_PLACEHOLDER_KEYS entry '9NUM_START'",
    );
    expect(run.result.stderr).toContain(
      "[config] Ignoring NEMOCLAW_EXTRA_PLACEHOLDER_KEYS entry 'Path$Bad'",
    );
    // Canonical-collision tokens are filtered silently by the case statement.
    expect(run.result.stderr).not.toContain(
      "[config] Ignoring NEMOCLAW_EXTRA_PLACEHOLDER_KEYS entry 'TELEGRAM_BOT_TOKEN'",
    );
    // The canonical-key revision-collapse still runs end-to-end.
    expect(run.config.channels.telegram.accounts.default.botToken).toBe(
      "openshell:resolve:env:v42_TELEGRAM_BOT_TOKEN",
    );
  });

  it.each([
    "GITHUB_TOKEN",
    "AWS_SECRET_ACCESS_KEY",
    "NPM_TOKEN",
    "KUBECONFIG",
    "NEMOCLAW_EXTRA_PLACEHOLDER_KEYS",
  ])(
    "refuses arbitrary host secret names that do not extend a discovered provider envKey inside the sandbox [%s]",
    async (blocked) => {
      // Defence-in-depth: even if an operator clobbers NEMOCLAW_EXTRA_PLACEHOLDER_KEYS
      // inside a running sandbox after the host-side parser already filtered it,
      // the container-side refresh helper must mirror the host's canonical-prefix
      // restriction so a noncanonical name such as GITHUB_TOKEN never reaches the
      // python placeholder walker.
      const run = await runRefresh(
        {
          channels: {
            telegram: {
              accounts: {
                default: {
                  botToken: "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
                },
              },
            },
          },
        },
        {
          TELEGRAM_BOT_TOKEN: "openshell:resolve:env:v42_TELEGRAM_BOT_TOKEN",
          NEMOCLAW_EXTRA_PLACEHOLDER_KEYS:
            "GITHUB_TOKEN AWS_SECRET_ACCESS_KEY NPM_TOKEN KUBECONFIG NEMOCLAW_EXTRA_PLACEHOLDER_KEYS TELEGRAM_BOT_TOKEN_KEPT",
          // Stage host secrets that would leak if the bash refresh ever
          // accepted their names. The assertion below confirms none of these
          // values appear in any output produced by the python heredoc.
          GITHUB_TOKEN: "ghp-host-secret-would-leak",
          AWS_SECRET_ACCESS_KEY: "aws-host-secret-would-leak",
          NPM_TOKEN: "npm-host-secret-would-leak",
          KUBECONFIG: "/host/path/would-leak",
        },
      );

      expect(run.result.status, run.result.stderr).toBe(0);

      expect(run.result.stderr).toContain(
        `[config] Ignoring NEMOCLAW_EXTRA_PLACEHOLDER_KEYS entry '${blocked}' — must extend a discovered provider envKey such as TELEGRAM_BOT_TOKEN_<suffix>`,
      );

      expect(run.result.stderr).not.toContain(
        "[config] Ignoring NEMOCLAW_EXTRA_PLACEHOLDER_KEYS entry 'TELEGRAM_BOT_TOKEN_KEPT'",
      );
      // None of the staged host secret values should reach any stdout/stderr
      // line the python heredoc emits, because their names were rejected before
      // the heredoc ran.
      expect(run.result.stderr).not.toContain("ghp-host-secret-would-leak");
      expect(run.result.stderr).not.toContain("aws-host-secret-would-leak");
      expect(run.result.stderr).not.toContain("npm-host-secret-would-leak");
      expect(run.result.stdout).not.toContain("ghp-host-secret-would-leak");
      expect(run.result.stdout).not.toContain("aws-host-secret-would-leak");
      expect(run.result.stdout).not.toContain("npm-host-secret-would-leak");
      expect(JSON.stringify(run.config)).not.toContain("ghp-host-secret-would-leak");
      expect(JSON.stringify(run.config)).not.toContain("aws-host-secret-would-leak");
    },
  );

  it.each(canonicalKeys)(
    "accepts manifest credential envKey %s as an extension prefix",
    async (canonical) => {
      // Behavioural parity guard: the in-container parser should not hardcode
      // channel env keys. It consumes the messaging plan's credentialBindings,
      // then accepts a per-profile extension for each discovered key.
      const extension = `${canonical}_PARITY`;
      const scoped = `openshell:resolve:env:v77_${extension}`;
      const run = await runRefresh(
        {
          channels: {
            telegram: {
              accounts: {
                parity: { botToken: `openshell:resolve:env:${extension}` },
              },
            },
          },
        },
        {
          NEMOCLAW_MESSAGING_PLAN_B64: placeholderPlan([canonical]),
          NEMOCLAW_EXTRA_PLACEHOLDER_KEYS: extension,
          [extension]: scoped,
        },
      );

      expect(run.result.status, run.result.stderr).toBe(0);
      expect(
        run.result.stderr,
        `bash refresh refused manifest credential extension '${extension}'`,
      ).not.toContain(`[config] Ignoring NEMOCLAW_EXTRA_PLACEHOLDER_KEYS entry '${extension}'`);
      expect(run.config.channels.telegram.accounts.parity.botToken).toBe(scoped);
    },
  );

  it("caps NEMOCLAW_EXTRA_PLACEHOLDER_KEYS at 32 entries inside the sandbox", async () => {
    // The first 32 extension keys are accepted; the planted 33rd must remain unchanged.
    const tokens = Array.from({ length: 33 }, (_, i) => `TELEGRAM_BOT_TOKEN_FILLER_${i}`);
    const beyondCap = tokens[32];
    const beyondCapScoped = `openshell:resolve:env:v42_${beyondCap}`;
    const env: Record<string, string> = {
      NEMOCLAW_EXTRA_PLACEHOLDER_KEYS: tokens.join(" "),
      // Only the 33rd key has a scoped value, so any rewrite proves the cap was exceeded.
      [beyondCap]: beyondCapScoped,
      // Deliberately leave TELEGRAM_BOT_TOKEN / DISCORD_BOT_TOKEN / etc.
      // unset so no canonical replacement is added; that sidesteps the
      // python heredoc's substring-match path which would otherwise let a
      // shorter canonical replacement bleed into beyondCap regardless of
      // the cap state.
    };
    const run = await runRefresh(
      {
        channels: {
          telegram: {
            accounts: {
              default: {
                botToken: "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
              },
              beyondCap: {
                botToken: `openshell:resolve:env:${beyondCap}`,
              },
            },
          },
        },
      },
      env,
    );

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.result.stderr).toContain(
      "[config] NEMOCLAW_EXTRA_PLACEHOLDER_KEYS: capped at 32 entries; ignoring remainder",
    );
    // The beyondCap key must not be processed by the python heredoc, so the
    // beyondCap canonical placeholder must stay unchanged on disk.
    expect(run.config.channels.telegram.accounts.beyondCap.botToken).toBe(
      `openshell:resolve:env:${beyondCap}`,
    );
    expect(run.result.stderr).not.toContain(
      `Refreshed provider placeholders from OpenShell runtime env: ${beyondCap}`,
    );
    expect(run.result.stdout).not.toContain(beyondCapScoped);
  });
});
