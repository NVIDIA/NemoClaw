// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Functional tests for src/lib/messaging/applier/build/messaging-build-applier.mts.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyMessagingBuildPhase,
  describeMessagingBuildPhase,
  type MessagingBuildPhase,
  readMessagingBuildPlanFromEnv,
} from "../src/lib/messaging/applier/build/messaging-build-applier.mts";
import { execTimeout, testTimeout } from "./helpers/timeouts";
import { withLegacyMessagingPlanEnvDirect } from "./messaging-plan-test-helper";

const SCRIPT_PATH = path.join(
  import.meta.dirname,
  "..",
  "src",
  "lib",
  "messaging",
  "applier",
  "build",
  "messaging-build-applier.mts",
);
const GENERATOR_PATH = path.join(
  import.meta.dirname,
  "..",
  "scripts",
  "generate-openclaw-config.mts",
);
const OPENCLAW_DISCORD_2026_6_10_INTEGRITY =
  "sha512-NKp/j00l+rk5PC0Lv/0fOIiiQJ1c/OpG9471zqXUDKQie6pQ1Fi9KUZUouyoTMmfLh/n4S0CkEMqrON40eBKXA==";
const OPENCLAW_SLACK_2026_6_10_INTEGRITY =
  "sha512-OOsMLjPcbWhQRM5XDwfdrACjJmKqavFtpuIlhHAXWrLrd/p7SyIVE9AoKS0yxOx6bqGDIMJ9+knzdViHMLgBdA==";
const OPENCLAW_WHATSAPP_2026_6_10_INTEGRITY =
  "sha512-k/XrRdZY77SHrdaRwJOEB7/JRbjp4yVgGD/ZNyakjTMqo32XRVtwPBUnj7726rW8Kl5yyOMQQLKFiD9MDfhmPQ==";
const OPENCLAW_MSTEAMS_2026_6_10_INTEGRITY =
  "sha512-GjHnCPvjbnI0C7mEFcdT2uKDH4/WwOe2dZBfQiWxBtkE76m6TNG0J9dJjD4mc8/pk8rXSO0cWw+KV9jzWtF9VA==";
const TENCENT_WEIXIN_2_4_3_INTEGRITY =
  "sha512-dPQbidUNWigC6V10vGW4i+GLH09x+6zUhafZRjuxkJ9GDu8o62WBsnUTojp4KqUH756hz+t2v9khiCRSi0dBDw==";
const TEST_PATH = process.env.PATH || "/usr/bin:/bin";

function fakeOpenClawPluginNpmPackScriptLines(): string[] {
  return [
    'if [ "${1:-}" = "view" ] && [ "${3:-}" = "dist.tarball" ]; then',
    '  case "${2:-}" in',
    '    "@openclaw/discord@2026.6.10") printf "%s\\n" "https://registry.npmjs.org/@openclaw/discord/-/discord-2026.6.10.tgz"; exit 0 ;;',
    '    "@tencent-weixin/openclaw-weixin@2.4.3") printf "%s\\n" "https://registry.npmjs.org/@tencent-weixin/openclaw-weixin/-/openclaw-weixin-2.4.3.tgz"; exit 0 ;;',
    '    "@openclaw/slack@2026.6.10") printf "%s\\n" "https://registry.npmjs.org/@openclaw/slack/-/slack-2026.6.10.tgz"; exit 0 ;;',
    '    "@openclaw/whatsapp@2026.6.10") printf "%s\\n" "https://registry.npmjs.org/@openclaw/whatsapp/-/whatsapp-2026.6.10.tgz"; exit 0 ;;',
    '    "@openclaw/msteams@2026.6.10") printf "%s\\n" "https://registry.npmjs.org/@openclaw/msteams/-/msteams-2026.6.10.tgz"; exit 0 ;;',
    "    *) exit 1 ;;",
    "  esac",
    "fi",
    'if [ "${1:-}" = "pack" ]; then',
    '  pack_dir="${4:-}";',
    '  case "${2:-}" in',
    '    "@openclaw/discord@2026.6.10") pack_file="discord-2026.6.10.tgz"; pack_integrity="${OPENCLAW_DISCORD_INTEGRITY:-${OPENCLAW_DISCORD_2026_6_10_INTEGRITY:-}}" ;;',
    '    "@tencent-weixin/openclaw-weixin@2.4.3") pack_file="openclaw-weixin-2.4.3.tgz"; pack_integrity="${TENCENT_WEIXIN_2_4_3_INTEGRITY:-}" ;;',
    '    "@openclaw/slack@2026.6.10") pack_file="slack-2026.6.10.tgz"; pack_integrity="${OPENCLAW_SLACK_INTEGRITY:-${OPENCLAW_SLACK_2026_6_10_INTEGRITY:-}}" ;;',
    '    "@openclaw/whatsapp@2026.6.10") pack_file="whatsapp-2026.6.10.tgz"; pack_integrity="${OPENCLAW_WHATSAPP_2026_6_10_INTEGRITY:-}" ;;',
    '    "@openclaw/msteams@2026.6.10") pack_file="msteams-2026.6.10.tgz"; pack_integrity="${OPENCLAW_MSTEAMS_2026_6_10_INTEGRITY:-}" ;;',
    "    *) exit 1 ;;",
    "  esac",
    '  test -n "$pack_dir"; test -n "$pack_integrity";',
    '  if [ -n "${OPENCLAW_PACK_INTEGRITY_OVERRIDE:-}" ]; then pack_integrity="$OPENCLAW_PACK_INTEGRITY_OVERRIDE"; fi',
    '  printf "fake plugin tarball" > "$pack_dir/$pack_file";',
    '  printf \'[{"filename":"%s","integrity":"%s"}]\\n\' "$pack_file" "$pack_integrity";',
    "  exit 0",
    "fi",
  ];
}

const BASE_GENERATOR_ENV: Record<string, string> = {
  NEMOCLAW_MODEL: "test-model",
  NEMOCLAW_PROVIDER_KEY: "test-provider",
  NEMOCLAW_PRIMARY_MODEL_REF: "test-ref",
  CHAT_UI_URL: "http://127.0.0.1:18789",
  NEMOCLAW_INFERENCE_BASE_URL: "http://localhost:8080",
  NEMOCLAW_INFERENCE_API: "openai",
  NEMOCLAW_INFERENCE_COMPAT_B64: Buffer.from("{}").toString("base64"),
  NEMOCLAW_PROXY_HOST: "10.200.0.1",
  NEMOCLAW_PROXY_PORT: "3128",
  NEMOCLAW_CONTEXT_WINDOW: "131072",
  NEMOCLAW_MAX_TOKENS: "4096",
  NEMOCLAW_REASONING: "false",
  NEMOCLAW_AGENT_TIMEOUT: "600",
};

function channelsB64(channels: string[]): string {
  return Buffer.from(JSON.stringify(channels)).toString("base64");
}

