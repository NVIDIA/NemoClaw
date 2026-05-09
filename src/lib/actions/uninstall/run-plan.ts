// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { dockerSpawnSync } from "../../adapters/docker/exec";
import { getAgentBranding, type AgentBranding } from "../../cli/branding";
import { sleepMs } from "../../core/wait";
import { defaultUninstallPaths, NEMOCLAW_OLLAMA_MODELS, NEMOCLAW_PROVIDERS, type UninstallPaths } from "../../domain/uninstall/paths";
import { buildUninstallPlan, type UninstallPlan } from "../../domain/uninstall/plan";
import { classifyShimPath, type FileSystemDeps } from "./plan";

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface UninstallRunOptions {
  assumeYes: boolean;
  deleteModels: boolean;
  gatewayName?: string;
  keepOpenShell: boolean;
}

export interface UninstallRunDeps {
  commandExists?: (command: string) => boolean;
  env?: NodeJS.ProcessEnv;
  error?: (message: string) => void;
  existsSync?: (target: string) => boolean;
  fs?: FileSystemDeps;
  isTty?: boolean;
  kill?: (pid: number, signal?: NodeJS.Signals | number) => boolean;
  log?: (message: string) => void;
  readLine?: () => string | null;
  rmSync?: typeof fs.rmSync;
  run?: (command: string, args: string[], options?: SpawnSyncOptions) => RunResult;
  runDocker?: (args: string[], options?: SpawnSyncOptions) => RunResult;
}

export interface UninstallRunOutcome {
  exitCode: number;
  plan: UninstallPlan;
}

function toRunResult(result: SpawnSyncReturns<string | Buffer>): RunResult {
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : String(result.stdout ?? ""),
    stderr: typeof result.stderr === "string" ? result.stderr : String(result.stderr ?? ""),
  };
}

function defaultRun(command: string, args: string[], options: SpawnSyncOptions = {}): RunResult {
  return toRunResult(spawnSync(command, args, { encoding: "utf-8", ...options }));
}

function defaultRunDocker(args: string[], options: SpawnSyncOptions = {}): RunResult {
  return toRunResult(dockerSpawnSync(args, { encoding: "utf-8", ...options }));
}

function defaultCommandExists(command: string, env: NodeJS.ProcessEnv): boolean {
  return defaultRun("sh", ["-c", `command -v ${JSON.stringify(command)} >/dev/null 2>&1`], { env }).status === 0;
}

function defaultReadLine(env: NodeJS.ProcessEnv): string | null {
  const result = defaultRun("sh", ["-c", "IFS= read -r reply; printf '%s' \"$reply\""], {
    encoding: "utf-8",
    env,
    stdio: ["inherit", "pipe", "inherit"],
  });
  return result.status === 0 ? result.stdout : null;
}

function splitNonEmptyLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function globToRegExp(pattern: string): RegExp {
  return new RegExp(
    `^${path
      .basename(pattern)
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  );
}

function removeGlob(pattern: string, deps: Required<Pick<UninstallRunDeps, "existsSync" | "log" | "rmSync">>): void {
  const dir = path.dirname(pattern);
  const matcher = globToRegExp(pattern);
  if (!deps.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    if (!matcher.test(entry)) continue;
    const target = path.join(dir, entry);
    deps.rmSync(target, { force: true, recursive: true });
    deps.log(`Removed ${target}`);
  }
}

function removePath(target: string, deps: Required<Pick<UninstallRunDeps, "existsSync" | "log" | "rmSync">>): void {
  if (!deps.existsSync(target)) return;
  deps.rmSync(target, { force: true, recursive: true });
  deps.log(`Removed ${target}`);
}

function removeFileWithOptionalSudo(target: string, deps: UninstallRuntime): void {
  if (!deps.existsSync(target)) return;
  const parent = path.dirname(target);
  try {
    fs.accessSync(parent, fs.constants.W_OK);
    deps.rmSync(target, { force: true });
    deps.log(`Removed ${target}`);
  } catch {
    if (deps.env.NEMOCLAW_NON_INTERACTIVE === "1" || !deps.isTty) {
      deps.warn(`Skipping privileged removal of ${target} in non-interactive mode.`);
      return;
    }
    const result = deps.run("sudo", ["rm", "-f", target], { env: deps.env });
    if (result.status === 0) deps.log(`Removed ${target}`);
    else deps.warn(`Failed to remove ${target}`);
  }
}

interface UninstallRuntime {
  commandExists: (command: string) => boolean;
  env: NodeJS.ProcessEnv;
  error: (message: string) => void;
  existsSync: (target: string) => boolean;
  isTty: boolean;
  kill: (pid: number, signal?: NodeJS.Signals | number) => boolean;
  log: (message: string) => void;
  readLine: () => string | null;
  rmSync: typeof fs.rmSync;
  run: (command: string, args: string[], options?: SpawnSyncOptions) => RunResult;
  runDocker: (args: string[], options?: SpawnSyncOptions) => RunResult;
  warn: (message: string) => void;
}

function buildRuntime(deps: UninstallRunDeps): UninstallRuntime {
  const env = { ...process.env, ...(deps.env ?? {}) };
  return {
    commandExists: deps.commandExists ?? ((command) => defaultCommandExists(command, env)),
    env,
    error: deps.error ?? ((message) => console.error(message)),
    existsSync: deps.existsSync ?? ((target) => fs.existsSync(target)),
    isTty: deps.isTty ?? !!process.stdin.isTTY,
    kill:
      deps.kill ??
      ((pid, signal) => {
        try {
          process.kill(pid, signal);
          return true;
        } catch {
          return false;
        }
      }),
    log: deps.log ?? ((message) => console.log(message)),
    readLine: deps.readLine ?? (() => defaultReadLine(env)),
    rmSync: deps.rmSync ?? fs.rmSync,
    run: deps.run ?? defaultRun,
    runDocker: deps.runDocker ?? defaultRunDocker,
    warn: deps.error ?? ((message) => console.warn(message)),
  };
}

function runtimeBranding(runtime: UninstallRuntime): AgentBranding {
  return getAgentBranding(runtime.env.NEMOCLAW_AGENT);
}

function planStepDisplayName(stepName: string, branding: AgentBranding): string {
  return stepName === "NemoClaw CLI" ? `${branding.display} CLI` : stepName;
}

function printBanner(runtime: UninstallRuntime): void {
  const branding = runtimeBranding(runtime);
  runtime.log(`${branding.display} Uninstaller`);
  runtime.log(`This will remove all ${branding.display} resources.`);
}

function printBye(runtime: UninstallRuntime): void {
  const branding = runtimeBranding(runtime);
  runtime.log(branding.display);
  runtime.log(branding.uninstallGoodbye);
}

function confirm(options: UninstallRunOptions, runtime: UninstallRuntime): boolean {
  const branding = runtimeBranding(runtime);
  if (options.assumeYes) return true;
  runtime.log("What will be removed:");
  runtime.log(`  · All OpenShell sandboxes, gateway, and ${branding.display} providers`);
  runtime.log("  · Related Docker containers, images, and volumes");
  runtime.log("  · ~/.nemoclaw  ~/.config/openshell  ~/.config/nemoclaw");
  runtime.log(`  · Global ${branding.display} CLI (npm package: nemoclaw)`);
  runtime.log(options.deleteModels ? `  · Ollama models: ${NEMOCLAW_OLLAMA_MODELS.join(" ")}` : "  · Ollama models: kept");
  runtime.log("Proceed? [y/N]");
  const reply = runtime.readLine();
  if (reply && /^(y|yes)$/i.test(reply.trim())) return true;
  runtime.log("Aborted.");
  return false;
}

function runOptional(runtime: UninstallRuntime, description: string, command: string, args: string[]): void {
  const result = runtime.run(command, args, { env: runtime.env, stdio: "ignore" });
  if (result.status === 0) runtime.log(description);
  else runtime.warn(`${description} skipped`);
}

function stopHelperServices(paths: UninstallPaths, runtime: UninstallRuntime): void {
  const startServices = path.join(paths.repoRoot, "scripts", "start-services.sh");
  if (runtime.existsSync(startServices)) runOptional(runtime, `Stopped ${runtimeBranding(runtime).display} helper services`, startServices, ["--stop"]);
}

function stopMatchingPids(pattern: string, runtime: UninstallRuntime, label: string): void {
  if (!runtime.commandExists("pgrep")) {
    runtime.warn(`pgrep not found; skipping ${label}.`);
    return;
  }
  const result = runtime.run("pgrep", ["-f", pattern], { env: runtime.env });
  const pids = splitNonEmptyLines(result.stdout).map(Number).filter(Number.isFinite);
  if (pids.length === 0) {
    runtime.log(`No ${label} found`);
    return;
  }
  for (const pid of pids) {
    if (runtime.kill(pid) || runtime.kill(pid, "SIGKILL")) runtime.log(`Stopped ${label} ${pid}`);
    else runtime.warn(`Failed to stop ${label} ${pid}`);
  }
}

// Identifier we look for in `/proc/<pid>/cmdline` (via `ps -p <pid> -o args=`)
// to confirm a candidate PID is the Ollama auth proxy and not another node
// process that happens to be on the same port. Mirrors the
// `isOllamaProxyProcess` check in `src/lib/onboard-ollama-proxy.ts`.
const OLLAMA_AUTH_PROXY_CMDLINE_MARK = "ollama-auth-proxy.js";

// Resolve the proxy port from runtime.env (rather than `process.env` at
// module-load time) so a user who onboarded with NEMOCLAW_OLLAMA_PROXY_PORT
// set to a custom value sees uninstall scan that same port. Mirrors the
// validation in `src/lib/core/ports.ts::parsePort`; falls back silently to
// the default (11435) on malformed input — uninstall is best-effort.
const DEFAULT_OLLAMA_PROXY_PORT = 11435;

function resolveOllamaProxyPort(runtime: UninstallRuntime): number {
  const raw = runtime.env.NEMOCLAW_OLLAMA_PROXY_PORT;
  if (raw === undefined || raw === "") return DEFAULT_OLLAMA_PROXY_PORT;
  const trimmed = String(raw).trim();
  if (!/^\d+$/.test(trimmed)) return DEFAULT_OLLAMA_PROXY_PORT;
  const parsed = Number(trimmed);
  if (parsed < 1024 || parsed > 65535) return DEFAULT_OLLAMA_PROXY_PORT;
  return parsed;
}

function isOllamaAuthProxyPid(pid: number, runtime: UninstallRuntime): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const result = runtime.run("ps", ["-p", String(pid), "-o", "args="], { env: runtime.env });
  return result.status === 0 && result.stdout.includes(OLLAMA_AUTH_PROXY_CMDLINE_MARK);
}

// `ps -p <pid>` is preferred over `kill(pid, 0)` for existence probing here:
// `runtime.kill()` collapses every `process.kill` error to `false`, so a foreign
// PID throwing EPERM (process exists but caller can't signal it) would look
// identical to ESRCH (gone) and we'd falsely log it as Stopped. `ps` reports
// existence regardless of signalling permission.
function pidExists(pid: number, runtime: UninstallRuntime): boolean {
  return runtime.run("ps", ["-p", String(pid), "-o", "pid="], { env: runtime.env }).status === 0;
}

function waitForPidExit(pid: number, runtime: UninstallRuntime, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidExists(pid, runtime)) return true;
    sleepMs(50);
  }
  return !pidExists(pid, runtime);
}

function pidOwnedByCurrentUser(pid: number, runtime: UninstallRuntime): boolean {
  const expected = runtime.env.SUDO_USER || runtime.env.LOGNAME || os.userInfo().username;
  if (!expected) return true;
  const result = runtime.run("ps", ["-p", String(pid), "-o", "user="], { env: runtime.env });
  return result.status === 0 && result.stdout.trim() === expected;
}

function tryStopOllamaProxyPid(pid: number, runtime: UninstallRuntime): boolean {
  // `runtime.kill()` only confirms the signal was sent; the proxy may ignore
  // SIGTERM, take time to clean up, or linger as a zombie. Verify the PID is
  // actually gone before claiming success — otherwise the next install fails
  // with `Ollama auth proxy failed to start on :11435`.
  runtime.kill(pid);
  if (waitForPidExit(pid, runtime, 1000)) {
    runtime.log(`Stopped Ollama auth proxy ${pid}`);
    return true;
  }
  runtime.kill(pid, "SIGKILL");
  if (waitForPidExit(pid, runtime, 1000)) {
    runtime.log(`Stopped Ollama auth proxy ${pid}`);
    return true;
  }
  runtime.warn(`Failed to stop Ollama auth proxy ${pid}`);
  return false;
}

function stopOllamaAuthProxy(paths: UninstallPaths, runtime: UninstallRuntime): void {
  // The auth proxy is a detached node child started by the Local Ollama
  // onboard path that listens on `NEMOCLAW_OLLAMA_PROXY_PORT` (default
  // 11435). Without this cleanup,
  // uninstall + reinstall fails with `Ollama auth proxy failed to start on
  // :11435` — the on-disk PID file is removed by the "State and binaries"
  // step but the process keeps running. The two-prong check (persisted PID
  // first, then port-bound listeners) mirrors `killStaleProxy()` in
  // `src/lib/onboard-ollama-proxy.ts` and verifies cmdline on every PID, so
  // an unrelated process on the same port (custom proxy, test setup) is
  // never killed. See issue #2759.
  const stopped = new Set<number>();

  // 1. Try the persisted PID file. The proxy stays bound across NemoClaw
  //    sessions; the PID file is the most reliable signal. The path mirrors
  //    `PROXY_PID_PATH` in `src/lib/onboard-ollama-proxy.ts` (`~/.nemoclaw`).
  const pidFile = path.join(paths.nemoclawStateDir, "ollama-auth-proxy.pid");
  if (runtime.existsSync(pidFile)) {
    try {
      const raw = fs.readFileSync(pidFile, "utf-8").trim();
      const pid = Number.parseInt(raw, 10);
      if (Number.isFinite(pid) && pid > 0 && isOllamaAuthProxyPid(pid, runtime)) {
        if (tryStopOllamaProxyPid(pid, runtime)) stopped.add(pid);
      }
    } catch {
      /* ignore — the State step deletes the file shortly anyway */
    }
  }

  // 2. Fall back to the configured proxy port for orphans whose PID file is
  //    gone (e.g. a previous uninstall already wiped state but the process
  //    survived). Filter via cmdline so we never kill unrelated listeners.
  if (!runtime.commandExists("lsof")) {
    if (stopped.size === 0) {
      runtime.warn("lsof not found; skipping orphan Ollama auth proxy scan.");
    }
    return;
  }
  const proxyPort = resolveOllamaProxyPort(runtime);
  const lsof = runtime.run("lsof", ["-ti", `:${proxyPort}`], { env: runtime.env });
  const pids = splitNonEmptyLines(lsof.stdout).map(Number).filter(Number.isFinite);
  for (const pid of pids) {
    if (stopped.has(pid)) continue;
    // Skip foreign-owned PIDs even if the cmdline matches: signalling them
    // would either no-op under EPERM or escalate via sudo, neither of which
    // is appropriate during a per-user uninstall.
    if (!pidOwnedByCurrentUser(pid, runtime)) continue;
    if (!isOllamaAuthProxyPid(pid, runtime)) continue;
    if (tryStopOllamaProxyPid(pid, runtime)) stopped.add(pid);
  }

  if (stopped.size === 0) runtime.log("No Ollama auth proxy processes found");
}

function stopOrphanedOpenShell(runtime: UninstallRuntime): void {
  if (!runtime.commandExists("pgrep")) {
    runtime.warn("pgrep not found; skipping orphaned openshell process cleanup.");
    return;
  }
  const user = runtime.env.SUDO_USER || runtime.env.LOGNAME || os.userInfo().username;
  const args = user ? ["-u", user, "-f", "openshell (sandbox create|ssh-proxy)"] : ["-f", "openshell (sandbox create|ssh-proxy)"];
  const result = runtime.run("pgrep", args, { env: runtime.env });
  const pids = splitNonEmptyLines(result.stdout).map(Number).filter(Number.isFinite);
  if (pids.length === 0) {
    runtime.log("No orphaned openshell processes found");
    return;
  }
  for (const pid of pids) {
    if (runtime.kill(pid) || runtime.kill(pid, "SIGKILL")) runtime.log(`Stopped orphaned openshell process ${pid}`);
    else runtime.warn(`Failed to stop orphaned openshell process ${pid}`);
  }
}

function removeOpenShellResources(options: UninstallRunOptions, runtime: UninstallRuntime): void {
  if (!runtime.commandExists("openshell")) {
    runtime.warn("openshell not found; skipping gateway/provider/sandbox cleanup.");
    return;
  }
  runOptional(runtime, "Deleted all OpenShell sandboxes", "openshell", ["sandbox", "delete", "--all"]);
  for (const provider of NEMOCLAW_PROVIDERS) {
    runOptional(runtime, `Deleted provider '${provider}'`, "openshell", ["provider", "delete", provider]);
  }
  runOptional(runtime, `Destroyed gateway '${options.gatewayName || "nemoclaw"}'`, "openshell", [
    "gateway",
    "destroy",
    "-g",
    options.gatewayName || "nemoclaw",
  ]);
}

function removeAliases(paths: UninstallPaths, runtime: UninstallRuntime): void {
  for (const profile of paths.shellProfilePaths) {
    if (!runtime.existsSync(profile)) continue;
    try {
      const original = fs.readFileSync(profile, "utf-8");
      const updated = original
        .replace(/^# NemoClaw PATH setup\n[\s\S]*?^# end NemoClaw PATH setup\n?/gm, "")
        .replace(/^# NemoClaw CLI alias\n.*\n?/gm, "");
      if (updated !== original) {
        fs.writeFileSync(profile, updated);
        runtime.log(`Removed ${runtimeBranding(runtime).display} PATH entries from ${profile}`);
      }
    } catch {
      runtime.warn(`Failed to update ${profile}`);
    }
  }
}

function removeNvmLeftovers(paths: UninstallPaths, runtime: UninstallRuntime): void {
  const nodeVersionsDir = path.join(paths.nvmDir, "versions", "node");
  if (!runtime.existsSync(nodeVersionsDir)) return;
  const stack = [nodeVersionsDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (target.endsWith(path.join("lib", "node_modules", "nemoclaw"))) {
          runtime.rmSync(target, { force: true, recursive: true });
          runtime.log(`Removed leftover nemoclaw module at ${target}`);
        } else {
          stack.push(target);
        }
      } else if (entry.isFile() && target.endsWith(path.join("bin", "nemoclaw"))) {
        runtime.rmSync(target, { force: true });
        runtime.log(`Removed leftover nemoclaw binary at ${target}`);
      }
    }
  }
}

function removeNemoclawCli(paths: UninstallPaths, runtime: UninstallRuntime): void {
  const branding = runtimeBranding(runtime);
  if (runtime.commandExists("npm")) {
    runtime.run("npm", ["unlink", "-g", "nemoclaw"], { env: runtime.env, stdio: "ignore" });
    const result = runtime.run("npm", ["uninstall", "-g", "--loglevel=error", "nemoclaw"], {
      env: runtime.env,
      stdio: "ignore",
    });
    if (result.status === 0) runtime.log(`Removed global ${branding.display} CLI package`);
    else runtime.warn(`Global ${branding.display} CLI package not found or already removed`);
  } else {
    runtime.warn(`npm not found; skipping ${branding.display} CLI uninstall.`);
  }

  const shim = classifyShimPath(paths.nemoclawShimPath);
  if (shim.remove) removePath(paths.nemoclawShimPath, runtime);
  else if (shim.kind === "preserve-foreign-file") {
    runtime.warn(`Leaving ${paths.nemoclawShimPath} in place because it is not an installer-managed shim.`);
  }
  removeNvmLeftovers(paths, runtime);
  removeAliases(paths, runtime);
}

function dockerIsAvailable(runtime: UninstallRuntime): boolean {
  if (!runtime.commandExists("docker")) {
    runtime.warn("docker not found; skipping Docker cleanup.");
    return false;
  }
  if (runtime.runDocker(["info"], { env: runtime.env, stdio: "ignore" }).status !== 0) {
    runtime.warn("docker is not running; skipping Docker cleanup.");
    return false;
  }
  return true;
}

function removeDockerContainers(runtime: UninstallRuntime): void {
  const result = runtime.runDocker(["ps", "-a", "--format", "{{.ID}} {{.Image}} {{.Names}}"], { env: runtime.env });
  const ids = splitNonEmptyLines(result.stdout)
    .filter((line) => /openshell-cluster|openshell|openclaw|nemoclaw/i.test(line))
    .map((line) => line.split(/\s+/)[0]);
  if (ids.length === 0) {
    runtime.log(`No ${runtimeBranding(runtime).display}/OpenShell Docker containers found`);
    return;
  }
  for (const id of [...new Set(ids)]) {
    if (runtime.runDocker(["rm", "-f", id], { env: runtime.env, stdio: "ignore" }).status === 0) runtime.log(`Removed Docker container ${id}`);
    else runtime.warn(`Failed to remove Docker container ${id}`);
  }
}

function removeDockerImages(runtime: UninstallRuntime): void {
  const result = runtime.runDocker(["images", "--format", "{{.ID}} {{.Repository}}:{{.Tag}}"], { env: runtime.env });
  const ids = splitNonEmptyLines(result.stdout)
    .filter((line) => /openshell|openclaw|nemoclaw/i.test(line))
    .map((line) => line.split(/\s+/)[0]);
  if (ids.length === 0) {
    runtime.log(`No ${runtimeBranding(runtime).display}/OpenShell Docker images found`);
    return;
  }
  for (const id of [...new Set(ids)]) {
    if (runtime.runDocker(["rmi", "-f", id], { env: runtime.env, stdio: "ignore" }).status === 0) runtime.log(`Removed Docker image ${id}`);
    else runtime.warn(`Failed to remove Docker image ${id}`);
  }
}

function removeDockerVolume(name: string, runtime: UninstallRuntime): void {
  if (runtime.runDocker(["volume", "inspect", name], { env: runtime.env, stdio: "ignore" }).status !== 0) return;
  if (runtime.runDocker(["volume", "rm", "-f", name], { env: runtime.env, stdio: "ignore" }).status === 0) runtime.log(`Removed Docker volume ${name}`);
  else runtime.warn(`Failed to remove Docker volume ${name}`);
}

function removeOllamaModels(options: UninstallRunOptions, runtime: UninstallRuntime): void {
  if (!options.deleteModels) {
    runtime.log("Keeping Ollama models as requested.");
    return;
  }
  if (!runtime.commandExists("ollama")) {
    runtime.warn("ollama not found; skipping model cleanup.");
    return;
  }
  for (const model of NEMOCLAW_OLLAMA_MODELS) {
    if (runtime.run("ollama", ["rm", model], { env: runtime.env, stdio: "ignore" }).status === 0) runtime.log(`Removed Ollama model '${model}'`);
    else runtime.warn(`Ollama model '${model}' not found or already removed`);
  }
}

function removeManagedSwap(paths: UninstallPaths, runtime: UninstallRuntime): void {
  if (!runtime.existsSync("/swapfile")) {
    runtime.log("No /swapfile found; skipping swap cleanup.");
    return;
  }
  if (!runtime.existsSync(paths.managedSwapMarkerPath)) {
    runtime.warn(`No ${runtimeBranding(runtime).display}-managed swap marker found, skipping swap cleanup.`);
    return;
  }
  if (runtime.env.NEMOCLAW_NON_INTERACTIVE === "1" || !runtime.isTty) {
    runtime.warn("Skipping swap cleanup in non-interactive mode (requires sudo).");
    return;
  }
  const swapoff = runtime.run("sudo", ["swapoff", "/swapfile"], { env: runtime.env, stdio: "ignore" });
  if (swapoff.status !== 0) {
    runtime.warn("Failed to disable /swapfile; skipping swap cleanup.");
    return;
  }
  const rm = runtime.run("sudo", ["rm", "-f", "/swapfile"], { env: runtime.env, stdio: "ignore" });
  if (rm.status === 0) runtime.log("Swap file removed");
  else runtime.warn("Failed to remove /swapfile.");
}

function executePlan(plan: UninstallPlan, paths: UninstallPaths, options: UninstallRunOptions, runtime: UninstallRuntime): void {
  const branding = runtimeBranding(runtime);
  for (const [index, step] of plan.steps.entries()) {
    runtime.log(`[${index + 1}/${plan.steps.length}] ${planStepDisplayName(step.name, branding)}`);
    if (step.name === "Stopping services") {
      stopHelperServices(paths, runtime);
      removeGlob(paths.helperServiceGlob, runtime);
      stopMatchingPids(`openshell.*forward.*${runtime.env.NEMOCLAW_DASHBOARD_PORT || "18789"}`, runtime, "local OpenShell forward processes");
      stopOrphanedOpenShell(runtime);
      stopOllamaAuthProxy(paths, runtime);
    } else if (step.name === "OpenShell resources") {
      removeOpenShellResources(options, runtime);
    } else if (step.name === "NemoClaw CLI") {
      removeNemoclawCli(paths, runtime);
    } else if (step.name === "Docker resources") {
      if (dockerIsAvailable(runtime)) {
        removeDockerContainers(runtime);
        removeDockerImages(runtime);
        for (const action of step.actions) if (action.kind === "delete-docker-volume") removeDockerVolume(action.name, runtime);
      }
    } else if (step.name === "Ollama models") {
      removeOllamaModels(options, runtime);
    } else if (step.name === "State and binaries") {
      removeManagedSwap(paths, runtime);
      for (const pattern of paths.runtimeTempGlobs) removeGlob(pattern, runtime);
      if (options.keepOpenShell) runtime.log("Keeping openshell binary as requested.");
      else for (const target of paths.openshellInstallPaths) removeFileWithOptionalSudo(target, runtime);
      removePath(paths.nemoclawStateDir, runtime);
      removePath(paths.openshellConfigDir, runtime);
      removePath(paths.nemoclawConfigDir, runtime);
    }
  }
}

export function buildRunPlan(options: UninstallRunOptions, deps: UninstallRunDeps = {}): { paths: UninstallPaths; plan: UninstallPlan } {
  const env = { ...process.env, ...(deps.env ?? {}) };
  const home = env.HOME || os.tmpdir();
  const paths = defaultUninstallPaths({
    home,
    repoRoot: path.resolve(__dirname, "..", "..", ".."),
    tmpDir: env.TMPDIR,
    xdgBinHome: env.XDG_BIN_HOME,
  });
  const plan = buildUninstallPlan(paths, {
    deleteModels: options.deleteModels,
    gatewayName: options.gatewayName,
    keepOpenShell: options.keepOpenShell,
    shim: classifyShimPath(paths.nemoclawShimPath, deps.fs),
  });
  return { paths, plan };
}

export function runUninstallPlan(options: UninstallRunOptions, deps: UninstallRunDeps = {}): UninstallRunOutcome {
  const runtime = buildRuntime(deps);
  const { paths, plan } = buildRunPlan(options, { ...deps, env: runtime.env });
  printBanner(runtime);
  if (!confirm(options, runtime)) return { exitCode: 0, plan };
  executePlan(plan, paths, options, runtime);
  printBye(runtime);
  return { exitCode: 0, plan };
}
