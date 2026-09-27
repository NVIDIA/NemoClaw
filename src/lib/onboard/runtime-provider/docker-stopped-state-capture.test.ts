// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { managedStartupStateRootOwnership } from "../managed-startup/state-roots";
import { fingerprintOpenShellSandboxId } from "../../domain/sandbox/openshell-identity";
import { prepareStoppedDockerStateCapture } from "./docker-stopped-state-capture";

const managedRoots = managedStartupStateRootOwnership({
  agent: "openclaw",
  sandboxName: "alpha",
});
const managedRoot = managedRoots[0]!;
const managedMount = {
  Type: "volume",
  Name: managedRoot.resourceIdentity,
  Destination: managedRoot.mountTarget,
  Source: `/var/lib/docker/volumes/${managedRoot.resourceIdentity}/_data`,
  RW: true,
  Driver: "local",
};
function volumeObservation() {
  return {
    Name: managedRoot.resourceIdentity,
    Driver: "local",
    Scope: "local",
    CreatedAt: "2026-09-23T00:00:00Z",
    Mountpoint: managedMount.Source,
    Options: null,
    Labels: { ...managedRoot.ownershipLabels },
  };
}
const projection = {
  managedStateRoots: managedRoots,
  directories: ["workspace"],
  prefixes: ["workspace-"],
  files: ["openclaw.json"],
};
const containerId = "a".repeat(64);
const sandbox = {
  name: "alpha",
  agent: "openclaw",
  openshellDriver: "docker",
  lifecycleLiveIdentityFingerprint: fingerprintOpenShellSandboxId("sandbox-alpha")!,
};
const runtime = {
  schemaVersion: 1,
  providerId: "docker",
  providerHandle: "opaque-docker-handle",
  lifecycleState: "stopped",
  lifecycleGeneration: "generation",
  runtime: {
    schemaVersion: 1,
    providerId: "docker",
    runtime: { kind: "docker-container", handle: containerId },
    acceleration: { kind: "none" },
  },
} as const;

function observation() {
  return [
    containerId,
    {
      Status: "exited",
      Running: false,
      Paused: false,
      Restarting: false,
      StartedAt: "before",
      FinishedAt: "after",
    },
    {
      "openshell.ai/managed-by": "openshell",
      "openshell.ai/sandbox-name": "alpha",
      "openshell.ai/sandbox-id": "sandbox-alpha",
    },
    0,
    `sha256:${"b".repeat(64)}`,
    [],
  ];
}

function inspectResult(value: unknown) {
  const stdout = Buffer.from(JSON.stringify(value));
  return {
    status: 0,
    stdout,
    stderr: Buffer.alloc(0),
    signal: null,
    pid: 1,
    output: [null, stdout, Buffer.alloc(0)],
  } as ReturnType<typeof import("../../adapters/docker/exec").dockerSpawnSync>;
}

function inspectStorage(
  args: readonly string[],
  source: unknown[],
  volume: unknown = volumeObservation(),
  users = containerId,
) {
  const responses: Record<string, ReturnType<typeof inspectResult>> = {
    volume: inspectResult(volume),
    ps: { ...inspectResult([]), stdout: Buffer.from(`${users}\n`) },
    inspect: inspectResult(source),
  };
  return responses[args[0]!]!;
}

