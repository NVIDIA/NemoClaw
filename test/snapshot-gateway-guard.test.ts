// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Regression tests for issue #2673: snapshot restore/create must reject when
// the openshell-cluster gateway container is stopped, even when
// `openshell sandbox list` lies and returns exit 0 with stale data.

import { type ChildProcess, execSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { execTimeout } from "./helpers/timeouts";

const CLI = path.join(import.meta.dirname, "..", "bin", "nemoclaw.js");
const listenerProcesses: ChildProcess[] = [];
let nextFixturePort = 46000 + (process.pid % 10000);

afterEach(() => {
  for (const child of listenerProcesses.splice(0)) {
    child.kill("SIGKILL");
  }
});

type CliRunResult = { code: number; out: string };

function runCli(args: string, env: Record<string, string | undefined> = {}): CliRunResult {
  try {
    const out = execSync(`node "${CLI}" ${args}`, {
      encoding: "utf-8",
      timeout: execTimeout(),
      env: {
        ...process.env,
        NEMOCLAW_HEALTH_POLL_COUNT: "1",
        NEMOCLAW_HEALTH_POLL_INTERVAL: "0",
        ...env,
      },
    });
    return { code: 0, out };
  } catch (err: unknown) {
    if (typeof err === "object" && err !== null && "status" in err) {
      const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
      const out = [e.stdout, e.stderr]
        .map((b) => (typeof b === "string" ? b : b ? b.toString("utf-8") : ""))
        .join("");
      return { code: typeof e.status === "number" ? e.status : 1, out };
    }
    return { code: 1, out: String(err) };
  }
}

/**
 * Creates a temp HOME with:
 *  - registry containing sandbox "alpha"
 *  - fake openshell: `sandbox list` exits 0 with "alpha" in output (stale cache)
 *  - fake docker: `inspect` exits 0 but prints "false" (container stopped)
 *
 * This setup reproduces the exact failure mode from #2673: openshell returns
 * exit 0 with stale data, so the old isLive.status guard never fires.
 */
function writeExecutable(filePath: string, lines: string[]): void {
  fs.writeFileSync(filePath, ["#!/bin/sh", ...lines].join("\n"), { mode: 0o755 });
}

function writeSandboxRegistry(
  home: string,
  sandboxName: string,
  entry: Record<string, unknown> = {},
): void {
  const registryDir = path.join(home, ".nemoclaw");
  fs.mkdirSync(registryDir, { recursive: true });
  fs.writeFileSync(
    path.join(registryDir, "sandboxes.json"),
    JSON.stringify({
      sandboxes: {
        [sandboxName]: {
          name: sandboxName,
          model: "test-model",
          provider: "nvidia-prod",
          gpuEnabled: false,
          policies: [],
          ...entry,
        },
      },
      defaultSandbox: sandboxName,
    }),
    { mode: 0o600 },
  );
}

function startReachableForward(port: number): void {
  const listener =
    'const net=require("node:net");' +
    "const server=net.createServer(()=>{});" +
    `server.listen(${String(port)},"127.0.0.1");`;
  const child = spawn(process.execPath, ["-e", listener], { stdio: "ignore" });
  listenerProcesses.push(child);
  expect(child.pid, `test forward listener failed to spawn for ${String(port)}`).toBeDefined();

  const probe =
    "const net=require('node:net');" +
    `const s=net.createConnection({host:'127.0.0.1',port:${String(port)}});` +
    "s.setTimeout(100);" +
    "s.on('connect',()=>{s.destroy();process.exit(0)});" +
    "s.on('error',()=>process.exit(1));" +
    "s.on('timeout',()=>{s.destroy();process.exit(1)});";
  const deadline = Date.now() + 2000;
  let ready = false;
  while (Date.now() < deadline && !ready) {
    ready = spawnSync(process.execPath, ["-e", probe], { stdio: "ignore" }).status === 0;
  }
  expect(ready, `test forward listener failed to bind port ${String(port)}`).toBe(true);
}

function makeStoppedGatewayEnv(prefix: string): Record<string, string> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const localBin = path.join(home, "bin");
  fs.mkdirSync(localBin, { recursive: true });
  writeSandboxRegistry(home, "alpha");

  // openshell lies: sandbox list exits 0 and lists alpha as Ready even though
  // the gateway container is down (reads stale local registry/cache).
  writeExecutable(path.join(localBin, "openshell"), [
    'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
    '  printf "NAME STATUS\\nalpha Ready\\n"',
    "  exit 0",
    "fi",
    "exit 0",
  ]);

  // docker inspect: returns "false" for State.Running (gateway stopped).
  writeExecutable(path.join(localBin, "docker"), [
    'if [ "$1" = "inspect" ]; then',
    '  echo "false"',
    "  exit 0",
    "fi",
    "exit 0",
  ]);

  return {
    HOME: home,
    PATH: `${localBin}:${process.env.PATH ?? ""}`,
  };
}

