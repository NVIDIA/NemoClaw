// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { makeStartScriptFixture } from "./support/dcode-start-script-fixture.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const agentDir = path.join(repoRoot, "agents", "langchain-deepagents-code");

function readAgentFile(name: string): string {
  return fs.readFileSync(path.join(agentDir, name), "utf8");
}

describe("LangChain Deep Agents Code auto-approval image contracts", () => {
  it("bakes an exact root-owned capability without env trust (#6478)", () => {
    const dockerfile = readAgentFile("Dockerfile");
    const launcher = readAgentFile("dcode-launcher.sh");
    const start = readAgentFile("start.sh");
    const wrapper = readAgentFile("dcode-wrapper.sh");
    const runtime = readAgentFile("managed-dcode-runtime.py");

    expect(dockerfile).toContain("ARG NEMOCLAW_DCODE_AUTO_APPROVAL=disabled");
    expect(dockerfile).toContain("disabled|thread-opt-in)");
    expect(dockerfile).toContain(
      `printf '%s\\n' "$NEMOCLAW_DCODE_AUTO_APPROVAL" > /usr/local/share/nemoclaw/dcode-auto-approval`,
    );
    expect(dockerfile).toContain(
      "chown root:root /usr/local/share/nemoclaw/dcode-proxy-host /usr/local/share/nemoclaw/dcode-proxy-port /usr/local/share/nemoclaw/dcode-inference-base-url /usr/local/share/nemoclaw/dcode-auto-approval",
    );
    expect(dockerfile).toContain(
      "chmod 0444 /usr/local/share/nemoclaw/dcode-proxy-host /usr/local/share/nemoclaw/dcode-proxy-port /usr/local/share/nemoclaw/dcode-inference-base-url /usr/local/share/nemoclaw/dcode-auto-approval",
    );
    const envBlock = dockerfile.slice(dockerfile.indexOf("ENV HOME="));
    expect(envBlock).not.toContain("NEMOCLAW_DCODE_AUTO_APPROVAL");

    for (const source of [launcher, start, wrapper]) {
      expect(source).toContain("compgen -A variable NEMOCLAW_DCODE_AUTO_APPROVAL");
    }
    expect(start).not.toContain("write_export_if_set NEMOCLAW_DCODE_AUTO_APPROVAL");
    expect(wrapper).toContain(
      'readonly MANAGED_DCODE_AUTO_APPROVAL_FILE="/usr/local/share/nemoclaw/dcode-auto-approval"',
    );
    expect(runtime).toContain(
      '_AUTO_APPROVAL_FILE = Path(\n    "/usr/local/share/nemoclaw/dcode-auto-approval"\n)',
    );
    expect(runtime).toContain("def managed_auto_approval_mode() -> str:");
    expect(runtime).toContain("def managed_auto_approval_enabled() -> bool:");
  });

  it("strips ambient hints without serializing them into shell state (#6478)", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-auto-env-"));
    try {
      const { envFile, scriptPath } = makeStartScriptFixture(tempDir);
      const output = execFileSync(
        "bash",
        [
          scriptPath,
          "sh",
          "-c",
          `printf '%s,%s' "\${NEMOCLAW_DCODE_AUTO_APPROVAL-unset}" "\${NEMOCLAW_DCODE_AUTO_APPROVAL_ENABLED-unset}"`,
        ],
        {
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            NEMOCLAW_DCODE_AUTO_APPROVAL: "thread-opt-in",
            NEMOCLAW_DCODE_AUTO_APPROVAL_ENABLED: "1",
          },
          encoding: "utf8",
        },
      );

      expect(output).toBe("unset,unset");
      expect(fs.readFileSync(envFile, "utf8")).not.toContain("NEMOCLAW_DCODE_AUTO_APPROVAL");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
