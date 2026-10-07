// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";

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
  nativeRoot: "/sandbox",
};
const captureMaxBytes = 16 * 1024 * 1024;
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

function tarHeader(name: string, type: string, size = 0): Buffer {
  const header = Buffer.alloc(512);
  const writeOctal = (start: number, length: number, value: number) =>
    header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, start, length, "ascii");
  header.write(name, 0, 100, "utf8");
  writeOctal(100, 8, 0o700);
  writeOctal(108, 8, 0);
  writeOctal(116, 8, 0);
  writeOctal(124, 12, size);
  writeOctal(136, 12, 0);
  header[156] = type.charCodeAt(0);
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.fill(0x20, 148, 156);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

function tarPayloadEntry(name: string, type: string, payload: Buffer): Buffer {
  return Buffer.concat([
    tarHeader(name, type, payload.byteLength),
    payload,
    Buffer.alloc(Math.ceil(payload.byteLength / 512) * 512 - payload.byteLength),
  ]);
}

function dockerCopyStream(payload: Buffer) {
  return spawn(
    process.execPath,
    [
      "-e",
      "process.stdout.write(Buffer.from(process.argv[1], 'base64'))",
      payload.toString("base64"),
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

describe("stopped Docker recovery capture", () => {
  it("rejects a non-canonical native root before runtime access", () => {
    const inspect = vi.fn();
    expect(() =>
      prepareStoppedDockerStateCapture(
        sandbox,
        runtime,
        { ...projection, nativeRoot: "/sandbox/../etc" },
        { inspect },
      ),
    ).toThrow("complete canonical native root");
    expect(inspect).not.toHaveBeenCalled();
  });

  it("captures the complete stopped Deep Agents native root (#11165, #11767)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-stopped-dcode-test-"));
    const archive = path.join(root, "archive");
    const nativeRoot = path.join(root, "sandbox");
    const source = path.join(nativeRoot, ".deepagents");
    fs.mkdirSync(path.join(source, ".state"), { recursive: true });
    fs.mkdirSync(path.join(source, "agent", "skills"), { recursive: true });
    fs.writeFileSync(path.join(source, ".state", "retained.txt"), "conversation state");
    fs.writeFileSync(path.join(source, "agent", "skills", "retained.md"), "user skill");
    fs.writeFileSync(path.join(source, "agent", "private.txt"), "UNDECLARED-AGENT-DATA");
    fs.writeFileSync(path.join(source, "config.toml"), "[ui]\nshow_scrollbar = true\n");
    fs.writeFileSync(path.join(source, ".mcp.json"), '{"mcpServers":{}}');
    fs.writeFileSync(path.join(source, ".env"), "PRIVATE-CREDENTIAL-CANARY");
    fs.mkdirSync(path.join(nativeRoot, "custom-package"));
    fs.writeFileSync(path.join(nativeRoot, "custom-package", "retained.txt"), "native state");
    const descriptor = fs.openSync(archive, "wx+", 0o600);
    const read = vi.fn(() =>
      spawn("tar", ["-cf", "-", "-C", root, "sandbox"], {
        env: { ...process.env, COPYFILE_DISABLE: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    try {
      const capture = prepareStoppedDockerStateCapture(
        { ...sandbox, agent: "langchain-deepagents-code" },
        runtime,
        projection,
        { inspect: () => inspectResult(observation()), spawn: read },
      );
      await capture.capture(descriptor, 2 * 1024 * 1024 * 1024);
      const names = execFileSync("tar", ["-tf", archive], { encoding: "utf8" });
      expect(names).toContain(".deepagents/.state/retained.txt");
      expect(names).toContain(".deepagents/agent/skills/retained.md");
      expect(names).toContain(".deepagents/agent/private.txt");
      expect(names).toContain(".deepagents/config.toml");
      expect(names).toContain(".deepagents/.mcp.json");
      expect(names).toContain(".deepagents/.env");
      expect(names).toContain("custom-package/retained.txt");
      expect(
        execFileSync("tar", ["-xOf", archive, ".deepagents/.state/retained.txt"], {
          encoding: "utf8",
        }),
      ).toBe("conversation state");
      expect(read).toHaveBeenCalledWith(["cp", `${containerId}:/sandbox`, "-"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } finally {
      fs.closeSync(descriptor);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([false, true])(
    "captures immutable stopped state with managed volume=%s",
    async (mounted) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-stopped-capture-test-"));
      const archive = path.join(root, "archive");
      fs.mkdirSync(path.join(root, "sandbox", ".openclaw", "workspace"), {
        recursive: true,
      });
      fs.mkdirSync(path.join(root, "sandbox", "custom-package"));
      fs.writeFileSync(
        path.join(root, "sandbox", ".openclaw", "workspace", "retained.txt"),
        "captured bytes",
      );
      fs.writeFileSync(
        path.join(root, "sandbox", "custom-package", "unregistered.txt"),
        "complete native state",
      );
      const longRelativePath = `${"long-segment-".repeat(10)}/${"nested-segment-".repeat(10)}/retained.txt`;
      fs.mkdirSync(path.dirname(path.join(root, "sandbox", longRelativePath)), { recursive: true });
      fs.writeFileSync(path.join(root, "sandbox", longRelativePath), "long path state");
      fs.linkSync(
        path.join(root, "sandbox", "custom-package", "unregistered.txt"),
        path.join(root, "sandbox", "custom-package", "hardlinked.txt"),
      );
      fs.symlinkSync("/usr/bin/python3", path.join(root, "sandbox", "python"));
      const descriptor = fs.openSync(archive, "wx+", 0o600);
      const source: unknown[] = observation();
      source[5] = mounted ? [managedMount] : [];
      const inspect = vi.fn((args: readonly string[]) => inspectStorage(args, source));
      const read = vi.fn(() =>
        spawn("tar", ["-cf", "-", "-C", root, "sandbox"], {
          env: { ...process.env, COPYFILE_DISABLE: "1" },
          stdio: ["ignore", "pipe", "pipe"],
        }),
      );
      try {
        await prepareStoppedDockerStateCapture(sandbox, runtime, projection, {
          inspect,
          spawn: read,
        }).capture(descriptor, captureMaxBytes);
        expect(
          execFileSync("tar", ["-xOf", archive, ".openclaw/workspace/retained.txt"], {
            encoding: "utf8",
          }),
        ).toBe("captured bytes");
        const extracted = path.join(root, "extracted");
        fs.mkdirSync(extracted);
        execFileSync("tar", ["-xf", archive, "-C", extracted]);
        expect(fs.readlinkSync(path.join(extracted, "python"))).toBe("/usr/bin/python3");
        expect(
          fs.readFileSync(path.join(extracted, "custom-package", "unregistered.txt"), "utf8"),
        ).toBe("complete native state");
        expect(
          fs.readFileSync(path.join(extracted, "custom-package", "hardlinked.txt"), "utf8"),
        ).toBe("complete native state");
        expect(fs.readFileSync(path.join(extracted, longRelativePath), "utf8")).toBe(
          "long path state",
        );
        expect(fs.statSync(path.join(extracted, "custom-package", "hardlinked.txt")).nlink).toBe(2);
        expect(read).toHaveBeenCalledWith(["cp", `${containerId}:/sandbox`, "-"], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        expect(inspect.mock.calls.length).toBeGreaterThanOrEqual(3);
      } finally {
        fs.closeSync(descriptor);
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("does not execute a substituted host interpreter from PATH", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-stopped-path-test-"));
    const archive = path.join(root, "archive");
    const marker = path.join(root, "substituted-interpreter-ran");
    const bin = path.join(root, "bin");
    const tar = execFileSync("which", ["tar"], { encoding: "utf8" }).trim();
    const oldPath = process.env.PATH;
    fs.mkdirSync(path.join(root, "sandbox", "workspace"), { recursive: true });
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(root, "sandbox", "workspace", "retained.txt"), "retained");
    fs.writeFileSync(path.join(bin, "python3"), `#!/bin/sh\ntouch '${marker}'\n`);
    fs.chmodSync(path.join(bin, "python3"), 0o755);
    const descriptor = fs.openSync(archive, "wx+", 0o600);
    process.env.PATH = bin;
    try {
      await prepareStoppedDockerStateCapture(sandbox, runtime, projection, {
        inspect: () => inspectResult(observation()),
        spawn: () =>
          spawn(tar, ["-cf", "-", "-C", root, "sandbox"], {
            env: { ...process.env, COPYFILE_DISABLE: "1" },
            stdio: ["ignore", "pipe", "pipe"],
          }),
      }).capture(descriptor, captureMaxBytes);
      expect(fs.existsSync(marker)).toBe(false);
      expect(
        execFileSync(tar, ["-xOf", archive, "workspace/retained.txt"], {
          encoding: "utf8",
        }),
      ).toBe("retained");
    } finally {
      process.env.PATH = oldPath;
      fs.closeSync(descriptor);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

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
      await expect(capture.capture(descriptor, captureMaxBytes)).rejects.toThrow(
        "Could not read and filter the stopped source container.",
      );
    } finally {
      fs.closeSync(descriptor);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("times out a pending archive write, kills the copy process, and publishes no bytes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-stopped-write-timeout-"));
    const archive = path.join(root, "archive");
    const descriptor = fs.openSync(archive, "wx+", 0o600);
    const payload = Buffer.concat([tarHeader("sandbox", "5"), Buffer.alloc(1024)]);
    let child: ReturnType<typeof spawn> | undefined;
    const writer = new Writable({
      write(_chunk, _encoding, _callback) {
        // Intentionally retain the callback past the capture deadline.
      },
    });
    try {
      const capture = prepareStoppedDockerStateCapture(sandbox, runtime, projection, {
        inspect: () => inspectResult(observation()),
        spawn: () => {
          child = spawn(
            process.execPath,
            [
              "-e",
              "process.stdout.write(Buffer.from(process.argv[1], 'base64')); setInterval(() => {}, 1000)",
              payload.toString("base64"),
            ],
            { stdio: ["ignore", "pipe", "pipe"] },
          );
          return child;
        },
        createArchiveWriteStream: () => writer,
        captureTimeoutMs: 25,
      });

      await expect(capture.capture(descriptor, captureMaxBytes)).rejects.toThrow(
        "Stopped state capture timed out.",
      );
      expect(child?.killed).toBe(true);
      expect(fs.fstatSync(descriptor).size).toBe(0);
    } finally {
      child?.kill("SIGKILL");
      fs.closeSync(descriptor);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "path escape",
      Buffer.concat([
        tarHeader("sandbox", "5"),
        tarHeader("sandbox/../outside", "0"),
        Buffer.alloc(1024),
      ]),
    ],
    [
      "GNU sparse PAX metadata",
      (() => {
        const body = "GNU.sparse.map=0,1\n";
        let length = Buffer.byteLength(body) + 2;
        let record = Buffer.from(`${length} ${body}`);
        while (record.byteLength !== length) {
          length = record.byteLength;
          record = Buffer.from(`${length} ${body}`);
        }
        return Buffer.concat([
          tarHeader("sandbox", "5"),
          tarPayloadEntry("sandbox/PaxHeaders/entry", "x", record),
          tarHeader("sandbox/entry", "0"),
          Buffer.alloc(1024),
        ]);
      })(),
    ],
    ["only one TAR end block", Buffer.concat([tarHeader("sandbox", "5"), Buffer.alloc(512)])],
  ])("rejects a forged Docker copy stream with %s", async (_name, forgedArchive) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-stopped-forged-test-"));
    const archive = path.join(root, "archive");
    const descriptor = fs.openSync(archive, "wx+", 0o600);
    const read = vi.fn(() => dockerCopyStream(forgedArchive));
    try {
      const capture = prepareStoppedDockerStateCapture(sandbox, runtime, projection, {
        inspect: () => inspectResult(observation()),
        spawn: read,
      });
      await expect(capture.capture(descriptor, captureMaxBytes)).rejects.toThrow(
        "Stopped state archive projection failed.",
      );
      expect(read).toHaveBeenCalledWith(["cp", `${containerId}:/sandbox`, "-"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } finally {
      fs.closeSync(descriptor);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "running",
      (value: unknown[]) => {
        value[1] = {
          ...(value[1] as object),
          Status: "running",
          Running: true,
        };
      },
    ],
    [
      "wrong sandbox",
      (value: unknown[]) => {
        value[2] = {
          ...(value[2] as object),
          "openshell.ai/sandbox-id": "someone-else",
        };
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
    {
      name: "unowned",
      volume: { ...volumeObservation(), Labels: {} },
      users: containerId,
    },
    {
      name: "externally backed",
      volume: { ...volumeObservation(), Options: { type: "nfs" } },
      users: containerId,
    },
    {
      name: "shared",
      volume: volumeObservation(),
      users: `${containerId}\n${"c".repeat(64)}`,
    },
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
