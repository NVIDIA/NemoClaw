// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it, vi } from "vitest";
import { type CommandRunner, HostCliClient } from "../fixtures/clients/index.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

const FORWARD_ARGS =
  "--gateway nemoclaw --gateway-endpoint https://127.0.0.1:8080 --workspace default forward service alpha --target-port 18789 --target-host 127.0.0.1 --local 127.0.0.1:18789";

async function inspectListener(
  executable: string,
  options: {
    args?: string;
    actualExecutable?: string;
    afterPid?: string;
    timedOut?: boolean;
    exitCode?: number;
  } = {},
) {
  const responses = [
    "4321\n",
    "/usr/local/bin/openshell\n",
    `${options.actualExecutable ?? "/opt/openshell"}\n`,
    "/opt/openshell\n",
    `${executable} ${options.args ?? FORWARD_ARGS}\n`,
    `${options.afterPid ?? "4321"}\n`,
  ];
  let index = 0;
  const runner: CommandRunner = {
    run: vi.fn(async (): Promise<ShellProbeResult> => {
      const current = index++;
      return {
        command: [],
        stdout: responses[current] ?? "",
        stderr: "",
        exitCode: current === 2 ? (options.exitCode ?? 0) : 0,
        timedOut: current === 2 && options.timedOut === true,
        signal: null,
        artifacts: { stdout: "/unused/stdout", stderr: "/unused/stderr", result: "/unused/result" },
      };
    }),
  };
  const evidence = await new HostCliClient(runner).inspectOpenShellForwardListener(
    "18789",
    "alpha",
    {
      env: { OPENSHELL_GATEWAY: "nemoclaw", OPENSHELL_WORKSPACE: "default" },
    },
  );
  expect(runner.run).toHaveBeenCalledTimes(6);
  return evidence;
}

it("accepts internal POSIX separators only after verifying the forward's hosting executable", async () => {
  const evidence = await inspectListener("/usr/local//bin/openshell");
  expect(evidence).toMatchObject({ valid: true, pid: 4321 });
  expect(evidence.identity).toContain(`/usr/local//bin/openshell ${FORWARD_ARGS}`);
});

it.each(["/usr/local/bin/../bin/openshell", "//usr/local/bin/openshell", "/tmp/openshell-alias"])(
  "rejects an unverified executable spelling %s despite matching kernel executable probes",
  async (executable) => {
    expect((await inspectListener(executable)).valid).toBe(false);
  },
);

it.each([
  { actualExecutable: "/usr/bin/python3" },
  { afterPid: "4322" },
  { timedOut: true },
  { exitCode: 1 },
])(
  "keeps the process identity and probe guards for equivalent executable spelling: %j",
  async (options) => {
    expect((await inspectListener("/usr/local//bin/openshell", options)).valid).toBe(false);
  },
);

it.each([
  ["--gateway nemoclaw", "--gateway foreign"],
  ["https://127.0.0.1:8080", "https://127.0.0.1:18080"],
  ["--workspace default", "--workspace foreign"],
  ["service alpha", "service beta"],
  ["--target-port 18789", "--target-port 18790"],
  ["--target-host 127.0.0.1", "--target-host 0.0.0.0"],
  ["--local 127.0.0.1:18789", "--local 0.0.0.0:18789"],
])("keeps forward arguments exact when %s becomes %s", async (from, to) => {
  expect(
    (await inspectListener("/usr/local//bin/openshell", { args: FORWARD_ARGS.replace(from, to) }))
      .valid,
  ).toBe(false);
});
