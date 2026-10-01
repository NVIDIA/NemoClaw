// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import { observeOpenShellGatewayRegistration } from "./gateway-reuse-cli";

const registration = {
  name: "nemoclaw",
  endpoint: "http://127.0.0.1:8080",
  auth: "plaintext",
  active: false,
};

beforeEach(() => {
  vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "");
});

describe("named gateway registration", () => {
  it("reads an inactive named gateway without network status or selection (#11861)", async () => {
    const capture = vi
      .fn()
      .mockResolvedValue({ status: 0, output: JSON.stringify([registration]) });
    expect(await observeOpenShellGatewayRegistration("nemoclaw", capture)).toEqual(registration);
    expect(capture).toHaveBeenCalledExactlyOnceWith(
      ["gateway", "list", "-o", "json"],
      expect.objectContaining({ timeout: expect.any(Number), ignoreError: true }),
    );
  });

  it.each([
    "not JSON",
    "[]",
    JSON.stringify([registration, registration]),
    JSON.stringify([{ ...registration, name: "other" }]),
    JSON.stringify([{ ...registration, active: "yes" }]),
  ])("refuses missing or ambiguous registry data %# (#11861)", async (output) => {
    const capture = vi.fn().mockResolvedValue({ status: 0, output });
    await expect(observeOpenShellGatewayRegistration("nemoclaw", capture)).rejects.toThrow(
      "missing or invalid",
    );
  });

  it("does not accept apparent JSON from a failed command (#11861)", async () => {
    const capture = vi
      .fn()
      .mockResolvedValue({ status: 1, output: JSON.stringify([registration]) });
    await expect(observeOpenShellGatewayRegistration("nemoclaw", capture)).rejects.toThrow(
      "read failed",
    );
  });

  it("refuses an ambient endpoint override before invoking the CLI (#11861)", async () => {
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "http://127.0.0.1:9090");
    const capture = vi.fn();
    await expect(observeOpenShellGatewayRegistration("nemoclaw", capture)).rejects.toThrow(
      "OPENSHELL_GATEWAY_ENDPOINT",
    );
    expect(capture).not.toHaveBeenCalled();
  });
});
