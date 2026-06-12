// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Focused live Vitest coverage for test/e2e/test-messaging-providers.sh paths.
 *
 * Keep this close to the shell suite's high-value provider/config/redaction
 * contracts: fake tokens by default, _REAL secrets opt in to real sends,
 * provider placeholders must not leak into sandbox-visible surfaces, WhatsApp
 * stays QR-only, and optional live-network probes skip on transport
 * reachability rather than weakening the assertions. Legacy-only paths such as
 * Telegram inbound replies, Slack mention/reply feedback, revoked Slack token
 * pre-validation, and no-real-secret plugin-send fallbacks remain in the shell
 * suite until their own scoped migrations.
 */

import fs from "node:fs";

import { testTimeoutOptions } from "../../helpers/timeouts";
import { test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2EScenarios } from "../fixtures/live-project-gate.ts";
import {
  accountBool,
  accountString,
  applyRestRewritePolicy,
  applyWebSocketRewritePolicy,
  bestEffort,
  CLI_ENTRYPOINT,
  channelAccount,
  channelEnabled,
  check,
  countCsv,
  expectExitZero,
  INSTALL_TIMEOUT_MS,
  isNvidiaEndpointRateLimitFailure,
  isUnresolvedPlaceholderRejection,
  LIVE_TIMEOUT_MS,
  lastJsonLine,
  messagingEnv,
  nonEmpty,
  outputText,
  pluginEnabled,
  policyTextHasHost,
  premergeSlackPolicyIfNeeded,
  REBUILD_TIMEOUT_MS,
  rawTokenSurfaceProbe,
  readOpenClawConfig,
  runDiscordGatewayClient,
  runHost,
  runSandboxShell,
  runSlackApiRequest,
  SANDBOX_NAME,
  sandboxOutput,
  shellQuote,
  skipNote,
  startFakeDockerApi,
  stripAnsi,
  tokenValues,
} from "./messaging-providers-helpers.ts";

const runLiveTest = shouldRunLiveE2EScenarios() ? test : test.skip;

