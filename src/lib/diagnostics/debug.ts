// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";

import { dockerExecFileSync } from "../adapters/docker/exec";
import { DASHBOARD_PORT } from "../core/ports";
import { listSandboxes } from "../state/registry";
import { createTarball as createDiagnosticsTarball } from "./tarball";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DebugOptions {
  /** Target sandbox name (auto-detected if omitted). */
  sandboxName?: string;
  /** Only collect minimal diagnostics. */
  quick?: boolean;
  /** Write a tarball to this path. */
  output?: string;
}

// ---------------------------------------------------------------------------
// Colour helpers — respect NO_COLOR
// ---------------------------------------------------------------------------

const useColor = !process.env.NO_COLOR && process.stdout.isTTY;
const GREEN = useColor ? "\x1b[0;32m" : "";
const YELLOW = useColor ? "\x1b[1;33m" : "";
const RED = useColor ? "\x1b[0;31m" : "";
const CYAN = useColor ? "\x1b[0;36m" : "";
const NC = useColor ? "\x1b[0m" : "";

function info(msg: string): void {
  console.log(`${GREEN}[debug]${NC} ${msg}`);
}

function warn(msg: string): void {
  console.log(`${YELLOW}[debug]${NC} ${msg}`);
}

function error(msg: string): void {
  console.error(`${RED}[debug]${NC} ${msg}`);
}

function section(title: string): void {
  console.log(`\n${CYAN}═══ ${title} ═══${NC}\n`);
}

// ---------------------------------------------------------------------------
// Secret redaction — delegates to unified redact module (#2381).
// ---------------------------------------------------------------------------

import { redactFull as redact } from "../security/redact";

export { redact };

// ---------------------------------------------------------------------------
// Command runner
// ---------------------------------------------------------------------------

const isMacOS = platform() === "darwin";
const TIMEOUT_MS = 30_000;
const DMESG_RESTRICT_PATH = "/proc/sys/kernel/dmesg_restrict";

