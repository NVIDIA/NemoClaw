// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";
import path from "node:path";

import { shellQuote } from "../../../src/lib/core/shell-quote";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { RuntimeProviderPrerequisite } from "../fixtures/runtime-provider.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

export interface DnsRebindingHostsFixture {
  hostname: string;
  hostBackupPath: string;
  sandboxBackupPath: string;
  containerId: string;
  containerHostsPath: string;
}

function assertHostFixtureProbeSucceeded(result: ShellProbeResult, label: string): void {
  if (result.exitCode === 0) return;
  throw new Error(`${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

function runtimeInvocation(host: HostCliClient) {
  return new RuntimeProviderPrerequisite(host).hostInvocation([]);
}

async function resolveResolverHosts(host: HostCliClient, sandboxName: string) {
  const runtime = new RuntimeProviderPrerequisite(host);
  const inspect = async (id: string) => {
    if (!/^[a-f0-9]{64}$/u.test(id)) throw new Error("DNS fixture requires one full container ID");
    const result = await runtime.command(
      [
        "container",
        "inspect",
        "--format",
        '{"id":{{json .Id}},"name":{{json (index .Config.Labels "openshell.ai/sandbox-name")}},"role":{{json (index .Config.Labels "openshell.ai/isolation-role")}},"sandboxId":{{json (index .Config.Labels "openshell.ai/sandbox-id")}},"namespace":{{json (index .Config.Labels "openshell.ai/sandbox-namespace")}},"running":{{json .State.Running}},"hostsPath":{{json .HostsPath}}}',
        id,
      ],
      { artifactName: "dns-rebinding-resolver-identity", timeoutMs: 30_000 },
    );
    assertHostFixtureProbeSucceeded(result, "inspect DNS resolver container");
    const record = JSON.parse(result.stdout) as Record<string, unknown>;
    if (record.id !== id || record.name !== sandboxName || record.running !== true) {
      throw new Error("DNS resolver container identity or running state changed");
    }
    return record;
  };
  let id = await runtime.resolveSandboxResourceHandle(sandboxName, {
    artifactName: "dns-rebinding-workload-resource",
    timeoutMs: 30_000,
  });
  let record = await inspect(id);
  if (record.role === "sandbox") {
    const { sandboxId, namespace } = record;
    if (
      typeof sandboxId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,128}$/u.test(sandboxId) ||
      typeof namespace !== "string" ||
      !/^[a-zA-Z0-9_-]{1,128}$/u.test(namespace)
    ) {
      throw new Error("DNS fixture requires the workload's sandbox identity");
    }
    const supervisor = await runtime.command(
      [
        "container",
        "ps",
        "--no-trunc",
        "--filter",
        `label=openshell.ai/sandbox-id=${sandboxId}`,
        "--filter",
        `label=openshell.ai/sandbox-namespace=${namespace}`,
        "--filter",
        "label=openshell.ai/isolation-role=supervisor",
        "--format",
        "{{.ID}}",
      ],
      { artifactName: "dns-rebinding-supervisor-resource", timeoutMs: 30_000 },
    );
    assertHostFixtureProbeSucceeded(supervisor, "discover DNS supervisor");
    id = supervisor.stdout.trim();
    record = await inspect(id);
    if (
      record.role !== "supervisor" ||
      record.sandboxId !== sandboxId ||
      record.namespace !== namespace
    ) {
      throw new Error("DNS supervisor does not belong to the selected workload");
    }
  } else if (record.role !== null && record.role !== "") {
    throw new Error("DNS fixture found an unsupported isolation role");
  }
  const hostsPath = record.hostsPath;
  if (
    typeof hostsPath !== "string" ||
    !path.isAbsolute(hostsPath) ||
    path.normalize(hostsPath) !== hostsPath ||
    !hostsPath.includes(`/${id}/`) ||
    path.basename(hostsPath) !== "hosts" ||
    /[\u0000-\u001f\u007f]/u.test(hostsPath)
  ) {
    throw new Error("DNS fixture requires the engine-owned container hosts file");
  }
  return { containerId: id, containerHostsPath: hostsPath };
}

function resolverHostsGuard(fixture: DnsRebindingHostsFixture): string[] {
  // Docker mounts a read-only supervisor's hosts file read-only too. Modify its
  // engine-owned host file in place; never remount or relax the container.
  // Pin the ID and path across backup, remapping and restoration. A replacement
  // container must not receive an earlier container's hosts backup.
  return [
    `container_id=${shellQuote(fixture.containerId)}`,
    `container_hosts=${shellQuote(fixture.containerHostsPath)}`,
    "verify_resolver_hosts() {",
    '  [ "$("${runtime_command[@]}" container inspect --format \'{{.HostsPath}}\' "$container_id")" = "$container_hosts" ] &&',
    '  sudo -n test -f "$container_hosts" && sudo -n test ! -L "$container_hosts"',
    "}",
  ];
}

export async function setupDnsRebindingHostsFixture(
  host: HostCliClient,
  sandboxName: string,
  hostname: string,
): Promise<DnsRebindingHostsFixture> {
  const tempDir = process.env.RUNNER_TEMP ?? os.tmpdir();
  const suffix = `${process.pid}-${sandboxName}`;
  const fixture = {
    hostname,
    hostBackupPath: path.join(tempDir, `nemoclaw-rebind-hosts-host-${suffix}`),
    sandboxBackupPath: path.join(tempDir, `nemoclaw-rebind-hosts-sandbox-${suffix}`),
    ...(await resolveResolverHosts(host, sandboxName)),
  };
  const runtime = runtimeInvocation(host);
  const result = await host.command(
    "bash",
    [
      "-lc",
      [
        "set -euo pipefail",
        'runtime_command=("$@")',
        ...resolverHostsGuard(fixture),
        `hostname=${shellQuote(hostname)}`,
        `host_backup=${shellQuote(fixture.hostBackupPath)}`,
        `sandbox_backup=${shellQuote(fixture.sandboxBackupPath)}`,
        'verify_resolver_hosts || { echo "DNS resolver hosts identity changed" >&2; exit 1; }',
        "sudo -n true",
        'rm -f "$host_backup" "$sandbox_backup"',
        'sudo -n cat /etc/hosts > "$host_backup"',
        'sudo -n cat "$container_hosts" > "$sandbox_backup"',
        'if grep -Fq "$hostname" "$host_backup" || grep -Fq "$hostname" "$sandbox_backup"; then rm -f "$host_backup" "$sandbox_backup"; echo "DNS rebinding fixture hostname already exists in /etc/hosts" >&2; exit 1; fi',
      ].join("\n"),
      "dns-rebinding-backup-hosts",
      runtime.command,
      ...runtime.args,
    ],
    {
      artifactName: "dns-rebinding-backup-hosts",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 60_000,
    },
  );
  assertHostFixtureProbeSucceeded(
    result,
    "back up host and sandbox hosts files for DNS rebinding proof",
  );
  return fixture;
}

export async function remapDnsRebindingHostname(
  host: HostCliClient,
  _sandboxName: string,
  fixture: DnsRebindingHostsFixture,
  address: string,
  artifactName: string,
): Promise<void> {
  const resolverCheck = [
    'const dns = require("node:dns");',
    "const [hostname, expected] = process.argv.slice(1);",
    "dns.lookup(hostname, { all: true, verbatim: true }, (error, results) => {",
    "  if (error) throw error;",
    "  const addresses = [...new Set(results.map((result) => result.address))];",
    "  console.log(JSON.stringify({ hostname, addresses }));",
    "  process.exit(addresses.length === 1 && addresses[0] === expected ? 0 : 1);",
    "});",
  ].join(" ");
  const runtime = runtimeInvocation(host);
  const result = await host.command(
    "bash",
    [
      "-lc",
      [
        "set -euo pipefail",
        'runtime_command=("$@")',
        ...resolverHostsGuard(fixture),
        `hostname=${shellQuote(fixture.hostname)}`,
        `expected_ip=${shellQuote(address)}`,
        `host_backup=${shellQuote(fixture.hostBackupPath)}`,
        `sandbox_backup=${shellQuote(fixture.sandboxBackupPath)}`,
        '[ -s "$host_backup" ] && [ -s "$sandbox_backup" ] || { echo "DNS rebinding hosts backups are missing" >&2; exit 1; }',
        'verify_resolver_hosts || { echo "DNS resolver hosts identity changed" >&2; exit 1; }',
        'sudo -n tee /etc/hosts < "$host_backup" >/dev/null',
        'printf "\\n%s %s\\n" "$expected_ip" "$hostname" | sudo -n tee -a /etc/hosts >/dev/null',
        'sudo -n tee "$container_hosts" < "$sandbox_backup" >/dev/null',
        'printf "\\n%s %s\\n" "$expected_ip" "$hostname" | sudo -n tee -a "$container_hosts" >/dev/null',
        `node -e ${shellQuote(resolverCheck)} "$hostname" "$expected_ip"`,
        'sudo -n grep -F "$expected_ip $hostname" "$container_hosts" >/dev/null',
      ].join("\n"),
      "dns-rebinding-remap-hosts",
      runtime.command,
      ...runtime.args,
    ],
    {
      artifactName,
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 60_000,
    },
  );
  assertHostFixtureProbeSucceeded(result, `map DNS rebinding fixture hostname to ${address}`);
}

export async function restoreDnsRebindingHostsFixture(
  host: HostCliClient,
  _sandboxName: string,
  fixture: DnsRebindingHostsFixture,
): Promise<void> {
  const runtime = runtimeInvocation(host);
  const result = await host.command(
    "bash",
    [
      "-lc",
      [
        // Cleanup must report the exact failed operation. An implicit `errexit`
        // here can turn a transient file/container race into an unexplained
        // exit 1 with empty stdout/stderr, which defeats the cleanup artifact.
        "set -uo pipefail",
        'runtime_command=("$@")',
        ...resolverHostsGuard(fixture),
        `host_backup=${shellQuote(fixture.hostBackupPath)}`,
        `sandbox_backup=${shellQuote(fixture.sandboxBackupPath)}`,
        'if [ ! -f "$host_backup" ] && [ ! -f "$sandbox_backup" ]; then echo "DNS rebinding hosts backups already absent"; exit 0; fi',
        "host_restore_failed=0",
        'if [ -f "$host_backup" ]; then',
        '  if ! sudo -n tee /etc/hosts < "$host_backup" >/dev/null; then',
        '    echo "failed to restore host /etc/hosts" >&2; host_restore_failed=1',
        '  elif ! cmp -s "$host_backup" /etc/hosts; then',
        '    echo "host /etc/hosts differs after restoration" >&2; host_restore_failed=1',
        "  else",
        '    echo "restored host /etc/hosts"',
        "  fi",
        "else",
        '  echo "host /etc/hosts backup is missing while sandbox backup remains" >&2; host_restore_failed=1',
        "fi",
        'if [ -f "$sandbox_backup" ]; then',
        "  sandbox_restored=0",
        "  for attempt in 1 2 3; do",
        '    if verify_resolver_hosts && sudo -n tee "$container_hosts" < "$sandbox_backup" >/dev/null && sudo -n cmp -s "$sandbox_backup" "$container_hosts"; then sandbox_restored=1; break; fi',
        '    [ "$attempt" -eq 3 ] || sleep 1',
        "  done",
        '  if [ "$sandbox_restored" -eq 1 ]; then echo "restored sandbox /etc/hosts"; else echo "::warning::could not restore ephemeral sandbox /etc/hosts; cleanup will destroy the sandbox" >&2; fi',
        "fi",
        'if [ "$host_restore_failed" -ne 0 ]; then exit 1; fi',
        'if ! rm -f "$host_backup" "$sandbox_backup"; then echo "failed to remove DNS rebinding hosts backups" >&2; exit 1; fi',
        'echo "removed DNS rebinding hosts backups"',
        "exit 0",
      ].join("\n"),
      "dns-rebinding-restore-hosts",
      runtime.command,
      ...runtime.args,
    ],
    {
      artifactName: "dns-rebinding-restore-hosts",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 60_000,
    },
  );
  assertHostFixtureProbeSucceeded(
    result,
    "restore host and sandbox hosts files after DNS rebinding proof",
  );
}
