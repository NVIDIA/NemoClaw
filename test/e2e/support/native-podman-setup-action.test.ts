// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  validateNativePodmanRestoreAction,
  validateNativePodmanSetupAction,
} from "../../../tools/e2e/workflow-boundary.mts";

const RESTORE_ACTION = path.resolve(".github/actions/restore-native-podman-e2e/action.yaml");
const SETUP_ACTION = path.resolve(".github/actions/setup-native-podman-e2e/action.yaml");
const FIXED_RESTORE_ROOT = "/usr/lib/nemoclaw-native-podman-e2e/docker-cli-restore";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function restoreRunScript(): string {
  const action = YAML.parse(fs.readFileSync(RESTORE_ACTION, "utf8")) as {
    runs: { steps: Array<{ name?: string; run?: string }> };
  };
  return String(
    action.runs.steps.find(
      ({ name }) => name === "Restore Docker CLI after native Podman execution",
    )?.run ?? "",
  );
}

type RestoreFixtureKind = "valid" | "regular-file" | "symlink";

function runRestoreFixture(
  kind: RestoreFixtureKind,
  serviceActiveState = "active",
  socketActiveState = "active",
  loadState = "loaded",
  unitFileState = "enabled",
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-podman-restore-"));
  const restoreRoot = path.join(root, "authority");
  const destination = path.join(root, "bin", "docker");
  const disabled = path.join(restoreRoot, "docker");
  fs.mkdirSync(restoreRoot, { mode: 0o700 });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const original = "#!/bin/sh\nexit 0\n";
  const expectedSha256 = createHash("sha256").update(original).digest("hex");
  fs.writeFileSync(path.join(restoreRoot, "metadata"), `${destination}\n${expectedSha256}\n`, {
    mode: 0o600,
  });
  fs.writeFileSync(
    path.join(restoreRoot, "runtime.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      dockerService: {
        loadState,
        activeState: serviceActiveState,
        unitFileState,
      },
      dockerSocket: {
        loadState,
        activeState: socketActiveState,
        unitFileState,
      },
    })}\n`,
    { mode: 0o600 },
  );
  const prepareSource = {
    valid: () => fs.writeFileSync(disabled, original, { mode: 0o755 }),
    "regular-file": () => fs.writeFileSync(disabled, "#!/bin/sh\necho tampered\n", { mode: 0o755 }),
    symlink: () => {
      const malicious = path.join(root, "malicious-docker");
      fs.writeFileSync(malicious, original, { mode: 0o755 });
      fs.symlinkSync(malicious, disabled);
    },
  } satisfies Record<RestoreFixtureKind, () => void>;
  prepareSource[kind]();
  const serviceState = path.join(root, "docker-service.state");
  const socketState = path.join(root, "docker-socket.state");
  const systemctlLog = path.join(root, "systemctl.log");
  fs.writeFileSync(serviceState, "inactive\n");
  fs.writeFileSync(socketState, "inactive\n");

  const commandShims = [
    "sudo() {",
    '  if [[ "${1:-}" == "-n" ]]; then shift; fi',
    '  "$@"',
    "}",
    "stat() {",
    '  case "${2:-}" in',
    "    %u:%g:%a) [[ \"${3:-}\" == *runtime.json ]] && printf '0:0:600\\n' || printf '0:0:700\\n' ;;",
    "    %u:%g) printf '0:0\\n' ;;",
    "    *) return 64 ;;",
    "  esac",
    "}",
    "sha256sum() {",
    '  if [[ "${1:-}" == "--" ]]; then shift; fi',
    `  "$NODE_BINARY" -e 'const fs=require("fs"),c=require("crypto"),p=process.argv[1];process.stdout.write(c.createHash("sha256").update(fs.readFileSync(p)).digest("hex")+"  "+p+"\\\\n")' "$1"`,
    "}",
    "find() {",
    '  local target=""',
    '  for value in "$@"; do [[ "$value" == /* ]] && target="$value" && break; done',
    '  [[ -n "$target" ]]',
    `  "$NODE_BINARY" -e 'const fs=require("fs"),p=process.argv[1];for(const name of fs.readdirSync(p).sort())process.stdout.write(name+"\\n")' "$target"`,
    "}",
    "systemctl() {",
    '  printf \'%s\\n\' "$*" >>"$SYSTEMCTL_LOG"',
    '  local operation="${1:-}"',
    "  shift || true",
    '  local unit="${*: -1}"',
    '  local state_file="$DOCKER_SERVICE_STATE"',
    '  [[ "$unit" == "docker.socket" ]] && state_file="$DOCKER_SOCKET_STATE"',
    '  case "$operation" in',
    "    show) printf '%s\\n' \"$DOCKER_LOAD_STATE\" ;;",
    '    is-active) cat "$state_file"; [[ "$(cat "$state_file")" == "active" ]] ;;',
    '    is-enabled) [[ "$DOCKER_UNIT_FILE_STATE" == "not-found" ]] && return 1; printf \'%s\\n\' "$DOCKER_UNIT_FILE_STATE" ;;',
    "    unmask) return 0 ;;",
    "    start) printf 'active\\n' >\"$state_file\" ;;",
    "    stop) printf 'inactive\\n' >\"$state_file\" ;;",
    "    *) return 64 ;;",
    "  esac",
    "}",
  ].join("\n");
  const script = restoreRunScript()
    .replace(`restore_root=${FIXED_RESTORE_ROOT}`, `restore_root=${shellQuote(restoreRoot)}`)
    .replace(
      "/usr/bin/docker | /usr/local/bin/docker | /snap/bin/docker) ;;",
      `${destination}) ;;`,
    );
  const result = spawnSync("bash", ["--noprofile", "--norc", "-c", `${commandShims}\n${script}`], {
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_BINARY: process.execPath,
      DOCKER_SERVICE_STATE: serviceState,
      DOCKER_SOCKET_STATE: socketState,
      DOCKER_LOAD_STATE: loadState,
      DOCKER_UNIT_FILE_STATE: unitFileState,
      PATH: `${path.dirname(destination)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      SYSTEMCTL_LOG: systemctlLog,
    },
  });
  return {
    destination,
    expectedSha256,
    restoreRoot,
    result,
    root,
    serviceState,
    socketState,
    systemctlLog,
  };
}

