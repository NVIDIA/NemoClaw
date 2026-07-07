// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyMessagingBuildPhase,
  type MessagingBuildPlan,
  readMessagingBuildPlanFromEnv,
} from "../src/lib/messaging/applier/build/messaging-build-applier.mts";

describe("messaging build applier inactive channels", () => {
  it("does not install a plugin carried by a serialized inactive channel", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-inactive-channel-plugin-"));
    const tracePath = path.join(tmp, "unexpected-install.trace");
    const commandTrap = [
      "#!/bin/sh",
      'printf "%s\\n" "$0 $*" >> "$UNEXPECTED_INSTALL_TRACE"',
      "exit 91",
      "",
    ].join("\n");
    const plan: MessagingBuildPlan = {
      schemaVersion: 1,
      sandboxName: "test-sandbox",
      agent: "openclaw",
      channels: [
        { channelId: "telegram", active: true, disabled: false },
        { channelId: "slack", active: false, disabled: false },
      ],
      credentialBindings: [],
      agentRender: [],
      buildSteps: [
        {
          channelId: "slack",
          kind: "package-install",
          outputId: "openclawPluginPackage",
          required: true,
          value: {
            manager: "openclaw-plugin",
            spec: "npm:@openclaw/slack@{{openclaw.version}}",
            pin: true,
          },
        },
      ],
    };

    try {
      for (const command of ["npm", "openclaw"]) {
        fs.writeFileSync(path.join(tmp, command), commandTrap, { mode: 0o755 });
      }

      const env = {
        PATH: `${tmp}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        OPENCLAW_VERSION: "2026.6.10",
        UNEXPECTED_INSTALL_TRACE: tracePath,
        NEMOCLAW_MESSAGING_PLAN_B64: Buffer.from(JSON.stringify(plan)).toString("base64"),
      };
      const serializedPlan = readMessagingBuildPlanFromEnv(env, "openclaw");

      expect(applyMessagingBuildPhase(serializedPlan, "agent-install", env)).toEqual([]);
      expect(fs.existsSync(tracePath)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
