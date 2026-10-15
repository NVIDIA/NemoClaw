// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { expect, vi } from "vitest";
import type {
  DockerOperationAuthority,
  dockerOperationCommandArguments,
} from "../../../src/lib/onboard/runtime-provider/docker-operation-authority";

export async function createNativeLlamaDockerFixture(
  image: string,
  modelPath: string,
  runtime: {
    authority: DockerOperationAuthority;
    commandArguments: typeof dockerOperationCommandArguments;
  },
  evidencePath?: string,
) {
  const authority = runtime.authority;
  const owner = randomBytes(12).toString("hex");
  const transactionId = createHash("sha256").update(owner).digest("hex");
  const name = `nmc-native-${owner}`;
  const key = randomBytes(32).toString("hex");
  const scratch = fs.mkdtempSync(path.join(path.dirname(modelPath), ".native-cancellation-"));
  const containers = new Set<string>();
  let networkId: string | undefined;
  const record: Record<string, unknown> = {
    owner,
    nodeVersion: process.version,
    bridgeRuntimeSha256: createHash("sha256")
      .update(
        fs.readFileSync(
          path.resolve(
            "dist/lib/onboard/runtime-provider/docker-llama-cpp-private-bridge-process.js",
          ),
        ),
      )
      .digest("hex"),
    cancellations: [],
    bridgeCancellationPassed: false,
  };
  const commands: string[] = [];
  let sequence = 0;
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const show = (args: readonly string[]) => {
    const command = ["docker", ...runtime.commandArguments(authority, args)].map(quote).join(" ");
    commands.push(command);
    console.log(command);
  };
  const capture = (args: readonly string[], check = true) => {
    show(args);
    const result = authority.engine.capture(args, 30_000);
    if (check && (result.status !== 0 || result.error)) {
      throw new Error(`Native Docker test command failed: ${args[0]}: ${result.stderr}`);
    }
    return result;
  };
  const inspect = (id: string) => JSON.parse(capture(["container", "inspect", id]).stdout)[0];
  const delay = (milliseconds: number) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds));
  const owned = (id: string) => {
    const current = inspect(id);
    expect(current.Id).toBe(id);
    expect(current.Config.Labels["io.nvidia.nemoclaw.native-test-owner"]).toBe(owner);
    return current;
  };
  const create = (args: readonly string[]) => {
    const id = capture([
      "create",
      "--label",
      `io.nvidia.nemoclaw.native-test-owner=${owner}`,
      ...args,
    ]).stdout.trim();
    expect(id).toMatch(/^[a-f0-9]{64}$/u);
    containers.add(id);
    return id;
  };

  const passed = new Set<string>();
  const close = () => {
    record.bridgeCancellationPassed = passed.size === 10;
    record.passedCases = [...passed];
    record.commands = commands;
    for (const id of containers) {
      owned(id);
      capture(["rm", "--force", id]);
    }
    if (networkId) capture(["network", "rm", networkId]);
    fs.rmSync(scratch, { recursive: true, force: true });
    if (evidencePath) fs.writeFileSync(evidencePath, `${JSON.stringify(record, null, 2)}\n`);
  };
  try {
    expect(createHash("sha256").update(fs.readFileSync(modelPath)).digest("hex")).toBe(
      "ed5fa30c487b282ec156c29062f1222e5c20875a944ac98289dbd242e947f747",
    );
    const selectedImage = JSON.parse(capture(["image", "inspect", image]).stdout)[0];
    const imageId = selectedImage.Id as string;
    expect(selectedImage.Config.Entrypoint).toHaveLength(1);
    const serverPath = selectedImage.Config.Entrypoint[0] as string;
    expect(["/app/llama-server", "/usr/local/bin/llama-server"]).toContain(serverPath);
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || uid! < 1 || gid! < 1)
      throw new Error("Native Docker qualification requires a non-root host identity");
    const keyPath = path.join(scratch, "api-key");
    const curlPath = path.join(scratch, "curl-config");
    fs.writeFileSync(keyPath, `${key}\n`, { mode: 0o600 });
    fs.writeFileSync(
      curlPath,
      `header = "Authorization: Bearer ${key}"\nheader = "Content-Type: application/json"\n`,
      { mode: 0o600 },
    );
    networkId = capture([
      "network",
      "create",
      "--internal",
      "--label",
      `io.nvidia.nemoclaw.native-test-owner=${owner}`,
      name,
    ]).stdout.trim();
    const server = create([
      "--name",
      name,
      "--user",
      `${uid}:${gid}`,
      "--env",
      "NVIDIA_VISIBLE_DEVICES=void",
      "--network",
      name,
      "--label",
      `io.nvidia.nemoclaw.host-local-inference.transaction-sha256=${transactionId}`,
      "--no-healthcheck",
      "--mount",
      `type=bind,src=${modelPath},dst=/models/model.gguf,readonly`,
      "--mount",
      `type=bind,src=${keyPath},dst=/run/secrets/api-key,readonly`,
      imageId,
      "--model",
      "/models/model.gguf",
      "--alias",
      "native-test-smollm",
      "--host",
      "0.0.0.0",
      "--port",
      "8081",
      "--parallel",
      "1",
      "--ctx-size",
      "8192",
      "--n-gpu-layers",
      "0",
      "--threads",
      "4",
      "--metrics",
      "--timeout",
      "900",
      "--api-key-file",
      "/run/secrets/api-key",
      "--no-ui",
      "--no-slots",
      "--no-agent",
    ]);
    owned(server);
    capture(["start", server]);
    record.server = {
      id: server,
      imageId,
      configuredPorts: owned(server).HostConfig.PortBindings,
      effectivePorts: owned(server).NetworkSettings.Ports,
      authorityId: authority.engine.authorityId,
    };
    const version = capture(["exec", server, serverPath, "--version"]);
    record.version = version.stdout + version.stderr;
    record.curlVersion = capture(["exec", server, "/usr/bin/curl", "--version"]).stdout.split(
      "\n",
    )[0];
    expect(record.version).toContain("commit 8e7f22b67ef4667b4ddd50230771287f328cfb3f");
    record.serverProcesses = capture(["top", server, "-eo", "pid,ppid,comm,args"]).stdout;

    const client = (
      url: string,
      body?: Record<string, unknown>,
      timeout = 10,
      authenticated = true,
    ) => {
      const args = [
        "--name",
        `${name}-client-${++sequence}`,
        "--user",
        `${uid}:${gid}`,
        "--env",
        "NVIDIA_VISIBLE_DEVICES=void",
        "--network",
        name,
        "--entrypoint",
        "/usr/bin/curl",
      ];
      if (authenticated)
        args.push("--mount", `type=bind,src=${curlPath},dst=/run/secrets/curl-config,readonly`);
      args.push(imageId);
      if (authenticated) args.push("--config", "/run/secrets/curl-config");
      args.push(
        "--silent",
        "--show-error",
        "--no-buffer",
        "--dump-header",
        "/dev/stderr",
        "--max-time",
        String(timeout),
      );
      if (body) args.push("--data", JSON.stringify(body));
      args.push(`http://${name}:8081${url}`);
      const id = create(args);
      expect(owned(id).Image).toBe(imageId);
      capture(["start", id]);
      return {
        id,
        timeout,
        output: () => capture(["logs", id]).stdout,
        headers: () => capture(["logs", id]).stderr,
      };
    };
    const body = (stream: boolean, tokens: number) => ({
      model: "native-test-smollm",
      messages: [{ role: "user", content: "Count upward without stopping." }],
      stream,
      max_tokens: tokens,
      temperature: 0,
      ignore_eos: true,
    });
    const clientFailures: unknown[] = [];
    record.clientFailures = clientFailures;
    const finished = async (request: ReturnType<typeof client>, expectedCode = 0) => {
      try {
        await vi.waitFor(
          () => {
            expect(owned(request.id).State.Running).toBe(false);
          },
          { timeout: (request.timeout + 2) * 1_000, interval: 20 },
        );
      } catch (error) {
        clientFailures.push({
          id: request.id,
          state: owned(request.id).State,
          logs: capture(["logs", request.id]),
        });
        throw error;
      }
      const state = owned(request.id).State;
      expect(state.Running).toBe(false);
      expect(state.Pid).toBe(0);
      expect(state.ExitCode).toBe(expectedCode);
      return request.output();
    };
    const metrics = async () => {
      const source = await finished(client("/metrics"));
      const samples = new Map<string, number>();
      for (const line of source.split("\n")) {
        const match = /^(llamacpp:[a-z_]+)\s+(\S+)$/u.exec(line);
        if (match) samples.set(match[1]!, Number(match[2]));
      }
      for (const field of ["requests_processing", "requests_deferred", "n_decode_total"]) {
        expect(Number.isFinite(samples.get(`llamacpp:${field}`))).toBe(true);
      }
      return Object.fromEntries(samples);
    };
    const idle = async () => {
      const start = performance.now();
      for (;;) {
        const values = await metrics();
        if (
          values["llamacpp:requests_processing"] === 0 &&
          values["llamacpp:requests_deferred"] === 0
        )
          return values;
        expect(performance.now() - start).toBeLessThan(5_000);
        await delay(20);
      }
    };
    const complete = async () => {
      const start = performance.now();
      const reply = JSON.parse(await finished(client("/v1/chat/completions", body(false, 16))));
      expect(reply.usage.completion_tokens).toBe(16);
      return performance.now() - start;
    };
    const stream = async (timeout = 30) => {
      const request = client("/v1/chat/completions", body(true, 4096), timeout);
      const start = performance.now();
      for (;;) {
        const chunks = request
          .output()
          .split("\n")
          .filter((line) => line.startsWith("data: {"))
          .map((line) => {
            try {
              return JSON.parse(line.slice(6));
            } catch {
              return undefined;
            }
          });
        if (chunks.some((chunk) => chunk?.choices?.[0]?.delta?.content)) return request;
        expect(performance.now() - start).toBeLessThan(10_000);
        await delay(10);
      }
    };

    await vi.waitFor(
      async () => {
        expect(JSON.parse(await finished(client("/health"))).status).toBe("ok");
      },
      { timeout: 30_000, interval: 100 },
    );
    await complete();
    const baseline = [await complete(), await complete(), await complete()].sort((a, b) => a - b);
    record.baselineMilliseconds = baseline;
    const normalLatencyBound = Math.max(1_500, baseline[1]! * 3);
    return {
      authority,
      key,
      keyPath,
      transactionId,
      server,
      owned,
      capture,
      client,
      finished,
      metrics,
      idle,
      complete,
      stream,
      body,
      record,
      normalLatencyBound,
      passed,
      restoreClientPidsLimit(id: string) {
        const current = capture([
          "ps",
          "--all",
          "--no-trunc",
          "--quiet",
          "--filter",
          `label=io.nvidia.nemoclaw.host-local-inference.request-transaction-sha256=${transactionId}`,
          "--filter",
          `id=${id}`,
        ]).stdout.trim();
        expect(["", id]).toContain(current);
        if (current === id) capture(["update", "--pids-limit", "32", id]);
      },
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}

