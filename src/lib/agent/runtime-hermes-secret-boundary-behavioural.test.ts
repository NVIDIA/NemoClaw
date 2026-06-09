// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Behavioural tests for the Hermes recovery boundary guards. These spawn `bash`
// on the synthesised shell snippets or full recovery scripts with stubbed
// `python3`/`pkill`/`pgrep`/`curl`/`hermes` binaries and assert real exit codes,
// kill invocations, and persisted `/tmp/gateway-recovery.log` contents. Pure
// generated-shell shape assertions live in
// runtime-hermes-secret-boundary-shape.test.ts.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it, expect } from "vitest";
import {
  HERMES_SECRET_BOUNDARY_VALIDATOR_PATH,
  __testing,
} from "../../../dist/lib/agent/hermes-recovery-boundary";
import { buildRecoveryScript } from "../../../dist/lib/agent/runtime";
import { hermesAgent } from "./hermes-recovery-boundary-fixtures";

function writeStub(dir: string, name: string, body: string) {
  const stub = path.join(dir, name);
  fs.writeFileSync(stub, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  return stub;
}

const SHARED_PYTHON_STUB_BY_MODE = [
  'if [ "$1" = "-c" ]; then',
  "  exit 0",
  "fi",
  'mode="$2"',
  'if [ "$mode" = "env-file" ]; then',
  '  if [ "${STUB_ENVFILE_EXIT:-0}" = "1" ]; then',
  '    printf "[SECURITY] Refusing Hermes startup because /sandbox/.hermes/.env contains raw secret-shaped values.\\n" >&2',
  '    printf "[SECURITY]   TELEGRAM_BOT_TOKEN (line 2)\\n" >&2',
  "    exit 1",
  "  fi",
  "  exit 0",
  "fi",
  'if [ "$mode" = "runtime-env" ]; then',
  '  if [ "${STUB_RUNTIMEENV_EXIT:-0}" = "1" ]; then',
  '    printf "[SECURITY] Refusing Hermes startup because the process environment contains raw secret-shaped values.\\n" >&2',
  '    printf "[SECURITY]   TELEGRAM_BOT_TOKEN\\n" >&2',
  "    exit 1",
  "  fi",
  "  exit 0",
  "fi",
  "exit 2",
].join("\n");

describe("Hermes secret-boundary guard — guard snippet behaviour", () => {
  function runGuard(opts: { guard: string; pythonExit: 0 | 1; validatorExists: boolean }) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-guard-"));
    const stubsDir = path.join(tmp, "bin");
    const validatorRoot = path.join(tmp, "usr-local-lib-nemoclaw");
    const pkillLog = path.join(tmp, "pkill.log");
    const recoveryLogPath = path.join(tmp, "gateway-recovery.log");
    fs.mkdirSync(stubsDir, { recursive: true });
    if (opts.validatorExists) {
      fs.mkdirSync(validatorRoot, { recursive: true });
      fs.writeFileSync(
        path.join(validatorRoot, "validate-hermes-env-secret-boundary.py"),
        "#!/usr/bin/env python3\nimport sys\nsys.exit(0)\n",
      );
    }
    writeStub(
      stubsDir,
      "python3",
      `printf '[SECURITY] stub validator stderr for %s\\n' "$*" >&2\nexit ${opts.pythonExit}`,
    );
    writeStub(stubsDir, "pkill", `printf '%s\\n' "$*" >> ${JSON.stringify(pkillLog)}\nexit 0`);
    writeStub(stubsDir, "sleep", "exit 0");

    const scriptPath = path.join(tmp, "guard.sh");
    const validatorPath = path.join(validatorRoot, "validate-hermes-env-secret-boundary.py");
    const guardWithStubs = opts.guard
      .replace(new RegExp(HERMES_SECRET_BOUNDARY_VALIDATOR_PATH, "g"), validatorPath)
      .replace(/\/tmp\/gateway-recovery\.log/g, recoveryLogPath);
    fs.writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -u",
        `export PATH=${JSON.stringify(stubsDir)}:/usr/bin:/bin`,
        guardWithStubs,
        "wait",
        'printf "REACHED_LAUNCH\\n"',
      ].join("\n"),
      { mode: 0o700 },
    );

    try {
      const result = spawnSync("bash", [scriptPath], {
        encoding: "utf-8",
        timeout: 10000,
        env: { PATH: `${stubsDir}:/usr/bin:/bin`, HOME: tmp },
      });
      return {
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        pkillCalls: fs.existsSync(pkillLog)
          ? fs.readFileSync(pkillLog, "utf-8").trim().split("\n").filter(Boolean)
          : [],
        recoveryLog: fs.existsSync(recoveryLogPath)
          ? fs.readFileSync(recoveryLogPath, "utf-8")
          : "",
      };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  it("env-file guard exits 1, kills hermes processes, and persists [SECURITY] to the recovery log when python validator fails", () => {
    const result = runGuard({
      guard: __testing.buildHermesEnvFileBoundaryGuard(),
      pythonExit: 1,
      validatorExists: true,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("SECRET_BOUNDARY_REFUSED");
    expect(result.stdout).not.toContain("REACHED_LAUNCH");
    const gatewayKills = result.pkillCalls.filter(
      (line) => line.includes("[h]ermes") && line.includes("gateway"),
    );
    const dashboardKills = result.pkillCalls.filter(
      (line) => line.includes("[h]ermes") && line.includes("dashboard"),
    );
    expect(gatewayKills.length).toBeGreaterThanOrEqual(2);
    expect(dashboardKills.length).toBeGreaterThanOrEqual(2);
    expect(result.recoveryLog).toContain("[SECURITY]");
    expect(result.stderr).toContain("[SECURITY]");
  });

  it("env-file guard passes through and lets the launch proceed when python validator succeeds", () => {
    const result = runGuard({
      guard: __testing.buildHermesEnvFileBoundaryGuard(),
      pythonExit: 0,
      validatorExists: true,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("REACHED_LAUNCH");
    expect(result.stdout).not.toContain("SECRET_BOUNDARY_REFUSED");
    expect(result.pkillCalls.length).toBe(0);
  });

  it("env-file guard warns and skips the boundary check when the validator script is absent", () => {
    const result = runGuard({
      guard: __testing.buildHermesEnvFileBoundaryGuard(),
      pythonExit: 0,
      validatorExists: false,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("REACHED_LAUNCH");
    expect(result.stdout).not.toContain("SECRET_BOUNDARY_REFUSED");
    expect(result.pkillCalls.length).toBe(0);
    expect(result.recoveryLog).toContain("[gateway-recovery] WARNING");
    expect(result.recoveryLog).toContain("missing on this sandbox image");
    expect(result.stderr).toContain("[gateway-recovery] WARNING");
  });

  it("runtime-env guard exits 1 on python validator failure, kills processes, and logs [SECURITY]", () => {
    const result = runGuard({
      guard: __testing.buildHermesRuntimeEnvBoundaryGuard(),
      pythonExit: 1,
      validatorExists: true,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("SECRET_BOUNDARY_REFUSED");
    expect(result.stdout).not.toContain("REACHED_LAUNCH");
    expect(result.pkillCalls.length).toBeGreaterThanOrEqual(2);
    expect(result.recoveryLog).toContain("[SECURITY]");
  });
});

describe("Hermes secret-boundary guard — full recovery script behaviour", () => {
  function prepareRecoveryHarness(name: string) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `nemoclaw-hermes-recovery-${name}-`));
    const stubsDir = path.join(tmp, "bin");
    const pkillLog = path.join(tmp, "pkill.log");
    const recoveryLogPath = path.join(tmp, "gateway-recovery.log");
    const hermesLaunchMarker = path.join(tmp, "hermes-launched");
    const gatewayLogPath = path.join(tmp, "gateway.log");
    const recoveryFallbackLog = path.join(tmp, "gateway-recovery-fallback.log");
    fs.mkdirSync(stubsDir, { recursive: true });
    return {
      tmp,
      stubsDir,
      pkillLog,
      recoveryLogPath,
      hermesLaunchMarker,
      gatewayLogPath,
      recoveryFallbackLog,
    };
  }

  function stubBaselineUtilities(stubsDir: string, pkillLog: string, hermesLaunchMarker: string) {
    writeStub(stubsDir, "pkill", `printf '%s\\n' "$*" >> ${JSON.stringify(pkillLog)}\nexit 0`);
    writeStub(stubsDir, "pgrep", "exit 1");
    writeStub(stubsDir, "sleep", "exit 0");
    writeStub(stubsDir, "curl", 'printf "000"\nexit 0');
    writeStub(stubsDir, "hermes", `: > ${JSON.stringify(hermesLaunchMarker)}\nexit 0`);
  }

  function runRecovery(opts: {
    stubsDir: string;
    validatorPath: string;
    envFilePath?: string;
    proxyEnvPath?: string;
    recoveryLogPath: string;
    gatewayLogPath: string;
    recoveryFallbackLog: string;
    tmp: string;
  }) {
    const recoveryScript = buildRecoveryScript(hermesAgent, 8642);
    expect(recoveryScript).not.toBeNull();
    let stubbed = recoveryScript!
      .replace(new RegExp(HERMES_SECRET_BOUNDARY_VALIDATOR_PATH, "g"), opts.validatorPath)
      .replace(/\/tmp\/gateway-recovery\.log/g, opts.recoveryLogPath)
      .replace(/\/tmp\/gateway\.log/g, opts.gatewayLogPath)
      .replace(
        /_GATEWAY_LOG=\/tmp\/gateway-recovery\.log/g,
        `_GATEWAY_LOG=${opts.recoveryFallbackLog}`,
      );
    if (opts.envFilePath) {
      stubbed = stubbed.replace(/\/sandbox\/\.hermes\/\.env/g, opts.envFilePath);
    }
    if (opts.proxyEnvPath) {
      stubbed = stubbed.replace(/\/tmp\/nemoclaw-proxy-env\.sh/g, opts.proxyEnvPath);
    }

    const scriptPath = path.join(opts.tmp, "recovery.sh");
    fs.writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        `export PATH=${JSON.stringify(opts.stubsDir)}:/usr/bin:/bin`,
        stubbed,
      ].join("\n"),
      { mode: 0o700 },
    );
    return spawnSync("bash", [scriptPath], {
      encoding: "utf-8",
      timeout: 15000,
      env: { PATH: `${opts.stubsDir}:/usr/bin:/bin`, HOME: opts.tmp },
    });
  }

  it("exits 1 with stubbed python3 returning [SECURITY] lines, kills hermes processes, never reaches the gateway launch", () => {
    const harness = prepareRecoveryHarness("stub");
    const validatorRoot = path.join(harness.tmp, "usr-local-lib-nemoclaw");
    fs.mkdirSync(validatorRoot, { recursive: true });
    fs.writeFileSync(
      path.join(validatorRoot, "validate-hermes-env-secret-boundary.py"),
      "#!/usr/bin/env python3\n",
    );
    writeStub(
      harness.stubsDir,
      "python3",
      'printf "[SECURITY] Refusing Hermes startup because /sandbox/.hermes/.env contains raw secret-shaped values.\\n" >&2\nprintf "[SECURITY]   TELEGRAM_BOT_TOKEN (line 2)\\n" >&2\nexit 1',
    );
    stubBaselineUtilities(harness.stubsDir, harness.pkillLog, harness.hermesLaunchMarker);

    try {
      const result = runRecovery({
        ...harness,
        validatorPath: path.join(validatorRoot, "validate-hermes-env-secret-boundary.py"),
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("SECRET_BOUNDARY_REFUSED");
      expect(result.stdout).not.toContain("GATEWAY_PID=");
      expect(result.stdout).not.toContain("ALREADY_RUNNING");
      expect(fs.existsSync(harness.hermesLaunchMarker)).toBe(false);
      const pkillCalls = fs.readFileSync(harness.pkillLog, "utf-8");
      expect(pkillCalls).toContain("[h]ermes");
      expect(pkillCalls).toContain("gateway");
      expect(pkillCalls).toContain("dashboard");
      const log = fs.readFileSync(harness.recoveryLogPath, "utf-8");
      expect(log).toContain("[SECURITY] Refusing Hermes startup");
      expect(log).toContain("TELEGRAM_BOT_TOKEN (line 2)");
    } finally {
      fs.rmSync(harness.tmp, { recursive: true, force: true });
    }
  });

  it("refuses against an actual poisoned .env using the real Python validator", () => {
    const harness = prepareRecoveryHarness("real-envfile");
    const envFile = path.join(harness.tmp, "hermes-dot-env");
    const realValidator = path.join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "agents",
      "hermes",
      "validate-env-secret-boundary.py",
    );
    fs.writeFileSync(
      envFile,
      "API_SERVER_PORT=18642\nTELEGRAM_BOT_TOKEN=1234567890:AAExample-RawSecretValueHere\n",
    );
    stubBaselineUtilities(harness.stubsDir, harness.pkillLog, harness.hermesLaunchMarker);

    try {
      const result = runRecovery({
        ...harness,
        validatorPath: realValidator,
        envFilePath: envFile,
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("SECRET_BOUNDARY_REFUSED");
      expect(fs.existsSync(harness.hermesLaunchMarker)).toBe(false);
      const log = fs.readFileSync(harness.recoveryLogPath, "utf-8");
      expect(log).toContain("[SECURITY] Refusing Hermes startup");
      expect(log).toContain("TELEGRAM_BOT_TOKEN");
      expect(log).toContain("(line 2)");
      expect(log).not.toContain("1234567890:AAExample-RawSecretValueHere");
    } finally {
      fs.rmSync(harness.tmp, { recursive: true, force: true });
    }
  });

  it("refuses before /health can accept an already-serving poisoned gateway", () => {
    const harness = prepareRecoveryHarness("health-already-serving");
    const envFile = path.join(harness.tmp, "hermes-dot-env");
    const curlLog = path.join(harness.tmp, "curl.log");
    const realValidator = path.join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "agents",
      "hermes",
      "validate-env-secret-boundary.py",
    );
    fs.writeFileSync(
      envFile,
      "API_SERVER_PORT=18642\nTELEGRAM_BOT_TOKEN=1234567890:AAExample-RawSecretValueHere\n",
    );
    stubBaselineUtilities(harness.stubsDir, harness.pkillLog, harness.hermesLaunchMarker);
    writeStub(
      harness.stubsDir,
      "curl",
      `printf '%s\\n' "$*" >> ${JSON.stringify(curlLog)}\nprintf "200"\nexit 0`,
    );

    try {
      const result = runRecovery({
        ...harness,
        validatorPath: realValidator,
        envFilePath: envFile,
      });
      // Unit-level HEALTH_DOWN evidence for #4957: the boundary refusal wins
      // before recovery can trust a still-serving /health endpoint.
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("SECRET_BOUNDARY_REFUSED");
      expect(result.stdout).not.toContain("ALREADY_RUNNING");
      expect(fs.existsSync(curlLog)).toBe(false);
      expect(fs.existsSync(harness.hermesLaunchMarker)).toBe(false);
      const pkillCalls = fs.readFileSync(harness.pkillLog, "utf-8");
      expect(pkillCalls).toContain("[h]ermes");
      expect(pkillCalls).toContain("gateway");
      const log = fs.readFileSync(harness.recoveryLogPath, "utf-8");
      expect(log).toContain("[SECURITY] Refusing Hermes startup");
      expect(log).toContain("TELEGRAM_BOT_TOKEN");
      expect(log).not.toContain("1234567890:AAExample-RawSecretValueHere");
    } finally {
      fs.rmSync(harness.tmp, { recursive: true, force: true });
    }
  });

  it("refuses on runtime-env violation after sourcing proxy-env (stubbed python3)", () => {
    const harness = prepareRecoveryHarness("runtime-env-stub");
    const validatorRoot = path.join(harness.tmp, "usr-local-lib-nemoclaw");
    fs.mkdirSync(validatorRoot, { recursive: true });
    fs.writeFileSync(
      path.join(validatorRoot, "validate-hermes-env-secret-boundary.py"),
      "#!/usr/bin/env python3\n",
    );
    const proxyEnvFile = path.join(harness.tmp, "nemoclaw-proxy-env.sh");
    fs.writeFileSync(
      proxyEnvFile,
      "export NODE_OPTIONS='--require=nemoclaw-sandbox-safety-net --require=nemoclaw-ciao-network-guard'\n",
    );
    writeStub(harness.stubsDir, "python3", `${SHARED_PYTHON_STUB_BY_MODE}\n`);
    stubBaselineUtilities(harness.stubsDir, harness.pkillLog, harness.hermesLaunchMarker);

    try {
      const result = spawnSync(
        "bash",
        [
          (() => {
            const recoveryScript = buildRecoveryScript(hermesAgent, 8642);
            expect(recoveryScript).not.toBeNull();
            const stubbed = recoveryScript!
              .replace(
                new RegExp(HERMES_SECRET_BOUNDARY_VALIDATOR_PATH, "g"),
                path.join(validatorRoot, "validate-hermes-env-secret-boundary.py"),
              )
              .replace(/\/tmp\/gateway-recovery\.log/g, harness.recoveryLogPath)
              .replace(/\/tmp\/nemoclaw-proxy-env\.sh/g, proxyEnvFile)
              .replace(/\/tmp\/gateway\.log/g, harness.gatewayLogPath)
              .replace(
                /_GATEWAY_LOG=\/tmp\/gateway-recovery\.log/g,
                `_GATEWAY_LOG=${harness.recoveryFallbackLog}`,
              );
            const scriptPath = path.join(harness.tmp, "recovery.sh");
            fs.writeFileSync(
              scriptPath,
              [
                "#!/usr/bin/env bash",
                `export PATH=${JSON.stringify(harness.stubsDir)}:/usr/bin:/bin`,
                "export STUB_ENVFILE_EXIT=0",
                "export STUB_RUNTIMEENV_EXIT=1",
                stubbed,
              ].join("\n"),
              { mode: 0o700 },
            );
            return scriptPath;
          })(),
        ],
        {
          encoding: "utf-8",
          timeout: 15000,
          env: { PATH: `${harness.stubsDir}:/usr/bin:/bin`, HOME: harness.tmp },
        },
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("SECRET_BOUNDARY_REFUSED");
      expect(fs.existsSync(harness.hermesLaunchMarker)).toBe(false);
      const log = fs.readFileSync(harness.recoveryLogPath, "utf-8");
      expect(log).toContain("[SECURITY] Refusing Hermes startup because the process environment");
      expect(log).toContain("TELEGRAM_BOT_TOKEN");
    } finally {
      fs.rmSync(harness.tmp, { recursive: true, force: true });
    }
  });

  it("refuses on runtime-env violation using the real validator against a proxy-env that exports a raw secret", () => {
    const harness = prepareRecoveryHarness("runtime-env-real");
    const envFile = path.join(harness.tmp, "hermes-dot-env");
    const proxyEnvFile = path.join(harness.tmp, "nemoclaw-proxy-env.sh");
    const realValidator = path.join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "agents",
      "hermes",
      "validate-env-secret-boundary.py",
    );
    // Clean .env so env-file passes, hostile proxy-env contributes the raw
    // runtime-env secret that runtime-env validation must catch after sourcing.
    fs.writeFileSync(envFile, "API_SERVER_PORT=18642\n");
    fs.writeFileSync(
      proxyEnvFile,
      [
        "export NODE_OPTIONS='--require=nemoclaw-sandbox-safety-net --require=nemoclaw-ciao-network-guard'",
        "export TELEGRAM_BOT_TOKEN=1234567890:AAExample-RawSecretValueHere",
        "",
      ].join("\n"),
    );
    stubBaselineUtilities(harness.stubsDir, harness.pkillLog, harness.hermesLaunchMarker);

    try {
      const result = runRecovery({
        ...harness,
        validatorPath: realValidator,
        envFilePath: envFile,
        proxyEnvPath: proxyEnvFile,
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("SECRET_BOUNDARY_REFUSED");
      expect(fs.existsSync(harness.hermesLaunchMarker)).toBe(false);
      const log = fs.readFileSync(harness.recoveryLogPath, "utf-8");
      expect(log).toContain("[SECURITY] Refusing Hermes startup because the process environment");
      expect(log).toContain("TELEGRAM_BOT_TOKEN");
      expect(log).not.toContain("1234567890:AAExample-RawSecretValueHere");
    } finally {
      fs.rmSync(harness.tmp, { recursive: true, force: true });
    }
  });
});