function makeHealthyVmGatewayEnv(prefix: string): Record<string, string> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const localBin = path.join(home, "bin");
  fs.mkdirSync(localBin, { recursive: true });
  writeSandboxRegistry(home, "alpha", { openshellDriver: "vm" });

  // VM-driver snapshots should trust gateway metadata, not the legacy cluster
  // container probe.
  writeExecutable(path.join(localBin, "openshell"), [
    'case "$1 $2" in',
    '  "gateway info") printf "Gateway Info\\n\\nGateway: nemoclaw\\nGateway endpoint: https://127.0.0.1:8080/\\n"; exit 0 ;;',
    '  "sandbox list") printf "NAME STATUS\\nalpha Ready\\n"; exit 0 ;;',
    '  "sandbox exec") printf "NEMOCLAW_DCODE_PROBE=no-runtime\\n"; exit 0 ;;',
    '  "sandbox ssh-config") printf "Host openshell-alpha\\n  HostName 127.0.0.1\\n  User sandbox\\n"; exit 0 ;;',
    "esac",
    'if [ "$1" = "status" ]; then exit 0; fi',
    "exit 0",
  ]);

  writeExecutable(path.join(localBin, "ssh"), ["exit 0"]);
  writeExecutable(path.join(localBin, "docker"), [
    'if [ "$1" = "inspect" ]; then echo "false"; exit 0; fi',
    "exit 0",
  ]);

  return {
    HOME: home,
    PATH: `${localBin}:${process.env.PATH ?? ""}`,
  };
}

// VM-driver env with an `imageTag` set in the sandbox registry so the
// `resolveSrcPodImage()` fast path returns the image without falling back to
// the docker/kubectl probe.
function makeVmRestoreToEnv(
  prefix: string,
  entry: Record<string, unknown> = { imageTag: "openshell/sandbox-from:fast-path-test" },
): Record<string, string> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const localBin = path.join(home, "bin");
  fs.mkdirSync(localBin, { recursive: true });
  const dashboardPort = nextFixturePort++;
  writeSandboxRegistry(home, "alpha", {
    openshellDriver: "vm",
    dashboardPort,
    ...entry,
  });
  startReachableForward(dashboardPort);

  const cloneReadyMarker = path.join(home, "clone-1-ready");
  const cloneRunningMarker = path.join(home, "clone-1-running");
  const gatewayLifecycleLog = path.join(home, "gateway-lifecycle.log");
  writeExecutable(path.join(localBin, "openshell"), [
    'case "$1 $2" in',
    '  "gateway info") printf "Gateway Info\\n\\nGateway: nemoclaw\\nGateway endpoint: https://127.0.0.1:8080/\\n"; exit 0 ;;',
    '  "sandbox get") printf "{\\"name\\":\\"%s\\"}\\n" "$3"; exit 0 ;;',
    `  "sandbox list") if [ -f ${JSON.stringify(cloneReadyMarker)} ]; then printf "NAME STATUS\\nalpha Ready\\nclone-1 Ready\\n"; else printf "NAME STATUS\\nalpha Ready\\n"; fi; exit 0 ;;`,
    '  "sandbox exec")',
    '    case "$*" in',
    '      *"__NEMOCLAW_SANDBOX_EXEC_STARTED__"*) printf "__NEMOCLAW_SANDBOX_EXEC_STARTED__\\nRUNNING\\n"; exit 0 ;;',
    "    esac",
    '    printf "NEMOCLAW_DCODE_PROBE=no-runtime\\n"; exit 0 ;;',
    '  "sandbox ssh-config") printf "Host openshell-alpha\\n  HostName 127.0.0.1\\n  User sandbox\\n"; exit 0 ;;',
    `  "sandbox create") touch ${JSON.stringify(cloneReadyMarker)} ${JSON.stringify(cloneRunningMarker)}; printf "created clone-1\\n"; exit 0 ;;`,
    `  "forward list") printf "SANDBOX BIND PORT PID STATUS\\nclone-1 127.0.0.1 ${String(dashboardPort)} 4242 running\\n"; exit 0 ;;`,
    '  "forward stop") exit 1 ;;',
    "esac",
    'if [ "$1" = "status" ]; then exit 0; fi',
    "exit 0",
  ]);

  const remoteOpenClawJson = path.join(home, "remote-openclaw.json");
  fs.writeFileSync(remoteOpenClawJson, JSON.stringify({ gateway: { auth: { token: "fresh" } } }));
  writeExecutable(path.join(localBin, "ssh"), [
    `REMOTE_OPENCLAW_JSON=${JSON.stringify(remoteOpenClawJson)}`,
    'cmd=""; for arg do cmd="$arg"; done',
    'if printf "%s" "$cmd" | grep -q "openclaw.json"; then',
    '  if printf "%s" "$cmd" | grep -q "cat --"; then cat "$REMOTE_OPENCLAW_JSON"; exit 0; fi',
    '  if printf "%s" "$cmd" | grep -q ".nemoclaw-restore"; then cat > "$REMOTE_OPENCLAW_JSON"; exit 0; fi',
    "fi",
    "exit 0",
  ]);

  // Model the supervisor-mediated gateway lifecycle used after restore. Keep the
  // kubectl-via-gateway probe rejected so an image-resolution regression
  // remains distinguishable from the expected clone gateway restart.
  writeExecutable(path.join(localBin, "docker"), [
    `CLONE_RUNNING_MARKER=${JSON.stringify(cloneRunningMarker)}`,
    `LIFECYCLE_LOG=${JSON.stringify(gatewayLifecycleLog)}`,
    'if [ "$1" = "ps" ]; then',
    '  target=""; format=""; all_states=0',
    "  for arg do",
    '    case "$arg" in',
    '      label=openshell.ai/sandbox-name=*) target="${arg##*=}" ;;',
    '      *".Names"*|*".ID"*) format="$arg" ;;',
    "      -a) all_states=1 ;;",
    "    esac",
    "  done",
    '  [ "$target" = "clone-1" ] || exit 0',
    '  if [ -f "$CLONE_RUNNING_MARKER" ]; then status="Up 1 minute"; else status="Exited (0) 1 second ago"; fi',
    '  if [ -f "$CLONE_RUNNING_MARKER" ] || [ "$all_states" = "1" ]; then',
    '    case "$format" in',
    '      *".ID"*) printf "clone-container-id\\topenshell-clone-1\\n" ;;',
    '      *".Status"*) printf "openshell-clone-1\\t%s\\n" "$status" ;;',
    '      *".Names"*) printf "openshell-clone-1\\n" ;;',
    "    esac",
    "  fi",
    "  exit 0",
    "fi",
    'if [ "$1" = "exec" ]; then',
    '  case "$*" in',
    '    *"/usr/local/bin/nemoclaw-gateway-control restart "*) printf "restart clone-1\\n" >> "$LIFECYCLE_LOG"; printf "GATEWAY_PID=123\\n"; exit 0 ;;',
    '    *"/usr/local/bin/nemoclaw-gateway-control probe "*) printf "GATEWAY_PID=123\\n"; exit 0 ;;',
    '    *"/usr/bin/id -u sandbox"*) printf "1000\\n"; exit 0 ;;',
    '    *"/usr/bin/id -g sandbox"*) printf "1000\\n"; exit 0 ;;',
    "  esac",
    "  for arg do",
    '    if [ "$arg" = "kubectl" ]; then echo "kubectl-must-not-run"; exit 1; fi',
    "  done",
    "  exit 0",
    "fi",
    "exit 0",
  ]);

  return {
    HOME: home,
    NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS: "0",
    PATH: `${localBin}:${process.env.PATH ?? ""}`,
  };
}

