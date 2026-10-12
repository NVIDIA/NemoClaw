// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import * as runner from "../runner";
import { probeVerificationHostPort } from "./dashboard";

describe("probeVerificationHostPort", () => {
  it("returns the HTTP status the forwarded port answered with", () => {
    vi.spyOn(runner, "runCapture").mockReturnValue("200\n");

    expect(probeVerificationHostPort(18789, "/health")).toBe(200);
  });

  it("probes the forwarded port on loopback with a bounded timeout", () => {
    const runCapture = vi.spyOn(runner, "runCapture").mockReturnValue("200");

    probeVerificationHostPort(18789, "/health");

    expect(runCapture).toHaveBeenCalledWith(
      expect.arrayContaining(["curl", "--max-time", "3", "http://127.0.0.1:18789/health"]),
      { ignoreError: true },
    );
  });

  it("reports 0 when the forward is down and curl prints nothing", () => {
    vi.spyOn(runner, "runCapture").mockReturnValue("");

    expect(probeVerificationHostPort(18789, "/health")).toBe(0);
  });
});
