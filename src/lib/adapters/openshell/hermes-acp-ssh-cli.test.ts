// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TempSshConfigCleanupError } from "../../sandbox/temp-ssh-config";
import {
  buildHermesAcpProbeSshArgs,
  buildHermesAcpSessionSshArgs,
  createCliHermesAcpSshTransport,
  type CliHermesAcpSshTransportDeps,
} from "./hermes-acp-ssh-cli";

function sshConfig(gatewayName = "nemoclaw"): string {
  return [
    "Host openshell-alpha.default",
    "  User sandbox",
    "  StrictHostKeyChecking no",
    "  UserKnownHostsFile /dev/null",
    "  GlobalKnownHostsFile /dev/null",
    "  LogLevel ERROR",
    "  ServerAliveInterval 15",
    "  ServerAliveCountMax 3",
    `  ProxyCommand /usr/bin/openshell ssh-proxy --gateway-name ${gatewayName} --name alpha --workspace default`,
    "",
  ].join("\n");
}
const PROBE_OUTPUT = "0.20.6\n0.9.0\n";
const SESSION_STATUS_NONCE = "0123456789abcdef0123456789abcdef";

function sessionStatusFrame(status: number): string {
  return `\x1enemoclaw-acp-status-v1:${SESSION_STATUS_NONCE}:${String(status)}\x1e`;
}

type FakeChild = Omit<
  ChildProcessWithoutNullStreams,
  "exitCode" | "signalCode" | "stderr" | "stdin" | "stdout"
> & {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  stderr: PassThrough;
  stdin: PassThrough;
  stdout: PassThrough;
  finish(status: number | null, signal?: NodeJS.Signals | null): void;
};

function fakeChild(onInputEnd?: (child: FakeChild, input: string) => void): FakeChild {
  const events = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let input = "";
  const child = Object.assign(events, {
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    pid: 987_654_321,
    stdin,
    stdout,
    stderr,
    finish(status: number | null, signal: NodeJS.Signals | null = null) {
      child.exitCode = status;
      child.signalCode = signal;
      stdout.end();
      stderr.end();
      queueMicrotask(() => events.emit("close", status, signal));
    },
    kill: vi.fn((signal: NodeJS.Signals) => {
      child.finish(null, signal);
      return true;
    }),
  }) as unknown as FakeChild;
  stdin.setEncoding("utf8");
  stdin.on("data", (chunk) => {
    input += String(chunk);
  });
  stdin.on("finish", () => onInputEnd?.(child, input));
  return child;
}

function probeChild(output = PROBE_OUTPUT, status = 0): FakeChild {
  return fakeChild((child) => {
    queueMicrotask(() => {
      child.stdout.write(output);
      child.finish(status);
    });
  });
}

function finishSession(child: FakeChild, status: number): void {
  child.stderr.write(sessionStatusFrame(status));
  child.finish(0);
}

function collectingWritable(options: { delay?: boolean; fail?: boolean } = {}): {
  stream: Writable;
  text: () => string;
} {
  let text = "";
  const write = options.fail
    ? (_chunk: unknown, _encoding: unknown, callback: (error?: Error | null) => void) =>
        callback(Object.assign(new Error("client closed"), { code: "EPIPE" }))
    : (chunk: unknown, _encoding: unknown, callback: (error?: Error | null) => void) => {
        text += String(chunk);
        options.delay ? setImmediate(callback) : callback();
      };
  const stream = new Writable({
    highWaterMark: 1,
    write,
  });
  return { stream, text: () => text };
}

function harness(
  children: FakeChild[],
  overrides: Partial<CliHermesAcpSshTransportDeps> = {},
): {
  captureOpenShell: ReturnType<typeof vi.fn>;
  cleanup: ReturnType<typeof vi.fn>;
  createTempConfig: ReturnType<typeof vi.fn>;
  spawnSsh: ReturnType<typeof vi.fn>;
  transport: ReturnType<typeof createCliHermesAcpSshTransport>;
} {
  const cleanup = vi.fn();
  const createTempConfig = vi.fn(() => ({
    dir: "/tmp/nemoclaw-acp-test",
    file: "/tmp/nemoclaw-acp-test/ssh_config",
    cleanup,
  }));
  const captureOpenShell = vi.fn((args: string[]) => ({
    status: 0,
    output: args.includes("ssh-config") ? sshConfig(args[args.indexOf("-g") + 1]) : "sandbox ready",
  }));
  const spawnSsh = vi.fn(() => {
    return children.shift() as FakeChild;
  });
  const deps: CliHermesAcpSshTransportDeps = {
    access: vi.fn(),
    captureOpenShell,
    createTempConfig,
    createSessionStatusNonce: () => SESSION_STATUS_NONCE,
    openshellVersion: vi.fn(() => "0.0.116"),
    platform: "linux",
    resolveOpenshell: () => "/usr/bin/openshell",
    spawnSsh,
    sshBinary: "/usr/bin/ssh",
    ...overrides,
  };
  return {
    captureOpenShell,
    cleanup,
    createTempConfig,
    spawnSsh,
    transport: createCliHermesAcpSshTransport(deps),
  };
}