function commandExists(cmd: string): boolean {
  try {
    // Use sh -c with the command as a separate argument to avoid shell injection.
    // While cmd values are hardcoded internally, this is defensive.
    execFileSync("sh", ["-c", `command -v "$1"`, "--", cmd], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function collect(collectDir: string, label: string, command: string, args: string[]): void {
  const filename = label.replace(/[ /]/g, (c) => (c === " " ? "_" : "-"));
  const outfile = join(collectDir, `${filename}.txt`);

  if (!commandExists(command)) {
    const msg = `  (${command} not found, skipping)`;
    console.log(msg);
    writeFileSync(outfile, msg + "\n");
    return;
  }

  const result = spawnSync(command, args, {
    timeout: TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  });

  const raw = (result.stdout ?? "") + "\n" + (result.stderr ?? "");
  const redacted = redact(raw);
  writeFileSync(outfile, redacted);
  console.log(redacted.trimEnd());

  if (result.status !== 0) {
    console.log("  (command exited with non-zero status)");
  }
}

/** Run a shell one-liner via `sh -c`. */
function collectShell(collectDir: string, label: string, shellCmd: string): void {
  const filename = label.replace(/[ /]/g, (c) => (c === " " ? "_" : "-"));
  const outfile = join(collectDir, `${filename}.txt`);

  const result = spawnSync("sh", ["-c", shellCmd], {
    timeout: TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  });

  const raw = (result.stdout ?? "") + "\n" + (result.stderr ?? "");
  const redacted = redact(raw);
  writeFileSync(outfile, redacted);
  console.log(redacted.trimEnd());

  if (result.status !== 0) {
    console.log("  (command exited with non-zero status)");
  }
}

function writeCollectedMessage(collectDir: string, label: string, message: string): void {
  const filename = label.replace(/[ /]/g, (c) => (c === " " ? "_" : "-"));
  const outfile = join(collectDir, `${filename}.txt`);
  writeFileSync(outfile, message + "\n");
  console.log(message);
}

export function isDmesgRestrictedForCurrentUser(
  restrictPath = DMESG_RESTRICT_PATH,
  euid = process.geteuid?.() ?? process.getuid?.() ?? 0,
): boolean {
  if (euid === 0) return false;

  try {
    return readFileSync(restrictPath, "utf-8").trim() === "1";
  } catch {
    return false;
  }
}

export function isDmesgPermissionDeniedOutput(output: string): boolean {
  if (!/\b(operation not permitted|permission denied)\b/i.test(output)) {
    return false;
  }
  return /\b(dmesg|kernel buffer|kernel logs?)\b/i.test(output);
}

/**
 * Build the option-aware re-run command for the dmesg-restricted hint.
 *
 * Preserves the user's original invocation flags (`--quick`, `--output`) so the
 * hint nudges them back into the same scoped diagnostic instead of a broader
 * privileged collector. See issue #4366.
 */
export function buildDmesgRerunCommand(opts: DebugOptions = {}): string {
  const parts = ["sudo", "nemoclaw", "debug"];
  if (opts.quick) parts.push("--quick");
  if (opts.output) {
    // Single-quote the path and escape embedded single quotes for shell safety.
    const escaped = opts.output.replace(/'/g, "'\\''");
    parts.push("--output", `'${escaped}'`);
  }
  return parts.join(" ");
}

export function dmesgRestrictedMessage(reason: string, opts: DebugOptions = {}): string {
  const rerun = buildDmesgRerunCommand(opts);
  return [
    `  (kernel messages skipped: dmesg access is restricted for this user; ${reason}.`,
    `   Re-run with \`${rerun}\` to include kernel logs in this report.`,
    "   Note: privileged diagnostics and kernel logs may contain sensitive data; review before sharing.)",
  ].join("\n");
}

function collectDmesg(collectDir: string, opts: DebugOptions = {}): void {
  if (!commandExists("dmesg")) {
    writeCollectedMessage(collectDir, "dmesg", "  (dmesg not found, skipping)");
    return;
  }

  if (isDmesgRestrictedForCurrentUser()) {
    writeCollectedMessage(
      collectDir,
      "dmesg",
      dmesgRestrictedMessage(
        `${DMESG_RESTRICT_PATH}=1 prevents non-root users from reading kernel logs`,
        opts,
      ),
    );
    return;
  }

  const result = spawnSync("sh", ["-c", "dmesg | tail -100"], {
    timeout: TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  });

  const raw = (result.stdout ?? "") + "\n" + (result.stderr ?? "");
  if (isDmesgPermissionDeniedOutput(raw)) {
    writeCollectedMessage(
      collectDir,
      "dmesg",
      dmesgRestrictedMessage("the dmesg command denied access to kernel logs", opts),
    );
    return;
  }

  const redacted = redact(raw);
  writeFileSync(join(collectDir, "dmesg.txt"), redacted);
  console.log(redacted.trimEnd());

  if (result.status !== 0) {
    console.log("  (command exited with non-zero status)");
  }
}

// ---------------------------------------------------------------------------
// Auto-detect sandbox name
// ---------------------------------------------------------------------------

function detectSandboxName(): string {
  // First, check the local registry for the default sandbox. This is
  // the authoritative source — it reflects the user's actual onboard
  // choices and survives gateway restarts. Falling back to "default"
  // without checking the registry was the bug in #1728: debug always
  // targeted a sandbox named "default" even though the user's sandbox
  // was named something else (e.g. "my-assistant").
  try {
    const registry = listSandboxes();
    if (registry.defaultSandbox) return registry.defaultSandbox;
    const names = registry.sandboxes.map((s) => s.name).filter(Boolean);
    if (names.length > 0) return names[0];
  } catch {
    /* registry unreadable — fall through to openshell probe */
  }

  // Fallback: ask the live gateway directly
  if (!commandExists("openshell")) return "default";
  try {
    const output = execFileSync("openshell", ["sandbox", "list"], {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const lines = output.split("\n").filter((l) => l.trim().length > 0);
    for (const line of lines) {
      const first = line.trim().split(/\s+/)[0];
      if (first && first.toLowerCase() !== "name") return first;
    }
  } catch {
    /* ignore */
  }
  return "default";
}

// ---------------------------------------------------------------------------
// Diagnostic sections
// ---------------------------------------------------------------------------

function collectSystem(collectDir: string, quick: boolean): void {
  section("System");
  collect(collectDir, "date", "date", []);
  collect(collectDir, "uname", "uname", ["-a"]);
  collect(collectDir, "uptime", "uptime", []);

  if (isMacOS) {
    collectShell(
      collectDir,
      "memory",
      'echo "Physical: $(($(sysctl -n hw.memsize) / 1048576)) MB"; vm_stat',
    );
  } else {
    collect(collectDir, "free", "free", ["-m"]);
  }

  if (!quick) {
    collect(collectDir, "df", "df", ["-h"]);
  }
}

function collectProcesses(collectDir: string, quick: boolean): void {
  section("Processes");
  if (isMacOS) {
    collectShell(
      collectDir,
      "ps-cpu",
      "ps -eo pid,ppid,comm,%mem,%cpu | sort -k5 -rn | head -30",
    );
  } else {
    collectShell(
      collectDir,
      "ps-cpu",
      "ps -eo pid,ppid,cmd,%mem,%cpu --sort=-%cpu | head -30",
    );
  }

  if (!quick) {
    if (isMacOS) {
      collectShell(
        collectDir,
        "ps-mem",
        "ps -eo pid,ppid,comm,%mem,%cpu | sort -k4 -rn | head -30",
      );
      collectShell(collectDir, "top", "top -l 1 | head -50");
    } else {
      collectShell(
        collectDir,
        "ps-mem",
        "ps -eo pid,ppid,cmd,%mem,%cpu --sort=-%mem | head -30",
      );
      collectShell(collectDir, "top", "top -b -n 1 | head -50");
    }
  }
}

function collectGpu(collectDir: string, quick: boolean): void {
  section("GPU");
  collect(collectDir, "nvidia-smi", "nvidia-smi", []);

  if (!quick) {
    collect(collectDir, "nvidia-smi-dmon", "nvidia-smi", [
      "dmon",
      "-s",
      "pucvmet",
      "-c",
      "10",
    ]);
    collect(collectDir, "nvidia-smi-query", "nvidia-smi", [
      "--query-gpu=name,utilization.gpu,utilization.memory,memory.total,memory.used,temperature.gpu,power.draw",
      "--format=csv",
    ]);
  }
}

function collectDocker(collectDir: string, quick: boolean): void {
  section("Docker");
  collect(collectDir, "docker-ps", "docker", ["ps", "-a"]);
  collect(collectDir, "docker-stats", "docker", ["stats", "--no-stream"]);

  if (!quick) {
    collect(collectDir, "docker-info", "docker", ["info"]);
    collect(collectDir, "docker-df", "docker", ["system", "df"]);
  }

  // NemoClaw-labelled containers
  if (commandExists("docker")) {
    try {
      const output = dockerExecFileSync(
        ["ps", "-a", "--filter", "label=com.nvidia.nemoclaw", "--format", "{{.Names}}"],
        { timeout: TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] },
      );
      const containers = output.split("\n").filter((c) => c.trim().length > 0);
      for (const cid of containers) {
        collect(collectDir, `docker-logs-${cid}`, "docker", ["logs", "--tail", "200", cid]);
        if (!quick) {
          collect(collectDir, `docker-inspect-${cid}`, "docker", ["inspect", cid]);
        }
      }
    } catch {
      /* docker not available or timed out */
    }
  }
}

function collectOpenshell(
  collectDir: string,
  sandboxName: string,
  quick: boolean,
): void {
  section("OpenShell");
  collect(collectDir, "openshell-status", "openshell", ["status"]);
  collect(collectDir, "openshell-sandbox-list", "openshell", ["sandbox", "list"]);
  collect(collectDir, "openshell-sandbox-get", "openshell", ["sandbox", "get", sandboxName]);
  collect(collectDir, "openshell-logs", "openshell", ["logs", sandboxName]);

  if (!quick) {
    collect(collectDir, "openshell-gateway-info", "openshell", ["gateway", "info"]);
  }
}

function collectSandboxInternals(
  collectDir: string,
  sandboxName: string,
  quick: boolean,
): void {
  if (!commandExists("openshell")) return;

  // Check if sandbox exists. OpenShell ssh-config may succeed for unknown
  // names, so verify the live sandbox first.
  try {
    execFileSync("openshell", ["sandbox", "get", sandboxName], {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return;
  }

  section("Sandbox Internals");

  // Generate temporary SSH config in a private directory.
  const sshConfigDir = mkdtempSync(join(tmpdir(), "nemoclaw-ssh-"));
  const sshConfigPath = join(sshConfigDir, "config");
  try {
    const sshResult = spawnSync("openshell", ["sandbox", "ssh-config", sandboxName], {
      timeout: TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
    });
    if (sshResult.status !== 0) {
      warn(`Could not generate SSH config for sandbox '${sandboxName}', skipping internals`);
      return;
    }
    writeFileSync(sshConfigPath, sshResult.stdout ?? "");

    const sshHost = `openshell-${sandboxName}`;
    const sshBase = [
      "-F",
      sshConfigPath,
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "ConnectTimeout=10",
      sshHost,
    ];

    // Use collect() with array args — no shell interpolation of sandboxName
    collect(collectDir, "sandbox-ps", "ssh", [...sshBase, "ps", "-ef"]);
    collect(collectDir, "sandbox-free", "ssh", [...sshBase, "free", "-m"]);
    if (!quick) {
      collect(collectDir, "sandbox-top", "ssh", [
        ...sshBase,
        "top",
        "-b",
        "-n",
        "1",
      ]);
      collect(collectDir, "sandbox-gateway-log", "ssh", [
        ...sshBase,
        "tail",
        "-200",
        "/tmp/gateway.log",
      ]);
    }
  } finally {
    rmSync(sshConfigDir, { force: true, recursive: true });
  }
}

function collectNetwork(collectDir: string): void {
  section("Network");
  if (isMacOS) {
    collectShell(collectDir, "listening", "netstat -anp tcp | grep LISTEN");
    collect(collectDir, "ifconfig", "ifconfig", []);
    collect(collectDir, "routes", "netstat", ["-rn"]);
    collect(collectDir, "dns-config", "scutil", ["--dns"]);
  } else {
    collect(collectDir, "ss", "ss", ["-ltnp"]);
    collect(collectDir, "ip-addr", "ip", ["addr"]);
    collect(collectDir, "ip-route", "ip", ["route"]);
    collectShell(collectDir, "resolv-conf", "cat /etc/resolv.conf");
  }
  collect(collectDir, "nslookup", "nslookup", ["integrate.api.nvidia.com"]);
  collectShell(
    collectDir,
    "curl-models",
    'code=$(curl -s -o /dev/null -w "%{http_code}" https://integrate.api.nvidia.com/v1/models); echo "HTTP $code"; if [ "$code" -ge 200 ] && [ "$code" -lt 500 ]; then echo "NIM API reachable"; else echo "NIM API unreachable"; exit 1; fi',
  );
  collectShell(collectDir, "lsof-net", "lsof -i -P -n 2>/dev/null | head -50");
  collect(collectDir, "lsof-18789", "lsof", ["-i", `:${DASHBOARD_PORT}`]);
}

function collectOnboardSession(collectDir: string, repoDir: string): void {
  section("Onboard Session");
  const helperPath = join(repoDir, "dist", "lib", "state", "onboard-session.js");
  if (!existsSync(helperPath) || !commandExists("node")) {
    console.log("  (onboard session helper not available, skipping)");
    return;
  }

  const script = [
    "const helper = require(process.argv[1]);",
    "const summary = helper.summarizeForDebug();",
    "if (!summary) { process.stdout.write('No onboard session state found.\\n'); process.exit(0); }",
    "process.stdout.write(JSON.stringify(summary, null, 2) + '\\n');",
  ].join(" ");

  collect(collectDir, "onboard-session-summary", "node", ["-e", script, helperPath]);
}

function collectKernel(collectDir: string): void {
  section("Kernel / IO");
  if (isMacOS) {
    collect(collectDir, "vmstat", "vm_stat", []);
    collect(collectDir, "iostat", "iostat", ["-c", "5", "-w", "1"]);
  } else {
    collect(collectDir, "vmstat", "vmstat", ["1", "5"]);
    collect(collectDir, "iostat", "iostat", ["-xz", "1", "5"]);
  }
}

function collectKernelMessages(collectDir: string, opts: DebugOptions = {}): void {
  section("Kernel Messages");
  if (isMacOS) {
    collectShell(
      collectDir,
      "system-log",
      'log show --last 5m --predicate "eventType == logEvent" --style compact 2>/dev/null | tail -100',
    );
  } else {
    collectDmesg(collectDir, opts);
  }
}

// ---------------------------------------------------------------------------
// Tarball
// ---------------------------------------------------------------------------

export function createTarball(collectDir: string, output: string): boolean {
  return createDiagnosticsTarball(collectDir, output, { info, warn, error });
}

/**
 * Return the final user-facing completion lines for the debug command.
 * When a tarball was already written, the tarball creation step has already
 * printed the attachment guidance, so we do not repeat it here.
 */
export function getDebugCompletionMessages(output?: string): string[] {
  if (output) {
    return [];
  }

  return [
    "Done. If filing a bug, run with --output and attach the tarball to your issue:",
    "  nemoclaw debug --output /tmp/nemoclaw-debug.tar.gz",
  ];
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Collect local and sandbox diagnostics for a NemoClaw environment and
 * optionally bundle the results into a tarball for issue reporting.
 */
export function runDebug(opts: DebugOptions = {}): void {
  const quick = opts.quick ?? false;
  const output = opts.output ?? "";
  // Compiled location: dist/lib/diagnostics/debug.js → repo root is 3 levels up
  const repoDir = join(__dirname, "..", "..", "..");

  // Resolve sandbox name. The CLI wrapper (runDebugCommandWithOptions) is the
  // sole supported caller; it already trims, validates, and applies the
  // documented precedence (--sandbox > NEMOCLAW_SANDBOX_NAME > NEMOCLAW_SANDBOX
  // > SANDBOX_NAME) before calling here. Reading env again would let
  // whitespace-only values bypass validation, so only trim the option.
  let sandboxName = opts.sandboxName?.trim() ?? "";
  if (!sandboxName) {
    sandboxName = detectSandboxName();
  }

  // Create temp collection directory
  const collectDir = mkdtempSync(join(tmpdir(), "nemoclaw-debug-"));

  try {
    info(`Collecting diagnostics for sandbox '${sandboxName}'...`);
    info(`Quick mode: ${String(quick)}`);
    if (output) info(`Tarball output: ${output}`);
    console.log("");

    collectSystem(collectDir, quick);
    collectProcesses(collectDir, quick);
    collectGpu(collectDir, quick);
    collectDocker(collectDir, quick);
    collectOpenshell(collectDir, sandboxName, quick);
    collectOnboardSession(collectDir, repoDir);
    collectSandboxInternals(collectDir, sandboxName, quick);

    if (!quick) {
      collectNetwork(collectDir);
      collectKernel(collectDir);
    }

    collectKernelMessages(collectDir, opts);

    let tarballOk = true;
    if (output) {
      tarballOk = createTarball(collectDir, output);
    }

    if (tarballOk) {
      console.log("");
      for (const message of getDebugCompletionMessages(output)) {
        info(message);
      }
    }
  } finally {
    rmSync(collectDir, { recursive: true, force: true });
  }
}
