// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  normalizeDestroySandboxOptions,
  normalizeGarbageCollectImagesOptions,
  normalizeRebuildSandboxOptions,
  normalizeUpgradeSandboxesOptions,
} from "./options";

describe("lifecycle option normalization", () => {
  it("preserves typed destroy options and still accepts compatibility argv", () => {
    expect(normalizeDestroySandboxOptions({ yes: true })).toEqual({ yes: true });
    expect(normalizeDestroySandboxOptions(["--yes", "--force"])).toEqual({
      force: true,
      yes: true,
    });
  });

  describe("destroy cleanupGateway resolution (#2166)", () => {
    const ENV_KEY = "NEMOCLAW_CLEANUP_GATEWAY";
    let original: string | undefined;

    beforeEach(() => {
      original = process.env[ENV_KEY];
      delete process.env[ENV_KEY];
    });

    afterEach(() => {
      if (original === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = original;
    });

    it("leaves cleanupGateway unset by default so the runtime can prompt", () => {
      expect(normalizeDestroySandboxOptions(["--yes"])).toEqual({
        force: false,
        yes: true,
      });
      expect(normalizeDestroySandboxOptions({})).toEqual({});
    });

    it("threads --cleanup-gateway and --no-cleanup-gateway through argv", () => {
      expect(normalizeDestroySandboxOptions(["--yes", "--cleanup-gateway"])).toEqual({
        force: false,
        yes: true,
        cleanupGateway: true,
      });
      expect(normalizeDestroySandboxOptions(["--yes", "--no-cleanup-gateway"])).toEqual({
        force: false,
        yes: true,
        cleanupGateway: false,
      });
    });

    it("falls back to NEMOCLAW_CLEANUP_GATEWAY when no flag is passed", () => {
      process.env[ENV_KEY] = "1";
      expect(normalizeDestroySandboxOptions(["--yes"])).toEqual({
        force: false,
        yes: true,
        cleanupGateway: true,
      });
      expect(normalizeDestroySandboxOptions({ yes: true })).toEqual({
        yes: true,
        cleanupGateway: true,
      });
    });

    it("argv flag wins over env var", () => {
      process.env[ENV_KEY] = "1";
      expect(normalizeDestroySandboxOptions(["--yes", "--no-cleanup-gateway"])).toEqual({
        force: false,
        yes: true,
        cleanupGateway: false,
      });
    });

    it("last cleanup-gateway flag wins when both forms appear", () => {
      expect(
        normalizeDestroySandboxOptions(["--yes", "--cleanup-gateway", "--no-cleanup-gateway"]),
      ).toEqual({
        force: false,
        yes: true,
        cleanupGateway: false,
      });
      expect(
        normalizeDestroySandboxOptions(["--yes", "--no-cleanup-gateway", "--cleanup-gateway"]),
      ).toEqual({
        force: false,
        yes: true,
        cleanupGateway: true,
      });
    });

    it("explicit option object wins over env var", () => {
      process.env[ENV_KEY] = "0";
      expect(normalizeDestroySandboxOptions({ yes: true, cleanupGateway: true })).toEqual({
        yes: true,
        cleanupGateway: true,
      });
    });

    it("recognises common truthy/falsy spellings of NEMOCLAW_CLEANUP_GATEWAY", () => {
      for (const truthy of ["1", "true", "TRUE", "Yes"]) {
        process.env[ENV_KEY] = truthy;
        expect(normalizeDestroySandboxOptions({}).cleanupGateway).toBe(true);
      }
      for (const falsy of ["0", "false", "No"]) {
        process.env[ENV_KEY] = falsy;
        expect(normalizeDestroySandboxOptions({}).cleanupGateway).toBe(false);
      }
      for (const noise of ["", "  ", "maybe", "later"]) {
        process.env[ENV_KEY] = noise;
        expect(normalizeDestroySandboxOptions({}).cleanupGateway).toBeUndefined();
      }
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
