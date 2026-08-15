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

  function mockHostsFixture(reads: string[]) {
    vi.spyOn(fs, "mkdtempSync").mockReturnValue("/tmp/nemoclaw-compatible-endpoint-hosts-test");
    vi.spyOn(fs, "openSync").mockReturnValue(42);
    const close = vi.spyOn(fs, "closeSync").mockImplementation(() => {});
    const unlink = vi.spyOn(fs, "unlinkSync").mockImplementation(() => {});
    vi.spyOn(fs, "readFileSync").mockImplementation(() => reads.shift() ?? "");
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => {});
    const remove = vi.spyOn(fs, "rmSync").mockImplementation(() => {});
    return { close, remove, unlink };
  }

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
    const mappedHosts = hostVerificationHostsFile(originalHosts);
    const { close, remove, unlink } = mockHostsFixture([
      originalHosts,
      mappedHosts,
      mappedHosts,
      mappedHosts,
      originalHosts,
    ]);
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

    expect(command).toHaveBeenCalledTimes(2);
    expect(
      command.mock.calls.map(([program, args]) => [program, args?.[0], args?.at(-2), args?.at(-1)]),
    ).toEqual([
      [
        "sudo",
        "bash",
        "/tmp/nemoclaw-compatible-endpoint-hosts-test/hosts.original",
        "/tmp/nemoclaw-compatible-endpoint-hosts-test/hosts.mapped",
      ],
      [
        "sudo",
        "bash",
        "/tmp/nemoclaw-compatible-endpoint-hosts-test/hosts.mapped",
        "/tmp/nemoclaw-compatible-endpoint-hosts-test/hosts.original",
      ],
    ]);
    expect(trackDisposable.mock.invocationCallOrder[0]).toBeLessThan(
      command.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(remove).toHaveBeenCalledWith("/tmp/nemoclaw-compatible-endpoint-hosts-test", {
      force: true,
      recursive: true,
    });
    expect(close).toHaveBeenCalledWith(42);
    expect(unlink).toHaveBeenCalledTimes(1);
  });

  it("does not discard a concurrent host resolver update", async () => {
    const originalHosts = "127.0.0.1 localhost\n";
    const mappedHosts = hostVerificationHostsFile(originalHosts);
    const concurrentHosts = `${mappedHosts}192.0.2.10 concurrent.example.test\n`;
    const { close, remove, unlink } = mockHostsFixture([
      originalHosts,
      mappedHosts,
      mappedHosts,
      concurrentHosts,
    ]);
    const command = vi.fn().mockResolvedValue({ exitCode: 0, stderr: "", stdout: "" });

    await expect(
      withHostVerificationLoopbackAlias(
        { command } as unknown as HostCliClient,
        { trackDisposable: vi.fn() },
        async () => undefined,
      ),
    ).rejects.toThrow("refusing to overwrite concurrent resolver state");

    expect(command).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledWith(42);
    expect(unlink).toHaveBeenCalledTimes(1);
  });

  it("reports a failed owned resolver restoration", async () => {
    const originalHosts = "127.0.0.1 localhost\n";
    const mappedHosts = hostVerificationHostsFile(originalHosts);
    const { close, remove, unlink } = mockHostsFixture([
      originalHosts,
      mappedHosts,
      mappedHosts,
      mappedHosts,
    ]);
    const command = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: "" })
      .mockResolvedValueOnce({ exitCode: 1, stderr: "permission denied", stdout: "" });

    await expect(
      withHostVerificationLoopbackAlias(
        { command } as unknown as HostCliClient,
        { trackDisposable: vi.fn() },
        async () => undefined,
      ),
    ).rejects.toThrow("could not restore /etc/hosts: permission denied");

    expect(command).toHaveBeenCalledTimes(2);
    expect(remove).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledWith(42);
    expect(unlink).toHaveBeenCalledTimes(1);
  });

  it("restores an observed mapping after the mapping runner fails", async () => {
    const originalHosts = "127.0.0.1 localhost\n";
    const mappedHosts = hostVerificationHostsFile(originalHosts);
    const { close, remove, unlink } = mockHostsFixture([
      originalHosts,
      mappedHosts,
      mappedHosts,
      originalHosts,
    ]);
    const command = vi
      .fn()
      .mockRejectedValueOnce(new Error("mapping runner disconnected"))
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: "" });

    await expect(
      withHostVerificationLoopbackAlias(
        { command } as unknown as HostCliClient,
        { trackDisposable: vi.fn() },
        async () => undefined,
      ),
    ).rejects.toThrow("mapping runner disconnected");

    expect(command).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledWith("/tmp/nemoclaw-compatible-endpoint-hosts-test", {
      force: true,
      recursive: true,
    });
    expect(close).toHaveBeenCalledWith(42);
    expect(unlink).toHaveBeenCalledTimes(1);
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
