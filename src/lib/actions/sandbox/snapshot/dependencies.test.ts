// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { sleepSeconds } from "./dependencies";

describe("snapshot runtime dependencies", () => {
  afterEach(() => vi.restoreAllMocks());

  it("provides the synchronous sleep contract required by runtime lifecycle polling", () => {
    const wait = vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");

    expect(sleepSeconds(0.25)).toBeUndefined();
    expect(wait).toHaveBeenCalledExactlyOnceWith(expect.any(Int32Array), 0, 0, 250);
  });
});
