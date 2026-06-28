// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HERMES_SECRET_BOUNDARY_VALIDATOR_PATH } from "./hermes-recovery-boundary";
import { buildRecoveryScript } from "./runtime";
import {
  createRecoveryPreloadHarnessPaths,
  type RecoveryPreloadHarnessPaths,
  rewriteRecoveryPreloadPaths,
} from "../../../test/helpers/runtime-recovery-preload-test-helpers";
import { hermesAgent } from "./hermes-recovery-boundary-fixtures";

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
  while (!fs.existsSync(filePath) && Date.now() < deadline) {
    Atomics.wait(sleepView, 0, 0, 10);
  }
  return fs.existsSync(filePath);
}

const SHARED_PYTHON_STUB_BY_MODE = [
  'if [ "$1" = "-c" ]; then',
  "  exit 0",
  "fi",
  'mode="$2"',
  'if [ -n "${STUB_VALIDATOR_MODE_LOG:-}" ]; then',
  '  printf "%s\\n" "$mode" >>"$STUB_VALIDATOR_MODE_LOG"',
  "fi",
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

describe("Hermes secret-boundary guard - runtime recovery behaviour", () => {
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
      extraEnv?: NodeJS.ProcessEnv;
    } & RecoveryPreloadHarnessPaths,
  ) {
    const recoveryScript = buildRecoveryScript(hermesAgent, 8642);
    expect(recoveryScript).not.toBeNull();
    let stubbed = rewriteRecoveryPreloadPaths(recoveryScript!, opts)
      .replace(new RegExp(HERMES_SECRET_BOUNDARY_VALIDATOR_PATH, "g"), opts.validatorPath)
      .replace(/\/tmp\/gateway-recovery\.log/g, opts.recoveryLogPath)
      .replace(/\/tmp\/gateway\.log/g, opts.gatewayLogPath)
      .replace(
        /_GATEWAY_LOG=\/tmp\/gateway-recovery\.log/g,
        `_GATEWAY_LOG=${opts.recoveryFallbackLog}`,
      );
    stubbed = opts.envFilePath
      ? stubbed.replace(/\/sandbox\/\.hermes\/\.env/g, opts.envFilePath)
      : stubbed;
    stubbed = opts.proxyEnvPath
      ? stubbed.replace(/\/tmp\/nemoclaw-proxy-env\.sh/g, opts.proxyEnvPath)
      : stubbed;

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
      env: {
        PATH: `${opts.stubsDir}:/usr/bin:/bin`,
        HOME: opts.tmp,
        ...opts.extraEnv,
      },
    });
  }

  it("refuses on runtime-env violation after sourcing proxy-env", () => {
    const harness = prepareRecoveryHarness("runtime-env-stub");
    const validatorRoot = path.join(harness.tmp, "usr-local-lib-nemoclaw");
    const validatorPath = path.join(validatorRoot, "validate-hermes-env-secret-boundary.py");
    fs.mkdirSync(validatorRoot, { recursive: true });
    fs.writeFileSync(validatorPath, "#!/usr/bin/env python3\n");
    const proxyEnvFile = path.join(harness.tmp, "nemoclaw-proxy-env.sh");
    fs.writeFileSync(
      proxyEnvFile,
      "export NODE_OPTIONS='--require=nemoclaw-sandbox-safety-net --require=nemoclaw-ciao-network-guard'\n",
    );
    fs.chmodSync(proxyEnvFile, 0o444);
    writeStub(harness.stubsDir, "python3", `${SHARED_PYTHON_STUB_BY_MODE}\n`);
    stubBaselineUtilities(harness.stubsDir, harness.pkillLog, harness.hermesLaunchMarker);

    try {
      const result = runRecovery({
        ...harness,
        validatorPath,
        proxyEnvPath: proxyEnvFile,
        extraEnv: { STUB_ENVFILE_EXIT: "0", STUB_RUNTIMEENV_EXIT: "1" },
      });
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

  it("lets an env-file refusal win before a simultaneous hostile runtime env", () => {
    const harness = prepareRecoveryHarness("dual-boundary-violation");
    const validatorRoot = path.join(harness.tmp, "usr-local-lib-nemoclaw");
    const validatorPath = path.join(validatorRoot, "validate-hermes-env-secret-boundary.py");
    const envFile = path.join(harness.tmp, "hermes-dot-env");
    const proxyEnvFile = path.join(harness.tmp, "nemoclaw-proxy-env.sh");
    const validatorModeLog = path.join(harness.tmp, "validator-modes.log");
    fs.mkdirSync(validatorRoot, { recursive: true });
    fs.writeFileSync(validatorPath, "#!/usr/bin/env python3\n");
    fs.writeFileSync(
      envFile,
      "API_SERVER_PORT=18642\nTELEGRAM_BOT_TOKEN=1234567890:AAExample-RawSecretValueHere\n",
    );
    fs.writeFileSync(
      proxyEnvFile,
      [
        "export NODE_OPTIONS='--require=nemoclaw-sandbox-safety-net --require=nemoclaw-ciao-network-guard'",
        "export SLACK_BOT_TOKEN=xoxb-example-hostile-runtime-secret",
        "",
      ].join("\n"),
    );
    fs.chmodSync(proxyEnvFile, 0o444);
    writeStub(harness.stubsDir, "python3", `${SHARED_PYTHON_STUB_BY_MODE}\n`);
    stubBaselineUtilities(harness.stubsDir, harness.pkillLog, harness.hermesLaunchMarker);

    try {
      const result = runRecovery({
        ...harness,
        validatorPath,
        envFilePath: envFile,
        proxyEnvPath: proxyEnvFile,
        extraEnv: {
          STUB_ENVFILE_EXIT: "1",
          STUB_RUNTIMEENV_EXIT: "1",
          STUB_VALIDATOR_MODE_LOG: validatorModeLog,
        },
      });
      expect(result.status).toBe(1);
      expect(result.stdout.match(/SECRET_BOUNDARY_REFUSED/g)).toHaveLength(1);
      expect(fs.existsSync(harness.hermesLaunchMarker)).toBe(false);
      expect(fs.readFileSync(validatorModeLog, "utf-8").trim().split("\n")).toEqual(["env-file"]);
      const pkillCalls = fs.readFileSync(harness.pkillLog, "utf-8");
      expect(pkillCalls).toContain("[h]ermes");
      expect(pkillCalls).toContain("gateway");
      expect(pkillCalls).toContain("dashboard");
      const log = fs.readFileSync(harness.recoveryLogPath, "utf-8");
      expect(log).toContain("/sandbox/.hermes/.env contains raw secret-shaped values");
      expect(log).not.toContain("the process environment contains raw secret-shaped values");
    } finally {
      removeTempDir(harness.tmp);
    }
  }, 20_000);

  it("does not import a raw secret from a metadata-safe proxy-env", () => {
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
});
