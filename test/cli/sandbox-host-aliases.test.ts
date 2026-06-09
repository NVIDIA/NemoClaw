// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  runWithEnv,
  testTimeoutOptions,
  writeHostAliasDockerStub,
  writeSandboxRegistry,
} from "./helpers";

function makeCliFixture(prefix: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const localBin = path.join(home, "bin");
  const dockerLog = path.join(home, "docker.log");
  fs.mkdirSync(localBin, { recursive: true });
  writeSandboxRegistry(home);
  return {
    dockerLog,
    home,
    localBin,
    env: { HOME: home, PATH: `${localBin}:${process.env.PATH || ""}` },
  };
}

function writeDockerStub(localBin: string, lines: string[]): void {
  fs.writeFileSync(path.join(localBin, "docker"), lines.join("\n"), { mode: 0o755 });
}

function expectDockerProbeFailure(out: string): void {
  expect(out).toContain(
    "Could not verify the legacy OpenShell gateway container 'openshell-cluster-nemoclaw'.",
  );
  expect(out).toContain("Docker probe failed:");
  expect(out).not.toContain(
    "Host aliases require the legacy OpenShell gateway container 'openshell-cluster-nemoclaw' to be running.",
  );
}

function expectNoLegacyGatewayExec(log: string[]): void {
  expect(log[0]).toBe("ps");
  expect(log).not.toContain("exec");
  expect(log).not.toContain("kubectl");
  expect(log).not.toContain("patch");
}