export const waitForNativeBridgeExit = (child: ChildProcess) =>
  new Promise<number | null>((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode);
      return;
    }
    const timeout = setTimeout(
      () => reject(new Error("Bridge shutdown exceeded 25 seconds")),
      25_000,
    );
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });

export function waitForNativeBridgeReady(
  processBridge: ChildProcess,
  record: Record<string, unknown>,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let errors = "";
    const timeout = setTimeout(
      () => reject(new Error(`Bridge startup timed out: ${errors}`)),
      10_000,
    );
    processBridge.stderr!.on("data", (value: Buffer) => {
      errors = (errors + value.toString()).slice(-4096);
      record.bridgeStderr = errors;
    });
    processBridge.once("error", reject);
    processBridge.once("exit", () => {
      clearTimeout(timeout);
      reject(new Error(`Bridge startup failed: ${errors}`));
    });
    processBridge.stdio[4]!.once("data", (value: Buffer) => {
      clearTimeout(timeout);
      if (value.toString() === "READY") resolve();
      else reject(new Error(`Bridge startup failed: ${errors}`));
    });
  });
}

export function captureNativeRequestDeadline() {
  let expire: (() => void) | undefined;
  const originalTimeout = globalThis.setTimeout;
  const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: (...args: unknown[]) => void,
    milliseconds?: number,
    ...args: unknown[]
  ) => {
    if (milliseconds === 900_000) expire = () => callback(...args);
    return originalTimeout(callback, milliseconds, ...args);
  }) as typeof setTimeout);
  return {
    get expire() {
      return expire;
    },
    mockRestore: () => timer.mockRestore(),
  };
}

