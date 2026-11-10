// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readOpenedRegularFile } from "../runtime/native-security.mts";

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export function readLauncherAdmissionBytes(file: string, maxBytes = 2 * 1024 * 1024) {
  const bytes = readOpenedRegularFile(file, { maxBytes, rejectLinks: true, rejectHardLinks: true });
  assert(bytes !== null, "An acceptance input is missing.");
  return bytes;
}

const launcherSourcePrefix = "packaging/windows/launcher/";
type ArtifactSourceSnapshot = {
  schemaVersion: 1;
  classification: `independent-${"openclaw" | "hermes"}-launcher-source-snapshot`;
  artifactSourceRevision: string;
  controllerSourceRevision: string;
  controllerRun: string;
  sources: { file: string; bytes: number; sha256: string }[];
};

function ordinarySourceDirectory(directory: string) {
  const resolved = path.resolve(directory);
  const stat = fs.lstatSync(resolved);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), "Source directories must not be links.");
  assert.equal(fs.realpathSync(resolved).toLowerCase(), resolved.toLowerCase());
  return resolved;
}

// Read Git's authorized tree, not candidate scripts, filters, hooks or receipt claims.
export function captureLauncherArtifactSources(input: {
  agent: "openclaw" | "hermes";
  artifactSourceRoot: string;
  controllerSourceRoot: string;
  artifactSourceRevision: string;
  controllerSourceRevision: string;
  controllerRun: string;
}): ArtifactSourceSnapshot {
  assert(["openclaw", "hermes"].includes(input.agent));
  assert.match(input.artifactSourceRevision, /^[a-f0-9]{40}$/u);
  assert.match(input.controllerSourceRevision, /^[a-f0-9]{40}$/u);
  assert.match(input.controllerRun, /^[1-9]\d*:[1-9]\d*$/u);
  const artifact = ordinarySourceDirectory(input.artifactSourceRoot);
  const controller = ordinarySourceDirectory(input.controllerSourceRoot);
  for (const [root, other] of [
    [artifact, controller],
    [controller, artifact],
  ]) {
    const relative = path.relative(root.toLowerCase(), other.toLowerCase());
    assert(
      relative && (relative.startsWith(".." + path.sep) || path.isAbsolute(relative)),
      "Controller and candidate sources must use separate checkouts.",
    );
  }
  ordinarySourceDirectory(path.join(artifact, ".git"));
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) =>
      /^(PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT|TEMP|TMP)$/iu.test(name),
    ),
  );
  Object.assign(environment, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
  });
  const git = (root: string, args: string[]) => {
    const result = spawnSync(
      "git",
      ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=", "-C", root, ...args],
      { env: environment, windowsHide: true, timeout: 10000, maxBuffer: 2 * 1024 * 1024 },
    );
    assert.equal(result.error, undefined, "Candidate source Git inspection failed.");
    assert.equal(result.status, 0, "Candidate source Git inspection failed.");
    return result.stdout;
  };
  assert.equal(
    git(controller, ["rev-parse", "HEAD"]).toString("utf8").trim(),
    input.controllerSourceRevision,
  );
  assert.equal(
    git(artifact, ["rev-parse", "HEAD"]).toString("utf8").trim(),
    input.artifactSourceRevision,
  );
  const tree = git(artifact, [
    "ls-tree",
    "-r",
    "-z",
    "--full-tree",
    input.artifactSourceRevision,
    "--",
    launcherSourcePrefix,
  ]);
  const entries = new Map<string, string>();
  for (const entry of tree.toString("utf8").split("\0").filter(Boolean)) {
    const match =
      /^(100644|100755) blob ([a-f0-9]{40})\t(packaging\/windows\/launcher\/[A-Za-z0-9_./-]+)$/u.exec(
        entry,
      );
    assert(match, "The candidate launcher tree contains unsupported paths or objects.");
    const file = match[3];
    assert(file.split("/").every((part) => part !== "." && part !== ".."));
    assert(
      ![...entries.keys()].some((name) => name.toLowerCase() === file.toLowerCase()),
      "The candidate launcher tree contains duplicate paths.",
    );
    entries.set(file, match[2]);
  }
  assert(
    entries.size >= 5 && entries.size <= 512,
    "The candidate launcher tree exceeds its bounds.",
  );
  const observed = new Set<string>();
  const sources: ArtifactSourceSnapshot["sources"] = [];
  let totalBytes = 0;
  const visit = (directory: string) => {
    ordinarySourceDirectory(directory);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      assert(!entry.isSymbolicLink(), "The candidate launcher checkout contains a link.");
      const relative = path.relative(artifact, file).split(path.sep).join("/");
      if (entry.isDirectory()) {
        assert(
          !["target", "bin", "obj"].includes(
            path
              .relative(path.join(artifact, "packaging", "windows", "launcher"), file)
              .split(path.sep)[0],
          ),
          "The candidate launcher checkout contains generated output.",
        );
        assert(
          [...entries.keys()].some((name) => name.startsWith(relative + "/")),
          "The candidate launcher checkout contains an unexpected directory.",
        );
        visit(file);
      } else {
        assert(
          entries.has(relative),
          "The candidate launcher checkout contains an unexpected file.",
        );
        const bytes = readLauncherAdmissionBytes(file, 16 * 1024 * 1024);
        totalBytes += bytes.length;
        assert(
          totalBytes <= 64 * 1024 * 1024,
          "The candidate launcher checkout exceeds its byte bound.",
        );
        const blob = createHash("sha1")
          .update("blob " + bytes.length + "\0")
          .update(bytes)
          .digest("hex");
        assert.equal(
          blob,
          entries.get(relative),
          "The candidate launcher source differs from its authorized Git tree.",
        );
        observed.add(relative);
        if (
          relative === launcherSourcePrefix + "Cargo.toml" ||
          relative === launcherSourcePrefix + "Cargo.lock" ||
          relative.endsWith(".rs") ||
          relative.startsWith(launcherSourcePrefix + ".cargo/")
        ) {
          assert(bytes.length > 0);
          sources.push({ file: relative, bytes: bytes.length, sha256: digest(bytes) });
        }
      }
    }
  };
  visit(path.join(artifact, "packaging", "windows", "launcher"));
  assert.deepEqual(
    [...observed].sort(),
    [...entries.keys()].sort(),
    "Candidate launcher files are missing.",
  );
  return {
    schemaVersion: 1,
    classification: `independent-${input.agent}-launcher-source-snapshot`,
    artifactSourceRevision: input.artifactSourceRevision,
    controllerSourceRevision: input.controllerSourceRevision,
    controllerRun: input.controllerRun,
    sources: sources.sort((a, b) => a.file.localeCompare(b.file)),
  };
}

