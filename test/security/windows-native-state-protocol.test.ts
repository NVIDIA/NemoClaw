// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));

import {
  acquireNativeStateConfiguration,
  acquireNativeStateRemoval,
  acquireNativeStateSession,
} from "../../packaging/windows/runtime/native-state.mts";

function fixture(exitCode = 0) {
  const child = Object.assign(new EventEmitter(), {
    stdin: Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() }),
    stdout: Object.assign(new EventEmitter(), { destroy: vi.fn() }),
    stderr: Object.assign(new EventEmitter(), { destroy: vi.fn() }),
    kill: vi.fn(),
    unref: vi.fn(),
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
afterEach(() => vi.useRealTimers());

describe("native Windows state protocol", () => {
  describe.each([
    ["session", acquireNativeStateSession],
    ["configuration", acquireNativeStateConfiguration],
    ["remove", acquireNativeStateRemoval],
  ] as const)("%s owner termination", (mode, acquire) => {
    it(`${mode} acquisition reports retained ownership when termination never closes`, async () => {
      vi.useFakeTimers();
      const child = fixture();
      child.stdin.end.mockImplementation(() => {});
      child.kill.mockReturnValue(false);
      const pending = acquire("launcher.exe", "hermes");
      const rejected = expect(pending).rejects.toThrow(/receipt is invalid.*exit is unconfirmed/);
      child.stdout.emit("data", Buffer.from("{}\n"));
      await vi.advanceTimersByTimeAsync(5000);
      expect(child.kill).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(5000);
      await rejected;
      expect(child.stdin.end).toHaveBeenCalledOnce();
      expect(child.unref).toHaveBeenCalledOnce();
      expect(child.stdin.destroy).toHaveBeenCalledOnce();
      expect(child.stdout.destroy).toHaveBeenCalledOnce();
      expect(child.stderr.destroy).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each([
      { outcome: "returns false", kill: () => false },
      { outcome: "returns true", kill: () => true },
      {
        outcome: "throws",
        kill: () => {
          throw new Error("termination failed");
        },
      },
    ])("release remains failed when kill $outcome without confirmed exit", async ({ kill }) => {
      vi.useFakeTimers();
      const child = fixture();
      child.stdin.end.mockImplementation(() => {});
      child.kill.mockImplementation(kill);
      const pending = acquire("launcher.exe", "hermes");
      child.stdout.emit(
        "data",
        Buffer.from(
          JSON.stringify({
            ...receipt,
            kind: `native-state-${mode}`,
            removed: false,
          }) + "\n",
        ),
      );
      const owner = await pending;
      const released = owner.release();
      expect(owner.release()).toBe(released);
      const rejected = expect(released).rejects.toThrow(
        /exit is unconfirmed.*ownership may be retained/,
      );
      await vi.advanceTimersByTimeAsync(14999);
      expect(child.kill).not.toHaveBeenCalled();
      expect(child.unref).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(child.kill).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(5000);
      await rejected;
      expect(() => owner.assertHeld()).toThrow("exit is unconfirmed");
      await expect(owner.release()).rejects.toThrow("exit is unconfirmed");
      // A late close cannot retroactively turn failed cleanup into confirmed ACL restoration.
      child.emit("close", 0);
      await expect(owner.release()).rejects.toThrow("exit is unconfirmed");
      expect(child.stdin.end).toHaveBeenCalledOnce();
      expect(child.kill).toHaveBeenCalledOnce();
      expect(child.unref).toHaveBeenCalledOnce();
      expect(child.stdin.destroy).toHaveBeenCalledOnce();
      expect(child.stdout.destroy).toHaveBeenCalledOnce();
      expect(child.stderr.destroy).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it("waits for close after requesting termination and preserves a failed exit", async () => {
    vi.useFakeTimers();
    const child = fixture();
    child.stdin.end.mockImplementation(() => {});
    child.kill.mockReturnValue(true);
    const pending = acquireNativeStateSession("launcher.exe", "hermes");
    child.stdout.emit("data", Buffer.from(JSON.stringify(receipt) + "\n"));
    const owner = await pending;
    const released = owner.release();
    const rejected = expect(released).rejects.toThrow("restore private access");
    await vi.advanceTimersByTimeAsync(15000);
    expect(child.kill).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    child.emit("close", 2);
    await rejected;
    expect(child.unref).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["pi", "nemocua", "langchain-deepagents-code"])(
    "rejects new %s sessions and configuration before starting the owner",
    async (agent) => {
      await expect(acquireNativeStateSession("launcher.exe", agent)).rejects.toThrow(
        "supported native agent",
      );
      await expect(acquireNativeStateConfiguration("launcher.exe", agent)).rejects.toThrow(
        "supported native agent",
      );
      expect(mocks.spawn).not.toHaveBeenCalled();
    },
  );

  it.each(["openclaw", "inference"])("retains %s session ownership", async (agent) => {
    const child = fixture();
    const pending = acquireNativeStateSession("launcher.exe", agent);
    child.stdout.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          ...receipt,
          agent,
          stateRoot: receipt.stateRoot.replace(/-hermes$/u, `-${agent}`),
        }) + "\n",
      ),
    );
    const session = await pending;
    expect(mocks.spawn.mock.calls[0][1]).toEqual(["--state-session", agent]);
    session.assertHeld();
    await session.release();
  });

  it.each(["openclaw", "hermes"])("retains %s configuration ownership", async (agent) => {
    const child = fixture();
    const pending = acquireNativeStateConfiguration("launcher.exe", agent);
    child.stdout.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          ...receipt,
          kind: "native-state-configuration",
          agent,
          stateRoot: receipt.stateRoot.replace(/-hermes$/u, `-${agent}`),
        }) + "\n",
      ),
    );
    const configuration = await pending;
    expect(mocks.spawn.mock.calls[0][1]).toEqual(["--state-configure", agent]);
    configuration.assertHeld();
    await configuration.release();
  });

  it.each(["pi", "nemocua", "langchain-deepagents-code"])(
    "retains explicit removal of historical %s state",
    async (agent) => {
      const child = fixture();
      const pending = acquireNativeStateRemoval("launcher.exe", agent);
      child.stdout.emit(
        "data",
        Buffer.from(
          JSON.stringify({
            ...receipt,
            kind: "native-state-remove",
            agent,
            removed: true,
            stateRoot: receipt.stateRoot.replace(/-hermes$/u, `-${agent}`),
          }) + "\n",
        ),
      );
      const removal = await pending;
      expect(mocks.spawn.mock.calls[0][1]).toEqual(["--state-remove", agent]);
      expect(removal.removed).toBe(true);
      removal.assertHeld();
      await removal.release();
    },
  );

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
    child.stderr.emit("data", Buffer.from("Native state permissions contain unexpected grants.\n"));
    const release = session.release();
    await expect(release).rejects.toThrow("restore private access");
    await expect(release).rejects.toThrow("Native state permissions contain unexpected grants.");
  });

  it("retains the bounded sanitized final state-owner failure", async () => {
    const child = fixture(2);
    const pending = acquireNativeStateSession("launcher.exe", "hermes");
    child.stdout.emit("data", Buffer.from(JSON.stringify(receipt) + "\n"));
    const session = await pending;
    child.stderr.emit("data", Buffer.from("owner warning\n".repeat(20000)));
    child.stderr.emit(
      "data",
      Buffer.from("Native state restore failed (Windows 5); api_key=PRIVATE_STATE_CANARY\n"),
    );
    const failure = await session.release().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain("Native state restore failed (Windows 5)");
    expect(message).not.toContain("PRIVATE_STATE_CANARY");
    expect(message.length).toBeLessThan(25 * 1024);
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
