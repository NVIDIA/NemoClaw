// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const onboardSession = require("./onboard-session");

function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return String(text || "").replace(/\x1b\[[0-9;]*m/g, "");
}

function parseLiveSandboxNames(listOutput = "") {
  const clean = stripAnsi(listOutput);
  const names = new Set();
  for (const rawLine of clean.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^(NAME|No sandboxes found\.?$)/i.test(line)) continue;
    if (/^Error:/i.test(line)) continue;
    const cols = line.split(/\s+/);
    if (cols[0]) {
      names.add(cols[0]);
    }
  }
  return names;
}

function classifySandboxLookup(output = "") {
  const clean = stripAnsi(output).trim();
  if (!clean) {
    return { state: "missing", reason: "empty" };
  }
  if (/sandbox not found|status:\s*NotFound/i.test(clean)) {
    return { state: "missing", reason: "not_found" };
  }
  if (
    /transport error|client error|Connection reset by peer|Connection refused|No active gateway|Gateway: .*Error/i.test(
      clean
    )
  ) {
    return { state: "unavailable", reason: "gateway_unavailable" };
  }
  return { state: "present", reason: "ok" };
}

function classifyGatewayStatus(output = "") {
  const clean = stripAnsi(output).trim();
  if (!clean) {
    return { state: "inactive", reason: "empty" };
  }
  if (/Connected/i.test(clean)) {
    return { state: "connected", reason: "ok" };
  }
  if (
    /No active gateway|transport error|client error|Connection reset by peer|Connection refused|Gateway: .*Error/i.test(
      clean
    )
  ) {
    return { state: "unavailable", reason: "gateway_unavailable" };
  }
  return { state: "inactive", reason: "not_connected" };
}

function shouldAttemptGatewayRecovery({ sandboxState = "missing", gatewayState = "inactive" } = {}) {
  return sandboxState === "unavailable" && gatewayState !== "connected";
}

function getRecoveryCommand() {
  const session = onboardSession.loadSession();
  if (session && session.resumable !== false) {
    return "nemoclaw onboard --resume";
  }
  return "nemoclaw onboard";
}

module.exports = {
  classifyGatewayStatus,
  classifySandboxLookup,
  getRecoveryCommand,
  parseLiveSandboxNames,
  shouldAttemptGatewayRecovery,
};
