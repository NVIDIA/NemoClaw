// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { startRebindingDnsServer } from "../fixtures/dns-rebinding-server.ts";
import path from "node:path";

import { shellQuote } from "../../../src/lib/core/shell-quote";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { assertExitZero } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { RuntimeProviderPrerequisite } from "../fixtures/runtime-provider.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

export interface DnsRebindingHostsFixture {
  hostname: string;
  hostBackupPath: string;
  backupReady: boolean;
  removeBackup: () => void;
  containerId: string;
  pid: number;
  cgroup: string;
  upstream: string;
  comment: string;
  server: Awaited<ReturnType<typeof startRebindingDnsServer>>;
  restored: boolean;
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
        '{"id":{{json .Id}},"name":{{json (index .Config.Labels "openshell.ai/sandbox-name")}},"role":{{json (index .Config.Labels "openshell.ai/isolation-role")}},"sandboxId":{{json (index .Config.Labels "openshell.ai/sandbox-id")}},"namespace":{{json (index .Config.Labels "openshell.ai/sandbox-namespace")}},"running":{{json .State.Running}},"pid":{{json .State.Pid}},"resolvPath":{{json .ResolvConfPath}},"networkMode":{{json .HostConfig.NetworkMode}}}',
        id,
      ],
      { artifactName: "dns-rebinding-resolver-identity", timeoutMs: 30_000 },
    );
    assertExitZero(result, "inspect DNS resolver container");
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
  const { sandboxId, namespace } = record;
  if (
    record.role !== "sandbox" ||
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
  assertExitZero(supervisor, "discover DNS supervisor");
  id = supervisor.stdout.trim();
  record = await inspect(id);
  if (
    record.role !== "supervisor" ||
    record.sandboxId !== sandboxId ||
    record.namespace !== namespace ||
    record.networkMode !== "host"
  ) {
    throw new Error("DNS fixture requires the selected workload's host-network supervisor");
  }
  const { pid, resolvPath } = record;
  if (
    !Number.isSafeInteger(pid) ||
    Number(pid) <= 1 ||
    typeof resolvPath !== "string" ||
    !path.isAbsolute(resolvPath) ||
    path.normalize(resolvPath) !== resolvPath ||
    !resolvPath.includes(`/${id}/`) ||
    path.basename(resolvPath) !== "resolv.conf"
  ) {
    throw new Error("DNS fixture requires the resolver process and engine-owned resolver file");
  }
  const probe = await host.command(
    "sudo",
    [
      "-n",
      "python3",
      "-I",
      "-c",
      `
import ipaddress, json, pathlib, sys
pid, container, resolver = sys.argv[1:]
start = pathlib.Path('/proc/' + pid + '/stat').read_text().rsplit(')', 1)[1].split()[19]
rows = pathlib.Path('/proc/' + pid + '/cgroup').read_text().splitlines()
assert len(rows) == 1 and rows[0].startswith('0::/')
cgroup = rows[0][4:]
parts = cgroup.split('/')
assert cgroup and all(part not in ('', '.', '..') for part in parts)
assert any(part == container or part.endswith('-' + container + '.scope') for part in parts)
assert not pathlib.Path(resolver).is_symlink()
upstream = None
for line in pathlib.Path(resolver).read_text().splitlines():
    fields = line.split('#', 1)[0].split()
    if len(fields) < 2 or fields[0] != 'nameserver' or '%' in fields[1]: continue
    try: upstream = str(ipaddress.ip_address(fields[1])); break
    except ValueError: pass
assert upstream is not None
assert pathlib.Path('/proc/' + pid + '/stat').read_text().rsplit(')', 1)[1].split()[19] == start
print(json.dumps({'cgroup': cgroup, 'upstream': upstream}))
`,
      String(pid),
      id,
      resolvPath,
    ],
    { artifactName: "dns-rebinding-resolver-cgroup", timeoutMs: 30_000 },
  );
  assertExitZero(probe, "bind DNS fixture to the supervisor process cgroup");
  const { cgroup, upstream } = JSON.parse(probe.stdout) as { cgroup: string; upstream: string };
  const current = await inspect(id);
  if (current.pid !== pid || current.resolvPath !== resolvPath)
    throw new Error("DNS supervisor changed during setup");
  return { containerId: id, pid: Number(pid), cgroup, upstream };
}

function dnsRule(fixture: DnsRebindingHostsFixture, protocol: string): string[] {
  return [
    "-p",
    protocol,
    "-d",
    fixture.upstream,
    "--dport",
    "53",
    "-m",
    "cgroup",
    "--path",
    fixture.cgroup,
    "-m",
    "comment",
    "--comment",
    fixture.comment,
    "-j",
    "REDIRECT",
    "--to-ports",
    String(fixture.server.port),
  ];
}

async function firewall(
  host: HostCliClient,
  fixture: DnsRebindingHostsFixture,
  action: string,
  protocol: string,
) {
  return host.command(
    "sudo",
    [
      "-n",
      fixture.server.family === 4 ? "iptables" : "ip6tables",
      "-w",
      "5",
      "-t",
      "nat",
      action,
      "OUTPUT",
      ...dnsRule(fixture, protocol),
    ],
    { artifactName: `dns-rebinding-rule-${action}-${protocol}`, timeoutMs: 30_000 },
  );
}

