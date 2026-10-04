// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  normalizeDestroySandboxOptions,
  normalizeGarbageCollectImagesOptions,
  normalizeRebuildSandboxOptions,
  normalizeUpgradeSandboxesOptions,
} from "./options";

describe("lifecycle option normalization", () => {
  beforeEach(() => {
    vi.stubEnv("NEMOCLAW_NON_INTERACTIVE", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("preserves typed destroy options and still accepts compatibility argv", () => {
    expect(normalizeDestroySandboxOptions({ yes: true })).toEqual({ yes: true });
    expect(normalizeDestroySandboxOptions(["--yes", "--force"])).toEqual({
      force: true,
      yes: true,
    });
  });

  it("normalizes the shared non-interactive environment into destroy confirmation", () => {
    vi.stubEnv("NEMOCLAW_NON_INTERACTIVE", "1");

    expect(normalizeDestroySandboxOptions([])).toEqual({ force: false, yes: true });
    expect(normalizeDestroySandboxOptions({})).toEqual({ yes: true });
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

    it.each(["1", "true", "TRUE", "Yes"])(
      "recognises truthy NEMOCLAW_CLEANUP_GATEWAY spelling %#",
      (value) => {
        process.env[ENV_KEY] = value;
        expect(normalizeDestroySandboxOptions({}).cleanupGateway).toBe(true);
      },
    );
    it.each(["0", "false", "No"])(
      "recognises falsy NEMOCLAW_CLEANUP_GATEWAY spelling %#",
      (value) => {
        process.env[ENV_KEY] = value;
        expect(normalizeDestroySandboxOptions({}).cleanupGateway).toBe(false);
      },
    );
    it.each(["", "  ", "maybe", "later"])(
      "ignores unrecognized NEMOCLAW_CLEANUP_GATEWAY spelling %#",
      (value) => {
        process.env[ENV_KEY] = value;
        expect(normalizeDestroySandboxOptions({}).cleanupGateway).toBeUndefined();
      },
    );
  });

  describe("destroy keepVllm resolution", () => {
    const ENV_KEY = "NEMOCLAW_KEEP_VLLM";

    beforeEach(() => {
      vi.stubEnv(ENV_KEY, undefined);
    });

    it("leaves keepVllm unset by default so destroy retires the last managed vLLM container", () => {
      expect(normalizeDestroySandboxOptions(["--yes"])).toEqual({ force: false, yes: true });
      expect(normalizeDestroySandboxOptions({ yes: true })).toEqual({ yes: true });
    });

    it("threads --keep-vllm through argv", () => {
      expect(normalizeDestroySandboxOptions(["--yes", "--keep-vllm"])).toEqual({
        force: false,
        yes: true,
        keepVllm: true,
      });
    });

    it("falls back to NEMOCLAW_KEEP_VLLM when no flag is passed", () => {
      vi.stubEnv(ENV_KEY, "1");
      expect(normalizeDestroySandboxOptions(["--yes"])).toEqual({
        force: false,
        yes: true,
        keepVllm: true,
      });
      expect(normalizeDestroySandboxOptions({ yes: true })).toEqual({ yes: true, keepVllm: true });
    });

    it("explicit option object wins over env var", () => {
      vi.stubEnv(ENV_KEY, "1");
      expect(normalizeDestroySandboxOptions({ yes: true, keepVllm: false })).toEqual({
        yes: true,
        keepVllm: false,
      });
    });

    it.each(["0", "false", "No"])("recognises falsy NEMOCLAW_KEEP_VLLM spelling %#", (value) => {
      vi.stubEnv(ENV_KEY, value);
      expect(normalizeDestroySandboxOptions({}).keepVllm).toBe(false);
    });

    it.each(["", "maybe"])("ignores unrecognized NEMOCLAW_KEEP_VLLM spelling %#", (value) => {
      vi.stubEnv(ENV_KEY, value);
      expect(normalizeDestroySandboxOptions({}).keepVllm).toBeUndefined();
    });
  });

  it("preserves typed rebuild options and still accepts compatibility argv", () => {
    expect(
      normalizeRebuildSandboxOptions({
        dcodeAutoApprovalMode: "thread-opt-in",
        toolDisclosure: "direct",
        verbose: true,
        yes: true,
      }),
    ).toEqual({
      dcodeAutoApprovalMode: "thread-opt-in",
      toolDisclosure: "direct",
      verbose: true,
      yes: true,
    });
    expect(
      normalizeRebuildSandboxOptions(["-v", "--force", "--tool-disclosure", "progressive"]),
    ).toEqual({
      force: true,
      toolDisclosure: "progressive",
      verbose: true,
      yes: false,
    });
    expect(normalizeRebuildSandboxOptions(["--tool-disclosure=direct"]).toolDisclosure).toBe(
      "direct",
    );
    expect(
      normalizeRebuildSandboxOptions(["--dcode-auto-approval", "thread-opt-in"])
        .dcodeAutoApprovalMode,
    ).toBe("thread-opt-in");
    expect(
      normalizeRebuildSandboxOptions(["--dcode-auto-approval=disabled"]).dcodeAutoApprovalMode,
    ).toBe("disabled");
    expect(normalizeRebuildSandboxOptions(["--observability"]).observabilityEnabled).toBe(true);
    expect(normalizeRebuildSandboxOptions(["--no-observability"]).observabilityEnabled).toBe(false);
    expect(
      normalizeRebuildSandboxOptions(["--observability", "--no-observability"])
        .observabilityEnabled,
    ).toBe(false);
    expect(
      normalizeRebuildSandboxOptions(["--no-observability", "--observability"])
        .observabilityEnabled,
    ).toBe(true);
    expect(() => normalizeRebuildSandboxOptions(["--tool-disclosure", "sometimes"])).toThrow(
      /progressive, direct/,
    );
    expect(() => normalizeRebuildSandboxOptions(["--tool-disclosure"])).toThrow(
      /progressive, direct/,
    );
    expect(() => normalizeRebuildSandboxOptions(["--tool-disclosure="])).toThrow(
      /progressive, direct/,
    );
    expect(() => normalizeRebuildSandboxOptions(["--dcode-auto-approval", "always"])).toThrow(
      /disabled, thread-opt-in/,
    );
    expect(() => normalizeRebuildSandboxOptions(["--dcode-auto-approval"])).toThrow(
      /disabled, thread-opt-in/,
    );
    expect(() => normalizeRebuildSandboxOptions(["--dcode-auto-approval="])).toThrow(
      /disabled, thread-opt-in/,
    );
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
