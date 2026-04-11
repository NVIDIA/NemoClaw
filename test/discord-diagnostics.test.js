// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  buildDiscordProbeCommand,
  buildDiscordProbeScript,
  getDiscordBridgeToken,
  getDiscordProbeToken,
} = require("../bin/lib/discord-diagnostics");

describe("discord diagnostics", () => {
  it("builds a sandbox probe command that uses sandbox ssh config", () => {
    const command = buildDiscordProbeCommand("the-crucible", {
      token: "abc123",
      openshellPath: "/usr/local/bin/openshell",
    });

    assert.match(command, /mktemp \/tmp\/nemoclaw-dc-probe-XXXXXX\.conf/);
    assert.match(command, /'\/usr\/local\/bin\/openshell' sandbox ssh-config 'the-crucible'/);
    assert.match(command, /ssh -T -F "\$probe_ssh_config" 'openshell-the-crucible' bash -s/);
    assert.match(command, /EOF_NEMOCLAW_DISCORD_PROBE/);
    assert.match(command, /discord\.com/);
  });

  it("includes DNS, HTTPS, and authenticated Bot API checks when a token is provided", () => {
    const script = buildDiscordProbeScript({ token: "abc123" });

    assert.match(script, /section "Proxy"/);
    assert.match(script, /proxy_env_lines=none/);
    assert.match(script, /no_proxy_matches_discord\.com=/);
    assert.match(script, /HTTP_PROXY\|HTTPS_PROXY\|ALL_PROXY\|NO_PROXY/);
    assert.match(script, /http_proxy_source=/);
    assert.match(script, /http_proxy_target=/);
    assert.match(script, /section "Proxy Endpoint"/);
    assert.match(script, /proxy_endpoint_host=/);
    assert.match(script, /proxy_endpoint_port=/);
    assert.match(script, /proxy_tcp_connect=ok/);
    assert.match(script, /pass 'proxy endpoint tcp connect'/);
    assert.match(script, /getent ahostsv4 discord\.com/);
    assert.match(script, /getent hosts gateway\.discord\.gg/);
    assert.match(script, /socket\.getaddrinfo\(host, 443/);
    assert.match(script, /advisory_fail 'dns discord'/);
    assert.match(
      script,
      /curl -sS -o \/dev\/null -D "\$curl_header_file" --max-time 15 https:\/\/discord\.com\/api\/v10\/gateway/,
    );
    assert.match(script, /DISCORD_BOT_TOKEN='abc123'/);
    assert.match(script, /section "Bot API \(curl\)"/);
    assert.match(script, /https:\/\/discord\.com\/api\/v10\/users\/@me/);
    assert.match(script, /discord bot users me \(curl\)/);
    assert.match(script, /section "Bot API \(node\)"/);
    assert.match(script, /require\("node:https"\)/);
    assert.match(script, /node_bot_http_status=/);
    assert.match(script, /node_bot_id=/);
    assert.match(script, /discord bot users me \(node\)/);
    assert.match(script, /discord_probe_advisory=/);
    assert.match(script, /discord_probe_exit=\$\{0,1\}|discord_probe_exit=%s/);
  });

  it("skips the authenticated Bot API probe when no token is available", () => {
    const script = buildDiscordProbeScript();

    assert.match(script, /DISCORD_BOT_TOKEN=''/);
    assert.match(script, /skipping authenticated Bot API probe/);
  });

  it("prefers DISCORD_BOT_TOKEN from the environment before credentials", () => {
    const token = getDiscordProbeToken({ DISCORD_BOT_TOKEN: "from-env" }, () => "from-creds");

    assert.equal(token, "from-env");
  });

  it("falls back to credentials when DISCORD_BOT_TOKEN is absent from the environment", () => {
    const token = getDiscordProbeToken({}, () => "from-creds");
    assert.equal(token, "from-creds");
  });

  it("reuses the running bridge token when env and credentials are empty", () => {
    const fs = require("fs");
    const fakeFs = {
      ...fs,
      existsSync(filePath) {
        return (
          filePath === "/tmp/nemoclaw-services-the-crucible/discord-bridge.pid" ||
          filePath === "/proc/4242/environ"
        );
      },
      readFileSync(filePath) {
        if (filePath === "/tmp/nemoclaw-services-the-crucible/discord-bridge.pid") {
          return "4242\n";
        }
        if (filePath === "/proc/4242/environ") {
          return Buffer.from("SANDBOX_NAME=the-crucible\0DISCORD_BOT_TOKEN=from-bridge\0");
        }
        throw new Error(`unexpected path: ${filePath}`);
      },
    };
    const fakeFsModule = /** @type {any} */ (fakeFs);

    assert.equal(getDiscordBridgeToken("the-crucible", fakeFsModule), "from-bridge");
    assert.equal(
      getDiscordProbeToken({}, () => null, { sandboxName: "the-crucible", fsModule: fakeFsModule }),
      "from-bridge",
    );
  });
});
