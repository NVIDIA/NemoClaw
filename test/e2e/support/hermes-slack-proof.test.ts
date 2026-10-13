// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertHermesSlackApiProof,
  classifyHermesSlackApiProof,
} from "../live/hermes-slack-proof.ts";

import {
  HERMES_SLACK_ENV_PROBE,
  HERMES_SLACK_INJECTED_TOKEN_PATTERN,
} from "../live/hermes-slack-e2e-helpers.ts";

describe("Hermes Slack .env placeholder proof", () => {
  const bot = "openshell:resolve:env:v12_SLACK_BOT_TOKEN";
  const app = `openshell:resolve:env:s${"a".repeat(64)}_SLACK_APP_TOKEN`;

  function probe(text: string): string {
    const directory = mkdtempSync(join(tmpdir(), "hermes-slack-env-"));
    try {
      const file = join(directory, ".env");
      writeFileSync(file, text);
      const result = spawnSync(
        "python3",
        ["-c", HERMES_SLACK_ENV_PROBE.replace('glob.glob("/proc/[0-9]*/environ")', "[]"), file],
        {
          encoding: "utf8",
          env: { PATH: process.env.PATH ?? "", SLACK_BOT_TOKEN: bot, SLACK_APP_TOKEN: app },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  it.each([
    `SLACK_BOT_TOKEN=${bot}\nSLACK_APP_TOKEN=${app}\n`,
    `export SLACK_BOT_TOKEN=${bot}\nSLACK_APP_TOKEN=${app}\n`,
  ])("accepts the currently injected scoped placeholders", (assignments) => {
    expect(probe(`API_SERVER_PORT=18642\n${assignments}`)).toBe("OK");
  });

  it("requires both injected Slack assignments", () => {
    expect(probe("API_SERVER_PORT=18642\n")).toBe(
      "FAIL missing or unsafe SLACK_APP_TOKEN, SLACK_BOT_TOKEN",
    );
  });

  it.each([
    "xoxb-test-raw-credential",
    "xapp-test-raw-credential",
    "openshell:resolve:env:SLACK_BOT_TOKEN",
    "openshell:resolve:env:v12_SLACK_APP_TOKEN",
    `openshell:resolve:env:s${"a".repeat(63)}_SLACK_BOT_TOKEN`,
    `openshell:resolve:env:s${"A".repeat(64)}_SLACK_BOT_TOKEN`,
    `openshell:resolve:env:v${"1".repeat(21)}_SLACK_BOT_TOKEN`,
  ])("rejects a raw or invalid credential without printing its value", (value) => {
    const output = probe(
      `API_SERVER_PORT=18642\nSLACK_BOT_TOKEN=${value}\nSLACK_APP_TOKEN=${app}\n`,
    );
    expect(output).toBe("FAIL missing or unsafe SLACK_BOT_TOKEN");
    expect(output).not.toContain(value);
  });

  it("rejects an empty credential assignment", () => {
    expect(probe(`API_SERVER_PORT=18642\nSLACK_BOT_TOKEN=\nSLACK_APP_TOKEN=${app}\n`)).toBe(
      "FAIL missing or unsafe SLACK_BOT_TOKEN",
    );
  });

  it("rejects a raw duplicate even when another assignment is valid", () => {
    expect(
      probe(
        `API_SERVER_PORT=18642\nSLACK_BOT_TOKEN=${bot}\nexport SLACK_BOT_TOKEN=raw\nSLACK_APP_TOKEN=${app}\n`,
      ),
    ).toBe("FAIL missing or unsafe SLACK_BOT_TOKEN");
  });

  it("still requires the configured API port", () => {
    expect(probe(`API_SERVER_PORT=8642\nSLACK_BOT_TOKEN=${bot}\nSLACK_APP_TOKEN=${app}\n`)).toBe(
      "FAIL missing or unsafe API_SERVER_PORT=18642",
    );
  });

  it("uses the same scoped grammar for file and egress probes", () => {
    const injected = new RegExp(HERMES_SLACK_INJECTED_TOKEN_PATTERN, "u");
    expect(injected.exec(bot)?.[1]).toBe("SLACK_BOT_TOKEN");
    expect(injected.exec(app)?.[1]).toBe("SLACK_APP_TOKEN");
    expect(injected.test("openshell:resolve:env:SLACK_BOT_TOKEN")).toBe(false);
  });
});

describe("Hermes Slack API proof classification", () => {
  it("accepts both successful Slack API markers", () => {
    expect(
      classifyHermesSlackApiProof(
        "OK auth.test: status=200 error=None\nOK apps.connections.open: status=200 error=None\n",
      ),
    ).toEqual({ kind: "passed" });
  });

  it("rejects a provider timeout as incomplete required evidence", () => {
    expect(classifyHermesSlackApiProof("TIMEOUT auth.test: socket timeout\n")).toEqual({
      kind: "timeout",
      reason: "TIMEOUT auth.test: socket timeout",
    });
    expect(() => assertHermesSlackApiProof("TIMEOUT auth.test: socket timeout\n")).toThrow(
      "Slack API proof incomplete required evidence: TIMEOUT auth.test: socket timeout",
    );
  });

  it("accepts complete required evidence in the live assertion path", () => {
    expect(() =>
      assertHermesSlackApiProof(
        "OK auth.test: status=200 error=None\nOK apps.connections.open: status=200 error=None\n",
      ),
    ).not.toThrow();
  });

  it.each(["FAIL auth.test: status=403", "ERROR apps.connections.open: invalid response"])(
    "rejects an explicit probe failure: %s",
    (line) => {
      expect(classifyHermesSlackApiProof(`${line}\n`)).toEqual({
        kind: "failed",
        reason: line,
      });
    },
  );

  it.each([
    {
      output: "OK auth.test: status=200 error=None\n",
      reason: "missing successful probe marker: apps.connections.open",
    },
    {
      output: "OK apps.connections.open: status=200 error=None\n",
      reason: "missing successful probe marker: auth.test",
    },
    {
      output: "unstructured output\n",
      reason: "missing successful probe marker: auth.test, apps.connections.open",
    },
  ])("rejects incomplete success evidence", ({ output, reason }) => {
    expect(classifyHermesSlackApiProof(output)).toEqual({ kind: "failed", reason });
  });
});
