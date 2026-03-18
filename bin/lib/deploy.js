// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Deploy helpers — input validation and shell-free command builders.
//
// SSH/rsync/scp use runArgv() (argv arrays, no shell) to eliminate command
// injection at the root cause. shellQuote() is retained for call sites that
// still need run() (e.g. brev CLI with shell features).

const { runArgv } = require("./runner");

const INSTANCE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * Validate that name is a safe instance/hostname string.
 * @param {string} name - Instance name to validate.
 * @throws {Error} If name is invalid, non-string, or too long.
 */
function validateInstanceName(name) {
  if (!name || typeof name !== "string" || name.length > 253 || !INSTANCE_NAME_RE.test(name)) {
    throw new Error(
      `Invalid instance name: ${JSON.stringify(String(name).slice(0, 40))}. ` +
      "Must be a string, 1-253 chars, start with alphanumeric, and contain only [a-zA-Z0-9._-]."
    );
  }
}

const SSH_OPTS = ["-o", "StrictHostKeyChecking=accept-new", "-o", "LogLevel=ERROR"];

/** @param remoteCmd — executed by the remote shell. Use only constant strings
 *  or values wrapped in shellQuote(). Never interpolate unsanitized input. */
function runSsh(host, remoteCmd, opts = {}) {
  validateInstanceName(host);
  const args = [...SSH_OPTS];
  if (opts.tty) args.unshift("-t");
  args.push(host);
  if (remoteCmd) args.push(remoteCmd);
  return runArgv("ssh", args, opts);
}

/**
 * Copy a file to a remote host via scp using argv arrays (no shell).
 * @param {string} src - Local source path.
 * @param {string} destHostPath - Remote destination in host:path format.
 * @param {object} [opts] - Options forwarded to runArgv.
 */
function runScp(src, destHostPath, opts = {}) {
  const [host] = destHostPath.split(":");
  validateInstanceName(host);
  const args = ["-q", ...SSH_OPTS, src, destHostPath];
  return runArgv("scp", args, opts);
}

/**
 * Sync files to a remote host via rsync using argv arrays (no shell).
 * @param {string[]} sources - Local paths to sync.
 * @param {string} host - Remote hostname (must pass validateInstanceName).
 * @param {string} dest - Remote destination directory.
 * @param {object} [opts] - Options forwarded to runArgv.
 */
function runRsync(sources, host, dest, opts = {}) {
  validateInstanceName(host);
  const args = [
    "-az", "--delete",
    "--exclude", "node_modules",
    "--exclude", ".git",
    "--exclude", "src",
    "-e", "ssh " + SSH_OPTS.join(" "),
    ...sources,
    `${host}:${dest}`,
  ];
  return runArgv("rsync", args, opts);
}

/**
 * Wrap a string in POSIX single quotes, escaping embedded quotes.
 * @param {string} s - Value to quote.
 * @returns {string} Shell-safe single-quoted string.
 */
function shellQuote(s) {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

module.exports = {
  INSTANCE_NAME_RE,
  validateInstanceName,
  runSsh,
  runScp,
  runRsync,
  shellQuote,
  SSH_OPTS,
};
