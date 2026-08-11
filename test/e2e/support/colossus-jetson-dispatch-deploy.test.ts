// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const DEPLOY_SCRIPT = path.join(process.cwd(), "tools/e2e/colossus-jetson-dispatch-deploy.sh");
const ENVIRONMENT_SOURCE = path.join(
  process.cwd(),
  "tools/e2e/colossus-jetson-dispatch.environment",
);
const FIXED_ORIGIN = "https://github.com/NVIDIA/NemoClaw.git";
const UNIT_SOURCE = path.join(process.cwd(), "tools/e2e/nemoclaw-jetson-dispatch.service");
const temporaryDirectories: string[] = [];

const HARNESS = String.raw`
set -euo pipefail
source "$DEPLOY_SCRIPT"

deploy_root="$TEST_ROOT/opt/nemoclaw-jetson-dispatch"
releases_directory="$deploy_root/releases"
current_link="$deploy_root/current"
deploy_lock="$deploy_root/deploy.lock"
cleanup_executable="$TEST_ROOT/usr/local/libexec/nemoclaw-jetson-cleanup"
cleanup_link_target="$current_link/$cleanup_relative"
service_home="$TEST_ROOT/var/lib/nemoclaw-jetson-dispatch"
state_directory="$service_home/state"
device_lock="$state_directory/device.lock"
ssh_identity_file="$service_home/id_ed25519"
ssh_known_hosts_file="$service_home/known_hosts"
node_executable="$NODE_EXECUTABLE"
environment_file="$TEST_ROOT/etc/nemoclaw-jetson-dispatch/environment"
unit_file="$TEST_ROOT/etc/systemd/system/$service_name"

mkdir -p "$state_directory" "${"$"}{environment_file%/*}" "${"$"}{unit_file%/*}"
printf 'test-private-key\n' >"$ssh_identity_file"
printf 'test-known-host\n' >"$ssh_known_hosts_file"
[ "$SERVICE_LOAD_STATE" != loaded ] || : >"$TEST_ROOT/service-active"
[ "$INITIAL_DEVICE_LOCK" != 1 ] || printf '%064d\n' 0 >"$device_lock"

effective_uid() {
  printf '%s\n' "$FAKE_UID"
}

id_exec() {
  [ "$MISSING_ACCOUNT" != 1 ] || return 1
  printf '1001\n'
}

require_service_owned_file() {
  [ -f "$1" ] && [ ! -L "$1" ]
}

require_service_owned_directory() {
  [ "$INVALID_SERVICE_HOME" != 1 ] || fail "$1 must be a directory, not a symbolic link"
  [ -d "$1" ] && [ ! -L "$1" ]
}

ssh_identity_is_valid() {
  [ "$INVALID_SSH_KEY" != 1 ]
}

known_hosts_has_jetson() {
  [ "$INVALID_KNOWN_HOSTS" != 1 ]
}

node_version_is_supported() {
  [ "$UNSUPPORTED_NODE" != 1 ]
}

install_directory() {
  /usr/bin/install -d -m "$2" "$1"
}

install_file() {
  /usr/bin/install -m "$3" "$1" "$2"
}

require_root_owned_directory() {
  [ -d "$1" ] && [ ! -L "$1" ]
}

require_root_owned_file() {
  [ -f "$1" ] && [ ! -L "$1" ]
}

root_owned_file_matches() {
  [ -f "$1" ] && [ ! -L "$1" ]
}

symlink_owner() {
  printf '0:0\n'
}

acquire_deploy_lock() {
  :
}

move_replace() {
  if [ "$2" = "$current_link" ] && [ -n "$FAIL_SELECT_SHA" ]; then
    candidate="$(/usr/bin/readlink "$1")"
    [ "${"$"}{candidate##*/}" != "$FAIL_SELECT_SHA" ] || return 1
  fi
  "$NODE_EXECUTABLE" -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$1" "$2"
}

move_directory() {
  /bin/mv "$1" "$2"
}

copy_file_preserving_metadata() {
  /bin/cp -p "$1" "$2"
}

files_match() {
  /usr/bin/cmp -s "$1" "$2"
}

git_exec() {
  {
    printf 'git'
    printf '\t%s' "$@"
    printf '\n'
  } >>"$TEST_ROOT/git.log"
  case "${"$"}{3:-}" in
  fetch)
    /usr/bin/git -c protocol.file.allow=always -C "$2" fetch \
      --depth=1 --no-tags "$FIXTURE_REPOSITORY" "${"$"}{!#}"
    ;;
  *) /usr/bin/git "$@" ;;
  esac
}

service_load_state() {
  if [ -f "$unit_file" ]; then
    printf 'loaded\n'
  else
    printf '%s\n' "$SERVICE_LOAD_STATE"
  fi
}

service_active_state() {
  [ "$ACTIVE_STATE_ERROR" != 1 ] || return 1
  if [ -f "$TEST_ROOT/service-active" ]; then
    printf 'active\n'
  else
    printf 'inactive\n'
  fi
}

current_sha() {
  /usr/bin/readlink "$current_link" 2>/dev/null | /usr/bin/awk -F/ '{print $NF}'
}

tunnel_is_active() {
  tunnel_check_count="$(cat "$TEST_ROOT/tunnel-check-count" 2>/dev/null || printf '0')"
  [ "$TUNNEL_ACTIVE" = 1 ] ||
    { [ "$TUNNEL_ACTIVATE_AFTER_CHECK" -gt 0 ] &&
      [ "$tunnel_check_count" -gt "$TUNNEL_ACTIVATE_AFTER_CHECK" ]; }
}

systemctl_exec() {
  printf 'systemctl\t%s\n' "$*" >>"$TEST_ROOT/service.log"
  case "$1" in
  show)
    if [ "${"$"}{!#}" = "$tunnel_service_name" ]; then
      case "$2" in
      --property=LoadState)
        tunnel_check_count="$(cat "$TEST_ROOT/tunnel-check-count" 2>/dev/null || printf '0')"
        tunnel_check_count="$((tunnel_check_count + 1))"
        printf '%s\n' "$tunnel_check_count" >"$TEST_ROOT/tunnel-check-count"
        if tunnel_is_active; then printf 'loaded\n'; else printf 'not-found\n'; fi
        ;;
      --property=ActiveState)
        if tunnel_is_active; then printf 'active\n'; else printf 'inactive\n'; fi
        ;;
      --property=UnitFileState)
        if tunnel_is_active; then printf 'enabled\n'; else printf 'disabled\n'; fi
        ;;
      *) return 1 ;;
      esac
    else
      return 1
    fi
    ;;
  daemon-reload) : ;;
  stop)
    stop_count="$(cat "$TEST_ROOT/stop-count" 2>/dev/null || printf '0')"
    stop_count="$((stop_count + 1))"
    printf '%s\n' "$stop_count" >"$TEST_ROOT/stop-count"
    if [ "$FAIL_ROLLBACK_STOP" = 1 ] && [ "$stop_count" -gt 1 ]; then
      return 1
    fi
    /bin/rm -f "$TEST_ROOT/service-active"
    if [ "$LEAVE_DEVICE_LOCK" = 1 ]; then
      printf '%064d\n' 0 >"$device_lock"
    else
      /bin/rm -f "$device_lock"
    fi
    ;;
  enable)
    selected="$(current_sha)"
    printf 'enable-sha\t%s\n' "$selected" >>"$TEST_ROOT/service.log"
    [ "$selected" != "$FAIL_START_SHA" ] || return 1
    : >"$TEST_ROOT/service-active"
    ;;
  disable)
    [ "$FAIL_INITIAL_ROLLBACK_DISABLE" != 1 ] || return 1
    /bin/rm -f "$TEST_ROOT/service-active"
    ;;
  start)
    selected="$(current_sha)"
    printf 'start-sha\t%s\n' "$selected" >>"$TEST_ROOT/service.log"
    [ "$selected" != "$FAIL_START_SHA" ] || return 1
    : >"$TEST_ROOT/service-active"
    ;;
  is-active) [ -f "$TEST_ROOT/service-active" ] ;;
  *) return 1 ;;
  esac
}

ss_exec() {
  if [ "$(current_sha)" = "$FAIL_VERIFY_SHA" ]; then
    printf 'LISTEN 0 511 0.0.0.0:8787 0.0.0.0:*\n'
  else
    printf 'LISTEN 0 511 127.0.0.1:8787 0.0.0.0:*\n'
  fi
}

curl_exec() {
  {
    printf 'curl'
    printf '\t%s' "$@"
    printf '\n'
  } >>"$TEST_ROOT/curl.log"
  if [ "$(current_sha)" = "$FAIL_VERIFY_SHA" ]; then
    printf '503'
  else
    printf '401'
  fi
}

sleep_exec() {
  :
}

main "$@"
`;

