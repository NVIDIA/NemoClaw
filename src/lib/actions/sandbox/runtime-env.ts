// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const SANDBOX_RUNTIME_ENV_FILE = "/tmp/nemoclaw-proxy-env.sh";

// Runtime env variables that ordinary caller argv must not inherit ambiently.
//
// Source-of-truth for this guard (#6291 / PRA-2):
//   - Invalid state: the root-generated runtime env file also exports
//     OPENCLAW_GATEWAY_TOKEN. Leaving it exported before `exec -- "$@"` makes
//     every general command inherit it, so diagnostics can print it accidentally
//     and OpenClaw can select gateway-token auth instead of local device auth.
//   - Source boundary: the runtime env file is a single shared trusted file;
//     splitting it per-consumer lives in scripts/nemoclaw-start.sh, not here.
//     This wrapper therefore removes the token from the child environment after
//     sourcing. The file remains sandbox-readable by design, so this guard is
//     not a secrecy boundary against a command that deliberately re-reads it.
//   - Credential audit: HTTP_PROXY/HTTPS_PROXY are required egress settings
//     generated as `http://${NEMOCLAW_PROXY_HOST}:${NEMOCLAW_PROXY_PORT}` with
//     no userinfo. State paths, gateway port, the private URL alias, and its
//     insecure-WS marker are routing metadata. OPENCLAW_GATEWAY_TOKEN is the
//     only credential-bearing value in this file and the only value removed
//     from ordinary caller argv.
//   - Owned exception: the gateway admin RPC path builds its own shell
//     (buildGatewayAdminRpcShell) that sources the same file and legitimately
//     needs the token; it does not use this wrapper, so no reinjection is
//     required here.
//   - Regression coverage: runtime-env.test.ts, passthrough-json.test.ts, and
//     nemoclaw-start-perms.test.ts cover exec, JSON-agent, and PID-1 one-shot
//     command boundaries respectively.
//   - Removal condition: if nemoclaw-start.sh emits the gateway token into a
//     separate owner-only env file that arbitrary commands never source, this
//     unset becomes redundant and can be removed.
const SANDBOX_RUNTIME_ENV_SENSITIVE_VARS = ["OPENCLAW_GATEWAY_TOKEN"];
const SANDBOX_RUNTIME_ENV_UNSET_SENSITIVE = `builtin unset ${SANDBOX_RUNTIME_ENV_SENSITIVE_VARS.join(" ")}`;
const SANDBOX_RUNTIME_ENV_EXEC_SCRIPT = `if [ -r "${SANDBOX_RUNTIME_ENV_FILE}" ]; then builtin source "${SANDBOX_RUNTIME_ENV_FILE}" || exit $?; fi; ${SANDBOX_RUNTIME_ENV_UNSET_SENSITIVE}; builtin exec -- "$@"`;

/**
 * Source NemoClaw's trusted runtime env without flattening the caller's argv.
 * The gateway token is removed after sourcing so ordinary caller argv does not
 * inherit it ambiently; owned helpers that need it source the file directly.
 * @internal Only NemoClaw-owned exec paths may source the root-generated file.
 */
export function wrapExecCommandWithRuntimeEnv(command: readonly string[]): string[] {
  return [
    "/bin/bash",
    "--noprofile",
    "--norc",
    "-p",
    "-c",
    SANDBOX_RUNTIME_ENV_EXEC_SCRIPT,
    "nemoclaw-runtime-env",
    ...command,
  ];
}
