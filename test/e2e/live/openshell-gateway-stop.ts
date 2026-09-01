// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";

import { type CommandExitResult, resultText } from "../fixtures/clients/command.ts";

const GATEWAY_ABSENT_DIAGNOSTIC = /^No gateway metadata found(?: for nemoclaw)?[.!]?$/i;

export function assertOpenShellGatewayStopResult(result: CommandExitResult): void {
  const diagnostic = resultText(result);
  assert(result.exitCode === 0 || GATEWAY_ABSENT_DIAGNOSTIC.test(diagnostic), diagnostic);
}
