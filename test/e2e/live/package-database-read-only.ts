// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resultText, shellQuote } from "../fixtures/clients/command.ts";
import { type SandboxClient, trustedSandboxShellScript } from "../fixtures/clients/sandbox.ts";
import type { RuntimeProviderPrerequisite } from "../fixtures/runtime-provider.ts";

type PackageDatabaseProbeOptions = {
  artifactPrefix: string;
  env: NodeJS.ProcessEnv;
  runtimeProvider: RuntimeProviderPrerequisite;
  sandbox: SandboxClient;
  sandboxName: string;
  timeoutMs: number;
};

function requireCondition(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

export async function expectPackageDatabaseReadOnly(
  options: PackageDatabaseProbeOptions,
): Promise<void> {
  const sentinel = `/var/lib/dpkg/nemoclaw-e2e-write-probe-${process.pid}`;
  const prepare = await options.runtimeProvider.execSandboxAsRoot(
      options.sandboxName,
      [
        "sh",
        "-c",
        'set -eu; probe="$1"; test ! -e "$probe"; install -o sandbox -g sandbox -m 600 /dev/null "$probe"',
        "sh",
        sentinel,
      ],
    {
      artifactName: `${options.artifactPrefix}-prepare-dpkg-landlock-sentinel`,
      env: options.env,
      sanitizeEnvironment: true,
      timeoutMs: options.timeoutMs,
    },
  );
  requireCondition(prepare.exitCode === 0, "package database sentinel preparation must succeed");

  try {
    const probe = await options.sandbox.execShell(
      options.sandboxName,
      trustedSandboxShellScript(
        String.raw`
set -euo pipefail
dpkg-query -W dpkg >/dev/null
printf 'DPKG_QUERY_OK\n'
control=/tmp/nemoclaw-e2e-dpkg-write-control
printf 'control\n' >"$control"
rm -f "$control"
printf 'CONTROL_WRITE_OK\n'
if printf 'denied\n' >${shellQuote(sentinel)} 2>/dev/null; then
  printf 'DPKG_WRITE_UNEXPECTEDLY_SUCCEEDED\n'
  exit 1
fi
printf 'DPKG_WRITE_DENIED\n'
`,
      ),
      {
        artifactName: `${options.artifactPrefix}-dpkg-package-database-read-only`,
        env: options.env,
        timeoutMs: options.timeoutMs,
      },
    );
    const output = resultText(probe);
    requireCondition(probe.exitCode === 0, "package database probe must exit successfully");
    requireCondition(output.includes("DPKG_QUERY_OK"), "dpkg-query read marker is missing");
    requireCondition(output.includes("CONTROL_WRITE_OK"), "writable control marker is missing");
    requireCondition(output.includes("DPKG_WRITE_DENIED"), "Landlock denial marker is missing");
  } finally {
    const cleanup = await options.runtimeProvider.execSandboxAsRoot(
      options.sandboxName,
      ["rm", "-f", "--", sentinel],
      {
        artifactName: `${options.artifactPrefix}-clean-dpkg-landlock-sentinel`,
        env: options.env,
        sanitizeEnvironment: true,
        timeoutMs: options.timeoutMs,
      },
    );
    requireCondition(cleanup.exitCode === 0, "package database sentinel cleanup must succeed");
  }
}
