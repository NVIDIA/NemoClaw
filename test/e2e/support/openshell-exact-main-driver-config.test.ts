// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveOpenShellSiblingComponents } from "../../helpers/openshell-components.ts";
import { createOpenShellDriverConfigTestWrapper } from "../live/openshell-driver-config-test-wrapper.ts";
import {
  assertGatewayListeners,
  assertRuntimeMounts,
  requireRunningSandboxContainer,
  EXACT_MAIN_DRIVER_CONFIG_JSON,
  EXACT_MAIN_DRIVER_CONFIG_PROOF_ENV,
  EXACT_MAIN_TMPFS_MOUNT,
  prepareExactMainDriverConfigProof,
} from "../live/openshell-exact-main-driver-config.ts";

const originalProofEnv = process.env[EXACT_MAIN_DRIVER_CONFIG_PROOF_ENV];
const restoreProofEnv =
  originalProofEnv === undefined
    ? () => Reflect.deleteProperty(process.env, EXACT_MAIN_DRIVER_CONFIG_PROOF_ENV)
    : () => Reflect.set(process.env, EXACT_MAIN_DRIVER_CONFIG_PROOF_ENV, originalProofEnv);

afterEach(() => {
  restoreProofEnv();
});

describe("OpenShell driver configuration for main-branch E2E", () => {
  it.each(["sandbox", "supervisor"] as const)("selects exactly one scoped %s", async (role) => {
    const command = vi.fn(async (_command: string, _args: string[]) => ({
      exitCode: 0,
      stdout: "container-id\n",
      stderr: "",
    }));
    await expect(
      requireRunningSandboxContainer({ command } as never, "candidate", "gateway-id", role, "test"),
    ).resolves.toBe("container-id");
    expect(command.mock.calls[0]?.[1]).toEqual([
      "ps",
      "--no-trunc",
      "--filter",
      "label=openshell.ai/sandbox-name=candidate",
      "--filter",
      "label=openshell.ai/managed-by=openshell",
      "--filter",
      "label=openshell.ai/sandbox-namespace=gateway-id",
      "--filter",
      "label=openshell.ai/isolation-role=" + role,
      "--format",
      "{{.ID}}",
    ]);
  });

  it.each(["", "one\ntwo\n"])("rejects a missing or ambiguous role: %j", async (stdout) => {
    const command = vi.fn(async () => ({ exitCode: 0, stdout, stderr: "" }));
    await expect(
      requireRunningSandboxContainer(
        { command } as never,
        "candidate",
        "gateway-id",
        "sandbox",
        "test",
      ),
    ).rejects.toThrow();
  });

  function splitRuntimeFixture(fault: string) {
    const hash = "a".repeat(64);
    const tmpfs = { Destination: "/run/nemoclaw-dcode-mcp", Type: "tmpfs", RW: true };
    const channel = {
      Destination: "/.openshell/channel",
      Type: "volume",
      RW: true,
      Source: "/volumes/channel",
    };
    const state = {
      Destination: "/.openshell/supervisor",
      Type: "volume",
      RW: false,
      Source: "/volumes/auth",
    };
    const command = vi.fn(async (_command: string, args: string[]) => {
      const respond: Record<string, () => { exitCode: number; stdout: string; stderr: string }> = {
        exec: () => {
          expect(args).toEqual([
            "exec",
            "--user",
            "0",
            "workload",
            "sha256sum",
            "/.openshell/runtime/openshell-sandbox",
          ]);
          return {
            exitCode: 0,
            stdout:
              (fault === "binary" ? "b".repeat(64) : hash) +
              "  /.openshell/runtime/openshell-sandbox\n",
            stderr: "",
          };
        },
        inspect: () => {
          const supervisor = args[3] === "supervisor";
          let value: unknown;
          switch (args[2]) {
            case "{{json .HostConfig.Mounts}}":
              value = [
                {
                  Type: "tmpfs",
                  Target: tmpfs.Destination,
                  TmpfsOptions: { Mode: 0o1777, SizeBytes: 1_048_576 },
                },
              ];
              break;
            case "{{json .HostConfig.Tmpfs}}":
              value = fault === "legacy tmpfs" ? { [tmpfs.Destination]: "rw" } : null;
              break;
            case "{{json .Mounts}}":
              value = supervisor
                ? [
                    {
                      ...channel,
                      RW: fault === "writable supervisor",
                      Source: fault === "channel" ? "/volumes/other" : channel.Source,
                    },
                    state,
                  ]
                : [tmpfs, channel, ...(fault === "credential exposure" ? [state] : [])];
              break;
            case "{{json .HostConfig.Binds}}":
              value = [];
              break;
            case "{{json .NetworkSettings.Networks}}":
              value = fault === "network attachment" ? { bridge: {} } : { none: {} };
              break;
            case "{{json .HostConfig.NetworkMode}}":
              value = supervisor ? "host" : fault === "network mode" ? "bridge" : "none";
              break;
            case "{{json .Config.Labels}}":
              value = {
                "openshell.ai/sandbox-id": supervisor && fault === "identity" ? "other" : "same-id",
              };
              break;
            default:
              throw new Error("Unexpected inspection " + args[2]);
          }
          return { exitCode: 0, stdout: JSON.stringify(value), stderr: "" };
        },
      };
      return respond[args[0]!]!();
    });
    return {
      host: { command },
      proof: { provenance: { artifacts: { standaloneSandbox: { binarySha256: hash } } } },
    };
  }

  it("accepts the expected split-runtime mount and network layout", async () => {
    const { host, proof } = splitRuntimeFixture("");
    await expect(
      assertRuntimeMounts(host as never, proof as never, "workload", "supervisor", "test"),
    ).resolves.toBeUndefined();
  });

  it.each([
    "binary",
    "channel",
    "writable supervisor",
    "credential exposure",
    "network attachment",
    "network mode",
    "identity",
    "legacy tmpfs",
  ])("rejects split-runtime %s mismatch", async (fault) => {
    const { host, proof } = splitRuntimeFixture(fault);
    await expect(
      assertRuntimeMounts(host as never, proof as never, "workload", "supervisor", "test"),
    ).rejects.toThrow();
  });

  function observeGatewayListener(address: string, pid: number) {
    const command = vi.fn(async () => ({
      exitCode: 0,
      stdout: "  LISTEN 0 4096 " + address + " 0.0.0.0:* users:((gateway,pid=" + pid + ",fd=3))\n",
      stderr: "",
    }));
    return assertGatewayListeners({ command } as never, 42, { port: 8080 } as never, "test");
  }

  it("accepts the gateway's loopback listener", async () => {
    await expect(observeGatewayListener("127.0.0.1:8080", 42)).resolves.toBeUndefined();
  });

  it.each([
    ["0.0.0.0:8080", 42],
    ["[::]:8080", 42],
    ["127.0.0.1:8080", 43],
  ] as const)("rejects gateway listener %s owned by PID %i", async (address, pid) => {
    await expect(observeGatewayListener(address, pid)).rejects.toThrow();
  });
  it("resolves one canonical executable set for CLI, gateway, and sandbox (#11547)", () => {
    const rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-components-"));
    const installDirectory = path.join(rootDirectory, "install");
    const pathDirectory = path.join(rootDirectory, "path");
    try {
      fs.mkdirSync(installDirectory);
      fs.mkdirSync(pathDirectory);
      fs.writeFileSync(path.join(installDirectory, "openshell"), "#!/bin/sh\n", { mode: 0o700 });
      fs.writeFileSync(path.join(installDirectory, "openshell-gateway"), "#!/bin/sh\n", {
        mode: 0o700,
      });
      fs.writeFileSync(path.join(installDirectory, "openshell-sandbox"), "#!/bin/sh\n", {
        mode: 0o700,
      });
      fs.symlinkSync(
        path.join(installDirectory, "openshell"),
        path.join(pathDirectory, "openshell"),
      );

      expect(resolveOpenShellSiblingComponents(path.join(pathDirectory, "openshell"))).toEqual({
        cli: path.join(installDirectory, "openshell"),
        gateway: path.join(installDirectory, "openshell-gateway"),
        sandbox: path.join(installDirectory, "openshell-sandbox"),
      });
    } finally {
      fs.rmSync(rootDirectory, { recursive: true, force: true });
    }
  });

  it("does nothing when the driver configuration check is disabled", async () => {
    delete process.env[EXACT_MAIN_DRIVER_CONFIG_PROOF_ENV];
    const add = vi.fn();

    const proof = prepareExactMainDriverConfigProof({ cleanup: { add } } as never, "inactive");
    expect(proof).toMatchObject({ active: false, envOverlay: {} });
    await expect(proof.assertAfterOnboard()).resolves.toBeUndefined();
    await expect(proof.assertAfterRebuild()).resolves.toBeUndefined();
    expect(add).not.toHaveBeenCalled();
  });

  it("adds the tmpfs driver configuration only to sandbox create", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-exact-main-driver-wrapper-"));
    const delegate = path.join(fixture, "openshell-real");
    fs.writeFileSync(delegate, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n", {
      encoding: "utf8",
      mode: 0o700,
    });
    const wrapper = createOpenShellDriverConfigTestWrapper({
      driverConfigJson: EXACT_MAIN_DRIVER_CONFIG_JSON,
      label: "exact-main-driver-config",
      realOpenshellPath: delegate,
    });
    try {
      expect(JSON.parse(EXACT_MAIN_DRIVER_CONFIG_JSON)).toEqual({
        docker: { mounts: [EXACT_MAIN_TMPFS_MOUNT] },
        podman: { mounts: [EXACT_MAIN_TMPFS_MOUNT] },
      });
      expect(EXACT_MAIN_TMPFS_MOUNT).toEqual({
        type: "tmpfs",
        target: "/run/nemoclaw-dcode-mcp",
        options: ["noexec"],
        size_bytes: 1_048_576,
        mode: 0o1777,
      });
      expect(EXACT_MAIN_DRIVER_CONFIG_JSON).not.toContain("selinux_label");
      expect(EXACT_MAIN_DRIVER_CONFIG_JSON).not.toContain('"type":"bind"');

      const create = spawnSync(wrapper.executable, ["sandbox", "create", "--name", "candidate"], {
        encoding: "utf8",
      });
      expect(create.status, create.stderr).toBe(0);
      expect(create.stdout.trimEnd().split("\n")).toEqual([
        "sandbox",
        "create",
        "--driver-config-json",
        EXACT_MAIN_DRIVER_CONFIG_JSON,
        "--name",
        "candidate",
      ]);

      const list = spawnSync(wrapper.executable, ["sandbox", "list"], {
        encoding: "utf8",
      });
      expect(list.status, list.stderr).toBe(0);
      expect(list.stdout.trimEnd().split("\n")).toEqual(["sandbox", "list"]);

      const duplicate = spawnSync(
        wrapper.executable,
        ["sandbox", "create", "--driver-config-json", "{}"],
        { encoding: "utf8" },
      );
      expect(duplicate.status).toBe(64);
      expect(duplicate.stderr).toContain("refusing duplicate --driver-config-json");
    } finally {
      wrapper.remove();
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("passes through an existing driver configuration unchanged", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-exact-main-pass-through-"));
    const delegate = path.join(fixture, "openshell-real");
    fs.writeFileSync(delegate, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n", {
      encoding: "utf8",
      mode: 0o700,
    });
    const wrapper = createOpenShellDriverConfigTestWrapper({
      delegatedCapabilityMarkers: ["driver-config-json"],
      label: "exact-main-pass-through",
      realOpenshellPath: delegate,
    });
    try {
      const create = spawnSync(
        wrapper.executable,
        ["sandbox", "create", "--driver-config-json", EXACT_MAIN_DRIVER_CONFIG_JSON],
        { encoding: "utf8" },
      );
      expect(create.status, create.stderr).toBe(0);
      expect(create.stdout.trimEnd().split("\n")).toEqual([
        "sandbox",
        "create",
        "--driver-config-json",
        EXACT_MAIN_DRIVER_CONFIG_JSON,
      ]);
    } finally {
      wrapper.remove();
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("expects gateway restart to empty tmpfs and preserve persistent files", () => {
    const source = fs.readFileSync(
      path.join("test", "e2e", "live", "openshell-exact-main-driver-config.ts"),
      "utf8",
    );
    const restart = source.match(
      /export async function restartAndAssertExactMainDriverConfig[\s\S]*?(?=\nexport async function assertExactMainDriverConfigAfterRebuild)/u,
    )?.[0];

    expect(restart).toBeDefined();
    expect(restart).toContain('tmpfsMarker: "absent"');
    expect(restart).not.toContain('tmpfsMarker: "present"');
    expect(restart).toContain("baseline.containerId");
    expect(restart).toContain("baseline.config.configSha256");
    expect(restart).toContain("durableMarkerValue: options.proof.durableMarkerValue!");
    expect(restart).toContain('"same-container-tmpfs-remounted-and-durable-state-retained"');
  });
});
