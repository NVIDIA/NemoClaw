// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
import { openNativeUiFileOwner } from "../../packaging/windows/runtime/native-ui-file-owner.mts";

function fixture(response: (line: string) => string) {
  const commands: string[] = [];
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  const close = vi.fn<(code: number) => void>().mockImplementationOnce((code) => {
    queueMicrotask(() => {
      child.stdout.end();
      child.stderr.end();
      child.emit("close", code);
    });
  });
  child.kill.mockImplementation(() => close(1));
  child.stdin.on("data", (chunk: Buffer) => {
    const line = chunk.toString("utf8").trimEnd();
    commands.push(line);
    child.stdout.write((line === "close" ? "OK" : response(line)) + "\n");
  });
  child.stdin.once("end", () => close(0));
  mocks.spawn.mockImplementationOnce(() => {
    queueMicrotask(() => child.stdout.write("READY\n"));
    return child;
  });
  return { child, commands };
}

describe("native UI file owner protocol", () => {
  it("reads only the requested relative file through the native owner", async () => {
    const { commands } = fixture((line) =>
      line === "read\tready" ? `OK\t${Buffer.from("owned-token").toString("base64")}` : "MISS",
    );
    const owner = await openNativeUiFileOwner(
      "launcher.exe",
      "C:\\NemoClawNativeUiShare-owned\\ui-relay",
    );
    expect((await owner.read("ready"))?.toString()).toBe("owned-token");
    expect(await owner.read("shutdown")).toBeNull();
    await owner.close();
    expect(commands).toEqual(["read\tready", "read\tshutdown", "close"]);
  });

  it.each([
    "../native-windows.json",
    "C:\\Users\\key",
    "stream-0123456789abcdef/open:secret",
    "stream-0123456789abcdef/../ready",
  ])("rejects an unauthorized relay path %s before native IO", async (relative) => {
    const { commands } = fixture(() => "OK");
    const owner = await openNativeUiFileOwner(
      "launcher.exe",
      "C:\\NemoClawNativeUiShare-owned\\ui-relay",
    );
    await expect(owner.read(relative)).rejects.toThrow("file name is invalid");
    expect(commands).toEqual([]);
    await owner.close();
  });

  it("rejects oversized frames before native IO", async () => {
    const { commands } = fixture(() => "OK");
    const owner = await openNativeUiFileOwner(
      "launcher.exe",
      "C:\\NemoClawNativeUiShare-owned\\ui-relay",
    );
    await expect(owner.write("ready", Buffer.alloc(1024 * 1024 + 1))).rejects.toThrow(
      "exceeds its limit",
    );
    expect(commands).toEqual([]);
    await owner.close();
  });

  it("stops the native owner after an explicit unsafe-operation refusal", async () => {
    const { child, commands } = fixture(() => "ERR\treparse");
    const owner = await openNativeUiFileOwner(
      "launcher.exe",
      "C:\\NemoClawNativeUiShare-owned\\ui-relay",
    );
    await expect(owner.read("ready")).rejects.toThrow("unsafe operation");
    await expect(owner.write("shutdown", "token")).rejects.toThrow("unsafe operation");
    await expect(owner.close()).rejects.toThrow("unsafe operation");
    expect(commands).toEqual(["read\tready"]);
    expect(child.kill).toHaveBeenCalled();
  });

  it("rejects an oversized native reply rather than forwarding it to a browser", async () => {
    const { child } = fixture(() => "OK\t" + "A".repeat(2 * 1024 * 1024));
    const owner = await openNativeUiFileOwner(
      "launcher.exe",
      "C:\\NemoClawNativeUiShare-owned\\ui-relay",
    );
    await expect(owner.read("ready")).rejects.toThrow("unsafe operation");
    await expect(owner.close()).rejects.toThrow();
    expect(child.kill).toHaveBeenCalled();
  });
});
