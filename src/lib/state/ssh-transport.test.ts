// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { isSshTransportFailure } from "./ssh-transport";

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

  it("treats SIGHUP/SIGPIPE terminated probes as transport failures", () => {
    // spawnSync surfaces signal-killed processes with status=null + signal set.
    // Match connect.ts by naming the transport-level signals explicitly.
    expect(isSshTransportFailure({ status: null, signal: "SIGHUP" })).toBe(true);
    expect(isSshTransportFailure({ status: null, signal: "SIGPIPE" })).toBe(true);
  });

  it("does not treat a reachable exit accompanied by a benign signal as unreachable", () => {
    // A remote exit-1 with a stale/benign signal field must still be classified
    // by exit code, not by the signal field.
    expect(isSshTransportFailure({ status: 1, signal: "SIGINT" })).toBe(false);
  });
});
