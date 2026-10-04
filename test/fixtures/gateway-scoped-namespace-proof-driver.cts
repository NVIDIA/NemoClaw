// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const {
  hasStateScopedSandboxNamespace,
} = require("../../src/lib/onboard/docker-driver-gateway-config");

const stateDir = process.env.NEMOCLAW_TEST_GATEWAY_STATE_DIR;
if (!stateDir) throw new Error("NEMOCLAW_TEST_GATEWAY_STATE_DIR is required");

process.stdout.write("ready\n");
process.stdin.once("data", () => process.exit(hasStateScopedSandboxNamespace(stateDir) ? 1 : 0));