function wechatConfigB64(overrides: Record<string, string> = {}): string {
  return Buffer.from(
    JSON.stringify({
      accountId: "primary",
      baseUrl: "https://ilinkai.wechat.com",
      userId: "u1",
      ...overrides,
    }),
  ).toString("base64");
}

function teamsConfigB64(overrides: Record<string, string | string[]> = {}): string {
  return Buffer.from(
    JSON.stringify({
      appId: "test-teams-app-id",
      tenantId: "test-teams-tenant-id",
      allowedUsers: ["00000000-0000-0000-0000-000000000001"],
      webhookPort: "3978",
      ...overrides,
    }),
  ).toString("base64");
}

async function buildPlanEnv(
  envOverrides: Record<string, string> = {},
  agent: "hermes" | "openclaw" = "openclaw",
): Promise<Record<string, string>> {
  return withLegacyMessagingPlanEnvDirect(
    {
      PATH: TEST_PATH,
      ...envOverrides,
    },
    agent,
  );
}

function runApplierProcess(
  env: Record<string, string>,
  agent: "hermes" | "openclaw",
  phase: MessagingBuildPhase,
  dryRun = false,
) {
  return spawnSync(
    "node",
    [
      "--experimental-strip-types",
      SCRIPT_PATH,
      "--agent",
      agent,
      "--phase",
      phase,
      ...(dryRun ? ["--dry-run"] : []),
    ],
    {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env,
      timeout: 10_000,
    },
  );
}

async function describeDryRun(
  envOverrides: Record<string, string> = {},
  agent: "hermes" | "openclaw" = "openclaw",
) {
  const env = await buildPlanEnv(envOverrides, agent);
  return describeMessagingBuildPhase(
    readMessagingBuildPlanFromEnv(env, agent),
    "agent-install",
    env,
  );
}

function decodePlan(encoded: string): any {
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf-8"));
}

function encodePlan(plan: any): string {
  return Buffer.from(JSON.stringify(plan)).toString("base64");
}

function thrownMessage(run: () => void): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected operation to throw");
}

