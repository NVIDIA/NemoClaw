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
  const args = [...SSH_OPTS];
  if (opts.tty) args.unshift("-t");
  args.push(host);
  if (remoteCmd) args.push(remoteCmd);
  return runArgv("ssh", args, opts);
}

function runScp(src, destHostPath, opts = {}) {
  const args = ["-q", ...SSH_OPTS, src, destHostPath];
  return runArgv("scp", args, opts);
}

function runRsync(sources, host, dest, opts = {}) {
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
