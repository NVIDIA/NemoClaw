// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { testTimeoutOptions } from "../../helpers/timeouts.ts";
import type { ArtifactSink } from "../fixtures/artifacts.ts";
import { resultText } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import {
  measureTree,
  requireEnvironment,
  type TreeMeasurement,
  treeDirectories,
} from "./state-dir-guard-metadata-helpers.ts";

const GUARD_PATH = "/usr/local/lib/nemoclaw/state-dir-guard.py";
const ACL_EXTRA_UID = 65_534;
const MARKER_XATTR = "user.nemoclaw_e2e_marker";
const TEST_TIMEOUT_MS = 10 * 60_000;
const COMMAND_TIMEOUT_MS = 2 * 60_000;

const AGENTS = [
  {
    id: "openclaw",
    image: process.env.NEMOCLAW_OPENCLAW_TEST_IMAGE ?? "nemoclaw-production",
    configDir: "/sandbox/.openclaw",
  },
  {
    id: "hermes",
    image: process.env.NEMOCLAW_HERMES_TEST_IMAGE ?? "nemoclaw-hermes-production",
    configDir: "/sandbox/.hermes",
  },
] as const;

type AgentCase = (typeof AGENTS)[number];
type GuardAction = "preflight" | "lock" | "unlock";
type GuardTargets = Record<"plugins" | "credentials", string>;
type AccessResult = { read: boolean; write: boolean };

interface GuardLimits {
  maxEntries: number;
  maxLogicalBytes: number;
  maxAllocatedBytes: number;
  maxCopiedBytes: number;
  maxDepth: number;
  maxSeconds: number;
}

interface GuardSummary {
  type: "result";
  action: GuardAction;
  status: "ok" | "failed";
  roots: number;
  directories: number;
  files: number;
  issueCount: number;
}

interface FileMetadata {
  inode: number;
  uid: number;
  gid: number;
  mode: string;
  sha256: string;
  marker: string;
  acl: {
    rawNamedUser: string;
    effectiveNamedUser: string;
    mask: string;
  };
}

async function command(
  host: HostCliClient,
  executable: string,
  args: string[],
  artifactName: string,
  timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<ShellProbeResult> {
  return host.command(executable, args, { artifactName, timeoutMs });
}

async function expectCommand(
  host: HostCliClient,
  executable: string,
  args: string[],
  artifactName: string,
  timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<ShellProbeResult> {
  const result = await command(host, executable, args, artifactName, timeoutMs);
  expect(result.exitCode, resultText(result)).toBe(0);
  return result;
}

function mountArgs(
  agent: AgentCase,
  fixtureRoot: string,
  entrypoint: string,
  user = "0",
): string[] {
  return [
    "run",
    "--rm",
    "--user",
    user,
    "--entrypoint",
    entrypoint,
    "--mount",
    `type=bind,src=${fixtureRoot},dst=${agent.configDir}`,
    "--tmpfs",
    "/run/nemoclaw:rw,mode=0755",
    agent.image,
  ];
}

async function dockerIdentity(
  host: HostCliClient,
  agent: AgentCase,
): Promise<{ uid: number; gid: number }> {
  const uid = await expectCommand(
    host,
    "docker",
    ["run", "--rm", "--entrypoint", "id", agent.image, "-u", "sandbox"],
    `${agent.id}-sandbox-uid`,
  );
  const gid = await expectCommand(
    host,
    "docker",
    ["run", "--rm", "--entrypoint", "id", agent.image, "-g", "sandbox"],
    `${agent.id}-sandbox-gid`,
  );
  return { uid: Number(uid.stdout.trim()), gid: Number(gid.stdout.trim()) };
}

async function installedGuardLimits(host: HostCliClient, agent: AgentCase): Promise<GuardLimits> {
  const script = [
    "import json, runpy",
    `m = runpy.run_path(${JSON.stringify(GUARD_PATH)})`,
    "print(json.dumps({",
    "'maxEntries': m['MAX_ENTRIES_PER_PASS'],",
    "'maxLogicalBytes': m['MAX_LOGICAL_BYTES_PER_PASS'],",
    "'maxAllocatedBytes': m['MAX_ALLOCATED_BYTES_PER_PASS'],",
    "'maxCopiedBytes': m['MAX_COPIED_BYTES_PER_PASS'],",
    "'maxDepth': m['MAX_TRAVERSAL_DEPTH'],",
    "'maxSeconds': m['MAX_GUARD_SECONDS'],",
    "}))",
  ].join("\n");
  const result = await expectCommand(
    host,
    "docker",
    ["run", "--rm", "--user", "0", "--entrypoint", "python3", agent.image, "-c", script],
    `${agent.id}-installed-guard-limits`,
  );
  return JSON.parse(result.stdout.trim()) as GuardLimits;
}

function seedTree(fixtureRoot: string, marker: string): GuardTargets {
  const targets = {
    plugins: path.join(fixtureRoot, "plugins", "nemoclaw-e2e", "state", "index.json"),
    credentials: path.join(
      fixtureRoot,
      "credentials",
      "providers",
      "nvidia",
      "profiles",
      "default.json",
    ),
  };
  for (const [rootName, target] of Object.entries(targets)) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify({ marker, rootName, kind: "metadata-target" }));
    fs.chmodSync(target, 0o666);
    for (let index = 0; index < 24; index += 1) {
      const shard = String(index % 4).padStart(2, "0");
      const file = path.join(
        fixtureRoot,
        rootName,
        "production-shaped",
        `shard-${shard}`,
        "cache",
        `entry-${String(index).padStart(2, "0")}.json`,
      );
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.alloc(16 * 1024, 65 + (index % 26)));
      fs.chmodSync(file, 0o660);
    }
  }
  fs.chmodSync(fixtureRoot, 0o2770);
  return targets;
}

