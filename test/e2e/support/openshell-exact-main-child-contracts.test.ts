// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import {
  assertExactMainChildProcessContracts,
  CONNECT_CHILD_PROBE,
  ENTRYPOINT_CHILD_PROBE,
  EXEC_CHILD_PROBE,
} from "../live/openshell-exact-main-exec.ts";

const SANDBOX_NAME = "e2e-mcp-dcode";
const CONTAINER_ID = "a".repeat(64);
const EMPTY_ARTIFACTS = { result: "", stderr: "", stdout: "" };

function probeResult(stdout: string, exitCode = 0, stderr = ""): ShellProbeResult {
  return {
    artifacts: EMPTY_ARTIFACTS,
    command: [],
    exitCode,
    signal: null,
    stderr,
    stdout,
    timedOut: false,
  };
}

function childReport(
  surface: "entrypoint" | "exec",
  capBnd = "0000000000000000",
  supervisorTlsEnvNames: string[] = [],
): ShellProbeResult {
  return probeResult(JSON.stringify({ capBnd, supervisorTlsEnvNames, surface }));
}

function fakeHost() {
  const command = vi.fn();
  const nemoclaw = vi.fn();
  return {
    command,
    host: {
      command,
      nemoclaw,
      openshellCommandPath: "/reviewed/openshell",
    } as unknown as HostCliClient,
    nemoclaw,
  };
}

