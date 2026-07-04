// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  execTimeout,
  runWithEnv,
  testTimeout,
  testTimeoutOptions,
  writeHealthyDockerStub,
  writeRecordingCommand,
  writeSandboxRegistry,
} from "./helpers";

type GatewayControlDockerStubOptions = {
  callsFile: string;
  stateFile: string;
  recoveryStatus?: number;
};

function writeGatewayControlDockerStub(
  localBin: string,
  { callsFile, stateFile, recoveryStatus = 0 }: GatewayControlDockerStubOptions,
): void {
  fs.writeFileSync(
    path.join(localBin, "docker"),
    [
      "#!/usr/bin/env bash",
      `calls=${JSON.stringify(callsFile)}`,
      `state_file=${JSON.stringify(stateFile)}`,
      `recovery_status=${recoveryStatus}`,
      'printf \'%s\\n\' "$*" >> "$calls"',
      'if [ "$1" = "info" ]; then echo "24.0.0"; exit 0; fi',
      'if [ "$1" = "ps" ]; then',
      '  if [[ "$*" == *"{{.ID}}"* ]]; then',
      "    printf 'container-id\\topenshell-alpha\\n'",
      "  else",
      "    echo openshell-alpha",
      "  fi",
      "  exit 0",
      "fi",
      'if [ "$1" = "exec" ]; then',
      '  if [[ "$*" == *"/usr/local/bin/nemoclaw-gateway-control recover "* ]]; then',
      '    if [ "$recovery_status" -ne 0 ]; then',
      "      echo 'privileged gateway control failed' >&2",
      '      exit "$recovery_status"',
      "    fi",
      '    echo recovered > "$state_file"',
      "    echo 'GATEWAY_PID=123'",
      "    exit 0",
      "  fi",
      '  if [[ "$*" == *"curl -so"* ]]; then',
      "    echo '__NEMOCLAW_SANDBOX_EXEC_STARTED__'",
      '    if [ "$(cat "$state_file")" = recovered ]; then echo RUNNING; else echo STOPPED; fi',
      "    exit 0",
      "  fi",
      "fi",
      "exit 1",
    ].join("\n"),
    { mode: 0o755 },
  );
}

function expectGatewayControlRecovery(callsFile: string): void {
  const calls = fs.readFileSync(callsFile, "utf8");
  expect(calls).toContain(
    "ps --no-trunc --filter label=openshell.ai/managed-by=openshell " +
      "--filter label=openshell.ai/sandbox-name=alpha --format {{.ID}}\t{{.Names}}",
  );
  const recoveryCall = calls
    .split("\n")
    .find((line) => line.includes("/usr/local/bin/nemoclaw-gateway-control recover"));
  expect(recoveryCall).toBeDefined();
  expect(recoveryCall).toContain("--env LD_PRELOAD=");
  expect(recoveryCall).toContain("--env LD_LIBRARY_PATH=");
  expect(recoveryCall).toContain("--env LD_AUDIT=");
  expect(recoveryCall).toContain("--env PYTHONPATH=");
  expect(recoveryCall).toContain("--env PYTHONUSERBASE=");
  expect(recoveryCall).toContain("--env PYTHONNOUSERSITE=1");
  expect(recoveryCall).toMatch(
    /^exec (?:--env [A-Z0-9_]+=[^ ]* )+--user root container-id \/usr\/local\/bin\/nemoclaw-gateway-control recover [0-9a-f]{64}$/,
  );
  expect(calls).not.toContain("OPENCLAW=");
  expect(calls).not.toContain("base64 -d | sh");
}

async function startForwardListeners(ports: number[]): Promise<() => Promise<void>> {
  const script = [
    'const net = require("node:net");',
    "const ports = JSON.parse(process.argv[1]);",
    "const servers = [];",
    "let pending = ports.length;",
    "const markReady = () => { pending -= 1; if (pending === 0) process.stdout.write('ready\\n'); };",
    "for (const port of ports) {",
    "  const server = net.createServer((socket) => socket.end());",
    "  server.on('error', (error) => {",
    "    if (error.code === 'EADDRINUSE') { markReady(); return; }",
    "    console.error(error.stack || error);",
    "    process.exit(1);",
    "  });",
    "  server.listen(port, '127.0.0.1', () => {",
    "    servers.push(server);",
    "    markReady();",
    "  });",
    "}",
    "const shutdown = () => {",
    "  let remaining = servers.length;",
    "  if (remaining === 0) process.exit(0);",
    "  for (const server of servers) server.close(() => { if (--remaining === 0) process.exit(0); });",
    "  setTimeout(() => process.exit(0), 1000).unref();",
    "};",
    "process.on('SIGTERM', shutdown);",
  ].join("\n");
  const child = spawn(process.execPath, ["-e", script, JSON.stringify(ports)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`forward listener startup timed out: ${stderr}`)),
      2000,
    );
    const markReady = (): void => {
      clearTimeout(timer);
      resolve();
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (chunk.includes("ready") ? markReady() : undefined));
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`forward listener exited with ${code}: ${stderr}`));
    });
  });

  return async () => {
    await (child.exitCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          child.kill("SIGTERM");
          const timer = setTimeout(resolve, 1500);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        }));
  };
}

