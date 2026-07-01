// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const OPENSHELL_EXEC_ARGUMENT_LIMIT_BYTES = 32_768;

const PROXY_ENV_CHUNK_BYTES = 16_384;
const DEFAULT_PROXY_ENV_PATH = "/tmp/nemoclaw-proxy-env.sh";
const PROXY_ENV_RESTORE_BOOTSTRAP =
  `set -eu; target="$1"; shift; rm -f "$target" 2>/dev/null || true; ` +
  `(printf '%s' "$@" | base64 -d > "$target" 2>/dev/null && chmod 444 "$target") || true; ` +
  `wc -c < "$target" 2>/dev/null || true`;

export function buildProxyEnvRestoreInvocation(
  encodedProxyEnv: string,
  targetPath = DEFAULT_PROXY_ENV_PATH,
): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < encodedProxyEnv.length; offset += PROXY_ENV_CHUNK_BYTES) {
    chunks.push(encodedProxyEnv.slice(offset, offset + PROXY_ENV_CHUNK_BYTES));
  }
  if (chunks.length === 0) chunks.push("");

  const invocation = [
    "sh",
    "-lc",
    PROXY_ENV_RESTORE_BOOTSTRAP,
    "nemoclaw-proxy-env-restore",
    targetPath,
    ...chunks,
  ];
  const oversizedArgument = invocation.find(
    (argument) => Buffer.byteLength(argument, "utf8") >= OPENSHELL_EXEC_ARGUMENT_LIMIT_BYTES,
  );
  if (oversizedArgument !== undefined) {
    throw new Error(
      `proxy-env restore argument must be smaller than ${OPENSHELL_EXEC_ARGUMENT_LIMIT_BYTES} bytes`,
    );
  }
  return invocation;
}
