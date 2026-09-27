// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, execFileSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HostCliClient } from "../fixtures/clients/host.ts";
import { RuntimeProviderPrerequisite } from "../fixtures/runtime-provider.ts";
import {
  ROUTED_PRIVATE_RELAY_SOURCE,
  ROUTED_PRIVATE_RELAY_SNAPSHOT_SOURCE,
  startRoutedPrivateRelay,
} from "../fixtures/routed-private-relay.ts";

const dirs: string[] = [];
function summaryFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-diagnostics-"));
  dirs.push(dir);
  return path.join(dir, "summary.json");
}
function snapshot(file: string) {
  return JSON.parse(
    execFileSync(process.execPath, ["-e", ROUTED_PRIVATE_RELAY_SNAPSHOT_SOURCE, file], {
      encoding: "utf8",
      timeout: 10_000,
      killSignal: "SIGKILL",
    }),
  );
}
afterEach(() => {
  vi.restoreAllMocks();
  dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});

const validSummary = {
  listening: 1,
  incoming: 2,
  upstreamConnected: 1,
  clientErrors: 0,
  upstreamErrors: 3,
  serverErrors: 0,
  errors: {
    ECONNREFUSED: 3,
    ECONNRESET: 0,
    ETIMEDOUT: 0,
    EHOSTUNREACH: 0,
    ENETUNREACH: 0,
    EPIPE: 0,
    EACCES: 0,
    EADDRINUSE: 0,
    OTHER: 65535,
  },
};
it("retains only fixed bounded counters and known codes from a hostile summary", () => {
  const file = summaryFile();
  fs.writeFileSync(
    file,
    JSON.stringify({
      ...validSummary,
      url: "https://secret.invalid/?token=secret",
      errors: { ...validSummary.errors, secret: 9 },
    }),
  );
  expect(snapshot(file)).toEqual({ available: true, ...validSummary });
});
it.each([65536, -1, 1.5, "secret", null])(
  "rejects invalid counter %j instead of reporting false zero evidence",
  (value) => {
    const file = summaryFile();
    fs.writeFileSync(file, JSON.stringify({ ...validSummary, incoming: value }));
    expect(snapshot(file)).toEqual({ available: false });
  },
);
it.each(["missing", "oversized", "malformed", "symlink", "directory", "fifo"])(
  "reports %s summary unavailable without leaking contents",
  (kind) => {
    const file = summaryFile();
    const setup: Record<string, () => void> = {
      missing: () => undefined,
      directory: () => fs.mkdirSync(file),
      fifo: () => {
        execFileSync("mkfifo", [file], { timeout: 10_000, killSignal: "SIGKILL" });
      },
      oversized: () => fs.writeFileSync(file, "secret".repeat(1000)),
      malformed: () => fs.writeFileSync(file, "secret"),
      symlink: () => {
        fs.writeFileSync(file + ".target", "secret");
        fs.symlinkSync(file + ".target", file);
      },
    };
    setup[kind]!();
    expect(snapshot(file)).toEqual({ available: false });
  },
);
it("bounds the read even when the regular file grows after fstat", () => {
  const read = vi.fn((_fd: number, buffer: Buffer, offset: number, length: number) => {
    buffer.fill("s", offset, offset + length);
    return length;
  });
  const close = vi.fn();
  const write = vi.fn();
  vm.runInNewContext(ROUTED_PRIVATE_RELAY_SNAPSHOT_SOURCE, {
    Buffer,
    require: () => ({
      constants: fs.constants,
      openSync: () => 42,
      fstatSync: () => ({ size: 1, isFile: () => true }),
      readSync: read,
      closeSync: close,
    }),
    process: { argv: ["node", "summary"], stdout: { write } },
  });
  expect(read).toHaveBeenCalledWith(42, expect.any(Buffer), 0, 4097, 0);
  expect(close).toHaveBeenCalledWith(42);
  expect(write).toHaveBeenCalledExactlyOnceWith('{"available":false}\n');
});
it("saturates counters and maps arbitrary error strings to OTHER without retaining messages", () => {
  const file = summaryFile();
  const server = new EventEmitter();
  Object.assign(server, { listen: (_port: number, _host: string, ready: () => void) => ready() });
  const context = vm.createContext({
    require: (name: string) =>
      ({ "node:fs": fs, "node:net": { createServer: () => server } })[name],
    process: { argv: ["node", "localhost", "1", "0", file] },
  });
  vm.runInContext(ROUTED_PRIVATE_RELAY_SOURCE, context);
  vm.runInContext("summary.serverErrors = 65535; summary.errors.OTHER = 65535", context);
  // Exercise the saturation boundary directly without a large event flood.
  const write = vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);
  const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => undefined);
  server.emit("error", { code: "token=secret", message: "Bearer secret" });
  const last = String(write.mock.calls.at(-1)?.[1]);
  expect(JSON.parse(last)).toMatchObject({ serverErrors: 65535, errors: { OTHER: 65535 } });
  expect(last).not.toContain("secret");
  rename.mockRestore();
  write.mockRestore();
});

