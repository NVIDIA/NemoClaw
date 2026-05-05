// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  normalizeDestroySandboxOptions,
  normalizeGarbageCollectImagesOptions,
  normalizeRebuildSandboxOptions,
  normalizeUpgradeSandboxesOptions,
} from "./lifecycle-options";

describe("lifecycle option normalization", () => {
  it("preserves typed destroy options and still accepts compatibility argv", () => {
    expect(normalizeDestroySandboxOptions({ yes: true })).toEqual({ yes: true });
    expect(normalizeDestroySandboxOptions(["--yes", "--force"])).toEqual({
      force: true,
      yes: true,
    });
  });

  it("preserves typed rebuild options and still accepts compatibility argv", () => {
    expect(normalizeRebuildSandboxOptions({ verbose: true, yes: true })).toEqual({
      verbose: true,
      yes: true,
    });
    expect(normalizeRebuildSandboxOptions(["-v", "--force"])).toEqual({
      force: true,
      verbose: true,
      yes: false,
    });
  });

  it("preserves typed maintenance options and still accepts compatibility argv", () => {
    expect(normalizeUpgradeSandboxesOptions({ auto: true, yes: true })).toEqual({
      auto: true,
      yes: true,
    });
    expect(normalizeUpgradeSandboxesOptions(["--check", "--yes"])).toEqual({
      auto: false,
      check: true,
      yes: true,
    });
    expect(normalizeGarbageCollectImagesOptions({ dryRun: true })).toEqual({ dryRun: true });
    expect(normalizeGarbageCollectImagesOptions(["--dry-run", "--force"])).toEqual({
      dryRun: true,
      force: true,
      yes: false,
    });
  });
});
