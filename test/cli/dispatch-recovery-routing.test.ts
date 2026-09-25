// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withDirectPublicDispatch } from "../support/public-dispatch-test-harness.js";
import { LAUNCH_READINESS_FIXTURE_POLICY } from "../helpers/launch-readiness-fixture";
import { runWithEnv } from "./helpers";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CLI recovery routing", () => {
  it.each([
    {
      argv: ["term"],
      entered: "term",
      command: "Run: openshell term",
      notes: [],
    },
    {
      argv: ["policy", "set"],
      entered: "policy set",
      command: "Run: openshell policy set --policy <policy-file> --wait <sandbox-name>",
      notes: ["nemoclaw <sandbox-name> policy add <preset>"],
    },
    {
      argv: ["gateway", "stop"],
      entered: "gateway stop",
      command: "Run: openshell gateway stop -g nemoclaw",
      notes: [],
    },
  ])("points $entered at OpenShell instead of sandbox connect (#3388)", async (testCase) => {
    await withDirectPublicDispatch(async ({ dispatchCli, exitSpy, resetObservedCalls, stderr }) => {
      resetObservedCalls();

      await expect(dispatchCli(testCase.argv)).rejects.toThrow("process.exit:1");

      const output = stderr.join("\n");
      expect(output).toContain(`Unknown nemoclaw command: ${testCase.entered}`);
      expect(output).toContain(testCase.command);
      expect(testCase.notes.every((note) => output.includes(note))).toBe(true);
      expect(output).not.toContain("Try: nemoclaw <sandbox-name> connect");
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  it("suggests list for a mistyped list command", async () => {
    await withDirectPublicDispatch(
      async ({ dispatchCli, exitSpy, recoverRegistryEntries, stderr }) => {
        await expect(dispatchCli(["liost"])).rejects.toThrow("process.exit:1");

        const output = stderr.join("\n");
        expect(recoverRegistryEntries).toHaveBeenCalledWith({ requestedSandboxName: "liost" });
        expect(output).toContain("Unknown command: liost");
        expect(output).toContain("Did you mean: nemoclaw list?");
        expect(exitSpy).toHaveBeenCalledWith(1);
      },
    );
  });

  it("recovers a live sandbox before suggesting a bare command typo", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-recover-typo-"));
    const localBin = path.join(home, "bin");
    fs.mkdirSync(localBin, { recursive: true });
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'printf "%s\\n" "$*" >> "$HOME/openshell-calls.log"',
        'case "$*" in',
        '  "status") printf "Status: Connected\\nGateway: nemoclaw\\n"; exit 0 ;;',
        '  "gateway info -g nemoclaw") printf "Gateway: nemoclaw\\n"; exit 0 ;;',
        '  "sandbox list"*) echo "liost Ready"; exit 0 ;;',
        '  "sandbox get liost") printf "Name: liost\\nPhase: Ready\\nPolicy:\\n"; exit 0 ;;',
        `  "policy get"*) printf '%b' ${JSON.stringify(LAUNCH_READINESS_FIXTURE_POLICY)}; exit 0 ;;`,
        '  "inference get") exit 1 ;;',
        '  "sandbox exec --name liost --tty -- /bin/bash -i") echo "CONNECTED_LIOST"; exit 0 ;;',
        "  *__NEMOCLAW_SANDBOX_EXEC_STARTED__*) echo '__NEMOCLAW_SANDBOX_EXEC_STARTED__'; exit 0 ;;",
        "  *) exit 0 ;;",
        "esac",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("liost", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
      NEMOCLAW_CONNECT_TIMEOUT: "1",
      NEMOCLAW_NO_CONNECT_HINT: "1",
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("CONNECTED_LIOST");
    expect(r.out).not.toContain("Unknown command: liost");
    const calls = fs.readFileSync(path.join(home, "openshell-calls.log"), "utf8").split("\n");
    // Every sandbox list in this flow is gateway-scoped, including registry
    // recovery's. An unscoped list returns every sandbox on the host, so on a
    // two-gateway host recovery would bind a sibling gateway's sandbox to the
    // selected gateway (#7105).
    expect(calls).not.toContain("sandbox list");
    expect(calls).toContain("sandbox list -g nemoclaw");
    expect(calls).toContain("sandbox exec --name liost --tty -- /bin/bash -i");
  });
});