describe("CLI dispatch", () => {
  it("connect does not pre-start a duplicate port forward", testTimeoutOptions(15_000), () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-connect-forward-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const markerFile = path.join(home, "openshell-calls");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          alpha: {
            name: "alpha",
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        `marker_file=${JSON.stringify(markerFile)}`,
        'printf \'%s\\n\' "$*" >> "$marker_file"',
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Sandbox:'",
        "  echo",
        "  echo '  Id: abc'",
        "  echo '  Name: alpha'",
        "  echo '  Namespace: openshell'",
        "  echo '  Phase: Ready'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        "  echo 'alpha   Ready   2m ago'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "connect" ] && [ "$3" = "alpha" ]; then',
        "  exit 0",
        "fi",
        'if [ "$1" = "forward" ] && [ "$2" = "list" ]; then echo "alpha 127.0.0.1 18789 12345 running"; exit 0; fi',
        'if [ "$1" = "forward" ]; then exit 99; fi',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(localBin, "sleep"), ["#!/usr/bin/env bash", "exit 0"].join("\n"), {
      mode: 0o755,
    });

    const r = runWithEnv("alpha connect", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    const calls = fs.readFileSync(markerFile, "utf8").trim().split("\n").filter(Boolean);
    expect(calls).toContain("sandbox get alpha");
    expect(calls).toContain("sandbox connect alpha");
    expect(calls.some((call) => call.startsWith("forward start --background 18789"))).toBe(false);
  });

  it("shows connect help without opening an interactive session", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-connect-help-"));
    const localBin = path.join(home, "bin");
    const markerFile = path.join(home, "openshell-calls");
    const sshMarkerFile = path.join(home, "ssh-calls");
    fs.mkdirSync(localBin, { recursive: true });
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        `printf '%s\\n' "$*" >> ${JSON.stringify(markerFile)}`,
        "exit 99",
      ].join("\n"),
      { mode: 0o755 },
    );
    writeRecordingCommand(localBin, "ssh", sshMarkerFile, 98);

    const r = runWithEnv("alpha connect --help", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });
    const implicit = runWithEnv("alpha --help", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(r.out).toContain("Usage: nemoclaw alpha connect");
    expect(r.out).toContain("--probe-only");
    expect(implicit.code).toBe(0);
    expect(implicit.out).toContain("Usage: nemoclaw alpha connect");
    expect(fs.existsSync(markerFile)).toBe(false);
    expect(fs.existsSync(sshMarkerFile)).toBe(false);
  });

  it("rejects the removed skip-permissions connect flag", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-connect-probe-flags-"));
    const localBin = path.join(home, "bin");
    const markerFile = path.join(home, "openshell-calls");
    const sshMarkerFile = path.join(home, "ssh-calls");
    fs.mkdirSync(localBin, { recursive: true });
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        `printf '%s\\n' "$*" >> ${JSON.stringify(markerFile)}`,
        "exit 99",
      ].join("\n"),
      { mode: 0o755 },
    );
    writeRecordingCommand(localBin, "ssh", sshMarkerFile, 98);
    writeSandboxRegistry(home);

    const r = runWithEnv("alpha connect --dangerously-skip-permissions", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(1);
    expect(r.out).toContain("--dangerously-skip-permissions was removed");
    expect(fs.existsSync(markerFile)).toBe(false);
    expect(fs.existsSync(sshMarkerFile)).toBe(false);
  });

  it(
    "connect --probe-only recovers the gateway without opening SSH",
    testTimeoutOptions(15_000),
    async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-connect-probe-"));
      const localBin = path.join(home, "bin");
      const markerFile = path.join(home, "openshell-calls");
      const dockerCalls = path.join(home, "docker-calls");
      const sshMarkerFile = path.join(home, "ssh-calls");
      const stateFile = path.join(home, "probe-state");
      fs.mkdirSync(localBin, { recursive: true });
      writeSandboxRegistry(home);
      fs.writeFileSync(stateFile, "stopped");
      fs.writeFileSync(
        path.join(localBin, "openshell"),
        [
          "#!/usr/bin/env bash",
          `marker_file=${JSON.stringify(markerFile)}`,
          `state_file=${JSON.stringify(stateFile)}`,
          'printf \'%s\\n\' "$*" >> "$marker_file"',
          'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
          "  echo 'Sandbox:'",
          "  echo",
          "  echo '  Id: abc'",
          "  echo '  Name: alpha'",
          "  echo '  Namespace: openshell'",
          "  echo '  Phase: Ready'",
          "  exit 0",
          "fi",
          'if [ "$1" = "sandbox" ] && [ "$2" = "exec" ] && [ "$3" = "--name" ] && [ "$4" = "alpha" ]; then',
          '  cmd="$8"',
          '  case "$cmd" in',
          "    *'curl -so'*)",
          "      echo '__NEMOCLAW_SANDBOX_EXEC_STARTED__'",
          '      if [ "$(cat "$state_file")" = recovered ]; then echo RUNNING; else echo STOPPED; fi',
          "      exit 0",
          "      ;;",
          "  esac",
          "fi",
          'if [ "$1" = "forward" ] && [ "$2" = "list" ]; then echo "alpha 127.0.0.1 18789 12345 running"; exit 0; fi',
          'if [ "$1" = "forward" ]; then exit 99; fi',
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );
      writeGatewayControlDockerStub(localBin, { callsFile: dockerCalls, stateFile });
      writeRecordingCommand(localBin, "ssh", sshMarkerFile, 98);
      const stopForwardListeners = await startForwardListeners([18789]);

      try {
        const r = runWithEnv("alpha connect --probe-only", {
          HOME: home,
          PATH: `${localBin}:${process.env.PATH || ""}`,
        });

        expect(r.code).toBe(0);
        expect(r.out).toContain("Probe complete: recovered OpenClaw gateway");
        const calls = fs.readFileSync(markerFile, "utf8").trim().split("\n").filter(Boolean);
        expect(calls).toContain("sandbox get alpha");
        expect(calls.some((call) => call.startsWith("sandbox exec --name alpha -- sh -c"))).toBe(
          true,
        );
        expect(calls).not.toContain("sandbox ssh-config alpha");
        expect(calls).not.toContain("sandbox connect alpha");
        expect(fs.existsSync(sshMarkerFile)).toBe(false);
        expectGatewayControlRecovery(dockerCalls);
      } finally {
        await stopForwardListeners();
      }
    },
  );

  it("uses the authenticated recovery marker as the initial managed health proof", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-connect-probe-wait-"));
    const localBin = path.join(home, "bin");
    const markerFile = path.join(home, "openshell-calls");
    const dockerCalls = path.join(home, "docker-calls");
    const stateFile = path.join(home, "probe-state");
    const readyCountFile = path.join(home, "ready-count");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home);
    fs.writeFileSync(stateFile, "stopped");
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        `marker_file=${JSON.stringify(markerFile)}`,
        `state_file=${JSON.stringify(stateFile)}`,
        `ready_count_file=${JSON.stringify(readyCountFile)}`,
        'printf \'%s\\n\' "$*" >> "$marker_file"',
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Sandbox:'",
        "  echo",
        "  echo '  Id: abc'",
        "  echo '  Name: alpha'",
        "  echo '  Namespace: openshell'",
        "  echo '  Phase: Ready'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "exec" ] && [ "$3" = "--name" ] && [ "$4" = "alpha" ]; then',
        '  cmd="$8"',
        '  case "$cmd" in',
        "    *'curl -so'*)",
        "      echo '__NEMOCLAW_SANDBOX_EXEC_STARTED__'",
        '      if [ "$(cat "$state_file")" != recovered ]; then echo STOPPED; exit 0; fi',
        '      count=$(cat "$ready_count_file" 2>/dev/null || echo 0)',
        "      count=$((count + 1))",
        '      echo "$count" > "$ready_count_file"',
        '      if [ "$count" -ge 3 ]; then echo RUNNING; else echo STOPPED; fi',
        "      exit 0",
        "      ;;",
        "  esac",
        "fi",
        'if [ "$1" = "forward" ] && [ "$2" = "list" ]; then echo "alpha 127.0.0.1 18789 12345 running"; exit 0; fi',
        'if [ "$1" = "forward" ]; then exit 99; fi',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    writeGatewayControlDockerStub(localBin, { callsFile: dockerCalls, stateFile });
    const stopForwardListeners = await startForwardListeners([18789]);

    try {
      const r = runWithEnv("alpha connect --probe-only", {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
        NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS: "3",
        NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS: "0",
      });

      expect(r.code).toBe(0);
      expect(r.out).toContain("Probe complete: recovered OpenClaw gateway");
      expect(fs.existsSync(readyCountFile)).toBe(false);
      expectGatewayControlRecovery(dockerCalls);
    } finally {
      await stopForwardListeners();
    }
  });

  it("treats leading --probe-only as an implicit connect probe", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-connect-probe-leading-"));
    const localBin = path.join(home, "bin");
    const markerFile = path.join(home, "openshell-calls");
    const sshMarkerFile = path.join(home, "ssh-calls");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home);
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        `marker_file=${JSON.stringify(markerFile)}`,
        'printf \'%s\\n\' "$*" >> "$marker_file"',
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Sandbox:'",
        "  echo",
        "  echo '  Id: abc'",
        "  echo '  Name: alpha'",
        "  echo '  Namespace: openshell'",
        "  echo '  Phase: Ready'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "exec" ] && [ "$3" = "--name" ] && [ "$4" = "alpha" ]; then',
        '  cmd="$8"',
        '  if [[ "$cmd" == *"curl -so"* ]]; then echo "__NEMOCLAW_SANDBOX_EXEC_STARTED__"; echo RUNNING; exit 0; fi',
        "fi",
        'if [ "$1" = "forward" ] && [ "$2" = "list" ]; then echo "alpha 127.0.0.1 18789 12345 running"; exit 0; fi',
        'if [ "$1" = "forward" ]; then exit 99; fi',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    writeRecordingCommand(localBin, "ssh", sshMarkerFile, 98);
    const stopForwardListeners = await startForwardListeners([18789]);

    try {
      const r = runWithEnv("alpha --probe-only", {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      });

      expect(r.code).toBe(0);
      expect(r.out).toContain("Probe complete: OpenClaw gateway is running");
      const calls = fs.readFileSync(markerFile, "utf8").trim().split("\n").filter(Boolean);
      expect(calls).toContain("sandbox get alpha");
      expect(calls.some((call) => call.startsWith("sandbox exec --name alpha -- sh -c"))).toBe(
        true,
      );
      expect(calls).not.toContain("sandbox ssh-config alpha");
      expect(calls).not.toContain("sandbox connect alpha");
      expect(fs.existsSync(sshMarkerFile)).toBe(false);
    } finally {
      await stopForwardListeners();
    }
  });

  it("connect --probe-only does not retry failed privileged recovery over SSH", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-connect-probe-no-ssh-"));
    const localBin = path.join(home, "bin");
    const markerFile = path.join(home, "openshell-calls");
    const dockerCalls = path.join(home, "docker-calls");
    const sshMarkerFile = path.join(home, "ssh-calls");
    const stateFile = path.join(home, "probe-state");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home);
    fs.writeFileSync(stateFile, "stopped");
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        `marker_file=${JSON.stringify(markerFile)}`,
        'printf \'%s\\n\' "$*" >> "$marker_file"',
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Sandbox:'",
        "  echo",
        "  echo '  Id: abc'",
        "  echo '  Name: alpha'",
        "  echo '  Namespace: openshell'",
        "  echo '  Phase: Ready'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "exec" ] && [ "$3" = "--name" ] && [ "$4" = "alpha" ]; then',
        '  cmd="$8"',
        '  if [[ "$cmd" == *"curl -so"* ]]; then echo "__NEMOCLAW_SANDBOX_EXEC_STARTED__"; echo STOPPED; exit 0; fi',
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "ssh-config" ]; then',
        "  echo 'Host openshell-alpha'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    writeGatewayControlDockerStub(localBin, {
      callsFile: dockerCalls,
      stateFile,
      recoveryStatus: 42,
    });
    writeRecordingCommand(localBin, "ssh", sshMarkerFile, 98);

    const r = runWithEnv("alpha connect --probe-only", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(1);
    const calls = fs.readFileSync(markerFile, "utf8").trim().split("\n").filter(Boolean);
    expect(calls).toContain("sandbox get alpha");
    expect(calls.some((call) => call.startsWith("sandbox exec --name alpha -- sh -c"))).toBe(true);
    expect(calls).not.toContain("sandbox ssh-config alpha");
    expect(fs.existsSync(sshMarkerFile)).toBe(false);
    expectGatewayControlRecovery(dockerCalls);
  });

  it(
    "connect --probe-only does not fall back to SSH when sandbox exec never starts",
    testTimeoutOptions(15_000),
    () => {
      const home = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-cli-connect-probe-exec-fallback-"),
      );
      const localBin = path.join(home, "bin");
      const openshellCalls = path.join(home, "openshell-calls");
      const dockerCalls = path.join(home, "docker-calls");
      const sshCalls = path.join(home, "ssh-calls");
      const stateFile = path.join(home, "probe-state");
      fs.mkdirSync(localBin, { recursive: true });
      writeSandboxRegistry(home);
      fs.writeFileSync(stateFile, "stopped");
      fs.writeFileSync(
        path.join(localBin, "openshell"),
        [
          "#!/usr/bin/env bash",
          `calls=${JSON.stringify(openshellCalls)}`,
          'printf \'%s\\n\' "$*" >> "$calls"',
          'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
          "  echo 'Sandbox:'",
          "  echo",
          "  echo '  Id: abc'",
          "  echo '  Name: alpha'",
          "  echo '  Namespace: openshell'",
          "  echo '  Phase: Ready'",
          "  exit 0",
          "fi",
          'if [ "$1" = "sandbox" ] && [ "$2" = "exec" ]; then',
          "  echo 'error: sandbox exec transport failed before command start' >&2",
          "  exit 2",
          "fi",
          'if [ "$1" = "forward" ] && [ "$2" = "list" ]; then echo "alpha 127.0.0.1 18789 12345 running"; exit 0; fi',
          'if [ "$1" = "forward" ]; then exit 99; fi',
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );
      writeGatewayControlDockerStub(localBin, {
        callsFile: dockerCalls,
        stateFile,
        recoveryStatus: 42,
      });
      writeRecordingCommand(localBin, "ssh", sshCalls, 98);

      const r = runWithEnv("alpha connect --probe-only", {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      });

      expect(r.code).toBe(1);
      const openshellLog = fs.readFileSync(openshellCalls, "utf8");
      expect(openshellLog).toContain("sandbox exec --name alpha -- sh -c");
      expect(openshellLog).not.toContain("sandbox ssh-config alpha");
      expect(openshellLog).not.toContain("sandbox connect");
      expect(fs.existsSync(sshCalls)).toBe(false);
      expectGatewayControlRecovery(dockerCalls);
    },
  );

  it(
    "connect --probe-only does not fall back to SSH when sandbox exec times out after starting",
    testTimeoutOptions(15_000),
    () => {
      const home = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-cli-connect-probe-exec-timeout-"),
      );
      const localBin = path.join(home, "bin");
      const openshellCalls = path.join(home, "openshell-calls");
      const dockerCalls = path.join(home, "docker-calls");
      const sshCalls = path.join(home, "ssh-calls");
      const stateFile = path.join(home, "probe-state");
      fs.mkdirSync(localBin, { recursive: true });
      writeSandboxRegistry(home);
      fs.writeFileSync(stateFile, "stopped");
      fs.writeFileSync(
        path.join(localBin, "openshell"),
        [
          "#!/usr/bin/env bash",
          `calls=${JSON.stringify(openshellCalls)}`,
          'printf \'%s\\n\' "$*" >> "$calls"',
          'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
          "  echo 'Sandbox:'",
          "  echo",
          "  echo '  Id: abc'",
          "  echo '  Name: alpha'",
          "  echo '  Namespace: openshell'",
          "  echo '  Phase: Ready'",
          "  exit 0",
          "fi",
          'if [ "$1" = "sandbox" ] && [ "$2" = "exec" ]; then',
          "  echo '__NEMOCLAW_SANDBOX_EXEC_STARTED__'",
          "  sleep 1",
          "  exit 0",
          "fi",
          'if [ "$1" = "forward" ] && [ "$2" = "list" ]; then echo "alpha 127.0.0.1 18789 12345 running"; exit 0; fi',
          'if [ "$1" = "forward" ]; then exit 99; fi',
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );
      writeGatewayControlDockerStub(localBin, {
        callsFile: dockerCalls,
        stateFile,
        recoveryStatus: 42,
      });
      writeRecordingCommand(localBin, "ssh", sshCalls, 98);

      const r = runWithEnv("alpha connect --probe-only", {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
        NEMOCLAW_SANDBOX_EXEC_TIMEOUT_MS: "50",
      });

      expect(r.code).toBe(1);
      const openshellLog = fs.readFileSync(openshellCalls, "utf8");
      expect(openshellLog).toContain("sandbox exec --name alpha -- sh -c");
      expect(openshellLog).not.toContain("sandbox ssh-config alpha");
      expect(fs.existsSync(sshCalls)).toBe(false);
      expectGatewayControlRecovery(dockerCalls);
    },
  );

  it("recovers stopped Hermes agents through privileged Docker control instead of SSH", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-connect-probe-agent-"));
    const localBin = path.join(home, "bin");
    const openshellCalls = path.join(home, "openshell-calls");
    const dockerCalls = path.join(home, "docker-calls");
    const sshCalls = path.join(home, "ssh-calls");
    const stateFile = path.join(home, "probe-state");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home, { agent: "hermes" });
    fs.writeFileSync(stateFile, "stopped");
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        `calls=${JSON.stringify(openshellCalls)}`,
        `state_file=${JSON.stringify(stateFile)}`,
        'printf \'%s\\n\' "$*" >> "$calls"',
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Sandbox:'",
        "  echo",
        "  echo '  Id: abc'",
        "  echo '  Name: alpha'",
        "  echo '  Namespace: openshell'",
        "  echo '  Phase: Ready'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "exec" ] && [ "$3" = "--name" ] && [ "$4" = "alpha" ]; then',
        '  cmd="$8"',
        '  if [[ "$cmd" == *"curl -so"* ]]; then',
        "    echo '__NEMOCLAW_SANDBOX_EXEC_STARTED__'",
        '    if [ "$(cat "$state_file")" = recovered ]; then echo RUNNING; else echo STOPPED; fi',
        "    exit 0",
        "  fi",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "ssh-config" ] && [ "$3" = "alpha" ]; then',
        '  echo UNEXPECTED_SSH_CONFIG >> "$calls"',
        "  exit 1",
        "fi",
        'if [ "$1" = "forward" ] && [ "$2" = "list" ]; then { echo "alpha 127.0.0.1 18789 12345 running"; echo "alpha 127.0.0.1 8642 12346 running"; }; exit 0; fi',
        'if [ "$1" = "forward" ]; then exit 99; fi',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    writeGatewayControlDockerStub(localBin, { callsFile: dockerCalls, stateFile });
    writeRecordingCommand(localBin, "ssh", sshCalls, 98);
    const stopForwardListeners = await startForwardListeners([18789, 8642]);

    try {
      const r = runWithEnv("alpha connect --probe-only", {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      });

      expect(r.code).toBe(0);
      expect(r.out).toContain("Probe complete: recovered Hermes Agent gateway");
      const openshellLog = fs.readFileSync(openshellCalls, "utf8");
      expect(openshellLog).toContain("sandbox exec --name alpha -- sh -c");
      expect(openshellLog).not.toContain("sandbox ssh-config alpha");
      expect(openshellLog).not.toContain("sandbox connect");
      expect(fs.existsSync(sshCalls)).toBe(false);
      expectGatewayControlRecovery(dockerCalls);
    } finally {
      await stopForwardListeners();
    }
  });

  it("preserves the registry entry when connect targets a missing live sandbox (#4497)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-stale-connect-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          alpha: {
            name: "alpha",
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Error: status: NotFound, message: \"sandbox not found\"' >&2",
        "  exit 1",
        "fi",
        // Simulate a healthy, active `nemoclaw` named gateway so the
        // lifecycle guard confirms healthy_named. Even on this path connect
        // must now preserve the entry so a follow-up rebuild can recover it
        // (#4497); it previously removed it here (#2276).
        'if [ "$1" = "status" ]; then',
        "  printf 'Server Status\\n\\n  Gateway: nemoclaw\\n  Status: Connected\\n'",
        "  exit 0",
        "fi",
        'if [ "$1" = "gateway" ] && [ "$2" = "info" ]; then',
        "  printf 'Gateway: nemoclaw\\n'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha connect", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(1);
    expect(r.out.includes("Removed stale local registry entry")).toBe(false);
    expect(r.out.includes("registered locally, but is not present")).toBeTruthy();
    expect(r.out.includes("preserved")).toBeTruthy();
    const saved = JSON.parse(fs.readFileSync(path.join(registryDir, "sandboxes.json"), "utf8"));
    expect(saved.sandboxes.alpha).toBeDefined();
  });

  it("recovers a missing registry entry from the last onboard session during list", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-list-session-recover-"));
    const localBin = path.join(home, "bin");
    const nemoclawDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(nemoclawDir, { recursive: true });
    fs.writeFileSync(
      path.join(nemoclawDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          gamma: {
            name: "gamma",
            model: "existing-model",
            provider: "existing-provider",
            gpuEnabled: false,
            policies: ["npm"],
          },
        },
        defaultSandbox: "gamma",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(nemoclawDir, "onboard-session.json"),
      JSON.stringify(
        {
          version: 1,
          sessionId: "session-1",
          resumable: true,
          status: "complete",
          mode: "interactive",
          startedAt: "2026-03-31T00:00:00.000Z",
          updatedAt: "2026-03-31T00:00:00.000Z",
          lastStepStarted: "policies",
          lastCompletedStep: "policies",
          failure: null,
          sandboxName: "alpha",
          provider: "nvidia-prod",
          model: "nvidia/nemotron-3-super-120b-a12b",
          endpointUrl: null,
          credentialEnv: null,
          preferredInferenceApi: null,
          nimContainer: null,
          policyPresets: ["pypi"],
          metadata: { gatewayName: "nemoclaw" },
          steps: {
            preflight: { status: "complete", startedAt: null, completedAt: null, error: null },
            gateway: { status: "complete", startedAt: null, completedAt: null, error: null },
            sandbox: { status: "complete", startedAt: null, completedAt: null, error: null },
            provider_selection: {
              status: "complete",
              startedAt: null,
              completedAt: null,
              error: null,
            },
            inference: { status: "complete", startedAt: null, completedAt: null, error: null },
            openclaw: { status: "complete", startedAt: null, completedAt: null, error: null },
            policies: { status: "complete", startedAt: null, completedAt: null, error: null },
          },
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "status" ]; then',
        "  echo 'Server Status'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  echo '  Status: Connected'",
        "  exit 0",
        "fi",
        'if [ "$1" = "gateway" ] && [ "$2" = "info" ]; then',
        "  echo 'Gateway Info'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        "  echo 'NAME           STATUS     AGE'",
        "  echo 'alpha          Ready      2m ago'",
        "  exit 0",
        "fi",
        'if [ "$1" = "inference" ] && [ "$2" = "get" ]; then',
        "  exit 0",
        "fi",
        'if [ "$1" = "--version" ]; then',
        "  echo 'openshell 0.0.16'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("list", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(
      r.out.includes("Recovered sandbox inventory from the last onboard session."),
    ).toBeTruthy();
    expect(r.out.includes("alpha")).toBeTruthy();
    expect(r.out.includes("gamma")).toBeTruthy();
    const saved = JSON.parse(fs.readFileSync(path.join(nemoclawDir, "sandboxes.json"), "utf8"));
    expect(saved.sandboxes.alpha).toBeTruthy();
    expect(saved.sandboxes.alpha.policies).toEqual(["pypi"]);
    expect(saved.sandboxes.gamma).toBeTruthy();
    expect(saved.defaultSandbox).toBe("gamma");
  });

  it("imports additional live sandboxes into the registry during list recovery", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-list-live-recover-"));
    const localBin = path.join(home, "bin");
    const nemoclawDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(nemoclawDir, { recursive: true });
    fs.writeFileSync(
      path.join(nemoclawDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          gamma: {
            name: "gamma",
            model: "existing-model",
            provider: "existing-provider",
            gpuEnabled: false,
            policies: ["npm"],
          },
        },
        defaultSandbox: "gamma",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(nemoclawDir, "onboard-session.json"),
      JSON.stringify(
        {
          version: 1,
          sessionId: "session-1",
          resumable: true,
          status: "complete",
          mode: "interactive",
          startedAt: "2026-03-31T00:00:00.000Z",
          updatedAt: "2026-03-31T00:00:00.000Z",
          lastStepStarted: "policies",
          lastCompletedStep: "policies",
          failure: null,
          sandboxName: "alpha",
          provider: "nvidia-prod",
          model: "nvidia/nemotron-3-super-120b-a12b",
          endpointUrl: null,
          credentialEnv: null,
          preferredInferenceApi: null,
          nimContainer: null,
          policyPresets: ["pypi"],
          metadata: { gatewayName: "nemoclaw" },
          steps: {
            preflight: { status: "complete", startedAt: null, completedAt: null, error: null },
            gateway: { status: "complete", startedAt: null, completedAt: null, error: null },
            sandbox: { status: "complete", startedAt: null, completedAt: null, error: null },
            provider_selection: {
              status: "complete",
              startedAt: null,
              completedAt: null,
              error: null,
            },
            inference: { status: "complete", startedAt: null, completedAt: null, error: null },
            openclaw: { status: "complete", startedAt: null, completedAt: null, error: null },
            policies: { status: "complete", startedAt: null, completedAt: null, error: null },
          },
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "status" ]; then',
        "  echo 'Server Status'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  echo '  Status: Connected'",
        "  exit 0",
        "fi",
        'if [ "$1" = "gateway" ] && [ "$2" = "info" ]; then',
        "  echo 'Gateway Info'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        "  echo 'NAME        PHASE'",
        "  echo 'alpha       Ready'",
        "  echo 'beta        Ready'",
        "  exit 0",
        "fi",
        'if [ "$1" = "inference" ] && [ "$2" = "get" ]; then',
        "  exit 0",
        "fi",
        'if [ "$1" = "--version" ]; then',
        "  echo 'openshell 0.0.16'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("list", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(
      r.out.includes("Recovered sandbox inventory from the last onboard session."),
    ).toBeTruthy();
    expect(
      r.out.includes("Recovered 1 sandbox entry from the live OpenShell gateway."),
    ).toBeTruthy();
    expect(r.out.includes("alpha")).toBeTruthy();
    expect(r.out.includes("beta")).toBeTruthy();
    expect(r.out.includes("gamma")).toBeTruthy();
    const saved = JSON.parse(fs.readFileSync(path.join(nemoclawDir, "sandboxes.json"), "utf8"));
    expect(saved.sandboxes.alpha).toBeTruthy();
    expect(saved.sandboxes.alpha.policies).toEqual(["pypi"]);
    expect(saved.sandboxes.beta).toBeTruthy();
    expect(saved.sandboxes.gamma).toBeTruthy();
    expect(saved.defaultSandbox).toBe("gamma");
  });

  it("skips invalid recovered sandbox names during list recovery", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-list-invalid-recover-"));
    const localBin = path.join(home, "bin");
    const nemoclawDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(nemoclawDir, { recursive: true });
    fs.writeFileSync(
      path.join(nemoclawDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          gamma: {
            name: "gamma",
            model: "existing-model",
            provider: "existing-provider",
            gpuEnabled: false,
            policies: ["npm"],
          },
        },
        defaultSandbox: "gamma",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(nemoclawDir, "onboard-session.json"),
      JSON.stringify(
        {
          version: 1,
          sessionId: "session-1",
          resumable: true,
          status: "complete",
          mode: "interactive",
          startedAt: "2026-03-31T00:00:00.000Z",
          updatedAt: "2026-03-31T00:00:00.000Z",
          lastStepStarted: "policies",
          lastCompletedStep: "policies",
          failure: null,
          sandboxName: "Alpha",
          provider: "nvidia-prod",
          model: "nvidia/nemotron-3-super-120b-a12b",
          endpointUrl: null,
          credentialEnv: null,
          preferredInferenceApi: null,
          nimContainer: null,
          policyPresets: ["pypi"],
          metadata: { gatewayName: "nemoclaw" },
          steps: {
            preflight: { status: "complete", startedAt: null, completedAt: null, error: null },
            gateway: { status: "complete", startedAt: null, completedAt: null, error: null },
            sandbox: { status: "complete", startedAt: null, completedAt: null, error: null },
            provider_selection: {
              status: "complete",
              startedAt: null,
              completedAt: null,
              error: null,
            },
            inference: { status: "complete", startedAt: null, completedAt: null, error: null },
            openclaw: { status: "complete", startedAt: null, completedAt: null, error: null },
            policies: { status: "complete", startedAt: null, completedAt: null, error: null },
          },
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "status" ]; then',
        "  echo 'Server Status'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  echo '  Status: Connected'",
        "  exit 0",
        "fi",
        'if [ "$1" = "gateway" ] && [ "$2" = "info" ]; then',
        "  echo 'Gateway Info'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        "  echo 'NAME        PHASE'",
        "  echo 'alpha       Ready'",
        "  echo 'Bad_Name    Ready'",
        "  exit 0",
        "fi",
        'if [ "$1" = "inference" ] && [ "$2" = "get" ]; then',
        "  exit 0",
        "fi",
        'if [ "$1" = "--version" ]; then',
        "  echo 'openshell 0.0.16'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("list", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(r.out.includes("alpha")).toBeTruthy();
    expect(r.out.includes("Bad_Name")).toBeFalsy();
    const saved = JSON.parse(fs.readFileSync(path.join(nemoclawDir, "sandboxes.json"), "utf8"));
    expect(saved.sandboxes.alpha).toBeTruthy();
    expect(saved.sandboxes.Bad_Name).toBeUndefined();
    expect(saved.sandboxes.Alpha).toBeUndefined();
    expect(saved.sandboxes.gamma).toBeTruthy();
  });

  it("connect recovers a named sandbox from the last onboard session when the registry is empty", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-connect-recover-session-"));
    const localBin = path.join(home, "bin");
    const nemoclawDir = path.join(home, ".nemoclaw");
    const markerFile = path.join(home, "connect-args");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(nemoclawDir, { recursive: true });
    fs.writeFileSync(
      path.join(nemoclawDir, "onboard-session.json"),
      JSON.stringify(
        {
          version: 1,
          sessionId: "session-1",
          resumable: true,
          status: "complete",
          mode: "interactive",
          startedAt: "2026-03-31T00:00:00.000Z",
          updatedAt: "2026-03-31T00:00:00.000Z",
          lastStepStarted: "policies",
          lastCompletedStep: "policies",
          failure: null,
          sandboxName: "alpha",
          provider: "nvidia-prod",
          model: "nvidia/nemotron-3-super-120b-a12b",
          endpointUrl: null,
          credentialEnv: null,
          preferredInferenceApi: null,
          nimContainer: null,
          policyPresets: null,
          metadata: { gatewayName: "nemoclaw" },
          steps: {
            preflight: { status: "complete", startedAt: null, completedAt: null, error: null },
            gateway: { status: "complete", startedAt: null, completedAt: null, error: null },
            sandbox: { status: "complete", startedAt: null, completedAt: null, error: null },
            provider_selection: {
              status: "complete",
              startedAt: null,
              completedAt: null,
              error: null,
            },
            inference: { status: "complete", startedAt: null, completedAt: null, error: null },
            openclaw: { status: "complete", startedAt: null, completedAt: null, error: null },
            policies: { status: "complete", startedAt: null, completedAt: null, error: null },
          },
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        `marker_file=${JSON.stringify(markerFile)}`,
        'printf \'%s\\n\' "$*" >> "$marker_file"',
        'if [ "$1" = "status" ]; then',
        "  echo 'Server Status'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  echo '  Status: Connected'",
        "  exit 0",
        "fi",
        'if [ "$1" = "gateway" ] && [ "$2" = "info" ]; then',
        "  echo 'Gateway Info'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        "  echo 'NAME           STATUS     AGE'",
        "  echo 'alpha          Ready      2m ago'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Sandbox:'",
        "  echo",
        "  echo '  Id: abc'",
        "  echo '  Name: alpha'",
        "  echo '  Namespace: openshell'",
        "  echo '  Phase: Ready'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "connect" ] && [ "$3" = "alpha" ]; then',
        "  exit 0",
        "fi",
        'if [ "$1" = "--version" ]; then',
        "  echo 'openshell 0.0.16'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha connect", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    const log = fs.readFileSync(markerFile, "utf8");
    expect(log.includes("sandbox list")).toBeTruthy();
    expect(log.includes("sandbox get alpha")).toBeTruthy();
    expect(log.includes("sandbox connect alpha")).toBeTruthy();
  });

  it("connect surfaces sandbox-not-found when recovery cannot find the requested sandbox (#2164)", () => {
    const home = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-cli-connect-unknown-after-recovery-"),
    );
    const localBin = path.join(home, "bin");
    const nemoclawDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(nemoclawDir, { recursive: true });
    fs.writeFileSync(
      path.join(nemoclawDir, "onboard-session.json"),
      JSON.stringify(
        {
          version: 1,
          sessionId: "session-1",
          resumable: true,
          status: "complete",
          mode: "interactive",
          startedAt: "2026-03-31T00:00:00.000Z",
          updatedAt: "2026-03-31T00:00:00.000Z",
          lastStepStarted: "policies",
          lastCompletedStep: "policies",
          failure: null,
          sandboxName: "alpha",
          provider: "nvidia-prod",
          model: "nvidia/nemotron-3-super-120b-a12b",
          endpointUrl: null,
          credentialEnv: null,
          preferredInferenceApi: null,
          nimContainer: null,
          policyPresets: null,
          metadata: { gatewayName: "nemoclaw" },
          steps: {
            preflight: { status: "complete", startedAt: null, completedAt: null, error: null },
            gateway: { status: "complete", startedAt: null, completedAt: null, error: null },
            sandbox: { status: "complete", startedAt: null, completedAt: null, error: null },
            provider_selection: {
              status: "complete",
              startedAt: null,
              completedAt: null,
              error: null,
            },
            inference: { status: "complete", startedAt: null, completedAt: null, error: null },
            openclaw: { status: "complete", startedAt: null, completedAt: null, error: null },
            policies: { status: "complete", startedAt: null, completedAt: null, error: null },
          },
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "status" ]; then',
        "  echo 'Server Status'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  echo '  Status: Connected'",
        "  exit 0",
        "fi",
        'if [ "$1" = "gateway" ] && [ "$2" = "info" ]; then',
        "  echo 'Gateway Info'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        "  echo 'No sandboxes found.'",
        "  exit 0",
        "fi",
        'if [ "$1" = "--version" ]; then',
        "  echo 'openshell 0.0.16'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("beta connect", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(1);
    expect(r.out.includes("Sandbox 'beta' does not exist")).toBeTruthy();
    // Recovery from onboard-session.json restores "alpha" into the local registry,
    // so the helper lists it rather than the empty-registry onboard hint.
    expect(r.out.includes("Registered sandboxes: alpha")).toBeTruthy();
  });
});
