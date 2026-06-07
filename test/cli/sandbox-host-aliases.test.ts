// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runWithEnv, testTimeoutOptions, writeHostAliasDockerStub, writeSandboxRegistry } from "./helpers";

describe("CLI dispatch", () => {
  it("adds host aliases with a sandbox json patch", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-hosts-add-"));
    const localBin = path.join(home, "bin");
    const dockerLog = path.join(home, "docker.log");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home);
    fs.writeFileSync(
      path.join(localBin, "docker"),
      [
        "#!/usr/bin/env bash",
        `log_file=${JSON.stringify(dockerLog)}`,
        'printf "%s\\n" "$@" >> "$log_file"',
        'if [ "$1" = "ps" ]; then',
        '  printf "%s\\n" "openshell-cluster-nemoclaw"',
        "  exit 0",
        "fi",
        'if printf "%s\\n" "$@" | grep -q "^get$"; then',
        '  printf "%s\\n" \'{"metadata":{"resourceVersion":"123"},"spec":{"podTemplate":{"spec":{"hostAliases":[{"ip":"10.0.0.5","hostnames":["old.local"]}]}}}}\'',
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha hosts-add searxng.local 192.168.1.105", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(r.out).toContain("Added host alias searxng.local -> 192.168.1.105");
    const log = fs.readFileSync(dockerLog, "utf8").trim().split(/\n/);
    // The docker invocation targeting the legacy gateway container must use
    // the `exec` subcommand. Without it, docker parses kubectl's `-n` as a
    // docker flag and exits 125 ("unknown shorthand flag: 'n' in -n"). The
    // legacy-gateway runtime probe runs `docker ps --format {{.Names}}`
    // first, so check the subcommand position relative to `kubectl` rather
    // than at index 0, and check that the probe argv has the expected
    // unfiltered shape (no fragile `--filter name=^...$` regex anchors).
    const psIndex = log.indexOf("ps");
    expect(psIndex).toBe(0);
    expect(log[psIndex + 1]).toBe("--format");
    expect(log[psIndex + 2]).toBe("{{.Names}}");
    expect(log).not.toContain("--filter");
    const kubectlIndex = log.indexOf("kubectl");
    expect(kubectlIndex).toBeGreaterThan(psIndex);
    expect(log[kubectlIndex - 1]).toBe("openshell-cluster-nemoclaw");
    expect(log[kubectlIndex - 2]).toBe("exec");
    expect(log).toContain("patch");
    expect(log).toContain("--type=json");
    const patch = JSON.parse(log[log.indexOf("-p") + 1]);
    expect(patch[0]).toEqual({
      op: "test",
      path: "/metadata/resourceVersion",
      value: "123",
    });
    expect(patch[1]).toEqual({
      op: "replace",
      path: "/spec/podTemplate/spec/hostAliases",
      value: [
        { ip: "10.0.0.5", hostnames: ["old.local"] },
        { ip: "192.168.1.105", hostnames: ["searxng.local"] },
      ],
    });
  });

  it("lists host aliases from the sandbox resource", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-hosts-list-"));
    const localBin = path.join(home, "bin");
    const dockerLog = path.join(home, "docker.log");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home);
    fs.writeFileSync(
      path.join(localBin, "docker"),
      [
        "#!/usr/bin/env bash",
        `log_file=${JSON.stringify(dockerLog)}`,
        'printf "%s\\n" "$@" >> "$log_file"',
        'if [ "$1" = "ps" ]; then',
        '  printf "%s\\n" "openshell-cluster-nemoclaw"',
        "  exit 0",
        "fi",
        'printf "%s\\n" \'{"metadata":{"resourceVersion":"123"},"spec":{"podTemplate":{"spec":{"hostAliases":[{"ip":"192.168.1.105","hostnames":["searxng.local","search.lan"]}]}}}}\'',
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha hosts-list", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(r.out).toContain("Host aliases for 'alpha'");
    expect(r.out).toContain("192.168.1.105  searxng.local, search.lan");
    const log = fs.readFileSync(dockerLog, "utf8").trim().split(/\n/);
    const kubectlIndex = log.indexOf("kubectl");
    expect(kubectlIndex).toBeGreaterThan(1);
    expect(log[kubectlIndex - 1]).toBe("openshell-cluster-nemoclaw");
    expect(log[kubectlIndex - 2]).toBe("exec");
    expect(log).toContain("get");
  });

  it("removes host aliases with a sandbox json patch", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-hosts-remove-"));
    const localBin = path.join(home, "bin");
    const dockerLog = path.join(home, "docker.log");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home);
    writeHostAliasDockerStub(localBin, dockerLog, [
      { ip: "10.0.0.5", hostnames: ["searxng.local", "old.local"] },
      { ip: "192.168.1.10", hostnames: ["keep.local"] },
    ]);

    const r = runWithEnv("alpha hosts-remove searxng.local", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(r.out).toContain("Removed host alias searxng.local");
    const log = fs.readFileSync(dockerLog, "utf8").trim().split(/\n/);
    const kubectlIndex = log.indexOf("kubectl");
    expect(kubectlIndex).toBeGreaterThan(1);
    expect(log[kubectlIndex - 1]).toBe("openshell-cluster-nemoclaw");
    expect(log[kubectlIndex - 2]).toBe("exec");
    expect(log).toContain("patch");
    const patch = JSON.parse(log[log.lastIndexOf("-p") + 1]);
    expect(patch[0]).toEqual({
      op: "test",
      path: "/metadata/resourceVersion",
      value: "123",
    });
    expect(patch[1]).toEqual({
      op: "replace",
      path: "/spec/podTemplate/spec/hostAliases",
      value: [
        { ip: "10.0.0.5", hostnames: ["old.local"] },
        { ip: "192.168.1.10", hostnames: ["keep.local"] },
      ],
    });
  });

  it("rejects duplicate host aliases case-insensitively", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-hosts-duplicate-"));
    const localBin = path.join(home, "bin");
    const dockerLog = path.join(home, "docker.log");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home);
    writeHostAliasDockerStub(localBin, dockerLog, [
      { ip: "10.0.0.5", hostnames: ["SearXNG.local"] },
    ]);

    const r = runWithEnv("alpha hosts-add searxng.local 192.168.1.105", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(1);
    expect(r.out).toContain("Host alias 'searxng.local' already exists");
    const log = fs.readFileSync(dockerLog, "utf8").trim().split(/\n/);
    expect(log).not.toContain("patch");
  });

  it("previews host alias changes with dry-run without patching", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-hosts-dry-run-"));
    const localBin = path.join(home, "bin");
    const dockerLog = path.join(home, "docker.log");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home);
    writeHostAliasDockerStub(localBin, dockerLog, [
      { ip: "10.0.0.5", hostnames: ["searxng.local", "old.local"] },
    ]);

    const add = runWithEnv("alpha hosts-add dry.local 192.168.1.105 --dry-run", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });
    const remove = runWithEnv("alpha hosts-remove searxng.local --dry-run", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(add.code).toBe(0);
    expect(add.out).toContain('\"/metadata/resourceVersion\"');
    expect(add.out).toContain('\"/spec/podTemplate/spec/hostAliases\"');
    expect(add.out).toContain('\"dry.local\"');
    expect(add.out).toContain('\"192.168.1.105\"');
    expect(remove.code).toBe(0);
    expect(remove.out).toContain('\"/metadata/resourceVersion\"');
    expect(remove.out).toContain('\"/spec/podTemplate/spec/hostAliases\"');
    expect(remove.out).toContain('\"old.local\"');
    expect(remove.out).not.toContain('\"searxng.local\"');
    const log = fs.readFileSync(dockerLog, "utf8").trim().split(/\n/);
    expect(log).not.toContain("patch");
  });

  it("rejects unknown host alias flags without patching", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-hosts-unknown-flag-"));
    const localBin = path.join(home, "bin");
    const dockerLog = path.join(home, "docker.log");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home);
    writeHostAliasDockerStub(localBin, dockerLog, [
      { ip: "10.0.0.5", hostnames: ["searxng.local"] },
    ]);

    const add = runWithEnv("alpha hosts-add searxng.local 192.168.1.105 --dry-rnu", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });
    const remove = runWithEnv("alpha hosts-remove searxng.local --force", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(add.code).not.toBe(0);
    expect(add.out).toContain("Nonexistent flag: --dry-rnu");
    expect(remove.code).not.toBe(0);
    expect(remove.out).toContain("Nonexistent flag: --force");
    expect(fs.existsSync(dockerLog)).toBe(false);
  });

  it("retries host alias patches when the resource version changes", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-hosts-retry-"));
    const localBin = path.join(home, "bin");
    const dockerLog = path.join(home, "docker.log");
    const getCount = path.join(home, "get-count");
    const patchCount = path.join(home, "patch-count");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home);
    fs.writeFileSync(
      path.join(localBin, "docker"),
      [
        "#!/usr/bin/env bash",
        `log_file=${JSON.stringify(dockerLog)}`,
        `get_count=${JSON.stringify(getCount)}`,
        `patch_count=${JSON.stringify(patchCount)}`,
        'printf "%s\\n" "$@" >> "$log_file"',
        'if [ "$1" = "ps" ]; then',
        '  printf "%s\\n" "openshell-cluster-nemoclaw"',
        "  exit 0",
        "fi",
        'if printf "%s\\n" "$@" | grep -q "^get$"; then',
        '  count=$(cat "$get_count" 2>/dev/null || echo 0)',
        "  count=$((count + 1))",
        '  printf "%s" "$count" > "$get_count"',
        '  if [ "$count" = "1" ]; then version=123; else version=124; fi',
        '  printf \'{"metadata":{"resourceVersion":"%s"},"spec":{"podTemplate":{"spec":{"hostAliases":[{"ip":"10.0.0.5","hostnames":["old.local"]}]}}}}\\n\' "$version"',
        "  exit 0",
        "fi",
        'if printf "%s\\n" "$@" | grep -q "^patch$"; then',
        '  count=$(cat "$patch_count" 2>/dev/null || echo 0)',
        "  count=$((count + 1))",
        '  printf "%s" "$count" > "$patch_count"',
        '  if [ "$count" = "1" ]; then',
        '    echo "Operation cannot be fulfilled: the object has been modified" >&2',
        "    exit 1",
        "  fi",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha hosts-add retry.local 192.168.1.105", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(r.out).toContain("Added host alias retry.local -> 192.168.1.105");
    expect(fs.readFileSync(getCount, "utf8")).toBe("2");
    expect(fs.readFileSync(patchCount, "utf8")).toBe("2");
    const log = fs.readFileSync(dockerLog, "utf8").trim().split(/\n/);
    const patchArgs = log.filter((line) => line.startsWith("["));
    const finalPatch = patchArgs.at(-1);
    expect(finalPatch).toBeDefined();
    expect(JSON.parse(finalPatch!)[0]).toEqual({
      op: "test",
      path: "/metadata/resourceVersion",
      value: "124",
    });
  });

  for (const driver of ["docker", "vm"] as const) {
    it(`gates host alias commands on the ${driver} driver without targeting the legacy gateway container`, testTimeoutOptions(30_000), () => {
      const home = fs.mkdtempSync(
        path.join(os.tmpdir(), `nemoclaw-cli-hosts-${driver}-`),
      );
      const localBin = path.join(home, "bin");
      const dockerLog = path.join(home, "docker.log");
      fs.mkdirSync(localBin, { recursive: true });
      // Record any docker invocation so we can prove the gate fires before
      // the legacy `docker exec openshell-cluster-nemoclaw kubectl` path.
      writeHostAliasDockerStub(localBin, dockerLog, [
        { ip: "10.0.0.5", hostnames: ["old.local"] },
      ]);
      writeSandboxRegistry(home, "alpha", { openshellDriver: driver });

      const env = { HOME: home, PATH: `${localBin}:${process.env.PATH || ""}` };
      const list = runWithEnv("alpha hosts-list", env);
      const add = runWithEnv("alpha hosts-add searxng.local 192.168.1.105", env);
      const remove = runWithEnv("alpha hosts-remove searxng.local", env);

      for (const result of [list, add, remove]) {
        expect(result.code).toBe(1);
        expect(result.out).toContain(
          `Host aliases are not supported on the '${driver}' driver sandbox 'alpha'.`,
        );
      }

      // Even the dry-run preview must not reach the legacy resource read.
      const dryRun = runWithEnv(
        "alpha hosts-add searxng.local 192.168.1.105 --dry-run",
        env,
      );
      expect(dryRun.code).toBe(1);
      expect(dryRun.out).not.toContain("/spec/podTemplate/spec/hostAliases");

      // The gate runs before any docker exec, so the legacy gateway container
      // is never targeted.
      expect(fs.existsSync(dockerLog)).toBe(false);
    });
  }

  it(
    "fails host alias commands with an actionable error when the legacy gateway container is not running",
    testTimeoutOptions(30_000),
    () => {
      // A sandbox onboarded by an older NemoClaw release whose registry
      // entry predates the openshellDriver field, on a host where the
      // legacy `openshell-cluster-nemoclaw` k3s gateway is not running.
      // Without the runtime probe, `docker exec openshell-cluster-nemoclaw
      // kubectl ...` bubbles up an opaque `Error response from daemon: No
      // such container: openshell-cluster-nemoclaw` to the user.
      const home = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-cli-hosts-no-gateway-"),
      );
      const localBin = path.join(home, "bin");
      const dockerLog = path.join(home, "docker.log");
      fs.mkdirSync(localBin, { recursive: true });
      writeHostAliasDockerStub(
        localBin,
        dockerLog,
        [{ ip: "10.0.0.5", hostnames: ["old.local"] }],
        { gatewayRunning: false },
      );
      // Registry omits openshellDriver to mimic a pre-feature sandbox entry.
      writeSandboxRegistry(home);

      const env = { HOME: home, PATH: `${localBin}:${process.env.PATH || ""}` };
      const list = runWithEnv("alpha hosts-list", env);
      const add = runWithEnv("alpha hosts-add searxng.local 192.168.1.105", env);
      const remove = runWithEnv("alpha hosts-remove searxng.local", env);

      for (const result of [list, add, remove]) {
        expect(result.code).toBe(1);
        expect(result.out).toContain(
          "Host aliases require the legacy OpenShell gateway container 'openshell-cluster-nemoclaw' to be running.",
        );
        expect(result.out).not.toContain("Error response from daemon");
        expect(result.out).not.toContain("No such container");
      }

      const log = fs.readFileSync(dockerLog, "utf8").trim().split(/\n/);
      // Probe argv must be the unfiltered `docker ps --format {{.Names}}`
      // shape. No exec/get/patch reached the missing container.
      expect(log[0]).toBe("ps");
      expect(log[1]).toBe("--format");
      expect(log[2]).toBe("{{.Names}}");
      expect(log).not.toContain("--filter");
      expect(log).not.toContain("exec");
      expect(log).not.toContain("kubectl");
      expect(log).not.toContain("get");
      expect(log).not.toContain("patch");
    },
  );

  it(
    "validates host alias arguments before probing the legacy gateway",
    testTimeoutOptions(30_000),
    () => {
      // Arg validation (missing args, bad hostname, bad IP) must run before
      // the legacy-gateway probe, so a missing legacy gateway never masks
      // an invalid-input failure that would otherwise reach the user.
      const home = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-cli-hosts-validate-first-"),
      );
      const localBin = path.join(home, "bin");
      const dockerLog = path.join(home, "docker.log");
      fs.mkdirSync(localBin, { recursive: true });
      writeHostAliasDockerStub(localBin, dockerLog, [], { gatewayRunning: false });
      writeSandboxRegistry(home);

      const env = { HOME: home, PATH: `${localBin}:${process.env.PATH || ""}` };

      const badHostnameAdd = runWithEnv("alpha hosts-add invalid_name!! 1.2.3.4", env);
      expect(badHostnameAdd.code).toBe(1);
      expect(badHostnameAdd.out).toContain("Invalid hostname 'invalid_name!!'");
      expect(badHostnameAdd.out).not.toContain("Host aliases require the legacy");

      const badIpAdd = runWithEnv("alpha hosts-add searxng.local not-an-ip", env);
      expect(badIpAdd.code).toBe(1);
      expect(badIpAdd.out).toContain("Invalid IP address 'not-an-ip'");
      expect(badIpAdd.out).not.toContain("Host aliases require the legacy");

      const badHostnameRemove = runWithEnv("alpha hosts-remove invalid_name!!", env);
      expect(badHostnameRemove.code).toBe(1);
      expect(badHostnameRemove.out).toContain("Invalid hostname 'invalid_name!!'");
      expect(badHostnameRemove.out).not.toContain("Host aliases require the legacy");

      // No docker probe runs when validation fails up front.
      expect(fs.existsSync(dockerLog)).toBe(false);
    },
  );

  it(
    "classifies docker spawn ENOENT distinctly from a missing gateway",
    testTimeoutOptions(30_000),
    () => {
      // When the docker binary is absent from PATH, spawnSync returns
      // error.code === "ENOENT". The probe must surface a docker-could-
      // not-launch error rather than the legacy-gateway-missing error.
      const home = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-cli-hosts-docker-enoent-"),
      );
      const emptyBin = path.join(home, "nodocker");
      fs.mkdirSync(emptyBin, { recursive: true });
      // runWithEnv starts the CLI with process.execPath, so this PATH can stay
      // empty and make the CLI's `spawnSync("docker", ...)` return ENOENT.
      writeSandboxRegistry(home);

      const env = { HOME: home, PATH: emptyBin };
      const list = runWithEnv("alpha hosts-list", env);
      expect(list.code).toBe(1);
      expect(list.out).toContain(
        "Could not verify the legacy OpenShell gateway container 'openshell-cluster-nemoclaw'.",
      );
      expect(list.out).toContain("Docker probe failed:");
      expect(list.out).toContain("could not launch");
      expect(list.out).not.toContain(
        "Host aliases require the legacy OpenShell gateway container 'openshell-cluster-nemoclaw' to be running.",
      );
    },
  );

  it(
    "classifies docker probe timeouts distinctly from a missing gateway",
    testTimeoutOptions(60_000),
    () => {
      // When `docker ps` hangs past the probe timeout, spawnSync kills it
      // and reports ETIMEDOUT (or a terminating SIGTERM with no exit).
      // The probe must surface a docker-timed-out error rather than the
      // legacy-gateway-missing error.
      const home = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-cli-hosts-docker-timeout-"),
      );
      const localBin = path.join(home, "bin");
      const dockerLog = path.join(home, "docker.log");
      fs.mkdirSync(localBin, { recursive: true });
      fs.writeFileSync(
        path.join(localBin, "docker"),
        [
          "#!/usr/bin/env bash",
          `log_file=${JSON.stringify(dockerLog)}`,
          'printf "%s\\n" "$@" >> "$log_file"',
          'if [ "$1" = "ps" ]; then',
          "  sleep 20",
          "  exit 0",
          "fi",
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );
      writeSandboxRegistry(home);

      const env = { HOME: home, PATH: `${localBin}:${process.env.PATH || ""}` };
      const list = runWithEnv("alpha hosts-list", env, 45_000);
      expect(list.code).toBe(1);
      expect(list.out).toContain(
        "Could not verify the legacy OpenShell gateway container 'openshell-cluster-nemoclaw'.",
      );
      expect(list.out).toContain("Docker probe failed:");
      expect(list.out).not.toContain(
        "Host aliases require the legacy OpenShell gateway container 'openshell-cluster-nemoclaw' to be running.",
      );

      const log = fs.readFileSync(dockerLog, "utf8").trim().split(/\n/);
      expect(log[0]).toBe("ps");
      expect(log).not.toContain("exec");
      expect(log).not.toContain("kubectl");
    },
  );

  it(
    "classifies docker probe failures distinctly from a missing gateway",
    testTimeoutOptions(30_000),
    () => {
      // When `docker ps` itself fails (daemon down, permission denied,
      // timeout), the user must see a docker-probe-failed error rather than
      // the legacy-gateway-missing error.
      const home = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-cli-hosts-docker-down-"),
      );
      const localBin = path.join(home, "bin");
      const dockerLog = path.join(home, "docker.log");
      fs.mkdirSync(localBin, { recursive: true });
      fs.writeFileSync(
        path.join(localBin, "docker"),
        [
          "#!/usr/bin/env bash",
          `log_file=${JSON.stringify(dockerLog)}`,
          'printf "%s\\n" "$@" >> "$log_file"',
          'if [ "$1" = "ps" ]; then',
          '  printf "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\\n" >&2',
          "  exit 1",
          "fi",
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );
      writeSandboxRegistry(home);

      const env = { HOME: home, PATH: `${localBin}:${process.env.PATH || ""}` };
      const list = runWithEnv("alpha hosts-list", env);
      expect(list.code).toBe(1);
      expect(list.out).toContain(
        "Could not verify the legacy OpenShell gateway container 'openshell-cluster-nemoclaw'.",
      );
      expect(list.out).toContain("Docker probe failed:");
      expect(list.out).toContain("docker info");
      expect(list.out).not.toContain(
        "Host aliases require the legacy OpenShell gateway container 'openshell-cluster-nemoclaw' to be running.",
      );

      const log = fs.readFileSync(dockerLog, "utf8").trim().split(/\n/);
      expect(log[0]).toBe("ps");
      expect(log).not.toContain("exec");
      expect(log).not.toContain("kubectl");
    },
  );
});
