// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, mkdir, rm, writeFile, chmod, readFile, access } from "node:fs/promises";
import net, { createServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  attemptNativeUiCleanup,
  watchNativeUiSandbox,
  observeNativeSandboxCreation,
  confirmNativeUiRegistryEmpty,
} from "../../packaging/windows/runtime/native-ui-lifecycle.mts";
import {
  readNativeUiTunnelMarker,
  startNativeUiTunnel,
} from "../../packaging/windows/runtime/native-ui-tunnel.mts";

async function probeNativeUiRegistry(output: string, code: number) {
  const directory = await mkdtemp(path.join(tmpdir(), "native-create-registry-"));
  try {
    const script = path.join(directory, "registry.mjs");
    const executable = path.join(directory, "openshell-fixture");
    const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
    await writeFile(
      script,
      `if (JSON.stringify(process.argv.slice(2)) !== '["sandbox","list","-o","json"]') process.exit(2); process.stdout.write(${JSON.stringify(output)}); process.exitCode = ${code};`,
    );
    await writeFile(
      executable,
      `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`,
    );
    await chmod(executable, 0o700);
    return await confirmNativeUiRegistryEmpty(executable, { PATH: "/usr/bin:/bin" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("contained native UI relay failures", () => {
  it.each(["EACCES", "EPERM"])("rejects a %s connection denial before readiness", async (code) => {
    const directory = await mkdtemp(path.join(tmpdir(), "native-ui-denial-"));
    const controller = new AbortController();
    const denied = Object.assign(new Error("Connection denied"), { code });
    const connect = vi.spyOn(net, "createConnection").mockImplementation(() => {
      const socket = new net.Socket();
      queueMicrotask(() => socket.emit("error", denied));
      return socket;
    });
    let failure: unknown;
    const tunnel = startNativeUiTunnel({
      relayRoot: directory,
      relayToken: "owned-token",
      uiPort: 12345,
      signal: controller.signal,
    }).catch((error: unknown) => {
      failure = error;
    });
    try {
      await vi.waitFor(() => expect(failure).toBe(denied));
      expect(connect).toHaveBeenCalledTimes(1);
      await expect(access(path.join(directory, "ready"))).rejects.toThrow();
    } finally {
      controller.abort();
      await tunnel;
      connect.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("accepts only the owned shutdown token before the UI starts", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "native-ui-startup-stop-"));
    const controller = new AbortController();
    const connect = vi.spyOn(net, "createConnection").mockImplementation(() => {
      const socket = new net.Socket();
      queueMicrotask(() =>
        socket.emit("error", Object.assign(new Error("Not ready"), { code: "ECONNREFUSED" })),
      );
      return socket;
    });
    await writeFile(path.join(directory, "shutdown"), "wrong-token");
    let stopped = false;
    const tunnel = startNativeUiTunnel({
      relayRoot: directory,
      relayToken: "owned-token",
      uiPort: 12345,
      signal: controller.signal,
    }).then(() => {
      stopped = true;
    });
    void tunnel.catch(() => {});
    try {
      await vi.waitFor(() => expect(connect.mock.calls.length).toBeGreaterThanOrEqual(2));
      expect(stopped).toBe(false);
      await writeFile(path.join(directory, "shutdown"), "owned-token");
      await vi.waitFor(() => expect(stopped).toBe(true));
      await expect(access(path.join(directory, "ready"))).rejects.toThrow();
    } finally {
      controller.abort();
      await tunnel.catch(() => {});
      connect.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

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
  it.each([
    {
      message: "code: 'Client specified an invalid argument', message: private-value",
      rejected: true,
    },
    {
      message: "code: 'The service is currently unavailable', message: private-value",
      rejected: false,
    },
    { message: "connection reset after submitting request", rejected: false },
  ])(
    "reports failed creation promptly without exposing stderr: $message",
    async ({ message, rejected }) => {
      const child = spawn(
        process.execPath,
        ["-e", `process.stderr.write(${JSON.stringify(message)}); process.exitCode = 1;`],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      const creation = observeNativeSandboxCreation(child);
      const error = await creation.failure.catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("sandbox creation failed (1)");
      expect((error as Error).message).not.toContain("private-value");
      expect(creation.wasRejected()).toBe(rejected);
      expect(child.stderr.listenerCount("data")).toBe(0);
    },
  );

  it("keeps an interrupted request ambiguous even after a rejection-like diagnostic", async () => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        `process.stderr.write("code: 'Client specified an invalid argument', message: interrupted"); process.stdout.write("ready"); setInterval(() => {}, 1000);`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const creation = observeNativeSandboxCreation(child);
    try {
      await once(child.stdout, "data");
      child.kill();
      await expect(creation.failure).rejects.toThrow("sandbox creation failed");
      expect(creation.wasRejected()).toBe(false);
    } finally {
      child.kill();
    }
  });

  it("does not confuse a successful create command with UI readiness", async () => {
    const child = spawn(process.execPath, ["-e", "process.exitCode = 0"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const closed = once(child, "close");
    const creation = observeNativeSandboxCreation(child);
    let failed = false;
    void creation.failure.catch(() => {
      failed = true;
    });
    await closed;
    expect(failed).toBe(false);
    expect(creation.wasRejected()).toBe(false);
    expect(child.stderr.listenerCount("data")).toBe(0);
  });

  it("classifies a process that never spawned without disclosing its path", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "native-create-missing-"));
    try {
      const child = spawn(path.join(directory, "missing-private-executable"), [], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const creation = observeNativeSandboxCreation(child);
      await expect(creation.failure).rejects.toThrow("sandbox request could not run");
      expect(creation.wasRejected()).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "accepts a successful empty registry before skipping rejected-creation cleanup",
    async () => {
      await expect(probeNativeUiRegistry("[]", 0)).resolves.toBeUndefined();
    },
  );

  it.skipIf(process.platform === "win32").each([
    { output: '[{"name":"owned"}]', code: 0 },
    { output: '{"sandboxes":[]}', code: 0 },
    { output: "invalid-json", code: 0 },
    { output: "[]", code: 1 },
  ])(
    "requires a successful empty registry before skipping rejected-creation cleanup: $output/$code",
    async ({ output, code }) => {
      await expect(probeNativeUiRegistry(output, code)).rejects.toThrow();
    },
  );

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
