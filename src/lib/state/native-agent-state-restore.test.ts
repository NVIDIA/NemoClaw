// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { buildRestoreCleanupCommand, buildRestoreTarArgs } from "./state-directory-restore";

describe("native agent state restore", () => {
  it("archives complete native plugin and package directories without image exclusions (#11766)", () => {
    expect(buildRestoreTarArgs("/backup", ["extensions", "plugins", "lazy-packages"])).toEqual([
      "-cf",
      "-",
      "-C",
      "/backup",
      "--",
      "extensions",
      "plugins",
      "lazy-packages",
    ]);
  });

  it("replaces complete native plugin and package directories before restore (#11766)", () => {
    const command = buildRestoreCleanupCommand("/sandbox/.agent", [
      "extensions",
      "plugins",
      "lazy-packages",
    ]);

    expect(command).toContain("rm -rf -- '/sandbox/.agent/extensions'");
    expect(command).toContain("rm -rf -- '/sandbox/.agent/plugins'");
    expect(command).toContain("rm -rf -- '/sandbox/.agent/lazy-packages'");
    expect(command).not.toContain("--exclude");
    expect(command).not.toContain("image-managed");
  });
});
