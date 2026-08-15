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
import { loadAgent } from "../../../src/lib/agent/defs.ts";

const GUARD_PATH = "/usr/local/lib/nemoclaw/state-dir-guard.py";
const STATE_LOCK_PLAN_PATH = "/usr/local/share/nemoclaw/state-lock-plan.json";
const ACL_EXTRA_UID = 65_534;
const MARKER_XATTR = "user.nemoclaw_e2e_marker";
const TEST_TIMEOUT_MS = 10 * 60_000;
const COMMAND_TIMEOUT_MS = 2 * 60_000;

const AGENTS = [
  {
    id: "openclaw",
    image: process.env.NEMOCLAW_OPENCLAW_TEST_IMAGE ?? "nemoclaw-production",
    configDir: "/sandbox/.openclaw",
    stateRoots: { readOnly: "extensions", confidential: "credentials" },
  },
  {
    id: "hermes",
    image: process.env.NEMOCLAW_HERMES_TEST_IMAGE ?? "nemoclaw-hermes-production",
    configDir: "/sandbox/.hermes",
    stateRoots: { readOnly: "plugins", confidential: "pairing" },
  },
] as const;

type AgentCase = (typeof AGENTS)[number];
type GuardAction = "preflight" | "lock" | "unlock";
type GuardTargets = Record<"readOnly" | "confidential", string>;
type AccessResult = { read: boolean; write: boolean };

interface InstalledStateLockPlan {
  $comment?: string;
  version: number;
  readOnlyRoots: string[];
  confidentialRoots: string[];
  readOnlyPrefixes: string[];
  confidentialPrefixes: string[];
  writableSubpaths: string[];
}

interface ConfidentialityAccessEvidence {
  processUid: number;
  processGid: number;
  rootUid: number;
  rootGid: number;
  rootMode: number;
  missingDirectChildErrno: number;
  rootListingErrno: number;
  nestedTraversalErrno: number;
  secretReadErrno: number;
}

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

async function installedStateLockPlan(
  host: HostCliClient,
  agent: AgentCase,
): Promise<InstalledStateLockPlan> {
  const result = await expectCommand(
    host,
    "docker",
    ["run", "--rm", "--user", "0", "--entrypoint", "cat", agent.image, STATE_LOCK_PLAN_PATH],
    `${agent.id}-installed-state-lock-plan`,
  );
  return JSON.parse(result.stdout) as InstalledStateLockPlan;
}