describe("CLI dispatch", () => {
  it("adds host aliases with a sandbox json patch", () => {
    const { dockerLog, env, localBin } = makeCliFixture("nemoclaw-cli-hosts-add-");
    writeDockerStub(localBin, [
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
    ]);

    const r = runWithEnv("alpha hosts-add searxng.local 192.168.1.105", env);

    expect(r.code).toBe(0);
    expect(r.out).toContain("Added host alias searxng.local -> 192.168.1.105");
    const log = fs.readFileSync(dockerLog, "utf8").trim().split(/\n/);
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
    const { dockerLog, env, localBin } = makeCliFixture("nemoclaw-cli-hosts-list-");
    writeDockerStub(localBin, [
      "#!/usr/bin/env bash",
      `log_file=${JSON.stringify(dockerLog)}`,
      'printf "%s\\n" "$@" >> "$log_file"',
      'if [ "$1" = "ps" ]; then',
      '  printf "%s\\n" "openshell-cluster-nemoclaw"',
      "  exit 0",
      "fi",
      'printf "%s\\n" \'{"metadata":{"resourceVersion":"123"},"spec":{"podTemplate":{"spec":{"hostAliases":[{"ip":"192.168.1.105","hostnames":["searxng.local","search.lan"]}]}}}}\'',
    ]);

    const r = runWithEnv("alpha hosts-list", env);

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
    const { dockerLog, env, localBin } = makeCliFixture("nemoclaw-cli-hosts-remove-");
    writeHostAliasDockerStub(localBin, dockerLog, [
      { ip: "10.0.0.5", hostnames: ["searxng.local", "old.local"] },
      { ip: "192.168.1.10", hostnames: ["keep.local"] },
    ]);

    const r = runWithEnv("alpha hosts-remove searxng.local", env);

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
    const { dockerLog, env, localBin } = makeCliFixture("nemoclaw-cli-hosts-duplicate-");
    writeHostAliasDockerStub(localBin, dockerLog, [
      { ip: "10.0.0.5", hostnames: ["SearXNG.local"] },
    ]);

    const r = runWithEnv("alpha hosts-add searxng.local 192.168.1.105", env);

    expect(r.code).toBe(1);
    expect(r.out).toContain("Host alias 'searxng.local' already exists");
    const log = fs.readFileSync(dockerLog, "utf8").trim().split(/\n/);
    expect(log).not.toContain("patch");
  });

  it("previews host alias changes with dry-run without patching", () => {
    const { dockerLog, env, localBin } = makeCliFixture("nemoclaw-cli-hosts-dry-run-");
    writeHostAliasDockerStub(localBin, dockerLog, [
      { ip: "10.0.0.5", hostnames: ["searxng.local", "old.local"] },
    ]);

    const add = runWithEnv("alpha hosts-add dry.local 192.168.1.105 --dry-run", env);
    const remove = runWithEnv("alpha hosts-remove searxng.local --dry-run", env);

    expect(add.code).toBe(0);
    expect(add.out).toContain('"/metadata/resourceVersion"');
    expect(add.out).toContain('"/spec/podTemplate/spec/hostAliases"');
    expect(add.out).toContain('"dry.local"');
    expect(add.out).toContain('"192.168.1.105"');
    expect(remove.code).toBe(0);
    expect(remove.out).toContain('"/metadata/resourceVersion"');
    expect(remove.out).toContain('"/spec/podTemplate/spec/hostAliases"');
    expect(remove.out).toContain('"old.local"');
    expect(remove.out).not.toContain('"searxng.local"');
    const log = fs.readFileSync(dockerLog, "utf8").trim().split(/\n/);
    expect(log).not.toContain("patch");
  });

  it("rejects unknown host alias flags without patching", () => {
    const { dockerLog, env, localBin } = makeCliFixture("nemoclaw-cli-hosts-unknown-flag-");
    writeHostAliasDockerStub(localBin, dockerLog, [
      { ip: "10.0.0.5", hostnames: ["searxng.local"] },
    ]);

    const add = runWithEnv("alpha hosts-add searxng.local 192.168.1.105 --dry-rnu", env);
    const remove = runWithEnv("alpha hosts-remove searxng.local --force", env);

    expect(add.code).not.toBe(0);
    expect(add.out).toContain("Nonexistent flag: --dry-rnu");
    expect(remove.code).not.toBe(0);
    expect(remove.out).toContain("Nonexistent flag: --force");
    expect(fs.existsSync(dockerLog)).toBe(false);
  });

  it("retries host alias patches when the resource version changes", () => {
    const { dockerLog, env, home, localBin } = makeCliFixture("nemoclaw-cli-hosts-retry-");
    const getCount = path.join(home, "get-count");
    const patchCount = path.join(home, "patch-count");
    writeDockerStub(localBin, [
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
    ]);

    const r = runWithEnv("alpha hosts-add retry.local 192.168.1.105", env);

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

  it("classifies docker spawn ENOENT distinctly from a missing gateway", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-hosts-docker-enoent-"));
    const emptyBin = path.join(home, "nodocker");
    fs.mkdirSync(emptyBin, { recursive: true });
    writeSandboxRegistry(home);

    const list = runWithEnv("alpha hosts-list", { HOME: home, PATH: emptyBin });

    expect(list.code).toBe(1);
    expectDockerProbeFailure(list.out);
    expect(list.out).toContain("could not launch");
  });

  it(
    "classifies docker probe timeouts distinctly from a missing gateway",
    testTimeoutOptions(60_000),
    () => {
      const { dockerLog, env, localBin } = makeCliFixture("nemoclaw-cli-hosts-docker-timeout-");
      writeDockerStub(localBin, [
        "#!/usr/bin/env bash",
        `log_file=${JSON.stringify(dockerLog)}`,
        'printf "%s\\n" "$@" >> "$log_file"',
        'if [ "$1" = "ps" ]; then',
        "  sleep 20",
        "  exit 0",
        "fi",
        "exit 0",
      ]);

      const list = runWithEnv("alpha hosts-list", env, 45_000);

      expect(list.code).toBe(1);
      expectDockerProbeFailure(list.out);
      const log = fs.readFileSync(dockerLog, "utf8").trim().split(/\n/);
      expectNoLegacyGatewayExec(log);
    },
  );

  it("classifies docker probe failures distinctly from a missing gateway", () => {
    const { dockerLog, env, localBin } = makeCliFixture("nemoclaw-cli-hosts-docker-down-");
    writeDockerStub(localBin, [
      "#!/usr/bin/env bash",
      `log_file=${JSON.stringify(dockerLog)}`,
      'printf "%s\\n" "$@" >> "$log_file"',
      'if [ "$1" = "ps" ]; then',
      '  printf "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\\n" >&2',
      "  exit 1",
      "fi",
      "exit 0",
    ]);

    const list = runWithEnv("alpha hosts-list", env);

    expect(list.code).toBe(1);
    expectDockerProbeFailure(list.out);
    expect(list.out).toContain("docker info");
    const log = fs.readFileSync(dockerLog, "utf8").trim().split(/\n/);
    expectNoLegacyGatewayExec(log);
  });
});
