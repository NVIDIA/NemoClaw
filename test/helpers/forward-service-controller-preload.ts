// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

/** Model an already healthy receipt-owned ForwardTcp service in CLI subprocess fixtures. */
export function healthyForwardServiceNodeOptions(
  directory: string,
  inheritedNodeOptions = process.env.NODE_OPTIONS,
): string {
  const preload = path.join(directory, "healthy-forward-service-controller.cjs");
  fs.writeFileSync(
    preload,
    [
      'const Module = require("node:module");',
      'const original = Module._extensions[".js"];',
      'Module._extensions[".js"] = (loaded, filename) => {',
      "  original(loaded, filename);",
      '  if (!filename.endsWith("/lib/adapters/openshell/forward-service-controller.js")) return;',
      "  loaded.exports.createForwardServiceController = () => ({",
      '    inspect: () => ({ disposition: "owned", ownsListener: true, reachable: true, receipt: {} }),',
      '    ensure: () => ({ action: "reused", receipt: {} }),',
      '    stop: () => "absent",',
      '    stopPort: () => "absent",',
      "    stopAll: () => 0,",
      "  });",
      "};",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  return [inheritedNodeOptions, `--require=${JSON.stringify(preload)}`].filter(Boolean).join(" ");
}

export type RecoveringForwardServiceFixture = {
  heal: boolean;
  invocationLog: string;
  sandboxIdentityFingerprint: string;
  sandboxName: string;
  settlePolls: number;
  stateFile: string;
};

/** Model the direct ForwardTcp controller's recovery transitions in a CLI subprocess fixture. */
export function recoveringForwardServiceNodeOptions(
  directory: string,
  fixture: RecoveringForwardServiceFixture,
  inheritedNodeOptions = process.env.NODE_OPTIONS,
): string {
  const preload = path.join(directory, "recovering-forward-service-controller.cjs");
  fs.writeFileSync(
    preload,
    [
      'const fs = require("node:fs");',
      'const Module = require("node:module");',
      `const invocationLog = ${JSON.stringify(fixture.invocationLog)};`,
      `const stateFile = ${JSON.stringify(fixture.stateFile)};`,
      `const heal = ${JSON.stringify(fixture.heal)};`,
      `const settlePolls = ${JSON.stringify(fixture.settlePolls)};`,
      `const sandboxIdentityFingerprint = ${JSON.stringify(fixture.sandboxIdentityFingerprint)};`,
      `const sandboxName = ${JSON.stringify(fixture.sandboxName)};`,
      'const record = (action) => fs.appendFileSync(invocationLog, "forward-service " + action + "\\n");',
      'const readState = () => fs.readFileSync(stateFile, "utf8").trim();',
      'const inspection = () => readState() === "running"',
      '  ? { disposition: "owned", ownsListener: true, reachable: true, receipt: {} }',
      '  : readState() === "missing"',
      '    ? { disposition: "absent", ownsListener: false, reachable: false, receipt: null }',
      '    : { disposition: "stale", ownsListener: false, reachable: false, receipt: {} };',
      'const original = Module._extensions[".js"];',
      'Module._extensions[".js"] = (loaded, filename) => {',
      "  original(loaded, filename);",
      '  if (filename.endsWith("/lib/onboard/forward-service-migration.js")) {',
      "    loaded.exports.requireProductionForwardServiceAuthority = () => ({",
      '      authority: { gatewayName: "nemoclaw", sandboxIdentityFingerprint, sandboxName },',
      "      migrated: false,",
      "      assertCurrent: () => {},",
      "      assertLiveCurrent: () => {},",
      "    });",
      "    loaded.exports.retireProductionLegacySandboxForwards = () => 0;",
      "    return;",
      "  }",
      '  if (!filename.endsWith("/lib/adapters/openshell/forward-service-controller.js")) return;',
      "  loaded.exports.createForwardServiceController = () => ({",
      "    inspect: inspection,",
      "    ensure: () => {",
      '      record("ensure");',
      '      for (let index = 0; index < settlePolls; index += 1) record("settle");',
      '      if (!heal) throw new Error("fixture ForwardTcp service did not become ready");',
      '      fs.writeFileSync(stateFile, "running");',
      '      return { action: "started", receipt: {} };',
      "    },",
      '    stop: () => { record("stop"); fs.writeFileSync(stateFile, "missing"); return "stopped"; },',
      '    stopPort: () => "absent",',
      "    stopAll: () => 0,",
      "  });",
      "};",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  return [inheritedNodeOptions, `--require=${JSON.stringify(preload)}`].filter(Boolean).join(" ");
}
