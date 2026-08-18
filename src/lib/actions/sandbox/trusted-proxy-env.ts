// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { shellQuote } from "../../core/shell-quote";

const DEFAULT_PROXY_ENV_PATH = "/tmp/nemoclaw-proxy-env.sh";
const DEFAULT_MANAGED_STARTUP_CA_PATH = "/run/nemoclaw/managed-startup-ca-bundle.pem";

const MANAGED_STARTUP_CA_ENV_NAMES = [
  "CURL_CA_BUNDLE",
  "GIT_SSL_CAINFO",
  "NODE_EXTRA_CA_CERTS",
  "REQUESTS_CA_BUNDLE",
  "SSL_CERT_FILE",
] as const;

/**
 * Validate the cross-user runtime env file before sourcing it and suppress all
 * source-time output. Root-mode sandboxes require the root:444 trust posture;
 * non-root mode can enforce only the repository's accepted mode-444 boundary
 * because privilege separation is disabled there (scripts/lib/sandbox-init.sh).
 */
export function buildTrustedProxyEnvSourceShell(proxyEnvPath = DEFAULT_PROXY_ENV_PATH): string {
  return `
proxy_env=${shellQuote(proxyEnvPath)}
if [ -e "$proxy_env" ] || [ -L "$proxy_env" ]; then
  if [ -L "$proxy_env" ] || [ ! -f "$proxy_env" ]; then
    echo "[SECURITY] $proxy_env is unsafe (expected regular root-owned mode 444 file)" >&2
    exit 126
  fi
  perms="$(stat -c '%a' "$proxy_env" 2>/dev/null || stat -f '%Lp' "$proxy_env" 2>/dev/null || echo unknown)"
  owner="$(stat -c '%U' "$proxy_env" 2>/dev/null || stat -f '%Su' "$proxy_env" 2>/dev/null || echo unknown)"
  if [ "$(id -u)" -eq 0 ]; then
    if [ "$owner" != "root" ] || [ "$perms" != "444" ]; then
      echo "[SECURITY] $proxy_env has unsafe permissions: owner=$owner mode=$perms (expected root:444)" >&2
      exit 126
    fi
  elif [ "$perms" != "444" ]; then
    echo "[SECURITY] $proxy_env has unsafe permissions: mode=$perms (expected 444)" >&2
    exit 126
  fi
  if ! . "$proxy_env" >/dev/null 2>&1; then
    echo "[SECURITY] $proxy_env could not be sourced safely" >&2
    exit 126
  fi
fi
`.trim();
}

/**
 * Restore the fixed managed-startup trust bundle for an owned diagnostic
 * launched through a fresh OpenShell exec session. Those sessions do not
 * inherit the environment sourced by the managed startup hold, so private-TLS
 * probes otherwise fall back to the public trust store even though the exact
 * root-owned bundle is present and policy-readable.
 */
export function buildTrustedManagedStartupCaEnvShell(
  managedCaPath = DEFAULT_MANAGED_STARTUP_CA_PATH,
): string {
  const exports = MANAGED_STARTUP_CA_ENV_NAMES.map(
    (name) => `export ${name}="$managed_startup_ca"`,
  ).join("\n  ");
  return `
managed_startup_ca=${shellQuote(managedCaPath)}
if [ -e "$managed_startup_ca" ] || [ -L "$managed_startup_ca" ]; then
  if [ -L "$managed_startup_ca" ] || [ ! -f "$managed_startup_ca" ]; then
    echo "[SECURITY] $managed_startup_ca is unsafe (expected regular root-owned mode 444 file)" >&2
    exit 126
  fi
  perms="$(stat -c '%a' "$managed_startup_ca" 2>/dev/null || stat -f '%Lp' "$managed_startup_ca" 2>/dev/null || echo unknown)"
  owner="$(stat -c '%U' "$managed_startup_ca" 2>/dev/null || stat -f '%Su' "$managed_startup_ca" 2>/dev/null || echo unknown)"
  if [ "$owner" != "root" ] || [ "$perms" != "444" ]; then
    echo "[SECURITY] $managed_startup_ca has unsafe permissions: owner=$owner mode=$perms (expected root:444)" >&2
    exit 126
  fi
  ${exports}
fi
`.trim();
}
