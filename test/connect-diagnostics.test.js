// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  getGatewayClusterContainerName,
  hasGatewayConnectFailure,
  hasSandboxAttachHandshakeFailure,
  isGatewayConnected,
} = require("../bin/nemoclaw");

describe("connect diagnostics", () => {
  it("detects a healthy gateway status output", () => {
    const output = [
      "Server Status",
      "",
      "  Gateway: nemoclaw",
      "  Server: https://127.0.0.1:8080",
      "  Status: Connected",
      "  Version: 0.0.12",
    ].join("\n");

    assert.equal(isGatewayConnected(output), true);
    assert.equal(hasGatewayConnectFailure(output), false);
  });

  it("detects gateway transport failures from openshell status output", () => {
    const output = [
      "Server Status",
      "",
      "  Gateway: nemoclaw",
      "  Server: https://127.0.0.1:8080",
      "Error:   × client error (Connect)",
      "  ├─▶ tcp connect error",
      "  ╰─▶ Connection refused (os error 111)",
    ].join("\n");

    assert.equal(isGatewayConnected(output), false);
    assert.equal(hasGatewayConnectFailure(output), true);
  });

  it("detects a healthy gateway status when openshell uses ANSI formatting", () => {
    const output = [
      "\x1b[1mServer Status\x1b[0m",
      "",
      "  \x1b[2mGateway:\x1b[0m nemoclaw",
      "  \x1b[2mServer:\x1b[0m https://127.0.0.1:8080",
      "  \x1b[2mStatus:\x1b[0m Connected",
      "  \x1b[2mVersion:\x1b[0m 0.0.12",
    ].join("\n");

    assert.equal(isGatewayConnected(output), true);
    assert.equal(hasGatewayConnectFailure(output), false);
  });

  it("detects sandbox attach handshake failures in recent logs", () => {
    const output = [
      "[gateway] [INFO ] [openshell_server::ssh_tunnel] SSH tunnel: handshake response received",
      "[sandbox] [WARN ] [openshell_sandbox::ssh] SSH connection: handshake verification failed peer=10.42.0.17:57764",
    ].join("\n");

    assert.equal(hasSandboxAttachHandshakeFailure(output), true);
  });

  it("builds the hardcoded gateway cluster container name", () => {
    assert.equal(getGatewayClusterContainerName(), "openshell-cluster-nemoclaw");
  });
});