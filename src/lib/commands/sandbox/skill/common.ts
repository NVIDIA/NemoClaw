// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { installSandboxSkill } from "../../../sandbox-runtime-actions";

let runtimeBridgeFactory = () => ({ sandboxSkillInstall: installSandboxSkill });

export function setSkillInstallRuntimeBridgeFactoryForTest(
  factory: () => { sandboxSkillInstall: (sandboxName: string, args?: string[]) => Promise<void> },
): void {
  runtimeBridgeFactory = factory;
}

export function getSkillInstallRuntimeBridge() {
  return runtimeBridgeFactory();
}
