// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type SandboxClient, trustedSandboxShellScript } from "./clients/sandbox.ts";

/** Record bounded readiness evidence without repeating a failed tool invocation. */
export async function captureNativePluginFailureReadiness(
  sandbox: Pick<SandboxClient, "execShell">,
  result: { exitCode: number | null },
  options: { sandboxName: string; artifactName: string; env: NodeJS.ProcessEnv },
): Promise<void> {
  if (result.exitCode === 0) return;
  await sandbox
    .execShell(
      options.sandboxName,
      trustedSandboxShellScript(
        `. /tmp/nemoclaw-proxy-env.sh && for endpoint in healthz readyz; do printf '%s=' "$endpoint"; curl --noproxy '*' --max-time 3 --silent --output /dev/null --write-out '%{http_code}\\n' "http://127.0.0.1:\${OPENCLAW_GATEWAY_PORT:-18789}/$endpoint" || true; done`,
      ),
      {
        artifactName: `${options.artifactName}-readiness-after-failure`,
        env: options.env,
        captureLimitBytes: 1024,
        timeoutMs: 10_000,
      },
    )
    .catch(() => undefined);
}
