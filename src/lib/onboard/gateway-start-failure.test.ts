// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { reportLegacyGatewayStartResultFailure } from "./gateway-start-failure";

describe("reportLegacyGatewayStartResultFailure", () => {
  it("classifies Docker-unreachable output after stripping ANSI sequences (#2347)", () => {
    const log = vi.fn();
    const output = [
      "\x1b[31mError: Failed to create Docker client.\x1b[0m",
      "\x1b[33mSocket not found: /var/run/docker.sock\x1b[0m",
    ].join("\n");

    expect(reportLegacyGatewayStartResultFailure(output, log)).toEqual({
      kind: "docker_unreachable",
    });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("Gateway start returned before healthy"),
    );
    expect(log.mock.calls[0][0]).not.toContain("\x1b");
  });
});