interface Fixture {
  directory: string;
  repository: string;
  firstSha: string;
  secondSha: string;
}

interface DeployOptions {
  activeStateError?: boolean;
  fakeUid?: string;
  failInitialRollbackDisable?: boolean;
  failRollbackStop?: boolean;
  failSelectSha?: string;
  serviceLoadState?: "loaded" | "not-found";
  failStartSha?: string;
  failVerifySha?: string;
  initialDeviceLock?: boolean;
  invalidKnownHosts?: boolean;
  invalidServiceHome?: boolean;
  invalidSshKey?: boolean;
  leaveDeviceLock?: boolean;
  missingAccount?: boolean;
  tunnelActive?: boolean;
  tunnelActivatesAfterCheck?: number;
  unsupportedNode?: boolean;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

function git(repository: string, ...args: string[]): string {
  return execFileSync("/usr/bin/git", ["-C", repository, ...args], {
    encoding: "utf8",
  }).trim();
}

function createFixture(): Fixture {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-colossus-deploy-"));
  temporaryDirectories.push(directory);
  const repository = path.join(directory, "origin");
  fs.mkdirSync(path.join(repository, "tools/e2e"), { recursive: true });
  execFileSync("/usr/bin/git", ["init", "--quiet", repository]);
  git(repository, "config", "user.name", "NemoClaw Test");
  git(repository, "config", "user.email", "test@example.com");
  const cleanup = path.join(repository, "tools/e2e/jetson-dispatch-cleanup.sh");
  const environment = path.join(repository, "tools/e2e/colossus-jetson-dispatch.environment");
  const unit = path.join(repository, "tools/e2e/nemoclaw-jetson-dispatch.service");
  fs.writeFileSync(cleanup, "#!/usr/bin/env bash\necho first-release\n", { mode: 0o755 });
  fs.writeFileSync(environment, "JETSON_DISPATCH_PORT=8787\n");
  fs.writeFileSync(unit, "[Service]\nEnvironmentFile=/etc/nemoclaw-jetson-dispatch/environment\n");
  git(repository, "add", "tools/e2e");
  git(repository, "commit", "--quiet", "-m", "first release");
  const firstSha = git(repository, "rev-parse", "HEAD");
  fs.writeFileSync(cleanup, "#!/usr/bin/env bash\necho second-release\n", { mode: 0o755 });
  git(repository, "add", cleanup);
  git(repository, "commit", "--quiet", "-m", "second release");
  return { directory, repository, firstSha, secondSha: git(repository, "rev-parse", "HEAD") };
}

function runDeploy(
  fixture: Fixture,
  args: string[],
  options: DeployOptions = {},
): ReturnType<typeof spawnSync> {
  return spawnSync("/bin/bash", ["-c", HARNESS, "deploy-harness", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ACTIVE_STATE_ERROR: options.activeStateError ? "1" : "0",
      DEPLOY_SCRIPT,
      FAIL_INITIAL_ROLLBACK_DISABLE: options.failInitialRollbackDisable ? "1" : "0",
      FAIL_ROLLBACK_STOP: options.failRollbackStop ? "1" : "0",
      FAIL_SELECT_SHA: options.failSelectSha ?? "",
      FAIL_START_SHA: options.failStartSha ?? "",
      FAIL_VERIFY_SHA: options.failVerifySha ?? "",
      FAKE_UID: options.fakeUid ?? "0",
      FIXTURE_REPOSITORY: fixture.repository,
      INITIAL_DEVICE_LOCK: options.initialDeviceLock ? "1" : "0",
      INVALID_KNOWN_HOSTS: options.invalidKnownHosts ? "1" : "0",
      INVALID_SERVICE_HOME: options.invalidServiceHome ? "1" : "0",
      INVALID_SSH_KEY: options.invalidSshKey ? "1" : "0",
      LEAVE_DEVICE_LOCK: options.leaveDeviceLock ? "1" : "0",
      MISSING_ACCOUNT: options.missingAccount ? "1" : "0",
      NODE_EXECUTABLE: process.execPath,
      SERVICE_LOAD_STATE: options.serviceLoadState ?? "not-found",
      TEST_ROOT: fixture.directory,
      TUNNEL_ACTIVE: options.tunnelActive ? "1" : "0",
      TUNNEL_ACTIVATE_AFTER_CHECK: String(options.tunnelActivatesAfterCheck ?? 0),
      UNSUPPORTED_NODE: options.unsupportedNode ? "1" : "0",
    },
  });
}

