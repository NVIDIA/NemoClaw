// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyMessagingAgentRenderToLocalFiles,
  readMessagingBuildPlanFromEnv,
} from "../src/lib/messaging/applier/build/messaging-build-applier.mts";

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
      const serializedPlan = readMessagingBuildPlanFromEnv(
        {
          NEMOCLAW_MESSAGING_PLAN_B64: Buffer.from(JSON.stringify(plan)).toString("base64"),
        },
        "openclaw",
      );

      expect(() => applyMessagingAgentRenderToLocalFiles(serializedPlan, { homeDir: tmp })).toThrow(
        "must stay inside",
      );
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
      const serializedPlan = readMessagingBuildPlanFromEnv(
        {
          NEMOCLAW_MESSAGING_PLAN_B64: Buffer.from(JSON.stringify(plan)).toString("base64"),
        },
        "hermes",
      );

      expect(() => applyMessagingAgentRenderToLocalFiles(serializedPlan, { homeDir: tmp })).toThrow(
        "line breaks",
      );
      const envPath = path.join(tmp, ".hermes", ".env");
      expect(fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf-8") : "").not.toContain(
        "EVIL=1",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
