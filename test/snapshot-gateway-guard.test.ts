// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Regression tests for issue #2673: snapshot restore/create must reject when
// the openshell-cluster gateway container is stopped, even when
// `openshell sandbox list` lies and returns exit 0 with stale data.

import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { execTimeout } from "./helpers/timeouts";

const CLI = path.join(import.meta.dirname, "..", "bin", "nemoclaw.js");

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
  writeSandboxRegistry(home, "alpha", {
    openshellDriver: "vm",
    ...entry,
  });

  const cloneReadyMarker = path.join(home, "clone-1-ready");
  writeExecutable(path.join(localBin, "openshell"), [
    'case "$1 $2" in',
    '  "gateway info") printf "Gateway Info\\n\\nGateway: nemoclaw\\nGateway endpoint: https://127.0.0.1:8080/\\n"; exit 0 ;;',
    `  "sandbox list") if [ -f ${JSON.stringify(cloneReadyMarker)} ]; then printf "NAME STATUS\\nalpha Ready\\nclone-1 Ready\\n"; else printf "NAME STATUS\\nalpha Ready\\n"; fi; exit 0 ;;`,
    '  "sandbox ssh-config") printf "Host openshell-alpha\\n  HostName 127.0.0.1\\n  User sandbox\\n"; exit 0 ;;',
    `  "sandbox create") touch ${JSON.stringify(cloneReadyMarker)}; printf "created clone-1\\n"; exit 0 ;;`,
    "esac",
    'if [ "$1" = "status" ]; then exit 0; fi',
    "exit 0",
  ]);

  writeExecutable(path.join(localBin, "ssh"), ["exit 0"]);

  // `docker exec` must never run: if the fast path regresses,
  // resolveSrcPodImage falls into the kubectl-via-docker probe and this
  // marker shows up in the captured output.
  writeExecutable(path.join(localBin, "docker"), [
    'if [ "$1" = "exec" ]; then',
    '  echo "kubectl-must-not-run"',
    "  exit 1",
    "fi",
    "exit 0",
  ]);

  return {
    HOME: home,
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
  it("snapshot restore --to uses registered imageTag for VM-driver auto-create instead of kubectl probe", () => {
    const env = makeVmRestoreToEnv("nemoclaw-snap-vm-gw-restore-to-");

    const seed = runCli("alpha snapshot create --name baseline", env);
    expect(seed.code).toBe(0);
    expect(seed.out).toContain("Snapshot v1 name=baseline created");

    const r = runCli("alpha snapshot restore baseline --to clone-1", env);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("could not resolve");
    expect(r.out).not.toContain("kubectl-must-not-run");
    expect(r.out).toContain("openshell/sandbox-from:fast-path-test");
  });

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
  });
});
