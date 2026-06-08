// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it, expect } from "vitest";
import {
  HERMES_SECRET_BOUNDARY_VALIDATOR_PATH,
  __testing,
} from "../../../dist/lib/agent/hermes-recovery-boundary";
import {
  buildHermesDashboardProcessRecoveryScript,
  buildManualRecoveryCommand,
  buildRecoveryScript,
} from "../../../dist/lib/agent/runtime";
import type { AgentDefinition } from "./defs";

function makeAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: "test-agent",
    displayName: "Test Agent",
    binary_path: "/usr/local/bin/test-agent",
    gateway_command: "test-agent gateway run",
    healthProbe: { url: "http://127.0.0.1:19000/", port: 19000, timeout_seconds: 5 },
    forwardPort: 19000,
    dashboard: { kind: "ui", label: "UI", path: "/", healthPath: "/health", auth: "url_token" },
    configPaths: {
      dir: "/tmp/agent",
      configFile: "/tmp/agent/config.yaml",
      envFile: null,
      format: "yaml",
    },
    inferenceProviderOptions: [],
    stateDirs: [],
    stateFiles: [],
    versionCommand: "test-agent --version",
    expectedVersion: null,
    hasDevicePairing: false,
    phoneHomeHosts: [],
    messagingPlatforms: [],
    dockerfileBasePath: null,
    dockerfilePath: null,
    startScriptPath: null,
    policyAdditionsPath: null,
    policyPermissivePath: null,
    pluginDir: null,
    legacyPaths: null,
    agentDir: "/tmp/agent",
    manifestPath: "/tmp/agent/manifest.yaml",
    ...overrides,
  };
}

const minimalAgent = makeAgent();
const hermesAgent = makeAgent({
  name: "hermes",
  displayName: "Hermes Agent",
  binary_path: "/usr/local/bin/hermes",
  gateway_command: "hermes gateway run",
  healthProbe: { url: "http://localhost:8642/health", port: 8642, timeout_seconds: 90 },
  forwardPort: 8642,
  configPaths: {
    dir: "/sandbox/.hermes",
    configFile: "/sandbox/.hermes/config.yaml",
    envFile: "/sandbox/.hermes/.env",
    format: "yaml",
  },
});

const VALIDATOR_PATH = HERMES_SECRET_BOUNDARY_VALIDATOR_PATH;

