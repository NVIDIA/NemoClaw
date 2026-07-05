// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

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
const TEST_PATH = process.env.PATH || "/usr/bin:/bin";

function runPostAgentInstall(tmp: string, agent: "hermes" | "openclaw", plan: unknown) {
  return spawnSync(
    "node",
    ["--experimental-strip-types", SCRIPT_PATH, "--agent", agent, "--phase", "post-agent-install"],
    {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        PATH: TEST_PATH,
        HOME: tmp,
        NEMOCLAW_MESSAGING_PLAN_B64: Buffer.from(JSON.stringify(plan)).toString("base64"),
      },
      timeout: 10_000,
    },
  );
}

describe("messaging-build-applier.mts: post-agent-install render safety", () => {
  it("rejects post-agent-install render targets that escape the agent root", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-render-target-escape-"));
    const plan = {
      schemaVersion: 1,
      sandboxName: "test-sandbox",
      agent: "openclaw",
      channels: [{ channelId: "telegram", active: true }],
      credentialBindings: [],
      agentRender: [
        {
          channelId: "telegram",
          agent: "openclaw",
          target: "~/.openclaw/../escaped.json",
          kind: "json-fragment",
          path: "channels.telegram.enabled",
          value: true,
        },
      ],
      buildSteps: [],
    };

    try {
      const result = runPostAgentInstall(tmp, "openclaw", plan);

      expect(result.status).toBe(2);
      expect(result.stderr).toContain("must stay inside");
      expect(fs.existsSync(path.join(tmp, "escaped.json"))).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects multiline env render lines from serialized plans", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-env-line-injection-"));
    const plan = {
      schemaVersion: 1,
      sandboxName: "test-sandbox",
      agent: "hermes",
      channels: [{ channelId: "slack", active: true }],
      credentialBindings: [],
      agentRender: [
        {
          channelId: "slack",
          agent: "hermes",
          target: "~/.hermes/.env",
          kind: "env-lines",
          renderId: "slack-hermes-env",
          lines: ["SLACK_ALLOWED_USERS=U123\nEVIL=1"],
        },
      ],
      buildSteps: [],
    };

    try {
      const result = runPostAgentInstall(tmp, "hermes", plan);

      expect(result.status).toBe(2);
      expect(result.stderr).toContain("line breaks");
      const envPath = path.join(tmp, ".hermes", ".env");
      expect(fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf-8") : "").not.toContain(
        "EVIL=1",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
