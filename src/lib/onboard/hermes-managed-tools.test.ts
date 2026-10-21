// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { HERMES_PROVIDER_NAME } from "../hermes-provider-auth";
import { setupHermesToolGateways, stringSetsEqual } from "./hermes-managed-tools";

describe("stringSetsEqual", () => {
  it("accepts equal selections regardless of order or duplicates", () => {
    expect(stringSetsEqual(["nous-web", "nous-code"], ["nous-code", "nous-web"])).toBe(true);
    expect(stringSetsEqual(["nous-web", "nous-web"], ["nous-web"])).toBe(true);
  });

  it("rejects selections with a missing or additional gateway", () => {
    expect(stringSetsEqual(["nous-web"], ["nous-web", "nous-code"])).toBe(false);
    expect(stringSetsEqual(["nous-web", "nous-code"], ["nous-web"])).toBe(false);
  });
});

describe("setupHermesToolGateways interactive selector EOF (#12169)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function openSelector() {
    // An inherited preset would bypass the interactive menu.
    vi.stubEnv("NEMOCLAW_HERMES_TOOL_GATEWAYS", "");
    vi.stubEnv("NEMOCLAW_HERMES_TOOL_GATEWAY_PRESETS", "");
    const input = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: vi.fn(),
      ref: vi.fn(),
      unref: vi.fn(),
    });
    const output = Object.assign(new PassThrough(), { isTTY: true });
    const select = () =>
      setupHermesToolGateways(HERMES_PROVIDER_NAME, "oauth", null, {
        prompt: vi.fn(),
        note: vi.fn(),
        isNonInteractive: () => false,
        input: input as unknown as NodeJS.ReadStream,
        output: output as unknown as NodeJS.WriteStream,
      });
    return { input, select };
  }

  it("cancels on an EOF queued before the menu enters raw mode", async () => {
    const { input, select } = openSelector();
    input.end();

    await expect(select()).rejects.toMatchObject({ code: "EOF" });
    expect(input.setRawMode).not.toHaveBeenCalledWith(true);
    expect(input.listenerCount("data")).toBe(0);
  });

  it("cancels on Ctrl-D typed inside the raw-mode menu and restores the terminal", async () => {
    const { input, select } = openSelector();
    const pending = select();
    await vi.waitFor(() => expect(input.setRawMode).toHaveBeenCalledWith(true));
    input.write("\u0004");

    await expect(pending).rejects.toMatchObject({ code: "EOF" });
    expect(input.setRawMode).toHaveBeenLastCalledWith(false);
    expect(input.listenerCount("data")).toBe(0);
  });
});
