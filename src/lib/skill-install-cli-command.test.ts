// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import SkillInstallCliCommand, {
  setSkillInstallRuntimeBridgeFactoryForTest,
} from "./skill-install-cli-command";

const rootDir = process.cwd();

describe("SkillInstallCliCommand", () => {
  it("runs skill install with the legacy install argv shape", async () => {
    const sandboxSkillInstall = vi.fn().mockResolvedValue(undefined);
    setSkillInstallRuntimeBridgeFactoryForTest(() => ({ sandboxSkillInstall }));

    await SkillInstallCliCommand.run(["alpha", "/tmp/my-skill"], rootDir);

    expect(sandboxSkillInstall).toHaveBeenCalledWith("alpha", ["install", "/tmp/my-skill"]);
  });

  it("requires an install path before dispatch", async () => {
    const sandboxSkillInstall = vi.fn().mockResolvedValue(undefined);
    setSkillInstallRuntimeBridgeFactoryForTest(() => ({ sandboxSkillInstall }));

    await expect(SkillInstallCliCommand.run(["alpha"], rootDir)).rejects.toThrow(/path/i);

    expect(sandboxSkillInstall).not.toHaveBeenCalled();
  });
});
