// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const shieldsUp = vi.hoisted(() => vi.fn());
const shieldsDown = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/shields/index", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/shields/index")>();
  return { ...actual, shieldsUp, shieldsDown };
});

vi.mock("../../../lib/state/mcp-lifecycle-lock", () => ({
  withSandboxMutationLock: (_sandboxName: string, fn: () => unknown) => fn(),
}));

import { DeferredShieldsExit } from "../../../lib/shields/index";
import ShieldsDownCommand from "./down";
import ShieldsUpCommand from "./up";

const rootDir = process.cwd();

describe("shields command deferred-exit translation", () => {
  beforeEach(() => {
    shieldsUp.mockClear();
    shieldsDown.mockClear();
    shieldsUp.mockReturnValue(undefined);
    shieldsDown.mockReturnValue(undefined);
  });

  afterEach(() => {
    process.exitCode = 0;
  });

  describe("ShieldsUpCommand", () => {
    it("exits with the sentinel's code instead of crashing with a raw traceback (#7382)", async () => {
      shieldsUp.mockImplementation(() => {
        throw new DeferredShieldsExit("Config not locked: stat failed", 1);
      });

      await ShieldsUpCommand.run(["alpha"], rootDir);

      expect(shieldsUp).toHaveBeenCalledWith("alpha", { throwOnError: true });
      expect(process.exitCode).toBe(1);
    });

    it("preserves a non-default sentinel exit code (#7382)", async () => {
      shieldsUp.mockImplementation(() => {
        throw new DeferredShieldsExit("Locked shields state has filesystem drift", 2);
      });

      await ShieldsUpCommand.run(["alpha"], rootDir);

      expect(process.exitCode).toBe(2);
    });

    it("rethrows errors that are not the deferred-exit sentinel (#7382)", async () => {
      shieldsUp.mockImplementation(() => {
        throw new Error("unexpected");
      });

      await expect(ShieldsUpCommand.run(["alpha"], rootDir)).rejects.toThrow("unexpected");
    });

    it("keeps a zero exit code on success (#7382)", async () => {
      await ShieldsUpCommand.run(["alpha"], rootDir);

      expect(shieldsUp).toHaveBeenCalledWith("alpha", { throwOnError: true });
      expect(process.exitCode).toBe(0);
    });
  });

  describe("ShieldsDownCommand", () => {
    it("exits with the sentinel's code instead of crashing with a raw traceback (#7382)", async () => {
      shieldsDown.mockImplementation(() => {
        throw new DeferredShieldsExit("Config not unlocked: stat failed", 1);
      });

      await ShieldsDownCommand.run(["alpha"], rootDir);

      expect(shieldsDown).toHaveBeenCalledWith("alpha", {
        timeout: null,
        reason: null,
        policy: "permissive",
        throwOnError: true,
      });
      expect(process.exitCode).toBe(1);
    });

    it("rethrows errors that are not the deferred-exit sentinel (#7382)", async () => {
      shieldsDown.mockImplementation(() => {
        throw new Error("unexpected");
      });

      await expect(ShieldsDownCommand.run(["alpha"], rootDir)).rejects.toThrow("unexpected");
    });

    it("keeps a zero exit code on success (#7382)", async () => {
      await ShieldsDownCommand.run(["alpha"], rootDir);

      expect(process.exitCode).toBe(0);
    });
  });
});
