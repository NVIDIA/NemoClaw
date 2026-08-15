// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { normalizeCustomEndpointUrl } from "../../../src/lib/actions/inference-set.ts";
import {
  writeDockerDriverGatewayPidFile,
  writeDockerDriverGatewayRuntimeMarkerForStateDir,
} from "../../../src/lib/onboard/docker-driver-gateway-runtime-marker.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import {
  COMPATIBLE_ANTHROPIC_CREDENTIAL_ENV,
  COMPATIBLE_ANTHROPIC_PROVIDER,
  GATEWAY_HOST_VERIFICATION_MOUNT_SCRIPT,
  compatibleAnthropicMockEndpointUrl,
  compatibleAnthropicSwitchBinding,
  compatibleAnthropicSwitchEnv,
  installGatewayHostVerificationAlias,
  requireCompatibleAnthropicProviderAbsent,
} from "../fixtures/compatible-anthropic-switch.ts";

const INVALID_MANAGED_GATEWAY_STATE_CASES = [
  {
    label: "invalid",
    pid: process.pid,
    writePid: (stateDirectory: string, _pid: number) =>
      fs.writeFileSync(path.join(stateDirectory, "openshell-gateway.pid"), "not-a-pid\n", {
        mode: 0o600,
      }),
  },
  {
    label: "symlinked",
    pid: process.pid,
    writePid: (stateDirectory: string, pid: number) => {
      const target = path.join(stateDirectory, "pid-target");
      fs.writeFileSync(target, `${pid}\n`, { mode: 0o600 });
      fs.symlinkSync(target, path.join(stateDirectory, "openshell-gateway.pid"));
    },
  },
  {
    label: "stale",
    pid: 2_147_483_647,
    writePid: (stateDirectory: string, pid: number) =>
      writeDockerDriverGatewayPidFile(
        path.join(stateDirectory, "openshell-gateway.pid"),
        pid,
      ),
  },
] as const;

describe("compatible Anthropic inference switch setup", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

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

  it("passes the mock bridge through endpoint validation without DNS rewriting (#9166)", async () => {
    const endpointUrl = compatibleAnthropicMockEndpointUrl(18_766);
    const rewrite = vi.fn();

    await expect(normalizeCustomEndpointUrl(endpointUrl, rewrite)).resolves.toBe(endpointUrl);
    expect(rewrite).not.toHaveBeenCalled();
  });

  it("uses the managed Docker-driver gateway before the user service (#9166)", async () => {
    const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-managed-gateway-test-"));
    const pid = process.pid;
    const gatewayBin = "/usr/bin/openshell-gateway";
    vi.stubEnv("NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR", stateDirectory);
    writeDockerDriverGatewayPidFile(path.join(stateDirectory, "openshell-gateway.pid"), pid);
    writeDockerDriverGatewayRuntimeMarkerForStateDir(stateDirectory, {
      desiredEnv: {},
      endpoint: "https://127.0.0.1:8080",
      gatewayBin,
      pid,
    });
    const realpathSync = fs.realpathSync;
    const gatewayExecutablePaths = new Set([`/proc/${pid}/exe`, gatewayBin]);
    vi.spyOn(fs, "realpathSync").mockImplementation(
      ((target) =>
        gatewayExecutablePaths.has(String(target)) ? gatewayBin : realpathSync(target)) as typeof fs.realpathSync,
    );
    const command = vi.fn().mockResolvedValue({ exitCode: 0, stderr: "", stdout: "" });
    const add = vi.fn();

    try {
      await installGatewayHostVerificationAlias({ command } as unknown as HostCliClient, { add });
      const cleanupMount = add.mock.calls[0]?.[1] as () => Promise<void>;
      await cleanupMount();

      expect(command).toHaveBeenCalledTimes(2);
      for (const call of command.mock.calls) {
        expect(call[0]).toBe("sudo");
        expect(call[1]).toEqual(
          expect.arrayContaining([String(pid), GATEWAY_HOST_VERIFICATION_MOUNT_SCRIPT]),
        );
      }
    } finally {
      fs.rmSync(stateDirectory, { force: true, recursive: true });
    }
  });

  it("uses the active user service when managed gateway state is absent (#9166)", async () => {
    const stateDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-missing-gateway-state-test-"),
    );
    vi.stubEnv("NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR", stateDirectory);
    const command = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: "",
        stdout: "ActiveState=active\nMainPID=4242\n",
      })
      .mockResolvedValue({ exitCode: 0, stderr: "", stdout: "" });
    const add = vi.fn();

    try {
      await installGatewayHostVerificationAlias({ command } as unknown as HostCliClient, { add });
      const cleanupMount = add.mock.calls[0]?.[1] as () => Promise<void>;
      await cleanupMount();

      expect(command.mock.calls[0]?.slice(0, 2)).toEqual([
        "systemctl",
        [
          "--user",
          "show",
          "nemoclaw-openshell-gateway",
          "--property=ActiveState",
          "--property=MainPID",
        ],
      ]);
      for (const call of command.mock.calls.slice(1)) {
        expect(call[0]).toBe("sudo");
        expect(call[1]).toEqual(
          expect.arrayContaining(["4242", GATEWAY_HOST_VERIFICATION_MOUNT_SCRIPT]),
        );
      }
    } finally {
      fs.rmSync(stateDirectory, { force: true, recursive: true });
    }
  });

  it.each(INVALID_MANAGED_GATEWAY_STATE_CASES)(
    "rejects $label managed gateway PID state (#9166)",
    async ({ pid, writePid }) => {
      const stateDirectory = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-invalid-gateway-state-test-"),
      );
      vi.stubEnv("NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR", stateDirectory);
      writeDockerDriverGatewayRuntimeMarkerForStateDir(stateDirectory, {
        desiredEnv: {},
        endpoint: "https://127.0.0.1:8080",
        gatewayBin: "/usr/bin/openshell-gateway",
        pid,
      });
      writePid(stateDirectory, pid);
      const command = vi.fn();

      try {
        await expect(
          installGatewayHostVerificationAlias({ command } as unknown as HostCliClient, {
            add: vi.fn(),
          }),
        ).rejects.toThrow(
          /Docker-driver gateway (PID file is invalid|process is unavailable|state is not an owned regular file)/u,
        );
        expect(command).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(stateDirectory, { force: true, recursive: true });
      }
    },
  );

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

