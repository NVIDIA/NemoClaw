// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { HostCliClient } from "../fixtures/clients/host.ts";
import {
  COMPATIBLE_ANTHROPIC_CREDENTIAL_ENV,
  COMPATIBLE_ANTHROPIC_PROVIDER,
  compatibleAnthropicSwitchBinding,
  compatibleAnthropicSwitchEnv,
  HOST_VERIFICATION_NAMESPACE_SCRIPT,
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

  it("runs host verification inside a private resolver mount namespace", async () => {
    const result = { exitCode: 0, stderr: "", stdout: "verified" };
    const command = vi.fn().mockResolvedValue(result);
    const commandEnv = { COMPATIBLE_ANTHROPIC_API_KEY: "fixture-key" };

    await expect(
      withHostVerificationLoopbackAlias(
        { command } as unknown as HostCliClient,
        (scopedHost) =>
          scopedHost.command("node", ["nemoclaw.js", "inference", "set"], {
            artifactName: "inference-set",
            env: commandEnv,
            redactionValues: ["fixture-key"],
          }),
      ),
    ).resolves.toBe(result);

    expect(command).toHaveBeenCalledOnce();
    const [program, args, options] = command.mock.calls[0] ?? [];
    expect(program).toBe("sudo");
    expect(args).toEqual(
      expect.arrayContaining([
        "--preserve-env",
        "unshare",
        "--mount",
        "--fork",
        "/etc/hosts",
        "node",
        "nemoclaw.js",
        "inference",
        "set",
      ]),
    );
    expect(args).not.toContain("fixture-key");
    expect(options).toEqual({
      artifactName: "inference-set",
      env: commandEnv,
      redactionValues: ["fixture-key"],
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

const linuxIt = process.platform === "linux" ? it : it.skip;

describe("host verifier resolver namespace", () => {
  function testFiles(): { directory: string; hostsPath: string; capturedPath: string } {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-host-verifier-test-"));
    const hostsPath = path.join(directory, "hosts");
    const capturedPath = path.join(directory, "hosts.private");
    fs.writeFileSync(hostsPath, "127.0.0.1 localhost\n", { mode: 0o644 });
    return { directory, hostsPath, capturedPath };
  }

  linuxIt("preserves an unrelated resolver write during private mount setup (#9166)", () => {
    const files = testFiles();
    const fakeBin = path.join(files.directory, "bin");
    const fakeMount = path.join(fakeBin, "mount");
    try {
      fs.mkdirSync(fakeBin);
      fs.writeFileSync(
        fakeMount,
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          '[[ "$1" == "--make-rprivate" ]] && exit 0',
          '[[ "$1" == "--bind" ]]',
          "printf '192.0.2.10 concurrent.example.test\\n' >> \"$NEMOCLAW_TEST_RESOLVER_SOURCE\"",
          'cp -- "$2" "$NEMOCLAW_TEST_RESOLVER_COPY"',
        ].join("\n"),
        { mode: 0o755 },
      );
      const result = spawnSync(
        "bash",
        [
          "-ceu",
          HOST_VERIFICATION_NAMESPACE_SCRIPT,
          "host-verifier-namespace-test",
          files.hostsPath,
          String(process.getuid?.()),
          String(process.getgid?.()),
          "true",
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            NEMOCLAW_TEST_RESOLVER_COPY: files.capturedPath,
            NEMOCLAW_TEST_RESOLVER_SOURCE: files.hostsPath,
            PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);

      expect(fs.readFileSync(files.hostsPath, "utf8")).toBe(
        "127.0.0.1 localhost\n192.0.2.10 concurrent.example.test\n",
      );
      const privateResolver = fs.readFileSync(files.capturedPath, "utf8");
      expect(privateResolver).toContain("127.0.0.1 host.openshell.internal");
      expect(privateResolver).not.toContain("concurrent.example.test");
    } finally {
      fs.rmSync(files.directory, { force: true, recursive: true });
    }
  });
});
