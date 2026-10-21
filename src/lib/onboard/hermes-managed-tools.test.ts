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

describe("setupHermesToolGateways interactive selector", () => {
  const savedExitCode = process.exitCode;

  afterEach(() => {
    process.exitCode = savedExitCode;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("rejects with SIGINT, pins exit code 130 and re-raises SIGINT on Ctrl-C", async () => {
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
    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation((() => true) as typeof process.kill);
    process.exitCode = undefined;

    const pending = setupHermesToolGateways(HERMES_PROVIDER_NAME, "oauth", null, {
      prompt: vi.fn(),
      note: vi.fn(),
      isNonInteractive: () => false,
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
    });
    await vi.waitFor(() => expect(input.setRawMode).toHaveBeenCalledWith(true));
    input.write("\u0003");

    await expect(pending).rejects.toMatchObject({ message: "Prompt interrupted", code: "SIGINT" });
    expect(process.exitCode).toBe(130);
    expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGINT");
    expect(input.setRawMode).toHaveBeenLastCalledWith(false);
    expect(input.listenerCount("data")).toBe(0);
  });
});
