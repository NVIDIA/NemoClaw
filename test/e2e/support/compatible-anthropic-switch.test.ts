// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { HostCliClient } from "../fixtures/clients/host.ts";
import {
  COMPATIBLE_ANTHROPIC_CREDENTIAL_ENV,
  COMPATIBLE_ANTHROPIC_PROVIDER,
  compatibleAnthropicSwitchBinding,
  compatibleAnthropicSwitchEnv,
  requireCompatibleAnthropicProviderAbsent,
} from "../fixtures/compatible-anthropic-switch.ts";

describe("compatible Anthropic inference switch setup", () => {
  it("passes the direct binding credential only to the inference-set command", () => {
    const binding = compatibleAnthropicSwitchBinding("http://host.openshell.internal:18766", {
      COMPATIBLE_ANTHROPIC_API_KEY: "fixture-key",
    });

    expect(binding).toEqual({
      endpointUrl: "http://host.openshell.internal:18766",
      credentialValue: "fixture-key",
    });
    expect(compatibleAnthropicSwitchEnv(binding)).toEqual({
      [COMPATIBLE_ANTHROPIC_CREDENTIAL_ENV]: "fixture-key",
    });
    expect(compatibleAnthropicSwitchEnv(null)).toEqual({});
  });

  it("rejects a blank compatible Anthropic endpoint URL", () => {
    expect(() =>
      compatibleAnthropicSwitchBinding("   ", {
        COMPATIBLE_ANTHROPIC_API_KEY: "fixture-key",
      }),
    ).toThrow("NEMOCLAW_SWITCH_ENDPOINT_URL is required");
  });

  it("rejects a blank compatible Anthropic credential", () => {
    expect(() =>
      compatibleAnthropicSwitchBinding("http://host.openshell.internal:18766", {
        COMPATIBLE_ANTHROPIC_API_KEY: "   ",
      }),
    ).toThrow("COMPATIBLE_ANTHROPIC_API_KEY is required");
  });

  it("requires the direct provider to be absent before inference set owns its creation", async () => {
    const command = vi.fn().mockResolvedValue({
      exitCode: 1,
      stderr: "Error: code: 'Some requested entity was not found', message: \"provider not found\"",
      stdout: "",
    });
    const host = { command } as unknown as HostCliClient;
    const commandEnv = { OPENSHELL_GATEWAY: "nemoclaw" };

    await expect(
      requireCompatibleAnthropicProviderAbsent(host, {
        artifactName: "compatible-anthropic-provider-absent",
        env: commandEnv,
      }),
    ).resolves.toBeUndefined();
    expect(command).toHaveBeenCalledWith(
      "openshell",
      ["provider", "get", "-g", "nemoclaw", COMPATIBLE_ANTHROPIC_PROVIDER],
      expect.objectContaining({
        artifactName: "compatible-anthropic-provider-absent",
        env: commandEnv,
      }),
    );
  });

  it("rejects a pre-existing or uninspectable direct provider", async () => {
    const command = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: "",
        stdout: `Name: ${COMPATIBLE_ANTHROPIC_PROVIDER}`,
      })
      .mockResolvedValueOnce({
        exitCode: 1,
        stderr: "gateway unavailable",
        stdout: "",
      });
    const host = { command } as unknown as HostCliClient;
    const options = { artifactName: "provider-absent", env: {} };

    await expect(requireCompatibleAnthropicProviderAbsent(host, options)).rejects.toThrow(
      "must be absent",
    );
    await expect(requireCompatibleAnthropicProviderAbsent(host, options)).rejects.toThrow(
      "Could not prove",
    );
  });
});