function writeExecutable(filePath: string, source: string): void {
  fs.writeFileSync(filePath, source, { mode: 0o700 });
}

function runPodmanCleanupFixture(
  withDockerState: boolean,
  podmanStopFails = false,
  withUnrelatedServiceUnit = false,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-podman-cleanup-"));
  const runnerTemp = path.join(root, "runner-temp");
  const home = path.join(root, "home");
  const fakeBin = path.join(root, "fake-bin");
  const toolchainRoot = path.join(root, "toolchain");
  const helperRoot = path.join(root, "helpers");
  const runtimeDirectory = path.join(root, "runtime");
  const serviceUnitDirectory = path.join(home, ".config", "systemd", "user");
  const storageDirectory = path.join(runnerTemp, "native-podman-e2e-storage");
  const restoreRoot = path.join(toolchainRoot, "docker-cli-restore");
  const destination = path.join(root, "docker-bin", "docker");
  const systemctlLog = path.join(root, "systemctl.log");
  const podmanServiceState = path.join(root, "podman-service.state");
  const loopbackState = path.join(root, "loopback-present");
  const uid = process.getuid?.() ?? 0;
  fs.mkdirSync(runnerTemp, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(path.join(toolchainRoot, "bin"), { recursive: true });
  fs.mkdirSync(helperRoot, { recursive: true });
  fs.mkdirSync(path.join(runtimeDirectory, "podman"), { recursive: true });
  fs.mkdirSync(serviceUnitDirectory, { recursive: true });
  fs.mkdirSync(path.join(storageDirectory, "runroot"), { recursive: true });
  fs.mkdirSync(path.join(storageDirectory, "graphroot"), { recursive: true });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.mkdirSync(path.join(runnerTemp, "native-podman-e2e-toolchain"), { recursive: true });
  fs.writeFileSync(path.join(toolchainRoot, "bin", "podman"), "owned\n");
  fs.writeFileSync(path.join(toolchainRoot, "bin", "pasta"), "owned\n");
  fs.writeFileSync(path.join(toolchainRoot, "podman.apparmor"), "owned\n");
  fs.writeFileSync(path.join(toolchainRoot, "pasta.apparmor"), "owned\n");
  fs.writeFileSync(path.join(helperRoot, "aardvark-dns"), "owned\n");
  fs.writeFileSync(path.join(helperRoot, "netavark"), "owned\n");
  fs.writeFileSync(path.join(helperRoot, "rootlessport"), "owned\n");
  fs.writeFileSync(
    path.join(serviceUnitDirectory, "nemoclaw-native-podman-e2e.service"),
    "owned\n",
  );
  fs.writeFileSync(path.join(serviceUnitDirectory, "nemoclaw-native-podman-e2e.socket"), "owned\n");
  new Map<boolean, () => void>([
    [
      true,
      () => fs.writeFileSync(path.join(serviceUnitDirectory, "unrelated.service"), "unowned\n"),
    ],
    [false, () => undefined],
  ]).get(withUnrelatedServiceUnit)!();
  fs.writeFileSync(path.join(runnerTemp, "native-podman-e2e-service.env"), "owned\n");
  fs.writeFileSync(path.join(runnerTemp, "native-podman-e2e-storage.conf"), "owned\n");
  fs.writeFileSync(path.join(runnerTemp, "native-podman-e2e-containers.conf"), "owned\n");
  fs.writeFileSync(path.join(runnerTemp, "native-podman-e2e-info.json"), "owned\n");
  fs.writeFileSync(loopbackState, "present\n");
  fs.writeFileSync(podmanServiceState, "active\n");
  fs.writeFileSync(
    path.join(toolchainRoot, "cleanup.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      uid,
      userRuntimeActive: "active",
      userManagerActive: "active",
      dbusActive: "active",
      podmanDirectoryPreexisting: false,
      serviceUnitDirectoryPreexisting: false,
      helperDirectoryPreexisting: false,
      loopbackAddressAdded: true,
      subuidRange: null,
      subgidRange: null,
    })}\n`,
    { mode: 0o600 },
  );
  const dockerBytes = "#!/bin/sh\nexit 0\n";
  const expectedSha256 = createHash("sha256").update(dockerBytes).digest("hex");
  const prepareDockerState = () => {
    fs.mkdirSync(restoreRoot, { mode: 0o700 });
    fs.writeFileSync(path.join(restoreRoot, "docker"), dockerBytes, { mode: 0o755 });
    fs.writeFileSync(path.join(restoreRoot, "metadata"), `${destination}\n${expectedSha256}\n`);
    fs.writeFileSync(
      path.join(restoreRoot, "runtime.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        dockerService: { loadState: "loaded", activeState: "active", unitFileState: "enabled" },
        dockerSocket: { loadState: "loaded", activeState: "active", unitFileState: "enabled" },
      })}\n`,
    );
  };
  new Map<boolean, () => void>([
    [true, prepareDockerState],
    [false, () => undefined],
  ]).get(withDockerState)!();
  writeExecutable(
    path.join(fakeBin, "systemctl"),
    `#!/bin/sh
printf '%s\\n' "$*" >>"$SYSTEMCTL_LOG"
case "$*" in
  'is-active user@${String(uid)}.service') printf 'active\\n' ;;
  '--user stop nemoclaw-native-podman-e2e.socket nemoclaw-native-podman-e2e.service')
    if [ "$PODMAN_STOP_FAILS" = true ]; then exit 1; fi
    printf 'inactive\\n' >"$PODMAN_SERVICE_STATE"
    ;;
  '--user is-active nemoclaw-native-podman-e2e.socket'|'--user is-active nemoclaw-native-podman-e2e.service')
    cat "$PODMAN_SERVICE_STATE"
    [ "$(cat "$PODMAN_SERVICE_STATE")" = active ]
    ;;
  *is-active*) printf 'active\\n' ;;
  *is-enabled*) printf 'enabled\\n' ;;
  *show*) printf 'loaded\\n' ;;
esac
exit 0
`,
  );
  writeExecutable(path.join(fakeBin, "apparmor_parser"), "#!/bin/sh\nexit 0\n");
  writeExecutable(
    path.join(fakeBin, "ip"),
    `#!/bin/sh
case "$*" in
  '-o -4 address show dev lo')
    if [ -e "$LOOPBACK_STATE" ]; then printf '1: lo inet 169.254.2.2/32 scope global lo\\n'; fi
    ;;
  'address del 169.254.2.2/32 dev lo') rm -f "$LOOPBACK_STATE" ;;
esac
`,
  );
  const commandShims = [
    "sudo() {",
    '  if [[ "${1:-}" == "-n" ]]; then shift; fi',
    '  "$@"',
    "}",
    "stat() {",
    '  case "${2:-}" in',
    `    %u:%g:%a) case "\${3:-}" in ${toolchainRoot}/cleanup.json|${restoreRoot}/runtime.json) printf '0:0:600\\n' ;; ${restoreRoot}) printf '0:0:700\\n' ;; *) printf '0:0:755\\n' ;; esac ;;`,
    "    %u:%g) printf '0:0\\n' ;;",
    `    %u) case "\${3:-}" in ${toolchainRoot}/*|${helperRoot}/*) printf '0\\n' ;; *) printf '${String(uid)}\\n' ;; esac ;;`,
    "    *) return 64 ;;",
    "  esac",
    "}",
    "sha256sum() {",
    '  if [[ "${1:-}" == "--" ]]; then shift; fi',
    `  "$NODE_BINARY" -e 'const fs=require("fs"),c=require("crypto"),p=process.argv[1];process.stdout.write(c.createHash("sha256").update(fs.readFileSync(p)).digest("hex")+"  "+p+"\\n")' "$1"`,
    "}",
    "find() {",
    '  local target=""',
    '  for value in "$@"; do [[ "$value" == /* ]] && target="$value" && break; done',
    '  [[ -n "$target" ]]',
    `  "$NODE_BINARY" -e 'const fs=require("fs"),p=process.argv[1];for(const name of fs.readdirSync(p).sort())process.stdout.write(name+"\\n")' "$target"`,
    "}",
    "rm() {",
    "  local filtered=()",
    '  for value in "$@"; do [[ "$value" == "--one-file-system" ]] || filtered+=("$value"); done',
    '  command rm "${filtered[@]}"',
    "}",
  ].join("\n");
  const script = restoreRunScript()
    .replace(`restore_root=${FIXED_RESTORE_ROOT}`, `restore_root=${shellQuote(restoreRoot)}`)
    .replace(
      "toolchain_install_root=/usr/lib/nemoclaw-native-podman-e2e",
      `toolchain_install_root=${shellQuote(toolchainRoot)}`,
    )
    .replace(
      "helper_install_root=/usr/local/libexec/podman",
      `helper_install_root=${shellQuote(helperRoot)}`,
    )
    .replace(
      'runtime_directory="/run/user/$uid"',
      `runtime_directory=${shellQuote(runtimeDirectory)}`,
    )
    .replaceAll("/usr/bin/systemctl", "systemctl")
    .replace(
      "/usr/bin/docker | /usr/local/bin/docker | /snap/bin/docker) ;;",
      `${destination}) ;;`,
    );
  const result = spawnSync("bash", ["--noprofile", "--norc", "-c", `${commandShims}\n${script}`], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      LOOPBACK_STATE: loopbackState,
      NODE_BINARY: process.execPath,
      PATH: `${fakeBin}:${path.dirname(destination)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      PODMAN_SERVICE_STATE: podmanServiceState,
      PODMAN_STOP_FAILS: podmanStopFails ? "true" : "false",
      RUNNER_TEMP: runnerTemp,
      SYSTEMCTL_LOG: systemctlLog,
    },
  });
  return {
    destination,
    expectedSha256,
    helperRoot,
    loopbackState,
    podmanServiceState,
    result,
    root,
    runnerTemp,
    runtimeDirectory,
    restoreRoot,
    serviceUnitDirectory,
    storageDirectory,
    systemctlLog,
    toolchainRoot,
    withDockerState,
  };
}

describe("native Podman E2E setup boundary", () => {
  it("provides Podman authority without impersonating Docker", () => {
    expect(validateNativePodmanSetupAction()).toEqual([]);
  });

  it("restores Docker state only from the immutable root-owned authority (#11014)", () => {
    expect(validateNativePodmanRestoreAction()).toEqual([]);
  });

  it("rejects Docker isolation before runtime recovery state is recorded (#11014)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-podman-setup-mutation-"));
    const mutatedAction = path.join(root, "action.yaml");
    const source = fs
      .readFileSync(SETUP_ACTION, "utf8")
      .replace(
        '        docker_service_state="$(capture_unit_state docker.service)"',
        '        systemctl stop docker.service docker.socket\n        docker_service_state="$(capture_unit_state docker.service)"',
      );
    fs.writeFileSync(mutatedAction, source);

    try {
      expect(validateNativePodmanSetupAction(mutatedAction)).toContain(
        "native Podman setup must make Docker unavailable before qualification",
      );
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects mutable privileged dependency acquisition for native Podman (#11014)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-podman-setup-dependencies-"));
    const mutatedAction = path.join(root, "action.yaml");
    const source = fs
      .readFileSync(SETUP_ACTION, "utf8")
      .replace(
        "        required_host_commands=(\n",
        "        sudo apt-get update\n        sudo apt-get install --yes conmon\n        required_host_commands=(\n",
      );
    fs.writeFileSync(mutatedAction, source);

    try {
      expect(validateNativePodmanSetupAction(mutatedAction)).toContain(
        "native Podman setup must use trusted preinstalled host dependencies without mutable privileged acquisition",
      );
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects restore logic that omits Docker service recovery (#11014)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-podman-restore-mutation-"));
    const mutatedAction = path.join(root, "action.yaml");
    const source = fs
      .readFileSync(RESTORE_ACTION, "utf8")
      .replace("        apply_unit_activity docker.service dockerService\n", "");
    fs.writeFileSync(mutatedAction, source);

    try {
      expect(validateNativePodmanRestoreAction(mutatedAction)).toContain(
        "native Podman restore action must verify and restore its root-owned Docker runtime state",
      );
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects restore logic that never invokes native Podman cleanup (#11014)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-podman-cleanup-invocation-"));
    const mutatedAction = path.join(root, "action.yaml");
    const source = fs
      .readFileSync(RESTORE_ACTION, "utf8")
      .replace("        (set -e; cleanup_native_podman_runtime)\n", "");
    fs.writeFileSync(mutatedAction, source);

    try {
      expect(validateNativePodmanRestoreAction(mutatedAction)).toContain(
        "native Podman restore action must remove recorded runner resources before restoring Docker",
      );
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it("restores unchanged Docker runtime state and retires its authority (#11014)", () => {
    const {
      destination,
      expectedSha256,
      restoreRoot,
      result,
      root,
      serviceState,
      socketState,
      systemctlLog,
    } = runRestoreFixture("valid");

    try {
      expect(result.status, result.stderr).toBe(0);
      expect(createHash("sha256").update(fs.readFileSync(destination)).digest("hex")).toBe(
        expectedSha256,
      );
      expect(
        spawnSync("bash", ["--noprofile", "--norc", "-c", "command -v docker"], {
          encoding: "utf8",
          env: { ...process.env, PATH: `${path.dirname(destination)}:/usr/bin:/bin` },
        }).stdout.trim(),
      ).toBe(destination);
      expect(fs.existsSync(restoreRoot)).toBe(false);
      expect(fs.readFileSync(serviceState, "utf8").trim()).toBe("active");
      expect(fs.readFileSync(socketState, "utf8").trim()).toBe("active");
      expect(fs.readFileSync(systemctlLog, "utf8")).toContain("unmask --runtime docker.service");
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it.each(["regular-file", "symlink"] as const)(
    "rejects a tampered %s restore source without modifying the Docker destination",
    (kind) => {
      const { destination, result, root } = runRestoreFixture(kind);

      try {
        expect(result.status).not.toBe(0);
        expect(fs.existsSync(destination)).toBe(false);
      } finally {
        fs.rmSync(root, { force: true, recursive: true });
      }
    },
  );

  it("keeps Docker services inactive when they were inactive before isolation (#11014)", () => {
    const fixture = runRestoreFixture("valid", "inactive", "inactive");

    try {
      expect(fixture.result.status, fixture.result.stderr).toBe(0);
      expect(fs.readFileSync(fixture.serviceState, "utf8").trim()).toBe("inactive");
      expect(fs.readFileSync(fixture.socketState, "utf8").trim()).toBe("inactive");
    } finally {
      fs.rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("restores absent Docker units when is-enabled returns no text (#11014)", () => {
    const fixture = runRestoreFixture("valid", "inactive", "inactive", "not-found", "not-found");

    try {
      expect(fixture.result.status, fixture.result.stderr).toBe(0);
      expect(fs.existsSync(fixture.destination)).toBe(true);
      expect(createHash("sha256").update(fs.readFileSync(fixture.destination)).digest("hex")).toBe(
        fixture.expectedSha256,
      );
      expect(fs.existsSync(fixture.restoreRoot)).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it.each([
    ["after complete setup", true],
    ["after setup fails before Docker-state capture", false],
  ] as const)("removes native Podman runner resources %s (#11014)", (_label, withDockerState) => {
    const fixture = runPodmanCleanupFixture(withDockerState);

    try {
      expect(fixture.result.status, fixture.result.stderr).toBe(0);
      expect(fs.existsSync(fixture.toolchainRoot)).toBe(false);
      expect(fs.existsSync(fixture.storageDirectory)).toBe(false);
      expect(fs.existsSync(fixture.serviceUnitDirectory)).toBe(false);
      expect(fs.existsSync(path.join(fixture.runtimeDirectory, "podman"))).toBe(false);
      expect(fs.existsSync(fixture.loopbackState)).toBe(false);
      expect(fs.existsSync(fixture.helperRoot)).toBe(false);
      expect(fs.existsSync(path.join(fixture.runnerTemp, "native-podman-e2e-toolchain"))).toBe(
        false,
      );
      expect(fs.existsSync(fixture.destination)).toBe(withDockerState);
      expect(
        withDockerState
          ? createHash("sha256").update(fs.readFileSync(fixture.destination)).digest("hex")
          : null,
      ).toBe(withDockerState ? fixture.expectedSha256 : null);
      expect(fs.readFileSync(fixture.systemctlLog, "utf8")).toContain(
        "--user stop nemoclaw-native-podman-e2e.socket nemoclaw-native-podman-e2e.service",
      );
    } finally {
      fs.rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("preserves unrelated user units while completing native Podman cleanup", () => {
    const fixture = runPodmanCleanupFixture(true, false, true);
    const unrelatedServiceUnit = path.join(fixture.serviceUnitDirectory, "unrelated.service");

    try {
      expect(fixture.result.status, fixture.result.stderr).toBe(0);
      expect(fs.readFileSync(unrelatedServiceUnit, "utf8")).toBe("unowned\n");
      expect(
        fs.existsSync(
          path.join(fixture.serviceUnitDirectory, "nemoclaw-native-podman-e2e.service"),
        ),
      ).toBe(false);
      expect(fs.existsSync(fixture.toolchainRoot)).toBe(false);
      expect(fs.existsSync(fixture.destination)).toBe(true);
    } finally {
      fs.rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("preserves recovery authority when the native Podman service survives stop (#11014)", () => {
    const fixture = runPodmanCleanupFixture(true, true);

    try {
      expect(fixture.result.status).not.toBe(0);
      expect(fixture.result.stderr).toContain(
        "systemctl --user status nemoclaw-native-podman-e2e.socket nemoclaw-native-podman-e2e.service",
      );
      expect(fs.existsSync(path.join(fixture.toolchainRoot, "cleanup.json"))).toBe(true);
      expect(fs.existsSync(path.join(fixture.toolchainRoot, "bin", "podman"))).toBe(true);
      expect(fs.existsSync(fixture.storageDirectory)).toBe(true);
      expect(fs.existsSync(fixture.serviceUnitDirectory)).toBe(true);
      expect(fs.existsSync(fixture.destination)).toBe(false);
      expect(fs.existsSync(fixture.restoreRoot)).toBe(true);
      expect(fs.existsSync(path.join(fixture.restoreRoot, "docker"))).toBe(true);
      expect(fs.existsSync(path.join(fixture.restoreRoot, "metadata"))).toBe(true);
      expect(fs.existsSync(path.join(fixture.restoreRoot, "runtime.json"))).toBe(true);
    } finally {
      fs.rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("rejects a restore record that cannot prove the prior Docker service state (#11014)", () => {
    const fixture = runRestoreFixture("valid", "activating");

    try {
      expect(fixture.result.status).not.toBe(0);
      expect(fs.existsSync(fixture.destination)).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { force: true, recursive: true });
    }
  });
});
