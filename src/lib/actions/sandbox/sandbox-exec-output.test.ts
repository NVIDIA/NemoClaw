// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  buildSandboxExecMarkedCommand,
  createSandboxExecMarker,
  extractSandboxExecCommandStdout,
  extractSandboxExecCommandStdoutFromStreams,
  SANDBOX_EXEC_STARTED_MARKER,
} from "./sandbox-exec-output";

describe("buildSandboxExecMarkedCommand", () => {
  it("prints the sentinel before the command for ordinary scripts", () => {
    const command = buildSandboxExecMarkedCommand("echo hi");
    expect(command).toBe(`printf '%s\\n' '${SANDBOX_EXEC_STARTED_MARKER}'; echo hi`);
  });

  it("base64-encodes the hermes secret boundary script instead of inlining it", () => {
    const script = "python3 validate-hermes-env-secret-boundary.py --check";
    const command = buildSandboxExecMarkedCommand(script);

    expect(command).toContain(`printf '%s\\n' '${SANDBOX_EXEC_STARTED_MARKER}'`);
    expect(command).not.toContain(script);
    const encoded = Buffer.from(script, "utf8").toString("base64");
    expect(command).toContain(encoded);
  });

  it("creates a fresh shell-safe marker for each exec", () => {
    const first = createSandboxExecMarker();
    const second = createSandboxExecMarker();

    expect(first).toMatch(new RegExp(`^${SANDBOX_EXEC_STARTED_MARKER}_[0-9a-f]{32}$`));
    expect(second).not.toBe(first);
    expect(buildSandboxExecMarkedCommand("echo hi", first)).toContain(`'${first}'`);
  });

  it("rejects a custom marker containing shell syntax", () => {
    expect(() =>
      buildSandboxExecMarkedCommand("echo hi", "x'; echo NEMOCLAW_MARKER_INJECTION; '"),
    ).toThrow("Invalid sandbox exec marker");
  });
});

describe("extractSandboxExecCommandStdout", () => {
  it("returns null for empty output", () => {
    expect(extractSandboxExecCommandStdout("")).toBeNull();
    expect(extractSandboxExecCommandStdout("   \n  ")).toBeNull();
  });

  it("returns null when the sentinel never appears", () => {
    expect(extractSandboxExecCommandStdout("exec failed\n")).toBeNull();
  });

  it("extracts stdout after a raw, unframed sentinel", () => {
    const output = `${SANDBOX_EXEC_STARTED_MARKER}\nNEMOCLAW_DCODE_PROBE=idle\n`;
    expect(extractSandboxExecCommandStdout(output)).toBe("NEMOCLAW_DCODE_PROBE=idle");
  });

  it("strips the 'stdout: ' frame prefix", () => {
    const output = `stdout: ${SANDBOX_EXEC_STARTED_MARKER}\nstdout: NEMOCLAW_DCODE_PROBE=idle\n`;
    expect(extractSandboxExecCommandStdout(output)).toBe("NEMOCLAW_DCODE_PROBE=idle");
  });

  it("strips the '[stdout] ' frame prefix", () => {
    const output = `[stdout] ${SANDBOX_EXEC_STARTED_MARKER}\n[stdout] NEMOCLAW_DCODE_PROBE=active\n`;
    expect(extractSandboxExecCommandStdout(output)).toBe("NEMOCLAW_DCODE_PROBE=active");
  });

  it("rejects duplicate sentinel lines as an ambiguous parser boundary", () => {
    const output = [
      SANDBOX_EXEC_STARTED_MARKER,
      "NEMOCLAW_DCODE_PROBE=idle",
      SANDBOX_EXEC_STARTED_MARKER,
      "NEMOCLAW_DCODE_PROBE=active",
    ].join("\n");

    expect(extractSandboxExecCommandStdout(output)).toBeNull();
  });

  it("does not match a sentinel embedded in a preamble line as a substring", () => {
    const output = `some login banner ${SANDBOX_EXEC_STARTED_MARKER} noise\n${SANDBOX_EXEC_STARTED_MARKER}\nNEMOCLAW_DCODE_PROBE=idle\n`;
    expect(extractSandboxExecCommandStdout(output)).toBe("NEMOCLAW_DCODE_PROBE=idle");
  });

  it("extracts a framed marker from stderr when stdout does not contain one", () => {
    const marker = createSandboxExecMarker();
    expect(
      extractSandboxExecCommandStdoutFromStreams(
        {
          stdout: "OpenShell transport preamble\n",
          stderr: `stdout: ${marker}\nstdout: NEMOCLAW_DCODE_PROBE=idle\n`,
        },
        marker,
      ),
    ).toBe("NEMOCLAW_DCODE_PROBE=idle");
  });

  it("rejects the same marker split across stdout and stderr", () => {
    const marker = createSandboxExecMarker();
    expect(
      extractSandboxExecCommandStdoutFromStreams(
        {
          stdout: `${marker}\nNEMOCLAW_DCODE_PROBE=active\n`,
          stderr: `stdout: ${marker}\nstdout: NEMOCLAW_DCODE_PROBE=idle\n`,
        },
        marker,
      ),
    ).toBeNull();
  });
});
