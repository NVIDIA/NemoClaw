// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import {
  buildGatewayLogScanScript,
  compareChannelSets,
  extractEnabledChannelsFromOpenclawConfig,
  parseGatewayLogScanOutput,
  probeChannelRuntimeStatus,
} from "../../dist/lib/channel-runtime-status.js";

// Build an executeSandboxCommand mock that returns the config file body
// on the `cat` call and a synthesized gateway-log-scan output on the
// scan call. `logChannelsFound` is the list of FOUND:<pattern> entries
// the scan emits; null suppresses the OK marker entirely (simulates a
// missing log file). Pass `null` for either to make the exec spawn fail.
function makeMockExec(
  configBody: string | null,
  logChannelsFound: string[] | null,
): (script: string) => { status: number; stdout: string; stderr: string } | null {
  return (script: string) => {
    if (script.startsWith("cat ")) {
      if (configBody === null) return null;
      return { status: 0, stdout: configBody, stderr: "" };
    }
    if (script.includes("GATEWAY_LOG_PROBED")) {
      if (logChannelsFound === null) {
        // `if test -r path` evaluated false — nothing was echoed.
        return { status: 0, stdout: "", stderr: "" };
      }
      const lines = ["GATEWAY_LOG_PROBED", ...logChannelsFound.map((p) => `FOUND:${p}`)];
      return { status: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
    }
    return null;
  };
}

describe("extractEnabledChannelsFromOpenclawConfig", () => {
  it("returns empty for non-object input", () => {
    expect(extractEnabledChannelsFromOpenclawConfig(null)).toEqual([]);
    expect(extractEnabledChannelsFromOpenclawConfig(undefined)).toEqual([]);
    expect(extractEnabledChannelsFromOpenclawConfig("oops")).toEqual([]);
    expect(extractEnabledChannelsFromOpenclawConfig(42)).toEqual([]);
  });

  it("returns empty when channels block is missing or empty", () => {
    expect(extractEnabledChannelsFromOpenclawConfig({})).toEqual([]);
    expect(extractEnabledChannelsFromOpenclawConfig({ channels: {} })).toEqual([]);
    expect(extractEnabledChannelsFromOpenclawConfig({ channels: { defaults: {} } })).toEqual([]);
  });

  it("collects channels with at least one enabled account", () => {
    const config = {
      channels: {
        telegram: { accounts: { default: { enabled: true, botToken: "x" } } },
        slack: {
          accounts: {
            default: { enabled: true, botToken: "x", appToken: "y" },
          },
        },
      },
    };
    expect(extractEnabledChannelsFromOpenclawConfig(config)).toEqual(["slack", "telegram"]);
  });

  it("skips channels whose only account has enabled=false", () => {
    const config = {
      channels: {
        telegram: { accounts: { default: { enabled: false } } },
        discord: { accounts: { default: { enabled: true } } },
      },
    };
    expect(extractEnabledChannelsFromOpenclawConfig(config)).toEqual(["discord"]);
  });

  it("maps openclaw-weixin to wechat", () => {
    const config = {
      channels: {
        "openclaw-weixin": {
          accounts: {
            "wechat-acct-1": { enabled: true },
          },
        },
      },
    };
    expect(extractEnabledChannelsFromOpenclawConfig(config)).toEqual(["wechat"]);
  });

  it("includes WhatsApp's token-less account when enabled", () => {
    const config = {
      channels: {
        whatsapp: {
          accounts: {
            default: { enabled: true },
          },
        },
      },
    };
    expect(extractEnabledChannelsFromOpenclawConfig(config)).toEqual(["whatsapp"]);
  });

  it("dedupes when multiple accounts under one channel are enabled", () => {
    const config = {
      channels: {
        discord: {
          accounts: {
            primary: { enabled: true },
            secondary: { enabled: true },
          },
        },
      },
    };
    expect(extractEnabledChannelsFromOpenclawConfig(config)).toEqual(["discord"]);
  });

  it("ignores unknown channel keys", () => {
    const config = {
      channels: {
        "vendor-future": { accounts: { default: { enabled: true } } },
        telegram: { accounts: { default: { enabled: true } } },
      },
    };
    expect(extractEnabledChannelsFromOpenclawConfig(config)).toEqual(["telegram"]);
  });

  it("treats missing accounts block as no enabled accounts", () => {
    const config = {
      channels: {
        telegram: { enabled: true },
      },
    };
    expect(extractEnabledChannelsFromOpenclawConfig(config)).toEqual([]);
  });
});

describe("buildGatewayLogScanScript", () => {
  it("emits a `test -r` guard and the OK marker", () => {
    const script = buildGatewayLogScanScript("/tmp/gateway.log");
    expect(script).toContain("test -r '/tmp/gateway.log'");
    expect(script).toContain("echo GATEWAY_LOG_PROBED");
  });

  it("isolates the current launch segment with awk before grepping", () => {
    // Without launch-segment isolation a stale channel mention from a
    // previous gateway run would still satisfy the probe even though the
    // *current* OpenClaw process never started the channel (#4156 review).
    // The awk filter resets its buffer on every boot/respawn marker so
    // only the segment since the last launch reaches grep.
    const script = buildGatewayLogScanScript("/tmp/gateway.log");
    expect(script).toContain("(launched|respawning)");
    expect(script).toContain('buf=""');
    expect(script).toContain("grep -iwoE 'telegram|discord|slack|whatsapp|wechat|openclaw-weixin'");
    expect(script).not.toContain("tail -n");
    expect(script).not.toContain("grep -m 1 -iwF 'telegram'");
  });

  it("escapes single quotes in the log path", () => {
    const script = buildGatewayLogScanScript("/tmp/odd'path.log");
    expect(script).toContain(`'/tmp/odd'\\''path.log'`);
  });
});

describe("parseGatewayLogScanOutput", () => {
  it("collects channel names from FOUND: lines", () => {
    const stdout = `GATEWAY_LOG_PROBED
FOUND:telegram
FOUND:discord
`;
    expect([...parseGatewayLogScanOutput(stdout)].sort()).toEqual(["discord", "telegram"]);
  });

  it("collapses openclaw-weixin onto wechat", () => {
    const stdout = `GATEWAY_LOG_PROBED
FOUND:openclaw-weixin
`;
    expect([...parseGatewayLogScanOutput(stdout)]).toEqual(["wechat"]);
  });

  it("returns an empty set when no FOUND: lines are present", () => {
    expect(parseGatewayLogScanOutput("GATEWAY_LOG_PROBED\n").size).toBe(0);
  });

  it("matches case-insensitively because grep -iwoE preserves log casing", () => {
    // The grep in the script keeps whatever case the log line used. The
    // parser normalizes so an OpenClaw log mentioning "Telegram" still
    // collapses onto the canonical "telegram" channel name.
    const stdout = `GATEWAY_LOG_PROBED
FOUND:Telegram
FOUND:WHATSAPP
`;
    expect([...parseGatewayLogScanOutput(stdout)].sort()).toEqual(["telegram", "whatsapp"]);
  });
});

describe("buildGatewayLogScanScript end-to-end shell behavior", () => {
  // Real-shell execution to confirm the awk/grep pipeline does what the
  // unit tests assert in structure. This guards against subtle quoting
  // and shell-flag drift between the builder and a sandbox sh.
  const { spawnSync, writeFileSync, unlinkSync, mkdtempSync, tmpdir, joinPath } = (() => {
    const cp = require("node:child_process");
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    return {
      spawnSync: cp.spawnSync,
      writeFileSync: fs.writeFileSync,
      unlinkSync: fs.unlinkSync,
      mkdtempSync: fs.mkdtempSync,
      tmpdir: os.tmpdir,
      joinPath: path.join,
    };
  })();

  function runScript(logBody: string): Set<string> {
    const dir = mkdtempSync(joinPath(tmpdir(), "channel-runtime-status-"));
    const logPath = joinPath(dir, "gateway.log");
    writeFileSync(logPath, logBody);
    const script = buildGatewayLogScanScript(logPath);
    try {
      // spawnSync with `shell: false` (default) and the script passed as
      // an explicit argv element so the OS receives it verbatim. Avoids
      // the brittle/CodeQL-flagged double-escape gymnastics that
      // `execSync(\`sh -c "${...}"\`)` would force. The pipeline can
      // legitimately exit non-zero when no channel matches, but we only
      // care about stdout regardless of exit status.
      const result = spawnSync("sh", ["-c", script], { encoding: "utf-8" });
      return parseGatewayLogScanOutput(String(result.stdout || ""));
    } finally {
      try {
        unlinkSync(logPath);
      } catch {
        /* best-effort cleanup */
      }
    }
  }

  it("returns only channels mentioned since the last gateway boot", () => {
    const logBody = [
      "2026-05-25 [gateway] openclaw gateway launched (pid 1)",
      "2026-05-25 [info] discord registered",
      "2026-05-25 [gateway] pid 1 exited (rc=2); respawning (#1)",
      "2026-05-25 [info] Starting telegram bridge",
    ].join("\n");
    expect([...runScript(logBody)].sort()).toEqual(["telegram"]);
  });

  it("returns an empty set when the current launch segment has no channel mentions (#4156)", () => {
    const logBody = [
      "2026-05-25 [gateway] openclaw gateway launched (pid 1)",
      "2026-05-25 [info] Starting telegram bridge",
      "2026-05-25 [gateway] pid 1 exited (rc=2); respawning (#1)",
      "2026-05-25 [error] failed to load channel config",
    ].join("\n");
    expect([...runScript(logBody)]).toEqual([]);
  });

  it("collapses openclaw-weixin in the live log onto the wechat channel name", () => {
    const logBody = [
      "2026-05-25 [gateway] openclaw gateway launched (pid 1)",
      "2026-05-25 [info] openclaw-weixin plugin loaded",
    ].join("\n");
    expect([...runScript(logBody)]).toEqual(["wechat"]);
  });
});

describe("probeChannelRuntimeStatus", () => {
  it("returns ok=false when sandbox exec fails", () => {
    const result = probeChannelRuntimeStatus({
      configFilePath: "/sandbox/.openclaw/openclaw.json",
      executeSandboxCommand: () => null,
    });
    expect(result.ok).toBe(false);
    expect(result.visibleChannels).toEqual([]);
    expect(result.detail).toContain("sandbox unreachable");
    expect(result.logProbeOk).toBe(false);
  });

  it("returns ok=false when config file is missing or empty", () => {
    const result = probeChannelRuntimeStatus({
      configFilePath: "/sandbox/.openclaw/openclaw.json",
      executeSandboxCommand: makeMockExec("", []),
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("missing or empty");
  });

  it("returns ok=false on invalid JSON", () => {
    const result = probeChannelRuntimeStatus({
      configFilePath: "/sandbox/.openclaw/openclaw.json",
      executeSandboxCommand: makeMockExec("{not json", []),
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("not valid JSON");
  });

  it("treats a configured channel as visible when the gateway log mentions it", () => {
    const config = JSON.stringify({
      channels: { telegram: { accounts: { default: { enabled: true } } } },
    });
    const result = probeChannelRuntimeStatus({
      configFilePath: "/sandbox/.openclaw/openclaw.json",
      executeSandboxCommand: makeMockExec(config, ["telegram"]),
    });
    expect(result.ok).toBe(true);
    expect(result.logProbeOk).toBe(true);
    expect(result.visibleChannels).toEqual(["telegram"]);
    expect(result.configuredButNotRunning).toEqual([]);
  });

  it("flags a configured channel as not-running when the gateway log never mentions it (#4156 reporter case)", () => {
    // Reporter symptom: openclaw.json had the telegram block but the
    // dashboard rendered "No channels found." This is the failure mode —
    // configured but the OpenClaw runtime never logged anything for it.
    const config = JSON.stringify({
      channels: {
        telegram: {
          accounts: {
            default: { enabled: true, botToken: "openshell:resolve:env:TELEGRAM_BOT_TOKEN" },
          },
        },
      },
    });
    const result = probeChannelRuntimeStatus({
      configFilePath: "/sandbox/.openclaw/openclaw.json",
      executeSandboxCommand: makeMockExec(config, []),
    });
    expect(result.ok).toBe(true);
    expect(result.logProbeOk).toBe(true);
    expect(result.visibleChannels).toEqual([]);
    expect(result.configuredButNotRunning).toEqual(["telegram"]);
  });

  it("returns empty visible channels when runtime config has no channels block", () => {
    const result = probeChannelRuntimeStatus({
      configFilePath: "/sandbox/.openclaw/openclaw.json",
      executeSandboxCommand: makeMockExec(JSON.stringify({ models: {} }), []),
    });
    expect(result.ok).toBe(true);
    expect(result.visibleChannels).toEqual([]);
    expect(result.configuredButNotRunning).toEqual([]);
  });

  it("collapses openclaw-weixin in the log onto the wechat channel name", () => {
    const config = JSON.stringify({
      channels: {
        "openclaw-weixin": { accounts: { "acct-1": { enabled: true } } },
      },
    });
    const result = probeChannelRuntimeStatus({
      configFilePath: "/sandbox/.openclaw/openclaw.json",
      // Log mentions only the plugin name, not "wechat"
      executeSandboxCommand: makeMockExec(config, ["openclaw-weixin"]),
    });
    expect(result.visibleChannels).toEqual(["wechat"]);
    expect(result.configuredButNotRunning).toEqual([]);
  });

  it("keeps visibleChannels empty when the gateway log is missing, so callers do not treat an inconclusive probe as healthy", () => {
    const config = JSON.stringify({
      channels: { telegram: { accounts: { default: { enabled: true } } } },
    });
    const result = probeChannelRuntimeStatus({
      configFilePath: "/sandbox/.openclaw/openclaw.json",
      // logChannelsFound=null = no OK marker emitted = log unreadable
      executeSandboxCommand: makeMockExec(config, null),
    });
    expect(result.ok).toBe(true);
    expect(result.logProbeOk).toBe(false);
    // `visibleChannels` is documented as "config + log corroborated". When
    // the log layer is unavailable, the runtime view is unknown — keep it
    // empty so callers must consult `logProbeOk` and decide how to render
    // the caveat instead of treating config-only as healthy
    // (CodeRabbit catch on PR #4182).
    expect(result.visibleChannels).toEqual([]);
    expect(result.configuredButNotRunning).toEqual([]);
    // But the config-derived set is still exposed so callers can detect
    // stale-rebuild mismatches without runtime corroboration.
    expect(result.configuredChannels).toEqual(["telegram"]);
    expect(result.detail).toContain("unreadable");
  });

  it("escapes single quotes in the config file path", () => {
    const captured: string[] = [];
    probeChannelRuntimeStatus({
      configFilePath: "/sandbox/.open'claw/openclaw.json",
      executeSandboxCommand: (script: string) => {
        captured.push(script);
        if (script.startsWith("cat ")) return { status: 0, stdout: "{}", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    expect(captured[0]).toContain(`'/sandbox/.open'\\''claw/openclaw.json'`);
  });

  it("honors a custom gateway log path override", () => {
    const captured: string[] = [];
    probeChannelRuntimeStatus({
      configFilePath: "/sandbox/.openclaw/openclaw.json",
      gatewayLogPath: "/var/log/openclaw/agent.log",
      executeSandboxCommand: (script: string) => {
        captured.push(script);
        if (script.startsWith("cat ")) return { status: 0, stdout: "{}", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    const scanScript = captured.find((s) => s.includes("GATEWAY_LOG_PROBED"));
    expect(scanScript).toBeDefined();
    expect(scanScript).toContain("/var/log/openclaw/agent.log");
    // No `tail` fallback should remain — the probe scans the full file.
    expect(captured.every((s) => !s.startsWith("tail "))).toBe(true);
  });
});

describe("compareChannelSets", () => {
  it("returns empty when sets match", () => {
    expect(compareChannelSets(["telegram", "discord"], ["discord", "telegram"])).toEqual({
      missing: [],
      unexpected: [],
    });
  });

  it("reports configured channels missing from the runtime view", () => {
    expect(compareChannelSets(["telegram", "slack"], ["telegram"])).toEqual({
      missing: ["slack"],
      unexpected: [],
    });
  });

  it("reports runtime channels not present in the configured view", () => {
    expect(compareChannelSets(["telegram"], ["telegram", "discord"])).toEqual({
      missing: [],
      unexpected: ["discord"],
    });
  });

  it("dedupes configured input before comparing", () => {
    expect(compareChannelSets(["telegram", "telegram"], ["telegram"])).toEqual({
      missing: [],
      unexpected: [],
    });
  });

  it("sorts the missing/unexpected outputs", () => {
    expect(compareChannelSets(["telegram", "slack", "discord"], ["whatsapp"])).toEqual({
      missing: ["discord", "slack", "telegram"],
      unexpected: ["whatsapp"],
    });
  });
});
