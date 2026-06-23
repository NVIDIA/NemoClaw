// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runWithEnv, writeSandboxRegistry } from "./helpers";

describe("CLI dispatch for terminal agents", () => {
  it("connect --probe-only runs terminal-agent smoke checks without gateway recovery", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-connect-terminal-"));
    const localBin = path.join(home, "bin");
    const markerFile = path.join(home, "openshell-calls");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home, {
      agent: "langchain-deepagents-code",
      provider: "",
      model: "",
    });
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        `marker_file=${JSON.stringify(markerFile)}`,
        'printf \'%s\\n\' "$*" >> "$marker_file"',
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Sandbox:'",
        "  echo",
        "  echo '  Id: abc'",
        "  echo '  Name: alpha'",
        "  echo '  Namespace: openshell'",
        "  echo '  Phase: Ready'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "exec" ] && [ "$3" = "-n" ] && [ "$4" = "alpha" ]; then',
        '  cmd="${10}"',
        '  case "$cmd" in',
        '    *"dcode --version"*) echo "dcode 0.1.12"; echo "NEMOCLAW_AGENT_SMOKE_EXIT:0"; exit 0 ;;',
        '    *"config.toml"*) echo "NEMOCLAW_DEEPAGENTS_CONFIG_OK"; echo "NEMOCLAW_AGENT_SMOKE_EXIT:0"; exit 0 ;;',
        "  esac",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha connect --probe-only", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(r.out).toContain("terminal smoke checks passed");
    const calls = fs.readFileSync(markerFile, "utf8").trim().split("\n").filter(Boolean);
    expect(calls).toContain("sandbox get alpha");
    expect(calls.some((call) => call.includes("NEMOCLAW_AGENT_SMOKE_EXIT"))).toBe(true);
    expect(calls.some((call) => call.includes("nemoclaw-agent-smoke dcode --version"))).toBe(true);
    expect(
      calls.some((call) =>
        call.includes("nemoclaw-agent-smoke test -s /sandbox/.deepagents/config.toml"),
      ),
    ).toBe(true);
    expect(calls.some((call) => call.includes("OPENCLAW="))).toBe(false);
    expect(calls.some((call) => call.includes("curl -so"))).toBe(false);
  });
});