export async function setupDnsRebindingHostsFixture(
  host: HostCliClient,
  sandboxName: string,
  hostname: string,
): Promise<DnsRebindingHostsFixture> {
  const identity = await resolveResolverHosts(host, sandboxName);
  const comment = `nemoclaw-dns-${randomUUID()}`;
  const directory = fs.mkdtempSync(
    path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), "nemoclaw-dns-"),
  );
  let fixture: DnsRebindingHostsFixture | undefined;
  try {
    fixture = {
      hostname,
      hostBackupPath: path.join(directory, "hosts"),
      backupReady: false,
      ...identity,
      server: await startRebindingDnsServer(hostname, identity.upstream),
      comment,
      restored: false,
      removeBackup: () => fs.rmSync(directory, { recursive: true, force: true }),
    };
    const backup = await host.command(
      "bash",
      [
        "-lc",
        [
          "set -euo pipefail",
          "umask 077",
          "set -C",
          `sudo -n cat /etc/hosts > ${shellQuote(fixture.hostBackupPath)}`,
          `if grep -Fq ${shellQuote(hostname)} ${shellQuote(fixture.hostBackupPath)}; then echo 'DNS fixture hostname already exists' >&2; exit 1; fi`,
        ].join("\n"),
      ],
      { artifactName: "dns-rebinding-backup-hosts", timeoutMs: 30_000 },
    );
    assertExitZero(backup, "back up host DNS mapping");
    fixture.backupReady = true;
    for (const protocol of ["udp", "tcp"]) {
      assertExitZero(
        await firewall(host, fixture, "-A", protocol),
        "redirect selected supervisor DNS",
      );
    }
    return fixture;
  } catch (error) {
    if (fixture) await restoreDnsRebindingHostsFixture(host, sandboxName, fixture);
    else fs.rmdirSync(directory);
    throw error;
  }
}

export async function remapDnsRebindingHostname(
  host: HostCliClient,
  sandboxName: string,
  fixture: DnsRebindingHostsFixture,
  address: string,
  artifactName: string,
): Promise<void> {
  const current = await resolveResolverHosts(host, sandboxName);
  if (
    fixture.restored ||
    Object.entries(current).some(([key, value]) => fixture[key as keyof typeof current] !== value)
  ) {
    throw new Error("DNS supervisor identity changed before remapping");
  }
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
  fixture.server.setAddress(address);
  const result = await host.command(
    "bash",
    [
      "-lc",
      [
        "set -euo pipefail",
        `hostname=${shellQuote(fixture.hostname)}`,
        `expected_ip=${shellQuote(address)}`,
        `host_backup=${shellQuote(fixture.hostBackupPath)}`,
        '[ -s "$host_backup" ] || { echo "DNS rebinding host backup is missing" >&2; exit 1; }',
        'sudo -n tee /etc/hosts < "$host_backup" >/dev/null',
        'printf "\\n%s %s\\n" "$expected_ip" "$hostname" | sudo -n tee -a /etc/hosts >/dev/null',
        `node -e ${shellQuote(resolverCheck)} "$hostname" "$expected_ip"`,
      ].join("\n"),
      "dns-rebinding-remap-hosts",
    ],
    {
      artifactName,
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 60_000,
    },
  );
  assertExitZero(result, `map DNS rebinding fixture hostname to ${address}`);
}

export async function restoreDnsRebindingHostsFixture(
  host: HostCliClient,
  _sandboxName: string,
  fixture: DnsRebindingHostsFixture,
): Promise<void> {
  if (fixture.restored) return;
  const failures: string[] = [];
  const observe = async (result: Promise<ShellProbeResult>, label: string) => {
    try {
      return await result;
    } catch {
      failures.push(label);
      return null;
    }
  };
  for (const protocol of ["udp", "tcp"]) {
    const present = await observe(
      firewall(host, fixture, "-C", protocol),
      `inspect ${protocol} DNS rule`,
    );
    if (present?.exitCode === 0) {
      const removed = await observe(
        firewall(host, fixture, "-D", protocol),
        `remove ${protocol} DNS rule`,
      );
      if (removed?.exitCode !== 0) failures.push(`remove ${protocol} DNS rule`);
    }
  }
  const remaining = await observe(
    host.command(
      "sudo",
      [
        "-n",
        fixture.server.family === 4 ? "iptables" : "ip6tables",
        "-w",
        "5",
        "-t",
        "nat",
        "-S",
        "OUTPUT",
      ],
      { artifactName: "dns-rebinding-rules-absent", timeoutMs: 30_000 },
    ),
    "prove owned DNS rules absent",
  );
  if (remaining?.exitCode !== 0 || remaining.stdout.includes(fixture.comment))
    failures.push("prove owned DNS rules absent");
  const result = fixture.backupReady
    ? await observe(
        host.command(
          "bash",
          [
            "-lc",
            [
              "set -euo pipefail",
              `backup=${shellQuote(fixture.hostBackupPath)}`,
              '[ -s "$backup" ] || { echo "DNS host backup is missing" >&2; exit 1; }',
              '  sudo -n tee /etc/hosts < "$backup" >/dev/null',
              '  cmp -s "$backup" /etc/hosts',
              '  rm -- "$backup"',
            ].join("\n"),
          ],
          { artifactName: "dns-rebinding-restore-hosts", timeoutMs: 30_000 },
        ),
        "restore host DNS mapping",
      )
    : { exitCode: 0 };
  if (result?.exitCode !== 0) failures.push("restore host DNS mapping");
  try {
    await fixture.server.close();
  } catch {
    failures.push("close DNS forwarder");
  }
  if (result?.exitCode === 0) {
    fixture.backupReady = false;
    fixture.removeBackup();
  }
  fixture.restored = failures.length === 0;
  if (failures.length) throw new Error(`DNS fixture cleanup failed: ${failures.join(", ")}`);
}
