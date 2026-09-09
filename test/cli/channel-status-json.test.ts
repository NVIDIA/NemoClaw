// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { expect } from "vitest";

import { test as it } from "../helpers/owned-test-resources";
import { makeMessagingPlan } from "../helpers/messaging-plan-fixtures";
import { runWithEnv, writeSandboxRegistry } from "./helpers";

it("keeps the detailed JSON envelope when paused Telegram skips its live probe (#10015)", ({
  testHome,
}) => {
  const { home, bin } = testHome;
  const sandboxName = "my-assistant";
  const openshell = path.join(bin, "openshell");
  const calls = path.join(home, "openshell.calls");
  fs.mkdirSync(bin, { recursive: true });
  writeSandboxRegistry(home, sandboxName, {
    agent: "openclaw",
    messaging: {
      schemaVersion: 1,
      plan: makeMessagingPlan({
        sandboxName,
        channels: ["telegram"],
        disabledChannels: ["telegram"],
      }),
    },
  });
  fs.writeFileSync(
    openshell,
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$*" >> ${JSON.stringify(calls)}`,
      'if [ "$1" = "sandbox" ] && [ "$2" = "exec" ]; then',
      `  printf '%s\\n' ${JSON.stringify(
        JSON.stringify({
          channels: {
            telegram: {
              enabled: true,
              groupPolicy: "allowlist",
              groups: { "*": { requireMention: true } },
            },
          },
        }),
      )}`,
      "  exit 0",
      "fi",
      "exit 1",
    ].join("\n"),
    { mode: 0o755 },
  );

  const result = runWithEnv(
    `${sandboxName} channels status --channel telegram --json`,
    testHome.environment({ NEMOCLAW_OPENSHELL_BIN: openshell }),
  );

  expect(result.code).toBe(0);
  const status = JSON.parse(result.out) as Record<string, unknown>;
  expect(Object.keys(status).sort()).toEqual(["channel", "report", "sandbox", "schemaVersion"]);
  const report = status.report as Record<string, unknown>;
  expect(Object.keys(report).sort()).toEqual([
    "agent",
    "channel",
    "hints",
    "probedAt",
    "schemaVersion",
    "signals",
    "verdict",
  ]);
  expect(report).toMatchObject({
    schemaVersion: 1,
    agent: "openclaw",
    channel: "telegram",
    verdict: "info",
    hints: expect.any(Array),
  });
  expect(report.probedAt).toEqual(expect.any(String));
  expect(report.signals).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        label: "Channel registration",
        severity: "warn",
        detail: "telegram registered but currently paused",
      }),
      expect.objectContaining({
        label: "Runtime health",
        severity: "info",
        detail: "not checked — telegram is currently paused",
      }),
    ]),
  );
  const invoked = fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : "";
  expect(invoked).not.toMatch(/gateway\.log|pgrep/);
});
