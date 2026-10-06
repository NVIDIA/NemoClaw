// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
const send = vi.hoisted(() => vi.fn(async () => "delivered"));
vi.mock("./send", () => ({ sendConfigurationSnapshotTelemetry: send }));
import {
  completedNestedConfigurationCount,
  hasParentConfigurationCompletion,
  withConfigurationCompletion,
} from "./completion";

describe("configuration completion ownership", () => {
  beforeEach(() => send.mockClear());
  it("waits for outer cleanup and sends once for nested operations", async () => {
    await withConfigurationCompletion("rebuild", async (complete) => {
      expect(hasParentConfigurationCompletion()).toBe(true);
      await withConfigurationCompletion("restore", async (childComplete) => childComplete());
      expect(completedNestedConfigurationCount()).toBe(1);
      expect(send).not.toHaveBeenCalled();
      complete();
      expect(send).not.toHaveBeenCalled();
    });
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith("rebuild", expect.any(Function));
    expect(hasParentConfigurationCompletion()).toBe(false);
  });
  it("does not send for failed outer cleanup even when a child succeeded", async () => {
    await expect(
      withConfigurationCompletion("rebuild", async () => {
        await withConfigurationCompletion("onboard", async (complete) => complete());
        throw new Error("required cleanup failed");
      }),
    ).rejects.toThrow("required cleanup failed");
    expect(send).not.toHaveBeenCalled();
  });
  it("does not send for no-ops or unverified completion", async () => {
    await withConfigurationCompletion("destroy", async () => {});
    await withConfigurationCompletion("messaging_add", async () => {});
    expect(send).not.toHaveBeenCalled();
  });
  it("keeps concurrent unrelated commands separate", async () => {
    await Promise.all([
      withConfigurationCompletion("rebuild", async (complete) => {
        await Promise.resolve();
        complete();
      }),
      withConfigurationCompletion("destroy", async (complete) => complete()),
    ]);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
