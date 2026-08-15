// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createManagedBootstrapTerminalFinalizer } from "./runtime-create";

describe("managed bootstrap terminal finalizer", () => {
  it("shares one in-flight outcome and rejects an opposite concurrent outcome", async () => {
    let release = (): void => {};
    const finalize = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const finalizer = createManagedBootstrapTerminalFinalizer(finalize);

    const firstCommit = finalizer.commit();
    const duplicateCommit = finalizer.commit();

    expect(duplicateCommit).toBe(firstCommit);
    await expect(finalizer.rollback()).rejects.toThrow(
      "rollback is no longer legal after commit finalization began",
    );
    release();
    await expect(Promise.all([firstCommit, duplicateCommit])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(finalize).toHaveBeenCalledExactlyOnceWith("commit");
  });

  it("retains the claimed outcome after a lost finalization acknowledgement", async () => {
    const finalize = vi.fn(async () => {
      throw new Error("commit acknowledgement lost");
    });
    const finalizer = createManagedBootstrapTerminalFinalizer(finalize);

    await expect(finalizer.commit()).rejects.toThrow("commit acknowledgement lost");
    await expect(finalizer.rollback()).rejects.toThrow(
      "rollback is no longer legal after commit finalization began",
    );
    expect(finalize).toHaveBeenCalledExactlyOnceWith("commit");
  });
});