describe("snapshot gateway guard (#2673)", () => {
  it("snapshot restore rejects when gateway container is stopped", () => {
    const env = makeStoppedGatewayEnv("nemoclaw-snap-gw-restore-");
    const r = runCli("alpha snapshot restore s1", env);
    expect(r.code).toBe(1);
    expect(r.out).toContain("Failed to query live sandbox state");
  });

  it("snapshot create rejects when gateway container is stopped", () => {
    const env = makeStoppedGatewayEnv("nemoclaw-snap-gw-create-");
    const r = runCli("alpha snapshot create", env);
    expect(r.code).toBe(1);
    expect(r.out).toContain("Failed to query live sandbox state");
  });
});

describe("snapshot VM-driver gateway guard", () => {
  it("snapshot create accepts healthy macOS VM-driver gateways without legacy cluster container", () => {
    const env = makeHealthyVmGatewayEnv("nemoclaw-snap-vm-gw-create-");
    const r = runCli("alpha snapshot create --name baseline", env);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Snapshot v1 name=baseline created");
    expect(r.out).not.toContain("Failed to query live sandbox state");
  });

  // `snapshot restore --to <new>` on VM driver must use the registered
  // imageTag, not the legacy `docker exec ... kubectl` probe.
  it("snapshot restore --to uses registered imageTag and restarts the VM gateway before pairing verification", () => {
    const env = makeVmRestoreToEnv("nemoclaw-snap-vm-gw-restore-to-");

    const seed = runCli("alpha snapshot create --name baseline", env);
    expect(seed.code).toBe(0);
    expect(seed.out).toContain("Snapshot v1 name=baseline created");

    const r = runCli("alpha snapshot restore baseline --to clone-1", env);
    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toContain("could not resolve");
    expect(r.out).not.toContain("kubectl-must-not-run");
    expect(r.out).toContain("openshell/sandbox-from:fast-path-test");
    expect(fs.readFileSync(path.join(env.HOME, "gateway-lifecycle.log"), "utf8")).toBe(
      "restart clone-1\nrestart clone-1\n",
    );
  }, 15000);

  it("snapshot restore --to fails closed for VM-driver entries missing imageTag", () => {
    const env = makeVmRestoreToEnv("nemoclaw-snap-vm-gw-restore-to-missing-image-", {
      imageTag: null,
    });

    const seed = runCli("alpha snapshot create --name baseline", env);
    expect(seed.code).toBe(0);

    const r = runCli("alpha snapshot restore baseline --to clone-1", env);
    expect(r.code).toBe(1);
    expect(r.out).toContain("Cannot resolve image");
    expect(r.out).not.toContain("kubectl-must-not-run");
  }, 15000);
});
