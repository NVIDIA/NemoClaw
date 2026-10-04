// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * SSH port-forward guidance for remote-deployed hosts (#5925).
 *
 * When the CLI is run inside an SSH session and the dashboard is bound to
 * loopback (the default), the printed `http://127.0.0.1:<port>/` URL is not
 * reachable from the operator's workstation without a port forward. These pure
 * helpers detect the SSH session and build a copy-pastable
 * `ssh -L <port>:127.0.0.1:<port> <user>@<host>` example so the post-onboard
 * block and `dashboard-url` output can show it. No I/O — env is passed in so
 * callers/tests stay deterministic.
 */

import { isLoopbackHostname } from "../core/url-utils";

const HOST_PLACEHOLDER = "<host>";
const USER_PLACEHOLDER = "<user>";

/** Detect whether the current process is running inside an SSH session. */
export function isSshSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY);
}

/**
 * Only surface usernames that are safe to show verbatim inside the example
 * command. Anything outside the conservative POSIX set falls back to the
 * `<user>` placeholder rather than rendering an odd or misleading command.
 */
function safeUser(value: string | undefined): string | null {
  if (!value) return null;
  return /^[A-Za-z0-9._-]+$/.test(value) ? value : null;
}

/**
 * Only surface a destination that a caller supplied explicitly and that is safe
 * to show verbatim (hostname, IP, or SSH config alias characters). We never
 * infer the destination from `SSH_CONNECTION`: its server-IP field is the remote
 * socket address, which loses the original host token, `-p` port, `ProxyJump`,
 * and any `~/.ssh/config` alias, so it is not the address the operator typed and
 * is not reliably reachable from their workstation. Unknown/unsafe destinations
 * fall back to the `<host>` placeholder.
 */
function safeDestination(value: string | undefined): string | null {
  if (!value) return null;
  return /^[A-Za-z0-9._-]+$/.test(value) ? value : null;
}

/** True when the access URL still points at loopback (forward required). */
function accessUrlNeedsForward(accessUrl: string | null | undefined): boolean {
  const raw = String(accessUrl || "").trim();
  if (!raw) return true;
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`);
    return isLoopbackHostname(url.hostname);
  } catch {
    return true;
  }
}

export interface SshForwardHintOptions {
  /** Dashboard port that must be forwarded. */
  port: number;
  /**
   * Resolved access URL. When it already points at a routable address (WSL
   * fallback, `NEMOCLAW_DASHBOARD_BIND=0.0.0.0`, etc.) the forward is
   * unnecessary and no hint is produced.
   */
  accessUrl?: string | null;
  /** Indent applied to every line. Defaults to two spaces. */
  indent?: string;
  /** Trailing guidance line; defaults to a generic "open the URL above" hint. */
  openHint?: string;
  /**
   * Explicit SSH destination the operator used (host, IP, or `~/.ssh/config`
   * alias). Rendered verbatim when safe; otherwise the example keeps the
   * `<host>` placeholder. Not inferred from `SSH_CONNECTION` -- see
   * {@link safeDestination}.
   */
  destination?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Build the copy-pastable SSH port-forward guidance block, or null when it
 * does not apply (not an SSH session, or the dashboard is already reachable
 * without a forward).
 */
export function buildSshForwardHintLines(options: SshForwardHintOptions): string[] | null {
  const env = options.env ?? process.env;
  if (!isSshSession(env)) return null;
  if (!accessUrlNeedsForward(options.accessUrl)) return null;

  const indent = options.indent ?? "  ";
  // The host is a placeholder unless the caller supplies the original
  // destination: `SSH_CONNECTION` cannot recover an alias, NAT'd hostname, or
  // `ProxyJump` target, so its socket IP is not reliably copy-pastable. The
  // username, by contrast, is the effective remote login user and stays correct.
  const host = safeDestination(options.destination) ?? HOST_PLACEHOLDER;
  const user = safeUser(env.USER ?? env.LOGNAME) ?? USER_PLACEHOLDER;
  const port = options.port;
  const openHint = options.openHint ?? "Then open the dashboard URL above in your local browser.";

  return [
    `${indent}Remote access (SSH session detected):`,
    `${indent}  On your workstation, run:`,
    `${indent}    ssh -L ${port}:127.0.0.1:${port} ${user}@${host}`,
    `${indent}  ${openHint}`,
  ];
}
