// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { appendOpenClawRuntimeEnvArgs } from "./openclaw-runtime-env";

describe("appendOpenClawRuntimeEnvArgs", () => {
  it("pins HOME, STATE_DIR, and WORKSPACE_DIR for the default OpenClaw config dir", () => {
    const envArgs: string[] = [];
    appendOpenClawRuntimeEnvArgs(envArgs, null);
    expect(envArgs).toEqual([
      "OPENCLAW_HOME=/sandbox",
      "OPENCLAW_STATE_DIR=/sandbox/.openclaw",
      "OPENCLAW_WORKSPACE_DIR=/sandbox/.openclaw/workspace",
    ]);
  });

  it("derives the env values from agent.configPaths.dir when supplied", () => {
    const envArgs: string[] = [];
    appendOpenClawRuntimeEnvArgs(envArgs, {
      configPaths: { dir: "/srv/agent-root/.openclaw" },
    });
    expect(envArgs).toEqual([
      "OPENCLAW_HOME=/srv/agent-root",
      "OPENCLAW_STATE_DIR=/srv/agent-root/.openclaw",
      "OPENCLAW_WORKSPACE_DIR=/srv/agent-root/.openclaw/workspace",
    ]);
  });

  it("falls back to the default dir when the agent omits configPaths", () => {
    const envArgs: string[] = [];
    appendOpenClawRuntimeEnvArgs(envArgs, { configPaths: undefined });
    expect(envArgs).toEqual([
      "OPENCLAW_HOME=/sandbox",
      "OPENCLAW_STATE_DIR=/sandbox/.openclaw",
      "OPENCLAW_WORKSPACE_DIR=/sandbox/.openclaw/workspace",
    ]);
  });

  it("appends to an existing envArgs array without dropping prior entries", () => {
    const envArgs = ["CHAT_UI_URL=http://127.0.0.1:18789"];
    appendOpenClawRuntimeEnvArgs(envArgs, null);
    expect(envArgs[0]).toBe("CHAT_UI_URL=http://127.0.0.1:18789");
    expect(envArgs).toHaveLength(4);
  });
});
