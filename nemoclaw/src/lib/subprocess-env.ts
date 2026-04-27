// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Subprocess environment allowlist.
 *
 * Subprocesses spawned by the CLI or plugin must NOT inherit the full
 * parent process.env — that leaks secrets (NVIDIA_API_KEY, GITHUB_TOKEN,
 * AWS_ACCESS_KEY_ID, etc.) to child processes where they can be read and
 * exfiltrated. Instead, only forward the categories below.
 *
 * Credentials needed by a subprocess are injected explicitly via the
 * `extra` parameter.
 *
 * See: #1874
 *
 * NOTE: src/lib/subprocess-env.ts is a mirror of this file for the CLI
 * project. Keep them in sync.
 */

// ── Allowed individual names ───────────────────────────────────

const SYSTEM = ["HOME", "USER", "LOGNAME", "SHELL", "PATH", "TERM", "HOSTNAME", "NODE_ENV"];

const TEMP = ["TMPDIR", "TMP", "TEMP"];

const LOCALE = ["LANG"]; // LC_* handled via prefix

const PROXY = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"];

const TLS = [
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "GIT_SSL_CAINFO",
  "GIT_SSL_CAPATH",
  "CURL_CA_BUNDLE",
  "REQUESTS_CA_BUNDLE",
];

const TOOLCHAIN = ["DOCKER_HOST", "KUBECONFIG", "SSH_AUTH_SOCK", "RUST_LOG", "RUST_BACKTRACE"];

const ALLOWED_ENV_NAMES = new Set([...SYSTEM, ...TEMP, ...LOCALE, ...PROXY, ...TLS, ...TOOLCHAIN]);

// ── Allowed prefixes ───────────────────────────────────────────

const ALLOWED_ENV_PREFIXES = ["LC_", "XDG_", "OPENSHELL_", "GRPC_"];

// ── Public API ─────────────────────────────────────────────────

export function buildSubprocessEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (ALLOWED_ENV_NAMES.has(key) || ALLOWED_ENV_PREFIXES.some((p) => key.startsWith(p))) {
      env[key] = value;
    }
  }
  if (extra) {
    Object.assign(env, extra);
  }
  return env;
}