describe("gateway resolver mount", () => {
  linuxIt("preserves a resolver write that overlaps mount installation (#9166)", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-resolver-test-"));
    const hostsPath = path.join(directory, "hosts");
    const underlayPath = path.join(directory, "hosts.underlay");
    const resolverSource = path.join(directory, "resolver-source");
    const fakeBin = path.join(directory, "bin");
    const token = "a".repeat(32);
    const ownedLine =
      `127.0.0.1 host.openshell.internal # nemoclaw-gateway-host-verifier:${token}`;
    try {
      fs.mkdirSync(fakeBin);
      fs.writeFileSync(hostsPath, "127.0.0.1 localhost\n", { mode: 0o644 });
      fs.writeFileSync(resolverSource, `${ownedLine}\n127.0.0.1 localhost\n`, { mode: 0o600 });
      fs.writeFileSync(
        path.join(fakeBin, "mount"),
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          '[[ "$1" == "--make-rprivate" ]] && exit 0',
          '[[ "$1" == "--bind" ]]',
          "printf '192.0.2.10 concurrent.example.test\\n' >> \"$3\"",
          'mv -- "$3" "$NEMOCLAW_TEST_RESOLVER_UNDERLAY"',
          'ln -s -- "$2" "$3"',
        ].join("\n"),
        { mode: 0o755 },
      );
      fs.writeFileSync(
        path.join(fakeBin, "umount"),
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          'rm -- "$1"',
          'mv -- "$NEMOCLAW_TEST_RESOLVER_UNDERLAY" "$1"',
        ].join("\n"),
        { mode: 0o755 },
      );
      const run = (operation: "add" | "remove") =>
        spawnSync(
          "bash",
          [
            "-ceu",
            GATEWAY_HOST_VERIFICATION_MOUNT_SCRIPT,
            "gateway-resolver-mount-test",
            operation,
            resolverSource,
            token,
            hostsPath,
          ],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              NEMOCLAW_TEST_RESOLVER_UNDERLAY: underlayPath,
              PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
            },
          },
        );

      const added = run("add");
      expect(added.status, added.stderr).toBe(0);
      expect(fs.readFileSync(hostsPath, "utf8")).toContain(ownedLine);
      expect(fs.readFileSync(underlayPath, "utf8")).toContain("concurrent.example.test");

      const removed = run("remove");
      expect(removed.status, removed.stderr).toBe(0);
      expect(fs.readFileSync(hostsPath, "utf8")).toBe(
        "127.0.0.1 localhost\n192.0.2.10 concurrent.example.test\n",
      );
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });
});
