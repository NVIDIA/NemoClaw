// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical process-control environment policy for credential-handoff children.
 *
 * The standalone local credential helper and browser form embed literal copies
 * because they must run before NemoClaw is installed. The repository pin check
 * enforces exact parity with this source. Callers pass canonical uppercase names.
 */
export const PROCESS_CONTROL_ENV_NAMES: ReadonlySet<string> = new Set([
  "ALL_PROXY",
  "AWS_CA_BUNDLE",
  "BASHOPTS",
  "BASH_ENV",
  "CDPATH",
  "CLASSPATH",
  "COMSPEC",
  "CURL_CA_BUNDLE",
  "DENO_CERT",
  "DOTNET_STARTUP_HOOKS",
  "ENV",
  "FTP_PROXY",
  "GIT_ASKPASS",
  "GIT_EDITOR",
  "GIT_EXEC_PATH",
  "GIT_EXTERNAL_DIFF",
  "GIT_PAGER",
  "GIT_PROXY_COMMAND",
  "GIT_PROXY_SSL_CAINFO",
  "GIT_SEQUENCE_EDITOR",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_SSL_CAINFO",
  "GIT_SSL_CAPATH",
  "GIT_SSL_NO_VERIFY",
  "GLOBIGNORE",
  "GRPC_DEFAULT_SSL_ROOTS_FILE_PATH",
  "GRPC_PROXY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "IFS",
  "JAVA_TOOL_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "LESSCLOSE",
  "LESSOPEN",
  "MANPAGER",
  "NODE_EXTRA_CA_CERTS",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "NODE_USE_ENV_PROXY",
  "NODE_USE_SYSTEM_CA",
  "NO_PROXY",
  "PAGER",
  "PATH",
  "PATHEXT",
  "PERL5LIB",
  "PERL5OPT",
  "PS4",
  "PYTHONHOME",
  "PYTHONINSPECT",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "REQUESTS_CA_BUNDLE",
  "RUBYLIB",
  "RUBYOPT",
  "SHELL",
  "SHELLOPTS",
  "SSH_ASKPASS",
  "SSH_ASKPASS_REQUIRE",
  "SSLKEYLOGFILE",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "_JAVA_OPTIONS",
]);

export function isProcessControlEnvName(name: string): boolean {
  return (
    PROCESS_CONTROL_ENV_NAMES.has(name) ||
    name.startsWith("BASH_FUNC_") ||
    name.startsWith("LD_") ||
    name.startsWith("DYLD_") ||
    name === "GIT_CONFIG" ||
    name.startsWith("GIT_CONFIG_") ||
    name.startsWith("GIT_TRACE") ||
    name.startsWith("NPM_CONFIG_") ||
    name.startsWith("PIP_")
  );
}