describe("OpenShell exact-main child contracts", () => {
  it("keeps every embedded child probe syntactically executable", () => {
    for (const source of [ENTRYPOINT_CHILD_PROBE, EXEC_CHILD_PROBE]) {
      const compiled = spawnSync(
        "python3",
        ["-c", "import sys; compile(sys.argv[1], '<exact-main-child-proof>', 'exec')", source],
        { encoding: "utf8" },
      );
      expect(compiled.status, compiled.stderr).toBe(0);
    }
    const parsed = spawnSync("bash", ["-n"], {
      encoding: "utf8",
      input: CONNECT_CHILD_PROBE,
    });
    expect(parsed.status, parsed.stderr).toBe(0);
  });

  it("proves entrypoint, exec, and forced-TTY connect children independently", async () => {
    const { command, host, nemoclaw } = fakeHost();
    command
      .mockResolvedValueOnce(probeResult(`${CONTAINER_ID}\topenshell-${SANDBOX_NAME}-reviewed\n`))
      .mockResolvedValueOnce(childReport("entrypoint"))
      .mockResolvedValueOnce(
        probeResult("NEMOCLAW_EXACT_MAIN_CONNECT_CHILD_OK CapBnd=0000000000000000\r\n"),
      );
    nemoclaw.mockResolvedValueOnce(childReport("exec"));

    await assertExactMainChildProcessContracts(host, SANDBOX_NAME);

    expect(command).toHaveBeenCalledTimes(3);
    expect(nemoclaw).toHaveBeenCalledTimes(1);
    expect(command.mock.calls[0]?.[1]).toEqual([
      "ps",
      "--no-trunc",
      "--filter",
      "label=openshell.ai/managed-by=openshell",
      "--filter",
      `label=openshell.ai/sandbox-name=${SANDBOX_NAME}`,
      "--format",
      "{{.ID}}\t{{.Names}}",
    ]);
    expect(command.mock.calls[1]?.[1]).toEqual(
      expect.arrayContaining(["exec", "--user", "0", CONTAINER_ID, "python3", "-c"]),
    );
    expect(nemoclaw.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([SANDBOX_NAME, "exec", "--", "python3", "-c"]),
    );
    expect(command.mock.calls[2]?.[0]).toBe("bash");
    expect(command.mock.calls[2]?.[1]).toEqual([
      "-lc",
      'printf \'%s\\n\' "$1" | "$2" sandbox connect "$3"',
      "exact-main-connect-child",
      CONNECT_CHILD_PROBE,
      "/reviewed/openshell",
      SANDBOX_NAME,
    ]);
    expect(CONNECT_CHILD_PROBE).toContain('"/proc/$$/status"');
    expect(CONNECT_CHILD_PROBE).toContain('printenv "$name"');
  });

  it("rejects a successful-looking entrypoint report with any bounding capability", async () => {
    const { command, host } = fakeHost();
    command
      .mockResolvedValueOnce(probeResult(`${CONTAINER_ID}\topenshell-${SANDBOX_NAME}\n`))
      .mockResolvedValueOnce(childReport("entrypoint", "0000000000000001"));

    await expect(assertExactMainChildProcessContracts(host, SANDBOX_NAME)).rejects.toThrow(
      "entrypoint child expected full CapBnd=0",
    );
  });

  it("rejects a successful-looking entrypoint report naming supervisor TLS identity", async () => {
    const { command, host } = fakeHost();
    command
      .mockResolvedValueOnce(probeResult(`${CONTAINER_ID}\topenshell-${SANDBOX_NAME}\n`))
      .mockResolvedValueOnce(childReport("entrypoint", "0000000000000000", ["OPENSHELL_TLS_KEY"]));

    await expect(assertExactMainChildProcessContracts(host, SANDBOX_NAME)).rejects.toThrow(
      "entrypoint child exposed supervisor TLS identity",
    );
  });

  it.each([
    ["any bounding capability", "0000000000000001", [], "exec child expected full CapBnd=0"],
    [
      "a supervisor TLS identity",
      "0000000000000000",
      ["OPENSHELL_TLS_CERT"],
      "exec child exposed supervisor TLS identity",
    ],
  ])("rejects an exec report exposing %s", async (_case, capBnd, tlsNames, message) => {
    const { command, host, nemoclaw } = fakeHost();
    command
      .mockResolvedValueOnce(probeResult(`${CONTAINER_ID}\topenshell-${SANDBOX_NAME}\n`))
      .mockResolvedValueOnce(childReport("entrypoint"));
    nemoclaw.mockResolvedValueOnce(childReport("exec", capBnd, tlsNames as string[]));

    await expect(assertExactMainChildProcessContracts(host, SANDBOX_NAME)).rejects.toThrow(message);
  });

  it("rejects a mislabeled container before inspecting any process", async () => {
    const { command, host } = fakeHost();
    command.mockResolvedValueOnce(probeResult(`${CONTAINER_ID}\topenshell-unrelated-sandbox\n`));

    await expect(assertExactMainChildProcessContracts(host, SANDBOX_NAME)).rejects.toThrow(
      "unexpected OpenShell Docker container identity",
    );
    expect(command).toHaveBeenCalledTimes(1);
  });

  it("rejects connect success without one executed zero-bound marker", async () => {
    const { command, host, nemoclaw } = fakeHost();
    command
      .mockResolvedValueOnce(probeResult(`${CONTAINER_ID}\topenshell-${SANDBOX_NAME}\n`))
      .mockResolvedValueOnce(childReport("entrypoint"))
      .mockResolvedValueOnce(probeResult("remote shell closed without proof\n"));
    nemoclaw.mockResolvedValueOnce(childReport("exec"));

    await expect(assertExactMainChildProcessContracts(host, SANDBOX_NAME)).rejects.toThrow(
      "connect child emitted 0 proof markers",
    );
  });

  it("rejects a connect marker reporting any bounding capability", async () => {
    const { command, host, nemoclaw } = fakeHost();
    command
      .mockResolvedValueOnce(probeResult(`${CONTAINER_ID}\topenshell-${SANDBOX_NAME}\n`))
      .mockResolvedValueOnce(childReport("entrypoint"))
      .mockResolvedValueOnce(probeResult("NEMOCLAW_EXACT_MAIN_CONNECT_CHILD_OK CapBnd=1\n"));
    nemoclaw.mockResolvedValueOnce(childReport("exec"));

    await expect(assertExactMainChildProcessContracts(host, SANDBOX_NAME)).rejects.toThrow(
      "connect child expected full CapBnd=0",
    );
  });
});