describe("stopped Docker recovery capture", () => {
  it.each([false, true])(
    "captures immutable stopped state with managed volume=%s",
    async (mounted) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-stopped-capture-test-"));
      const archive = path.join(root, "archive");
      fs.mkdirSync(path.join(root, ".openclaw", "workspace"), { recursive: true });
      fs.mkdirSync(path.join(root, ".openclaw", "identity"));
      fs.writeFileSync(path.join(root, ".openclaw", "workspace", "retained.txt"), "captured bytes");
      fs.writeFileSync(
        path.join(root, ".openclaw", "identity", "machine-key"),
        "NEVER-PERSIST-MACHINE-KEY",
      );
      const descriptor = fs.openSync(archive, "wx+", 0o600);
      const source: unknown[] = observation();
      source[5] = mounted ? [managedMount] : [];
      const inspect = vi.fn((args: readonly string[]) => inspectStorage(args, source));
      const read = vi.fn(() =>
        spawn("tar", ["-cf", "-", "-C", root, ".openclaw"], {
          env: { ...process.env, COPYFILE_DISABLE: "1" },
          stdio: ["ignore", "pipe", "pipe"],
        }),
      );
      try {
        await prepareStoppedDockerStateCapture(sandbox, runtime, projection, {
          inspect,
          spawn: read,
        }).capture(descriptor);
        expect(
          execFileSync("tar", ["-xOf", archive, "workspace/retained.txt"], { encoding: "utf8" }),
        ).toBe("captured bytes");
        const capturedBytes = Buffer.alloc(fs.fstatSync(descriptor).size);
        fs.readSync(descriptor, capturedBytes, 0, capturedBytes.length, 0);
        expect(capturedBytes.includes(Buffer.from("NEVER-PERSIST-MACHINE-KEY"))).toBe(false);
        expect(execFileSync("tar", ["-tf", archive], { encoding: "utf8" })).not.toContain(
          "identity",
        );
        expect(read).toHaveBeenCalledWith(["cp", `${containerId}:/sandbox/.openclaw`, "-"], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        expect(inspect.mock.calls.length).toBeGreaterThanOrEqual(3);
      } finally {
        fs.closeSync(descriptor);
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("handles archive stream errors without exposing source diagnostics", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-stopped-stream-test-"));
    const descriptor = fs.openSync(path.join(root, "archive"), "wx", 0o600);
    try {
      const capture = prepareStoppedDockerStateCapture(sandbox, runtime, projection, {
        inspect: () => inspectResult(observation()),
        spawn: () => {
          const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
            stdio: ["ignore", "pipe", "pipe"],
          });
          setImmediate(() => {
            child.stdout.destroy(new Error("PRIVATE-SOURCE-DIAGNOSTIC"));
            child.kill("SIGKILL");
          });
          return child;
        },
      });
      await expect(capture.capture(descriptor)).rejects.toThrow(
        "Could not read and filter the stopped source container.",
      );
    } finally {
      fs.closeSync(descriptor);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "running",
      (value: unknown[]) => {
        value[1] = { ...(value[1] as object), Status: "running", Running: true };
      },
    ],
    [
      "wrong sandbox",
      (value: unknown[]) => {
        value[2] = { ...(value[2] as object), "openshell.ai/sandbox-id": "someone-else" };
      },
    ],
    [
      "shared root",
      (value: unknown[]) => {
        value[5] = [{ Destination: "/sandbox" }];
      },
    ],
    [
      "shared state",
      (value: unknown[]) => {
        value[5] = [{ Destination: "/sandbox/.openclaw" }];
      },
    ],
    [
      "shared workspace",
      (value: unknown[]) => {
        value[5] = [{ Destination: "/sandbox/.openclaw/workspace" }];
      },
    ],
  ] as const)("refuses %s before reading data", (_name, change) => {
    const value = observation();
    change(value);
    const read = vi.fn();
    expect(() =>
      prepareStoppedDockerStateCapture(sandbox, runtime, projection, {
        inspect: () => inspectResult(value),
        spawn: read,
      }),
    ).toThrow("no longer the stopped registered sandbox");
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    { name: "unowned", volume: { ...volumeObservation(), Labels: {} }, users: containerId },
    {
      name: "externally backed",
      volume: { ...volumeObservation(), Options: { type: "nfs" } },
      users: containerId,
    },
    { name: "shared", volume: volumeObservation(), users: `${containerId}\n${"c".repeat(64)}` },
    { name: "unbound", volume: volumeObservation(), users: "" },
  ])("refuses a $name managed state volume before copying", ({ volume, users }) => {
    const source: unknown[] = observation();
    source[5] = [managedMount];
    const read = vi.fn();
    expect(() =>
      prepareStoppedDockerStateCapture(sandbox, runtime, projection, {
        inspect: (args) => inspectStorage(args, source, volume, users),
        spawn: read,
      }),
    ).toThrow("no longer the stopped registered sandbox");
    expect(read).not.toHaveBeenCalled();
  });

  it("accepts reordered mounts while refusing changed mount metadata", () => {
    const source: unknown[] = observation();
    const bind = {
      Type: "bind",
      Destination: "/etc/openshell",
      Source: "/owned/gateway/config",
      RW: false,
    };
    source[5] = [bind, managedMount];
    const capture = prepareStoppedDockerStateCapture(sandbox, runtime, projection, {
      inspect: (args) => inspectStorage(args, source),
    });
    source[5] = [managedMount, bind];
    expect(() => capture.assertCurrent()).not.toThrow();
    bind.Source = "/another/gateway/config";
    expect(() => capture.assertCurrent()).toThrow("changed during recovery capture");
  });

  it("rejects replacement of the owned state volume during recovery", () => {
    const source: unknown[] = observation();
    source[5] = [managedMount];
    const volume = volumeObservation();
    const capture = prepareStoppedDockerStateCapture(sandbox, runtime, projection, {
      inspect: (args) => inspectStorage(args, source, volume),
    });
    volume.CreatedAt = "2026-09-23T00:01:00Z";
    expect(() => capture.assertCurrent()).toThrow("changed during recovery capture");
  });

  it("rejects a source that was restarted and stopped again", () => {
    const value = observation();
    const inspect = vi.fn(() => inspectResult(value));
    const capture = prepareStoppedDockerStateCapture(sandbox, runtime, projection, { inspect });
    value[3] = 1;
    expect(() => capture.assertCurrent()).toThrow("changed during recovery capture");
  });
});
