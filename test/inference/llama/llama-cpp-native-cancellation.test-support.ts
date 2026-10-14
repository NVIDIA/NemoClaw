// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, vi } from "vitest";
import {
  createDockerOperationAuthority,
  dockerOperationCommandArguments,
} from "../../../src/lib/onboard/runtime-provider/docker-operation-authority";

export async function createNativeLlamaDockerFixture(
  image: string,
  modelPath: string,
  evidencePath?: string,
) {
  const authority = createDockerOperationAuthority("host-local-inference");
  const owner = randomBytes(12).toString("hex");
  const name = `nmc-native-${owner}`;
  const key = randomBytes(32).toString("hex");
  const scratch = fs.mkdtempSync(path.join(path.dirname(modelPath), ".native-cancellation-"));
  const containers = new Set<string>();
  let networkId: string | undefined;
  const record: Record<string, unknown> = {
    owner,
    cancellations: [],
    backendCancellationPassed: false,
  };
  const commands: string[] = [];
  let sequence = 0;
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const show = (args: readonly string[]) => {
    const command = ["docker", ...dockerOperationCommandArguments(authority, args)]
      .map(quote)
      .join(" ");
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
    record.backendCancellationPassed = passed.size === 8;
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
    const imageId = JSON.parse(capture(["image", "inspect", image]).stdout)[0].Id as string;
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
      "--network",
      name,
      "--publish",
      "127.0.0.1:8081:8081",
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
    const version = capture(["exec", server, "/app/llama-server", "--version"]);
    record.version = version.stdout + version.stderr;
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
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}
