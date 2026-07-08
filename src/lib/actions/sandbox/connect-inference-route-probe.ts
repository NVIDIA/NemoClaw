// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type InferenceRouteProbeAgent = { name: string } | null;

const INFERENCE_ROUTE_PROBE_SCRIPT = [
  "OUT=/tmp/nemoclaw-inference-route-probe.out",
  "HTTP_CODE=$(curl -sk -o \"$OUT\" -w '%{http_code}' --connect-timeout 3 --max-time 8 https://inference.local/v1/models 2>/dev/null) || HTTP_CODE=000",
  'case "$HTTP_CODE" in 000|5*) printf \'BROKEN %s \' "$HTTP_CODE"; head -c 160 "$OUT" 2>/dev/null || true ;; *) printf \'OK %s\' "$HTTP_CODE" ;; esac',
].join("; ");

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
  "ALL_PROXY",
  "all_proxy",
] as const;

export function buildSandboxInferenceRouteProbeArgs(
  sandboxName: string,
  agent: InferenceRouteProbeAgent,
): string[] {
  const command =
    agent?.name === "langchain-deepagents-code"
      ? [
          // Clear the inherited sandbox-create proxy seed before bash starts.
          // The login shell then sources /sandbox/.profile, whose single source
          // of truth is /tmp/nemoclaw-proxy-env.sh; this TypeScript boundary
          // intentionally does not reconstruct NO_PROXY independently.
          "env",
          ...PROXY_ENV_KEYS.flatMap((key) => ["-u", key]),
          "HOME=/sandbox",
          "bash",
          "-lc",
          INFERENCE_ROUTE_PROBE_SCRIPT,
        ]
      : ["sh", "-c", INFERENCE_ROUTE_PROBE_SCRIPT];

  return ["sandbox", "exec", "--name", sandboxName, "--", ...command];
}