runLiveTest(
  "messaging providers preserve placeholder, policy, runtime, and send contracts",
  testTimeoutOptions(LIVE_TIMEOUT_MS),
  async ({ artifacts, cleanup, host, sandbox, skip }) => {
    if (!process.env.NVIDIA_API_KEY) {
      skip("NVIDIA_API_KEY is required for live messaging-provider E2E");
      return;
    }
    if (!fs.existsSync(CLI_ENTRYPOINT)) {
      throw new Error(`NemoClaw CLI entrypoint missing: ${CLI_ENTRYPOINT}`);
    }

    const state = messagingEnv();
    const redactionValues = tokenValues(state.tokens);
    const skips: string[] = [];
    await artifacts.writeJson("messaging-provider-env-summary.json", {
      sandboxName: SANDBOX_NAME,
      telegramTokenChars: state.tokens.telegram.length,
      discordTokenChars: state.tokens.discord.length,
      slackBotTokenChars: state.tokens.slackBot.length,
      slackAppTokenChars: state.tokens.slackApp.length,
      telegramAllowlistKey: state.telegramAllowlistKey,
      telegramAllowedIdCount: countCsv(state.telegramIds),
      slackAllowedUserCount: countCsv(state.slackIds),
      wechatAccount: state.wechatAccount,
    });

    cleanup.add(`destroy messaging providers sandbox ${SANDBOX_NAME}`, async () => {
      await bestEffort(() =>
        runHost(host, "node", [CLI_ENTRYPOINT, SANDBOX_NAME, "destroy", "--yes"], {
          artifactName: "cleanup-nemoclaw-destroy-messaging-providers",
          env: state.env,
          redactionValues,
          timeoutMs: 15 * 60_000,
        }),
      );
      await bestEffort(() =>
        runHost(host, "openshell", ["sandbox", "delete", SANDBOX_NAME], {
          artifactName: "cleanup-openshell-sandbox-delete-messaging-providers",
          env: state.env,
          redactionValues,
          timeoutMs: 120_000,
        }),
      );
    });

    const restoreSlackPolicy = await premergeSlackPolicyIfNeeded();
    cleanup.add("restore messaging E2E Slack policy pre-merge", restoreSlackPolicy);

    await bestEffort(() =>
      runHost(host, "node", [CLI_ENTRYPOINT, SANDBOX_NAME, "destroy", "--yes"], {
        artifactName: "preclean-nemoclaw-destroy-messaging-providers",
        env: state.env,
        redactionValues,
        timeoutMs: 15 * 60_000,
      }),
    );
    await bestEffort(() =>
      runHost(host, "openshell", ["sandbox", "delete", SANDBOX_NAME], {
        artifactName: "preclean-openshell-sandbox-delete-messaging-providers",
        env: state.env,
        redactionValues,
        timeoutMs: 120_000,
      }),
    );
    await bestEffort(() =>
      runHost(host, "openshell", ["gateway", "destroy", "-g", "nemoclaw"], {
        artifactName: "preclean-openshell-gateway-destroy-messaging-providers",
        env: state.env,
        redactionValues,
        timeoutMs: 120_000,
      }),
    );

    const dockerInfo = await runHost(host, "docker", ["info"], {
      artifactName: "prereq-docker-info-messaging-providers",
      env: state.env,
      redactionValues,
      timeoutMs: 30_000,
    });
    expectExitZero(dockerInfo, "Docker must be running");

    const install = await runHost(host, "bash", ["install.sh", "--non-interactive"], {
      artifactName: "install-messaging-providers",
      env: state.env,
      redactionValues,
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    if (install.exitCode !== 0 && isNvidiaEndpointRateLimitFailure(outputText(install))) {
      await artifacts.writeJson("messaging-provider-early-skip.json", {
        reason:
          "NVIDIA endpoint validation was rate-limited before messaging-provider assertions ran",
        exitCode: install.exitCode,
        artifact: install.artifacts.result,
      });
      skip("NVIDIA endpoint validation was rate-limited before messaging-provider assertions ran");
      return;
    }
    expectExitZero(install, "M0: install.sh completed");

    const openshellVersion = await runHost(host, "openshell", ["--version"], {
      artifactName: "openshell-version-messaging-providers",
      env: state.env,
      redactionValues,
      timeoutMs: 60_000,
    });
    expectExitZero(openshellVersion, "openshell installed");

    const sandboxList = await runHost(host, "openshell", ["sandbox", "list"], {
      artifactName: "sandbox-list-messaging-providers",
      env: state.env,
      redactionValues,
      timeoutMs: 60_000,
    });
    expectExitZero(sandboxList, "openshell sandbox list");
    const sandboxRow = stripAnsi(sandboxList.stdout)
      .split(/\r?\n/)
      .find((line) => line.includes(SANDBOX_NAME));
    check(Boolean(sandboxRow && /\bReady\b/.test(sandboxRow)), "M0b: sandbox is Ready");

    const whatsappAdd = await runHost(
      host,
      "node",
      [CLI_ENTRYPOINT, SANDBOX_NAME, "channels", "add", "whatsapp"],
      {
        artifactName: "channels-add-whatsapp-messaging-providers",
        env: state.env,
        redactionValues,
        timeoutMs: 10 * 60_000,
      },
    );
    expectExitZero(whatsappAdd, "M-WA0: channels add whatsapp exits 0");
    check(
      outputText(whatsappAdd).includes("Enabled whatsapp channel"),
      "M-WA0: channels add whatsapp registered QR-only channel",
    );

    const whatsappProvider = await runHost(
      host,
      "openshell",
      ["provider", "get", `${SANDBOX_NAME}-whatsapp-bridge`],
      {
        artifactName: "provider-get-whatsapp-messaging-providers",
        env: state.env,
        redactionValues,
        timeoutMs: 60_000,
      },
    );
    check(
      whatsappProvider.exitCode !== 0,
      "M-WA1: WhatsApp QR-only channel creates no bridge provider",
    );

    const registryWhatsapp = await runHost(
      host,
      "node",
      [
        "-e",
        `const fs = require("fs");
const registry = JSON.parse(fs.readFileSync(process.env.HOME + "/.nemoclaw/sandboxes.json", "utf8"));
const channels = registry.sandboxes?.[process.env.SANDBOX_NAME]?.messaging?.plan?.channels;
process.exit(Array.isArray(channels) && channels.some((c) => c?.channelId === "whatsapp") ? 0 : 1);`,
      ],
      {
        artifactName: "registry-whatsapp-messaging-providers",
        env: { ...state.env, SANDBOX_NAME },
        redactionValues,
        timeoutMs: 60_000,
      },
    );
    check(
      registryWhatsapp.exitCode === 0,
      "M-WA2: registry.messaging.plan.channels contains whatsapp after channel add",
    );

    const whatsappPolicyPre = await runHost(
      host,
      "openshell",
      ["policy", "get", "--full", SANDBOX_NAME],
      {
        artifactName: "whatsapp-policy-pre-rebuild-messaging-providers",
        env: state.env,
        redactionValues,
        timeoutMs: 60_000,
      },
    );
    const whatsappPolicyPreText = outputText(whatsappPolicyPre);
    check(
      policyTextHasHost(whatsappPolicyPreText, "web.whatsapp.com") &&
        policyTextHasHost(whatsappPolicyPreText, "whatsapp.net") &&
        policyTextHasHost(whatsappPolicyPreText, "raw.githubusercontent.com"),
      "M-WA3: WhatsApp policy preset applied before rebuild",
    );

    const whatsappRebuild = await runHost(
      host,
      "node",
      [CLI_ENTRYPOINT, SANDBOX_NAME, "rebuild", "--yes"],
      {
        artifactName: "whatsapp-rebuild-messaging-providers",
        env: state.env,
        redactionValues,
        timeoutMs: REBUILD_TIMEOUT_MS,
      },
    );
    expectExitZero(whatsappRebuild, "M-WA4: rebuild completed after WhatsApp channel add");

    const providerList = await runHost(host, "openshell", ["provider", "list"], {
      artifactName: "provider-list-messaging-providers",
      env: state.env,
      redactionValues,
      timeoutMs: 60_000,
    });
    const providerListText = outputText(providerList);
    check(
      providerListText.includes(`${SANDBOX_NAME}-telegram-bridge`),
      "M1: Telegram provider exists in gateway",
    );
    check(
      providerListText.includes(`${SANDBOX_NAME}-discord-bridge`),
      "M2: Discord provider exists in gateway",
    );
    check(
      providerListText.includes(`${SANDBOX_NAME}-wechat-bridge`),
      "M-W1: WeChat provider exists in gateway",
    );
    check(
      providerListText.includes(`${SANDBOX_NAME}-extra-telegram-bot-token-agent-a`),
      "X1: provider registered for TELEGRAM_BOT_TOKEN_AGENT_A",
    );
    check(
      !providerListText.includes(`${SANDBOX_NAME}-extra-telegram-bot-token-agent-missing`),
      "X2: missing extra key produced no provider row",
    );
    check(
      !providerListText.includes(`${SANDBOX_NAME}-extra-github-token`),
      "X3: GITHUB_TOKEN refused by parser; no provider row registered",
    );

    const envDump = await sandboxOutput(
      sandbox,
      "env 2>/dev/null || true",
      "sandbox-env-dump-messaging-providers",
      redactionValues,
    );
    const processProbe = await sandboxOutput(
      sandbox,
      "cat /proc/[0-9]*/cmdline 2>/dev/null | tr '\\0' '\\n' || true",
      "sandbox-process-list-messaging-providers",
      redactionValues,
    );
    check(envDump.length > 0, "Phase 2: sandbox environment dump is available");
    check(processProbe.length > 0, "Phase 2: sandbox process list is available");

    const placeholderChecks: Array<[string, string, string]> = [
      ["M3", "TELEGRAM_BOT_TOKEN", state.tokens.telegram],
      ["M4", "DISCORD_BOT_TOKEN", state.tokens.discord],
      ["M-W3", "WECHAT_BOT_TOKEN", state.tokens.wechat],
    ];
    for (const [assertionId, key, token] of placeholderChecks) {
      const value = await sandboxOutput(
        sandbox,
        `printenv ${key} 2>/dev/null || true`,
        `placeholder-${key.toLowerCase()}`,
        redactionValues,
      );
      if (!value) {
        await skipNote(
          artifacts,
          skips,
          `${assertionId}: ${key} not set inside sandbox (provider-only mode)`,
        );
      } else {
        check(
          !value.includes(token),
          `${assertionId}: ${key} is a placeholder, not the host token`,
        );
        check(
          value.startsWith("openshell:resolve:env:"),
          `${assertionId}: ${key} uses OpenShell resolve placeholder`,
        );
      }
    }

    const leakChecks: Array<[string, string, string]> = [
      ["M5a/M5b/M5c", "Telegram", state.tokens.telegram],
      ["M5e/M5f/M5g", "Discord", state.tokens.discord],
      ["M-S5a/M-S5b/M-S5c", "Slack bot", state.tokens.slackBot],
      ["M-S5d/M-S5d2/M-S5e", "Slack app", state.tokens.slackApp],
      ["M-W3a/M-W3b/M-W3c", "WeChat", state.tokens.wechat],
      ["X6", "extra Telegram", state.tokens.extraTelegramA],
      ["X7", "refused GITHUB_TOKEN", state.tokens.extraGithub],
    ];
    for (const [assertionId, label, token] of leakChecks) {
      for (const surface of ["env", "process", "filesystem"] as const) {
        const probe = await rawTokenSurfaceProbe(
          sandbox,
          token,
          surface,
          `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${surface}-leak-probe`,
          redactionValues,
        );
        check(
          probe === "ABSENT",
          `${assertionId}: raw ${label} token absent from sandbox ${surface} (${probe.slice(0, 160)})`,
        );
      }
    }

    const extraA = await sandboxOutput(
      sandbox,
      "printenv TELEGRAM_BOT_TOKEN_AGENT_A 2>/dev/null || true",
      "extra-placeholder-agent-a",
      redactionValues,
    );
    const extraB = await sandboxOutput(
      sandbox,
      "printenv TELEGRAM_BOT_TOKEN_AGENT_B 2>/dev/null || true",
      "extra-placeholder-agent-b",
      redactionValues,
    );
    check(
      extraA.startsWith("openshell:resolve:env:"),
      "X4a: TELEGRAM_BOT_TOKEN_AGENT_A is canonical resolve placeholder",
    );
    check(
      extraB.startsWith("openshell:resolve:env:"),
      "X4b: TELEGRAM_BOT_TOKEN_AGENT_B is canonical resolve placeholder",
    );
    check(extraA !== extraB, "X4b: extension keys resolve to distinct placeholders");

    const startLog = await sandboxOutput(
      sandbox,
      "cat /tmp/nemoclaw-start.log 2>/dev/null || true",
      "start-log-messaging-providers",
      redactionValues,
    );
    check(
      /\[config\] NEMOCLAW_EXTRA_PLACEHOLDER_KEYS accepted \d+ entry\(ies\):/.test(startLog) &&
        startLog.includes("TELEGRAM_BOT_TOKEN_AGENT_A") &&
        !startLog.includes("GITHUB_TOKEN"),
      "X5: accepted-extras breadcrumb proves extra keys reached in-container parser",
    );

    const config = await readOpenClawConfig(sandbox, redactionValues);
    for (const [assertionId, channel, plugin] of [
      ["M6a", "telegram", "telegram"],
      ["M6b", "discord", "discord"],
      ["M6c", "slack", "slack"],
      ["M6d", "whatsapp", "whatsapp"],
    ] as const) {
      check(channelEnabled(config, channel), `${assertionId}: channels.${channel}.enabled is true`);
      check(
        pluginEnabled(config, plugin),
        `${assertionId}: plugins.entries.${plugin}.enabled is true`,
      );
    }

    const telegramAccount = channelAccount(config, "telegram");
    const discordAccount = channelAccount(config, "discord");
    const slackAccount = channelAccount(config, "slack");
    const whatsappAccount = channelAccount(config, "whatsapp");
    const wechatAccount = channelAccount(config, "openclaw-weixin", state.wechatAccount);

    const telegramBotToken = accountString(telegramAccount, "botToken");
    const discordToken = accountString(discordAccount, "token");
    check(telegramBotToken.length > 0, "M6: Telegram botToken present in openclaw.json");
    check(
      telegramBotToken !== state.tokens.telegram,
      "M7: Telegram botToken is not the host token",
    );
    check(discordToken.length > 0, "M8: Discord token present in openclaw.json");
    check(discordToken !== state.tokens.discord, "M9: Discord token is not the host token");
    check(accountBool(telegramAccount, "enabled") === true, "M10: Telegram account is enabled");
    check(accountBool(discordAccount, "enabled") === true, "M11: Discord account is enabled");
    check(
      accountString(telegramAccount, "dmPolicy") === "allowlist",
      "M11b: Telegram dmPolicy is allowlist",
    );
    check(
      accountString(telegramAccount, "groupPolicy") === "open",
      "M11d: Telegram groupPolicy is open",
    );
    check(
      accountString(slackAccount, "dmPolicy") === "allowlist",
      "M11f: Slack dmPolicy is allowlist",
    );
    check(
      accountString(slackAccount, "groupPolicy") === "allowlist",
      "M11g: Slack groupPolicy is allowlist",
    );
    const slackChannels = slackAccount.channels;
    const slackWildcard =
      slackChannels && typeof slackChannels === "object"
        ? (slackChannels as Record<string, Record<string, unknown>>)["*"]
        : undefined;
    check(
      slackWildcard?.enabled === true &&
        slackWildcard.requireMention === true &&
        Array.isArray(slackWildcard.users) &&
        state.slackIds
          .split(",")
          .every((id) => (slackWildcard.users as unknown[]).includes(id.trim())),
      "M11h: Slack wildcard channel mention allowlist contains expected users",
    );

    check(accountBool(whatsappAccount, "enabled") === true, "M-WA8: WhatsApp account is enabled");
    const whatsappHealth = whatsappAccount.healthMonitor;
    check(
      Boolean(
        whatsappHealth &&
          typeof whatsappHealth === "object" &&
          (whatsappHealth as Record<string, unknown>).enabled === false,
      ),
      "M-WA8a: WhatsApp health monitor is disabled for unpaired QR session",
    );
    check(
      !JSON.stringify(whatsappAccount).match(
        /token|secret|auth|session|openshell:resolve:env:WHATSAPP/i,
      ),
      "M-WA9: WhatsApp config has no token/auth/session provider placeholders",
    );
    check(
      accountBool(wechatAccount, "enabled") === true,
      "M-W8: WeChat configured account is enabled",
    );

    const wechatCredentialFile = await sandboxOutput(
      sandbox,
      `cat /sandbox/.openclaw/openclaw-weixin/accounts/${state.wechatAccount}.json 2>/dev/null || true`,
      "wechat-account-credential-file",
      redactionValues,
    );
    check(
      wechatCredentialFile.includes("openshell:resolve:env:WECHAT_BOT_TOKEN") &&
        !wechatCredentialFile.includes(state.tokens.wechat),
      "M-W9: WeChat account file uses L7-resolved placeholder",
    );
    const wechatIndex = await sandboxOutput(
      sandbox,
      "cat /sandbox/.openclaw/openclaw-weixin/accounts.json 2>/dev/null || true",
      "wechat-accounts-index",
      redactionValues,
    );
    check(
      wechatIndex.includes(state.wechatAccount),
      "M-W10: WeChat accounts index contains configured account",
    );

    const runtimeChannels = await sandboxOutput(
      sandbox,
      "timeout 45 openclaw channels list --all --json --no-color 2>/dev/null || true",
      "openclaw-channels-list-messaging-providers",
      redactionValues,
    );
    if (!runtimeChannels) {
      await skipNote(artifacts, skips, "M6e-M6h: OpenClaw channels list returned no output");
    } else {
      const parsedRuntime = JSON.parse(runtimeChannels) as {
        chat?: Record<string, { installed?: unknown; origin?: unknown; accounts?: unknown }>;
      };
      for (const [assertionId, channel, accountId] of [
        ["M6e", "telegram", "default"],
        ["M6f", "discord", "default"],
        ["M6g", "slack", "default"],
      ] as const) {
        const entry = parsedRuntime.chat?.[channel];
        check(
          entry?.installed === true &&
            entry.origin === "configured" &&
            Array.isArray(entry.accounts) &&
            entry.accounts.includes(accountId),
          `${assertionId}: OpenClaw channels list reports ${channel} installed/configured`,
        );
      }
      const whatsappRuntime = parsedRuntime.chat?.whatsapp;
      check(
        whatsappRuntime?.installed === true &&
          (whatsappRuntime.origin === "available" || whatsappRuntime.origin === "configured"),
        "M6h: OpenClaw channels list reports WhatsApp plugin installed",
      );
    }

    const telegramReach = await sandboxOutput(
      sandbox,
      `node -e '
const https = require("https");
const req = https.get("https://api.telegram.org/", (res) => {
  console.log("HTTP_" + res.statusCode);
  res.resume();
});
req.on("error", (e) => console.log("ERROR: " + e.message));
req.setTimeout(15000, () => { req.destroy(); console.log("TIMEOUT"); });
'`,
      "telegram-reachability-messaging-providers",
      redactionValues,
    );
    if (/HTTP_/.test(telegramReach)) {
      check(true, `M12: Node.js reached api.telegram.org (${telegramReach})`);
    } else if (
      /TIMEOUT|ECONNRESET|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|socket hang up/i.test(telegramReach)
    ) {
      await skipNote(
        artifacts,
        skips,
        `M12: api.telegram.org unreachable from this network (${telegramReach.slice(0, 160)})`,
      );
    } else {
      check(
        false,
        `M12: Node.js could not reach api.telegram.org (${telegramReach.slice(0, 200)})`,
      );
    }

    const discordPolicy = await runHost(
      host,
      "openshell",
      ["policy", "get", "--full", SANDBOX_NAME],
      {
        artifactName: "discord-policy-messaging-providers",
        env: state.env,
        redactionValues,
        timeoutMs: 60_000,
      },
    );
    const discordPolicyText = outputText(discordPolicy);
    check(
      policyTextHasHost(discordPolicyText, "discord.com") &&
        policyTextHasHost(discordPolicyText, "cdn.discordapp.com") &&
        /\/usr\/local\/bin\/node|\/usr\/bin\/node/.test(discordPolicyText),
      "M13-policy: live policy contains Discord endpoints and Node binaries",
    );

    const proxyEnv = await sandboxOutput(
      sandbox,
      'printf "HTTPS_PROXY=%s\\nhttps_proxy=%s\\nNO_PROXY=%s\\nno_proxy=%s\\n" "$HTTPS_PROXY" "$https_proxy" "$NO_PROXY" "$no_proxy"',
      "proxy-env-messaging-providers",
      redactionValues,
    );
    check(
      /10\.200\.0\.1:3128/.test(proxyEnv),
      "M13-proxy: sandbox uses the OpenShell gateway proxy",
    );

    const discordReach = await sandboxOutput(
      sandbox,
      `node - <<'NODE'
const https = require("https");
const targets = [
  ["api", "https://discord.com/api/v10/gateway"],
  ["cdn", "https://cdn.discordapp.com/"],
];
let pending = targets.length;
let failed = false;
function done() {
  pending -= 1;
  if (pending === 0) process.exit(0);
}
for (const [name, url] of targets) {
  const req = https.get(url, (res) => {
    console.log(\`\${name}:HTTP_\${res.statusCode}\`);
    res.resume();
    done();
  });
  req.on("error", (error) => {
    failed = true;
    console.log(\`\${name}:ERROR_\${error.message}\`);
    done();
  });
  req.setTimeout(15000, () => {
    failed = true;
    req.destroy();
    console.log(\`\${name}:TIMEOUT\`);
    done();
  });
}
NODE`,
      "discord-reachability-messaging-providers",
      redactionValues,
    );
    if (discordReach.includes("api:HTTP_") && discordReach.includes("cdn:HTTP_")) {
      check(true, "M13: Node.js reached Discord API and CDN through proxy");
    } else if (
      /TIMEOUT|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|ECONNRESET|socket hang up|network/i.test(
        discordReach,
      )
    ) {
      await skipNote(
        artifacts,
        skips,
        `M13: live Discord unreachable from this network (${discordReach.slice(0, 200)})`,
      );
    } else {
      check(false, `M13: Node.js could not reach Discord API/CDN (${discordReach.slice(0, 200)})`);
    }

    const curlReach = await sandboxOutput(
      sandbox,
      "curl -s --max-time 10 https://api.telegram.org/ 2>&1 || true",
      "curl-block-messaging-providers",
      redactionValues,
    );
    if (
      /blocked|denied|forbidden|refused|not found|no such|command not found|not installed/i.test(
        curlReach,
      ) ||
      !curlReach
    ) {
      check(true, "M14: curl to api.telegram.org is blocked or unavailable");
    } else {
      await skipNote(
        artifacts,
        skips,
        `M14: could not confirm curl is blocked (${curlReach.slice(0, 200)})`,
      );
    }

    const telegramApi = await sandboxOutput(
      sandbox,
      `node -e '
const https = require("https");
const token = process.env.TELEGRAM_BOT_TOKEN || "missing";
const req = https.get("https://api.telegram.org/bot" + token + "/getMe", (res) => {
  let body = "";
  res.on("data", (d) => { body += d; });
  res.on("end", () => console.log(res.statusCode + " " + body.slice(0, 300)));
});
req.on("error", (e) => console.log("ERROR: " + e.message));
req.setTimeout(30000, () => { req.destroy(); console.log("TIMEOUT"); });
'`,
      "telegram-l7-rewrite-messaging-providers",
      redactionValues,
    );
    const telegramStatus = telegramApi.match(/^(\d+)/m)?.[1] ?? "";
    if (["200", "401", "404"].includes(telegramStatus)) {
      check(
        true,
        `M15/M16: Telegram getMe status ${telegramStatus} proves placeholder reached API boundary`,
      );
    } else if (
      /TIMEOUT|ECONNRESET|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|socket hang up/i.test(telegramApi)
    ) {
      await skipNote(
        artifacts,
        skips,
        `M15: Telegram API timed out/unreachable (${telegramApi.slice(0, 160)})`,
      );
    } else {
      check(false, `M15: unexpected Telegram response (${telegramApi.slice(0, 200)})`);
    }

    const discordApi = await sandboxOutput(
      sandbox,
      `node -e '
const https = require("https");
const token = process.env.DISCORD_BOT_TOKEN || "missing";
const req = https.get({
  hostname: "discord.com",
  path: "/api/v10/users/@me",
  headers: { Authorization: "Bot " + token },
}, (res) => {
  let body = "";
  res.on("data", (d) => { body += d; });
  res.on("end", () => console.log(res.statusCode + " " + body.slice(0, 300)));
});
req.on("error", (e) => console.log("ERROR: " + e.message));
req.setTimeout(30000, () => { req.destroy(); console.log("TIMEOUT"); });
'`,
      "discord-l7-rewrite-messaging-providers",
      redactionValues,
    );
    const discordStatus = discordApi.match(/^(\d+)/m)?.[1] ?? "";
    if (["200", "401"].includes(discordStatus)) {
      check(
        true,
        `M17: Discord users/@me status ${discordStatus} proves placeholder reached API boundary`,
      );
    } else if (
      /TIMEOUT|ECONNRESET|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|socket hang up/i.test(discordApi)
    ) {
      await skipNote(
        artifacts,
        skips,
        `M17: Discord API timed out/unreachable (${discordApi.slice(0, 160)})`,
      );
    } else {
      check(false, `M17: unexpected Discord response (${discordApi.slice(0, 200)})`);
    }

    const fakeSlack = await startFakeDockerApi(host, cleanup.add.bind(cleanup), {
      kind: "slack",
      imageScript: "fake-slack-api.cjs",
      containerPrefix: "nemoclaw-fake-slack-vitest",
      portEnv: "FAKE_SLACK_API_PORT",
      portFileEnv: "FAKE_SLACK_API_PORT_FILE",
      captureFileEnv: "FAKE_SLACK_API_CAPTURE_FILE",
      expectedEnv: {
        FAKE_SLACK_API_EXPECTED_BOT_TOKEN: state.tokens.slackBot,
        FAKE_SLACK_API_EXPECTED_APP_TOKEN: state.tokens.slackApp,
      },
      env: state.env,
      redactionValues,
    });
    await applyRestRewritePolicy(host, fakeSlack, state.env, redactionValues);

    const slackAuth = await runSlackApiRequest(
      sandbox,
      fakeSlack.port,
      "/api/auth.test",
      "Bearer xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
      redactionValues,
    );
    check(
      /^200\b/.test(slackAuth) && /invalid_auth|not_authed|ok":true/.test(slackAuth),
      `M-S15: Slack auth.test exercised alias rewrite (${slackAuth.slice(0, 200)})`,
    );
    const slackAuthCapture = lastJsonLine(
      fakeSlack.captureFile,
      (row) => row.event === "request" && row.path === "/api/auth.test",
    );
    check(
      slackAuthCapture?.tokenMatchesExpected === true &&
        slackAuthCapture.bodyMatchesExpected === true &&
        slackAuthCapture.tokenLooksPlaceholder !== true &&
        slackAuthCapture.authorization === undefined &&
        slackAuthCapture.body === undefined,
      "M-S15a: fake Slack saw host-side bot token without raw capture leakage",
    );

    const slackCanonical = await runSlackApiRequest(
      sandbox,
      fakeSlack.port,
      "/api/auth.test",
      "Bearer openshell:resolve:env:SLACK_BOT_TOKEN",
      redactionValues,
    );
    check(
      /^200\b/.test(slackCanonical) && /invalid_auth|not_authed|ok":true/.test(slackCanonical),
      "M-S15b: L7 proxy substitutes canonical SLACK_BOT_TOKEN placeholder",
    );
    const slackUnset = await runSlackApiRequest(
      sandbox,
      fakeSlack.port,
      "/api/auth.test",
      "Bearer openshell:resolve:env:DEFINITELY_NOT_SET_XYZ",
      redactionValues,
    );
    check(
      isUnresolvedPlaceholderRejection(slackUnset) ||
        /ERROR:.*(socket hang up|ECONNRESET|EPIPE|hang up|reset)/i.test(slackUnset),
      `M-S15c: unset-var failed closed before upstream exposure (${slackUnset.slice(0, 200)})`,
    );

    const slackApp = await runSlackApiRequest(
      sandbox,
      fakeSlack.port,
      "/api/apps.connections.open",
      "Bearer xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN",
      redactionValues,
    );
    check(
      /^200\b/.test(slackApp) &&
        /invalid_auth|not_authed|not_allowed_token_type|ok":true/.test(slackApp),
      "M-S16: Slack Socket Mode HTTPS leg exercised xapp alias rewrite",
    );
    const slackAppCapture = lastJsonLine(
      fakeSlack.captureFile,
      (row) => row.event === "request" && row.path === "/api/apps.connections.open",
    );
    check(
      slackAppCapture?.tokenMatchesExpected === true &&
        slackAppCapture.bodyMatchesExpected === true &&
        slackAppCapture.tokenLooksPlaceholder !== true,
      "M-S16a: fake Slack saw host-side app token in header/body",
    );

    const fakeGateway = await startFakeDockerApi(host, cleanup.add.bind(cleanup), {
      kind: "discord-gateway",
      imageScript: "fake-discord-gateway.cjs",
      containerPrefix: "nemoclaw-fake-discord-gateway-vitest",
      portEnv: "FAKE_DISCORD_GATEWAY_PORT",
      portFileEnv: "FAKE_DISCORD_GATEWAY_PORT_FILE",
      captureFileEnv: "FAKE_DISCORD_GATEWAY_CAPTURE_FILE",
      expectedEnv: {
        FAKE_DISCORD_GATEWAY_EXPECTED_TOKEN: state.tokens.discord,
      },
      env: state.env,
      redactionValues,
    });
    await applyWebSocketRewritePolicy(host, fakeGateway, state.env, redactionValues);
    const gatewayProof = await runDiscordGatewayClient(
      sandbox,
      fakeGateway.port,
      "openshell:resolve:env:DISCORD_BOT_TOKEN",
      redactionValues,
    );
    check(
      gatewayProof.includes("UPGRADE"),
      "M13d: native WebSocket upgrade reached fake Discord Gateway",
    );
    check(
      gatewayProof.includes("HELLO") &&
        gatewayProof.includes("IDENTIFY_SENT_PLACEHOLDER") &&
        gatewayProof.includes("READY") &&
        gatewayProof.includes("HEARTBEAT_ACK"),
      "M13e: Discord HELLO, placeholder IDENTIFY, READY, heartbeat ACK completed",
    );
    const gatewayIdentify = lastJsonLine(
      fakeGateway.captureFile,
      (row) => row.event === "identify",
    );
    check(
      gatewayIdentify?.tokenMatchesExpected === true &&
        gatewayIdentify?.tokenLooksPlaceholder === false,
      "M13f: fake Gateway received host-side Discord token after relay rewrite",
    );

    const gatewayPort = await sandboxOutput(
      sandbox,
      `node -e '
const net = require("net");
const sock = net.connect(18789, "127.0.0.1");
sock.on("connect", () => { console.log("OPEN"); sock.end(); });
sock.on("error", () => console.log("CLOSED"));
setTimeout(() => { console.log("TIMEOUT"); sock.destroy(); }, 5000);
'`,
      "gateway-port-messaging-providers",
      redactionValues,
    );
    check(gatewayPort.includes("OPEN"), "S1: gateway is serving on port 18789");

    const gatewayLog = await sandboxOutput(
      sandbox,
      "cat /tmp/gateway.log 2>/dev/null || true",
      "gateway-log-messaging-providers",
      redactionValues,
    );
    if (/provider failed to start:.*gateway continues/.test(gatewayLog)) {
      check(true, "S2: gateway log shows Slack rejection was caught by channel guard");
    } else if (/slack/i.test(gatewayLog)) {
      await skipNote(
        artifacts,
        skips,
        "S2: gateway log has Slack output but not the guard catch message",
      );
    } else {
      await skipNote(artifacts, skips, "S2: no Slack-related output in gateway log");
    }

    const doctor = await runHost(host, "node", [CLI_ENTRYPOINT, SANDBOX_NAME, "doctor", "--json"], {
      artifactName: "doctor-json-messaging-providers",
      env: state.env,
      redactionValues,
      timeoutMs: 120_000,
    });
    if (doctor.exitCode !== 0 || !doctor.stdout.trim()) {
      await skipNote(artifacts, skips, "RT0: could not collect doctor --json output");
    } else {
      const report = JSON.parse(doctor.stdout) as {
        checks?: Array<{ label?: string; status?: string; detail?: string }>;
      };
      const runtimeCheck = report.checks?.find((item) => item.label === "Runtime channel registry");
      if (!runtimeCheck) {
        await skipNote(
          artifacts,
          skips,
          "RT1: doctor --json had no Runtime channel registry check",
        );
      } else {
        check(
          runtimeCheck.status === "ok" || runtimeCheck.status === "warn",
          `RT1: doctor reports runtime channel registry status (${runtimeCheck.status})`,
        );
      }
    }

    const telegramRealTarget = nonEmpty(process.env.TELEGRAM_CHAT_ID_E2E);
    if (nonEmpty(process.env.TELEGRAM_BOT_TOKEN_REAL) && telegramRealTarget) {
      check(telegramStatus === "200", "M18: Telegram getMe returned 200 with real token");
      const send = await runSandboxShell(
        sandbox,
        `OPENCLAW_NO_COLOR=1 openclaw message send --channel telegram --target ${shellQuote(telegramRealTarget)} --message "NemoClaw OpenClaw Telegram plugin E2E $(date -u +%Y-%m-%dT%H:%M:%SZ)" --json`,
        {
          artifactName: "real-telegram-send-messaging-providers",
          redactionValues,
          timeoutMs: 120_000,
        },
      );
      check(
        send.exitCode === 0,
        `M19: Telegram openclaw message send succeeded (${outputText(send).slice(0, 200)})`,
      );
    } else {
      await skipNote(
        artifacts,
        skips,
        "M18/M19: complete real Telegram credentials not available; fake-token L7 proof covered provider rewrite",
      );
    }

    const discordRealTarget = nonEmpty(process.env.DISCORD_CHANNEL_ID_E2E);
    if (nonEmpty(process.env.DISCORD_BOT_TOKEN_REAL) && discordRealTarget) {
      check(discordStatus === "200", "M20: Discord users/@me returned 200 with real token");
      const send = await runSandboxShell(
        sandbox,
        `OPENCLAW_NO_COLOR=1 openclaw message send --channel discord --target ${shellQuote(`channel:${discordRealTarget}`)} --message "NemoClaw OpenClaw Discord plugin E2E $(date -u +%Y-%m-%dT%H:%M:%SZ)" --json`,
        {
          artifactName: "real-discord-send-messaging-providers",
          redactionValues,
          timeoutMs: 120_000,
        },
      );
      check(
        send.exitCode === 0,
        `M21: Discord openclaw message send succeeded (${outputText(send).slice(0, 200)})`,
      );
    } else {
      await skipNote(
        artifacts,
        skips,
        "M20/M21: complete real Discord credentials not available; fake Gateway proof covered provider rewrite",
      );
    }

    const slackRealTarget = nonEmpty(process.env.SLACK_CHANNEL_ID_E2E);
    if (nonEmpty(process.env.SLACK_BOT_TOKEN_REAL) && slackRealTarget) {
      const send = await runSandboxShell(
        sandbox,
        `OPENCLAW_NO_COLOR=1 openclaw message send --channel slack --target ${shellQuote(`channel:${slackRealTarget}`)} --message "NemoClaw OpenClaw Slack plugin E2E $(date -u +%Y-%m-%dT%H:%M:%SZ)" --json`,
        {
          artifactName: "real-slack-send-messaging-providers",
          redactionValues,
          timeoutMs: 120_000,
        },
      );
      check(
        send.exitCode === 0,
        `M23: Slack openclaw message send succeeded (${outputText(send).slice(0, 200)})`,
      );
    } else {
      check(
        slackAuthCapture?.tokenMatchesExpected === true &&
          slackAppCapture?.tokenMatchesExpected === true,
        "M22/M23: Slack host mock accepted OpenShell-rewritten bot/app tokens",
      );
    }
  },
);