function throwSshSpawn(): never {
  throw new Error("SSH spawn failed");
}

function streams(input: Readable = Readable.from([])) {
  const output = collectingWritable({ delay: true });
  const diagnostics = collectingWritable();
  return {
    diagnostics,
    output,
    value: {
      input,
      output: output.stream,
      diagnostics: diagnostics.stream,
    },
  };
}

describe("CLI Hermes ACP SSH transport", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("constructs only fixed probe and status-framed hermes-acp commands (#10947)", () => {
    const probe = buildHermesAcpProbeSshArgs("/tmp/acp/ssh_config", "openshell-alpha.default");
    const session = buildHermesAcpSessionSshArgs(
      "/tmp/acp/ssh_config",
      "openshell-alpha.default",
      SESSION_STATUS_NONCE,
    );

    expect(probe.slice(0, -1)).toEqual(session.slice(0, -1));
    expect(probe.at(-1)).toContain('m.version("hermes-agent")');
    expect(probe.at(-1)).toContain('m.version("agent-client-protocol")');
    expect(session.at(-1)).toContain("/bin/sh -c");
    expect(session.at(-1)).toContain("/usr/local/bin/hermes-acp");
    expect(session.at(-1)).toContain("nemoclaw-acp-status-v1");
    expect(session.at(-1)).toContain(SESSION_STATUS_NONCE);
    expect(() =>
      buildHermesAcpSessionSshArgs(
        "/tmp/acp/ssh_config",
        "openshell-alpha.default",
        "$(untrusted)",
      ),
    ).toThrow("Hermes ACP session status nonce is invalid");
  });

  it("forwards duplex bytes with backpressure and keeps stderr out of ACP output", async () => {
    const session = fakeChild((child, input) => {
      child.stderr.write("request payload and credential-shaped diagnostic");
      child.stdout.write(`reply:${input}`);
      finishSession(child, 0);
    });
    const fixture = harness([probeChild(), session]);
    const io = streams(Readable.from(["first", "-second"]));

    const result = await fixture.transport.run({
      gatewayName: "nemoclaw",
      sandboxName: "alpha",
      streams: io.value,
    });

    expect(result).toEqual({ kind: "completed", exitCode: 0 });
    expect(io.output.text()).toBe("reply:first-second");
    expect(io.diagnostics.text()).toBe("");
    expect(fixture.cleanup).toHaveBeenCalledOnce();
  });

  it("gives SSH only the selected OpenShell target and credential-minimizing environment", async () => {
    vi.stubEnv("NVIDIA_INFERENCE_API_KEY", "provider-secret");
    vi.stubEnv("OPENSHELL_TOKEN", "openshell-secret");
    vi.stubEnv("SSH_AUTH_SOCK", "/tmp/private-agent.sock");
    const session = fakeChild((child) => finishSession(child, 0));
    const fixture = harness([probeChild(), session]);
    const io = streams();

    await fixture.transport.run({
      gatewayName: "nemoclaw-8090",
      sandboxName: "alpha",
      streams: io.value,
    });

    expect(fixture.captureOpenShell.mock.calls.map(([args]) => args)).toEqual([
      ["sandbox", "get", "-g", "nemoclaw-8090", "alpha"],
      ["sandbox", "ssh-config", "-g", "nemoclaw-8090", "alpha"],
    ]);
    expect(fixture.spawnSsh.mock.calls[0]?.slice(0, 2)).toEqual([
      "/usr/bin/ssh",
      expect.arrayContaining(["openshell-alpha.default"]),
    ]);
    const options = fixture.spawnSsh.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv };
    expect(options.env).toMatchObject({
      OPENSHELL_GATEWAY: "nemoclaw-8090",
      OPENSHELL_WORKSPACE: "default",
    });
    expect(options.env).not.toHaveProperty("NVIDIA_INFERENCE_API_KEY");
    expect(options.env).not.toHaveProperty("OPENSHELL_TOKEN");
    expect(options.env).not.toHaveProperty("SSH_AUTH_SOCK");
  });

  it("rejects an untrusted SSH proxy command before writing a configuration or starting SSH (#10947)", async () => {
    const captureOpenShell = vi.fn((args: string[]) => ({
      status: 0,
      output: args.includes("ssh-config")
        ? sshConfig().replace(
            "/usr/bin/openshell ssh-proxy --gateway-name nemoclaw --name alpha --workspace default",
            "/bin/sh -c 'touch /tmp/not-allowed'",
          )
        : "sandbox ready",
    }));
    const fixture = harness([], { captureOpenShell });
    const io = streams();

    const result = await fixture.transport.run({
      gatewayName: "nemoclaw",
      sandboxName: "alpha",
      streams: io.value,
    });

    expect(result).toMatchObject({ kind: "failed", error: { kind: "transport" } });
    expect(fixture.createTempConfig).not.toHaveBeenCalled();
    expect(fixture.spawnSsh).not.toHaveBeenCalled();
  });

  it("preserves a remote nonzero status while reducing remote diagnostics", async () => {
    const session = fakeChild((child) => {
      child.stderr.write("Authorization: Bearer secret\nACP request body");
      finishSession(child, 42);
    });
    const fixture = harness([probeChild(), session]);
    const io = streams();

    const result = await fixture.transport.run({
      gatewayName: "nemoclaw",
      sandboxName: "alpha",
      streams: io.value,
    });

    expect(result).toEqual({ kind: "completed", exitCode: 42 });
    expect(io.diagnostics.text()).toBe(
      "nemoclaw-acp: the remote adapter reported diagnostic output.\n",
    );
    expect(io.diagnostics.text()).not.toMatch(/Bearer|request body|secret/u);
    expect(fixture.cleanup).toHaveBeenCalledOnce();
  });

  it("preserves remote exit 255 without classifying it as an SSH failure (#10947)", async () => {
    const session = fakeChild((child) => {
      const frame = sessionStatusFrame(255);
      child.stderr.write(frame.slice(0, 19));
      child.stderr.write(frame.slice(19));
      child.finish(0);
    });
    const fixture = harness([probeChild(), session]);
    const io = streams();

    const result = await fixture.transport.run({
      gatewayName: "nemoclaw",
      sandboxName: "alpha",
      streams: io.value,
    });

    expect(result).toEqual({ kind: "completed", exitCode: 255 });
    expect(io.diagnostics.text()).toBe("");
    expect(fixture.cleanup).toHaveBeenCalledOnce();
  });

  it("terminates SSH when the ACP output consumer disconnects", async () => {
    const session = fakeChild((child) => {
      child.stdout.write("response");
    });
    const fixture = harness([probeChild(), session]);
    const output = collectingWritable({ fail: true });
    const diagnostics = collectingWritable();

    const result = await fixture.transport.run({
      gatewayName: "nemoclaw",
      sandboxName: "alpha",
      streams: {
        input: Readable.from(["request"]),
        output: output.stream,
        diagnostics: diagnostics.stream,
      },
    });

    expect(result).toMatchObject({ kind: "failed", error: { kind: "client_disconnect" } });
    expect(session.kill).toHaveBeenCalledWith("SIGTERM");
    expect(fixture.cleanup).toHaveBeenCalledOnce();
  });

  it("propagates AbortSignal cancellation and removes the temporary configuration", async () => {
    const session = fakeChild();
    const fixture = harness([probeChild(), session]);
    const controller = new AbortController();
    const io = streams();
    const pending = fixture.transport.run({
      gatewayName: "nemoclaw",
      sandboxName: "alpha",
      signal: controller.signal,
      streams: io.value,
    });
    await vi.waitFor(() => expect(fixture.spawnSsh).toHaveBeenCalledTimes(2));
    controller.abort();

    const result = await pending;

    expect(result).toMatchObject({ kind: "failed", error: { kind: "cancelled" } });
    expect(session.kill).toHaveBeenCalledWith("SIGTERM");
    expect(fixture.cleanup).toHaveBeenCalledOnce();
  });

  it("returns the SIGTERM exit code when AbortSignal cancels the compatibility probe", async () => {
    const probe = fakeChild();
    const fixture = harness([probe]);
    const controller = new AbortController();
    const io = streams();
    const pending = fixture.transport.run({
      gatewayName: "nemoclaw",
      sandboxName: "alpha",
      signal: controller.signal,
      streams: io.value,
    });
    await vi.waitFor(() => expect(fixture.spawnSsh).toHaveBeenCalledOnce());
    controller.abort();

    await expect(pending).resolves.toMatchObject({
      kind: "failed",
      error: { kind: "cancelled" },
      exitCode: 143,
    });
    expect(probe.kill).toHaveBeenCalledWith("SIGTERM");
    expect(fixture.cleanup).toHaveBeenCalledOnce();
  });

  it.each([
    ["SIGTERM" as const, 143],
    ["SIGINT" as const, 130],
  ])("forwards host %s and returns its conventional exit code", async (signal, exitCode) => {
    const signalEvents = new EventEmitter();
    const session = fakeChild();
    const fixture = harness([probeChild(), session], {
      signalSource: {
        add: (signal, listener) => signalEvents.on(signal, listener),
        remove: (signal, listener) => signalEvents.off(signal, listener),
      },
    });
    const io = streams();
    const pending = fixture.transport.run({
      gatewayName: "nemoclaw",
      sandboxName: "alpha",
      streams: io.value,
    });
    await vi.waitFor(() => expect(fixture.spawnSsh).toHaveBeenCalledTimes(2));
    signalEvents.emit(signal);

    const result = await pending;

    expect(result).toMatchObject({ kind: "failed", error: { kind: "cancelled" }, exitCode });
    expect(session.kill).toHaveBeenCalledWith(signal);
    expect(signalEvents.listenerCount("SIGTERM")).toBe(0);
    expect(signalEvents.listenerCount("SIGINT")).toBe(0);
  });

  it("reports session start only after SSH launches and before completion", async () => {
    const session = fakeChild();
    const fixture = harness([probeChild(), session]);
    const io = streams();
    const onSessionStarted = vi.fn();
    const pending = fixture.transport.run({
      gatewayName: "nemoclaw",
      sandboxName: "alpha",
      streams: io.value,
      onSessionStarted,
    });

    await vi.waitFor(() => expect(onSessionStarted).toHaveBeenCalledOnce());
    expect(session.exitCode).toBeNull();
    finishSession(session, 0);

    await expect(pending).resolves.toEqual({ kind: "completed", exitCode: 0 });
  });

  it("terminates a timed-out session and reports a bounded timeout", async () => {
    const session = fakeChild();
    const fixture = harness([probeChild(), session]);
    const io = streams();

    const result = await fixture.transport.run({
      gatewayName: "nemoclaw",
      sandboxName: "alpha",
      streams: io.value,
      timeoutMs: 5,
    });

    expect(result).toMatchObject({
      kind: "failed",
      error: { kind: "timeout" },
      exitCode: 124,
    });
    expect(session.kill).toHaveBeenCalledWith("SIGTERM");
    expect(fixture.cleanup).toHaveBeenCalledOnce();
  });

  it.each([
    ["SSH connection failure", probeChild("", 255), "transport"],
    ["incompatible runtime", probeChild("0.20.5\n0.9.0\n"), "incompatible"],
    ["oversized compatibility output", probeChild("x".repeat(5_000)), "incompatible"],
  ])("classifies %s and cleans the temporary configuration", async (_label, probe, kind) => {
    const fixture = harness([probe]);
    const io = streams();

    const result = await fixture.transport.run({
      gatewayName: "nemoclaw",
      sandboxName: "alpha",
      streams: io.value,
    });

    expect(result).toMatchObject({ kind: "failed", error: { kind } });
    expect(fixture.cleanup).toHaveBeenCalledOnce();
  });

  it("classifies a failed live SSH session and cleans the temporary configuration", async () => {
    const session = fakeChild((child) => child.finish(255));
    const fixture = harness([probeChild(), session]);
    const io = streams(Readable.from(["request"]));

    const result = await fixture.transport.run({
      gatewayName: "nemoclaw",
      sandboxName: "alpha",
      streams: io.value,
    });

    expect(result).toMatchObject({ kind: "failed", error: { kind: "transport" }, exitCode: 255 });
    expect(fixture.cleanup).toHaveBeenCalledOnce();
  });

  it("fails closed when SSH completes without a session-bound remote status (#10947)", async () => {
    const session = fakeChild((child) => child.finish(0));
    const fixture = harness([probeChild(), session]);
    const io = streams();

    const result = await fixture.transport.run({
      gatewayName: "nemoclaw",
      sandboxName: "alpha",
      streams: io.value,
    });

    expect(result).toMatchObject({
      kind: "failed",
      error: { kind: "transport" },
      exitCode: 255,
    });
    expect(fixture.cleanup).toHaveBeenCalledOnce();
  });

  it("reports cleanup failure with the retained credential path (#10947)", async () => {
    const cleanup = vi.fn(() => {
      throw new Error("remove failed");
    });
    const createTempConfig = vi.fn(() => ({
      dir: "/tmp/nemoclaw-acp-retained",
      file: "/tmp/nemoclaw-acp-retained/ssh_config",
      cleanup,
    }));
    const session = fakeChild((child) => finishSession(child, 0));
    const fixture = harness([probeChild(), session], { createTempConfig });
    const io = streams();

    const result = await fixture.transport.run({
      gatewayName: "nemoclaw",
      sandboxName: "alpha",
      streams: io.value,
    });

    expect(result).toEqual({
      kind: "failed",
      error: {
        kind: "cleanup",
        message:
          'NemoClaw could not remove the temporary SSH configuration at "/tmp/nemoclaw-acp-retained". Remove that directory before running nemoclaw-acp again.',
      },
      exitCode: 1,
    });
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("reports a retained path when temporary SSH configuration creation cannot clean up (#10947)", async () => {
    const createTempConfig = vi.fn(() => {
      throw new TempSshConfigCleanupError("/tmp/nemoclaw-acp-create-retained", new Error());
    });
    const fixture = harness([], { createTempConfig });
    const io = streams();

    const result = await fixture.transport.run({
      gatewayName: "nemoclaw",
      sandboxName: "alpha",
      streams: io.value,
    });

    expect(result).toMatchObject({
      kind: "failed",
      error: {
        kind: "cleanup",
        message: expect.stringContaining('"/tmp/nemoclaw-acp-create-retained"'),
      },
      exitCode: 1,
    });
    expect(fixture.spawnSsh).not.toHaveBeenCalled();
  });

  it.each([
    ["native Windows", { platform: "win32" as const }],
    ["a different OpenShell version", { openshellVersion: vi.fn(() => "0.0.105") }],
  ])("rejects %s before preparing SSH", async (_label, overrides) => {
    const fixture = harness([], overrides);
    const io = streams();

    const result = await fixture.transport.run({
      gatewayName: "nemoclaw",
      sandboxName: "alpha",
      streams: io.value,
    });

    expect(result).toMatchObject({ kind: "failed", error: { kind: "unavailable" } });
    expect(fixture.captureOpenShell).not.toHaveBeenCalled();
    expect(fixture.spawnSsh).not.toHaveBeenCalled();
  });

  it.each([
    ["compatibility probe", []],
    ["session", [probeChild()]],
  ])("cleans the temporary configuration when the %s cannot start", async (_label, children) => {
    const spawnSsh = vi.fn(() => children.shift() ?? throwSshSpawn());
    const fixture = harness([], { spawnSsh });
    const io = streams();

    const result = await fixture.transport.run({
      gatewayName: "nemoclaw",
      sandboxName: "alpha",
      streams: io.value,
    });

    expect(result).toMatchObject({ kind: "failed", error: { kind: "invocation" } });
    expect(fixture.cleanup).toHaveBeenCalledOnce();
  });

  it("rejects an endpoint override before reading OpenShell state", async () => {
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://untrusted.invalid");
    const captureOpenShell = vi.fn();
    const transport = createCliHermesAcpSshTransport({ captureOpenShell });
    const io = streams();

    await expect(
      transport.run({ gatewayName: "nemoclaw", sandboxName: "alpha", streams: io.value }),
    ).rejects.toThrow("OPENSHELL_GATEWAY_ENDPOINT is set");
    expect(captureOpenShell).not.toHaveBeenCalled();
  });
});
