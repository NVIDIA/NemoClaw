// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { shellQuote } from "../../../src/lib/core/shell-quote";
import {
  extractShellFunction as extractShellFunctionFromSource,
  LOCKED_HERMES_CONFIG_STAT_MOCK,
  runHermesSandboxInitPreludeWithFakePath,
  writeFakeProcCmdline,
} from "../../support/hermes-shell-harness";

const START_SCRIPT = path.join(import.meta.dirname, "../../..", "agents", "hermes", "start.sh");
const ENV_WRAPPER = path.join(
  import.meta.dirname,
  "../../../scripts/lib/entrypoint-env-wrapper.sh",
);
const TIRITH_FINALIZER = path.join(
  import.meta.dirname,
  "../../..",
  "agents",
  "hermes",
  "finalize-tirith-marker.py",
);
const SECRET_BOUNDARY_VALIDATOR_SCRIPT = path.join(
  import.meta.dirname,
  "../../..",
  "agents",
  "hermes",
  "validate-env-secret-boundary.py",
);
const GENERATED_API_SERVER_KEY = Array.from({ length: 64 }, (_value, index) =>
  (index % 16).toString(16),
).join("");

function filesystemFingerprint(entry: string): string {
  const fd = fs.openSync(entry, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const metadata = fs.fstatSync(fd);
    const contents = metadata.isDirectory() ? "" : fs.readFileSync(fd, "utf8");
    return `${metadata.dev}:${metadata.ino}:${metadata.uid}:${metadata.gid}:${metadata.mode & 0o7777}:${metadata.size}:${metadata.mtimeMs}:${contents}`;
  } finally {
    fs.closeSync(fd);
  }
}

function createHermesUnsafeLogFixture(
  tmpDir: string,
  hermesHome: string,
  kind: "root-symlink" | "nested-symlink" | "fifo",
): { before: string[]; fingerprint: () => string[] } {
  if (kind === "fifo") {
    const fifo = path.join(hermesHome, "logs", "curator", "unsafe.fifo");
    fs.mkdirSync(path.dirname(fifo), { recursive: true });
    const created = spawnSync("mkfifo", [fifo], { encoding: "utf-8" });
    if (created.status !== 0) throw new Error(`mkfifo failed: ${created.stderr}`);
    const fingerprint = () => {
      const metadata = fs.lstatSync(fifo);
      return [`${metadata.dev}:${metadata.ino}:${metadata.mode & 0o7777}:${metadata.size}`];
    };
    return { before: fingerprint(), fingerprint };
  }
  const target = path.join(tmpDir, "unsafe-log-target");
  const sentinel = path.join(target, "sentinel.log");
  fs.mkdirSync(target);
  fs.writeFileSync(sentinel, "outside sentinel\n", { mode: 0o640 });
  if (kind === "root-symlink") {
    fs.symlinkSync(target, path.join(hermesHome, "logs"));
  } else {
    const nested = path.join(hermesHome, "logs", "curator", "nested");
    fs.mkdirSync(nested, { recursive: true });
    fs.symlinkSync(sentinel, path.join(nested, "sentinel-link"));
  }
  const fingerprint = () => [filesystemFingerprint(target), filesystemFingerprint(sentinel)];
  return { before: fingerprint(), fingerprint };
}

type MutableLayoutTarget = "." | "hooks" | "image_cache" | "audio_cache";

function createLayoutSwapFixture(tmpDir: string, hermesHome: string, target: MutableLayoutTarget) {
  const externalRoot = path.join(tmpDir, "unsafe-layout-target");
  const sentinel = path.join(externalRoot, "sentinel.txt");
  const originalEntry = path.join(tmpDir, `original-${target === "." ? "hermes-root" : target}`);
  const injectedScript = path.join(tmpDir, "layout-repair.py");
  const fakeBin = path.join(tmpDir, "layout-swap-bin");
  fs.mkdirSync(externalRoot);
  fs.writeFileSync(sentinel, "outside sentinel\n", { mode: 0o640 });
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(
    path.join(fakeBin, "python3"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `if [ "\${NEMOCLAW_HERMES_LAYOUT_DIR_NAME:-}" != ${shellQuote(target)} ]; then`,
      `  export PATH=${shellQuote(process.env.PATH ?? "")}`,
      '  exec python3 "$@"',
      "fi",
      `tee ${shellQuote(injectedScript)} >/dev/null`,
      `export NEMOCLAW_TEST_LAYOUT_ROOT=${shellQuote(hermesHome)}`,
      `export NEMOCLAW_TEST_LAYOUT_TARGET=${shellQuote(target)}`,
      `export NEMOCLAW_TEST_LAYOUT_EXTERNAL=${shellQuote(externalRoot)}`,
      `export NEMOCLAW_TEST_LAYOUT_ORIGINAL=${shellQuote(originalEntry)}`,
      `export NEMOCLAW_TEST_LAYOUT_SCRIPT=${shellQuote(injectedScript)}`,
      `export PATH=${shellQuote(process.env.PATH ?? "")}`,
      "exec python3 -I -c '",
      "import os",
      "real_fchmod = os.fchmod",
      "def swap_then_fchmod(fd, mode):",
      '    root = os.environ["NEMOCLAW_TEST_LAYOUT_ROOT"]',
      '    target = os.environ["NEMOCLAW_TEST_LAYOUT_TARGET"]',
      '    source = root if target == "." else os.path.join(root, target)',
      '    os.rename(source, os.environ["NEMOCLAW_TEST_LAYOUT_ORIGINAL"])',
      '    os.symlink(os.environ["NEMOCLAW_TEST_LAYOUT_EXTERNAL"], source)',
      "    return real_fchmod(fd, mode)",
      "os.fchmod = swap_then_fchmod",
      'script = os.environ["NEMOCLAW_TEST_LAYOUT_SCRIPT"]',
      'exec(compile(open(script, encoding="utf-8").read(), script, "exec"))',
      "'",
    ].join("\n"),
    { mode: 0o700 },
  );
  const fingerprint = () => [filesystemFingerprint(externalRoot), filesystemFingerprint(sentinel)];
  return { fakeBin, before: fingerprint(), fingerprint };
}

function extractRuntimeShellEnvBlock(src: string): string {
  const start = src.indexOf("write_runtime_shell_env() {");
  const end = src.indexOf("\nwrite_runtime_shell_env\n", start);
  if (start < 0 || end < 0) {
    throw new Error("Expected write_runtime_shell_env block in agents/hermes/start.sh");
  }
  return src.slice(start, end).trimEnd();
}