it.each([true, false])(
  "local relay captures upstream connected=%s without recording forwarded bytes",
  async (connected) => {
    const file = summaryFile();
    const upstream = net.createServer((socket) => socket.end("secret-payload"));
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as net.AddressInfo).port;
    await {
      true: async () => undefined,
      false: () => new Promise<void>((resolve) => upstream.close(() => resolve())),
    }[String(connected)]!();
    const reserve = net.createServer();
    reserve.listen(0, "127.0.0.1");
    await once(reserve, "listening");
    const port = (reserve.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => reserve.close(() => resolve()));
    const child = spawn(
      process.execPath,
      ["-e", ROUTED_PRIVATE_RELAY_SOURCE, "127.0.0.1", String(upstreamPort), String(port), file],
      { stdio: "ignore" },
    );
    const exited = once(child, "exit");
    try {
      await vi.waitFor(() => expect(snapshot(file).listening).toBe(1), {
        timeout: 10_000,
        interval: 100,
      });
      const client = net.connect({ host: "127.0.0.1", port });
      client.on("error", () => undefined);
      client.resume();
      await once(client, "close");
      await vi.waitFor(
        () =>
          expect(snapshot(file)).toMatchObject(
            connected
              ? { incoming: 1, upstreamConnected: 1, upstreamErrors: 0 }
              : {
                  incoming: 1,
                  upstreamConnected: 0,
                  upstreamErrors: 1,
                  errors: { ECONNREFUSED: 1 },
                },
          ),
        { timeout: 10_000, interval: 100 },
      );
      expect(fs.readFileSync(file, "utf8")).not.toContain("secret-payload");
    } finally {
      child.kill("SIGTERM");
      await exited;
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  },
);

