// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Deploy helpers — input validation and shell-safe command builders.

const INSTANCE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function validateInstanceName(name) {
  if (!name || !INSTANCE_NAME_RE.test(name)) {
    throw new Error(
      `Invalid instance name: ${JSON.stringify(name)}. ` +
      "Must start with alphanumeric and contain only [a-zA-Z0-9._-]."
    );
  }
}

function buildSshCommand(host, remoteCmd) {
  const args = [
    "ssh",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "LogLevel=ERROR",
  ];
  args.push(shellQuote(host));
  if (remoteCmd) args.push(shellQuote(remoteCmd));
  return args.join(" ");
}

function buildRsyncCommand(sources, host, dest) {
  const sshOpt = '"ssh -o StrictHostKeyChecking=accept-new -o LogLevel=ERROR"';
  const quotedSources = sources.map(shellQuote).join(" ");
  return `rsync -az --delete --exclude node_modules --exclude .git --exclude src -e ${sshOpt} ${quotedSources} ${shellQuote(host + ":" + dest)}`;
}

function shellQuote(s) {
  // Simple single-quote wrapping — escape any embedded single quotes
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

module.exports = {
  INSTANCE_NAME_RE,
  validateInstanceName,
  buildSshCommand,
  buildRsyncCommand,
  shellQuote,
};
