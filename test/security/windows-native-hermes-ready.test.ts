// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { startNativeUiTunnel } from "../../packaging/windows/runtime/native-ui-tunnel.mts";
import {
  dashboardChildEnvironment,
  openDashboardReadyFixture,
  READY_CANARY,
  stopOwnedNativeAgent,
  watchNativeStopRequest,
} from "../support/windows-native-hermes-ready-fixtures.js";

describe("native Hermes dashboard readiness", () => {
  it("disables optional file publication even when the parent supplies a path", () => {
    const parent = { HERMES_DESKTOP_READY_FILE: "outside-ready.json" };
    const environment = dashboardChildEnvironment(parent);
    expect(environment.HERMES_DESKTOP_READY_FILE).toBe("");
    expect(parent.HERMES_DESKTOP_READY_FILE).toBe("outside-ready.json");
  });

  it.each(["split", "noise"])(
    "accepts the owned child's bound port with %s output and backpressure",
    async (mode) => {
      const fixture = openDashboardReadyFixture(mode);
      try {
        const ready = await fixture.ready;
        expect(ready.processId).toBe(fixture.child.pid);
        const response = await fetch(`http://127.0.0.1:${ready.port}`, {
          signal: AbortSignal.timeout(2000),
        });
        expect(await response.json()).toEqual({ processId: fixture.child.pid });
      } finally {
        await fixture.close();
      }
      expect(fixture.child.signalCode).not.toBeNull();
      expect(fixture.stdout()).toContain("UTF-8: snowman ☃\n");
      expect(fixture.stdout()).toContain("HERMES_DASHBOARD_READY port=");
      expect(fixture.stdout()).toContain(READY_CANARY);
      expect(fixture.diagnostic()).not.toContain(READY_CANARY);
    },
  );

  it.each(["0", "65536", "123abc", "12345 extra"])(
    "rejects the invalid port announcement %s and stops its child",
    async (portText) => {
      const fixture = openDashboardReadyFixture("invalid", { portText });
      try {
        await expect(fixture.ready).rejects.toThrow("announced an invalid port");
      } finally {
        await fixture.close();
      }
      expect(fixture.child.signalCode).not.toBeNull();
    },
  );

  it("rejects an oversized readiness line without waiting for the deadline", async () => {
    const fixture = openDashboardReadyFixture("oversized");
    try {
      await expect(fixture.ready).rejects.toThrow("announcement exceeded its limit");
    } finally {
      await fixture.close();
    }
    expect(fixture.child.signalCode).not.toBeNull();
  });

  it("reports an exited child before the readiness deadline", async () => {
    const fixture = openDashboardReadyFixture("exit");
    try {
      await expect(fixture.ready).rejects.toThrow(/closed stdout|exited before/);
    } finally {
      await fixture.close();
    }
    expect(fixture.child.exitCode).toBe(3);
    expect(fixture.stderr()).toContain("owned startup failure");
  });

  it("does not accept a marker on stderr as stdout readiness", async () => {
    const fixture = openDashboardReadyFixture("stderr", { timeout: 1000 });
    try {
      await expect(fixture.ready).rejects.toThrow("did not become ready");
    } finally {
      await fixture.close();
    }
    expect(fixture.stderr()).toContain("HERMES_DASHBOARD_READY port=");
    expect(fixture.child.signalCode).not.toBeNull();
  });

  it("preserves a broker failure and stops the owned child during startup", async () => {
    const failure = new Error("owned broker failed during startup");
    const fixture = openDashboardReadyFixture("quiet", { failure: Promise.reject(failure) });
    try {
      await expect(fixture.ready).rejects.toBe(failure);
    } finally {
      await fixture.close();
    }
    expect(fixture.child.signalCode).not.toBeNull();
  });
});