function runtimeFixture(
  options: {
    startNonzero?: boolean;
    snapshotThrows?: boolean;
    snapshotNonzero?: boolean;
    inspectThrows?: boolean;
    removalNonzero?: boolean;
  } = {},
) {
  vi.spyOn(RuntimeProviderPrerequisite.prototype, "resolveSandboxResourceHandle").mockResolvedValue(
    "sandbox-id",
  );
  const command = vi
    .spyOn(RuntimeProviderPrerequisite.prototype, "command")
    .mockImplementation(async (args) => {
      const key = args.slice(0, 2).join(" ");
      const failure = {
        "container cp": options.snapshotThrows ? "diagnostic unavailable" : "",
        "container inspect":
          options.inspectThrows && args.at(-1) !== "sandbox-id" ? "inspect failed" : "",
      }[key];
      await (failure ? Promise.reject(new Error(failure)) : Promise.resolve());
      const copySummary = options.snapshotNonzero
        ? () => undefined
        : () =>
            fs.writeFileSync(
              args.at(-1)!,
              JSON.stringify({ ...validSummary, token: "secret-not-for-artifacts" }),
            );
      const effects: Record<string, () => void> = { "container cp": copySummary };
      effects[key]?.();
      const stdout = args.at(-1) === "sandbox-id" ? '{"owned-network":{}}' : "172.18.0.3";
      return {
        command: [],
        exitCode:
          (args[0] === "run" && options.startNonzero) ||
          (key === "container cp" && options.snapshotNonzero) ||
          (key === "container rm" && options.removalNonzero)
            ? 1
            : 0,
        signal: null,
        timedOut: false,
        stdout,
        stderr: "",
        artifacts: { stdout: "", stderr: "", result: "" },
      };
    });
  const hostCommand = vi.fn(
    async (command: string, args: string[], options?: { timeoutMs?: number }) => ({
      command: [],
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: execFileSync(command, args, {
        encoding: "utf8",
        timeout: options?.timeoutMs ?? 10_000,
        killSignal: "SIGKILL",
      }),
      stderr: "",
      artifacts: { stdout: "", stderr: "", result: "" },
    }),
  );
  return {
    command,
    hostCommand,
    start: () =>
      startRoutedPrivateRelay({
        host: { command: hostCommand } as unknown as HostCliClient,
        sandboxName: "sandbox",
        upstreamHost: "127.0.0.1",
        upstreamPort: 1234,
      }),
  };
}
describe("relay diagnostic cleanup ownership", () => {
  it.each([{ snapshotThrows: true }, { snapshotNonzero: true }, {}])(
    "always removes the exact relay after snapshot outcome %j",
    async (options) => {
      const f = runtimeFixture(options);
      const relay = await f.start();
      await relay.close();
      const calls = f.command.mock.calls;
      expect(calls.at(-2)?.[0].slice(0, 2)).toEqual(["container", "cp"]);
      expect(calls.at(-1)?.[0].slice(0, 3)).toEqual(["container", "rm", "--force"]);
      expect(calls.at(-2)?.[0][2]).toBe(
        `${calls.at(-1)?.[0][3]}:/tmp/nemoclaw-private-relay-summary.json`,
      );
    },
  );
  it("retains relay cleanup ownership when the diagnostic copy fails", async () => {
    const f = runtimeFixture({ snapshotNonzero: true });
    const relay = await f.start();
    const startArgs = f.command.mock.calls.find(([args]) => args[0] === "run")![0];
    expect(startArgs).not.toContain("--rm");
    expect(startArgs).toContain(
      "node:22-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9",
    );
    await relay.close();
    expect(f.command.mock.calls.at(-1)?.[0]).toEqual([
      "container",
      "rm",
      "--force",
      startArgs[startArgs.indexOf("--name") + 1],
    ]);
  });
  it.each([0, 1])("sanitizes snapshot %s and removes its private temporary copy", async (index) => {
    const f = runtimeFixture();
    const relay = await f.start();
    await relay.close();
    expect(f.hostCommand).toHaveBeenCalledTimes(2);
    const result = await f.hostCommand.mock.results[index]!.value;
    expect(JSON.parse(result.stdout)).toEqual({ available: true, ...validSummary });
    expect(result.stdout).not.toContain("secret-not-for-artifacts");
    const copies = f.command.mock.calls.filter(([args]) => args[1] === "cp");
    expect(copies).toHaveLength(2);
    const args = copies[index]![0];
    expect(args).not.toContain("-L");
    expect(fs.existsSync(path.dirname(args.at(-1)!))).toBe(false);
  });
  it("preserves relay operation and removal when private temporary storage is unavailable", async () => {
    const unavailable = path.join(path.dirname(summaryFile()), "absent");
    vi.spyOn(os, "tmpdir").mockReturnValue(unavailable);
    const f = runtimeFixture();
    const relay = await f.start();
    await relay.close();
    expect(f.hostCommand).not.toHaveBeenCalled();
    expect(f.command.mock.calls.filter(([args]) => args[1] === "cp")).toEqual([]);
    expect(f.command.mock.calls.at(-1)?.[0].slice(0, 3)).toEqual(["container", "rm", "--force"]);
  });
  it("removes the private copy and relay when the host schema reader throws", async () => {
    const f = runtimeFixture();
    const relay = await f.start();
    f.hostCommand.mockRejectedValueOnce(new Error("reader unavailable"));
    await relay.close();
    const copy = f.command.mock.calls.filter(([args]) => args[1] === "cp").at(-1)![0];
    expect(fs.existsSync(path.dirname(copy.at(-1)!))).toBe(false);
    expect(f.command.mock.calls.at(-1)?.[0].slice(0, 3)).toEqual(["container", "rm", "--force"]);
  });
  it("removes the private copy even when owned relay removal fails", async () => {
    const f = runtimeFixture({ removalNonzero: true });
    const relay = await f.start();
    await expect(relay.close()).rejects.toThrow("remove owned routed-private relay");
    const copy = f.command.mock.calls.filter(([args]) => args[1] === "cp").at(-1)![0];
    expect(fs.existsSync(path.dirname(copy.at(-1)!))).toBe(false);
  });
  it("removes an owned relay after the runtime creates it but fails to start it", async () => {
    const f = runtimeFixture({ startNonzero: true, snapshotNonzero: true });
    await expect(f.start()).rejects.toThrow();
    const startArgs = f.command.mock.calls.find(([args]) => args[0] === "run")![0];
    expect(f.command.mock.calls.at(-1)?.[0]).toEqual([
      "container",
      "rm",
      "--force",
      startArgs[startArgs.indexOf("--name") + 1],
    ]);
  });
  it("cleans up after post-start inspection fails and preserves that failure", async () => {
    const f = runtimeFixture({ inspectThrows: true, snapshotThrows: true });
    await expect(f.start()).rejects.toThrow("inspect failed");
    expect(f.command.mock.calls.at(-1)?.[0].slice(0, 3)).toEqual(["container", "rm", "--force"]);
  });
  it("reports removal nonzero even when diagnostics also fail", async () => {
    const f = runtimeFixture({ snapshotThrows: true, removalNonzero: true });
    const relay = await f.start();
    await expect(relay.close()).rejects.toThrow("remove owned routed-private relay");
  });
  it("preserves startup and cleanup failures together", async () => {
    const f = runtimeFixture({ inspectThrows: true, removalNonzero: true });
    const error = await f.start().catch((error) => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toHaveLength(2);
    expect(error.errors[0].message).toBe("inspect failed");
    expect(error.errors[1].message).toContain("remove owned routed-private relay");
  });
});

it("bounds the real snapshot-reader adapter by its supplied timeout", async () => {
  const f = runtimeFixture();
  await expect(
    f.hostCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 25 }),
  ).rejects.toMatchObject({ code: "ETIMEDOUT", signal: "SIGKILL" });
});