function parseAcl(output: string): FileMetadata["acl"] {
  const lines = output.split(/\r?\n/u).map((line) => line.trim());
  const named = lines.find((line) => line.startsWith(`user:${ACL_EXTRA_UID}:`)) ?? "";
  const mask = lines.find((line) => line.startsWith("mask::")) ?? "";
  const namedMatch = named.match(/^user:\d+:([rwx-]{3})(?:\s+#effective:([rwx-]{3}))?$/u);
  const maskMatch = mask.match(/^mask::([rwx-]{3})$/u);
  expect(namedMatch, `missing numeric named-user ACL in:\n${output}`).not.toBeNull();
  expect(maskMatch, `missing ACL mask in:\n${output}`).not.toBeNull();
  return {
    rawNamedUser: namedMatch?.[1] ?? "",
    effectiveNamedUser: namedMatch?.[2] ?? namedMatch?.[1] ?? "",
    mask: maskMatch?.[1] ?? "",
  };
}

async function readMetadata(
  host: HostCliClient,
  file: string,
  artifactPrefix: string,
): Promise<FileMetadata> {
  const stat = await expectCommand(
    host,
    "sudo",
    ["-n", "stat", "-c", "%i %u %g %a", file],
    `${artifactPrefix}-stat`,
  );
  const hash = await expectCommand(
    host,
    "sudo",
    ["-n", "sha256sum", file],
    `${artifactPrefix}-sha256`,
  );
  const marker = await expectCommand(
    host,
    "sudo",
    ["-n", "getfattr", "--only-values", "-n", MARKER_XATTR, file],
    `${artifactPrefix}-xattr`,
  );
  const acl = await expectCommand(
    host,
    "sudo",
    ["-n", "getfacl", "--omit-header", "--absolute-names", "--numeric", file],
    `${artifactPrefix}-acl`,
  );
  const [inode, uid, gid, mode] = stat.stdout.trim().split(/\s+/u);
  return {
    inode: Number(inode),
    uid: Number(uid),
    gid: Number(gid),
    mode: mode.padStart(4, "0"),
    sha256: hash.stdout.trim().split(/\s+/u)[0] ?? "",
    marker: marker.stdout.trim(),
    acl: parseAcl(acl.stdout),
  };
}

function parseGuardSummary(result: ShellProbeResult): GuardSummary {
  const records = result.stdout
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const issues = records.filter((record) => record.type === "issue");
  const summary = [...records].reverse().find((record) => record.type === "result") as
    | GuardSummary
    | undefined;
  expect(issues, JSON.stringify(records, null, 2)).toEqual([]);
  expect(summary, JSON.stringify(records, null, 2)).toBeDefined();
  return summary as GuardSummary;
}

async function runGuard(
  host: HostCliClient,
  agent: AgentCase,
  fixtureRoot: string,
  action: GuardAction,
): Promise<{ elapsedMs: number; summary: GuardSummary }> {
  const started = performance.now();
  const result = await command(
    host,
    "docker",
    [...mountArgs(agent, fixtureRoot, GUARD_PATH), action, "--config-dir", agent.configDir],
    `${agent.id}-guard-${action}`,
  );
  const elapsedMs = performance.now() - started;
  expect(result.exitCode, resultText(result)).toBe(0);
  const summary = parseGuardSummary(result);
  expect(summary).toMatchObject({ action, status: "ok", roots: 2, issueCount: 0 });
  return { elapsedMs, summary };
}

function expectPreserved(actual: FileMetadata, original: FileMetadata, marker: string): void {
  expect(actual.sha256).toBe(original.sha256);
  expect(actual.marker).toBe(marker);
  expect(actual.acl.rawNamedUser).toBe("rwx");
}

async function configureMetadata(
  host: HostCliClient,
  fixtureRoot: string,
  targets: GuardTargets,
  marker: string,
  artifactPrefix: string,
  skip: (reason: string) => never,
): Promise<void> {
  for (const [index, directory] of treeDirectories(fixtureRoot).entries()) {
    const setDirectoryAcl = await command(
      host,
      "setfacl",
      ["-m", `u:${ACL_EXTRA_UID}:--x,m::r-x`, directory],
      `${artifactPrefix}-directory-acl-${index}`,
    );
    requireEnvironment(
      setDirectoryAcl.exitCode === 0,
      `POSIX ACL traversal cannot be configured on ${directory}: ${resultText(setDirectoryAcl)}`,
      skip,
    );
  }
  for (const [name, file] of Object.entries(targets)) {
    const setXattr = await command(
      host,
      "setfattr",
      ["-n", MARKER_XATTR, "-v", `${marker}-${name}`, file],
      `${artifactPrefix}-${name}-set-xattr`,
    );
    requireEnvironment(
      setXattr.exitCode === 0,
      `user xattrs are unsupported on the ${name} fixture: ${resultText(setXattr)}`,
      skip,
    );
    const setAcl = await command(
      host,
      "setfacl",
      ["-m", `u::rw-,u:${ACL_EXTRA_UID}:rwx,g::rw-,m::rw-,o::rw-`, file],
      `${artifactPrefix}-${name}-set-acl`,
    );
    requireEnvironment(
      setAcl.exitCode === 0,
      `POSIX ACLs are unsupported on the ${name} fixture: ${resultText(setAcl)}`,
      skip,
    );
    const getXattr = await command(
      host,
      "getfattr",
      ["--only-values", "-n", MARKER_XATTR, file],
      `${artifactPrefix}-${name}-get-xattr`,
    );
    requireEnvironment(
      getXattr.exitCode === 0,
      `user xattrs cannot be read from the ${name} fixture: ${resultText(getXattr)}`,
      skip,
    );
    const getAcl = await command(
      host,
      "getfacl",
      ["--omit-header", "--absolute-names", "--numeric", file],
      `${artifactPrefix}-${name}-get-acl`,
    );
    requireEnvironment(
      getAcl.exitCode === 0,
      `POSIX ACLs cannot be read from the ${name} fixture: ${resultText(getAcl)}`,
      skip,
    );
  }
}

function containerTargetPath(agent: AgentCase, fixtureRoot: string, target: string): string {
  return path.posix.join(
    agent.configDir,
    path.relative(fixtureRoot, target).split(path.sep).join(path.posix.sep),
  );
}

async function proveExactBindMount(
  host: HostCliClient,
  agent: AgentCase,
  fixtureRoot: string,
  target: string,
  marker: string,
): Promise<ShellProbeResult> {
  const containerTarget = containerTargetPath(agent, fixtureRoot, target);
  const script = [
    "import os, sys",
    "path, expected = sys.argv[1:]",
    `assert os.getxattr(path, ${JSON.stringify(MARKER_XATTR)}).decode() == expected`,
    "assert 'system.posix_acl_access' in os.listxattr(path)",
  ].join("\n");
  return command(
    host,
    "docker",
    [...mountArgs(agent, fixtureRoot, "python3"), "-c", script, containerTarget, marker],
    `${agent.id}-exact-bind-capability`,
  );
}

async function probeNamedUserAccess(
  host: HostCliClient,
  agent: AgentCase,
  fixtureRoot: string,
  target: string,
  artifactName: string,
): Promise<AccessResult> {
  const script = [
    "import json, os, sys",
    "path = sys.argv[1]",
    "def can_open(flags):",
    "    try:",
    "        descriptor = os.open(path, flags)",
    "    except OSError:",
    "        return False",
    "    else:",
    "        os.close(descriptor)",
    "        return True",
    "print(json.dumps({",
    "    'read': can_open(os.O_RDONLY),",
    "    'write': can_open(os.O_WRONLY | os.O_APPEND),",
    "}))",
  ].join("\n");
  const result = await expectCommand(
    host,
    "docker",
    [
      ...mountArgs(agent, fixtureRoot, "python3", `${ACL_EXTRA_UID}:${ACL_EXTRA_UID}`),
      "-c",
      script,
      containerTargetPath(agent, fixtureRoot, target),
    ],
    artifactName,
  );
  return JSON.parse(result.stdout.trim()) as AccessResult;
}

async function expectNamedUserAccessState(
  host: HostCliClient,
  agent: AgentCase,
  fixtureRoot: string,
  targets: GuardTargets,
  phase: string,
  expected: Record<keyof GuardTargets, AccessResult>,
): Promise<void> {
  const actual = Object.fromEntries(
    await Promise.all(
      Object.entries(targets).map(async ([name, target]) => [
        name,
        await probeNamedUserAccess(
          host,
          agent,
          fixtureRoot,
          target,
          `${agent.id}-${phase}-${name}-access`,
        ),
      ]),
    ),
  );
  expect(actual).toEqual(expected);
}

function assertBudgetEvidence(
  tree: TreeMeasurement,
  limits: GuardLimits,
  elapsed: Record<GuardAction, number>,
): void {
  expect(tree.entries * 2).toBeLessThan(limits.maxEntries);
  expect(tree.logicalBytes * 2).toBeLessThan(limits.maxLogicalBytes);
  expect(tree.allocatedBytes * 2).toBeLessThan(limits.maxAllocatedBytes);
  expect(tree.copiedBytes).toBeLessThan(limits.maxCopiedBytes);
  expect(tree.maxDepth).toBeLessThanOrEqual(limits.maxDepth);
  for (const action of ["preflight", "lock", "unlock"] as const) {
    expect(elapsed[action]).toBeLessThan(limits.maxSeconds * 1_000);
  }
}

async function runAgentProbe(
  host: HostCliClient,
  artifacts: ArtifactSink,
  agent: AgentCase,
  fixtureRoot: string,
  skip: (reason: string) => never,
): Promise<void> {
  const installedMode = await expectCommand(
    host,
    "docker",
    [
      "run",
      "--rm",
      "--user",
      "0",
      "--entrypoint",
      "stat",
      agent.image,
      "-c",
      "%U:%G %a",
      GUARD_PATH,
    ],
    `${agent.id}-installed-guard-mode`,
  );
  expect(installedMode.stdout.trim()).toBe("root:root 500");

  const identity = await dockerIdentity(host, agent);
  const limits = await installedGuardLimits(host, agent);
  const marker = `nemoclaw-${agent.id}-${crypto.randomBytes(8).toString("hex")}`;
  const targets = seedTree(fixtureRoot, marker);
  await configureMetadata(host, fixtureRoot, targets, marker, agent.id, skip);
  const bindProbe = await proveExactBindMount(
    host,
    agent,
    fixtureRoot,
    targets.plugins,
    `${marker}-plugins`,
  );
  requireEnvironment(
    bindProbe.exitCode === 0,
    `the ${agent.id} exact bind mount lacks required xattr/ACL semantics: ${resultText(bindProbe)}`,
    skip,
  );

  const tree = measureTree(fixtureRoot);
  await expectCommand(
    host,
    "sudo",
    ["-n", "chown", "-R", `${identity.uid}:${identity.gid}`, fixtureRoot],
    `${agent.id}-seed-ownership`,
  );
  const seeded = {
    plugins: await readMetadata(host, targets.plugins, `${agent.id}-seeded-plugins`),
    credentials: await readMetadata(host, targets.credentials, `${agent.id}-seeded-credentials`),
  };
  for (const metadata of Object.values(seeded)) {
    expect(metadata).toMatchObject({
      uid: identity.uid,
      gid: identity.gid,
      mode: "0666",
      acl: { rawNamedUser: "rwx", effectiveNamedUser: "rw-", mask: "rw-" },
    });
  }
  await expectNamedUserAccessState(host, agent, fixtureRoot, targets, "seeded", {
    plugins: { read: true, write: true },
    credentials: { read: true, write: true },
  });

  const preflight = await runGuard(host, agent, fixtureRoot, "preflight");
  const preflightMetadata = {
    plugins: await readMetadata(host, targets.plugins, `${agent.id}-preflight-plugins`),
    credentials: await readMetadata(host, targets.credentials, `${agent.id}-preflight-credentials`),
  };
  expect(preflightMetadata).toEqual(seeded);
  await expectNamedUserAccessState(host, agent, fixtureRoot, targets, "preflight", {
    plugins: { read: true, write: true },
    credentials: { read: true, write: true },
  });

  const lock = await runGuard(host, agent, fixtureRoot, "lock");
  expect(lock.summary).toMatchObject({
    directories: tree.directories,
    files: tree.files,
  });
  const locked = {
    plugins: await readMetadata(host, targets.plugins, `${agent.id}-locked-plugins`),
    credentials: await readMetadata(host, targets.credentials, `${agent.id}-locked-credentials`),
  };
  expectPreserved(locked.plugins, seeded.plugins, `${marker}-plugins`);
  expectPreserved(locked.credentials, seeded.credentials, `${marker}-credentials`);
  expect(locked.plugins).toMatchObject({
    uid: 0,
    gid: identity.gid,
    mode: "0644",
    acl: { rawNamedUser: "rwx", effectiveNamedUser: "r--", mask: "r--" },
  });
  expect(locked.credentials).toMatchObject({
    uid: 0,
    gid: 0,
    mode: "0600",
    acl: { rawNamedUser: "rwx", effectiveNamedUser: "---", mask: "---" },
  });
  expect(locked.plugins.inode).not.toBe(seeded.plugins.inode);
  expect(locked.credentials.inode).not.toBe(seeded.credentials.inode);
  await expectNamedUserAccessState(host, agent, fixtureRoot, targets, "locked", {
    plugins: { read: true, write: false },
    credentials: { read: false, write: false },
  });

  const unlock = await runGuard(host, agent, fixtureRoot, "unlock");
  expect(unlock.summary).toMatchObject({
    directories: tree.directories,
    files: tree.files,
  });
  const unlocked = {
    plugins: await readMetadata(host, targets.plugins, `${agent.id}-unlocked-plugins`),
    credentials: await readMetadata(host, targets.credentials, `${agent.id}-unlocked-credentials`),
  };
  for (const [name, metadata] of Object.entries(unlocked)) {
    const original = seeded[name as keyof typeof seeded];
    const lockedMetadata = locked[name as keyof typeof locked];
    expectPreserved(metadata, original, `${marker}-${name}`);
    expect(metadata).toMatchObject({
      uid: identity.uid,
      gid: identity.gid,
      mode: "0660",
      acl: { rawNamedUser: "rwx", effectiveNamedUser: "rw-", mask: "rw-" },
    });
    expect(metadata.inode).toBe(lockedMetadata.inode);
  }
  await expectNamedUserAccessState(host, agent, fixtureRoot, targets, "unlocked", {
    plugins: { read: true, write: true },
    credentials: { read: true, write: true },
  });

  const elapsed = {
    preflight: preflight.elapsedMs,
    lock: lock.elapsedMs,
    unlock: unlock.elapsedMs,
  };
  assertBudgetEvidence(tree, limits, elapsed);
  await artifacts.writeJson(`${agent.id}-budget-evidence.json`, {
    agent: agent.id,
    image: agent.image,
    fixture: tree,
    guardLimits: limits,
    estimatedPeakEntriesPerMutationBudget: tree.entries * 2,
    estimatedPeakLogicalBytesPerMutationBudget: tree.logicalBytes * 2,
    estimatedPeakAllocatedBytesPerMutationBudget: tree.allocatedBytes * 2,
    elapsedMs: elapsed,
    summaries: {
      preflight: preflight.summary,
      lock: lock.summary,
      unlock: unlock.summary,
    },
  });
}

// biome-ignore format: preserve legacy live-test body formatting so phase-only changes stay reviewable.
test(
  "installed state-dir guard preserves xattrs and clamps effective ACLs for OpenClaw and Hermes (#6059)",
  {
    ...testTimeoutOptions(TEST_TIMEOUT_MS),
    meta: {
      e2ePhases: [
        "confirm the Linux host and metadata tools",
        "exercise the OpenClaw metadata lock lifecycle",
        "exercise the Hermes metadata lock lifecycle",
        "record cross-agent metadata evidence",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, skip }) => {
    await artifacts.target.declare({
      id: "state-dir-guard-metadata",
      boundary: "prebuilt-production-images-exact-bind-mount",
      contracts: [
        "the installed root-owned guard handles preflight, lock, and unlock for OpenClaw and Hermes",
        "plugins and credentials preserve content and user xattrs across fresh-inode locking",
        "numeric ownership, mode, raw ACL, mask, and effective named-user access match each policy",
        "representative-tree entry, byte, depth, copy, and wall-time evidence stays within shipped limits",
      ],
    });

    requireEnvironment(
      process.platform === "linux",
      "state-dir metadata coverage requires Linux",
      skip,
    );
    const requiredCommands = ["docker", "sudo", "setfacl", "getfacl", "setfattr", "getfattr"];
    const commandAvailability = await Promise.all(
      requiredCommands.map(async (name) => [name, await host.isCommandAvailable(name)] as const),
    );
    const missingCommands = commandAvailability
      .filter(([, available]) => !available)
      .map(([name]) => name);
    requireEnvironment(
      missingCommands.length === 0,
      `state-dir metadata coverage is missing host commands: ${missingCommands.join(", ")}`,
      skip,
    );
    const sudo = await command(host, "sudo", ["-n", "true"], "prereq-passwordless-sudo");
    requireEnvironment(
      sudo.exitCode === 0,
      `passwordless sudo is required: ${resultText(sudo)}`,
      skip,
    );
    const dockerInfo = await command(host, "docker", ["info"], "prereq-docker-info", 30_000);
    requireEnvironment(
      dockerInfo.exitCode === 0,
      `Docker is required: ${resultText(dockerInfo)}`,
      skip,
    );

    const runAgent = async (agent: AgentCase): Promise<void> => {
      const image = await command(
        host,
        "docker",
        ["image", "inspect", agent.image],
        `${agent.id}-image-inspect`,
        30_000,
      );
      requireEnvironment(
        image.exitCode === 0,
        `prebuilt ${agent.id} production image '${agent.image}' is required: ${resultText(image)}`,
        skip,
      );
      const fixtureRoot = fs.mkdtempSync(
        path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), `nemoclaw-${agent.id}-metadata-`),
      );
      cleanup.add(`remove ${agent.id} state-dir metadata fixture`, async () => {
        await expectCommand(
          host,
          "sudo",
          ["-n", "rm", "-rf", "--", fixtureRoot],
          `cleanup-${agent.id}-fixture`,
        );
      });
      await runAgentProbe(host, artifacts, agent, fixtureRoot, skip);
    };

    progress.phase("exercise the OpenClaw metadata lock lifecycle");
    await runAgent(AGENTS[0]);
    progress.phase("exercise the Hermes metadata lock lifecycle");
    await runAgent(AGENTS[1]);

    progress.phase("record cross-agent metadata evidence");
    await artifacts.target.complete({
      id: "state-dir-guard-metadata",
      agents: AGENTS.map((agent) => agent.id),
      assertions: {
        exactBindMountCapabilities: true,
        preflightNonMutating: true,
        lockReplacesInodes: true,
        unlockPreservesLockedInodes: true,
        contentXattrAclPreserved: true,
        effectiveAclClamped: true,
        effectiveAclEnforcedByKernel: true,
        productionBudgetsRecorded: true,
      },
    });
  },
);