export function advanceNativeRequestDeadline(
  dockerOperations: NativeDockerOperations,
  fixture: NativeFixture,
) {
  const now = performance.now.bind(performance);
  const timeout = globalThis.setTimeout;
  let offset = 0;
  let requestDeadline: number | undefined;
  let advanced = false;
  let timerCalls = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now() + offset);
  const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: (...args: unknown[]) => void,
    milliseconds?: number,
    ...args: unknown[]
  ) => {
    if (milliseconds === 900_000 && !advanced) {
      requestDeadline = performance.now() + milliseconds;
      return timeout(() => {
        timerCalls += 1;
        callback(...args);
      }, milliseconds);
    }
    return timeout(callback, milliseconds, ...args);
  }) as typeof setTimeout);
  const qualification = vi
    .spyOn(dockerOperations, "createDockerOperationAuthority")
    .mockReturnValue({
      ...fixture.authority,
      spawn: (args, options) => {
        const child = fixture.authority.spawn(args, options);
        if (!advanced) {
          if (requestDeadline === undefined) throw new Error("request deadline was not installed");
          offset = requestDeadline - now() - 5_000;
          advanced = true;
        }
        return child;
      },
    });
  return {
    get offset() {
      return offset;
    },
    get timerCalls() {
      return timerCalls;
    },
    restore() {
      clock.mockRestore();
      timer.mockRestore();
      qualification.mockRestore();
    },
  };
}

