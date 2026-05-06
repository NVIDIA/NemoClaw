// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args } from "@oclif/core";

import { runSandboxSnapshot } from "../../../sandbox-runtime-actions";

let runtimeBridgeFactory = () => ({ sandboxSnapshot: runSandboxSnapshot });

export function setSnapshotRuntimeBridgeFactoryForTest(
  factory: () => { sandboxSnapshot: (sandboxName: string, args: string[]) => Promise<void> },
): void {
  runtimeBridgeFactory = factory;
}

export function getSnapshotRuntimeBridge() {
  return runtimeBridgeFactory();
}

export const sandboxNameArg = Args.string({
  name: "sandbox",
  description: "Sandbox name",
  required: true,
});