function deploymentPaths(fixture: Fixture) {
  const root = path.join(fixture.directory, "opt/nemoclaw-jetson-dispatch");
  return {
    cleanup: path.join(fixture.directory, "usr/local/libexec/nemoclaw-jetson-cleanup"),
    current: path.join(root, "current"),
    environment: path.join(fixture.directory, "etc/nemoclaw-jetson-dispatch/environment"),
    releases: path.join(root, "releases"),
    serviceLog: path.join(fixture.directory, "service.log"),
    unit: path.join(fixture.directory, "etc/systemd/system/nemoclaw-jetson-dispatch.service"),
  };
}

function readIfPresent(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

describe("Colossus Jetson dispatcher deployment", () => {
  it("ships the fixed dispatcher environment and restricted systemd unit (#8142)", () => {
    const environment = fs.readFileSync(ENVIRONMENT_SOURCE, "utf8");
    const unit = fs.readFileSync(UNIT_SOURCE, "utf8");

    expect(environment).toContain("JETSON_DISPATCH_GITHUB_REPOSITORY_ID=1182547092");
    expect(environment).toContain("JETSON_DISPATCH_SSH_DESTINATION=nvidia@192.168.55.1");
    expect(environment).toContain(
      "JETSON_DISPATCH_CLEANUP_EXECUTABLE=/usr/local/libexec/nemoclaw-jetson-cleanup",
    );
    expect(environment).not.toContain("=REPOSITORY_ID");
    expect(unit).toContain("EnvironmentFile=/etc/nemoclaw-jetson-dispatch/environment");
    expect(unit).toContain("WorkingDirectory=/opt/nemoclaw-jetson-dispatch/current");
    expect(unit).toContain("NoNewPrivileges=true");
    expect(unit).not.toContain("nemoclaw-jetson-tunnel.service");
  });

  it("installs and verifies an exact release when the service is absent (#8142)", () => {
    const fixture = createFixture();
    const result = runDeploy(fixture, ["--commit", fixture.firstSha]);
    const paths = deploymentPaths(fixture);

    expect(result.status, String(result.stderr)).toBe(0);
    expect(fs.readlinkSync(paths.current)).toBe(path.join(paths.releases, fixture.firstSha));
    expect(fs.readlinkSync(paths.cleanup)).toBe(
      path.join(paths.current, "tools/e2e/jetson-dispatch-cleanup.sh"),
    );
    expect(fs.readFileSync(paths.cleanup, "utf8")).toContain("first-release");
    expect(fs.readdirSync(paths.releases)).toEqual([fixture.firstSha]);
    expect(fs.readFileSync(paths.environment, "utf8")).toBe("JETSON_DISPATCH_PORT=8787\n");
    expect(fs.readFileSync(paths.unit, "utf8")).toContain(
      "EnvironmentFile=/etc/nemoclaw-jetson-dispatch/environment",
    );
    expect(readIfPresent(paths.serviceLog)).toMatch(
      /systemctl\tdaemon-reload[\s\S]*systemctl\tenable --now nemoclaw-jetson-dispatch\.service/u,
    );
    expect(result.stdout).toMatch(
      /\[1\/5\].*[\s\S]*\[2\/5\].*[\s\S]*\[3\/5\].*[\s\S]*\[4\/5\].*[\s\S]*\[5\/5\]/u,
    );
    expect(result.stdout).toContain("public ingress remains disabled");
    expect(readIfPresent(paths.serviceLog)).not.toContain(
      "enable --now nemoclaw-jetson-tunnel.service",
    );
    expect(fs.readFileSync(path.join(fixture.directory, "curl.log"), "utf8")).toContain(
      "curl\t--disable\t--noproxy\t*\t--silent",
    );
    expect(fs.readFileSync(path.join(fixture.directory, "git.log"), "utf8")).toContain(
      `remote\tadd\torigin\t${FIXED_ORIGIN}`,
    );
  });

  it.each([
    ["dispatcher account", { missingAccount: true }, "account is required"],
    ["service home", { invalidServiceHome: true }, "must be a directory"],
    ["SSH identity", { invalidSshKey: true }, "is not a readable OpenSSH private key"],
    ["pinned host key", { invalidKnownHosts: true }, "does not contain the pinned Jetson"],
    ["Node.js version", { unsupportedNode: true }, "must be Node.js 22.19.0 or later"],
  ] satisfies Array<
    [string, DeployOptions, string]
  >)("rejects initial deployment when the prepared %s is invalid (#8142)", (_name, options, error) => {
    const fixture = createFixture();
    const result = runDeploy(fixture, ["--commit", fixture.firstSha], options);
    const paths = deploymentPaths(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(error);
    expect(fs.existsSync(paths.current)).toBe(false);
    expect(fs.existsSync(paths.environment)).toBe(false);
    expect(fs.existsSync(paths.unit)).toBe(false);
  });

  it("rejects an unmanaged cleanup path before initial deployment (#8142)", () => {
    const fixture = createFixture();
    const paths = deploymentPaths(fixture);
    fs.mkdirSync(path.dirname(paths.cleanup), { recursive: true });
    fs.writeFileSync(paths.cleanup, "unmanaged\n");

    const result = runDeploy(fixture, ["--commit", fixture.firstSha]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("exists without one managed current release");
    expect(fs.readFileSync(paths.cleanup, "utf8")).toBe("unmanaged\n");
    expect(fs.existsSync(paths.environment)).toBe(false);
    expect(fs.existsSync(paths.unit)).toBe(false);
  });

  it("rejects an unmanaged current link before initial deployment (#8142)", () => {
    const fixture = createFixture();
    const paths = deploymentPaths(fixture);
    fs.mkdirSync(path.dirname(paths.current), { recursive: true });
    fs.symlinkSync(fixture.repository, paths.current);

    const result = runDeploy(fixture, ["--commit", fixture.firstSha]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not select one managed release");
    expect(fs.readlinkSync(paths.current)).toBe(fixture.repository);
    expect(fs.existsSync(paths.cleanup)).toBe(false);
    expect(fs.existsSync(paths.environment)).toBe(false);
    expect(fs.existsSync(paths.unit)).toBe(false);
  });

  it("rejects initial deployment while public ingress is active (#8142)", () => {
    const fixture = createFixture();
    const paths = deploymentPaths(fixture);
    const result = runDeploy(fixture, ["--commit", fixture.firstSha], {
      tunnelActive: true,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must be disabled and inactive");
    expect(fs.existsSync(paths.current)).toBe(false);
    expect(fs.existsSync(paths.environment)).toBe(false);
    expect(fs.existsSync(paths.unit)).toBe(false);
  });

  it("rolls back initial deployment when public ingress becomes active (#8142)", () => {
    const fixture = createFixture();
    const paths = deploymentPaths(fixture);
    const result = runDeploy(fixture, ["--commit", fixture.firstSha], {
      tunnelActivatesAfterCheck: 1,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("release, unit, and environment were rolled back");
    expect(fs.existsSync(paths.current)).toBe(false);
    expect(fs.existsSync(paths.cleanup)).toBe(false);
    expect(fs.existsSync(paths.environment)).toBe(false);
    expect(fs.existsSync(paths.unit)).toBe(false);
  });

  it("rolls back the initial release, unit, and environment when verification fails (#8142)", () => {
    const fixture = createFixture();
    const paths = deploymentPaths(fixture);
    const result = runDeploy(fixture, ["--commit", fixture.firstSha], {
      failVerifySha: fixture.firstSha,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("release, unit, and environment were rolled back");
    expect(fs.existsSync(paths.current)).toBe(false);
    expect(fs.existsSync(paths.cleanup)).toBe(false);
    expect(fs.existsSync(paths.environment)).toBe(false);
    expect(fs.existsSync(paths.unit)).toBe(false);
    expect(readIfPresent(paths.serviceLog)).toMatch(
      /systemctl\tenable --now nemoclaw-jetson-dispatch\.service[\s\S]*systemctl\tdisable --now nemoclaw-jetson-dispatch\.service[\s\S]*systemctl\tdaemon-reload/u,
    );
  });

  it("reports when initial rollback cannot disable the service (#8142)", () => {
    const fixture = createFixture();
    const paths = deploymentPaths(fixture);
    const result = runDeploy(fixture, ["--commit", fixture.firstSha], {
      failInitialRollbackDisable: true,
      failVerifySha: fixture.firstSha,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("rollback did not restore the prepared host");
    expect(fs.readlinkSync(paths.current)).toBe(path.join(paths.releases, fixture.firstSha));
    expect(fs.readFileSync(paths.cleanup, "utf8")).toContain("first-release");
    expect(fs.existsSync(paths.environment)).toBe(true);
    expect(fs.existsSync(paths.unit)).toBe(true);
  });

  it("reports inconclusive containment when ingress activates and initial disable fails (#8142)", () => {
    const fixture = createFixture();
    const paths = deploymentPaths(fixture);
    const result = runDeploy(fixture, ["--commit", fixture.firstSha], {
      failInitialRollbackDisable: true,
      tunnelActivatesAfterCheck: 2,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("rollback did not restore the prepared host");
    expect(fs.existsSync(path.join(fixture.directory, "service-active"))).toBe(true);
    expect(fs.readlinkSync(paths.current)).toBe(path.join(paths.releases, fixture.firstSha));
    expect(fs.existsSync(paths.environment)).toBe(true);
    expect(fs.existsSync(paths.unit)).toBe(true);
  });

  it("stops, switches, starts, and verifies an installed loopback service (#8142)", () => {
    const fixture = createFixture();
    expect(runDeploy(fixture, ["--commit", fixture.firstSha]).status).toBe(0);

    const result = runDeploy(fixture, ["--commit", fixture.secondSha], {
      serviceLoadState: "loaded",
    });
    const serviceLog = fs.readFileSync(deploymentPaths(fixture).serviceLog, "utf8");
    const curlLog = fs.readFileSync(path.join(fixture.directory, "curl.log"), "utf8");

    expect(result.status).toBe(0);
    expect(serviceLog).toMatch(
      /systemctl\tstop nemoclaw-jetson-dispatch\.service[\s\S]*start-sha\t[0-9a-f]{40}/u,
    );
    expect(result.stdout).toContain("verified its loopback service");
    expect(curlLog).toContain("curl\t--disable\t--noproxy\t*\t--silent");
  });

  it("rejects a later dispatcher deployment while public ingress is active (#8142)", () => {
    const fixture = createFixture();
    const paths = deploymentPaths(fixture);
    expect(runDeploy(fixture, ["--commit", fixture.firstSha]).status).toBe(0);
    const serviceLogBeforeDeployment = fs.readFileSync(paths.serviceLog, "utf8");

    const result = runDeploy(fixture, ["--commit", fixture.secondSha], {
      serviceLoadState: "loaded",
      tunnelActive: true,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must be disabled and inactive");
    expect(fs.readlinkSync(paths.current)).toBe(path.join(paths.releases, fixture.firstSha));
    const deploymentServiceLog = fs
      .readFileSync(paths.serviceLog, "utf8")
      .slice(serviceLogBeforeDeployment.length);
    expect(deploymentServiceLog).not.toContain("systemctl\tstop");
    expect(deploymentServiceLog).not.toContain("start-sha");
  });

  it.each([
    ["after the dispatcher starts", 3],
    ["after loopback verification", 4],
  ])("leaves the dispatcher stopped when public ingress activates %s (#8142)", (_phase, check) => {
    const fixture = createFixture();
    const paths = deploymentPaths(fixture);
    expect(runDeploy(fixture, ["--commit", fixture.firstSha]).status).toBe(0);
    fs.rmSync(path.join(fixture.directory, "tunnel-check-count"), { force: true });
    const serviceLogBeforeDeployment = fs.readFileSync(paths.serviceLog, "utf8");

    const result = runDeploy(fixture, ["--commit", fixture.secondSha], {
      serviceLoadState: "loaded",
      tunnelActivatesAfterCheck: check,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("rollback did not restore a verified service");
    expect(fs.readlinkSync(paths.current)).toBe(path.join(paths.releases, fixture.firstSha));
    expect(fs.existsSync(path.join(fixture.directory, "service-active"))).toBe(false);
    const deploymentServiceLog = fs
      .readFileSync(paths.serviceLog, "utf8")
      .slice(serviceLogBeforeDeployment.length);
    expect(deploymentServiceLog).toContain(`start-sha\t${fixture.secondSha}`);
    expect(deploymentServiceLog).not.toContain(`start-sha\t${fixture.firstSha}`);
  });

  it("reports inconclusive dispatcher state when ingress containment cannot stop it (#8142)", () => {
    const fixture = createFixture();
    const paths = deploymentPaths(fixture);
    expect(runDeploy(fixture, ["--commit", fixture.firstSha]).status).toBe(0);
    fs.rmSync(path.join(fixture.directory, "tunnel-check-count"), { force: true });

    const result = runDeploy(fixture, ["--commit", fixture.secondSha], {
      failRollbackStop: true,
      serviceLoadState: "loaded",
      tunnelActivatesAfterCheck: 3,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("rollback did not restore a verified service");
    expect(fs.readlinkSync(paths.current)).toBe(path.join(paths.releases, fixture.secondSha));
    expect(fs.existsSync(path.join(fixture.directory, "service-active"))).toBe(true);
  });

  it.each([
    ["a branch", ["--commit", "main"]],
    ["a tag", ["--commit", "v0.1.0"]],
    ["a URL", ["--commit", FIXED_ORIGIN]],
    ["an abbreviated SHA", ["--commit", "a".repeat(12)]],
    ["an uppercase SHA", ["--commit", "A".repeat(40)]],
    ["an extra argument", ["--commit", "a".repeat(40), "extra"]],
    ["a missing flag", ["a".repeat(40)]],
  ])("rejects %s before deployment (#8142)", (_name, args) => {
    const result = runDeploy(createFixture(), args);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--commit <full lowercase 40-character SHA>");
  });

  it("rejects deployment by a non-root caller (#8142)", () => {
    const fixture = createFixture();
    const result = runDeploy(fixture, ["--commit", fixture.firstSha], { fakeUid: "1000" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("this command requires root");
  });

  it("rejects a release whose configured origin is not the fixed repository (#8142)", () => {
    const fixture = createFixture();
    const paths = deploymentPaths(fixture);
    expect(runDeploy(fixture, ["--commit", fixture.firstSha]).status).toBe(0);
    git(
      path.join(paths.releases, fixture.firstSha),
      "remote",
      "set-url",
      "origin",
      "https://example.test/other.git",
    );

    const result = runDeploy(fixture, ["--commit", fixture.firstSha]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`release origin is not ${FIXED_ORIGIN}`);
    expect(fs.readlinkSync(paths.current)).toBe(path.join(paths.releases, fixture.firstSha));
  });

  it("rejects a modified release checkout (#8142)", () => {
    const fixture = createFixture();
    const paths = deploymentPaths(fixture);
    expect(runDeploy(fixture, ["--commit", fixture.firstSha]).status).toBe(0);
    fs.appendFileSync(
      path.join(paths.releases, fixture.firstSha, "tools/e2e/jetson-dispatch-cleanup.sh"),
      "modified\n",
    );

    const result = runDeploy(fixture, ["--commit", fixture.firstSha]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("release checkout is modified");
  });

  it("rejects a current link that does not select one managed release (#8142)", () => {
    const fixture = createFixture();
    const paths = deploymentPaths(fixture);
    expect(runDeploy(fixture, ["--commit", fixture.firstSha]).status).toBe(0);
    fs.unlinkSync(paths.current);
    fs.symlinkSync(fixture.repository, paths.current);

    const result = runDeploy(fixture, ["--commit", fixture.secondSha]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not select one managed release");
    expect(fs.readlinkSync(paths.current)).toBe(fixture.repository);
  });

  it("rolls back code and cleanup when service startup fails (#8142)", () => {
    const fixture = createFixture();
    const paths = deploymentPaths(fixture);
    expect(runDeploy(fixture, ["--commit", fixture.firstSha]).status).toBe(0);

    const result = runDeploy(fixture, ["--commit", fixture.secondSha], {
      failStartSha: fixture.secondSha,
      serviceLoadState: "loaded",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("previous deployment state was restored");
    expect(fs.readlinkSync(paths.current)).toBe(path.join(paths.releases, fixture.firstSha));
    expect(fs.readFileSync(paths.cleanup, "utf8")).toContain("first-release");
  });

  it("rejects an inconclusive service state after stopping (#8142)", () => {
    const fixture = createFixture();
    const paths = deploymentPaths(fixture);
    expect(runDeploy(fixture, ["--commit", fixture.firstSha]).status).toBe(0);

    const result = runDeploy(fixture, ["--commit", fixture.secondSha], {
      activeStateError: true,
      serviceLoadState: "loaded",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "could not inspect nemoclaw-jetson-dispatch.service after stop",
    );
    expect(fs.readlinkSync(paths.current)).toBe(path.join(paths.releases, fixture.firstSha));
  });

  it("does not switch releases when service cleanup leaves the device lock (#8142)", () => {
    const fixture = createFixture();
    const paths = deploymentPaths(fixture);
    expect(runDeploy(fixture, ["--commit", fixture.firstSha]).status).toBe(0);

    const result = runDeploy(fixture, ["--commit", fixture.secondSha], {
      leaveDeviceLock: true,
      serviceLoadState: "loaded",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("recover cleanup before deployment");
    expect(fs.readlinkSync(paths.current)).toBe(path.join(paths.releases, fixture.firstSha));
    expect(fs.readFileSync(paths.cleanup, "utf8")).toContain("first-release");
  });

  it("rejects bootstrap when a stale device lock remains (#8142)", () => {
    const fixture = createFixture();
    const paths = deploymentPaths(fixture);

    const result = runDeploy(fixture, ["--commit", fixture.firstSha], {
      initialDeviceLock: true,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("recover cleanup before deployment");
    expect(fs.existsSync(paths.current)).toBe(false);
    expect(fs.existsSync(paths.cleanup)).toBe(false);
    expect(fs.existsSync(paths.releases)).toBe(true);
    expect(fs.readdirSync(paths.releases)).toEqual([]);
  });

  it("redeploys the selected commit without creating another release (#8142)", () => {
    const fixture = createFixture();
    const paths = deploymentPaths(fixture);

    expect(runDeploy(fixture, ["--commit", fixture.firstSha]).status).toBe(0);
    expect(runDeploy(fixture, ["--commit", fixture.firstSha]).status).toBe(0);

    expect(fs.readdirSync(paths.releases)).toEqual([fixture.firstSha]);
    expect(fs.readlinkSync(paths.current)).toBe(path.join(paths.releases, fixture.firstSha));
    expect(fs.readFileSync(paths.cleanup, "utf8")).toContain("first-release");
  });

  it("rolls back code and cleanup when loopback verification fails (#8142)", () => {
    const fixture = createFixture();
    const paths = deploymentPaths(fixture);
    expect(runDeploy(fixture, ["--commit", fixture.firstSha]).status).toBe(0);

    const result = runDeploy(fixture, ["--commit", fixture.secondSha], {
      failVerifySha: fixture.secondSha,
      serviceLoadState: "loaded",
    });
    const serviceLog = fs.readFileSync(paths.serviceLog, "utf8");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("previous deployment state was restored");
    expect(fs.readlinkSync(paths.current)).toBe(path.join(paths.releases, fixture.firstSha));
    expect(fs.readFileSync(paths.cleanup, "utf8")).toContain("first-release");
    expect(serviceLog).toContain(`start-sha\t${fixture.secondSha}`);
    expect(serviceLog).toContain(`start-sha\t${fixture.firstSha}`);
  });

  it("keeps code and cleanup on the prior release when selection fails (#8142)", () => {
    const fixture = createFixture();
    const paths = deploymentPaths(fixture);
    expect(runDeploy(fixture, ["--commit", fixture.firstSha]).status).toBe(0);

    const result = runDeploy(fixture, ["--commit", fixture.secondSha], {
      failSelectSha: fixture.secondSha,
      serviceLoadState: "loaded",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("previous deployment state was restored");
    expect(fs.readlinkSync(paths.current)).toBe(path.join(paths.releases, fixture.firstSha));
    expect(fs.readlinkSync(paths.cleanup)).toBe(
      path.join(paths.current, "tools/e2e/jetson-dispatch-cleanup.sh"),
    );
    expect(fs.readFileSync(paths.cleanup, "utf8")).toContain("first-release");
  });

  it("keeps the new code and cleanup paired when rollback cannot stop the service (#8142)", () => {
    const fixture = createFixture();
    const paths = deploymentPaths(fixture);
    expect(runDeploy(fixture, ["--commit", fixture.firstSha]).status).toBe(0);

    const result = runDeploy(fixture, ["--commit", fixture.secondSha], {
      failRollbackStop: true,
      failVerifySha: fixture.secondSha,
      serviceLoadState: "loaded",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("rollback did not restore a verified service");
    expect(fs.readlinkSync(paths.current)).toBe(path.join(paths.releases, fixture.secondSha));
    expect(fs.readFileSync(paths.cleanup, "utf8")).toContain("second-release");
  });
});