describe("messaging-build-applier.mts: agent-install", () => {
  it(
    "collects selected messaging plugin install specs",
    async () => {
      const env = await buildPlanEnv({
        OPENCLAW_VERSION: "2026.5.22",
        NEMOCLAW_MESSAGING_CHANNELS_B64: channelsB64([
          "telegram",
          "discord",
          "slack",
          "whatsapp",
          "wechat",
          "teams",
        ]),
        NEMOCLAW_WECHAT_CONFIG_B64: wechatConfigB64(),
        NEMOCLAW_TEAMS_CONFIG_B64: teamsConfigB64(),
      });
      const result = runApplierProcess(env, "openclaw", "agent-install", true);
      expect(result.status, result.stderr).toBe(0);
      const payload = JSON.parse(result.stdout);

      expect(payload.installSpecs).toEqual([
        "npm:@openclaw/discord@2026.5.22",
        "npm:@tencent-weixin/openclaw-weixin@2.4.3",
        "npm:@openclaw/slack@2026.5.22",
        "npm:@openclaw/whatsapp@2026.5.22",
        "npm:@openclaw/msteams@2026.5.22",
      ]);
      expect(payload.doctorEnv).toEqual({
        DISCORD_BOT_TOKEN: "openshell:resolve:env:DISCORD_BOT_TOKEN",
        MSTEAMS_APP_PASSWORD: "openshell:resolve:env:MSTEAMS_APP_PASSWORD",
        SLACK_APP_TOKEN: "xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN",
        SLACK_BOT_TOKEN: "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
        TELEGRAM_BOT_TOKEN: "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
        WECHAT_BOT_TOKEN: "openshell:resolve:env:WECHAT_BOT_TOKEN",
      });
    },
    testTimeout(15_000),
  );

  it("does not inject placeholder token env vars for unselected channels", async () => {
    const payload = await describeDryRun({
      OPENCLAW_VERSION: "2026.5.22",
      NEMOCLAW_MESSAGING_CHANNELS_B64: channelsB64(["discord", "discord"]),
    });

    expect(payload.channels).toEqual(["discord"]);
    expect(payload.installSpecs).toEqual(["npm:@openclaw/discord@2026.5.22"]);
    expect(payload.doctorEnv).toEqual({
      DISCORD_BOT_TOKEN: "openshell:resolve:env:DISCORD_BOT_TOKEN",
    });
  });

  it("does not require OPENCLAW_VERSION when no external plugin is selected", async () => {
    const payload = await describeDryRun({
      NEMOCLAW_MESSAGING_CHANNELS_B64: channelsB64(["telegram"]),
    });

    expect(payload.installSpecs).toEqual([]);
    expect(payload.doctorEnv).toEqual({
      TELEGRAM_BOT_TOKEN: "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
    });
  });

  it("installs the fixed WeChat OpenClaw plugin without OPENCLAW_VERSION", async () => {
    const payload = await describeDryRun({
      NEMOCLAW_MESSAGING_CHANNELS_B64: channelsB64(["wechat"]),
      NEMOCLAW_WECHAT_CONFIG_B64: wechatConfigB64(),
    });

    expect(payload.installSpecs).toEqual(["npm:@tencent-weixin/openclaw-weixin@2.4.3"]);
    expect(payload.doctorEnv).toEqual({
      WECHAT_BOT_TOKEN: "openshell:resolve:env:WECHAT_BOT_TOKEN",
    });
  });

  it("forces WhatsApp to the OpenClaw runtime version on 2026.5.18 sandboxes", async () => {
    const payload = await describeDryRun({
      OPENCLAW_VERSION: "2026.5.18",
      NEMOCLAW_MESSAGING_CHANNELS_B64: channelsB64(["whatsapp"]),
    });

    expect(payload.installSpecs).toEqual(["npm:@openclaw/whatsapp@2026.5.18"]);
  });

  it("does not include non-messaging OTEL diagnostics in messaging package installs", async () => {
    const payload = await describeDryRun({
      OPENCLAW_VERSION: "2026.5.22",
      NEMOCLAW_OPENCLAW_OTEL: "1",
    });

    expect(payload.installSpecs).toEqual([]);
  });

  it("preserves the Brave web-search placeholder when doctor runs after messaging render", async () => {
    const payload = await describeDryRun({
      OPENCLAW_VERSION: "2026.5.22",
      NEMOCLAW_WEB_SEARCH_ENABLED: "1",
      NEMOCLAW_MESSAGING_CHANNELS_B64: channelsB64(["slack"]),
    });

    expect(payload.installSpecs).toEqual(["npm:@openclaw/slack@2026.5.22"]);
    expect(payload.doctorEnv.BRAVE_API_KEY).toBe("openshell:resolve:env:BRAVE_API_KEY");
  });

  it("preserves only the selected Tavily placeholder when doctor runs after messaging render", async () => {
    const payload = await describeDryRun({
      OPENCLAW_VERSION: "2026.5.27",
      NEMOCLAW_WEB_SEARCH_ENABLED: "1",
      NEMOCLAW_WEB_SEARCH_PROVIDER: "tavily",
      NEMOCLAW_MESSAGING_CHANNELS_B64: channelsB64(["slack"]),
    });

    expect(payload.doctorEnv.TAVILY_API_KEY).toBe("openshell:resolve:env:TAVILY_API_KEY");
    expect(payload.doctorEnv.BRAVE_API_KEY).toBeUndefined();
  });

  it("rejects an unknown selected web-search provider before running doctor", async () => {
    await expect(
      describeDryRun({
        NEMOCLAW_WEB_SEARCH_ENABLED: "1",
        NEMOCLAW_WEB_SEARCH_PROVIDER: "unknown",
        NEMOCLAW_MESSAGING_CHANNELS_B64: channelsB64(["telegram"]),
      }),
    ).rejects.toThrow("Unsupported NEMOCLAW_WEB_SEARCH_PROVIDER: unknown");
  });

  it("fails fast on malformed messaging plans", () => {
    const env = {
      PATH: TEST_PATH,
      OPENCLAW_VERSION: "2026.5.22",
      NEMOCLAW_MESSAGING_PLAN_B64: "not-base64-json",
    };

    expect(() => readMessagingBuildPlanFromEnv(env, "openclaw")).toThrow(
      "NEMOCLAW_MESSAGING_PLAN_B64",
    );
  });

  it("writes a reduced runtime plan artifact for entrypoint startup", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runtime-plan-artifact-"));
    const artifactPath = path.join(tmp, "runtime", "messaging-runtime-plan.json");
    const plan = {
      schemaVersion: 1,
      sandboxName: "test-sandbox",
      agent: "openclaw",
      workflow: "rebuild",
      channels: [
        {
          channelId: "telegram",
          active: true,
          disabled: false,
          inputs: [{ value: "do-not-persist-input-value" }],
        },
        { channelId: "slack", active: false, disabled: true },
      ],
      disabledChannels: ["slack"],
      credentialBindings: [
        {
          channelId: "telegram",
          credentialId: "telegram-bot-token",
          providerName: "telegram-provider-name",
          providerEnvKey: "TELEGRAM_BOT_TOKEN",
          placeholder: "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
          credentialHash: "do-not-persist-hash",
        },
      ],
      agentRender: [
        {
          channelId: "telegram",
          agent: "openclaw",
          target: "openclaw.json",
          kind: "json-fragment",
          path: "channels.telegram",
          value: { token: "do-not-persist-render-value" },
        },
      ],
      buildSteps: [
        {
          channelId: "telegram",
          kind: "build-file",
          outputId: "seed-file",
          value: { content: "do-not-persist-build-step" },
        },
      ],
      runtimeSetup: {
        nodePreloads: [
          {
            channelId: "telegram",
            module: "telegram-diagnostics",
            source: "/usr/local/lib/nemoclaw/preloads/telegram-diagnostics.js",
            target: "/tmp/nemoclaw-telegram-diagnostics.js",
            injectInto: ["boot", "connect"],
            optional: false,
            installMessage: "[channels] install telegram diagnostics",
            installedMessage: "[channels] installed telegram diagnostics",
          },
        ],
        envAliases: [],
        secretScans: [],
      },
    };

    try {
      const result = spawnSync(
        "node",
        [
          "--experimental-strip-types",
          SCRIPT_PATH,
          "--agent",
          "openclaw",
          "--phase",
          "runtime-setup",
        ],
        {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            PATH: TEST_PATH,
            NEMOCLAW_MESSAGING_RUNTIME_PLAN_PATH: artifactPath,
            NEMOCLAW_MESSAGING_PLAN_B64: Buffer.from(JSON.stringify(plan)).toString("base64"),
          },
          timeout: 10_000,
        },
      );

      expect(result.status, result.stderr).toBe(0);
      const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf-8"));
      expect(artifact).toMatchObject({
        schemaVersion: 1,
        sandboxName: "test-sandbox",
        agent: "openclaw",
        workflow: "rebuild",
        channels: [
          { channelId: "telegram", active: true, disabled: false },
          { channelId: "slack", active: false, disabled: true },
        ],
        disabledChannels: ["slack"],
        credentialBindings: [{ channelId: "telegram", providerEnvKey: "TELEGRAM_BOT_TOKEN" }],
        runtimeSetup: {
          nodePreloads: [
            {
              channelId: "telegram",
              source: "/usr/local/lib/nemoclaw/preloads/telegram-diagnostics.js",
              target: "/tmp/nemoclaw-telegram-diagnostics.js",
              injectInto: ["boot", "connect"],
              optional: false,
            },
          ],
          envAliases: [],
          secretScans: [],
        },
      });
      expect(JSON.stringify(artifact)).not.toContain("do-not-persist");
      expect(JSON.stringify(artifact)).not.toContain("openshell:resolve:env");
      expect(artifact.runtimeSetup.nodePreloads[0]).not.toHaveProperty("module");
      expect((fs.statSync(artifactPath).mode & 0o777).toString(8)).toBe("644");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("skips runtime plan artifact output when messaging is not configured", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-empty-runtime-plan-artifact-"));
    const artifactPath = path.join(tmp, "runtime", "messaging-runtime-plan.json");

    try {
      const env = {
        PATH: TEST_PATH,
        NEMOCLAW_MESSAGING_RUNTIME_PLAN_PATH: artifactPath,
      };
      const plan = readMessagingBuildPlanFromEnv(env, "hermes");

      expect(applyMessagingBuildPhase(plan, "runtime-setup", env)).toEqual([]);
      expect(fs.existsSync(artifactPath)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("preserves Hermes runtime env aliases in the reduced runtime plan artifact", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-runtime-plan-artifact-"));
    const artifactPath = path.join(tmp, "runtime", "messaging-runtime-plan.json");
    const plan = {
      schemaVersion: 1,
      sandboxName: "test-sandbox",
      agent: "hermes",
      workflow: "rebuild",
      channels: [{ channelId: "slack", active: true, disabled: false }],
      disabledChannels: [],
      credentialBindings: [
        {
          channelId: "slack",
          providerEnvKey: "SLACK_BOT_TOKEN",
          placeholder: "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
        },
      ],
      agentRender: [],
      buildSteps: [],
      runtimeSetup: {
        nodePreloads: [],
        envAliases: [
          {
            channelId: "slack",
            envKey: "SLACK_BOT_TOKEN",
            match: "^openshell:resolve:env:(v[0-9]+_)?SLACK_BOT_TOKEN$",
            value: "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
            message:
              "[channels] Normalized SLACK_BOT_TOKEN runtime placeholder to the Bolt-compatible alias",
          },
          {
            channelId: "slack",
            envKey: "SLACK_APP_TOKEN",
            match: "^openshell:resolve:env:(v[0-9]+_)?SLACK_APP_TOKEN$",
            value: "xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN",
            message:
              "[channels] Normalized SLACK_APP_TOKEN runtime placeholder to the Bolt-compatible alias",
          },
        ],
        secretScans: [],
      },
    };

    try {
      const env = {
        PATH: TEST_PATH,
        NEMOCLAW_MESSAGING_RUNTIME_PLAN_PATH: artifactPath,
        NEMOCLAW_MESSAGING_PLAN_B64: encodePlan(plan),
      };
      const serializedPlan = readMessagingBuildPlanFromEnv(env, "hermes");

      expect(applyMessagingBuildPhase(serializedPlan, "runtime-setup", env)).toEqual([
        artifactPath,
      ]);
      const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf-8"));
      expect(artifact).toMatchObject({
        schemaVersion: 1,
        sandboxName: "test-sandbox",
        agent: "hermes",
        workflow: "rebuild",
        channels: [{ channelId: "slack", active: true, disabled: false }],
        credentialBindings: [{ channelId: "slack", providerEnvKey: "SLACK_BOT_TOKEN" }],
        runtimeSetup: {
          envAliases: plan.runtimeSetup.envAliases,
        },
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("installs reviewed packages using code-owned integrity instead of serialized plan pins", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-package-plan-"));
    const tracePath = path.join(tmp, "openclaw.trace");
    const fakeOpenclaw = path.join(tmp, "openclaw");
    const fakeNpm = path.join(tmp, "npm");
    fs.writeFileSync(
      fakeOpenclaw,
      [
        "#!/usr/bin/env node",
        "require('node:fs').appendFileSync(process.env.OPENCLAW_TRACE, `${process.argv.slice(2).join('|')}|ignore-scripts=${process.env.NPM_CONFIG_IGNORE_SCRIPTS || ''}/${process.env.npm_config_ignore_scripts || ''}\\n`);",
        "process.exit(0);",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      fakeNpm,
      [
        "#!/bin/sh",
        'printf \'npm|%s|%s|%s\\n\' "$1" "$2" "$3" >> "$OPENCLAW_TRACE"',
        ...fakeOpenClawPluginNpmPackScriptLines(),
        'if [ "${1:-}" = "view" ] && [ "${2:-}" = "@openclaw/discord@2026.6.10" ] && [ "${3:-}" = "dist.integrity" ]; then printf "%s\\n" "$OPENCLAW_DISCORD_2026_6_10_INTEGRITY"; exit 0; fi',
        "exit 1",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const plan = {
      schemaVersion: 1,
      sandboxName: "test-sandbox",
      agent: "openclaw",
      channels: [{ channelId: "discord", active: true }],
      credentialBindings: [],
      agentRender: [],
      buildSteps: [
        {
          channelId: "discord",
          kind: "package-install",
          outputId: "openclawPluginPackage",
          required: true,
          value: {
            manager: "openclaw-plugin",
            spec: "npm:@openclaw/discord@{{openclaw.version}}",
            integrity: "sha512-plan-controlled-pin",
            integrityByVersion: {
              "2026.6.10": "sha512-plan-controlled-version-pin",
            },
            pin: false,
          },
        },
      ],
    };

    try {
      const env = {
        PATH: tmp + ":" + (process.env.PATH || "/usr/bin:/bin"),
        OPENCLAW_TRACE: tracePath,
        OPENCLAW_DISCORD_2026_6_10_INTEGRITY,
        OPENCLAW_VERSION: "2026.6.10",
        NEMOCLAW_MESSAGING_PLAN_B64: Buffer.from(JSON.stringify(plan)).toString("base64"),
      };
      const serializedPlan = readMessagingBuildPlanFromEnv(env, "openclaw");

      expect(applyMessagingBuildPhase(serializedPlan, "agent-install", env)).toEqual([]);
      const trace = fs.readFileSync(tracePath, "utf-8");
      expect(trace).toContain("npm|view|@openclaw/discord@2026.6.10|dist.integrity");
      expect(trace).toContain("npm|pack|@openclaw/discord@2026.6.10|--pack-destination");
      expect(trace).toContain("plugins|install|npm-pack:");
      expect(trace).toContain("discord-2026.6.10.tgz|ignore-scripts=true/true");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("tolerates verbose npm metadata output when installing the Teams plugin (#6389)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-teams-npm-buffer-"));
    const tracePath = path.join(tmp, "openclaw.trace");
    fs.writeFileSync(
      path.join(tmp, "npm"),
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const [command, packageSpec, fieldOrFlag, destination] = process.argv.slice(2);",
        "fs.appendFileSync(process.env.OPENCLAW_TRACE, `npm|${command}|${packageSpec}|${fieldOrFlag || ''}\\n`);",
        "process.stderr.write('npm notice verbose teams metadata '.repeat(50000));",
        "if (command === 'view' && packageSpec === '@openclaw/msteams@2026.6.10' && fieldOrFlag === 'dist.integrity') {",
        "  process.stdout.write(`${process.env.OPENCLAW_MSTEAMS_2026_6_10_INTEGRITY}\\n`);",
        "  process.exit(0);",
        "}",
        "if (command === 'view' && packageSpec === '@openclaw/msteams@2026.6.10' && fieldOrFlag === 'dist.tarball') {",
        "  process.stdout.write('https://registry.npmjs.org/@openclaw/msteams/-/msteams-2026.6.10.tgz\\n');",
        "  process.exit(0);",
        "}",
        "if (command === 'pack' && packageSpec === '@openclaw/msteams@2026.6.10') {",
        "  const packFile = 'msteams-2026.6.10.tgz';",
        "  fs.writeFileSync(path.join(destination, packFile), 'fake plugin tarball');",
        "  process.stdout.write(JSON.stringify([{ filename: packFile, integrity: process.env.OPENCLAW_MSTEAMS_2026_6_10_INTEGRITY }]) + '\\n');",
        "  process.exit(0);",
        "}",
        "process.exit(1);",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(tmp, "openclaw"),
      [
        "#!/bin/sh",
        'printf \'openclaw|%s|%s|%s|%s\\n\' "$1" "$2" "$3" "$4" >> "$OPENCLAW_TRACE"',
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    try {
      const env = await withLegacyMessagingPlanEnvDirect(
        {
          PATH: `${tmp}:${TEST_PATH}`,
          OPENCLAW_TRACE: tracePath,
          OPENCLAW_MSTEAMS_2026_6_10_INTEGRITY,
          OPENCLAW_VERSION: "2026.6.10",
          NEMOCLAW_MESSAGING_CHANNELS_B64: channelsB64(["teams"]),
          NEMOCLAW_TEAMS_CONFIG_B64: teamsConfigB64(),
        },
        "openclaw",
      );
      const plan = readMessagingBuildPlanFromEnv(env, "openclaw");

      expect(applyMessagingBuildPhase(plan, "agent-install", env)).toEqual([]);
      const trace = fs.readFileSync(tracePath, "utf-8");
      expect(trace).toContain("npm|view|@openclaw/msteams@2026.6.10|dist.integrity");
      expect(trace).toContain("npm|view|@openclaw/msteams@2026.6.10|dist.tarball");
      expect(trace).toContain("npm|pack|@openclaw/msteams@2026.6.10|--pack-destination");
      expect(trace).toContain("openclaw|plugins|install|npm-pack:");
      expect(trace).toContain("msteams-2026.6.10.tgz|");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails closed before installing reviewed OpenClaw plugins absent from active channel manifests", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-package-plan-"));
    const tracePath = path.join(tmp, "openclaw.trace");
    fs.writeFileSync(
      path.join(tmp, "openclaw"),
      [
        "#!/usr/bin/env node",
        "require('node:fs').appendFileSync(process.env.OPENCLAW_TRACE, `${process.argv.slice(2).join('|')}\\n`);",
        "process.exit(0);",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const plan = {
      schemaVersion: 1,
      sandboxName: "test-sandbox",
      agent: "openclaw",
      channels: [{ channelId: "discord", active: true }],
      credentialBindings: [],
      agentRender: [],
      buildSteps: [
        {
          channelId: "discord",
          kind: "package-install",
          outputId: "openclawPluginPackage",
          required: true,
          value: {
            manager: "openclaw-plugin",
            spec: "npm:@openclaw/slack@{{openclaw.version}}",
            integrity: "sha512-plan-controlled-pin",
            pin: false,
          },
        },
      ],
    };

    try {
      const env = {
        PATH: tmp + ":" + TEST_PATH,
        OPENCLAW_TRACE: tracePath,
        OPENCLAW_VERSION: "2026.6.10",
        NEMOCLAW_MESSAGING_PLAN_B64: Buffer.from(JSON.stringify(plan)).toString("base64"),
      };
      const serializedPlan = readMessagingBuildPlanFromEnv(env, "openclaw");

      expect(() => applyMessagingBuildPhase(serializedPlan, "agent-install", env)).toThrow(
        "Messaging package-install output openclawPluginPackage is not declared by a trusted built-in manifest for active OpenClaw channels: npm:@openclaw/slack@2026.6.10",
      );
      expect(fs.existsSync(tracePath)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails closed before installing non-npm OpenClaw plugin specs", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-package-plan-"));
    const tracePath = path.join(tmp, "openclaw.trace");
    fs.writeFileSync(
      path.join(tmp, "openclaw"),
      [
        "#!/usr/bin/env node",
        "require('node:fs').appendFileSync(process.env.OPENCLAW_TRACE, `${process.argv.slice(2).join('|')}\\n`);",
        "process.exit(0);",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const plan = {
      schemaVersion: 1,
      sandboxName: "test-sandbox",
      agent: "openclaw",
      channels: [{ channelId: "discord", active: true }],
      credentialBindings: [],
      agentRender: [],
      buildSteps: [
        {
          channelId: "discord",
          kind: "package-install",
          outputId: "openclawPluginPackage",
          required: true,
          value: {
            manager: "openclaw-plugin",
            spec: "github:example/unreviewed-plugin",
            pin: true,
          },
        },
      ],
    };

    try {
      const env = {
        PATH: tmp + ":" + (process.env.PATH || "/usr/bin:/bin"),
        OPENCLAW_TRACE: tracePath,
        OPENCLAW_VERSION: "2026.5.22",
        NEMOCLAW_MESSAGING_PLAN_B64: Buffer.from(JSON.stringify(plan)).toString("base64"),
      };
      const serializedPlan = readMessagingBuildPlanFromEnv(env, "openclaw");

      expect(() => applyMessagingBuildPhase(serializedPlan, "agent-install", env)).toThrow(
        "OpenClaw plugin spec github:example/unreviewed-plugin must use an npm: package with committed integrity pin",
      );
      expect(fs.existsSync(tracePath)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it(
    "runs pinned installs during agent-install without doctor env injection",
    async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-message-plugins-"));
      const tracePath = path.join(tmp, "openclaw.trace");
      const fakeOpenclaw = path.join(tmp, "openclaw");
      const fakeNpm = path.join(tmp, "npm");
      fs.writeFileSync(
        fakeOpenclaw,
        [
          "#!/bin/sh",
          'printf \'%s|%s|%s|%s|%s|%s|%s\\n\' "$1" "$2" "$3" "$4" "${TELEGRAM_BOT_TOKEN:-}" "${DISCORD_BOT_TOKEN:-}" "${SLACK_BOT_TOKEN:-}" >> "$OPENCLAW_TRACE"',
          "exit 0",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      fs.writeFileSync(
        fakeNpm,
        [
          "#!/bin/sh",
          'printf \'npm|%s|%s|%s\\n\' "$1" "$2" "$3" >> "$OPENCLAW_TRACE"',
          ...fakeOpenClawPluginNpmPackScriptLines(),
          'if [ "${1:-}" != "view" ] || [ "${3:-}" != "dist.integrity" ]; then exit 1; fi',
          'case "${2:-}" in',
          `  "@openclaw/discord@2026.6.10") printf "%s\\n" "${OPENCLAW_DISCORD_2026_6_10_INTEGRITY}"; exit 0 ;;`,
          `  "@tencent-weixin/openclaw-weixin@2.4.3") printf "%s\\n" "${TENCENT_WEIXIN_2_4_3_INTEGRITY}"; exit 0 ;;`,
          `  "@openclaw/slack@2026.6.10") printf "%s\\n" "${OPENCLAW_SLACK_2026_6_10_INTEGRITY}"; exit 0 ;;`,
          `  "@openclaw/whatsapp@2026.6.10") printf "%s\\n" "${OPENCLAW_WHATSAPP_2026_6_10_INTEGRITY}"; exit 0 ;;`,
          `  "@openclaw/msteams@2026.6.10") printf "%s\\n" "${OPENCLAW_MSTEAMS_2026_6_10_INTEGRITY}"; exit 0 ;;`,
          "esac",
          "exit 1",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );

      try {
        const planEnv = await withLegacyMessagingPlanEnvDirect(
          {
            PATH: `${tmp}:${TEST_PATH}`,
            OPENCLAW_TRACE: tracePath,
            OPENCLAW_DISCORD_2026_6_10_INTEGRITY,
            OPENCLAW_SLACK_2026_6_10_INTEGRITY,
            OPENCLAW_WHATSAPP_2026_6_10_INTEGRITY,
            OPENCLAW_MSTEAMS_2026_6_10_INTEGRITY,
            TENCENT_WEIXIN_2_4_3_INTEGRITY,
            OPENCLAW_VERSION: "2026.6.10",
            NEMOCLAW_MESSAGING_CHANNELS_B64: channelsB64([
              "telegram",
              "discord",
              "slack",
              "whatsapp",
              "wechat",
              "teams",
            ]),
            NEMOCLAW_WECHAT_CONFIG_B64: wechatConfigB64(),
            NEMOCLAW_TEAMS_CONFIG_B64: teamsConfigB64(),
          },
          "openclaw",
        );
        const plan = readMessagingBuildPlanFromEnv(planEnv, "openclaw");

        expect(applyMessagingBuildPhase(plan, "agent-install", planEnv)).toEqual([]);
        const trace = fs.readFileSync(tracePath, "utf-8");
        for (const [packageSpec, archiveName] of [
          ["@openclaw/discord@2026.6.10", "discord-2026.6.10.tgz"],
          ["@tencent-weixin/openclaw-weixin@2.4.3", "openclaw-weixin-2.4.3.tgz"],
          ["@openclaw/slack@2026.6.10", "slack-2026.6.10.tgz"],
          ["@openclaw/whatsapp@2026.6.10", "whatsapp-2026.6.10.tgz"],
          ["@openclaw/msteams@2026.6.10", "msteams-2026.6.10.tgz"],
        ] as const) {
          expect(trace).toContain(`npm|view|${packageSpec}|dist.integrity`);
          expect(trace).toContain(`npm|view|${packageSpec}|dist.tarball`);
          expect(trace).toContain(`npm|pack|${packageSpec}|--pack-destination`);
          expect(trace).toContain("plugins|install|npm-pack:");
          expect(trace).toContain(`${archiveName}||||`);
        }
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
    testTimeout(15_000),
  );

  it("verifies reviewed npm integrity before installing the 2026.6.10 Slack plugin", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-slack-integrity-"));
    const tracePath = path.join(tmp, "openclaw.trace");
    fs.writeFileSync(
      path.join(tmp, "npm"),
      [
        "#!/bin/sh",
        'printf \'npm|%s|%s|%s\\n\' "$1" "$2" "$3" >> "$OPENCLAW_TRACE"',
        ...fakeOpenClawPluginNpmPackScriptLines(),
        'if [ "${1:-}" = "view" ] && [ "${3:-}" = "dist.integrity" ]; then printf "%s\\n" "$OPENCLAW_SLACK_INTEGRITY"; exit 0; fi',
        "exit 1",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(tmp, "openclaw"),
      [
        "#!/bin/sh",
        'printf \'openclaw|%s|%s|%s|%s\\n\' "$1" "$2" "$3" "$4" >> "$OPENCLAW_TRACE"',
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    try {
      const env = await withLegacyMessagingPlanEnvDirect(
        {
          PATH: `${tmp}:${process.env.PATH || "/usr/bin:/bin"}`,
          OPENCLAW_TRACE: tracePath,
          OPENCLAW_SLACK_INTEGRITY: OPENCLAW_SLACK_2026_6_10_INTEGRITY,
          OPENCLAW_VERSION: "2026.6.10",
          NEMOCLAW_MESSAGING_CHANNELS_B64: channelsB64(["slack"]),
        },
        "openclaw",
      );
      const plan = readMessagingBuildPlanFromEnv(env, "openclaw");

      expect(applyMessagingBuildPhase(plan, "agent-install", env)).toEqual([]);
      const trace = fs.readFileSync(tracePath, "utf-8");
      expect(trace).toContain("npm|view|@openclaw/slack@2026.6.10|dist.integrity");
      expect(trace).toContain("npm|view|@openclaw/slack@2026.6.10|dist.tarball");
      expect(trace).toContain("npm|pack|@openclaw/slack@2026.6.10|--pack-destination");
      expect(trace).toContain("openclaw|plugins|install|npm-pack:");
      expect(trace).toContain("slack-2026.6.10.tgz|");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails closed before installing the 2026.6.10 Slack plugin when registry integrity drifts", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-slack-integrity-"));
    const tracePath = path.join(tmp, "openclaw.trace");
    fs.writeFileSync(
      path.join(tmp, "npm"),
      [
        "#!/bin/sh",
        'printf \'npm|%s|%s|%s\\n\' "$1" "$2" "$3" >> "$OPENCLAW_TRACE"',
        'if [ "${1:-}" = "view" ] && [ "${3:-}" = "dist.integrity" ]; then printf "sha512-drift\\n"; exit 0; fi',
        "exit 1",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(tmp, "openclaw"),
      [
        "#!/bin/sh",
        'printf \'openclaw|%s|%s|%s|%s\\n\' "$1" "$2" "$3" "$4" >> "$OPENCLAW_TRACE"',
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    try {
      const env = await withLegacyMessagingPlanEnvDirect(
        {
          PATH: `${tmp}:${process.env.PATH || "/usr/bin:/bin"}`,
          OPENCLAW_TRACE: tracePath,
          OPENCLAW_VERSION: "2026.6.10",
          NEMOCLAW_MESSAGING_CHANNELS_B64: channelsB64(["slack"]),
        },
        "openclaw",
      );
      const plan = readMessagingBuildPlanFromEnv(env, "openclaw");

      const message = thrownMessage(() => applyMessagingBuildPhase(plan, "agent-install", env));
      expect(message).toContain("OpenClaw plugin @openclaw/slack@2026.6.10 npm integrity mismatch");
      expect(message).toContain(`Expected: ${OPENCLAW_SLACK_2026_6_10_INTEGRITY}`);
      expect(message).toContain("Actual: sha512-drift");
      expect(fs.readFileSync(tracePath, "utf-8").trim()).toBe(
        "npm|view|@openclaw/slack@2026.6.10|dist.integrity",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("installs Hermes Python packages supplied by the compiled Teams plan", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-teams-packages-"));
    const tracePath = path.join(tmp, "uv.trace");
    const fakeUv = path.join(tmp, "uv");
    fs.writeFileSync(
      fakeUv,
      ["#!/bin/sh", 'printf \'%s\\n\' "$*" >> "$UV_TRACE"', "exit 0", ""].join("\n"),
      { mode: 0o755 },
    );

    try {
      const planEnv = await withLegacyMessagingPlanEnvDirect(
        {
          PATH: `${tmp}:${TEST_PATH}`,
          UV_TRACE: tracePath,
          NEMOCLAW_MESSAGING_CHANNELS_B64: channelsB64(["teams"]),
          NEMOCLAW_TEAMS_CONFIG_B64: teamsConfigB64(),
        },
        "hermes",
      );

      const plan = readMessagingBuildPlanFromEnv(planEnv, "hermes");
      expect(describeMessagingBuildPhase(plan, "agent-install", planEnv).hermesUvPackages).toEqual([
        "microsoft-teams-apps==2.0.13.4",
        "aiohttp==3.14.1",
      ]);

      const result = runApplierProcess(planEnv, "hermes", "agent-install");

      expect(result.status, result.stderr).toBe(0);
      expect(fs.readFileSync(tracePath, "utf-8").trim()).toBe(
        "pip install --python /opt/hermes/.venv/bin/python --no-cache -- microsoft-teams-apps==2.0.13.4 aiohttp==3.14.1",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects Hermes Python packages not declared by trusted built-in channel manifests", async () => {
    const baseEnv = await withLegacyMessagingPlanEnvDirect(
      {
        PATH: TEST_PATH,
        NEMOCLAW_MESSAGING_CHANNELS_B64: channelsB64(["teams"]),
        NEMOCLAW_TEAMS_CONFIG_B64: teamsConfigB64(),
      },
      "hermes",
    );
    const plan = decodePlan(baseEnv.NEMOCLAW_MESSAGING_PLAN_B64);
    plan.buildSteps = [
      ...plan.buildSteps,
      {
        channelId: "teams",
        kind: "package-install",
        outputId: "tamperedHermesPackage",
        required: true,
        value: {
          manager: "hermes-uv-pip",
          spec: "unexpected-package==1.2.3",
        },
      },
    ];

    const env = {
      ...baseEnv,
      NEMOCLAW_MESSAGING_PLAN_B64: encodePlan(plan),
    };
    const serializedPlan = readMessagingBuildPlanFromEnv(env, "hermes");

    const message = thrownMessage(() =>
      describeMessagingBuildPhase(serializedPlan, "agent-install", env),
    );
    expect(message).toContain("tamperedHermesPackage");
    expect(message).toContain("not declared by a trusted built-in manifest");
    expect(message).toContain("unexpected-package==1.2.3");
  });

  it("reaches the mocked OpenClaw doctor boundary during post-agent-install messaging render (#4246)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-discord-runtime-contract-"));
    const tracePath = path.join(tmp, "openclaw.trace");
    const fakeOpenclaw = path.join(tmp, "openclaw");
    const fakeNpm = path.join(tmp, "npm");
    const discordChannels = channelsB64(["discord"]);
    fs.writeFileSync(
      fakeOpenclaw,
      [
        "#!/usr/bin/env node",
        'const fs = require("fs");',
        "const args = process.argv.slice(2);",
        'fs.appendFileSync(process.env.OPENCLAW_TRACE, `${args.join("|")}|${process.env.DISCORD_BOT_TOKEN || ""}|${process.env.BRAVE_API_KEY || ""}\\n`);',
        'if (args[0] === "plugins" && args[1] === "install") {',
        '  if (!args[2].startsWith("npm-pack:") || !args[2].endsWith("discord-2026.6.10.tgz")) process.exit(41);',
        "  if (args.length !== 3) process.exit(47);",
        "  process.exit(0);",
        "}",
        'if (args[0] === "doctor" && args[1] === "--fix" && args[2] === "--non-interactive") {',
        '  if (process.env.DISCORD_BOT_TOKEN !== "openshell:resolve:env:DISCORD_BOT_TOKEN") process.exit(42);',
        '  const config = JSON.parse(fs.readFileSync(`${process.env.HOME}/.openclaw/openclaw.json`, "utf8"));',
        "  if (config.plugins?.entries?.discord?.enabled !== true) process.exit(43);",
        "  if (config.channels?.discord?.enabled !== true) process.exit(44);",
        '  if (config.channels?.discord?.accounts?.default?.token !== "openshell:resolve:env:DISCORD_BOT_TOKEN") process.exit(45);',
        "  process.exit(0);",
        "}",
        "process.exit(46);",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      fakeNpm,
      [
        "#!/bin/sh",
        'printf \'npm|%s|%s|%s||\\n\' "$1" "$2" "$3" >> "$OPENCLAW_TRACE"',
        ...fakeOpenClawPluginNpmPackScriptLines(),
        'if [ "${1:-}" = "view" ] && [ "${2:-}" = "@openclaw/discord@2026.6.10" ] && [ "${3:-}" = "dist.integrity" ]; then printf "%s\\n" "$OPENCLAW_DISCORD_2026_6_10_INTEGRITY"; exit 0; fi',
        "exit 1",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    try {
      const generatorEnv = await withLegacyMessagingPlanEnvDirect(
        {
          PATH: `${tmp}:${TEST_PATH}`,
          HOME: tmp,
          ...BASE_GENERATOR_ENV,
          NEMOCLAW_MESSAGING_CHANNELS_B64: discordChannels,
          NEMOCLAW_OPENCLAW_MANAGED_PROXY: "0",
          NEMOCLAW_WEB_SEARCH_ENABLED: "1",
        },
        "openclaw",
      );
      const generatorResult = spawnSync("node", ["--experimental-strip-types", GENERATOR_PATH], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        env: generatorEnv,
        timeout: execTimeout(20_000),
      });
      expect(generatorResult.status, generatorResult.stderr).toBe(0);

      const applierEnv = {
        PATH: `${tmp}:${TEST_PATH}`,
        HOME: tmp,
        OPENCLAW_TRACE: tracePath,
        OPENCLAW_DISCORD_2026_6_10_INTEGRITY,
        OPENCLAW_VERSION: "2026.6.10",
        NEMOCLAW_MESSAGING_PLAN_B64: generatorEnv.NEMOCLAW_MESSAGING_PLAN_B64,
        NEMOCLAW_WEB_SEARCH_ENABLED: "1",
      };
      const pluginResult = runApplierProcess(applierEnv, "openclaw", "agent-install");
      expect(pluginResult.status, pluginResult.stderr).toBe(0);

      const postInstallResult = runApplierProcess(applierEnv, "openclaw", "post-agent-install");

      expect(postInstallResult.status, postInstallResult.stderr).toBe(0);
      const trace = fs.readFileSync(tracePath, "utf-8");
      expect(trace).toContain("npm|view|@openclaw/discord@2026.6.10|dist.integrity||");
      expect(trace).toContain("npm|pack|@openclaw/discord@2026.6.10|--pack-destination||");
      expect(trace).toContain("plugins|install|npm-pack:");
      expect(trace).toContain("discord-2026.6.10.tgz||");
      expect(trace).toContain(
        "doctor|--fix|--non-interactive|openshell:resolve:env:DISCORD_BOT_TOKEN|openshell:resolve:env:BRAVE_API_KEY",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reapplies OpenClaw messaging render after doctor rewrites config", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-doctor-rewrite-"));
    const tracePath = path.join(tmp, "openclaw.trace");
    const fakeOpenclaw = path.join(tmp, "openclaw");
    const channels = channelsB64(["telegram", "discord", "slack", "wechat"]);
    const wechatConfig = Buffer.from(
      JSON.stringify({ accountId: "primary", baseUrl: "https://ilinkai.wechat.com", userId: "u1" }),
    ).toString("base64");

    fs.writeFileSync(
      fakeOpenclaw,
      [
        "#!/usr/bin/env node",
        'const fs = require("fs");',
        'const path = require("path");',
        "const args = process.argv.slice(2);",
        'fs.appendFileSync(process.env.OPENCLAW_TRACE, args.join("|") + String.fromCharCode(10));',
        'if (args[0] !== "doctor" || args[1] !== "--fix" || args[2] !== "--non-interactive") process.exit(46);',
        'const configPath = path.join(process.env.HOME, ".openclaw", "openclaw.json");',
        'const config = JSON.parse(fs.readFileSync(configPath, "utf8"));',
        'if (config.channels?.telegram?.accounts?.default?.botToken !== "openshell:resolve:env:TELEGRAM_BOT_TOKEN") process.exit(40);',
        "if (config.channels?.discord?.enabled !== true) process.exit(41);",
        "if (config.plugins?.entries?.discord?.enabled !== true) process.exit(42);",
        "if (config.plugins?.entries?.slack?.enabled !== true) process.exit(43);",
        'if (config.channels?.["openclaw-weixin"]?.accounts?.primary?.enabled !== true) process.exit(44);',
        'fs.writeFileSync(configPath, JSON.stringify({ channels: { telegram: { accounts: { default: { botToken: "openshell:resolve:env:v42_TELEGRAM_BOT_TOKEN" } } } }, plugins: { entries: {} } }, null, 2) + String.fromCharCode(10));',
        "process.exit(0);",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    try {
      const env = await withLegacyMessagingPlanEnvDirect(
        {
          PATH: `${tmp}:${TEST_PATH}`,
          HOME: tmp,
          OPENCLAW_TRACE: tracePath,
          ...BASE_GENERATOR_ENV,
          NEMOCLAW_MESSAGING_CHANNELS_B64: channels,
          NEMOCLAW_WECHAT_CONFIG_B64: wechatConfig,
          NEMOCLAW_OPENCLAW_MANAGED_PROXY: "0",
        },
        "openclaw",
      );
      const postInstallResult = runApplierProcess(env, "openclaw", "post-agent-install");
      expect(postInstallResult.status, postInstallResult.stderr).toBe(0);
      expect(fs.readFileSync(tracePath, "utf-8").trim()).toBe("doctor|--fix|--non-interactive");

      const config = JSON.parse(
        fs.readFileSync(path.join(tmp, ".openclaw", "openclaw.json"), "utf-8"),
      );
      expect(config.channels?.telegram?.accounts?.default).toMatchObject({
        botToken: "openshell:resolve:env:v42_TELEGRAM_BOT_TOKEN",
        enabled: true,
      });
      expect(config.channels?.discord?.enabled).toBe(true);
      expect(config.plugins?.entries?.discord).toEqual({ enabled: true });
      expect(config.channels?.slack?.enabled).toBe(true);
      expect(config.plugins?.entries?.slack).toEqual({ enabled: true });
      expect(config.channels?.["openclaw-weixin"]?.accounts?.primary).toEqual({ enabled: true });
      expect(config.channels?.wechat).toBeUndefined();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("applies post-agent-install WeChat build files from the compiled messaging plan", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-post-agent-install-"));
    const channels = channelsB64(["wechat"]);
    const wechatConfig = Buffer.from(
      JSON.stringify({ accountId: "primary", baseUrl: "https://ilinkai.wechat.com", userId: "u1" }),
    ).toString("base64");

    try {
      const env = await withLegacyMessagingPlanEnvDirect(
        {
          PATH: `${tmp}:${TEST_PATH}`,
          HOME: tmp,
          ...BASE_GENERATOR_ENV,
          NEMOCLAW_MESSAGING_CHANNELS_B64: channels,
          NEMOCLAW_WECHAT_CONFIG_B64: wechatConfig,
          NEMOCLAW_OPENCLAW_MANAGED_PROXY: "0",
        },
        "openclaw",
      );
      fs.writeFileSync(path.join(tmp, "openclaw"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const postInstallResult = runApplierProcess(env, "openclaw", "post-agent-install");
      expect(postInstallResult.status, postInstallResult.stderr).toBe(0);

      const config = JSON.parse(
        fs.readFileSync(path.join(tmp, ".openclaw", "openclaw.json"), "utf-8"),
      );
      expect(config.plugins?.installs?.["openclaw-weixin"]).toEqual({
        source: "npm",
        spec: "@tencent-weixin/openclaw-weixin@2.4.3",
        installPath: "/sandbox/.openclaw/extensions/openclaw-weixin",
      });
      expect(config.plugins?.load?.paths ?? []).not.toContain(
        "/sandbox/.openclaw/extensions/openclaw-weixin",
      );
      expect(config.channels?.["openclaw-weixin"]?.accounts?.primary).toEqual({ enabled: true });
      expect(config.channels?.wechat).toBeUndefined();

      const account = JSON.parse(
        fs.readFileSync(
          path.join(tmp, ".openclaw", "openclaw-weixin", "accounts", "primary.json"),
          "utf-8",
        ),
      );
      expect(account).toMatchObject({
        token: "openshell:resolve:env:WECHAT_BOT_TOKEN",
        baseUrl: "https://ilinkai.wechat.com",
        userId: "u1",
      });
      expect(
        JSON.parse(
          fs.readFileSync(path.join(tmp, ".openclaw", "openclaw-weixin", "accounts.json"), "utf-8"),
        ),
      ).toEqual(["primary"]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("applies Hermes messaging render to config.yaml and .env in post-agent-install", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-render-"));
    try {
      const hermesDir = path.join(tmp, ".hermes");
      fs.mkdirSync(hermesDir, { recursive: true });
      fs.writeFileSync(
        path.join(hermesDir, "config.yaml"),
        [
          "# Managed by NemoClaw - Hermes configuration",
          "# Upstream provider: openai",
          "# OpenShell rewrites model.base_url to the upstream endpoint at request time.",
          "_config_version: 12",
          "platform_toolsets:",
          "  api_server:",
          "  - web",
          "platforms:",
          "  api_server:",
          "    enabled: true",
          "",
        ].join("\n"),
      );
      fs.writeFileSync(path.join(hermesDir, ".env"), "API_SERVER_PORT=18642\n");
      const env = await withLegacyMessagingPlanEnvDirect(
        {
          PATH: TEST_PATH,
          HOME: tmp,
          NEMOCLAW_MESSAGING_CHANNELS_B64: channelsB64(["telegram"]),
        },
        "hermes",
      );
      const postInstallResult = runApplierProcess(env, "hermes", "post-agent-install");
      expect(postInstallResult.status, postInstallResult.stderr).toBe(0);
      const configYaml = fs.readFileSync(path.join(hermesDir, "config.yaml"), "utf-8");
      expect(configYaml).toContain("telegram:");
      expect(configYaml).toContain("enabled: true");
      const envFile = fs.readFileSync(path.join(hermesDir, ".env"), "utf-8");
      expect(envFile).toContain("API_SERVER_PORT=18642\n");
      expect(envFile).toContain("TELEGRAM_BOT_TOKEN=openshell:resolve:env:TELEGRAM_BOT_TOKEN\n");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
