// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
const requireCompiled = createRequire(import.meta.url);
const { cleanupLlamaCppPrivateBridgeRequests, createLlamaCppPrivateBridgeServer } = requireCompiled(
  path.resolve("dist/lib/onboard/runtime-provider/docker-llama-cpp-private-bridge-process.js"),
) as typeof import("../../../src/lib/onboard/runtime-provider/docker-llama-cpp-private-bridge-process");
import { createNativeLlamaDockerFixture } from "./llama-cpp-native-cancellation.test-support";
const dockerOperations = requireCompiled(
  path.resolve("dist/lib/onboard/runtime-provider/docker-operation-authority.js"),
) as typeof import("../../../src/lib/onboard/runtime-provider/docker-operation-authority");

const image = process.env.NEMOCLAW_NATIVE_LLAMA_TEST_IMAGE;
const modelPath = process.env.NEMOCLAW_NATIVE_LLAMA_TEST_MODEL;
const evidencePath = process.env.NEMOCLAW_NATIVE_LLAMA_TEST_EVIDENCE;
const requestOwnerLabel = "io.nvidia.nemoclaw.host-local-inference.request-transaction-sha256";

describe
  .runIf(Boolean(image && modelPath))
  .sequential("private bridge native Docker cancellation", { shuffle: false }, () => {
    let fixture: Awaited<ReturnType<typeof createNativeLlamaDockerFixture>>;
    let processBridge: ChildProcess;
    let url: string;
    let normalLatencyBound: number;
    const target = () => ({
      targetHost: "127.0.0.1",
      targetPort: 8081,
      containerId: fixture.server,
      dockerAuthorityId: fixture.authority.engine.authorityId,
      transactionId: fixture.transactionId,
    });
    const clients = () =>
      fixture
        .capture([
          "ps",
          "--all",
          "--no-trunc",
          "--quiet",
          "--filter",
          `label=${requestOwnerLabel}=${fixture.transactionId}`,
        ])
        .stdout.trim()
        .split("\n")
        .filter(Boolean);
    const chat = (stream: boolean, endpoint = url, authenticated = true, signal?: AbortSignal) =>
      fetch(`${endpoint}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authenticated ? { Authorization: `Bearer ${fixture.key}` } : {}),
        },
        body: JSON.stringify(fixture.body(stream, stream ? 4096 : 16)),
        signal,
      });
    const complete = async (endpoint = url) => {
      const started = performance.now();
      const response = await chat(false, endpoint);
      expect(response.status).toBe(200);
      expect((await response.json()).usage.completion_tokens).toBe(16);
      return performance.now() - started;
    };
    const stream = async (endpoint = url) => {
      const abort = new AbortController();
      const response = await chat(true, endpoint, true, abort.signal);
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(first.done).toBe(false);
      expect(Buffer.from(first.value!).toString()).toContain("data:");
      const ids = clients();
      expect(ids).toHaveLength(1);
      const owned = JSON.parse(fixture.capture(["container", "inspect", ids[0]!]).stdout)[0];
      expect(owned.State.Running).toBe(true);
      expect(owned.HostConfig.NetworkMode).toBe(`container:${fixture.server}`);
      expect(owned.HostConfig.LogConfig.Type).toBe("none");
      expect(owned.HostConfig.Privileged).toBe(false);
      expect(owned.HostConfig.ReadonlyRootfs).toBe(true);
      expect(owned.HostConfig.CapDrop).toEqual(["ALL"]);
      expect(owned.HostConfig.DeviceRequests ?? []).toEqual([]);
      expect(owned.Mounts).toEqual([]);
      expect(owned.HostConfig.PortBindings ?? {}).toEqual({});
      expect(JSON.stringify(owned)).not.toContain(fixture.key);
      expect(JSON.stringify(owned)).not.toContain("Count upward");
      expect((await fixture.metrics())["llamacpp:requests_processing"]).toBe(1);
      return { id: ids[0]!, abort, reader };
    };
    const stopped = async (id: string, exitCode = 137) => {
      await expect.poll(clients, { timeout: 10_000, interval: 50 }).toEqual([]);
      const idle = await fixture.idle();
      const stable = await fixture.metrics();
      expect(stable["llamacpp:requests_processing"]).toBe(0);
      expect(stable["llamacpp:requests_deferred"]).toBe(0);
      expect(stable["llamacpp:n_decode_total"]).toBe(idle["llamacpp:n_decode_total"]);
      const events = fixture
        .capture([
          "events",
          "--since",
          "10m",
          "--until",
          new Date().toISOString(),
          "--filter",
          `container=${id}`,
          "--format",
          "{{json .}}",
        ])
        .stdout.trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      expect(
        events.some(
          (event) =>
            event.Action === "die" &&
            event.Actor.ID === id &&
            event.Actor.Attributes.exitCode === String(exitCode),
        ),
      ).toBe(true);
      expect(events.some((event) => event.Action === "destroy" && event.Actor.ID === id)).toBe(
        true,
      );
      return { idle, stable, events };
    };
    const exited = (child: ChildProcess) =>
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
    beforeAll(async () => {
      try {
        fixture = await createNativeLlamaDockerFixture(image!, modelPath!, {
          authority: dockerOperations.createDockerOperationAuthority("host-local-inference"),
          commandArguments: dockerOperations.dockerOperationCommandArguments,
        }, evidencePath);
        const reservation = http.createServer();
        await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
        const port = (reservation.address() as { port: number }).port;
        await new Promise<void>((resolve) => reservation.close(() => resolve()));
        const descriptor = fs.openSync(fixture.keyPath, "r");
        try {
          processBridge = spawn(
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
        } finally {
          fs.closeSync(descriptor);
        }
        await new Promise<void>((resolve, reject) => {
          let errors = "";
          const timeout = setTimeout(
            () => reject(new Error(`Bridge startup timed out: ${errors}`)),
            10_000,
          );
          processBridge.stderr!.on("data", (value: Buffer) => {
            errors = (errors + value.toString()).slice(-4096);
            fixture.record.bridgeStderr = errors;
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
        url = `http://127.0.0.1:${port}`;
        await complete();
        const baseline = [await complete(), await complete(), await complete()].sort(
          (a, b) => a - b,
        );
        normalLatencyBound = Math.max(3_000, baseline[1]! * 3);
        fixture.record.bridgeBaselineMilliseconds = baseline;
      } catch (error) {
        if (fixture)
          fixture.record.setupFailure = error instanceof Error ? error.stack : String(error);
        throw error;
      }
    }, 90_000);
    afterAll(async () => {
      vi.restoreAllMocks();
      if (processBridge && processBridge.exitCode === null) {
        processBridge.kill("SIGTERM");
        await exited(processBridge);
      }
      if (fixture) {
        cleanupLlamaCppPrivateBridgeRequests(
          fixture.authority.engine,
          fixture.transactionId,
          fixture.key,
          8081,
        );
        fixture.close();
      }
    }, 60_000);
    it("rejects a completion without bearer authentication before creating a client", async () => {
      const response = await chat(false, url, false);
      expect(response.status).toBe(401);
      await response.text();
      expect(clients()).toEqual([]);
      fixture.passed.add("authentication");
    });
    it.each([1, 2, 3, 4, 5])(
      "cancels remote work before readmission and recovers normal latency [%s]",
      async (iteration) => {
        const active = await stream();
        const denied = await chat(false);
        expect(denied.status).toBe(503);
        expect(denied.headers.get("retry-after")).toBe("1");
        await denied.text();
        if (iteration === 1) {
          const metrics = await fetch(`${url}/metrics`, {
            headers: { Authorization: `Bearer ${fixture.key}` },
          });
          expect(metrics.status).toBe(503);
          expect(metrics.headers.get("retry-after")).toBe("1");
          await metrics.text();
        }
        const start = performance.now();
        active.abort.abort();
        await active.reader.cancel().catch(() => undefined);
        const proof = await stopped(active.id);
        const cancellationMilliseconds = performance.now() - start;
        expect(cancellationMilliseconds).toBeLessThan(5_000);
        const nextCompletionMilliseconds = await complete();
        expect(nextCompletionMilliseconds).toBeLessThan(normalLatencyBound);
        (fixture.record.cancellations as unknown[]).push({
          iteration,
          clientId: active.id,
          cancellationMilliseconds,
          nextCompletionMilliseconds,
          ...proof,
        });
        fixture.passed.add(`cancellation-${iteration}`);
      },
      30_000,
    );
    it("cleans remote work when the real bridge process receives SIGTERM", async () => {
      const active = await stream();
      const start = performance.now();
      const exit = exited(processBridge);
      processBridge.kill("SIGTERM");
      expect(await exit).toBe(0);
      const proof = await stopped(active.id);
      fixture.record.bridgeShutdown = { milliseconds: performance.now() - start, ...proof };
      active.abort.abort();
      await active.reader.cancel().catch(() => undefined);
      fixture.passed.add("shutdown");
    }, 30_000);
    it("runs the request deadline cleanup against real Docker and recovers normal latency", async () => {
      if (processBridge.exitCode === null && processBridge.signalCode === null) {
        const exit = exited(processBridge);
        processBridge.kill("SIGTERM");
        await exit;
      }
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
      const bridge = createLlamaCppPrivateBridgeServer(target(), fixture.key);
      await new Promise<void>((resolve) => bridge.listen(0, "127.0.0.1", resolve));
      const endpoint = `http://127.0.0.1:${(bridge.address() as { port: number }).port}`;
      try {
        const active = await stream(endpoint);
        expect(expire).toBeTypeOf("function");
        expire!();
        const proof = await stopped(active.id);
        active.abort.abort();
        await active.reader.cancel().catch(() => undefined);
        const nextCompletionMilliseconds = await complete(endpoint);
        expect(nextCompletionMilliseconds).toBeLessThan(normalLatencyBound);
        fixture.record.deadline = {
          timer: "production 900-second callback invoked after first SSE chunk",
          nextCompletionMilliseconds,
          ...proof,
        };
        fixture.passed.add("deadline");
      } finally {
        timer.mockRestore();
        bridge.closeAllConnections();
        await bridge.closeOwnedWork();
        await new Promise<void>((resolve) => bridge.close(() => resolve()));
      }
    }, 30_000);
    it("enforces the remaining request budget in native curl without the host timer firing", async () => {
      if (processBridge.exitCode === null && processBridge.signalCode === null) {
        const exit = exited(processBridge);
        processBridge.kill("SIGTERM");
        await exit;
      }
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
              if (requestDeadline === undefined)
                throw new Error("request deadline was not installed");
              offset = requestDeadline - now() - 5_000;
              advanced = true;
            }
            return child;
          },
        });
      const bridge = createLlamaCppPrivateBridgeServer(target(), fixture.key);
      await new Promise<void>((resolve) => bridge.listen(0, "127.0.0.1", resolve));
      const endpoint = `http://127.0.0.1:${(bridge.address() as { port: number }).port}`;
      try {
        const active = await stream(endpoint);
        const proof = await stopped(active.id, 28);
        expect(timerCalls).toBe(0);
        active.abort.abort();
        await active.reader.cancel().catch(() => undefined);
        clock.mockRestore();
        timer.mockRestore();
        qualification.mockRestore();
        const nextCompletionMilliseconds = await complete(endpoint);
        expect(nextCompletionMilliseconds).toBeLessThan(normalLatencyBound);
        fixture.record.nativeDeadline = {
          simulatedElapsedMilliseconds: offset,
          hostTimerCalls: timerCalls,
          curlExitCode: 28,
          nextCompletionMilliseconds,
          ...proof,
        };
        fixture.passed.add("native-deadline");
      } finally {
        clock.mockRestore();
        timer.mockRestore();
        qualification.mockRestore();
        bridge.closeAllConnections();
        await bridge.closeOwnedWork();
        await new Promise<void>((resolve) => bridge.close(() => resolve()));
      }
    }, 30_000);

    it("keeps admission closed when local Docker exit does not prove remote cleanup", async () => {
      if (processBridge.exitCode === null && processBridge.signalCode === null) {
        const exit = exited(processBridge);
        processBridge.kill("SIGTERM");
        await exit;
      }
      const authority = fixture.authority;
      let requestClient: ChildProcess | undefined;
      let denyStop = true;
      let refusedStops = 0;
      const qualification = vi
        .spyOn(dockerOperations, "createDockerOperationAuthority")
        .mockReturnValue({
          ...authority,
          spawn: (args, options) => {
            requestClient = authority.spawn(args, options);
            return requestClient;
          },
          engine: {
            ...authority.engine,
            capture: (args, timeout, input) => {
              if (denyStop && args[0] === "kill") {
                refusedStops += 1;
                return { status: 1, stdout: "", stderr: "test-only Docker stop refusal" };
              }
              return authority.engine.capture(args, timeout, input);
            },
          },
        });
      const bridge = createLlamaCppPrivateBridgeServer(target(), fixture.key);
      await new Promise<void>((resolve) => bridge.listen(0, "127.0.0.1", resolve));
      const endpoint = `http://127.0.0.1:${(bridge.address() as { port: number }).port}`;
      try {
        const active = await stream(endpoint);
        active.abort.abort();
        await active.reader.cancel().catch(() => undefined);
        await expect.poll(() => refusedStops, { timeout: 5_000 }).toBe(1);
        await expect
          .poll(
            () =>
              requestClient !== undefined &&
              (requestClient.exitCode !== null || requestClient.signalCode !== null),
            { timeout: 5_000 },
          )
          .toBe(true);
        const remote = JSON.parse(fixture.capture(["container", "inspect", active.id]).stdout)[0];
        expect(remote.State.Running).toBe(true);
        expect((await fixture.metrics())["llamacpp:requests_processing"]).toBe(1);
        const denied = await chat(false, endpoint);
        expect(denied.status).toBe(503);
        await denied.text();
        denyStop = false;
        await bridge.closeOwnedWork();
        fixture.record.cleanupRefusal = {
          clientId: active.id,
          localClient: {
            pid: requestClient!.pid,
            exitCode: requestClient!.exitCode,
            signal: requestClient!.signalCode,
          },
          admissionStatus: denied.status,
          ...(await stopped(active.id)),
        };
        fixture.passed.add("cleanup-failure");
      } finally {
        denyStop = false;
        qualification.mockRestore();
        bridge.closeAllConnections();
        await bridge.closeOwnedWork();
        await new Promise<void>((resolve) => bridge.close(() => resolve()));
      }
    }, 30_000);
  });
