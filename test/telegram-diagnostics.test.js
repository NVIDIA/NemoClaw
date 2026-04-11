// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  buildTelegramProbeCommand,
  buildTelegramProbeScript,
  getTelegramBridgeToken,
  getTelegramProbeToken,
} = require("../bin/lib/telegram-diagnostics");

describe("telegram diagnostics", () => {
  it("builds a sandbox probe command that uses sandbox ssh config", () => {
    const command = buildTelegramProbeCommand("the-crucible", {
      token: "abc123",
      openshellPath: "/usr/local/bin/openshell",
    });

    assert.match(command, /mktemp \/tmp\/nemoclaw-tg-probe-XXXXXX\.conf/);
    assert.match(command, /'\/usr\/local\/bin\/openshell' sandbox ssh-config 'the-crucible'/);
    assert.match(command, /ssh -T -F "\$probe_ssh_config" 'openshell-the-crucible' bash -s/);
    assert.match(command, /EOF_NEMOCLAW_TELEGRAM_PROBE/);
    assert.match(command, /api\.telegram\.org/);
  });

  it("includes DNS, HTTPS, and authenticated Bot API checks when a token is provided", () => {
    const script = buildTelegramProbeScript({ token: "abc123" });

    assert.match(script, /section "Proxy"/);
    assert.match(script, /proxy_env_lines=none/);
    assert.match(script, /no_proxy_matches_api\.telegram\.org=/);
    assert.match(script, /HTTP_PROXY\|HTTPS_PROXY\|ALL_PROXY\|NO_PROXY/);
    assert.match(script, /http_proxy_source=/);
    assert.match(script, /http_proxy_target=/);
    assert.match(script, /section "Proxy Endpoint"/);
    assert.match(script, /proxy_endpoint_host=/);
    assert.match(script, /proxy_endpoint_port=/);
    assert.match(script, /proxy_tcp_connect=ok/);
    assert.match(script, /proxy_endpoint_http_status=/);
    assert.match(script, /pass 'proxy endpoint tcp connect'/);
    assert.match(script, /pass 'proxy endpoint http'/);
    assert.match(script, /curl --silent --show-error --no-progress-meter --noproxy '\*'/);
    assert.match(script, /section "Proxy Routing"/);
    assert.match(script, /run_route_probe_for_url/);
    assert.match(script, /run_route_probe default curl/);
    assert.match(
      script,
      /run_route_probe forced-proxy env NO_PROXY= no_proxy= curl --proxy "\$selected_proxy_target" --noproxy ""/,
    );
    assert.match(
      script,
      /run_route_probe forced-bypass env HTTPS_PROXY= HTTP_PROXY= ALL_PROXY= https_proxy= http_proxy= all_proxy= curl --noproxy '\*'/,
    );
    assert.match(script, /section "Proxy Comparison"/);
    assert.match(script, /comparison_probe_url="https:\/\/example\.com\/"/);
    assert.match(
      script,
      /run_route_probe_for_url comparison-default "\$comparison_probe_url" curl/,
    );
    assert.match(
      script,
      /run_route_probe_for_url comparison-forced-proxy "\$comparison_probe_url" env NO_PROXY= no_proxy= curl --proxy "\$selected_proxy_target" --noproxy ""/,
    );
    assert.match(script, /--silent --show-error --no-progress-meter/);
    assert.match(script, /curl --proxy "\$selected_proxy_target" --noproxy ""/);
    assert.match(script, /curl --noproxy '\*'/);
    assert.match(script, /getent ahostsv4 api\.telegram\.org/);
    assert.match(script, /socket\.getaddrinfo\('api\.telegram\.org', 443/);
    assert.match(script, /advisory_fail 'dns api\.telegram\.org'/);
    assert.match(
      script,
      /curl -sS -o \/dev\/null -D "\$curl_header_file" --max-time 15 https:\/\/api\.telegram\.org\//,
    );
    assert.match(script, /TELEGRAM_BOT_TOKEN='abc123'/);
    assert.match(script, /section "Bot API \(curl\)"/);
    assert.match(script, /https:\/\/api\.telegram\.org\/bot\$\{TELEGRAM_BOT_TOKEN\}\/getMe/);
    assert.match(script, /telegram bot getMe \(curl\)/);
    assert.match(script, /section "Bot API \(node\)"/);
    assert.match(script, /command -v node >\/dev\/null 2>&1/);
    assert.match(script, /require\("node:https"\)/);
    assert.match(script, /node_bot_http_status=/);
    assert.match(script, /node_bot_api_ok=/);
    assert.match(script, /node_bot_username=/);
    assert.match(script, /telegram bot getMe \(node\)/);
    assert.match(script, /telegram_probe_advisory=/);
    assert.match(script, /telegram_probe_exit=\$\{0,1\}|telegram_probe_exit=%s/);
  });

  it("skips the authenticated Bot API probe when no token is available", () => {
    const script = buildTelegramProbeScript();

    assert.match(script, /TELEGRAM_BOT_TOKEN=''/);
    assert.match(script, /skipping authenticated Bot API probe/);
  });

  it("prefers TELEGRAM_BOT_TOKEN from the environment before credentials", () => {
    const token = getTelegramProbeToken({ TELEGRAM_BOT_TOKEN: "from-env" }, () => "from-creds");

    assert.equal(token, "from-env");
  });

  it("falls back to credentials when TELEGRAM_BOT_TOKEN is absent from the environment", () => {
    const token = getTelegramProbeToken({}, () => "from-creds");
    assert.equal(token, "from-creds");
  });

  it("reuses the running bridge token when env and credentials are empty", () => {
    const fs = require("fs");
    const fakeFs = {
      ...fs,
      existsSync(filePath) {
        return (
          filePath === "/tmp/nemoclaw-services-the-crucible/telegram-bridge.pid" ||
          filePath === "/proc/4242/environ"
        );
      },
      readFileSync(filePath) {
        if (filePath === "/tmp/nemoclaw-services-the-crucible/telegram-bridge.pid") {
          return "4242\n";
        }
        if (filePath === "/proc/4242/environ") {
          return Buffer.from("SANDBOX_NAME=the-crucible\0TELEGRAM_BOT_TOKEN=from-bridge\0");
        }
        throw new Error(`unexpected path: ${filePath}`);
      },
    };
    const fakeFsModule = /** @type {any} */ (fakeFs);

    assert.equal(getTelegramBridgeToken("the-crucible", fakeFsModule), "from-bridge");
    assert.equal(
      getTelegramProbeToken({}, () => null, {
        sandboxName: "the-crucible",
        fsModule: fakeFsModule,
      }),
      "from-bridge",
    );
  });
});