function runHermesLazyInstallTargetBootstrap(childEnv: NodeJS.ProcessEnv) {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  const start = src.indexOf('HERMES_DIR="/sandbox/.hermes"');
  const end = src.indexOf("\nHERMES_HASH_FILE=", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return spawnSync(
    "bash",
    ["-c", `${src.slice(start, end)}\nprintf '%s\\n' "$HERMES_LAZY_INSTALL_TARGET"`],
    { encoding: "utf-8", env: childEnv, timeout: 5000 },
  );
}

function extractDashboardPortBootstrap(src: string): string {
  const start = src.indexOf('NEMOCLAW_CMD=("$@")');
  const end = src.indexOf('\nHERMES="$(command -v hermes)"', start);
  if (start < 0 || end < 0) {
    throw new Error("Expected Hermes dashboard port bootstrap block in agents/hermes/start.sh");
  }
  return src.slice(start, end).trimEnd();
}

function runHermesDashboardPortBootstrap(env: Record<string, string | undefined> = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-port-bootstrap-"));
  const scriptPath = path.join(tmpDir, "run.sh");
  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      // macOS Bash 3.2 treats an empty array expansion as unbound under nounset.
      // This fixture deliberately starts with no command arguments.
      "set -eo pipefail",
      "set --",
      extractDashboardPortBootstrap(src),
      'printf "CHAT_UI_URL=%s\\n" "${CHAT_UI_URL:-}"',
      'printf "DASHBOARD_PUBLIC_PORT=%s\\n" "$DASHBOARD_PUBLIC_PORT"',
      'printf "DASHBOARD_INTERNAL_PORT=%s\\n" "$DASHBOARD_INTERNAL_PORT"',
      'printf "PUBLIC_PORT=%s\\n" "$PUBLIC_PORT"',
    ].join("\n"),
    { mode: 0o700 },
  );

  try {
    const childEnv = { ...process.env };
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) {
        delete childEnv[key];
      } else {
        childEnv[key] = value;
      }
    }
    return spawnSync("bash", [scriptPath], {
      encoding: "utf-8",
      timeout: 5000,
      env: childEnv,
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function runHermesDashboardArgs(tuiValue?: string) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-dashboard-args-"));
  const scriptPath = path.join(tmpDir, "run.sh");
  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      extractShellFunctionFromSource(src, "truthy_env"),
      extractShellFunctionFromSource(src, "hermes_dashboard_tui_enabled"),
      extractShellFunctionFromSource(src, "build_hermes_dashboard_args"),
      "DASHBOARD_INTERNAL_PORT=19119",
      tuiValue === undefined
        ? 'HERMES_DASHBOARD_TUI="${HERMES_DASHBOARD_TUI:-0}"'
        : `HERMES_DASHBOARD_TUI=${shellQuote(tuiValue)}`,
      "build_hermes_dashboard_args",
      'printf "%s\\n" "${HERMES_DASHBOARD_ARGS[@]}"',
    ].join("\n"),
    { mode: 0o700 },
  );

  try {
    return spawnSync("bash", [scriptPath], {
      encoding: "utf-8",
      timeout: 5000,
      env: process.env,
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function runHermesPortValidation(opts: {
  publicPort?: number;
  internalPort?: number;
  dashboardPublicPort?: number;
  dashboardInternalPort?: number;
}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-port-validation-"));
  const scriptPath = path.join(tmpDir, "run.sh");
  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      extractShellFunctionFromSource(src, "validate_tcp_port"),
      extractShellFunctionFromSource(src, "validate_port_configuration"),
      `PUBLIC_PORT=${opts.publicPort ?? 8642}`,
      `INTERNAL_PORT=${opts.internalPort ?? 18642}`,
      `DASHBOARD_PUBLIC_PORT=${opts.dashboardPublicPort ?? 18789}`,
      `DASHBOARD_INTERNAL_PORT=${opts.dashboardInternalPort ?? 19119}`,
      "validate_port_configuration",
    ].join("\n"),
    { mode: 0o700 },
  );

  try {
    return spawnSync("bash", [scriptPath], {
      encoding: "utf-8",
      timeout: 5000,
      env: process.env,
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function runHermesEnvSecretBoundary(opts: { envFile?: string; symlinkEnvFile?: boolean }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-env-boundary-"));
  const hermesHome = path.join(tmpDir, ".hermes");
  const envFile = path.join(hermesHome, ".env");
  const target = path.join(tmpDir, "env-target");
  const scriptPath = path.join(tmpDir, "run.sh");

  fs.mkdirSync(hermesHome, { recursive: true });
  if (opts.symlinkEnvFile) {
    fs.writeFileSync(target, opts.envFile ?? "DEVTEST_API_TOKEN=secret\n");
    fs.symlinkSync(target, envFile);
  } else if (opts.envFile !== undefined) {
    fs.writeFileSync(envFile, opts.envFile);
  }

  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      // Keep a nonempty no-op prefix: macOS Bash 3.2 rejects empty arrays, and BSD env has no `--`.
      '_HERMES_BOUNDARY_TIMEOUT=(command); _HERMES_PYTHON="$(command -v python3)"',
      extractShellFunctionFromSource(src, "validate_hermes_env_secret_boundary"),
      `HERMES_DIR=${shellQuote(hermesHome)}`,
      `_HERMES_BOUNDARY_VALIDATOR=${shellQuote(SECRET_BOUNDARY_VALIDATOR_SCRIPT)}`,
      "validate_hermes_env_secret_boundary",
    ].join("\n"),
    { mode: 0o700 },
  );

  try {
    return spawnSync("bash", [scriptPath], {
      encoding: "utf-8",
      timeout: 5000,
      env: process.env,
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function runHermesRuntimeEnvSecretBoundary(envOverrides: Record<string, string>) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-runtime-boundary-"));
  const scriptPath = path.join(tmpDir, "run.sh");
  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      // Keep a nonempty no-op prefix: macOS Bash 3.2 rejects empty arrays, and BSD env has no `--`.
      '_HERMES_BOUNDARY_TIMEOUT=(command); _HERMES_PYTHON="$(command -v python3)"',
      extractShellFunctionFromSource(src, "validate_hermes_runtime_env_secret_boundary"),
      `_HERMES_BOUNDARY_VALIDATOR=${shellQuote(SECRET_BOUNDARY_VALIDATOR_SCRIPT)}`,
      "validate_hermes_runtime_env_secret_boundary",
    ].join("\n"),
    { mode: 0o700 },
  );

  try {
    return spawnSync("bash", [scriptPath], {
      encoding: "utf-8",
      timeout: 5000,
      env: {
        HOME: tmpDir,
        PATH: process.env.PATH ?? "",
        _HERMES_BOUNDARY_VALIDATOR: SECRET_BOUNDARY_VALIDATOR_SCRIPT,
        HERMES_LAZY_INSTALL_TARGET: "/sandbox/.hermes/lazy-packages",
        ...envOverrides,
      },
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function extractTirithDispatchBlock(src: string, mode: "non-root" | "root"): string {
  const nonRootStart = src.indexOf("# ── Non-root fallback");
  const rootStart = src.indexOf("# ── Root path");
  if (nonRootStart < 0 || rootStart < 0 || rootStart <= nonRootStart) {
    throw new Error("Expected root and non-root dispatch blocks in agents/hermes/start.sh");
  }
  return mode === "non-root" ? src.slice(nonRootStart, rootStart) : src.slice(rootStart);
}

function runTirithExplicitCommandDispatch(mode: "non-root" | "root") {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-tirith-dispatch-"));
  const hermesHome = path.join(tmpDir, ".hermes");
  const marker = path.join(hermesHome, ".tirith-install-failed");
  const scriptPath = path.join(tmpDir, "run.sh");

  fs.mkdirSync(hermesHome, { recursive: true });
  fs.writeFileSync(marker, "download_failed");

  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      extractShellFunctionFromSource(src, "retry_tirith_marker_if_needed"),
      extractShellFunctionFromSource(src, "prepare_tirith_marker_retry"),
      mode === "root"
        ? 'id() { if [ "${1:-}" = "-u" ]; then printf "0\\n"; else command id "$@"; fi; }'
        : 'id() { if [ "${1:-}" = "-u" ]; then printf "1000\\n"; else command id "$@"; fi; }',
      "verify_config_integrity_if_locked() { :; }",
      "verify_config_integrity() { :; }",
      "verify_hermes_config_integrity() { :; }",
      "ensure_hermes_config_root_mode() { :; }",
      "apply_shields_up_runtime_env() { :; }",
      "validate_hermes_env_secret_boundary() { :; }",
      "validate_hermes_runtime_env_secret_boundary() { :; }",
      "ensure_hermes_runtime_api_server_key() { :; }",
      "refresh_hermes_runtime_config_hashes() { :; }",
      "refresh_hermes_provider_placeholders() { :; }",
      "configure_messaging_channels() { :; }",
      "prepare_hermes_nonroot_runtime() { prepare_tirith_marker_retry; }",
      "prepare_hermes_root_runtime() { prepare_tirith_marker_retry; }",
      'cleanup_stale_hermes_gateway_runtime() { echo "unexpected gateway cleanup" >&2; return 99; }',
      `HERMES_DIR=${shellQuote(hermesHome)}`,
      `HERMES_HASH_FILE=${shellQuote(path.join(tmpDir, "hermes.config-hash"))}`,
      `_HERMES_PYTHON=${shellQuote(process.env.PYTHON || "python3")}`,
      `_HERMES_TIRITH_MARKER_FINALIZER=${shellQuote(TIRITH_FINALIZER)}`,
      "STEP_DOWN_PREFIX_SANDBOX=(env)",
      'NEMOCLAW_CMD=(bash -c \'test ! -e "$1/.tirith-install-failed"\' bash "$HERMES_DIR")',
      extractTirithDispatchBlock(src, mode),
    ].join("\n"),
    { mode: 0o700 },
  );

  try {
    const result = spawnSync("bash", [scriptPath], {
      encoding: "utf-8",
      timeout: 5000,
      env: process.env,
    });
    return {
      result,
      markerExists: fs.existsSync(marker),
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function runHermesRootStartupMutableRootPreflight() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-root-preflight-"));
  const hermesHome = path.join(tmpDir, ".hermes");
  const scriptPath = path.join(tmpDir, "run.sh");

  fs.mkdirSync(hermesHome, { recursive: true });
  fs.chmodSync(hermesHome, 0o750);

  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      extractShellFunctionFromSource(src, "hermes_config_path_is_locked"),
      extractShellFunctionFromSource(src, "hermes_config_root_is_locked"),
      extractShellFunctionFromSource(src, "ensure_hermes_mutable_layout_dir"),
      extractShellFunctionFromSource(src, "ensure_hermes_config_root_mode"),
      'id() { [ "${1:-}" = "-u" ] && printf "1000\\n" || command id "$@"; }',
      'dir_mode() { python3 -I -c "import os,sys; print(oct(os.stat(sys.argv[1]).st_mode & 0o7777)[2:])" "$HERMES_DIR"; }',
      'verify_hermes_config_integrity() { printf "verify mode=%s\\n" "$(dir_mode)"; }',
      'prepare_hermes_lazy_dependencies() { printf "lazy mode=%s\\n" "$(dir_mode)"; }',
      'ensure_hermes_runtime_api_server_key() { printf "api-key mode=%s\\n" "$(dir_mode)"; }',
      "apply_shields_up_runtime_env() { :; }",
      "validate_hermes_env_secret_boundary() { :; }",
      "validate_hermes_runtime_env_secret_boundary() { :; }",
      "refresh_hermes_provider_placeholders() { :; }",
      "refresh_hermes_runtime_config_hashes() { :; }",
      "configure_messaging_channels() { :; }",
      'retry_tirith_marker_if_needed() { printf "tirith-state=%s\\n" "$TIRITH_RETRY_MARKER_CLEARED"; }',
      "prepare_tirith_marker_retry() { TIRITH_RETRY_MARKER_CLEARED=0; retry_tirith_marker_if_needed; }",
      extractShellFunctionFromSource(src, "prepare_hermes_root_runtime"),
      'cleanup_stale_hermes_gateway_runtime() { echo "unexpected gateway cleanup" >&2; return 99; }',
      `HERMES_DIR=${shellQuote(hermesHome)}`,
      `HERMES_HASH_FILE=${shellQuote(path.join(tmpDir, "hermes.config-hash"))}`,
      "STEP_DOWN_PREFIX_SANDBOX=(env)",
      "NEMOCLAW_CMD=(bash -c 'exit 0')",
      extractTirithDispatchBlock(src, "root"),
    ].join("\n"),
    { mode: 0o700 },
  );

  try {
    const result = spawnSync("bash", [scriptPath], {
      encoding: "utf-8",
      timeout: 5000,
      env: process.env,
    });
    return {
      result,
      hermesDirMode: (fs.statSync(hermesHome).mode & 0o7777).toString(8),
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function runTirithFinalizerPathResolution(installed: boolean) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-tirith-path-"));
  const scriptPath = path.join(tmpDir, "run.sh");
  const installedPath = path.join(tmpDir, "installed-finalizer.py");
  const fallbackPath = path.join(tmpDir, "finalize-tirith-marker.py");
  const source = fs.readFileSync(START_SCRIPT, "utf-8");
  const start = source.indexOf(
    '_HERMES_TIRITH_MARKER_FINALIZER="/usr/local/lib/nemoclaw/finalize-tirith-marker.py"',
  );
  const end = source.indexOf("\n_HERMES_GUARD_TIMEOUT=", start);
  const resolver = source
    .slice(start, end)
    .replace("/usr/local/lib/nemoclaw/finalize-tirith-marker.py", installedPath);
  fs.writeFileSync(fallbackPath, "#!/usr/bin/env python3\n", { mode: 0o755 });
  void (installed ? fs.writeFileSync(installedPath, "#!/usr/bin/env python3\n") : undefined);
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      resolver,
      'printf "%s\\n" "$_HERMES_TIRITH_MARKER_FINALIZER"',
    ].join("\n"),
    { mode: 0o700 },
  );

  try {
    return {
      expected: installed ? installedPath : fallbackPath,
      result: spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 5000 }),
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

type HermesStateDir = "sessions" | "gateway" | "runtime";

function runHermesGatewayRuntimeCleanup(opts: {
  liveGateway?: boolean;
  liveGatewayArgv?: string[];
  orphanSocat?: boolean;
  orphanDashboardSocat?: boolean;
  staleLock?: boolean;
  stalePid?: boolean;
  lockedConfigRoot?: boolean;
  preExistingLogFile?: boolean | "hardlink-to-config" | "hardlink-to-env";
  unsafeLog?: "root-symlink" | "nested-symlink" | "fifo";
  swapLayoutDir?: MutableLayoutTarget;
  preExistingHistory?: "regular" | "symlink" | "directory" | "hardlink-to-config";
  unsafeState?: readonly [name: HermesStateDir, kind: "symlink" | "file"];
}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-runtime-cleanup-"));
  const hermesHome = path.join(tmpDir, ".hermes");
  const runtimeDir = path.join(hermesHome, "runtime");
  const cronDir = path.join(hermesHome, "cron");
  const procRoot = path.join(tmpDir, "proc");
  const killLog = path.join(tmpDir, "kill.log");
  const scriptPath = path.join(tmpDir, "run.sh");
  const legacyPid = path.join(hermesHome, "gateway.pid");
  const runtimePid = path.join(runtimeDir, "gateway.pid");
  const runtimeLock = path.join(runtimeDir, "gateway.lock");
  const agentLogPath = path.join(hermesHome, "logs", "agent.log");
  const pythonImportSentinel = path.join(tmpDir, "python-import-sentinel");
  const configYamlPath = path.join(hermesHome, "config.yaml");
  const envFilePath = path.join(hermesHome, ".env");
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(cronDir);
  fs.mkdirSync(path.join(hermesHome, "sessions"), { mode: 0o750 });
  fs.chmodSync(path.join(hermesHome, "sessions"), 0o750);
  fs.chmodSync(runtimeDir, 0o2770);
  fs.chmodSync(cronDir, 0o2770);
  fs.mkdirSync(procRoot, { recursive: true });
  const needsConfigFile =
    opts.lockedConfigRoot ||
    opts.preExistingLogFile === "hardlink-to-config" ||
    opts.preExistingHistory === "hardlink-to-config";
  if (needsConfigFile) fs.writeFileSync(configYamlPath, "model: test\n", { mode: 0o600 });
  void (opts.lockedConfigRoot || opts.preExistingLogFile === "hardlink-to-env"
    ? fs.writeFileSync(envFilePath, "HERMES_TEST=1\n", { mode: 0o600 })
    : undefined);
  void (opts.preExistingLogFile === true
    ? (fs.mkdirSync(path.dirname(agentLogPath), { recursive: true }),
      fs.writeFileSync(agentLogPath, "pre-existing log\n", { mode: 0o644 }))
    : opts.preExistingLogFile === "hardlink-to-config"
      ? (fs.mkdirSync(path.dirname(agentLogPath), { recursive: true }),
        fs.linkSync(configYamlPath, agentLogPath))
      : opts.preExistingLogFile === "hardlink-to-env"
        ? (fs.mkdirSync(path.dirname(agentLogPath), { recursive: true }),
          fs.linkSync(envFilePath, agentLogPath))
        : undefined);
  const unsafeLogFixture = opts.unsafeLog
    ? createHermesUnsafeLogFixture(tmpDir, hermesHome, opts.unsafeLog)
    : undefined;
  const layoutSwapFixture = opts.swapLayoutDir
    ? createLayoutSwapFixture(tmpDir, hermesHome, opts.swapLayoutDir)
    : undefined;
  if (opts.lockedConfigRoot) {
    fs.chmodSync(hermesHome, 0o755);
    fs.chmodSync(cronDir, 0o755);
  }
  const historyPath = path.join(hermesHome, ".hermes_history");
  const symlinkTarget = path.join(tmpDir, "history-target");
  if (opts.preExistingHistory === "regular") {
    fs.writeFileSync(historyPath, "pre-existing\n", { mode: 0o600 });
  } else if (opts.preExistingHistory === "symlink") {
    fs.writeFileSync(symlinkTarget, "attacker\n");
    fs.symlinkSync(symlinkTarget, historyPath);
  } else if (opts.preExistingHistory === "directory") {
    fs.mkdirSync(historyPath);
  } else if (opts.preExistingHistory === "hardlink-to-config") {
    fs.linkSync(configYamlPath, historyPath);
  }
  fs.symlinkSync("runtime/gateway.pid", legacyPid);
  if (opts.stalePid !== false) fs.writeFileSync(runtimePid, "999999\n");
  if (opts.staleLock !== false) fs.writeFileSync(runtimeLock, "stale lock");
  let unsafeStatePath: string | undefined;
  let unsafeStateTarget: string | undefined;
  let unsafeStateBefore: string | undefined;
  void (opts.unsafeState
    ? (() => {
        const [name, kind] = opts.unsafeState;
        const entry = path.join(hermesHome, name);
        fs.rmSync(entry, { recursive: true, force: true });
        const setups = {
          symlink: () => {
            const target = path.join(tmpDir, `${name}-target`);
            fs.mkdirSync(target, { mode: 0o750 });
            fs.chmodSync(target, 0o750);
            fs.symlinkSync(target, entry);
            return target;
          },
          file: () => {
            fs.writeFileSync(entry, "attacker\n", { mode: 0o640 });
            fs.chmodSync(entry, 0o640);
            return entry;
          },
        };
        const target = setups[kind]();
        unsafeStatePath = entry;
        unsafeStateTarget = target;
        unsafeStateBefore = `${kind}:${filesystemFingerprint(target)}`;
      })()
    : undefined);
  if (opts.liveGateway) {
    writeFakeProcCmdline(
      procRoot,
      123,
      opts.liveGatewayArgv ?? ["/usr/local/bin/hermes", "gateway", "run"],
    );
  }
  if (opts.orphanSocat) {
    writeFakeProcCmdline(procRoot, 456, [
      "socat",
      "TCP-LISTEN:8642,bind=0.0.0.0,fork,reuseaddr",
      "TCP:127.0.0.1:18642",
    ]);
  }
  if (opts.orphanDashboardSocat) {
    writeFakeProcCmdline(procRoot, 789, [
      "socat",
      "TCP-LISTEN:18789,bind=0.0.0.0,fork,reuseaddr",
      "TCP:127.0.0.1:19119",
    ]);
  }
  fs.writeFileSync(
    path.join(tmpDir, "sitecustomize.py"),
    `from pathlib import Path\nPath(${JSON.stringify(pythonImportSentinel)}).write_text("loaded")\n`,
  );

  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `PYTHONPATH=${shellQuote(tmpDir)}`,
      "export PYTHONPATH",
      extractShellFunctionFromSource(src, "cmdline_is_hermes_gateway"),
      extractShellFunctionFromSource(src, "has_live_hermes_gateway"),
      extractShellFunctionFromSource(src, "cleanup_orphan_socat_forwarders"),
      extractShellFunctionFromSource(src, "remove_stale_gateway_file"),
      extractShellFunctionFromSource(src, "hermes_config_path_is_locked"),
      extractShellFunctionFromSource(src, "hermes_config_root_is_locked"),
      extractShellFunctionFromSource(src, "ensure_hermes_mutable_layout_dir"),
      extractShellFunctionFromSource(src, "ensure_hermes_config_root_mode"),
      extractShellFunctionFromSource(src, "ensure_hermes_state_dir"),
      extractShellFunctionFromSource(src, "ensure_hermes_cross_uid_state_dir"),
      extractShellFunctionFromSource(src, "repair_hermes_log_permissions"),
      extractShellFunctionFromSource(src, "ensure_hermes_history_file"),
      extractShellFunctionFromSource(src, "fail_hermes_startup_layout_repair"),
      extractShellFunctionFromSource(src, "repair_hermes_startup_layout"),
      extractShellFunctionFromSource(src, "cleanup_stale_hermes_gateway_runtime"),
      `KILL_LOG=${shellQuote(killLog)}`,
      'kill() { printf "%s\\n" "$*" >>"$KILL_LOG"; return 0; }',
      'id() { if [ "${1:-}" = "-u" ]; then printf "1000\\n"; else command id "$@"; fi; }',
      `HERMES_DIR=${shellQuote(hermesHome)}`,
      `NEMOCLAW_PROC_ROOT=${shellQuote(procRoot)}`,
      opts.lockedConfigRoot ? LOCKED_HERMES_CONFIG_STAT_MOCK : "",
      "PUBLIC_PORT=8642",
      "INTERNAL_PORT=18642",
      "DASHBOARD_PUBLIC_PORT=18789",
      "DASHBOARD_INTERNAL_PORT=19119",
      "cleanup_stale_hermes_gateway_runtime",
    ].join("\n"),
    { mode: 0o700 },
  );

  try {
    const result = spawnSync("bash", [scriptPath], {
      encoding: "utf-8",
      timeout: 15_000,
      env: layoutSwapFixture
        ? { ...process.env, PATH: `${layoutSwapFixture.fakeBin}:${process.env.PATH ?? ""}` }
        : process.env,
    });
    const legacyPidStat = fs.lstatSync(legacyPid, { throwIfNoEntry: false });
    const modeEntry = (entry: string, mask: number): [string, string] => {
      const entryPath = path.join(hermesHome, entry);
      const entryMode = fs.existsSync(entryPath)
        ? (fs.statSync(entryPath).mode & mask).toString(8)
        : "missing";
      return [entry, entryMode];
    };
    const requiredDirs = Object.fromEntries(
      "sessions gateway runtime cron logs logs/curator hooks image_cache audio_cache"
        .split(" ")
        .map((entry) => modeEntry(entry, 0o777)),
    );
    const requiredDirFullModes = Object.fromEntries(
      ["sessions", "gateway", "runtime", "cron", "logs", "logs/curator"].map((entry) =>
        modeEntry(entry, 0o7777),
      ),
    );
    const historyStat = fs.lstatSync(historyPath, { throwIfNoEntry: false });
    let historyMode = "missing";
    let historyKind: "missing" | "regular" | "symlink" | "directory" | "other" = "missing";
    let historyContent = "";
    if (historyStat) {
      historyMode = (historyStat.mode & 0o777).toString(8);
      if (historyStat.isSymbolicLink()) historyKind = "symlink";
      else if (historyStat.isDirectory()) historyKind = "directory";
      else if (historyStat.isFile()) historyKind = "regular";
      else historyKind = "other";
      if (historyKind === "regular") {
        const historyFd = fs.openSync(historyPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          const openedHistoryStat = fs.fstatSync(historyFd);
          expect(
            openedHistoryStat.isFile() &&
              openedHistoryStat.dev === historyStat.dev &&
              openedHistoryStat.ino === historyStat.ino,
            "Hermes history fixture changed during inspection",
          ).toBe(true);
          historyContent = fs.readFileSync(historyFd, "utf-8");
        } finally {
          fs.closeSync(historyFd);
        }
      }
    }
    const symlinkTargetContent = fs.existsSync(symlinkTarget)
      ? fs.readFileSync(symlinkTarget, "utf-8")
      : "";
    const configYamlMode = fs.existsSync(configYamlPath)
      ? (fs.statSync(configYamlPath).mode & 0o777).toString(8)
      : "missing";
    const configYamlContent = fs.existsSync(configYamlPath)
      ? fs.readFileSync(configYamlPath, "utf-8")
      : "";
    const envFileMode = fs.existsSync(envFilePath)
      ? (fs.statSync(envFilePath).mode & 0o777).toString(8)
      : "missing";
    const envFileContent = fs.existsSync(envFilePath) ? fs.readFileSync(envFilePath, "utf-8") : "";
    return {
      result,
      killLog: fs.existsSync(killLog) ? fs.readFileSync(killLog, "utf-8") : "",
      hermesDirMode: (fs.statSync(hermesHome).mode & 0o7777).toString(8),
      requiredDirs,
      requiredDirFullModes,
      agentLogMode: fs.existsSync(agentLogPath)
        ? (fs.statSync(agentLogPath).mode & 0o777).toString(8)
        : "missing",
      runtimePidExists: fs.existsSync(runtimePid),
      runtimeLockExists: fs.existsSync(runtimeLock),
      legacyPidExists: legacyPidStat !== undefined,
      legacyPidIsSymlink: legacyPidStat?.isSymbolicLink() ?? false,
      historyMode,
      historyKind,
      historyContent,
      pythonImportSentinelExists: fs.existsSync(pythonImportSentinel),
      unsafeLogBefore: unsafeLogFixture?.before,
      unsafeLogAfter: unsafeLogFixture?.fingerprint(),
      layoutSwapBefore: layoutSwapFixture?.before,
      layoutSwapAfter: layoutSwapFixture?.fingerprint(),
      symlinkTargetContent,
      unsafeStateBefore,
      unsafeStateAfter:
        unsafeStatePath && unsafeStateTarget
          ? `${fs.lstatSync(unsafeStatePath).isSymbolicLink() ? "symlink" : "file"}:${filesystemFingerprint(unsafeStateTarget)}`
          : undefined,
      configYamlMode,
      configYamlContent,
      envFileMode,
      envFileContent,
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function runRuntimeShellEnvBootstrap() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-runtime-env-"));
  const envFile = path.join(tmpDir, "nemoclaw-proxy-env.sh");
  const caFile = path.join(tmpDir, "proxy ca.pem");
  const hermesHome = path.join(tmpDir, ".hermes");
  const scriptPath = path.join(tmpDir, "run.sh");

  fs.mkdirSync(hermesHome, { recursive: true });
  fs.writeFileSync(caFile, "ca");

  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'emit_sandbox_sourced_file() { cat >"$1"; chmod 444 "$1"; }',
      `_PROXY_ENV_FILE=${shellQuote(envFile)}`,
      `_PROXY_URL=${shellQuote("http://10.200.0.1:3128")}`,
      `_NO_PROXY_VAL=${shellQuote("localhost,127.0.0.1,::1,10.200.0.1")}`,
      `HERMES_DIR=${shellQuote(hermesHome)}`,
      `SSL_CERT_FILE=${shellQuote(caFile)}`,
      "CURL_CA_BUNDLE=",
      "REQUESTS_CA_BUNDLE=",
      "GIT_SSL_CAINFO=",
      extractRuntimeShellEnvBlock(src),
      "write_runtime_shell_env",
    ].join("\n"),
    { mode: 0o700 },
  );

  try {
    const result = spawnSync("bash", [scriptPath], {
      encoding: "utf-8",
      timeout: 5000,
      env: { ...process.env, AWS_EC2_METADATA_DISABLED: "false" },
    });
    const envFileContent = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf-8") : "";
    const envFileMode = fs.existsSync(envFile)
      ? (fs.statSync(envFile).mode & 0o777).toString(8)
      : "";
    const guardResult = spawnSync("bash", ["-c", `. ${shellQuote(envFile)}; hermes setup`], {
      encoding: "utf-8",
      timeout: 5000,
      env: { ...process.env, PATH: "/usr/bin:/bin" },
    });
    const sourcedEnvResult = spawnSync(
      "bash",
      ["-c", `. ${shellQuote(envFile)}; printf '%s' "$SSL_CERT_FILE"`],
      {
        encoding: "utf-8",
        timeout: 5000,
        env: { ...process.env, PATH: "/usr/bin:/bin" },
      },
    );

    return {
      src,
      result,
      envFileContent,
      envFileMode,
      guardResult,
      hermesHome,
      caFile,
      sourcedEnvResult,
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("agents/hermes/start.sh sandbox init bootstrap", () => {
  it("locks the trusted PATH before sourcing shared sandbox init", () => {
    const { result, dirnameCalled, sourcePath } = runHermesSandboxInitPreludeWithFakePath(
      START_SCRIPT,
      ENV_WRAPPER,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(dirnameCalled).toBe(false);
    expect(sourcePath).toBe("/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
  });
});

describe("agents/hermes/start.sh runtime shell env", () => {
  it("defaults the managed lazy dependency target without replacing an explicit target (#9211)", () => {
    const { HERMES_LAZY_INSTALL_TARGET: _ignored, ...envWithoutTarget } = process.env;
    const defaulted = runHermesLazyInstallTargetBootstrap(envWithoutTarget);
    const preserved = runHermesLazyInstallTargetBootstrap({
      ...process.env,
      HERMES_LAZY_INSTALL_TARGET: "/sandbox/custom-lazy-packages",
    });

    expect(defaulted.status, defaulted.stderr).toBe(0);
    expect(defaulted.stdout.trim()).toBe("/sandbox/.hermes/lazy-packages");
    expect(preserved.status, preserved.stderr).toBe(0);
    expect(preserved.stdout.trim()).toBe("/sandbox/custom-lazy-packages");
  });

  it("puts the Hermes configure guard in the sourced proxy env file", () => {
    const run = runRuntimeShellEnvBootstrap();

    expect(run.result.status).toBe(0);
    expect(run.envFileMode).toBe("444");
    expect(run.envFileContent).toContain(`export HERMES_HOME="${run.hermesHome}"`);
    expect(run.envFileContent).toContain(
      'export HERMES_LAZY_INSTALL_TARGET="/sandbox/.hermes/lazy-packages"',
    );
    expect(run.envFileContent).toContain('export HERMES_TUI_DIR="/opt/hermes/ui-tui"');
    expect(run.envFileContent).not.toContain("AWS_EC2_METADATA_DISABLED");
    expect(run.envFileContent).not.toContain('HERMES_TUI_DIR="${HERMES_TUI_DIR:-');
    expect(run.sourcedEnvResult.status, run.sourcedEnvResult.stderr).toBe(0);
    expect(run.sourcedEnvResult.stdout).toBe(run.caFile);
    expect(run.envFileContent).toContain("# nemoclaw-configure-guard begin");
    expect(run.envFileContent).toContain("hermes() {");
    expect(run.envFileContent).toContain("# nemoclaw-configure-guard end");
    expect(run.envFileContent).not.toContain(".bashrc");
    expect(run.envFileContent).not.toContain(".profile");

    expect(run.guardResult.status).toBe(1);
    expect(run.guardResult.stderr).toContain(
      "Error: 'hermes setup' cannot modify config inside the sandbox.",
    );
  });
});

describe("agents/hermes/start.sh port validation", () => {
  it("derives the dashboard port from CHAT_UI_URL while preserving API port 8642", () => {
    const run = runHermesDashboardPortBootstrap({
      CHAT_UI_URL: "https://hermes.example.test:29443",
      NEMOCLAW_DASHBOARD_PORT: undefined,
    });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("CHAT_UI_URL=https://hermes.example.test:29443");
    expect(run.stdout).toContain("DASHBOARD_PUBLIC_PORT=29443");
    expect(run.stdout).toContain("PUBLIC_PORT=8642");
  });

  it("rejects dashboard ports that collide with the API port during bootstrap", () => {
    const fromChatUrl = runHermesDashboardPortBootstrap({
      CHAT_UI_URL: "http://127.0.0.1:8642",
      NEMOCLAW_DASHBOARD_PORT: undefined,
    });
    expect(fromChatUrl.status).toBe(1);
    expect(fromChatUrl.stderr).toContain("reserved for the Hermes OpenAI-compatible API");

    const invalidOverride = runHermesDashboardPortBootstrap({
      CHAT_UI_URL: undefined,
      NEMOCLAW_DASHBOARD_PORT: "not-a-port",
    });
    expect(invalidOverride.status).toBe(1);
    expect(invalidOverride.stderr).toContain("Invalid NEMOCLAW_DASHBOARD_PORT");
  });

  it("keeps the managed dashboard isolated and its in-browser Hermes TUI opt-in", () => {
    const defaultArgs = runHermesDashboardArgs();
    expect(defaultArgs.status).toBe(0);
    expect(defaultArgs.stdout.split("\n")).not.toContain("--tui");

    const optInArgs = runHermesDashboardArgs("1");
    expect(optInArgs.status).toBe(0);
    expect(optInArgs.stdout.split("\n")).toEqual(expect.arrayContaining(["--isolated", "--tui"]));
  });

  it("rejects cross-collisions between API and dashboard ports", () => {
    const dashboardPublicOnApiInternal = runHermesPortValidation({
      dashboardPublicPort: 18642,
    });
    expect(dashboardPublicOnApiInternal.status).toBe(1);
    expect(dashboardPublicOnApiInternal.stderr).toContain(
      "DASHBOARD_PUBLIC_PORT must not equal INTERNAL_PORT",
    );

    const dashboardInternalOnApiPublic = runHermesPortValidation({
      dashboardInternalPort: 8642,
    });
    expect(dashboardInternalOnApiPublic.status).toBe(1);
    expect(dashboardInternalOnApiPublic.stderr).toContain(
      "DASHBOARD_INTERNAL_PORT must not equal PUBLIC_PORT",
    );
  });
});

describe("agents/hermes/start.sh validator-path bootstrap", () => {
  function extractValidatorBootstrapBlock(src: string): string {
    const startMarker = "# Resolve the standalone secret-boundary validator";
    const start = src.indexOf(startMarker);
    if (start < 0) {
      throw new Error("Expected validator bootstrap comment in agents/hermes/start.sh");
    }
    const fiNeedle = "\nfi\n";
    const end = src.indexOf(fiNeedle, start);
    if (end < 0) {
      throw new Error("Expected closing 'fi' in validator bootstrap block");
    }
    return src.slice(start, end + fiNeedle.length);
  }

  it("ignores a caller-supplied _HERMES_BOUNDARY_VALIDATOR and resolves to the installed validator", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-validator-bootstrap-"));
    const installRoot = path.join(tmpDir, "usr-local-lib-nemoclaw");
    const installValidator = path.join(installRoot, "validate-hermes-env-secret-boundary.py");
    const evilValidator = path.join(tmpDir, "evil-validator.py");
    fs.mkdirSync(installRoot, { recursive: true });
    fs.writeFileSync(installValidator, "#!/usr/bin/env python3\n");
    fs.writeFileSync(evilValidator, "#!/usr/bin/env python3\n");

    const src = fs.readFileSync(START_SCRIPT, "utf-8");
    const bootstrap = extractValidatorBootstrapBlock(src).replaceAll(
      "/usr/local/lib/nemoclaw/validate-hermes-env-secret-boundary.py",
      installValidator,
    );
    const scriptPath = path.join(tmpDir, "run.sh");
    fs.writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        bootstrap,
        'printf "FINAL=%s\\n" "$_HERMES_BOUNDARY_VALIDATOR"',
      ].join("\n"),
      { mode: 0o700 },
    );

    try {
      const result = spawnSync("bash", [scriptPath], {
        encoding: "utf-8",
        timeout: 5000,
        env: {
          HOME: tmpDir,
          PATH: process.env.PATH ?? "",
          _HERMES_BOUNDARY_VALIDATOR: evilValidator,
        },
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`FINAL=${installValidator}`);
      expect(result.stdout).not.toContain(`FINAL=${evilValidator}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("falls back to the script-relative validator when the install path is absent", () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-hermes-validator-bootstrap-fallback-"),
    );
    const scriptDir = path.join(tmpDir, "agents", "hermes");
    const fallbackValidator = path.join(scriptDir, "validate-env-secret-boundary.py");
    fs.mkdirSync(scriptDir, { recursive: true });
    fs.writeFileSync(fallbackValidator, "#!/usr/bin/env python3\n");

    const src = fs.readFileSync(START_SCRIPT, "utf-8");
    const missingInstallPath = path.join(tmpDir, "definitely-not-installed.py");
    const bootstrap = extractValidatorBootstrapBlock(src).replaceAll(
      "/usr/local/lib/nemoclaw/validate-hermes-env-secret-boundary.py",
      missingInstallPath,
    );
    const scriptPath = path.join(scriptDir, "start.sh");
    fs.writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        bootstrap,
        'printf "FINAL=%s\\n" "$_HERMES_BOUNDARY_VALIDATOR"',
      ].join("\n"),
      { mode: 0o700 },
    );

    try {
      const result = spawnSync("bash", [scriptPath], {
        encoding: "utf-8",
        timeout: 5000,
        env: {
          HOME: tmpDir,
          PATH: process.env.PATH ?? "",
          _HERMES_BOUNDARY_VALIDATOR: "/tmp/evil-via-env",
        },
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`FINAL=${fallbackValidator}`);
      expect(result.stdout).not.toContain("/tmp/evil-via-env");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("agents/hermes/start.sh env secret boundary", () => {
  it("allows OpenShell resolver placeholders and Slack SDK aliases", () => {
    const result = runHermesEnvSecretBoundary({
      envFile: [
        "TELEGRAM_BOT_TOKEN=openshell:resolve:env:TELEGRAM_BOT_TOKEN",
        "DISCORD_BOT_TOKEN='openshell:resolve:env:DISCORD_BOT_TOKEN'",
        "SLACK_BOT_TOKEN=xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
        "SLACK_BOT_TOKEN_ROTATED=xoxb-OPENSHELL-RESOLVE-ENV-v42_SLACK_BOT_TOKEN_ROTATED",
        'SLACK_APP_TOKEN="xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN"',
        "API_SERVER_PORT=18642",
        "API_SERVER_HOST=127.0.0.1",
        "EMPTY_TOKEN=",
        "LEGACY_SECRET=[STRIPPED_BY_MIGRATION]",
        "",
      ].join("\n"),
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("allows a raw API_SERVER_KEY (Hermes loopback api_server token)", () => {
    const result = runHermesEnvSecretBoundary({
      envFile: [
        "API_SERVER_PORT=18642",
        "API_SERVER_HOST=127.0.0.1",
        `API_SERVER_KEY=${GENERATED_API_SERVER_KEY}`,
        "",
      ].join("\n"),
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("rejects raw secret-shaped values without printing the value", () => {
    const rawToken = "SENTINEL_RAW_SECRET_VALUE";
    const result = runHermesEnvSecretBoundary({
      envFile: `DEVTEST_API_TOKEN=${rawToken}\n`,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("raw secret-shaped values");
    expect(result.stderr).toContain("DEVTEST_API_TOKEN (line 1)");
    expect(result.stderr).not.toContain(rawToken);
  });

  it("rejects bare API-named raw values without printing the value", () => {
    const rawToken = "SENTINEL_RAW_SECRET_VALUE";
    const result = runHermesEnvSecretBoundary({
      envFile: `INTERNAL_API=${rawToken}\n`,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("INTERNAL_API (line 1)");
    expect(result.stderr).not.toContain(rawToken);
  });

  it("rejects credential-shaped rewrite sentinels in Hermes .env", () => {
    const result = runHermesEnvSecretBoundary({
      envFile: "OPENAI_API_KEY=sk-OPENSHELL-PROXY-REWRITE\n",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("OPENAI_API_KEY (line 1)");
    expect(result.stderr).not.toContain("sk-OPENSHELL-PROXY-REWRITE");
  });

  it("rejects symlinked Hermes .env files", () => {
    const result = runHermesEnvSecretBoundary({
      envFile: "TELEGRAM_BOT_TOKEN=openshell:resolve:env:TELEGRAM_BOT_TOKEN\n",
      symlinkEnvFile: true,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("is a symlink");
  });

  it("allows gateway token, nonsecret config names, and resolver placeholders in process env", () => {
    const result = runHermesRuntimeEnvSecretBoundary({
      API_SERVER_HOST: "127.0.0.1",
      API_SERVER_PORT: "18642",
      EMPTY_TOKEN: "",
      GPG_KEY: "public-build-key-fingerprint",
      LEGACY_SECRET: "[STRIPPED_BY_MIGRATION]",
      NEMOCLAW_INFERENCE_API: "openai-completions",
      NEMOCLAW_PROVIDER_KEY: "custom",
      OPENCLAW_GATEWAY_TOKEN: "raw-gateway-token",
      SLACK_BOT_TOKEN: "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
      TELEGRAM_BOT_TOKEN: "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("rejects inherited API_SERVER_KEY process env values", () => {
    const inheritedKey = GENERATED_API_SERVER_KEY;
    const result = runHermesRuntimeEnvSecretBoundary({
      API_SERVER_HOST: "127.0.0.1",
      API_SERVER_PORT: "18642",
      API_SERVER_KEY: inheritedKey,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("process environment");
    expect(result.stderr).toContain("API_SERVER_KEY");
    expect(result.stderr).not.toContain(inheritedKey);
  });

  it("rejects raw secret-shaped process env values without printing the value", () => {
    const rawToken = "SENTINEL_RAW_SECRET_VALUE";
    const result = runHermesRuntimeEnvSecretBoundary({
      DEVTEST_API_TOKEN: rawToken,
      NEMOCLAW_HERMES_TOOL_GATEWAY_REFRESH_TOKEN: "raw-refresh-token",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("process environment");
    expect(result.stderr).toContain("DEVTEST_API_TOKEN");
    expect(result.stderr).toContain("NEMOCLAW_HERMES_TOOL_GATEWAY_REFRESH_TOKEN");
    expect(result.stderr).not.toContain(rawToken);
    expect(result.stderr).not.toContain("raw-refresh-token");
  });
});

describe("agents/hermes/start.sh gateway runtime cleanup", () => {
  it("removes stale Hermes pid and lock files plus the legacy compatibility pid symlink", () => {
    const run = runHermesGatewayRuntimeCleanup({});
    expect(run.result.status).toBe(0);
    expect(run.runtimePidExists).toBe(false);
    expect(run.runtimeLockExists).toBe(false);
    expect(run.legacyPidExists).toBe(false);
    expect(run.legacyPidIsSymlink).toBe(false);
    expect(run.result.stderr).toContain("Removing stale Hermes runtime PID file");
    expect(run.result.stderr).toContain("Removing unsafe stale Hermes legacy PID file symlink");
    expect(run.result.stderr).toContain("Removing stale Hermes lock file");
  });

  it("repairs the Hermes v0.14 writable directory layout before launch", () => {
    const run = runHermesGatewayRuntimeCleanup({
      staleLock: false,
      stalePid: false,
      preExistingLogFile: true,
    });
    expect(run.result.status).toBe(0);
    expect(run.hermesDirMode).toBe("3770");
    expect(run.requiredDirs).toMatchObject({
      hooks: "770",
      image_cache: "770",
      audio_cache: "770",
    });
    expect(run.requiredDirFullModes).toMatchObject({
      sessions: "2770",
      gateway: "2770",
      runtime: "2770",
      cron: "2770",
      logs: "2770",
      "logs/curator": "2770",
    });
    expect(run.agentLogMode).toBe("660");
    expect(run.historyKind).toBe("regular");
    expect(run.historyMode).toBe("660");
    expect(run.historyContent).toBe("");
  });

  it.each([
    ["sessions", "symlink", "is a symlink"],
    ["sessions", "file", "is not a directory"],
    ["gateway", "symlink", "is a symlink"],
    ["gateway", "file", "is not a directory"],
    ["runtime", "symlink", "is a symlink"],
    ["runtime", "file", "is not a directory"],
  ] as const)("refuses an unsafe %s %s without mutation", (name, kind, message) => {
    const run = runHermesGatewayRuntimeCleanup({ unsafeState: [name, kind] });
    expect(run.result.status).not.toBe(0);
    expect(run.legacyPidIsSymlink).toBe(true);
    expect(run.unsafeStateBefore).toBeDefined();
    expect(run.unsafeStateAfter).toBe(run.unsafeStateBefore);
    expect(run.result.stderr).toContain("Refusing Hermes cross-UID state repair");
    expect(run.result.stderr).toContain(`/${name} ${message}`);
    expect(run.result.stderr).toContain(
      `Hermes pre-launch layout repair failed at ${name} state directory`,
    );
    expect(run.result.stderr).toContain(
      "Restore a trusted snapshot into a recreated sandbox, or recreate from host-side onboarding configuration.",
    );
  });

  it("preserves a pre-existing Hermes history file and reasserts its mode", () => {
    const run = runHermesGatewayRuntimeCleanup({
      staleLock: false,
      stalePid: false,
      preExistingHistory: "regular",
    });
    expect(run.result.status).toBe(0);
    expect(run.historyKind).toBe("regular");
    expect(run.historyMode).toBe("660");
    expect(run.historyContent).toBe("pre-existing\n");
  });

  it.each([
    [false, "symlink", "symlink", ".hermes_history is a symlink"],
    [true, "symlink", "symlink", ".hermes_history is a symlink"],
    [false, "directory", "directory", ".hermes_history is not a regular file"],
    [true, "directory", "directory", ".hermes_history is not a regular file"],
    [false, "hardlink-to-config", "regular", ".hermes_history has hard-link count"],
  ] as const)(
    "refuses unsafe history with locked root=%s and kind=%s",
    (locked, kind, expectedKind, message) => {
      const run = runHermesGatewayRuntimeCleanup({
        lockedConfigRoot: locked,
        staleLock: false,
        stalePid: false,
        preExistingHistory: kind,
      });
      expect(run.result.status).not.toBe(0);
      expect(run.historyKind).toBe(expectedKind);
      expect(run.symlinkTargetContent).toBe(kind === "symlink" ? "attacker\n" : "");
      expect(run.result.stderr).toContain("Refusing Hermes layout repair because");
      expect(run.result.stderr).toContain(message);
      expect(run.result.stderr).toContain("Hermes pre-launch layout repair failed at history file");
      expect(run.result.stderr).toContain(
        "Restore a trusted snapshot into a recreated sandbox, or recreate from host-side onboarding configuration.",
      );
    },
  );

  it("repairs runtime parents and history without reopening cron job definitions", () => {
    const run = runHermesGatewayRuntimeCleanup({ lockedConfigRoot: true });
    expect(run.result.status).toBe(0);
    expect(run.hermesDirMode).toBe("755");
    expect(run.requiredDirs).toMatchObject({
      logs: "missing",
      "logs/curator": "missing",
      hooks: "missing",
      image_cache: "missing",
      audio_cache: "missing",
    });
    expect(run.historyKind).toBe("regular");
    expect(run.requiredDirFullModes).toMatchObject({
      sessions: "2770",
      gateway: "2770",
      runtime: "2770",
      cron: "755",
    });
    expect(run.historyMode).toBe("660");
    expect(run.historyContent).toBe("");
    expect(run.pythonImportSentinelExists).toBe(false);
    expect(run.runtimePidExists).toBe(false);
    expect(run.runtimeLockExists).toBe(false);
    expect(run.legacyPidExists).toBe(false);
    expect(run.result.stderr).toContain(
      "Hermes layout repair limited to history file because config root is locked",
    );
  });

  it.each([".", "hooks", "image_cache", "audio_cache"] as const)(
    "rejects a swapped mutable layout directory %s after validation without mutating its external target",
    (swapLayoutDir) => {
      const run = runHermesGatewayRuntimeCleanup({ swapLayoutDir });
      const resource = swapLayoutDir === "." ? "config root" : `${swapLayoutDir} directory`;
      expect(run.result.status).not.toBe(0);
      expect(run.layoutSwapAfter).toEqual(run.layoutSwapBefore);
      expect(run.result.stderr).toContain(`layout repair failed at ${resource}`);
      expect(run.result.stderr).toContain("Restore a trusted snapshot into a recreated sandbox");
    },
  );

  it("fails Hermes startup when the locked-root history path hard-links a sealed config file", () => {
    const run = runHermesGatewayRuntimeCleanup({
      lockedConfigRoot: true,
      preExistingHistory: "hardlink-to-config",
    });

    expect(run.result.status).not.toBe(0);
    expect(run.historyKind).toBe("regular");
    expect(run.result.stderr).toContain("Refusing Hermes layout repair because");
    expect(run.result.stderr).toContain("has hard-link count");
    expect(run.result.stderr).toContain("Hermes pre-launch layout repair failed at history file");
    expect(run.result.stderr).toContain("Restore a trusted snapshot into a recreated sandbox");
    expect(run.configYamlMode).toBe("600");
    expect(run.configYamlContent).toBe("model: test\n");
  });

  it("repair_hermes_log_permissions rejects log files hard-linked to config.yaml or .env and preserves config/env mode and content", () => {
    const [configRun, envRun] = (["hardlink-to-config", "hardlink-to-env"] as const).map(
      (preExistingLogFile) =>
        runHermesGatewayRuntimeCleanup({ staleLock: false, stalePid: false, preExistingLogFile }),
    );

    expect(configRun.result.status).not.toBe(0);
    expect(configRun.result.stderr).toContain("Refusing Hermes log repair because");
    expect(configRun.result.stderr).toContain("has hard-link count");
    expect(configRun.configYamlMode).toBe("600");
    expect(configRun.configYamlContent).toBe("model: test\n");
    expect(envRun.result.status).not.toBe(0);
    expect(envRun.result.stderr).toContain("Refusing Hermes log repair because");
    expect(envRun.result.stderr).toContain("has hard-link count");
    expect(envRun.envFileMode).toBe("600");
    expect(envRun.envFileContent).toBe("HERMES_TEST=1\n");
  });

  it.each([
    ["root-symlink", "/logs is a symlink"],
    ["nested-symlink", "/logs/curator/nested/sentinel-link is a symlink"],
    ["fifo", "/logs/curator/unsafe.fifo is not a regular file or directory"],
  ] as const)(
    "rejects unsafe logs %s without mutating the entry or its external target",
    (unsafeLog, message) => {
      const run = runHermesGatewayRuntimeCleanup({ unsafeLog, staleLock: false, stalePid: false });
      expect(run.result.status).not.toBe(0);
      expect(run.unsafeLogBefore).toBeDefined();
      expect(run.unsafeLogAfter).toEqual(run.unsafeLogBefore);
      expect(run.result.stderr).toContain(message);
      expect(run.result.stderr).toContain(
        "Hermes pre-launch layout repair failed at logs directory",
      );
      expect(run.result.stderr).toContain(
        "Restore a trusted snapshot into a recreated sandbox, or recreate from host-side onboarding configuration.",
      );
    },
  );

  it.each([
    ["gateway", { orphanSocat: true }, "456", "Removing orphaned socat forwarder"],
    ["dashboard", { orphanDashboardSocat: true }, "789", "Removing orphaned dashboard socat"],
  ] as const)("kills orphaned %s socat forwarders", (_name, orphan, pid, message) => {
    const run = runHermesGatewayRuntimeCleanup({
      ...orphan,
      staleLock: false,
      stalePid: false,
    });

    expect(run.result.status).toBe(0);
    expect(run.killLog.trim()).toBe(pid);
    expect(run.result.stderr).toContain(message);
  });

  it.each([undefined, ["/usr/local/bin/hermes.real", "gateway", "run"]])(
    "preserves runtime state for a live gateway process [case %#]",
    (liveGatewayArgv) => {
      const run = runHermesGatewayRuntimeCleanup({
        liveGateway: true,
        liveGatewayArgv,
        orphanSocat: true,
      });

      expect(run.result.status).toBe(0);
      expect(run.runtimePidExists).toBe(true);
      expect(run.runtimeLockExists).toBe(true);
      expect(run.legacyPidIsSymlink).toBe(true);
      expect(run.killLog).toBe("");
      expect(run.result.stderr).toContain("Existing Hermes gateway process detected");
    },
  );
});

describe("agents/hermes/start.sh Tirith marker bootstrap", () => {
  it.each([true, false])(
    "resolves the installed Tirith finalizer before fallback (%s)",
    (installed) => {
      const run = runTirithFinalizerPathResolution(installed);

      expect(run.result.status, run.result.stderr).toBe(0);
      expect(run.result.stdout.trim()).toBe(run.expected);
    },
  );

  it.each(["non-root", "root"] as const)(
    "removes retryable Tirith markers before explicit command dispatch [case %#]",
    (mode) => {
      const run = runTirithExplicitCommandDispatch(mode);

      expect(run.result.status, `${mode}: ${run.result.stderr}`).toBe(0);
      expect(run.markerExists, mode).toBe(false);
      expect(run.result.stderr).toContain(
        "download_failed marker present; letting Hermes runtime fallback retry Tirith",
      );
    },
  );

  it("repairs the Hermes config root before strict runtime config updates", () => {
    const run = runHermesRootStartupMutableRootPreflight();

    expect(run.result.status).toBe(0);
    expect(run.result.stdout).toContain("verify mode=750");
    expect(run.result.stdout).toContain("lazy mode=750");
    expect(run.result.stdout).toContain("api-key mode=3770");
    expect(run.result.stdout).toContain("tirith-state=0");
    expect(run.hermesDirMode).toBe("3770");
  });
});