export function validateLauncherArtifactSourceSnapshot(input: {
  agent: "openclaw" | "hermes";
  bytes: Buffer;
  sha256: string;
  sourceRevision: string;
  controllerSourceRevision: string;
  controllerRun: string;
}) {
  assert.match(input.sha256, /^[a-f0-9]{64}$/u);
  assert.match(input.sourceRevision, /^[a-f0-9]{40}$/u);
  assert.match(input.controllerSourceRevision, /^[a-f0-9]{40}$/u);
  assert.match(input.controllerRun, /^[1-9]\d*:[1-9]\d*$/u);
  assert(input.bytes.length > 0 && input.bytes.length <= 256 * 1024);
  assert.equal(digest(input.bytes), input.sha256, "The pre-install source snapshot changed.");
  const document = JSON.parse(input.bytes.toString("utf8"));
  assert.deepEqual(
    Object.keys(document).sort(),
    [
      "schemaVersion",
      "classification",
      "artifactSourceRevision",
      "controllerSourceRevision",
      "controllerRun",
      "sources",
    ].sort(),
  );
  assert.equal(document.schemaVersion, 1);
  assert(["openclaw", "hermes"].includes(input.agent));
  assert.equal(document.classification, `independent-${input.agent}-launcher-source-snapshot`);
  assert.equal(document.artifactSourceRevision, input.sourceRevision);
  assert.equal(document.controllerSourceRevision, input.controllerSourceRevision);
  assert.equal(document.controllerRun, input.controllerRun);
  assert(
    Array.isArray(document.sources) &&
      document.sources.length >= 5 &&
      document.sources.length <= 512,
  );
  const rows = new Map<string, { file: string; bytes: number; sha256: string }>();
  let total = 0;
  for (const row of document.sources) {
    assert(row && typeof row === "object");
    assert.deepEqual(Object.keys(row).sort(), ["bytes", "file", "sha256"]);
    assert(
      typeof row.file === "string" &&
        /^packaging\/windows\/launcher\/[A-Za-z0-9_./-]+$/u.test(row.file),
    );
    assert(row.file.split("/").every((part: string) => part !== "." && part !== ".."));
    assert(
      row.file === launcherSourcePrefix + "Cargo.toml" ||
        row.file === launcherSourcePrefix + "Cargo.lock" ||
        row.file.endsWith(".rs") ||
        row.file.startsWith(launcherSourcePrefix + ".cargo/"),
    );
    assert(Number.isSafeInteger(row.bytes) && row.bytes > 0 && row.bytes <= 16 * 1024 * 1024);
    assert.match(row.sha256, /^[a-f0-9]{64}$/u);
    assert(!rows.has(row.file.toLowerCase()));
    rows.set(row.file.toLowerCase(), row);
    total += row.bytes;
    assert(total <= 64 * 1024 * 1024);
  }
  for (const file of [
    "Cargo.toml",
    "Cargo.lock",
    "src/main.rs",
    "src/state_session.rs",
    "src/runtime_lease.rs",
  ])
    assert(rows.has((launcherSourcePrefix + file).toLowerCase()));
  return rows;
}

