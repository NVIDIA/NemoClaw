// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { fingerprintOpenShellSandboxId } from "../../domain/sandbox/openshell-identity";
import { prepareStoppedDockerStateCapture } from "./docker-stopped-state-capture";

const projection = {
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

describe("stopped Docker recovery capture", () => {
  it("copies only the immutable stopped source and never starts or executes a container", async () => {
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
    const inspect = vi.fn(() => inspectResult(observation()));
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
      expect(execFileSync("tar", ["-tf", archive], { encoding: "utf8" })).not.toContain("identity");
      expect(read).toHaveBeenCalledWith(["cp", `${containerId}:/sandbox/.openclaw`, "-"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      expect(inspect.mock.calls.length).toBeGreaterThanOrEqual(3);
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

  it("rejects a source that was restarted and stopped again", () => {
    const value = observation();
    const inspect = vi.fn(() => inspectResult(value));
    const capture = prepareStoppedDockerStateCapture(sandbox, runtime, projection, { inspect });
    value[3] = 1;
    expect(() => capture.assertCurrent()).toThrow("changed during recovery capture");
  });
});
