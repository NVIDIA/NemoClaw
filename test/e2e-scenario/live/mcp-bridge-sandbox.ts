// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { shellQuote } from "../../../src/lib/core/shell-quote";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { type SandboxClient, trustedSandboxShellScript } from "../fixtures/clients/sandbox.ts";

function requireMcpTestCaPath(): string {
  const caPath = process.env.NEMOCLAW_MCP_TLS_CA_CERT;
  if (!caPath) {
    throw new Error("NEMOCLAW_MCP_TLS_CA_CERT is required for the HTTPS MCP live proof");
  }
  return caPath;
}

async function waitForSandboxAfterRestart(
  sandbox: SandboxClient,
  sandboxName: string,
  artifactPrefix: string,
): Promise<void> {
  for (let attempt = 1; attempt <= 18; attempt += 1) {
    const ready = await sandbox.execShell(sandboxName, trustedSandboxShellScript("true"), {
      artifactName: `${artifactPrefix}-wait-after-mcp-ca-restart-${attempt}`,
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 10_000,
    });
    if (ready.exitCode === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`OpenShell sandbox '${sandboxName}' did not recover after installing test CA`);
}

export async function installMcpTestCaInSandbox(
  host: HostCliClient,
  sandbox: SandboxClient,
  sandboxName: string,
  artifactPrefix: string,
): Promise<void> {
  const caPath = requireMcpTestCaPath();
  const install = await host.command(
    "bash",
    [
      "-lc",
      [
        "set -euo pipefail",
        `sandbox_name=${shellQuote(sandboxName)}`,
        `ca_path=${shellQuote(caPath)}`,
        `container_id="$(docker ps --filter \"label=openshell.ai/sandbox-name=\${sandbox_name}\" --format '{{.ID}}' | head -n 1)"`,
        '[ -n "$container_id" ] || { echo "OpenShell sandbox container not found" >&2; exit 1; }',
        'docker cp "$ca_path" "$container_id:/tmp/nemoclaw-mcp-e2e-ca.crt"',
        "docker exec --user 0 \"$container_id\" sh -eu -c 'install -m 0644 /tmp/nemoclaw-mcp-e2e-ca.crt /usr/local/share/ca-certificates/nemoclaw-mcp-e2e.crt && update-ca-certificates'",
        'docker restart "$container_id" >/dev/null',
      ].join("\n"),
    ],
    {
      artifactName: `${artifactPrefix}-install-mcp-test-ca`,
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 2 * 60_000,
    },
  );
  if (install.exitCode !== 0) {
    throw new Error(
      `${artifactPrefix} install MCP test CA into sandbox runtime\nstdout:\n${install.stdout}\nstderr:\n${install.stderr}`,
    );
  }
  await waitForSandboxAfterRestart(sandbox, sandboxName, artifactPrefix);
}
