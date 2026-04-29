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

/**
 * When any HTTP proxy is forwarded, ensure localhost and loopback traffic is
 * not routed through it. Without this, tools that respect HTTP_PROXY (curl,
 * Node.js http, Python requests) will tunnel loopback requests to the user's
 * proxy (e.g. Privoxy), which fails with HTTP 500.
 * See: #2616
 */
export function withLocalNoProxy(env: Record<string, string>): void {
  const hasProxy = env.HTTP_PROXY || env.HTTPS_PROXY || env.http_proxy || env.https_proxy;
  if (!hasProxy) return;
  for (const key of ["NO_PROXY", "no_proxy"] as const) {
    const current = env[key] ?? "";
    const parts = current ? current.split(",").map((s) => s.trim()) : [];
    let changed = false;
    for (const host of ["localhost", "127.0.0.1"]) {
      if (!parts.includes(host)) {
        parts.push(host);
        changed = true;
      }
    }
    if (changed) env[key] = parts.join(",");
  }
}

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
  withLocalNoProxy(env);
  return env;
}
