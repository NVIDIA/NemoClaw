// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));

import {
  acquireNativeStateRemoval,
  acquireNativeStateSession,
} from "../../packaging/windows/runtime/native-state.mts";

function fixture(exitCode = 0) {
  const child = Object.assign(new EventEmitter(), {
    stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
    stdout: new EventEmitter(),
    stderr: { resume: vi.fn() },
    kill: vi.fn(),
  });
  child.stdin.end.mockImplementation(() => queueMicrotask(() => child.emit("close", exitCode)));
  mocks.spawn.mockReturnValue(child);
  return child;
}
const receipt = {
  schemaVersion: 1,
  kind: "native-state-session",
  agent: "hermes",
  stateRoot: "C:\\NemoClawState-S-1-5-21-123-456-789-1001-hermes",
  created: false,
  leaseHeld: true,
};
beforeEach(() => mocks.spawn.mockReset());

describe("native Windows state protocol", () => {
  it("holds removal ownership during metadata cleanup without creating absent agent data", async () => {
    const child = fixture();
    const pending = acquireNativeStateRemoval("launcher.exe", "hermes");
    const { created: _created, ...identity } = receipt;
    child.stdout.emit(
      "data",
      Buffer.from(
        JSON.stringify({ ...identity, kind: "native-state-remove", removed: false }) + "\n",
      ),
    );
    const removal = await pending;
    expect(mocks.spawn.mock.calls[0][1]).toEqual(["--state-remove", "hermes"]);
    expect(removal.removed).toBe(false);
    expect(child.stdin.end).not.toHaveBeenCalled();
    removal.assertHeld();
    await removal.release();
    await expect(acquireNativeStateRemoval("launcher.exe", "inference")).rejects.toThrow(
      "shared inference state",
    );
  });
  it("keeps the native owner alive until MXC cleanup releases its pipe", async () => {
    const child = fixture();
    const pending = acquireNativeStateSession("launcher.exe", "hermes");
    child.stdout.emit("data", Buffer.from(JSON.stringify(receipt) + "\n"));
    const session = await pending;
    expect(session.stateRoot).toBe(receipt.stateRoot);
    expect(child.stdin.end).not.toHaveBeenCalled();
    session.assertHeld();
    await session.release();
    expect(child.stdin.end).toHaveBeenCalledOnce();
    expect(() => session.assertHeld()).toThrow();
  });

  it.each([
    {
      name: "profile path",
      changed: { stateRoot: "C:\\Users\\test\\hermes" },
      error: "receipt is invalid",
    },
    {
      name: "another agent",
      changed: { stateRoot: receipt.stateRoot.replace(/-hermes$/u, "-pi") },
      error: "receipt is invalid",
    },
    { name: "unheld lease", changed: { leaseHeld: false }, error: "receipt is invalid" },
    {
      name: "oversize receipt",
      changed: { padding: "x".repeat(4096) },
      error: "receipt exceeds its limit",
    },
  ])("rejects $name and closes its owner", async ({ changed, error }) => {
    const child = fixture();
    const pending = acquireNativeStateSession("launcher.exe", "hermes");
    const rejected = expect(pending).rejects.toThrow(error);
    child.stdout.emit("data", Buffer.from(JSON.stringify({ ...receipt, ...changed }) + "\n"));
    await rejected;
    expect(child.stdin.end).toHaveBeenCalledOnce();
  });

  it("treats failed ACL restoration as failed cleanup", async () => {
    const child = fixture(2);
    const pending = acquireNativeStateSession("launcher.exe", "hermes");
    child.stdout.emit("data", Buffer.from(JSON.stringify(receipt) + "\n"));
    const session = await pending;
    await expect(session.release()).rejects.toThrow("restore private access");
  });

  it("refuses to keep using state after its owner exits unexpectedly", async () => {
    const child = fixture();
    const pending = acquireNativeStateSession("launcher.exe", "hermes");
    child.stdout.emit("data", Buffer.from(JSON.stringify(receipt) + "\n"));
    const session = await pending;
    child.emit("close", 0);
    expect(() => session.assertHeld()).toThrow("stopped unexpectedly");
    await expect(session.release()).rejects.toThrow("stopped unexpectedly");
  });
});
