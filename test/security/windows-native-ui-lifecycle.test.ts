// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, mkdir, rm, writeFile, chmod, readFile, access } from "node:fs/promises";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  attemptNativeUiCleanup,
  watchNativeUiSandbox,
} from "../../packaging/windows/runtime/native-ui-lifecycle.mts";
import {
  readNativeUiTunnelMarker,
  startNativeUiTunnel,
} from "../../packaging/windows/runtime/native-ui-tunnel.mts";

describe("contained native UI relay failures", () => {
  it.each([0, 4096])(
    "reads a regular %i-byte marker through its opened descriptor",
    async (size) => {
      const directory = await mkdtemp(path.join(tmpdir(), "native-ui-marker-"));
      const file = path.join(directory, "marker");
      try {
        expect(readNativeUiTunnelMarker(file)).toBeNull();
        const content = "x".repeat(size);
        await writeFile(file, content);
        expect(readNativeUiTunnelMarker(file)).toBe(content);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.each([
    { name: "directory", create: (file: string) => mkdir(file) },
    { name: "oversized file", create: (file: string) => writeFile(file, "x".repeat(4097)) },
  ])("rejects a $name before accepting its marker", async ({ create }) => {
    const directory = await mkdtemp(path.join(tmpdir(), "native-ui-marker-"));
    const file = path.join(directory, "marker");
    try {
      await create(file);
      expect(() => readNativeUiTunnelMarker(file)).toThrow(
        "opened native UI relay marker is invalid",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "invalid shutdown marker during polling",
      trigger: async (directory: string) => {
        await mkdir(path.join(directory, "shutdown"));
      },
      error: /opened native UI relay marker is invalid/u,
    },
    {
      name: "exclusive frame collision during socket data",
      trigger: async (directory: string) => {
        const stream = path.join(directory, "stream-0123456789abcdef");
        await mkdir(stream);
        await writeFile(path.join(stream, "sandbox-0000000000.bin"), "collision");
        await writeFile(path.join(stream, "host-0000000000.bin"), "echo");
        await writeFile(path.join(stream, "open"), "owned-token");
      },
      error: /EEXIST/u,
    },
  ])("rejects and closes sockets after $name", async ({ trigger, error }) => {
    const directory = await mkdtemp(path.join(tmpdir(), "native-ui-tunnel-"));
    const clients = new Set<Socket>();
    const server = createServer((socket) => {
      clients.add(socket);
      socket.on("data", (data) => socket.write(data));
      socket.once("error", () => {});
      socket.once("close", () => clients.delete(socket));
    });
    let tunnel: Promise<void> | undefined;
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      tunnel = startNativeUiTunnel({
        relayRoot: directory,
        relayToken: "owned-token",
        uiPort: (server.address() as AddressInfo).port,
      });
      const rejection = expect(tunnel).rejects.toThrow(error);
      await vi.waitFor(async () =>
        expect(await readFile(path.join(directory, "ready"), "utf8")).toBe("owned-token"),
      );
      await trigger(directory);
      await rejection;
      await vi.waitFor(() => expect(clients.size).toBe(0));
    } finally {
      await writeFile(path.join(directory, "shutdown"), "owned-token").catch(() => {});
      await tunnel?.catch(() => {});
      clients.forEach((socket) => socket.destroy());
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("native OpenClaw session lifecycle", () => {
  it("closes an owned listener, file, and state lease after earlier cleanup failures", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "native-ui-cleanup-"));
    const file = path.join(directory, "owned-state");
    const server = createServer();
    let leaseReleased = false;
    try {
      await writeFile(file, "owned");
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const failures = await attemptNativeUiCleanup([
        [
          "UI file owner",
          async () => {
            throw new Error("injected file-owner disposal failure");
          },
        ],
        [
          "owned files",
          async () => {
            await rm(file);
          },
        ],
        [
          "gateway logs",
          async () => {
            throw new Error("injected descriptor failure");
          },
        ],
        [
          "inference listener",
          async () => {
            await new Promise<void>((resolve) => server.close(() => resolve()));
          },
        ],
        [
          "state lease",
          async () => {
            leaseReleased = true;
          },
        ],
      ]);
      expect(failures).toEqual(["UI file owner", "gateway logs"]);
      await expect(access(file)).rejects.toThrow();
      expect(server.listening).toBe(false);
      expect(leaseReleased).toBe(true);
    } finally {
      server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a stopped gateway and a lost state lease before querying a sandbox", async () => {
    const signal = new AbortController().signal;
    await expect(
      watchNativeUiSandbox(
        "unreachable",
        {},
        "owned",
        { exitCode: 1, signalCode: null },
        null,
        signal,
      ),
    ).rejects.toThrow("gateway stopped");
    await expect(
      watchNativeUiSandbox(
        "unreachable",
        {},
        "owned",
        { exitCode: null, signalCode: null },
        {
          assertHeld() {
            throw new Error("lease closed");
          },
        },
        signal,
      ),
    ).rejects.toThrow("lease closed");
  });

  it.skipIf(process.platform === "win32")(
    "observes an actual status subprocess changing from Ready to Error without exposing its output",
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "native-ui-status-"));
      const status = path.join(directory, "status.json");
      const observed = path.join(directory, "observed");
      const script = path.join(directory, "status.mjs");
      const executable = path.join(directory, "openshell-fixture");
      const controller = new AbortController();
      let monitoring: Promise<unknown> | undefined;
      try {
        await writeFile(status, JSON.stringify({ name: "owned", phase: "Ready" }));
        await writeFile(
          script,
          `import fs from 'node:fs'; if (JSON.stringify(process.argv.slice(2)) !== '["sandbox","get","owned","-o","json"]') process.exit(2); fs.writeFileSync(${JSON.stringify(observed)}, 'queried'); process.stdout.write(fs.readFileSync(${JSON.stringify(status)}));`,
        );
        const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
        await writeFile(
          executable,
          `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`,
        );
        await chmod(executable, 0o700);
        monitoring = watchNativeUiSandbox(
          executable,
          { PATH: "/usr/bin:/bin" },
          "owned",
          { exitCode: null, signalCode: null },
          null,
          controller.signal,
        );
        const rejection = expect(monitoring).rejects.toThrow("contained OpenClaw session stopped");
        await vi.waitFor(
          async () => {
            expect(await readFile(observed, "utf8")).toBe("queried");
          },
          { timeout: 5000, interval: 20 },
        );
        await writeFile(
          status,
          JSON.stringify({
            name: "owned",
            phase: "Error",
            privateDiagnostic: "must-not-appear-in-the-error",
          }),
        );
        await rejection;
      } finally {
        controller.abort();
        await monitoring?.catch(() => {});
        await rm(directory, { recursive: true, force: true });
      }
    },
    15_000,
  );
});
