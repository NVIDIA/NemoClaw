// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { isSshTransportFailure } from "./sandbox";

describe("isSshTransportFailure", () => {
  it("treats an ssh transport failure exit code (255) as unreachable", () => {
    expect(isSshTransportFailure({ status: 255 })).toBe(true);
  });

  it("treats a timed-out or signal-killed probe (null status) as unreachable", () => {
    expect(isSshTransportFailure({ status: null })).toBe(true);
  });

  it("treats a spawn error as unreachable", () => {
    expect(isSshTransportFailure({ status: null, error: new Error("spawn ETIMEDOUT") })).toBe(true);
  });

  it("does not treat a reachable non-zero remote exit as unreachable", () => {
    expect(isSshTransportFailure({ status: 1 })).toBe(false);
    expect(isSshTransportFailure({ status: 2 })).toBe(false);
  });

  it("does not treat a successful probe as unreachable", () => {
    expect(isSshTransportFailure({ status: 0 })).toBe(false);
  });
});