describe("contained native session stop", () => {
  it.each(["fedcba9876\n", "0123456789", "0123456789\nextra"])(
    "ignores a foreign or malformed marker %j before accepting the exact session",
    async (foreign) => {
      const directory = await mkdtemp(join(tmpdir(), "native-session-stop-"));
      const file = join(directory, "shutdown");
      await writeFile(file, foreign);
      const watcher = watchNativeStopRequest(file, "0123456789", 5);
      try {
        await delay(50);
        expect(watcher.signal.aborted).toBe(false);
        const requested = expect(watcher.requested).rejects.toThrow(
          "host requested this native session",
        );
        await writeFile(file, "0123456789\n");
        await requested;
        expect(watcher.signal.aborted).toBe(true);
        expect(watcher.signal.reason).toMatchObject({ code: "ABORT_ERR" });
      } finally {
        await watcher.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.each([
    {
      name: "host marker",
      stop: (file: string, _watcher: ReturnType<typeof watchNativeStopRequest>) =>
        writeFile(file, "0123456789\n"),
      message: "The host requested this native session to stop.",
    },
    {
      name: "watcher close",
      stop: async (file: string, watcher: ReturnType<typeof watchNativeStopRequest>) => {
        await watcher.close();
        await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
      },
      message: "The native session is closing.",
    },
  ])("closes active UI sockets after $name", async ({ stop, message }) => {
    const directory = await mkdtemp(join(tmpdir(), "native-session-tunnel-stop-"));
    const clients = new Set<Socket>();
    const server = createServer((socket) => {
      clients.add(socket);
      socket.on("data", (chunk) => socket.write(chunk));
      socket.once("error", () => {});
      socket.once("close", () => clients.delete(socket));
    });
    const file = join(directory, "session-stop");
    const watcher = watchNativeStopRequest(file, "0123456789", 5);
    let tunnel: Promise<void> | undefined;
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      tunnel = startNativeUiTunnel({
        relayRoot: directory,
        relayToken: "owned-token",
        uiPort: (server.address() as AddressInfo).port,
        signal: watcher.signal,
      });
      let tunnelFailure: unknown;
      void tunnel.catch((error: unknown) => {
        tunnelFailure = error;
      });
      await vi.waitFor(async () =>
        expect(await readFile(join(directory, "ready"), "utf8")).toBe("owned-token"),
      );
      const stream = join(directory, "stream-0123456789abcdef");
      await mkdir(stream);
      await writeFile(join(stream, "host-0000000000.bin"), "owned echo");
      await writeFile(join(stream, "open"), "owned-token");
      await vi.waitFor(async () =>
        expect(await readFile(join(stream, "sandbox-0000000000.bin"), "utf8")).toBe("owned echo"),
      );
      expect(clients.size).toBe(1);
      await stop(file, watcher);
      await vi.waitFor(
        () => {
          expect(watcher.signal.aborted).toBe(true);
          expect(tunnelFailure).toBe(watcher.signal.reason);
        },
        { timeout: 2000 },
      );
      expect(watcher.signal.reason).toMatchObject({ message });
      await vi.waitFor(() => expect(clients.size).toBe(0));
    } finally {
      await writeFile(join(directory, "shutdown"), "owned-token");
      await watcher.close();
      await tunnel?.catch(() => {});
      clients.forEach((socket) => socket.destroy());
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("waits for owned pipes to close after the direct child has exited", async () => {
    const child = Object.assign(new ChildProcess(), { exitCode: 0 });
    let closeChild!: () => void;
    const childStopped = new Promise<void>((resolve) => {
      closeChild = resolve;
    });
    let settled = false;
    const stopping = stopOwnedNativeAgent(child, childStopped, 1000).then((result) => {
      settled = true;
      return result;
    });
    try {
      await delay(20);
      expect(settled).toBe(false);
    } finally {
      closeChild();
    }
    await expect(stopping).resolves.toBe(true);
  });

  it("bounds retained child pipes and preserves inherited console streams", async () => {
    const child = Object.assign(new ChildProcess(), {
      exitCode: 0,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    child.stdout.pipe(process.stdout, { end: false });
    child.stderr.pipe(process.stderr, { end: false });
    try {
      await expect(stopOwnedNativeAgent(child, new Promise(() => {}), 20)).resolves.toBe(false);
      expect(child.stdin.destroyed).toBe(true);
      expect(child.stdout.destroyed).toBe(true);
      expect(child.stderr.destroyed).toBe(true);
      expect(process.stdout.destroyed).toBe(false);
      expect(process.stderr.destroyed).toBe(false);
    } finally {
      child.stdout.unpipe(process.stdout);
      child.stderr.unpipe(process.stderr);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  });
});
