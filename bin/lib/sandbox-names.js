// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { validateName } = require("./runner");

const RESERVED_SANDBOX_NAMES = new Set([
  "onboard",
  "list",
  "deploy",
  "setup",
  "setup-spark",
  "start",
  "telegram",
  "stop",
  "status",
  "debug",
  "uninstall",
  "help",
]);

const SANDBOX_ACTIONS = new Set([
  "connect",
  "status",
  "logs",
  "policy-add",
  "policy-list",
  "destroy",
]);

function validateSandboxName(name, label = "sandbox name") {
  const validName = validateName(name, label);
  if (RESERVED_SANDBOX_NAMES.has(validName)) {
    throw new Error(
      `Invalid ${label}: '${validName}'. This name is reserved by the CLI. Use a different name, or target an existing sandbox with 'nemoclaw -- ${validName} <action>'.`,
    );
  }
  return validName;
}

module.exports = { RESERVED_SANDBOX_NAMES, SANDBOX_ACTIONS, validateSandboxName };