describe("Hermes secret-boundary guard — generated shell shape", () => {
  it("invokes the env-file validator before launching the Hermes gateway", () => {
    const script = buildRecoveryScript(hermesAgent, 8642);
    expect(script).not.toBeNull();
    expect(script).toContain(VALIDATOR_PATH);
    expect(script).toContain(`python3 '${VALIDATOR_PATH}' env-file /sandbox/.hermes/.env`);
  });

  it("invokes the runtime-env validator after sourcing /tmp/nemoclaw-proxy-env.sh", () => {
    const script = buildRecoveryScript(hermesAgent, 8642);
    expect(script).not.toBeNull();
    const proxyEnvIdx = script!.indexOf(". /tmp/nemoclaw-proxy-env.sh");
    const runtimeGuardIdx = script!.indexOf(
      `python3 '${VALIDATOR_PATH}' runtime-env`,
    );
    const launchIdx = script!.indexOf("nohup");
    expect(proxyEnvIdx).toBeGreaterThanOrEqual(0);
    expect(runtimeGuardIdx).toBeGreaterThanOrEqual(0);
    expect(launchIdx).toBeGreaterThanOrEqual(0);
    expect(proxyEnvIdx).toBeLessThan(runtimeGuardIdx);
    expect(runtimeGuardIdx).toBeLessThan(launchIdx);
  });

  it("refuses the relaunch with SECRET_BOUNDARY_REFUSED on env-file violation", () => {
    const script = buildRecoveryScript(hermesAgent, 8642);
    expect(script).toContain("SECRET_BOUNDARY_REFUSED");
    expect(script).toContain("exit 1");
  });

  it("env-file guard runs before the ALREADY_RUNNING health probe so a poisoned gateway gets stopped", () => {
    const script = buildRecoveryScript(hermesAgent, 8642);
    expect(script).not.toBeNull();
    const guardIdx = script!.indexOf(
      `python3 '${VALIDATOR_PATH}' env-file /sandbox/.hermes/.env`,
    );
    const probeIdx = script!.indexOf("ALREADY_RUNNING");
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    expect(probeIdx).toBeGreaterThanOrEqual(0);
    expect(guardIdx).toBeLessThan(probeIdx);
  });

  it("kills running Hermes gateway and dashboard on boundary failure", () => {
    const script = buildRecoveryScript(hermesAgent, 8642);
    expect(script).toContain("[h]ermes[[:space:]]+gateway");
    expect(script).toContain("[h]ermes[[:space:]]+dashboard");
    expect(script).toContain("pkill -TERM -f");
    expect(script).toContain("pkill -KILL -f");
  });

  it("warns and continues recovery on older sandbox images that lack the validator", () => {
    const script = buildRecoveryScript(hermesAgent, 8642);
    expect(script).not.toContain("SECRET_BOUNDARY_VALIDATOR_MISSING");
    expect(script).toContain("[gateway-recovery] WARNING");
    expect(script).toContain("secret-boundary validator");
    expect(script).toContain("missing on this sandbox image");
  });

  it("does not gate non-Hermes recovery on the Hermes-specific validator", () => {
    const script = buildRecoveryScript(minimalAgent, 19000);
    expect(script).not.toContain("validate-hermes-env-secret-boundary.py");
    expect(script).not.toContain("SECRET_BOUNDARY_REFUSED");
  });

  it("guards the dashboard-only recovery path with env-file before sourcing and runtime-env after", () => {
    const script = buildHermesDashboardProcessRecoveryScript({
      publicPort: 9119,
      internalPort: 19119,
      tuiEnabled: false,
    });
    const envFileIdx = script.indexOf(
      `python3 '${VALIDATOR_PATH}' env-file /sandbox/.hermes/.env`,
    );
    const proxyEnvIdx = script.indexOf(". /tmp/nemoclaw-proxy-env.sh");
    const runtimeIdx = script.indexOf(`python3 '${VALIDATOR_PATH}' runtime-env`);
    const launchIdx = script.indexOf('"$AGENT_BIN" dashboard');
    expect(envFileIdx).toBeGreaterThanOrEqual(0);
    expect(proxyEnvIdx).toBeGreaterThanOrEqual(0);
    expect(runtimeIdx).toBeGreaterThanOrEqual(0);
    expect(launchIdx).toBeGreaterThanOrEqual(0);
    expect(envFileIdx).toBeLessThan(proxyEnvIdx);
    expect(proxyEnvIdx).toBeLessThan(runtimeIdx);
    expect(runtimeIdx).toBeLessThan(launchIdx);
    expect(script).toContain("SECRET_BOUNDARY_REFUSED");
  });

  it("guards manual Hermes recovery copy-paste command", () => {
    const cmd = buildManualRecoveryCommand(hermesAgent, 8642);
    expect(cmd).toContain(`python3 '${VALIDATOR_PATH}' env-file /sandbox/.hermes/.env`);
    expect(cmd).toContain(`python3 '${VALIDATOR_PATH}' runtime-env`);
    expect(cmd).toContain("SECRET_BOUNDARY_REFUSED");
    const guardIdx = cmd.indexOf(`python3 '${VALIDATOR_PATH}'`);
    const launchIdx = cmd.indexOf("nohup hermes gateway run");
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    expect(launchIdx).toBeGreaterThanOrEqual(0);
    expect(guardIdx).toBeLessThan(launchIdx);
  });

  it("does not gate the non-Hermes manual recovery command", () => {
    const cmd = buildManualRecoveryCommand(minimalAgent, 19000);
    expect(cmd).not.toContain("validate-hermes-env-secret-boundary.py");
    expect(cmd).not.toContain("SECRET_BOUNDARY_REFUSED");
  });
});

