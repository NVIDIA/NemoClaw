// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

let runtimeBridgeFactory = () => ({
  sandboxSkillInstall: async (sandboxName: string, args?: string[]) => {
    const { installSandboxSkill } = require("../../../actions/sandbox/skill-install") as {
      installSandboxSkill: (sandboxName: string, args?: string[]) => Promise<void>;
    };
    await installSandboxSkill(sandboxName, args);
  },
});

export function setSkillInstallRuntimeBridgeFactoryForTest(
  factory: () => { sandboxSkillInstall: (sandboxName: string, args?: string[]) => Promise<void> },
): void {
  runtimeBridgeFactory = factory;
}

export function getSkillInstallRuntimeBridge() {
  return runtimeBridgeFactory();
}
