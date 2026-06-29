// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Behavioural tests for the Hermes recovery boundary guards. These spawn `bash`
// on the synthesised shell snippets or full recovery scripts with stubbed
// `python3`/`pkill`/`pgrep`/`curl`/`hermes` binaries and assert real exit codes,
// kill invocations, and persisted `/tmp/gateway-recovery.log` contents. Pure
// generated-shell shape assertions live in
// runtime-hermes-secret-boundary-shape.test.ts.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createRecoveryPreloadHarnessPaths,
  type RecoveryPreloadHarnessPaths,
  rewriteRecoveryPreloadPaths,
} from "../../../test/helpers/runtime-recovery-preload-test-helpers";
import { __testing, HERMES_SECRET_BOUNDARY_VALIDATOR_PATH } from "./hermes-recovery-boundary";
import { hermesAgent } from "./hermes-recovery-boundary-fixtures";
import { buildRecoveryScript } from "./runtime";

function writeStub(dir: string, name: string, body: string) {
  const stub = path.join(dir, name);
  fs.writeFileSync(stub, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  return stub;
}

function removeTempDir(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function waitForPath(filePath: string, timeoutMs = 1000) {
  const sleepView = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return true;
    Atomics.wait(sleepView, 0, 0, 10);
  }
  return fs.existsSync(filePath);
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
      removeTempDir(tmp);
    }
  }

  it("env-file guard exits 1, kills hermes processes, and persists [SECURITY] to the recovery log when python validator fails", {
    timeout: 15_000,
  }, () => {
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

  it("runtime-env guard exits 1 on python validator failure, kills processes, and logs [SECURITY]", {
    timeout: 20_000,
  }, () => {
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

  it("standalone env-file check exits 1, emits SECRET_BOUNDARY_REFUSED, kills processes when validator refuses", {
    timeout: 15_000,
  }, () => {
    const result = runGuard({
      guard: __testing.buildHermesEnvFileBoundaryStandaloneCheck(),
      pythonExit: 1,
      validatorExists: true,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("SECRET_BOUNDARY_REFUSED");
    expect(result.stdout).not.toContain("SECRET_BOUNDARY_OK");
    expect(result.stdout).not.toContain("REACHED_LAUNCH");
    expect(result.pkillCalls.length).toBeGreaterThanOrEqual(2);
    expect(result.stderr).toContain("[SECURITY]");
  });

  it("standalone env-file check exits 0 and emits SECRET_BOUNDARY_OK when validator accepts", () => {
    const result = runGuard({
      guard: __testing.buildHermesEnvFileBoundaryStandaloneCheck(),
      pythonExit: 0,
      validatorExists: true,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("SECRET_BOUNDARY_OK");
    expect(result.stdout).not.toContain("SECRET_BOUNDARY_REFUSED");
    expect(result.pkillCalls.length).toBe(0);
  });

  it("standalone env-file check emits SECRET_BOUNDARY_VALIDATOR_MISSING and exits 0 when validator script is absent", () => {
    const result = runGuard({
      guard: __testing.buildHermesEnvFileBoundaryStandaloneCheck(),
      pythonExit: 0,
      validatorExists: false,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("SECRET_BOUNDARY_VALIDATOR_MISSING");
    expect(result.stdout).not.toContain("SECRET_BOUNDARY_REFUSED");
    expect(result.pkillCalls.length).toBe(0);
  });
});

describe("Hermes secret-boundary guard — full recovery script behaviour", {
  timeout: 20_000,
}, () => {
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
      ...createRecoveryPreloadHarnessPaths(tmp),
    };
  }

  function stubBaselineUtilities(stubsDir: string, pkillLog: string, hermesLaunchMarker: string) {
    writeStub(stubsDir, "pkill", `printf '%s\\n' "$*" >> ${JSON.stringify(pkillLog)}\nexit 0`);
    writeStub(stubsDir, "pgrep", "exit 1");
    writeStub(stubsDir, "sleep", "exit 0");
    writeStub(stubsDir, "curl", 'printf "000"\nexit 0');
    writeStub(stubsDir, "hermes", `: > ${JSON.stringify(hermesLaunchMarker)}\n/bin/sleep 5`);
    const manager = writeStub(
      stubsDir,
      "nemoclaw-start",
      `: > ${JSON.stringify(hermesLaunchMarker)}\n/bin/sleep 5`,
    );
    fs.chmodSync(manager, 0o555);
    writeStub(
      stubsDir,
      "trusted-python3",
      'if [ "$1" = "-c" ] && printf "%s" "$2" | grep -Fq "raise SystemExit(0 if manager_is_safe"; then exit 0; fi\nexec /usr/bin/python3 "$@"',
    );
  }

  function runRecovery(
    opts: {
      stubsDir: string;
      validatorPath: string;
      envFilePath?: string;
      proxyEnvPath?: string;
      recoveryLogPath: string;
      gatewayLogPath: string;
      recoveryFallbackLog: string;
      tmp: string;
      procRoot?: string;
      rootLifecycleMarkerPath?: string;
      trustManagerValidation?: boolean;
    } & RecoveryPreloadHarnessPaths,
  ) {
    const recoveryScript = buildRecoveryScript(hermesAgent, 8642);
    expect(recoveryScript).not.toBeNull();
    let stubbed = rewriteRecoveryPreloadPaths(recoveryScript!, opts)
      .replace(new RegExp(HERMES_SECRET_BOUNDARY_VALIDATOR_PATH, "g"), opts.validatorPath)
      .replace(/\/tmp\/gateway-recovery\.log/g, opts.recoveryLogPath)
      .replace(/\/tmp\/gateway\.log/g, opts.gatewayLogPath)
      .replace(/\/usr\/local\/bin\/nemoclaw-start/g, path.join(opts.stubsDir, "nemoclaw-start"))
      .replace(
        /_GATEWAY_LOG=\/tmp\/gateway-recovery\.log/g,
        `_GATEWAY_LOG=${opts.recoveryFallbackLog}`,
      );
    if (opts.trustManagerValidation !== false) {
      stubbed = stubbed.replace(
        /\/usr\/bin\/python3/g,
        path.join(opts.stubsDir, "trusted-python3"),
      );
    }
    if (opts.envFilePath) {
      stubbed = stubbed.replace(/\/sandbox\/\.hermes\/\.env/g, opts.envFilePath);
    }
    if (opts.proxyEnvPath) {
      stubbed = stubbed.replace(/\/tmp\/nemoclaw-proxy-env\.sh/g, opts.proxyEnvPath);
    }
    if (opts.procRoot) {
      stubbed = stubbed.replace(/\/proc\//g, `${opts.procRoot}/`);
    }
    if (opts.rootLifecycleMarkerPath) {
      stubbed = stubbed.replace(
        /\/run\/nemoclaw\/hermes-root-lifecycle/g,
        opts.rootLifecycleMarkerPath,
      );
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
      removeTempDir(harness.tmp);
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
      removeTempDir(harness.tmp);
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
      removeTempDir(harness.tmp);
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
    fs.chmodSync(proxyEnvFile, 0o444);
    writeStub(harness.stubsDir, "python3", `${SHARED_PYTHON_STUB_BY_MODE}\n`);
    stubBaselineUtilities(harness.stubsDir, harness.pkillLog, harness.hermesLaunchMarker);

    try {
      const result = spawnSync(
        "bash",
        [
          (() => {
            const recoveryScript = buildRecoveryScript(hermesAgent, 8642);
            expect(recoveryScript).not.toBeNull();
            const stubbed = rewriteRecoveryPreloadPaths(recoveryScript!, harness)
              .replace(/\/usr\/bin\/python3/g, path.join(harness.stubsDir, "trusted-python3"))
              .replace(
                new RegExp(HERMES_SECRET_BOUNDARY_VALIDATOR_PATH, "g"),
                path.join(validatorRoot, "validate-hermes-env-secret-boundary.py"),
              )
              .replace(/\/tmp\/gateway-recovery\.log/g, harness.recoveryLogPath)
              .replace(/\/tmp\/nemoclaw-proxy-env\.sh/g, proxyEnvFile)
              .replace(/\/tmp\/gateway\.log/g, harness.gatewayLogPath)
              .replace(
                /\/usr\/local\/bin\/nemoclaw-start/g,
                path.join(harness.stubsDir, "nemoclaw-start"),
              )
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
      removeTempDir(harness.tmp);
    }
  }, 20_000);

  it("does not import a raw secret from a metadata-safe proxy-env during runtime validation", () => {
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
    // Clean .env so env-file passes. The hostile proxy-env used to contribute a
    // raw runtime-env secret; recovery now rewrites that volatile shell file
    // before sourcing it, so the runtime-env validator should never see the raw
    // value.
    fs.writeFileSync(envFile, "API_SERVER_PORT=18642\n");
    fs.writeFileSync(
      proxyEnvFile,
      [
        "export NODE_OPTIONS='--require=nemoclaw-sandbox-safety-net --require=nemoclaw-ciao-network-guard'",
        "export TELEGRAM_BOT_TOKEN=1234567890:AAExample-RawSecretValueHere",
        "",
      ].join("\n"),
    );
    fs.chmodSync(proxyEnvFile, 0o444);
    stubBaselineUtilities(harness.stubsDir, harness.pkillLog, harness.hermesLaunchMarker);

    try {
      const result = runRecovery({
        ...harness,
        validatorPath: realValidator,
        envFilePath: envFile,
        proxyEnvPath: proxyEnvFile,
      });
      expect(result.status).toBe(0);
      expect(waitForPath(harness.hermesLaunchMarker)).toBe(true);
      expect(result.stdout).not.toContain("SECRET_BOUNDARY_REFUSED");
      expect(result.stderr).not.toContain("TELEGRAM_BOT_TOKEN");
      const proxyEnv = fs.readFileSync(proxyEnvFile, "utf-8");
      expect(proxyEnv).not.toContain("TELEGRAM_BOT_TOKEN");
      expect(proxyEnv).toContain(harness.preloadTmpSafetyNet);
      expect(proxyEnv).toContain(harness.preloadTmpCiao);
      const log = fs.readFileSync(harness.recoveryLogPath, "utf-8");
      expect(log).not.toContain("[SECURITY] Refusing Hermes startup");
      expect(log).not.toContain("TELEGRAM_BOT_TOKEN");
      expect(log).not.toContain("1234567890:AAExample-RawSecretValueHere");
    } finally {
      removeTempDir(harness.tmp);
    }
  }, 20_000);

  it("refuses a dangling root-lifecycle marker before any probe, kill, or launch", () => {
    const harness = prepareRecoveryHarness("root-marker");
    const validatorRoot = path.join(harness.tmp, "usr-local-lib-nemoclaw");
    const marker = path.join(harness.tmp, "hermes-root-lifecycle");
    const curlLog = path.join(harness.tmp, "curl.log");
    fs.mkdirSync(validatorRoot, { recursive: true });
    fs.writeFileSync(
      path.join(validatorRoot, "validate-hermes-env-secret-boundary.py"),
      "#!/usr/bin/env python3\n",
    );
    fs.symlinkSync(path.join(harness.tmp, "missing-root-marker-target"), marker);
    stubBaselineUtilities(harness.stubsDir, harness.pkillLog, harness.hermesLaunchMarker);
    writeStub(
      harness.stubsDir,
      "curl",
      `printf '%s\\n' "$*" >> ${JSON.stringify(curlLog)}\nprintf "200"`,
    );

    try {
      const result = runRecovery({
        ...harness,
        validatorPath: path.join(validatorRoot, "validate-hermes-env-secret-boundary.py"),
        rootLifecycleMarkerPath: marker,
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("HERMES_ROOT_LIFECYCLE_UNSUPPORTED");
      expect(fs.existsSync(curlLog)).toBe(false);
      expect(fs.existsSync(harness.pkillLog)).toBe(false);
      expect(fs.existsSync(harness.hermesLaunchMarker)).toBe(false);
    } finally {
      removeTempDir(harness.tmp);
    }
  });

  it("refuses a manager writable by the recovery identity before process mutation", () => {
    const harness = prepareRecoveryHarness("writable-manager");
    const validatorRoot = path.join(harness.tmp, "usr-local-lib-nemoclaw");
    const manager = path.join(harness.stubsDir, "nemoclaw-start");
    fs.mkdirSync(validatorRoot, { recursive: true });
    fs.writeFileSync(
      path.join(validatorRoot, "validate-hermes-env-secret-boundary.py"),
      "#!/usr/bin/env python3\n",
    );
    stubBaselineUtilities(harness.stubsDir, harness.pkillLog, harness.hermesLaunchMarker);
    fs.chmodSync(manager, 0o755);

    try {
      const result = runRecovery({
        ...harness,
        validatorPath: path.join(validatorRoot, "validate-hermes-env-secret-boundary.py"),
        trustManagerValidation: false,
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("HERMES_SERVICE_MANAGER_UNSAFE");
      expect(fs.existsSync(harness.pkillLog)).toBe(false);
      expect(fs.existsSync(harness.hermesLaunchMarker)).toBe(false);
    } finally {
      removeTempDir(harness.tmp);
    }
  });

  it("ignores a sandbox rc attempt to redirect the trusted service manager", () => {
    const harness = prepareRecoveryHarness("manager-rc-override");
    const validatorRoot = path.join(harness.tmp, "usr-local-lib-nemoclaw");
    const proxyEnvFile = path.join(harness.tmp, "nemoclaw-proxy-env.sh");
    const evilManager = path.join(harness.tmp, "evil-manager");
    const evilMarker = path.join(harness.tmp, "evil-manager-launched");
    fs.mkdirSync(validatorRoot, { recursive: true });
    fs.writeFileSync(
      path.join(validatorRoot, "validate-hermes-env-secret-boundary.py"),
      "#!/usr/bin/env python3\n",
    );
    fs.writeFileSync(
      proxyEnvFile,
      "export NODE_OPTIONS='--require=nemoclaw-sandbox-safety-net --require=nemoclaw-ciao-network-guard'\n",
    );
    fs.chmodSync(proxyEnvFile, 0o444);
    writeStub(harness.tmp, "evil-manager", `: > ${JSON.stringify(evilMarker)}\n/bin/sleep 5`);
    fs.writeFileSync(
      path.join(harness.tmp, ".bashrc"),
      `_HERMES_SERVICE_MANAGER=${JSON.stringify(evilManager)}\n`,
    );
    writeStub(harness.stubsDir, "python3", `${SHARED_PYTHON_STUB_BY_MODE}\n`);
    stubBaselineUtilities(harness.stubsDir, harness.pkillLog, harness.hermesLaunchMarker);

    try {
      const result = runRecovery({
        ...harness,
        validatorPath: path.join(validatorRoot, "validate-hermes-env-secret-boundary.py"),
        proxyEnvPath: proxyEnvFile,
      });
      expect(result.status).toBe(0);
      expect(waitForPath(harness.hermesLaunchMarker)).toBe(true);
      expect(fs.existsSync(evilMarker)).toBe(false);
    } finally {
      removeTempDir(harness.tmp);
    }
  });

  it("terminates an old manager without killing a one-shot manager-path decoy", async () => {
    const harness = prepareRecoveryHarness("manager-takeover");
    const validatorRoot = path.join(harness.tmp, "usr-local-lib-nemoclaw");
    const proxyEnvFile = path.join(harness.tmp, "nemoclaw-proxy-env.sh");
    const procRoot = path.join(harness.tmp, "proc");
    const manager = path.join(harness.stubsDir, "nemoclaw-start");
    const lifecycleLog = path.join(harness.tmp, "manager-lifecycle.log");
    const oldReady = path.join(harness.tmp, "old-manager-ready");
    fs.mkdirSync(validatorRoot, { recursive: true });
    fs.mkdirSync(procRoot, { recursive: true });
    fs.writeFileSync(
      path.join(validatorRoot, "validate-hermes-env-secret-boundary.py"),
      "#!/usr/bin/env python3\n",
    );
    fs.writeFileSync(
      proxyEnvFile,
      "export NODE_OPTIONS='--require=nemoclaw-sandbox-safety-net --require=nemoclaw-ciao-network-guard'\n",
    );
    fs.chmodSync(proxyEnvFile, 0o444);
    stubBaselineUtilities(harness.stubsDir, harness.pkillLog, harness.hermesLaunchMarker);
    fs.chmodSync(manager, 0o755);
    fs.writeFileSync(
      manager,
      [
        "#!/usr/bin/env bash",
        'if [ "${NEMOCLAW_TEST_OLD_MANAGER:-0}" = "1" ]; then',
        `  trap 'printf "old-term\\n" >> ${JSON.stringify(lifecycleLog)}; rm -rf "${procRoot}/$$"; exit 0' TERM`,
        `  : > ${JSON.stringify(oldReady)}`,
        "  while :; do /bin/sleep 1; done",
        "fi",
        `printf "new-launch\\n" >> ${JSON.stringify(lifecycleLog)}`,
        `: > ${JSON.stringify(harness.hermesLaunchMarker)}`,
        "/bin/sleep 5",
      ].join("\n"),
      { mode: 0o555 },
    );
    const oldManager = spawn("bash", [manager], {
      env: {
        PATH: `${harness.stubsDir}:/usr/bin:/bin`,
        NEMOCLAW_TEST_OLD_MANAGER: "1",
      },
      stdio: "ignore",
    });
    const decoy = spawn("/bin/sleep", ["30"], { stdio: "ignore" });

    const writeFakeProcess = (pid: number, argv: string[], startTime: string) => {
      const procDir = path.join(procRoot, String(pid));
      fs.mkdirSync(procDir, { recursive: true });
      fs.writeFileSync(path.join(procDir, "cmdline"), `${argv.join("\0")}\0`);
      fs.writeFileSync(
        path.join(procDir, "stat"),
        `${pid} (bash) S ${[...Array(18).fill("0"), startTime].join(" ")}\n`,
      );
    };

    try {
      expect(waitForPath(oldReady)).toBe(true);
      expect(oldManager.pid).toBeTypeOf("number");
      expect(decoy.pid).toBeTypeOf("number");
      writeFakeProcess(oldManager.pid!, ["bash", manager], "101");
      writeFakeProcess(decoy.pid!, ["bash", manager, "true"], "202");
      const result = runRecovery({
        ...harness,
        validatorPath: path.join(validatorRoot, "validate-hermes-env-secret-boundary.py"),
        proxyEnvPath: proxyEnvFile,
        procRoot,
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("SERVICE_PID=");
      expect(waitForPath(harness.hermesLaunchMarker)).toBe(true);
      expect(fs.readFileSync(lifecycleLog, "utf-8").trim().split("\n")).toEqual([
        "old-term",
        "new-launch",
      ]);
      expect(decoy.killed).toBe(false);
      expect(decoy.exitCode).toBeNull();
    } finally {
      oldManager.kill("SIGKILL");
      decoy.kill("SIGKILL");
      removeTempDir(harness.tmp);
    }
  }, 20_000);

  function runManagedTopologyProbe(managed: boolean) {
    const harness = prepareRecoveryHarness(managed ? "managed-parent" : "bare-parent");
    const validatorRoot = path.join(harness.tmp, "usr-local-lib-nemoclaw");
    const proxyEnvFile = path.join(harness.tmp, "nemoclaw-proxy-env.sh");
    const procRoot = path.join(harness.tmp, "proc");
    const gatewayPid = "111";
    const parentPid = "222";
    fs.mkdirSync(validatorRoot, { recursive: true });
    fs.mkdirSync(path.join(procRoot, gatewayPid), { recursive: true });
    fs.mkdirSync(path.join(procRoot, parentPid), { recursive: true });
    fs.writeFileSync(
      path.join(validatorRoot, "validate-hermes-env-secret-boundary.py"),
      "#!/usr/bin/env python3\n",
    );
    fs.writeFileSync(
      proxyEnvFile,
      "export NODE_OPTIONS='--require=nemoclaw-sandbox-safety-net --require=nemoclaw-ciao-network-guard'\n",
    );
    fs.chmodSync(proxyEnvFile, 0o444);
    fs.writeFileSync(
      path.join(procRoot, gatewayPid, "cmdline"),
      "/usr/local/lib/nemoclaw/hermes\0gateway\0run\0",
    );
    fs.writeFileSync(
      path.join(procRoot, gatewayPid, "status"),
      `Name:\thermes\nPPid:\t${parentPid}\n`,
    );
    fs.writeFileSync(
      path.join(procRoot, parentPid, "cmdline"),
      managed ? `bash\0${path.join(harness.stubsDir, "nemoclaw-start")}\0` : "sleep\0infinity\0",
    );
    writeStub(harness.stubsDir, "python3", `${SHARED_PYTHON_STUB_BY_MODE}\n`);
    stubBaselineUtilities(harness.stubsDir, harness.pkillLog, harness.hermesLaunchMarker);
    writeStub(harness.stubsDir, "curl", 'printf "200"\nexit 0');

    try {
      const result = runRecovery({
        ...harness,
        validatorPath: path.join(validatorRoot, "validate-hermes-env-secret-boundary.py"),
        proxyEnvPath: proxyEnvFile,
        procRoot,
      });
      return {
        result,
        managerLaunched: waitForPath(harness.hermesLaunchMarker),
      };
    } finally {
      removeTempDir(harness.tmp);
    }
  }

  it("does not trust HTTP health from a bare Hermes gateway without its service manager", () => {
    const { result, managerLaunched } = runManagedTopologyProbe(false);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("ALREADY_RUNNING");
    expect(result.stdout).toContain("SERVICE_PID=");
    expect(managerLaunched).toBe(true);
  });

  it("keeps a healthy Hermes gateway only when its service-manager parent is present", () => {
    const { result, managerLaunched } = runManagedTopologyProbe(true);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("ALREADY_RUNNING");
    expect(result.stdout).not.toContain("SERVICE_PID=");
    expect(managerLaunched).toBe(false);
  });
});