function seedTree(agent: AgentCase, fixtureRoot: string, marker: string): GuardTargets {
  const targets = {
    readOnly: path.join(
      fixtureRoot,
      agent.stateRoots.readOnly,
      "nemoclaw-e2e",
      "state",
      "index.json",
    ),
    confidential: path.join(
      fixtureRoot,
      agent.stateRoots.confidential,
      "nemoclaw-e2e",
      "state",
      "index.json",
    ),
  };
  for (const [policy, target] of Object.entries(targets)) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify({ marker, policy, kind: "metadata-target" }));
    fs.chmodSync(target, 0o666);
    for (let index = 0; index < 24; index += 1) {
      const shard = String(index % 4).padStart(2, "0");
      const file = path.join(
        path.dirname(path.dirname(target)),
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
    [
      ...mountArgs(agent, fixtureRoot, GUARD_PATH),
      action,
      "--config-dir",
      agent.configDir,
      "--plan-file",
      STATE_LOCK_PLAN_PATH,
    ],
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

async function probeConfidentialityAccessContract(
  host: HostCliClient,
  agent: AgentCase,
  fixtureRoot: string,
  target: string,
  identity: { uid: number; gid: number },
): Promise<ConfidentialityAccessEvidence> {
  const credentialsRoot = path.join(fixtureRoot, agent.stateRoots.confidential);
  const containerRoot = containerTargetPath(agent, fixtureRoot, credentialsRoot);
  const containerTarget = containerTargetPath(agent, fixtureRoot, target);
  const script = [
    "import json, os, stat, sys",
    "root_path, secret_path = sys.argv[1:]",
    "def errno_of(operation):",
    "    try:",
    "        operation()",
    "    except OSError as exc:",
    "        return exc.errno",
    "    return 0",
    "def read_secret():",
    "    with open(secret_path, 'rb') as stream:",
    "        stream.read(1)",
    "root = os.lstat(root_path)",
    "print(json.dumps({",
    "    'processUid': os.getuid(),",
    "    'processGid': os.getgid(),",
    "    'rootUid': root.st_uid,",
    "    'rootGid': root.st_gid,",
    "    'rootMode': stat.S_IMODE(root.st_mode),",
    "    'missingDirectChildErrno': errno_of(lambda: os.lstat(os.path.join(root_path, 'oauth.json'))),",
    "    'rootListingErrno': errno_of(lambda: os.listdir(root_path)),",
    "    'nestedTraversalErrno': errno_of(lambda: os.lstat(os.path.join(root_path, 'nemoclaw-e2e', 'missing.json'))),",
    "    'secretReadErrno': errno_of(read_secret),",
    "}))",
  ].join("\n");
  const result = await expectCommand(
    host,
    "docker",
    [
      ...mountArgs(agent, fixtureRoot, "python3", `${identity.uid}:${identity.gid}`),
      "-c",
      script,
      containerRoot,
      containerTarget,
    ],
    `${agent.id}-locked-confidentiality-access`,
  );
  return JSON.parse(result.stdout.trim()) as ConfidentialityAccessEvidence;
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

  const installedPlanMode = await expectCommand(
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
      STATE_LOCK_PLAN_PATH,
    ],
    `${agent.id}-installed-state-lock-plan-mode`,
  );
  expect(installedPlanMode.stdout.trim()).toBe("root:root 444");

  const stateLockPlan = await installedStateLockPlan(host, agent);
  const { $comment, ...installedPlan } = stateLockPlan;
  expect(typeof $comment).toBe("string");
  expect(installedPlan).toEqual(loadAgent(agent.id).stateLockPlan);

  const identity = await dockerIdentity(host, agent);
  const limits = await installedGuardLimits(host, agent);
  const marker = `nemoclaw-${agent.id}-${crypto.randomBytes(8).toString("hex")}`;
  const targets = seedTree(agent, fixtureRoot, marker);
  await configureMetadata(host, fixtureRoot, targets, marker, agent.id, skip);
  const bindProbe = await proveExactBindMount(
    host,
    agent,
    fixtureRoot,
    targets.readOnly,
    `${marker}-readOnly`,
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
    readOnly: await readMetadata(host, targets.readOnly, `${agent.id}-seeded-read-only`),
    confidential: await readMetadata(host, targets.confidential, `${agent.id}-seeded-confidential`),
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
    readOnly: { read: true, write: true },
    confidential: { read: true, write: true },
  });

  const preflight = await runGuard(host, agent, fixtureRoot, "preflight");
  const preflightMetadata = {
    readOnly: await readMetadata(host, targets.readOnly, `${agent.id}-preflight-read-only`),
    confidential: await readMetadata(
      host,
      targets.confidential,
      `${agent.id}-preflight-confidential`,
    ),
  };
  expect(preflightMetadata).toEqual(seeded);
  await expectNamedUserAccessState(host, agent, fixtureRoot, targets, "preflight", {
    readOnly: { read: true, write: true },
    confidential: { read: true, write: true },
  });

  const lock = await runGuard(host, agent, fixtureRoot, "lock");
  expect(lock.summary).toMatchObject({
    directories: tree.directories,
    files: tree.files,
  });
  const locked = {
    readOnly: await readMetadata(host, targets.readOnly, `${agent.id}-locked-read-only`),
    confidential: await readMetadata(host, targets.confidential, `${agent.id}-locked-confidential`),
  };
  expectPreserved(locked.readOnly, seeded.readOnly, `${marker}-readOnly`);
  expectPreserved(locked.confidential, seeded.confidential, `${marker}-confidential`);
  expect(locked.readOnly).toMatchObject({
    uid: 0,
    gid: identity.gid,
    mode: "0644",
    acl: { rawNamedUser: "rwx", effectiveNamedUser: "r--", mask: "r--" },
  });
  expect(locked.confidential).toMatchObject({
    uid: 0,
    gid: 0,
    mode: "0600",
    acl: { rawNamedUser: "rwx", effectiveNamedUser: "---", mask: "---" },
  });
  expect(locked.readOnly.inode).not.toBe(seeded.readOnly.inode);
  expect(locked.confidential.inode).not.toBe(seeded.confidential.inode);
  await expectNamedUserAccessState(host, agent, fixtureRoot, targets, "locked", {
    readOnly: { read: true, write: false },
    confidential: { read: false, write: false },
  });
  const confidentialityAccess = await probeConfidentialityAccessContract(
    host,
    agent,
    fixtureRoot,
    targets.confidential,
    identity,
  );
  expect(confidentialityAccess).toMatchObject({
    processUid: identity.uid,
    processGid: identity.gid,
    rootUid: 0,
    rootGid: identity.gid,
    rootMode: 0o710,
    missingDirectChildErrno: os.constants.errno.ENOENT,
    rootListingErrno: os.constants.errno.EACCES,
    nestedTraversalErrno: os.constants.errno.EACCES,
    secretReadErrno: os.constants.errno.EACCES,
  });
  expect(confidentialityAccess.processUid).not.toBe(confidentialityAccess.rootUid);

  const unlock = await runGuard(host, agent, fixtureRoot, "unlock");
  expect(unlock.summary).toMatchObject({
    directories: tree.directories,
    files: tree.files,
  });
  const unlocked = {
    readOnly: await readMetadata(host, targets.readOnly, `${agent.id}-unlocked-read-only`),
    confidential: await readMetadata(
      host,
      targets.confidential,
      `${agent.id}-unlocked-confidential`,
    ),
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
    readOnly: { read: true, write: true },
    confidential: { read: true, write: true },
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
    stateLockPlan: {
      path: STATE_LOCK_PLAN_PATH,
      readOnlyRoot: agent.stateRoots.readOnly,
      confidentialRoot: agent.stateRoots.confidential,
    },
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
    confidentialityAccess,
  });
}

test(
  "installed state-dir guard applies each agent's generated plan without losing metadata (#6059)",
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
        "the installed root-owned guard loads each image's generated AgentDefinition state-lock plan for preflight, lock, and unlock",
        "one declared read-only root and one declared confidential root exercise each agent's lifecycle",
        "content and user xattrs survive fresh-inode locking for both declared policies",
        "numeric ownership, mode, raw ACL, mask, and effective named-user access match each declared policy",
        "a distinct sandbox-group member sees ENOENT for a missing direct child while listing, nested traversal, and secret reads stay denied",
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
        installedGeneratedPlanLoaded: true,
        agentSpecificPolicyRootsExercised: true,
        exactBindMountCapabilities: true,
        preflightNonMutating: true,
        lockReplacesInodes: true,
        unlockPreservesLockedInodes: true,
        contentXattrAclPreserved: true,
        effectiveAclClamped: true,
        effectiveAclEnforcedByKernel: true,
        confidentialityRootAccessContract: true,
        productionBudgetsRecorded: true,
      },
    });
  },
);