export async function spawnNativeBridge(fixture: NativeFixture, listenPort = 0) {
  const reservation = http.createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(listenPort, "127.0.0.1", resolve);
  });
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const descriptor = fs.openSync(fixture.keyPath, "r");
  try {
    const child = spawn(
      process.execPath,
      [
        path.resolve(
          "dist/lib/onboard/runtime-provider/docker-llama-cpp-private-bridge-process.js",
        ),
        "--transaction",
        fixture.transactionId,
        "--auth-mode",
        "api-key-fd3",
        "--target-host",
        "127.0.0.1",
        "--target-port",
        "8081",
        "--listen-port",
        String(port),
        "--container-id",
        fixture.server,
        "--docker-authority",
        fixture.authority.engine.authorityId,
        "--bind-address",
        "127.0.0.1",
      ],
      { stdio: ["ignore", "ignore", "pipe", descriptor, "pipe"] },
    );
    return { child, url: `http://127.0.0.1:${port}` };
  } finally {
    fs.closeSync(descriptor);
  }
}

export function nativeBridgeClientPid(bridge: ChildProcess): number {
  const clients = execFileSync("ps", ["-eo", "pid=,ppid=,comm="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((row) => row.trim().split(/\s+/u))
    .filter((row) => Number(row[1]) === bridge.pid && /(?:^|\/)docker$/u.test(row[2] ?? ""));
  expect(clients).toHaveLength(1);
  return Number(clients[0]![0]);
}

export function nativeProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    return false;
  }
}

type NativeFixture = Awaited<ReturnType<typeof createNativeLlamaDockerFixture>>;
type NativeDockerOperations =
  typeof import("../../../src/lib/onboard/runtime-provider/docker-operation-authority");

export async function stopNativeBridge(child?: ChildProcess): Promise<void> {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exit = waitForNativeBridgeExit(child);
    child.kill("SIGTERM");
    await exit;
  }
}

export function recordNativeSetupFailure(fixture: NativeFixture | undefined, error: unknown): void {
  if (fixture) fixture.record.setupFailure = error instanceof Error ? error.stack : String(error);
}

export function closeNativeFixture(
  fixture: NativeFixture | undefined,
  cleanup: typeof import("../../../src/lib/onboard/runtime-provider/docker-llama-cpp-private-bridge-process").cleanupLlamaCppPrivateBridgeRequests,
): void {
  if (fixture) {
    cleanup(fixture.authority.engine, fixture.transactionId, fixture.key, 8081);
    fixture.close();
  }
}
