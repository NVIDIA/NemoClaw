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
}

function assertHostFixtureProbeSucceeded(result: ShellProbeResult, label: string): void {
  if (result.exitCode === 0) return;
  throw new Error(`${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

function runtimeInvocation(host: HostCliClient) {
  return new RuntimeProviderPrerequisite(host, (reason) => {
    throw new Error(reason);
  }).hostInvocation([]);
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
  };
  const runtime = runtimeInvocation(host);
  const result = await host.command(
    "bash",
    [
      "-lc",
      [
        "set -euo pipefail",
        'runtime_command=("$@")',
        `sandbox_name=${shellQuote(sandboxName)}`,
        `hostname=${shellQuote(hostname)}`,
        `host_backup=${shellQuote(fixture.hostBackupPath)}`,
        `sandbox_backup=${shellQuote(fixture.sandboxBackupPath)}`,
        'container_id="$("${runtime_command[@]}" container ps --filter "label=openshell.ai/sandbox-name=${sandbox_name}" --format \'{{.ID}}\' | head -n 1)"',
        '[ -n "$container_id" ] || { echo "OpenShell sandbox container not found" >&2; exit 1; }',
        "sudo -n true",
        'rm -f "$host_backup" "$sandbox_backup"',
        'sudo -n cat /etc/hosts > "$host_backup"',
        '"${runtime_command[@]}" container exec "$container_id" cat /etc/hosts > "$sandbox_backup"',
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
  sandboxName: string,
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
        `sandbox_name=${shellQuote(sandboxName)}`,
        `hostname=${shellQuote(fixture.hostname)}`,
        `expected_ip=${shellQuote(address)}`,
        `host_backup=${shellQuote(fixture.hostBackupPath)}`,
        `sandbox_backup=${shellQuote(fixture.sandboxBackupPath)}`,
        '[ -s "$host_backup" ] && [ -s "$sandbox_backup" ] || { echo "DNS rebinding hosts backups are missing" >&2; exit 1; }',
        'container_id="$("${runtime_command[@]}" container ps --filter "label=openshell.ai/sandbox-name=${sandbox_name}" --format \'{{.ID}}\' | head -n 1)"',
        '[ -n "$container_id" ] || { echo "OpenShell sandbox container not found" >&2; exit 1; }',
        'sudo -n tee /etc/hosts < "$host_backup" >/dev/null',
        'printf "\\n%s %s\\n" "$expected_ip" "$hostname" | sudo -n tee -a /etc/hosts >/dev/null',
        '"${runtime_command[@]}" container exec --user 0 --interactive "$container_id" sh -c \'cat > /etc/hosts\' < "$sandbox_backup"',
        'printf "\\n%s %s\\n" "$expected_ip" "$hostname" | "${runtime_command[@]}" container exec --user 0 --interactive "$container_id" tee -a /etc/hosts >/dev/null',
        `node -e ${shellQuote(resolverCheck)} "$hostname" "$expected_ip"`,
        '"${runtime_command[@]}" container exec "$container_id" grep -F "$expected_ip $hostname" /etc/hosts >/dev/null',
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
  sandboxName: string,
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
        `sandbox_name=${shellQuote(sandboxName)}`,
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
        '    container_id="$("${runtime_command[@]}" container ps --filter "label=openshell.ai/sandbox-name=${sandbox_name}" --format \'{{.ID}}\' 2>/dev/null | head -n 1 || true)"',
        '    if [ -n "$container_id" ] && "${runtime_command[@]}" container exec --user 0 --interactive "$container_id" sh -c \'cat > /etc/hosts\' < "$sandbox_backup"; then sandbox_restored=1; break; fi',
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
