// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { assertExitZero as expectExitZero, resultText } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { expect } from "../fixtures/e2e-test.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

function expectExitNonZero(result: ShellProbeResult, label: string, pattern: RegExp): void {
  expect(
    result.exitCode,
    `${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  ).not.toBe(0);
  expect(resultText(result)).toMatch(pattern);
}

export async function assertExactMainMultilineExecContract(
  host: HostCliClient,
  sandboxName: string,
): Promise<void> {
  // The stable lane intentionally retains the old behavior. The exact-main
  // workflow sets this gate and requires this proof before accepting the run.
  if (process.env.NEMOCLAW_OPENSHELL_EXACT_MAIN_PROOF !== "1") return;

  const payload = "lf-one\ncrlf-two\r\nsingle-' double-\"\rbare-cr";
  const encoder = [
    "import base64, sys",
    'print(base64.b64encode(sys.argv[1].encode("utf-8")).decode("ascii"))',
  ].join("\n");
  const encoded = await host.nemoclaw(
    [sandboxName, "exec", "--", "python3", "-c", encoder, payload],
    {
      artifactName: "exact-main-multiline-argv-bytes",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 60_000,
    },
  );
  expectExitZero(encoded, "exact-main multiline argv byte preservation");
  expect(encoded.stdout.trim()).toBe(Buffer.from(payload, "utf8").toString("base64"));

  const expectedHeredoc = "first line\nquote ' and double \"\nlast line\n";
  const heredoc = [
    "cat <<'NEMOCLAW_EXACT_MAIN_EOF'",
    "first line",
    "quote ' and double \"",
    "last line",
    "NEMOCLAW_EXACT_MAIN_EOF",
  ].join("\n");
  const heredocResult = await host.nemoclaw([sandboxName, "exec", "--", "bash", "-lc", heredoc], {
    artifactName: "exact-main-multiline-heredoc",
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 60_000,
  });
  expectExitZero(heredocResult, "exact-main literal heredoc execution");
  expect(heredocResult.stdout).toBe(expectedHeredoc);

  const invalidWorkdir = await host.command(
    "openshell",
    [
      "sandbox",
      "exec",
      "--name",
      sandboxName,
      "--workdir",
      "/tmp/invalid\r\nworkdir",
      "--",
      "true",
    ],
    {
      artifactName: "exact-main-multiline-workdir-rejected",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 60_000,
    },
  );
  expectExitNonZero(
    invalidWorkdir,
    "exact-main multiline workdir rejection",
    /newline|carriage return/i,
  );

  const invalidEnvironment = await host.command(
    "openshell",
    [
      "sandbox",
      "exec",
      "--name",
      sandboxName,
      "--env",
      "NEMOCLAW_MULTILINE_VALUE=line-one\nline-two",
      "--",
      "true",
    ],
    {
      artifactName: "exact-main-multiline-env-rejected",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 60_000,
    },
  );
  expectExitNonZero(
    invalidEnvironment,
    "exact-main multiline environment rejection",
    /newline|carriage return/i,
  );
}
