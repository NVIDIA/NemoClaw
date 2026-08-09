// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const INSTALLER_PAYLOAD = path.join(import.meta.dirname, "..", "scripts", "install.sh");
const tempRoots: string[] = [];

afterEach(() => {
  for (const tempRoot of tempRoots.splice(0)) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

interface PortableOverrideOptions {
  profile?: string;
  dockerHost?: string;
  existingStorage?: string;
  runroot?: string;
  runs?: number;
  xdgRuntimeDir?: string;
}

function runPortableOverride(options: PortableOverrideOptions = {}): {
  home: string;
  result: ReturnType<typeof spawnSync>;
  trace: string;
} {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-installer-"));
  tempRoots.push(home);
  if (options.existingStorage !== undefined) {
    const storagePath = path.join(home, ".config", "containers", "storage.conf");
    fs.mkdirSync(path.dirname(storagePath), { recursive: true });
    fs.writeFileSync(storagePath, options.existingStorage, { mode: 0o600 });
  }

  const snippet = `
    set -e
    source "${INSTALLER_PAYLOAD}" >/dev/null 2>&1 || true
    NEMOCLAW_EXPERIMENTAL_PROFILE="${options.profile ?? "portable"}"
    export NEMOCLAW_EXPERIMENTAL_PROFILE
    command_exists() { return 0; }
    uname() { printf 'Linux\\n'; }
    id() { printf '4242\\n'; }
    systemctl() {
      printf 'SYSTEMCTL=%s\\n' "$*" >&2
      printf 'SYSTEMCTL=%s\\n' "$*" >> "$NEMOCLAW_TEST_TRACE"
    }
    podman() {
      printf 'PODMAN=%s\\n' "$*" >> "$NEMOCLAW_TEST_TRACE"
      case "$*" in
        *Store.GraphRoot*) printf '%s\\n' "$HOME/.local/share/containers/storage" ;;
        *Store.RunRoot*) printf '%s\\n' "\${NEMOCLAW_TEST_RUNROOT:-\${XDG_RUNTIME_DIR:-/run/user/4242}/containers}" ;;
        *RemoteSocket.Path*) printf '/run/user/4242/selected/podman.sock\\n' ;;
      esac
    }
    info() { printf 'INFO=%s\\n' "$*"; }
    error() { printf 'ERROR=%s\\n' "$*" >&2; return 1; }
    for _ in $(seq 1 "${options.runs ?? 1}"); do
      prepare_portable_experimental_runtime_override
    done
    printf 'DOCKER_HOST=%s\\n' "\${DOCKER_HOST:-}"
  `;
  const tracePath = path.join(home, "installer.trace");
  const result = spawnSync("bash", ["-c", snippet], {
    encoding: "utf-8",
    env: {
      ...process.env,
      DOCKER_HOST: options.dockerHost ?? "",
      HOME: home,
      NEMOCLAW_TEST_TRACE: tracePath,
      NEMOCLAW_TEST_RUNROOT: options.runroot ?? "",
      XDG_RUNTIME_DIR: options.xdgRuntimeDir ?? "/run/user/4242",
    },
  });
  return {
    home,
    result,
    trace: fs.existsSync(tracePath) ? fs.readFileSync(tracePath, "utf-8") : "",
  };
}

describe("installer portable profile runtime override", () => {
  it("configures and verifies persistent Podman storage before installer preflight", () => {
    const { home, result, trace } = runPortableOverride();
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("SYSTEMCTL=--user try-restart podman.service");
    expect(result.stderr).toContain("SYSTEMCTL=--user enable --now podman.socket");
    expect(result.stderr).toContain("SYSTEMCTL=--user enable podman-restart.service");
    expect(result.stdout).toContain("DOCKER_HOST=unix:///run/user/4242/selected/podman.sock");

    const storagePath = path.join(home, ".config", "containers", "storage.conf");
    expect(fs.readFileSync(storagePath, "utf-8")).toBe(
      `# NEMOCLAW_MANAGED_PORTABLE_STORAGE=1
[storage]
graphroot = "${home}/.local/share/containers/storage"
runroot = "/run/user/4242/containers"
driver = "overlay"
transient_store = false
`,
    );
    expect(fs.statSync(storagePath).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(path.join(home, ".local", "share", "containers", "runroot"))).toBe(false);
    expect(trace.indexOf("PODMAN=info --format {{.Store.GraphRoot}}")).toBeGreaterThan(
      trace.indexOf("SYSTEMCTL=--user enable podman-restart.service"),
    );
  });

  it("does not touch the runtime without the explicit portable profile", () => {
    const { result } = runPortableOverride({
      profile: "",
      dockerHost: "unix:///preexisting.sock",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("DOCKER_HOST=unix:///preexisting.sock\n");
    expect(result.stderr).toBe("");
  });

  it("reuses the exact marked configuration on repeat runs", () => {
    const { home, result } = runPortableOverride({ runs: 2 });
    const stdout = String(result.stdout);
    expect(result.status).toBe(0);
    expect(
      stdout.match(/Reusing NemoClaw-managed persistent Podman storage configuration at /gu),
    ).toHaveLength(1);
    const storageDirectory = path.join(home, ".config", "containers");
    expect(fs.readdirSync(storageDirectory)).toEqual(["storage.conf"]);
  });

  it("replaces the obsolete NemoClaw-managed persistent RunRoot configuration", () => {
    const obsoleteStorage = `# NEMOCLAW_MANAGED_PORTABLE_STORAGE=1
[storage]
graphroot = "/home/kiosk/.local/share/containers/storage"
runroot = "/home/kiosk/.local/share/containers/runroot"
driver = "overlay"
transient_store = false
`;
    const { home, result } = runPortableOverride({ existingStorage: obsoleteStorage });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "Replacing obsolete NemoClaw-managed Podman storage configuration",
    );
    expect(fs.readdirSync(path.join(home, ".config", "containers"))).toEqual(["storage.conf"]);
    expect(
      fs.readFileSync(path.join(home, ".config", "containers", "storage.conf"), "utf8"),
    ).toContain('runroot = "/run/user/4242/containers"');
  });

  it("backs up an unrelated storage configuration before installing the POC configuration", () => {
    const foreignStorage = '[storage]\ndriver = "vfs"\n';
    const { result } = runPortableOverride({ existingStorage: foreignStorage });
    const stdout = String(result.stdout);
    expect(result.status).toBe(0);
    const backupLine = stdout
      .split("\n")
      .find((line) => line.includes("Backed up the existing Podman storage configuration to "));
    expect(backupLine).toBeDefined();
    const backupPath = backupLine?.replace(/^INFO=.* to /u, "").replace(/\.$/u, "");
    expect(backupPath).toBeDefined();
    expect(fs.readFileSync(backupPath ?? "", "utf-8")).toBe(foreignStorage);
    expect(stdout.indexOf("Backed up the existing Podman storage configuration")).toBeLessThan(
      stdout.indexOf("Configured persistent rootless Podman storage"),
    );
  });

  it("fails immediately when Podman reports a different RunRoot", () => {
    const { result, trace } = runPortableOverride({ runroot: "/run/user/9999/containers" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Podman RunRoot mismatch: expected");
    expect(trace).not.toContain("PODMAN=info --format {{.Host.RemoteSocket.Path}}");
  });
});