describe("Hermes secret-boundary guard — behavioural", () => {
  function writeStub(dir: string, name: string, body: string) {
    const stub = path.join(dir, name);
    fs.writeFileSync(stub, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
    return stub;
  }

  function runGuard(opts: {
    guard: string;
    pythonExit: 0 | 1;
    validatorExists: boolean;
  }) {
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
    const validatorPath = path.join(
      validatorRoot,
      "validate-hermes-env-secret-boundary.py",
    );
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
        'wait',
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
    const gatewayKills = result.pkillCalls.filter((line) => line.includes("[h]ermes") && line.includes("gateway"));
    const dashboardKills = result.pkillCalls.filter((line) => line.includes("[h]ermes") && line.includes("dashboard"));
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

  it("full Hermes recovery script exits 1, kills processes, and never reaches the gateway launch when env-file is poisoned", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-recovery-full-"));
    const stubsDir = path.join(tmp, "bin");
    const validatorRoot = path.join(tmp, "usr-local-lib-nemoclaw");
    const pkillLog = path.join(tmp, "pkill.log");
    const recoveryLogPath = path.join(tmp, "gateway-recovery.log");
    const hermesLaunchMarker = path.join(tmp, "hermes-launched");
    fs.mkdirSync(stubsDir, { recursive: true });
    fs.mkdirSync(validatorRoot, { recursive: true });
    fs.writeFileSync(
      path.join(validatorRoot, "validate-hermes-env-secret-boundary.py"),
      "#!/usr/bin/env python3\nimport sys\nsys.exit(0)\n",
    );

    writeStub(
      stubsDir,
      "python3",
      'printf "[SECURITY] Refusing Hermes startup because /sandbox/.hermes/.env contains raw secret-shaped values.\\n" >&2\nprintf "[SECURITY]   TELEGRAM_BOT_TOKEN (line 2)\\n" >&2\nexit 1',
    );
    writeStub(stubsDir, "pkill", `printf '%s\\n' "$*" >> ${JSON.stringify(pkillLog)}\nexit 0`);
    writeStub(stubsDir, "pgrep", "exit 1");
    writeStub(stubsDir, "sleep", "exit 0");
    writeStub(stubsDir, "curl", 'printf "000"\nexit 0');
    writeStub(stubsDir, "hermes", `: > ${JSON.stringify(hermesLaunchMarker)}\nexit 0`);

    const validatorPath = path.join(validatorRoot, "validate-hermes-env-secret-boundary.py");
    const recoveryScript = buildRecoveryScript(hermesAgent, 8642);
    expect(recoveryScript).not.toBeNull();
    const stubbed = recoveryScript!
      .replace(new RegExp(HERMES_SECRET_BOUNDARY_VALIDATOR_PATH, "g"), validatorPath)
      .replace(/\/tmp\/gateway-recovery\.log/g, recoveryLogPath);

    const scriptPath = path.join(tmp, "recovery.sh");
    fs.writeFileSync(
      scriptPath,
      ["#!/usr/bin/env bash", `export PATH=${JSON.stringify(stubsDir)}:/usr/bin:/bin`, stubbed].join("\n"),
      { mode: 0o700 },
    );

    try {
      const result = spawnSync("bash", [scriptPath], {
        encoding: "utf-8",
        timeout: 15000,
        env: { PATH: `${stubsDir}:/usr/bin:/bin`, HOME: tmp },
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("SECRET_BOUNDARY_REFUSED");
      expect(result.stdout).not.toContain("GATEWAY_PID=");
      expect(result.stdout).not.toContain("ALREADY_RUNNING");
      expect(fs.existsSync(hermesLaunchMarker)).toBe(false);
      const pkillCalls = fs.readFileSync(pkillLog, "utf-8");
      expect(pkillCalls).toContain("[h]ermes");
      expect(pkillCalls).toContain("gateway");
      expect(pkillCalls).toContain("dashboard");
      const log = fs.readFileSync(recoveryLogPath, "utf-8");
      expect(log).toContain("[SECURITY] Refusing Hermes startup");
      expect(log).toContain("TELEGRAM_BOT_TOKEN (line 2)");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("full Hermes recovery refuses against an actual poisoned .env using the real Python validator", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-recovery-real-"));
    const stubsDir = path.join(tmp, "bin");
    const pkillLog = path.join(tmp, "pkill.log");
    const recoveryLogPath = path.join(tmp, "gateway-recovery.log");
    const hermesLaunchMarker = path.join(tmp, "hermes-launched");
    const envFile = path.join(tmp, "hermes-dot-env");
    const realValidator = path.join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "agents",
      "hermes",
      "validate-env-secret-boundary.py",
    );
    fs.mkdirSync(stubsDir, { recursive: true });
    fs.writeFileSync(
      envFile,
      "API_SERVER_PORT=18642\nTELEGRAM_BOT_TOKEN=1234567890:AAExample-RawSecretValueHere\n",
    );

    writeStub(stubsDir, "pkill", `printf '%s\\n' "$*" >> ${JSON.stringify(pkillLog)}\nexit 0`);
    writeStub(stubsDir, "pgrep", "exit 1");
    writeStub(stubsDir, "sleep", "exit 0");
    writeStub(stubsDir, "curl", 'printf "000"\nexit 0');
    writeStub(stubsDir, "hermes", `: > ${JSON.stringify(hermesLaunchMarker)}\nexit 0`);

    const recoveryScript = buildRecoveryScript(hermesAgent, 8642);
    expect(recoveryScript).not.toBeNull();
    const stubbed = recoveryScript!
      .replace(new RegExp(HERMES_SECRET_BOUNDARY_VALIDATOR_PATH, "g"), realValidator)
      .replace(/\/sandbox\/\.hermes\/\.env/g, envFile)
      .replace(/\/tmp\/gateway-recovery\.log/g, recoveryLogPath);

    const scriptPath = path.join(tmp, "recovery.sh");
    fs.writeFileSync(
      scriptPath,
      ["#!/usr/bin/env bash", `export PATH=${JSON.stringify(stubsDir)}:/usr/bin:/bin`, stubbed].join("\n"),
      { mode: 0o700 },
    );

    try {
      const result = spawnSync("bash", [scriptPath], {
        encoding: "utf-8",
        timeout: 15000,
        env: { PATH: `${stubsDir}:/usr/bin:/bin`, HOME: tmp },
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("SECRET_BOUNDARY_REFUSED");
      expect(fs.existsSync(hermesLaunchMarker)).toBe(false);
      const log = fs.readFileSync(recoveryLogPath, "utf-8");
      expect(log).toContain("[SECURITY] Refusing Hermes startup");
      expect(log).toContain("TELEGRAM_BOT_TOKEN");
      expect(log).toContain("(line 2)");
      expect(log).not.toContain("1234567890:AAExample-RawSecretValueHere");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("full Hermes recovery refuses on runtime-env violation after sourcing proxy-env", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-recovery-runtime-"));
    const stubsDir = path.join(tmp, "bin");
    const validatorRoot = path.join(tmp, "usr-local-lib-nemoclaw");
    const pkillLog = path.join(tmp, "pkill.log");
    const recoveryLogPath = path.join(tmp, "gateway-recovery.log");
    const hermesLaunchMarker = path.join(tmp, "hermes-launched");
    const proxyEnvFile = path.join(tmp, "nemoclaw-proxy-env.sh");
    fs.mkdirSync(stubsDir, { recursive: true });
    fs.mkdirSync(validatorRoot, { recursive: true });
    fs.writeFileSync(
      path.join(validatorRoot, "validate-hermes-env-secret-boundary.py"),
      "#!/usr/bin/env python3\n",
    );
    fs.writeFileSync(
      proxyEnvFile,
      "export NODE_OPTIONS='--require=nemoclaw-sandbox-safety-net --require=nemoclaw-ciao-network-guard'\n",
    );

    writeStub(
      stubsDir,
      "python3",
      [
        'if [ "$1" = "-c" ]; then',
        "  exit 0",
        "fi",
        'mode="$2"',
        'if [ "$mode" = "env-file" ]; then',
        "  exit 0",
        "fi",
        'if [ "$mode" = "runtime-env" ]; then',
        '  printf "[SECURITY] Refusing Hermes startup because the process environment contains raw secret-shaped values.\\n" >&2',
        '  printf "[SECURITY]   TELEGRAM_BOT_TOKEN\\n" >&2',
        "  exit 1",
        "fi",
        "exit 2",
      ].join("\n"),
    );
    writeStub(stubsDir, "pkill", `printf '%s\\n' "$*" >> ${JSON.stringify(pkillLog)}\nexit 0`);
    writeStub(stubsDir, "pgrep", "exit 1");
    writeStub(stubsDir, "sleep", "exit 0");
    writeStub(stubsDir, "curl", 'printf "000"\nexit 0');
    writeStub(stubsDir, "hermes", `: > ${JSON.stringify(hermesLaunchMarker)}\nexit 0`);

    const validatorPath = path.join(validatorRoot, "validate-hermes-env-secret-boundary.py");
    const gatewayLogPath = path.join(tmp, "gateway.log");
    const recoveryFallbackLog = path.join(tmp, "gateway-recovery-fallback.log");
    const recoveryScript = buildRecoveryScript(hermesAgent, 8642);
    expect(recoveryScript).not.toBeNull();
    const stubbed = recoveryScript!
      .replace(new RegExp(HERMES_SECRET_BOUNDARY_VALIDATOR_PATH, "g"), validatorPath)
      .replace(/\/tmp\/gateway-recovery\.log/g, recoveryLogPath)
      .replace(/\/tmp\/nemoclaw-proxy-env\.sh/g, proxyEnvFile)
      .replace(/\/tmp\/gateway\.log/g, gatewayLogPath)
      .replace(
        /_GATEWAY_LOG=\/tmp\/gateway-recovery\.log/g,
        `_GATEWAY_LOG=${recoveryFallbackLog}`,
      );

    const scriptPath = path.join(tmp, "recovery.sh");
    fs.writeFileSync(
      scriptPath,
      ["#!/usr/bin/env bash", `export PATH=${JSON.stringify(stubsDir)}:/usr/bin:/bin`, stubbed].join("\n"),
      { mode: 0o700 },
    );

    try {
      const result = spawnSync("bash", [scriptPath], {
        encoding: "utf-8",
        timeout: 15000,
        env: { PATH: `${stubsDir}:/usr/bin:/bin`, HOME: tmp },
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("SECRET_BOUNDARY_REFUSED");
      expect(fs.existsSync(hermesLaunchMarker)).toBe(false);
      const log = fs.readFileSync(recoveryLogPath, "utf-8");
      expect(log).toContain("[SECURITY] Refusing Hermes startup because the process environment");
      expect(log).toContain("TELEGRAM_BOT_TOKEN");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
