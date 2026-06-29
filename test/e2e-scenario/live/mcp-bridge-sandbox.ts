// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { shellQuote } from "../../../src/lib/core/shell-quote";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { type SandboxClient, trustedSandboxShellScript } from "../fixtures/clients/sandbox.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

const MCP_CURL_HTTP_CODE_MARKER = "NEMOCLAW_MCP_CURL_HTTP_CODE=";

/**
 * Accept the two fail-closed shapes OpenShell can expose for a denied HTTPS
 * request: an L7 HTTP 403, or curl's exit 56 for a CONNECT-level proxy 403.
 */
export function isExpectedMcpCurlPolicyDenial(
  result: Pick<ShellProbeResult, "exitCode" | "stderr" | "stdout" | "timedOut">,
): boolean {
  if (result.timedOut) return false;

  const httpCode = result.stdout.match(
    new RegExp(`^${MCP_CURL_HTTP_CODE_MARKER}([0-9]{3})$`, "m"),
  )?.[1];
  if (result.exitCode === 0) return httpCode === "403";

  return (
    result.exitCode === 56 &&
    /curl:\s*\(56\)\s*CONNECT tunnel failed,\s*response 403/i.test(result.stderr)
  );
}

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

async function collectHermesRecoveryDiagnostics(
  sandbox: SandboxClient,
  sandboxName: string,
  artifactPrefix: string,
): Promise<string> {
  const diagnostics = await sandbox.execShell(
    sandboxName,
    trustedSandboxShellScript(
      [
        "set +e",
        "echo '=== identity ==='",
        "id",
        "echo '=== lifecycle files ==='",
        "stat -c '%U %G %a %h %n' /usr/local/bin/nemoclaw-start /run/nemoclaw/hermes-root-lifecycle 2>&1",
        "cat /run/nemoclaw/hermes-root-lifecycle 2>/dev/null || true",
        "echo '=== lifecycle processes ==='",
        "ps -eo user=,pid=,ppid=,stat=,args= | grep -E '[n]emoclaw-start|[h]ermes|[s]ocat' || true",
        'for log in /tmp/nemoclaw-start.log /tmp/gateway-recovery.log /tmp/gateway.log /tmp/dashboard.log; do echo "=== ${log} ==="; if [ -f "$log" ] && [ ! -L "$log" ]; then tail -n 200 "$log"; else echo missing-or-unsafe; fi; done',
      ].join("\n"),
    ),
    {
      artifactName: `${artifactPrefix}-recover-after-mcp-ca-restart-diagnostics`,
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    },
  );
  return `diagnostic exit: ${diagnostics.exitCode}\ndiagnostic stdout:\n${diagnostics.stdout}\ndiagnostic stderr:\n${diagnostics.stderr}`;
}

export async function installMcpTestCaInSandbox(
  host: HostCliClient,
  sandbox: SandboxClient,
  sandboxName: string,
  artifactPrefix: string,
  options: { recoverAgentRuntime?: boolean } = {},
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
      timeoutMs: 3 * 60_000,
    },
  );
  if (install.exitCode !== 0) {
    throw new Error(
      `${artifactPrefix} install MCP test CA into sandbox runtime\nstdout:\n${install.stdout}\nstderr:\n${install.stderr}`,
    );
  }
  await waitForSandboxAfterRestart(sandbox, sandboxName, artifactPrefix);

  if (options.recoverAgentRuntime) {
    const recover = await host.nemoclaw([sandboxName, "recover"], {
      artifactName: `${artifactPrefix}-recover-after-mcp-ca-restart`,
      env: {
        ...buildAvailabilityProbeEnv(),
        NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS: "90",
      },
      timeoutMs: 3 * 60_000,
    });
    if (recover.exitCode !== 0) {
      const diagnostics = await collectHermesRecoveryDiagnostics(
        sandbox,
        sandboxName,
        artifactPrefix,
      );
      throw new Error(
        `${artifactPrefix} recover agent runtime after installing MCP test CA\nstdout:\n${recover.stdout}\nstderr:\n${recover.stderr}\n${diagnostics}`,
      );
    }
    const managedLifecycle = await sandbox.exec(
      sandboxName,
      ["/usr/local/lib/nemoclaw/hermes-mcp-config-transaction.py", "probe"],
      {
        artifactName: `${artifactPrefix}-assert-managed-lifecycle-after-mcp-ca-restart`,
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 30_000,
      },
    );
    if (managedLifecycle.exitCode !== 0) {
      throw new Error(
        `${artifactPrefix} prove managed Hermes lifecycle after recovery\nstdout:\n${managedLifecycle.stdout}\nstderr:\n${managedLifecycle.stderr}`,
      );
    }
  }
}
