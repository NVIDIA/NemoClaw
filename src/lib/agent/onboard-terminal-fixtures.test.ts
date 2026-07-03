// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  recordSuccessfulDeepAgentsRuntimeCall,
  recordUnverifiedDeepAgentsRuntimeCall,
} from "./onboard-terminal-fixtures";

describe("Deep Agents Code terminal onboard fixtures", () => {
  it("recognizes a plain version probe when OpenShell options precede the command", () => {
    const calls: string[] = [];
    const output = recordSuccessfulDeepAgentsRuntimeCall(
      [
        "sandbox",
        "exec",
        "-n",
        "deepagents-code",
        "--env",
        "EXAMPLE=value",
        "--",
        "sh",
        "-lc",
        "dcode --version",
      ],
      calls,
    );

    expect(output).toBe("dcode 0.1.30");
  });

  it("requires the exact smoke-runner argument before appending its exit marker", () => {
    const calls: string[] = [];
    const plainOutput = recordSuccessfulDeepAgentsRuntimeCall(
      ["sandbox", "exec", "--", "sh", "-lc", "dcode --version # nemoclaw-agent-smoke"],
      calls,
    );
    const smokeOutput = recordSuccessfulDeepAgentsRuntimeCall(
      ["sandbox", "exec", "--", "nemoclaw-agent-smoke", "dcode --version"],
      calls,
    );

    expect(plainOutput).toBe("dcode 0.1.30");
    expect(smokeOutput).toContain("NEMOCLAW_AGENT_SMOKE_EXIT:0");
  });

  it("can model a successful smoke followed by an empty version probe", () => {
    const calls: string[] = [];
    expect(
      recordUnverifiedDeepAgentsRuntimeCall(
        ["sandbox", "exec", "--", "nemoclaw-agent-smoke", "dcode --version"],
        calls,
      ),
    ).toContain("NEMOCLAW_AGENT_SMOKE_EXIT:0");
    expect(
      recordUnverifiedDeepAgentsRuntimeCall(
        ["sandbox", "exec", "--", "sh", "-lc", "dcode --version"],
        calls,
      ),
    ).toBe("");
  });
});
