// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  recordDriftedDeepAgentsRuntimeCall,
  recordFailingDeepAgentsSmokeCall,
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
        "--workdir",
        "/sandbox",
        "--",
        "sh",
        "-lc",
        "dcode --version",
      ],
      calls,
    );

    expect(output).toBe("dcode 0.1.34");
  });

  it("requires the exact smoke-runner argument before appending its exit marker", () => {
    const calls: string[] = [];
    const plainOutput = recordSuccessfulDeepAgentsRuntimeCall(
      [
        "sandbox",
        "exec",
        "--env",
        "EXAMPLE=nemoclaw-agent-smoke",
        "--",
        "sh",
        "-lc",
        "dcode --version # nemoclaw-agent-smoke",
      ],
      calls,
    );
    const smokeOutput = recordSuccessfulDeepAgentsRuntimeCall(
      [
        "sandbox",
        "exec",
        "--",
        "sh",
        "-lc",
        "smoke runner",
        "nemoclaw-agent-smoke",
        "dcode --version",
      ],
      calls,
    );

    expect(plainOutput).toBe("dcode 0.1.34");
    expect(smokeOutput).toContain("NEMOCLAW_AGENT_SMOKE_EXIT:0");
  });

  it("can model a successful smoke followed by an empty version probe", () => {
    const calls: string[] = [];
    expect(
      recordUnverifiedDeepAgentsRuntimeCall(
        [
          "sandbox",
          "exec",
          "--",
          "sh",
          "-lc",
          "smoke runner",
          "nemoclaw-agent-smoke",
          "dcode --version",
        ],
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

  it("reports the same drifted binary version through smoke and plain probes", () => {
    const calls: string[] = [];
    const smokeOutput = recordDriftedDeepAgentsRuntimeCall(
      [
        "sandbox",
        "exec",
        "--",
        "sh",
        "-lc",
        "smoke runner",
        "nemoclaw-agent-smoke",
        "dcode --version",
      ],
      calls,
    );
    const probeOutput = recordDriftedDeepAgentsRuntimeCall(
      ["sandbox", "exec", "--", "sh", "-lc", "dcode --version"],
      calls,
    );

    expect(smokeOutput).toContain("dcode 0.0.1");
    expect(probeOutput).toBe("dcode 0.0.1");
  });

  it("recognizes binary checks when OpenShell options precede the command", () => {
    const calls: string[] = [];
    const output = recordSuccessfulDeepAgentsRuntimeCall(
      [
        "sandbox",
        "exec",
        "--env",
        "EXAMPLE=value",
        "--",
        "sh",
        "-lc",
        "echo NEMOCLAW_AGENT_BINARY_CHECK:ok",
      ],
      calls,
    );

    expect(output).toBe("NEMOCLAW_AGENT_BINARY_CHECK:ok");
  });

  it("recognizes config smoke checks when OpenShell options precede the command", () => {
    const calls: string[] = [];
    const output = recordSuccessfulDeepAgentsRuntimeCall(
      [
        "sandbox",
        "exec",
        "--workdir",
        "/sandbox",
        "--",
        "sh",
        "-lc",
        "smoke runner",
        "nemoclaw-agent-smoke",
        "test -s /sandbox/.deepagents/config.toml",
      ],
      calls,
    );

    expect(output).toBe("NEMOCLAW_DEEPAGENTS_CONFIG_OK\nNEMOCLAW_AGENT_SMOKE_EXIT:0");
  });

  it("can model a nonzero terminal smoke command", () => {
    const output = recordFailingDeepAgentsSmokeCall([
      "sandbox",
      "exec",
      "--",
      "sh",
      "-lc",
      "smoke runner",
      "nemoclaw-agent-smoke",
      "dcode --version",
    ]);

    expect(output).toContain("NEMOCLAW_AGENT_SMOKE_EXIT:42");
  });
});