// The caller's authenticated package transfer owns provenance. These checks bind
// its selected executable and every launcher source before invoking inspection.
export function validateInstalledLauncherInputs(input: {
  agent: "openclaw" | "hermes";
  buildBytes: Buffer;
  sourceBytes: Buffer;
  capabilityBytes: Buffer;
  materializationBytes: Buffer;
  launcherBytes: Buffer;
  packagedBytes: Buffer;
  installedBytes: Buffer;
  sourceRevision: string;
  controllerRun: string;
  artifactSourceSnapshotBytes: Buffer;
  artifactSourceSnapshotSha256: string;
  controllerSourceRevision: string;
}) {
  const independentSources = validateLauncherArtifactSourceSnapshot({
    agent: input.agent,
    bytes: input.artifactSourceSnapshotBytes,
    sha256: input.artifactSourceSnapshotSha256,
    sourceRevision: input.sourceRevision,
    controllerSourceRevision: input.controllerSourceRevision,
    controllerRun: input.controllerRun,
  });
  const build = JSON.parse(input.buildBytes.toString("utf8"));
  const source = JSON.parse(input.sourceBytes.toString("utf8"));
  const capability = JSON.parse(input.capabilityBytes.toString("utf8"));
  const materialized = JSON.parse(input.materializationBytes.toString("utf8"));
  assert.match(input.sourceRevision, /^[a-f0-9]{40}$/u);
  assert.match(input.controllerRun, /^[1-9]\d*:[1-9]\d*$/u);
  assert.equal(build.schemaVersion, 1);
  assert.equal(build.classification, "finished-native-runtime-package-build");
  assert.equal(build.status, "candidate-built-for-installed-qualification");
  assert.equal(build.sourceRevision, input.sourceRevision);
  assert.equal(build.launcherBuildInputs?.file, "launcher-build-inputs.json");
  assert.equal(build.launcherBuildInputs.bytes, input.sourceBytes.length);
  assert.equal(build.launcherBuildInputs.sha256, digest(input.sourceBytes));
  assert.equal(build.launcherCapabilitiesSha256, digest(input.capabilityBytes));
  const copies = build.compiledArtifacts?.filter(
    (row: any) => row.file === "compiled-launcher.json",
  );
  assert.equal(copies?.length, 1);
  assert.equal(copies[0].sha256, digest(input.materializationBytes));
  assert.equal(source.schemaVersion, 1);
  assert.equal(source.classification, "package-selected-launcher-build-inputs");
  assert.equal(source.sourceRevision, input.sourceRevision);
  assert.equal(`${source.workflowRunId}:${source.workflowRunAttempt}`, input.controllerRun);
  assert.equal(source.target, "aarch64-pc-windows-msvc");
  assert.equal(source.rustToolchain, "1.95.0-aarch64-pc-windows-msvc");
  assert.deepEqual(source.features, ["immutable-runtime"]);
  assert.equal(source.lockedDependencies, true);
  assert.equal(source.staticCrt, true);
  for (const flag of ["commandSupportValidated", "invocationAdmitted", "installedAcceptance"])
    assert.equal(source[flag], false);
  assert(
    input.launcherBytes.equals(input.packagedBytes) &&
      input.launcherBytes.equals(input.installedBytes),
    "The installed inspection helper differs from the package-selected launcher.",
  );
  const launcherSha256 = digest(input.launcherBytes);
  for (const [property, file, bytes] of [
    ["retainedLauncher", "build/compiled-native/NemoClaw.exe", input.launcherBytes],
    ["packagedLauncher", "build/payload/bin/NemoClaw.exe", input.packagedBytes],
    ["materialization", "compiled-launcher.json", input.materializationBytes],
    ["capabilityObservation", "build/launcher-capabilities.json", input.capabilityBytes],
  ] as const) {
    assert.equal(source[property]?.file, file);
    assert.equal(source[property].bytes, bytes.length);
    assert.equal(source[property].sha256, digest(bytes));
  }
  assert.equal(materialized.schemaVersion, 1);
  assert.equal(materialized.classification, "ci-native-compiled-artifact");
  assert.equal(materialized.status, "materialized");
  assert.equal(materialized.runtimeLaunchCopy, false);
  for (const key of ["outputSha256", "sourceSha256Before", "sourceSha256After"])
    assert.equal(materialized[key], launcherSha256);
  assert.equal(materialized.outputStat?.bytes, input.launcherBytes.length);
  assert.equal(materialized.outputStat?.links, 1);
  assert.equal(capability.schemaVersion, 1);
  assert.equal(capability.launcherSha256, launcherSha256);
  assert.equal(capability.capabilities?.schemaVersion, 1);
  assert.equal(capability.capabilities.kind, "native-runtime-capabilities");
  assert.equal(capability.capabilities.immutableRuntime, true);
  assert.equal(capability.capabilities.guardianEnabled, true);
  assert.deepEqual(capability.capabilities.supportedCommands, ["native-state-inspection-v1"]);
  assert.deepEqual(source.capabilityObservation.advertisedCommands, ["native-state-inspection-v1"]);
  assert(
    Array.isArray(source.sources) && source.sources.length >= 5 && source.sources.length <= 512,
  );
  const names = new Set<string>();
  for (const row of source.sources) {
    assert(
      typeof row.file === "string" &&
        /^packaging\/windows\/launcher\/(?:Cargo\.(?:toml|lock)|(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+)$/u.test(
          row.file,
        ),
    );
    assert(row.file.split("/").every((part: string) => part !== "." && part !== ".."));
    assert(!names.has(row.file.toLowerCase()));
    names.add(row.file.toLowerCase());
    const expected = independentSources.get(row.file.toLowerCase());
    assert(expected, "The package source is absent from the independently admitted inventory.");
    assert.equal(row.file, expected.file);
    assert.equal(row.bytes, expected.bytes);
    assert.equal(
      row.sha256,
      expected.sha256,
      "The package source differs from the authorized candidate.",
    );
  }
  for (const file of [
    "Cargo.toml",
    "Cargo.lock",
    "src/main.rs",
    "src/state_session.rs",
    "src/runtime_lease.rs",
  ])
    assert(names.has(("packaging/windows/launcher/" + file).toLowerCase()));
  assert.deepEqual(
    [...names].sort(),
    [...independentSources.keys()].sort(),
    "The complete launcher source inventory differs from the admitted candidate snapshot.",
  );
  return {
    launcherSha256,
    packageBuildSha256: digest(input.buildBytes),
    artifactSourceSnapshotSha256: input.artifactSourceSnapshotSha256,
    controllerSourceRevision: input.controllerSourceRevision,
  };
}
