// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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
const SANDBOX_ID = "sandbox-uuid-1";
const SANDBOX_WORKSPACE = "default";
const CONTAINER_ID = "a".repeat(64);
const CONTAINER_NAME = `openshell-${SANDBOX_WORKSPACE}--${SANDBOX_NAME}-${SANDBOX_ID}`;
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

function containerRow(
  overrides: { containerId?: string; name?: string; sandboxId?: string; workspace?: string } = {},
): string {
  return [
    overrides.containerId ?? CONTAINER_ID,
    overrides.name ?? CONTAINER_NAME,
    overrides.sandboxId ?? SANDBOX_ID,
    overrides.workspace ?? SANDBOX_WORKSPACE,
  ].join("\t");
}

function containerDiscovery(overrides: Parameters<typeof containerRow>[0] = {}): ShellProbeResult {
  return probeResult(`${containerRow(overrides)}\n`);
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
      expect(source).not.toContain("value.strip().split()[0]");
    }
    const parsed = spawnSync("bash", ["-n"], {
      encoding: "utf8",
      input: CONNECT_CHILD_PROBE,
    });
    expect(parsed.status, parsed.stderr).toBe(0);
  });

  it("parses proc status entries with an empty value", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-proc-status-"));
    const statusPath = path.join(directory, "status");
    try {
      writeFileSync(statusPath, "Name:\tpython3\nGroups:\t\nCapBnd:\t0000000000000000\n", "utf8");
      const source = EXEC_CHILD_PROBE.replace(
        'Path("/proc/self/status")',
        `Path(${JSON.stringify(statusPath)})`,
      );
      const executed = spawnSync("python3", ["-c", source], { encoding: "utf8" });

      expect(executed.status, executed.stderr).toBe(0);
      expect(JSON.parse(executed.stdout)).toEqual({
        capBnd: "0000000000000000",
        supervisorTlsEnvNames: [],
        surface: "exec",
      });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("proves entrypoint, exec, and forced-TTY connect children independently", async () => {
    const { command, host, nemoclaw } = fakeHost();
    command
      .mockResolvedValueOnce(containerDiscovery())
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
      '{{.ID}}\t{{.Names}}\t{{.Label "openshell.ai/sandbox-id"}}\t{{.Label "openshell.ai/sandbox-workspace"}}',
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
      .mockResolvedValueOnce(containerDiscovery())
      .mockResolvedValueOnce(childReport("entrypoint", "0000000000000001"));

    await expect(assertExactMainChildProcessContracts(host, SANDBOX_NAME)).rejects.toThrow(
      "entrypoint child expected full CapBnd=0",
    );
  });

  it("rejects a successful-looking entrypoint report naming supervisor TLS identity", async () => {
    const { command, host } = fakeHost();
    command
      .mockResolvedValueOnce(containerDiscovery())
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
      .mockResolvedValueOnce(containerDiscovery())
      .mockResolvedValueOnce(childReport("entrypoint"));
    nemoclaw.mockResolvedValueOnce(childReport("exec", capBnd, tlsNames as string[]));

    await expect(assertExactMainChildProcessContracts(host, SANDBOX_NAME)).rejects.toThrow(message);
  });

  it("rejects a mislabeled container before inspecting any process", async () => {
    const { command, host } = fakeHost();
    command.mockResolvedValueOnce(
      containerDiscovery({ name: "openshell-default--unrelated-sandbox-sandbox-uuid-1" }),
    );

    await expect(assertExactMainChildProcessContracts(host, SANDBOX_NAME)).rejects.toThrow(
      "unexpected OpenShell Docker container identity",
    );
    expect(command).toHaveBeenCalledTimes(1);
  });

  it("rejects a container qualified by a non-default workspace", async () => {
    const { command, host } = fakeHost();
    command.mockResolvedValueOnce(
      containerDiscovery({
        name: `openshell-review--${SANDBOX_NAME}-${SANDBOX_ID}`,
        workspace: "review",
      }),
    );

    await expect(assertExactMainChildProcessContracts(host, SANDBOX_NAME)).rejects.toThrow(
      "unexpected OpenShell Docker container identity",
    );
    expect(command).toHaveBeenCalledTimes(1);
  });

  it("rejects a container whose name does not carry its exact sandbox-id label", async () => {
    const { command, host } = fakeHost();
    command.mockResolvedValueOnce(
      containerDiscovery({
        name: `openshell-default--${SANDBOX_NAME}-different-sandbox-id`,
      }),
    );

    await expect(assertExactMainChildProcessContracts(host, SANDBOX_NAME)).rejects.toThrow(
      "unexpected OpenShell Docker container identity",
    );
    expect(command).toHaveBeenCalledTimes(1);
  });

  it("rejects an abbreviated mutable Docker container ID", async () => {
    const { command, host } = fakeHost();
    command.mockResolvedValueOnce(containerDiscovery({ containerId: "a".repeat(12) }));

    await expect(assertExactMainChildProcessContracts(host, SANDBOX_NAME)).rejects.toThrow(
      "unexpected OpenShell Docker container identity",
    );
    expect(command).toHaveBeenCalledTimes(1);
  });

  it("rejects multiple label-matching containers before inspecting a process", async () => {
    const { command, host } = fakeHost();
    command.mockResolvedValueOnce(
      probeResult(`${containerRow()}\n${containerRow({ containerId: "b".repeat(64) })}\n`),
    );

    await expect(assertExactMainChildProcessContracts(host, SANDBOX_NAME)).rejects.toThrow(
      "expected exactly one running Docker container",
    );
    expect(command).toHaveBeenCalledTimes(1);
  });

  it("rejects connect success without one executed zero-bound marker", async () => {
    const { command, host, nemoclaw } = fakeHost();
    command
      .mockResolvedValueOnce(containerDiscovery())
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
      .mockResolvedValueOnce(containerDiscovery())
      .mockResolvedValueOnce(childReport("entrypoint"))
      .mockResolvedValueOnce(probeResult("NEMOCLAW_EXACT_MAIN_CONNECT_CHILD_OK CapBnd=1\n"));
    nemoclaw.mockResolvedValueOnce(childReport("exec"));

    await expect(assertExactMainChildProcessContracts(host, SANDBOX_NAME)).rejects.toThrow(
      "connect child expected full CapBnd=0",
    );
  });
});
