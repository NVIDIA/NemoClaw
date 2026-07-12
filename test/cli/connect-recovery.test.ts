// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  runWithEnv,
  testTimeoutOptions,
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

describe("CLI connect recovery process contracts", () => {
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
        const result = runWithEnv("alpha connect --probe-only", {
          HOME: home,
          PATH: `${localBin}:${process.env.PATH || ""}`,
        });

        expect(result.code).toBe(0);
        expect(result.out).toContain("Probe complete: recovered OpenClaw gateway");
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

  it(
    "fails closed when privileged gateway recovery exits non-zero",
    testTimeoutOptions(15_000),
    async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-connect-probe-failure-"));
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
      const stopForwardListeners = await startForwardListeners([18789]);

      try {
        const result = runWithEnv("alpha connect --probe-only", {
          HOME: home,
          PATH: `${localBin}:${process.env.PATH || ""}`,
        });

        expect(result.code).toBe(1);
        expect(fs.readFileSync(stateFile, "utf8")).toBe("stopped");
        const openshellLog = fs.readFileSync(openshellCalls, "utf8");
        expect(openshellLog).toContain("sandbox exec --name alpha -- sh -c");
        expect(openshellLog).not.toContain("sandbox ssh-config alpha");
        expect(openshellLog).not.toContain("sandbox connect alpha");
        expect(fs.existsSync(sshCalls)).toBe(false);
        expectGatewayControlRecovery(dockerCalls);
      } finally {
        await stopForwardListeners();
      }
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
      const result = runWithEnv("alpha connect --probe-only", {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      });

      expect(result.code).toBe(0);
      expect(result.out).toContain("Probe complete: recovered Hermes Agent gateway");
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
        'if [ "$1" = "sandbox" ] && [ "$2" = "exec" ] && [ "$3" = "--name" ] && [ "$4" = "alpha" ]; then',
        "  echo 'OK 200'",
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

    const result = runWithEnv("alpha connect", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(result.code).toBe(0);
    const calls = fs.readFileSync(markerFile, "utf8");
    expect(calls).toContain("sandbox list");
    expect(calls).toContain("sandbox get alpha");
    expect(calls).toContain("sandbox connect alpha");
    const recoveredRegistry = JSON.parse(
      fs.readFileSync(path.join(nemoclawDir, "sandboxes.json"), "utf8"),
    );
    expect(recoveredRegistry.sandboxes.alpha).toEqual(
      expect.objectContaining({
        model: "nvidia/nemotron-3-super-120b-a12b",
        provider: "nvidia-prod",
      }),
    );
  });
});
