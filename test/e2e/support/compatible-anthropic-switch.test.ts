// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { HostCliClient } from "../fixtures/clients/host.ts";
import {
  COMPATIBLE_ANTHROPIC_CREDENTIAL_ENV,
  COMPATIBLE_ANTHROPIC_PROVIDER,
  compatibleAnthropicSwitchBinding,
  compatibleAnthropicSwitchEnv,
  hostVerificationHostsFile,
  requireCompatibleAnthropicProviderAbsent,
  withHostVerificationLoopbackAlias,
} from "../fixtures/compatible-anthropic-switch.ts";

describe("compatible Anthropic inference switch setup", () => {
  afterEach(() => vi.restoreAllMocks());

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

  it("maps the sandbox host alias to loopback for host-side verification", () => {
    expect(hostVerificationHostsFile("127.0.0.1 localhost\n")).toBe(
      "127.0.0.1 host.openshell.internal\n127.0.0.1 localhost\n",
    );
  });

  it("restores the host resolver file when verification fails", async () => {
    const originalHosts = "127.0.0.1 localhost\n";
    vi.spyOn(fs, "mkdtempSync").mockReturnValue("/tmp/nemoclaw-compatible-endpoint-hosts-test");
    vi.spyOn(fs, "readFileSync").mockReturnValue(originalHosts);
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => {});
    const remove = vi.spyOn(fs, "rmSync").mockImplementation(() => {});
    const command = vi.fn().mockResolvedValue({ exitCode: 0, stderr: "", stdout: "" });
    const trackDisposable = vi.fn();

    await expect(
      withHostVerificationLoopbackAlias(
        { command } as unknown as HostCliClient,
        { trackDisposable },
        async () => {
          throw new Error("verification failed");
        },
      ),
    ).rejects.toThrow("verification failed");

    expect(command.mock.calls.map(([program, args]) => [program, args])).toEqual([
      [
        "sudo",
        [
          "cp",
          "--",
          "/tmp/nemoclaw-compatible-endpoint-hosts-test/hosts.mapped",
          "/etc/hosts",
        ],
      ],
      [
        "sudo",
        [
          "cp",
          "--",
          "/tmp/nemoclaw-compatible-endpoint-hosts-test/hosts.original",
          "/etc/hosts",
        ],
      ],
    ]);
    expect(trackDisposable.mock.invocationCallOrder[0]).toBeLessThan(
      command.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(remove).toHaveBeenCalledWith("/tmp/nemoclaw-compatible-endpoint-hosts-test", {
      force: true,
      recursive: true,
    });
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
