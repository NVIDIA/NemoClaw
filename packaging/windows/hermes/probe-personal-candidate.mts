// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes, createHash } from "node:crypto";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { errorDetail, fileIdentity } from "./probe-component-workload.mts";
import {
  bashDiagnostics,
  parseComponent,
  personalCommand,
  personalCriticalFiles,
  validatePersonalWorkloadInput,
} from "./probe-personal-workload.mts";
import {
  binaryPins,
  validateDerivedMetadata,
  validateMxcInspectionBuild,
} from "../mxc-bash/bash-compat.mts";

export function validatePersonalCompatibility(
  proof: any,
  build: any,
  mxcBuild: any,
  patchSha256: string,
) {
  assert.equal(proof.passed, true);
  assert.equal(proof.normalCleanup, true);
  assert.equal(proof.phase, "two-container-isolation");
  assert.match(proof.sourceRevision, /^[a-f0-9]{40}$/u);
  assert.equal(build.schemaVersion, 1);
  assert.equal(build.classification, "mxc-msys-compatibility-prototype-build");
  assert.equal(build.status, "built");
  assert.equal(build.sourceRevision, proof.sourceRevision);
  assert.equal(mxcBuild.candidateRevision, proof.sourceRevision);
  assert.deepEqual(build, proof.inputs.compatibility);
  assert.deepEqual(mxcBuild, proof.inputs.mxcBuild);
  const mxcFile = validateMxcInspectionBuild(mxcBuild, patchSha256);
  assert.equal(mxcFile.sha256, proof.inputs.mxcSha256);
  const expected = new Map([
    ["NemoClawMsysLauncher.exe", "arm64"],
    ["NemoClawMsysCompat-arm64.dll", "arm64"],
    ["NemoClawMsysCompat-x64.dll", "x64"],
  ]);
  assert.equal(build.files.length, expected.size);
  assert.equal(new Set(build.files.map((file: any) => file.file)).size, expected.size);
  for (const file of build.files) {
    assert.equal(file.machine, expected.get(file.file));
    assert(expected.has(file.file));
    assert(Number.isSafeInteger(file.bytes) && file.bytes > 0);
    assert.match(file.sha256, /^[a-f0-9]{64}$/u);
  }
  assert.equal(build.license.file, "DETOURS-LICENSE.txt");
  assert(Number.isSafeInteger(build.license.bytes) && build.license.bytes > 0);
  assert.match(build.license.sha256, /^[a-f0-9]{64}$/u);
  // This validates the already-passed raw prototype receipt only. The new
  // initialized canonical tree has its own distinct derivation contract.
  validateDerivedMetadata(proof.inputs.gitDerivation, proof.sourceRevision);
  assert.deepEqual(proof.inputs.git, binaryPins);
  return {
    sourceRevision: proof.sourceRevision,
    files: build.files,
    license: build.license,
    mxcFile,
    gitPins: proof.inputs.git,
  };
}

export function validateInitializedPersonalGit(git: any, proof: any) {
  assert.equal(git.schemaVersion, 1);
  assert.equal(git.classification, "ci-derived-initialized-canonical-hermes-git");
  assert.equal(git.baseCandidateSource, "47d890728482cca05e840edd27e33e3d495aeabf");
  assert.equal(
    git.baseInventorySha256,
    "777f6a6fcbefa3790130e795b611aff086775f23682ae109c16cac2f1ff1acd0",
  );
  assert.equal(git.upstreamCommit, "2237be355906fbe6065ce1815711eee52b2d646e");
  assert.equal(git.fileCount, 7835);
  assert.equal(git.filesReplacedAtBuild, 3);
  assert.equal(git.allOtherFilesUnchanged, true);
  assert.equal(git.firstLaunchSetupAllowed, false);
  assert.equal(git.fullAgentQualified, false);
  assert.equal(git.installedAcceptance, false);
  assert.deepEqual(git.initializedFilesPreserved, [
    "clangarm64/libexec/git-core/dlls-copied",
    "etc/hosts",
    "etc/mtab",
    "etc/networks",
    "etc/protocols",
    "etc/services",
  ]);
  assert.match(git.beforeInventorySha256, /^[a-f0-9]{64}$/u);
  assert.match(git.afterInventorySha256, /^[a-f0-9]{64}$/u);
  assert.equal(git.files.length, 3);
  assert.equal(new Set(git.files.map((file: any) => file.path)).size, 3);
  for (const file of git.files) {
    const qualified = proof.inputs.gitDerivation.files.find((row: any) => row.path === file.path);
    assert(qualified, "The initialized Git image was not part of the passed prototype.");
    for (const field of [
      "beforeSha256",
      "afterSha256",
      "beforeBytes",
      "bytes",
      "beforeFlags",
      "afterFlags",
      "onlyMetadataChanged",
    ])
      assert.equal(file[field], qualified[field]);
    assert.equal(file.afterSha256, proof.inputs.git[file.path]);
    assert.deepEqual(file.sections, qualified.sections);
  }
  return git;
}

function receiptDocument(file: string) {
  const stat = fs.lstatSync(file);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 256 * 1024 * 1024);
  const bytes = fs.readFileSync(file);
  return {
    path: file,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    value: JSON.parse(bytes.toString("utf8")),
  };
}

export function validateDerivedPersonalHeader(
  candidate: any,
  derivation: any,
  inventory: any,
  wheel: any,
  git: any,
  sourceRevision: string,
  runtime: string,
  adapterSha256: string,
  proof: any,
) {
  assert.match(sourceRevision, /^[a-f0-9]{40}$/u);
  assert.match(adapterSha256, /^[a-f0-9]{64}$/u);
  assert.equal(candidate.schemaVersion, 1);
  assert.equal(candidate.classification, "official-hermes-runtime-candidate-build");
  assert.equal(candidate.status, "candidate-bytes-exported");
  assert.equal(candidate.controllerSource, sourceRevision);
  assert.equal(candidate.upstreamCommit, "2237be355906fbe6065ce1815711eee52b2d646e");
  assert.equal(candidate.completeByteInventory, true);
  for (const key of ["runtimeExecutionQualified", "installedAcceptance", "activationAllowed"])
    assert.equal(candidate[key], false);
  assert.equal(candidate.startupAdapterSha256, adapterSha256);
  assert.match(candidate.archive.sha256, /^[a-f0-9]{64}$/u);
  assert(Number.isSafeInteger(candidate.archive.bytes) && candidate.archive.bytes > 0);
  assert.equal(candidate.archive.file, "official-hermes-runtime-candidate.tar.gz");
  assert.equal(derivation.schemaVersion, 1);
  assert.equal(derivation.classification, "reused-complete-canonical-hermes-runtime");
  assert.equal(derivation.runtimeRootAtExport, runtime);
  assert.match(derivation.originalBuildRoot, /^[A-Za-z]:\\NemoClawHermesProbe-[a-f0-9]{12}$/u);
  assert.notEqual(derivation.originalBuildRoot, runtime);
  assert.equal(derivation.onlyRecordedChanges, true);
  assert.equal(derivation.completeCanonicalBaseVerified, true);
  assert.equal(derivation.fullAgentQualified, false);
  assert.equal(derivation.installedAcceptance, false);
  assert.equal(derivation.base.artifactId, 10181796438);
  assert.equal(derivation.base.runId, 34551706967);
  assert.equal(derivation.base.sourceRevision, "47d890728482cca05e840edd27e33e3d495aeabf");
  assert.equal(
    derivation.base.zipSha256,
    "b6e3683f4248b62e6ba3594d8ecab11d6958a23f161b526a1d11ec07d146d6ed",
  );
  assert.equal(
    derivation.base.inventorySha256,
    "777f6a6fcbefa3790130e795b611aff086775f23682ae109c16cac2f1ff1acd0",
  );
  assert.equal(candidate.buildReceiptSha256, derivation.base.buildReceiptSha256);
  assert.equal(derivation.adapterUpgrade.afterSha256, adapterSha256);
  assert.equal(derivation.adapterUpgrade.baseCandidateSource, derivation.base.sourceRevision);
  assert.equal(wheel.schemaVersion, 1);
  assert.equal(wheel.classification, "ci-targeted-pywinpty-conpty-rebuild");
  assert.equal(wheel.status, "pass");
  assert.deepEqual(wheel.base, derivation.base);
  for (const key of [
    "allOtherFilesUnchanged",
    "allOtherDirectoriesUnchanged",
    "buildToolsOutsideRuntime",
    "noRuntimeDependencyResolution",
    "allOwnedProcessesClosed",
  ])
    assert.equal(wheel[key], true);
  assert.equal(wheel.installedAcceptance, false);
  assert.equal(wheel.fullAgentQualified, false);
  assert.equal(wheel.configuration.maturinBuildArgs, "--features winpty-rs/conpty --locked");
  assert.equal(wheel.configuration.upstreamUvSettingsPreserved, true);
  assert.equal(wheel.configuration.globalRustFlagsChanged, false);
  assert.equal(wheel.configuration.upstreamSourcesChanged, false);
  validateInitializedPersonalGit(git, proof);
  assert.equal(candidate.fileCount, inventory.files.length);
  assert.equal(
    candidate.logicalBytes,
    inventory.files.reduce((sum: number, file: any) => sum + (file.bytes ?? 0), 0),
  );
  const indexed = new Map<string, any>();
  for (const file of inventory.files) {
    assert.equal(typeof file.path, "string");
    assert(file.path && !file.path.startsWith("/") && !/[\\:]/u.test(file.path));
    assert(file.path.split("/").every((part: string) => part && part !== "." && part !== ".."));
    assert(!indexed.has(file.path));
    indexed.set(file.path, file);
  }
  assert(
    Array.isArray(wheel.replacement.installedFiles) && wheel.replacement.installedFiles.length > 0,
  );
  assert.equal(
    new Set(wheel.replacement.installedFiles.map((file: any) => file.path)).size,
    wheel.replacement.installedFiles.length,
  );
  for (const file of wheel.replacement.installedFiles) {
    const expected = indexed.get(file.path);
    assert(expected && expected.bytes === file.bytes && expected.sha256 === file.sha256);
  }
  return indexed;
}

export const completedPersonalReplayPin = {
  artifactId: 10293082661,
  runId: 34679482914,
  sourceRevision: "8d78fe458e9268a7afdc8ed06b85c23306452036",
  bytes: 1073328197,
  sha256: "753aa3e7addcc1c274b4a59b6785706715ccba661eaa31bfe77a95e20271bda1",
  candidateReceiptSha256: "c682b3cd2f9691ad7d65312682522b59a5a5105c19688621153261d92c4f1c4f",
  inventorySha256: "f4df172630b7f5ae6ec9cc9cf9c54b4744c2b0046cb15859f9469ff9bfe7a0e2",
  startupAdapterSha256: "58a55abda6045e4919da5e56042d21768e72bab3be1e7444a4f65eb850941f65",
  runtimeRoot: "C:\\NemoClawHermesProbe-274d797050ea",
} as const;

export function validatePersonalReplayInput(
  replay: any,
  candidate: any,
  identity: any,
  runtime: string,
  controller: string,
) {
  assert.equal(replay.schemaVersion, 1);
  assert.equal(replay.classification, "immutable-canonical-hermes-personal-replay");
  assert.deepEqual(replay.base, completedPersonalReplayPin);
  assert.equal(replay.controllerSource, controller);
  assert.equal(replay.runtimeRoot, runtime);
  assert.equal(runtime, completedPersonalReplayPin.runtimeRoot);
  assert.equal(candidate.controllerSource, completedPersonalReplayPin.sourceRevision);
  assert.equal(identity.sha256, completedPersonalReplayPin.candidateReceiptSha256);
  assert.equal(candidate.inventorySha256, completedPersonalReplayPin.inventorySha256);
  for (const key of [
    "completeZipVerified",
    "completeNestedArchiveVerified",
    "sourceBuildProvenanceVerified",
  ])
    assert.equal(replay[key], true);
  for (const key of [
    "runtimeRebuilt",
    "runtimeRelocated",
    "runtimeExported",
    "runtimeExecutionQualified",
    "installedAcceptance",
  ])
    assert.equal(replay[key], false);
  assert.equal(replay.before.allFilesAndDirectoriesVerified, true);
  assert.equal(replay.before.inventorySha256, completedPersonalReplayPin.inventorySha256);
  assert.equal(replay.before.files, candidate.fileCount);
  assert.equal(replay.before.logicalBytes, candidate.logicalBytes);
}

export function verifyPersonalReplayInventory(
  runtime: string,
  expected: any,
  inventorySha256: string,
) {
  const started = performance.now();
  const rootStat = fs.lstatSync(runtime);
  assert(rootStat.isDirectory() && !rootStat.isSymbolicLink());
  const files = new Map(expected.files.map((row: any) => [row.path, row]));
  const directories = new Set(expected.directories);
  const seenFiles = new Set<string>(),
    seenDirectories = new Set<string>();
  const walk = (relative: string) => {
    for (const name of fs.readdirSync(path.join(runtime, relative))) {
      const item = relative ? relative + "/" + name : name;
      const file = path.join(runtime, item);
      const stat = fs.lstatSync(file);
      assert(!stat.isSymbolicLink(), "A replay runtime entry became a link");
      if (stat.isDirectory()) {
        assert(directories.has(item), "An unrecorded replay directory appeared");
        seenDirectories.add(item);
        walk(item);
      } else {
        const row: any = files.get(item);
        assert(stat.isFile() && row && !row.linkTarget, "An unrecorded replay file appeared");
        assert.equal(stat.size, row.bytes, item);
        assert.equal(fileIdentity(file).sha256, row.sha256, item);
        seenFiles.add(item);
      }
    }
  };
  walk("");
  assert.equal(seenFiles.size, files.size);
  assert.equal(seenDirectories.size, directories.size);
  return {
    allFilesAndDirectoriesVerified: true,
    files: seenFiles.size,
    logicalBytes: expected.files.reduce((n: number, row: any) => n + row.bytes, 0),
    inventorySha256,
    elapsedMs: performance.now() - started,
  };
}

function loadDerivedPersonalInputs(
  file: string,
  runtime: string,
  sourceRevision: string,
  proof: any,
  build: any,
  mxcBuild: any,
  replay: any = null,
) {
  const candidate = receiptDocument(file);
  const directory = path.dirname(file);
  const referenced = (reference: any, expectedName: string) => {
    assert.equal(reference.file, expectedName);
    assert(Number.isSafeInteger(reference.bytes) && reference.bytes > 0);
    assert.match(reference.sha256, /^[a-f0-9]{64}$/u);
    const document = receiptDocument(path.join(directory, expectedName));
    assert.equal(document.bytes, reference.bytes);
    assert.equal(document.sha256, reference.sha256);
    return document;
  };
  const derivation = referenced(candidate.value.derivation, "candidate-derivation.json");
  const wheel = referenced(derivation.value.pywinpty, "pywinpty-rebuild.json");
  const git = referenced(derivation.value.git, "canonical-git-derivation.json");
  const compatibility = referenced(derivation.value.compatibility, "msys-build.json");
  const compatibilityProof = referenced(
    derivation.value.compatibilityProof,
    "bash-compatibility-proof.json",
  );
  const mxc = referenced(derivation.value.mxc, "mxc-build.json");
  if (replay)
    validatePersonalReplayInput(replay, candidate.value, candidate, runtime, sourceRevision);
  else {
    assert.deepEqual(compatibility.value, build);
    assert.deepEqual(compatibilityProof.value, proof);
    assert.deepEqual(mxc.value, mxcBuild);
  }
  const inventory = receiptDocument(path.join(directory, "payload-inventory.json"));
  assert.equal(inventory.sha256, candidate.value.inventorySha256);
  const adapterSha256 = fileIdentity(
    fileURLToPath(new URL("./nemoclaw_native_windows.py", import.meta.url)),
  ).sha256;
  const indexed = validateDerivedPersonalHeader(
    candidate.value,
    derivation.value,
    inventory.value,
    wheel.value,
    git.value,
    replay ? completedPersonalReplayPin.sourceRevision : sourceRevision,
    runtime,
    adapterSha256,
    compatibilityProof.value,
  );
  assert.equal(
    fs.existsSync(derivation.value.originalBuildRoot),
    false,
    "The original canonical build root must remain absent.",
  );
  const marker = receiptDocument(path.join(runtime, "nemoclaw-windows-runtime.json"));
  assert.deepEqual(marker.value.startupAdapterUpgrade, derivation.value.adapterUpgrade);
  const hooks = [
    "hermes-agent/.hermes-runtime/python/cpython-3.11.16-windows-aarch64-none/Lib/site-packages/nemoclaw_native_windows.py",
    "hermes-agent/venv/Lib/site-packages/nemoclaw_native_windows.py",
    "tools/browser-use/Lib/site-packages/nemoclaw_native_windows.py",
  ];
  assert.deepEqual(derivation.value.adapterUpgrade.hookPaths, hooks);
  const inspect = new Set<string>([
    ...personalCriticalFiles,
    ...hooks,
    ...wheel.value.replacement.installedFiles.map((row: any) => row.path),
    ...compatibility.value.files.map((row: any) => "mxc-compat/" + row.file),
    "mxc-compat/DETOURS-LICENSE.txt",
    "mxc-compat/build-receipt.json",
    "nemoclaw-windows-runtime.json",
  ]);
  for (const name of inspect) {
    const expected = indexed.get(name);
    assert(
      expected && Number.isSafeInteger(expected.bytes) && /^[a-f0-9]{64}$/u.test(expected.sha256),
    );
    const actual = fileIdentity(path.join(runtime, name));
    assert.equal(actual.bytes, expected.bytes, name);
    assert.equal(actual.sha256, expected.sha256, name);
    if (hooks.includes(name)) assert.equal(actual.sha256, adapterSha256);
  }
  return {
    candidate,
    derivation,
    documents: [wheel, git, compatibility, compatibilityProof, mxc, inventory].map((document) => ({
      path: document.path,
      bytes: document.bytes,
      sha256: document.sha256,
    })),
    criticalFiles: personalCriticalFiles.map((name) => indexed.get(name)),
    inventoryValue: inventory.value,
  };
}

export function personalRequest(
  node: string,
  worker: string,
  runtime: string,
  share: string,
  nonce: string,
  windows: string,
  nativeRoot = path.win32.join(runtime, "mxc-compat"),
) {
  if (
    !/^[a-f0-9]{24}$/u.test(nonce) ||
    [node, worker, runtime, share, windows].some((value) => /["\r\n]/u.test(value))
  )
    throw new Error("Invalid Personal probe identity or path.");
  if (
    share !==
      path.win32.join(
        path.win32.parse(runtime).root,
        `NemoClawMsysProof-${nonce.slice(0, 12)}-state-start`,
      ) ||
    path.win32.dirname(node) !== path.win32.dirname(worker)
  )
    throw new Error("Invalid admitted Personal probe state or launcher path.");
  const externalNativeRoot = path.win32.join(
    path.win32.parse(runtime).root,
    `NemoClawPersonalCompat-${nonce.slice(0, 12)}`,
  );
  if (nativeRoot !== path.win32.join(runtime, "mxc-compat") && nativeRoot !== externalNativeRoot)
    throw new Error("The current native component is outside its owned replay stage.");
  const home = path.win32.join(share, "home");
  const temp = path.win32.join(share, "temp");
  const environment = {
    GITHUB_ACTIONS: "true",
    NEMOCLAW_MSYS_TOKEN_INSPECTION_HOLD: "repair-query",
    NEMOCLAW_MSYS_DIAGNOSTICS: "0",
    AGENT_BROWSER_ARGS: "--enable-logging=stderr",
    NEMOCLAW_MSYS_ASLR_METADATA: "1",
    NODE_DISABLE_COMPILE_CACHE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    COMSPEC: path.win32.join(windows, "System32/cmd.exe"),
    HERMES_HOME: home,
    NEMOCLAW_AGENT_HOME: share,
    HOME: home,
    USERPROFILE: home,
    APPDATA: home,
    LOCALAPPDATA: home,
    HERMES_GIT_BASH_PATH: path.win32.join(runtime, "git/bin/bash.exe"),
    HERMES_DISABLE_LAZY_INSTALLS: "1",
    UV_OFFLINE: "1",
    PIP_NO_INDEX: "1",
    TEMP: temp,
    TMP: temp,
    OS: "Windows_NT",
    PROCESSOR_ARCHITECTURE: "ARM64",
    SYSTEMROOT: windows,
    WINDIR: windows,
    SYSTEMDRIVE: path.win32.parse(windows).root.slice(0, 2),
    PATHEXT: ".COM;.EXE;.BAT;.CMD;",
    PATH: ["bin", "node", "hermes-agent/venv/Scripts", "git/cmd", "git/bin", "git/usr/bin"]
      .map((value) => path.win32.join(runtime, value))
      .concat([path.win32.join(windows, "System32"), windows])
      .join(";"),
  };
  return {
    version: "0.6.0-alpha",
    containerId: `nm-${nonce.slice(0, 12)}-start`,
    containment: "processcontainer",
    process: {
      commandLine: [
        path.win32.join(nativeRoot, "NemoClawMsysLauncher.exe"),
        "--",
        node,
        "--experimental-strip-types",
        "--no-warnings",
        worker,
        runtime,
        path.win32.join(share, "result.json"),
        nonce,
        path.win32.join(path.win32.dirname(worker), "personal-workload-input.json"),
      ]
        .map((value) => `"${value}"`)
        .join(" "),
      cwd: share,
      timeout: 120_000,
      env: Object.entries(environment).map(([key, value]) => `${key}=${value}`),
    },
    processContainer: {
      leastPrivilege: false,
      capabilities: ["privateNetworkClientServer", "internetClient"],
    },
    ui: { disable: false },
    network: {
      defaultPolicy: "allow",
      allowedHosts: [],
      blockedHosts: [],
      allowLocalNetwork: true,
    },
    filesystem: {
      readonlyPaths: [
        runtime,
        path.win32.dirname(worker),
        ...(nativeRoot === externalNativeRoot ? [nativeRoot] : []),
      ],
      readwritePaths: [share],
    },
    lifecycle: { destroyOnExit: false, preservePolicy: false },
  };
}

function argument(name: string) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1] || process.argv[index + 1]!.startsWith("--"))
    throw new Error(`Missing ${name}.`);
  return path.resolve(process.argv[index + 1]!);
}

export function directBrowserRequest(
  primary: ReturnType<typeof personalRequest>,
  runtime: string,
  script: string,
  nonce: string,
) {
  assert.match(nonce, /^[a-f0-9]{24}$/u);
  assert([runtime, script].every((value) => !/["\r\n]/u.test(value)));
  assert(primary.filesystem.readonlyPaths.includes(runtime));
  assert(primary.filesystem.readonlyPaths.includes(path.win32.dirname(script)));
  assert.equal(path.win32.basename(script), "probe-personal-python.py");
  assert.equal(primary.process.timeout, 120_000);
  const share = path.win32.join(
    path.win32.parse(runtime).root,
    `NemoClawMsysProof-${nonce.slice(0, 12)}-state-start`,
  );
  assert.notEqual(share, primary.process.cwd);
  const request = structuredClone(primary);
  request.containerId = `nm-${nonce.slice(0, 12)}-start`;
  assert.notEqual(request.containerId, primary.containerId);
  request.process.cwd = share;
  request.filesystem.readwritePaths = [share];
  request.process.commandLine = [
    path.win32.join(runtime, "hermes-agent/venv/Scripts/python.exe"),
    "-I",
    "-B",
    script,
    "browser",
    runtime,
    nonce,
  ]
    .map((value) => `"${value}"`)
    .join(" ");
  const home = path.win32.join(share, "home");
  const state: Record<string, string> = {
    HERMES_HOME: home,
    HOME: home,
    USERPROFILE: home,
    APPDATA: home,
    LOCALAPPDATA: home,
    NEMOCLAW_AGENT_HOME: share,
    TEMP: path.win32.join(share, "temp"),
    TMP: path.win32.join(share, "temp"),
  };
  request.process.env = request.process.env.map((entry) => {
    const key = entry.slice(0, entry.indexOf("="));
    return key in state ? `${key}=${state[key]}` : entry;
  });
  return request;
}

export function stockBrowserEnvironment(environment: NodeJS.ProcessEnv) {
  const stock = { ...environment };
  delete stock.NEMOCLAW_MSYS_TOKEN_INSPECTION;
  return stock;
}

export function validateStockBrowserExecutor(identity: ReturnType<typeof fileIdentity>) {
  assert.equal(identity.sha256, "dde1c592270e9a659b01dccad70362da7b99fec114885fa4d625507aa775a503");
  assert.equal(identity.peMachine, 0xaa64);
  assert(Number.isSafeInteger(identity.bytes) && identity.bytes > 0);
  return identity;
}

export async function directBrowserDiagnostic(
  primary: ReturnType<typeof personalRequest>,
  runtime: string,
  script: string,
  mxc: string,
  environment: NodeJS.ProcessEnv,
  output: string,
  nonce: string,
  expectedPython: { bytes: number; sha256: string },
  command: typeof personalCommand = personalCommand,
  executorVariant: "patched" | "stock" | "stock-debug" = "patched",
) {
  const request = directBrowserRequest(primary, runtime, script, nonce);
  const share = request.process.cwd;
  let owned = false,
    attempted = false,
    outputOwned = false;
  const cleanup = {
    executorClosed: true,
    profileDeletionClosed: true,
    profileDeleted: true,
    ownedRootRemoved: true,
  };
  const record: Record<string, any> = {
    schemaVersion: 1,
    classification: "canonical-Personal-direct-Python-browser-diagnostic",
    diagnosticOnly: true,
    executorVariant,
    debuggerAttached: executorVariant === "stock-debug",
    debuggerMayChangeBehavior: executorVariant === "stock-debug",
    hostEnvironmentDifferences:
      executorVariant !== "patched" ? ["NEMOCLAW_MSYS_TOKEN_INSPECTION omitted"] : [],
    compatibilityLauncherUsed: false,
    dllAbsenceIndependentlyVerified: false,
    changedDimensions: [
      "compatibility launcher omitted",
      "intermediate Node controller omitted",
      "no concurrent sibling probes",
      "fresh owned state and profile",
      ...(executorVariant === "stock-debug"
        ? ["DEBUG_PROCESS observer and owned kill-on-close Job"]
        : []),
    ],
    comparisonLimits: [
      "Direct Python also omits the intermediate Node controller and concurrent sibling probes.",
      "Success does not uniquely attribute the primary failure to DLL injection.",
    ],
    canonicalQualification: false,
    installedAcceptance: false,
    nonce,
    runtime,
    cleanup,
    operationSucceeded: false,
    execution: null,
    result: null,
    error: null,
    cleanupErrors: [],
  };
  try {
    fs.mkdirSync(output);
    outputOwned = true;
    const python = fileIdentity(path.win32.join(runtime, "hermes-agent/venv/Scripts/python.exe"));
    assert.equal(python.bytes, expectedPython.bytes);
    assert.equal(python.sha256, expectedPython.sha256);
    assert.equal(python.peMachine, 0xaa64);
    record.python = python;
    record.executor = fileIdentity(mxc);
    if (executorVariant !== "patched") {
      validateStockBrowserExecutor(record.executor);
      assert.equal(environment.NEMOCLAW_MSYS_TOKEN_INSPECTION, undefined);
      record.stockSdk = {
        version: "0.8.0",
        archiveSha256: "06bb2399d7e98ab1907acf851e12a4e44748dd467b79d3e53c2f2fbf569da14e",
      };
    }
    record.probe = fileIdentity(script);
    fs.mkdirSync(share);
    owned = true;
    cleanup.ownedRootRemoved = false;
    for (const name of ["home", "temp"]) fs.mkdirSync(path.win32.join(share, name));
    const policy = path.join(output, "request.json");
    const bytes = JSON.stringify(request, null, 2) + "\n";
    fs.writeFileSync(policy, bytes, { flag: "wx" });
    record.requestSha256 = createHash("sha256").update(bytes).digest("hex");
    attempted = true;
    cleanup.executorClosed = false;
    cleanup.profileDeleted = false;
    const execution = await command(
      mxc,
      [policy, "--log-file", path.join(output, "mxc-native.log")],
      environment,
      share,
      120_000,
    );
    record.execution = execution;
    cleanup.executorClosed = execution.childClosed;
    record.result = parseComponent(execution.stdout, "browser", nonce);
    record.operationSucceeded =
      record.result.passed === true &&
      execution.exitCode === 0 &&
      execution.childClosed &&
      !execution.timedOut &&
      !execution.outputExceeded &&
      !execution.error;
  } catch (error) {
    record.error = errorDetail(error);
  } finally {
    if (attempted && cleanup.executorClosed) {
      cleanup.profileDeletionClosed = false;
      try {
        const deletion = await command(
          mxc,
          ["--delete", "--containername", request.containerId],
          environment,
          path.win32.parse(runtime).root,
        );
        record.profileDeletion = deletion;
        cleanup.profileDeletionClosed = deletion.childClosed;
        cleanup.profileDeleted =
          deletion.exitCode === 0 &&
          deletion.childClosed &&
          !deletion.error &&
          !deletion.timedOut &&
          !deletion.outputExceeded;
        if (!cleanup.profileDeleted)
          record.cleanupErrors.push("The diagnostic profile did not delete successfully.");
      } catch (error) {
        record.cleanupErrors.push(errorDetail(error));
      }
    }
    if (owned && cleanup.executorClosed && cleanup.profileDeletionClosed) {
      const removed = removePersonalRoots([share], attempted, true);
      cleanup.ownedRootRemoved = removed.removed;
      record.cleanupErrors.push(...removed.errors);
    }
    record.attempted = attempted;
    record.childrenClosed = cleanup.executorClosed && cleanup.profileDeletionClosed;
    record.cleanupComplete =
      record.childrenClosed &&
      cleanup.profileDeleted &&
      cleanup.ownedRootRemoved &&
      record.cleanupErrors.length === 0;
    if (outputOwned) {
      try {
        fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(record, null, 2) + "\n", {
          flag: "wx",
        });
      } catch (error) {
        record.receiptWriteError = errorDetail(error);
      }
    }
  }
  return record;
}

export function stockDebugCompletion(record: any, request: any, supervisorClosed: boolean) {
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.classification, "stock-MXC-browser-debug-result");
  assert.equal(record.diagnosticOnly, true);
  assert.equal(record.canonicalQualification, false);
  assert.equal(record.nonce, request.nonce);
  assert.equal(record.policySha256, request.policySha256);
  assert.equal(
    record.executorIdentityAfter?.sha256,
    "dde1c592270e9a659b01dccad70362da7b99fec114885fa4d625507aa775a503",
  );
  const closed =
    supervisorClosed &&
    record.childrenClosed === true &&
    record.cleanupComplete === true &&
    record.cleanup?.captureClosed === true &&
    record.cleanup?.handlesClosed === true &&
    record.cleanup?.activeProcesses === 0 &&
    Array.isArray(record.cleanup?.errors) &&
    record.cleanup.errors.length === 0 &&
    Array.isArray(record.remainingDebugProcesses) &&
    record.remainingDebugProcesses.length === 0;
  return closed;
}

function stockDebugCommand(
  controllerPython: string,
  runtime: string,
  probe: string,
  nonce: string,
): typeof personalCommand {
  return async (executable, args, environment, cwd, timeout) => {
    // The existing direct-browser owner still owns profile deletion/state cleanup.
    if (args[0] === "--delete") return personalCommand(executable, args, environment, cwd, timeout);
    assert.equal(args.length, 3);
    assert.equal(args[1], "--log-file");
    const directory = path.dirname(args[0]!);
    const helper = fileURLToPath(new URL("./probe-stock-browser-debug.py", import.meta.url));
    const sharedOwner = fileURLToPath(new URL("./probe-host-browser.py", import.meta.url));
    const controller = fileIdentity(controllerPython);
    assert.equal(
      controller.sha256,
      "54e17da389d3aae8c56b08a06fea5cd2f5acd57d2a7acb4061fc572964d4108b",
    );
    const ownerInputs = {
      controller,
      helper: fileIdentity(helper),
      sharedOwner: fileIdentity(sharedOwner),
    };
    const request = {
      schemaVersion: 1,
      classification: "stock-MXC-browser-debug-request",
      executor: executable,
      policyFile: args[0],
      policySha256: fileIdentity(args[0]!).sha256,
      logFile: args[2],
      environment,
      runtimeRoot: runtime,
      probeFile: probe,
      nonce,
    };
    const requestFile = path.join(directory, "debug-owner-request.json");
    const resultFile = path.join(directory, "debug-owner-result.json");
    fs.writeFileSync(requestFile, JSON.stringify(request, null, 2) + "\n", { flag: "wx" });
    const identity = fileIdentity(requestFile);
    const supervisor = await personalCommand(
      controllerPython,
      ["-I", "-B", helper, "--request", requestFile, "--output", resultFile],
      environment,
      path.win32.parse(runtime).root,
      135_000,
    );
    fs.writeFileSync(
      path.join(directory, "debug-owner-supervisor.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          diagnosticOnly: true,
          ownerInputs,
          requestIdentity: identity,
          supervisor,
        },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    );
    const receipt = receiptDocument(resultFile);
    assert.equal(receipt.value.requestSha256, identity.sha256);
    const childClosed = stockDebugCompletion(receipt.value, request, supervisor.childClosed);
    const native = receipt.value.execution;
    assert.equal(native.executable, executable);
    assert.deepEqual(native.args, args);
    assert.equal(typeof native.stdout, "string");
    assert.equal(typeof native.stderr, "string");
    return {
      ...native,
      signal: null,
      childClosed,
      timedOut: native.timedOut || supervisor.timedOut,
      outputExceeded: native.outputExceeded || supervisor.outputExceeded,
      error: native.error ?? supervisor.error,
      nativeStderr: "",
      nativeStderrBytes: 0,
      nativeStderrSha256: "",
      nativeRecordCount: 0,
      nativeOutputExceeded: false,
      nativeParseErrors: [],
      debugOwner: { ownerInputs, requestIdentity: identity, receipt, supervisor },
    };
  };
}

export function removePersonalRoots(
  directories: string[],
  attempted: boolean,
  executorClosed: boolean,
) {
  const errors: unknown[] = [];
  if (!attempted || executorClosed) {
    for (const directory of directories) {
      try {
        fs.rmSync(directory, { recursive: true, force: true });
      } catch (error) {
        errors.push(errorDetail(error));
      }
    }
  }
  return { removed: directories.every((directory) => !fs.existsSync(directory)), errors };
}

export function hostBrowserCompletion(record: any, request: any, supervisorClosed: boolean) {
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.classification, "canonical-host-browser-diagnostic");
  assert.equal(record.diagnosticOnly, true);
  assert.equal(record.canonicalQualification, false);
  assert.equal(record.installedAcceptance, false);
  for (const key of ["nonce", "runtimeRoot", "stateRoot"]) assert.equal(record[key], request[key]);
  if (record.result) {
    assert.equal(record.result.schemaVersion, 1);
    assert.equal(record.result.component, "browser");
    assert.equal(record.result.nonce, request.nonce);
  }
  const childClosed =
    record.processCreated === false ||
    (record.processCreated === true &&
      record.execution?.childClosed === true &&
      record.job?.created === true &&
      record.job.limitFlags === 8192 &&
      record.job.assignedBeforeResume === true &&
      record.job.rootMembershipVerified === true &&
      record.job.activeAfterCleanup === 0 &&
      record.cleanup?.captureClosed === true);
  const childrenClosed = supervisorClosed && record.childrenClosed === true && childClosed;
  const cleanupComplete =
    childrenClosed &&
    record.cleanupComplete === true &&
    [
      "captureClosed",
      "processHandleClosed",
      "threadHandleClosed",
      "jobHandleClosed",
      "stateRemoved",
    ].every((key) => record.cleanup?.[key] === true) &&
    Array.isArray(record.cleanup?.errors) &&
    record.cleanup.errors.length === 0;
  return { childrenClosed, cleanupComplete };
}

async function hostBrowserDiagnostic(
  primary: ReturnType<typeof personalRequest>,
  runtime: string,
  script: string,
  controllerPython: string,
  environment: NodeJS.ProcessEnv,
  output: string,
  expectedPython: { bytes: number; sha256: string },
) {
  const nonce = randomBytes(12).toString("hex");
  const stateRoot = path.win32.join(
    path.win32.parse(runtime).root,
    `NemoClawBrowserHost-${nonce.slice(0, 12)}`,
  );
  const result: Record<string, any> = {
    schemaVersion: 1,
    classification: "Personal-host-browser-controller",
    executionContext: "ordinary host token inside an owned kill-on-close Job",
    diagnosticOnly: true,
    canonicalQualification: false,
    installedAcceptance: false,
    childrenClosed: true,
    cleanupComplete: true,
    operationSucceeded: false,
    execution: null,
    result: null,
    error: null,
    browserOperationTimeoutMs: 120_000,
    supervisorTimeoutMs: 135_000,
    supervisorBudget:
      "120s diagnostic work + 5s cleanup + startup/receipt margin; no agent startup timeout change",
  };
  try {
    fs.mkdirSync(output);
    const controller = fileIdentity(controllerPython);
    assert.equal(
      controller.sha256,
      "54e17da389d3aae8c56b08a06fea5cd2f5acd57d2a7acb4061fc572964d4108b",
    );
    result.controllerPython = controller;
    const helper = fileURLToPath(new URL("./probe-host-browser.py", import.meta.url));
    result.ownerHelper = fileIdentity(helper);
    const probe = fileIdentity(script);
    const hostEnvironment = Object.fromEntries(
      primary.process.env.map((entry) => {
        const split = entry.indexOf("=");
        return [entry.slice(0, split), entry.slice(split + 1)];
      }),
    );
    for (const key of ["HOME", "HERMES_HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"])
      hostEnvironment[key] = path.win32.join(stateRoot, "home");
    hostEnvironment.NEMOCLAW_AGENT_HOME = stateRoot;
    for (const key of ["TEMP", "TMP"]) hostEnvironment[key] = path.win32.join(stateRoot, "temp");
    const request = {
      schemaVersion: 1,
      classification: "canonical-host-browser-request",
      runtimeRoot: runtime,
      probeFile: script,
      stateRoot,
      nonce,
      environment: hostEnvironment,
      pythonIdentity: { bytes: expectedPython.bytes, sha256: expectedPython.sha256 },
      probeIdentity: { bytes: probe.bytes, sha256: probe.sha256 },
    };
    const policy = path.join(output, "request.json"),
      destination = path.join(output, "result.json");
    fs.writeFileSync(policy, JSON.stringify(request, null, 2) + "\n", { flag: "wx" });
    result.request = fileIdentity(policy);
    result.childrenClosed = false;
    result.cleanupComplete = false;
    const execution = await personalCommand(
      controllerPython,
      ["-I", "-B", helper, "--request", policy, "--output", destination],
      stockBrowserEnvironment(environment),
      path.win32.parse(runtime).root,
      135_000,
    );
    result.execution = execution;
    const receipt = receiptDocument(destination);
    result.receipt = receipt;
    assert.equal(receipt.value.requestSha256, result.request.sha256);
    Object.assign(result, hostBrowserCompletion(receipt.value, request, execution.childClosed));
    result.result = receipt.value.result;
    result.operationSucceeded =
      result.childrenClosed &&
      result.cleanupComplete &&
      receipt.value.result?.passed === true &&
      receipt.value.execution?.exitCode === 0 &&
      receipt.value.execution?.timedOut === false &&
      receipt.value.execution?.outputExceeded === false &&
      execution.exitCode === 0 &&
      !execution.timedOut &&
      !execution.outputExceeded &&
      !execution.error;
  } catch (error) {
    result.error = errorDetail(error);
  }
  return result;
}

export function publishPersonalReceipt(
  file: string,
  receipt: Record<string, unknown>,
  primary: unknown,
  report: (value: unknown) => void = console.error,
) {
  if (primary) report({ primary: errorDetail(primary) });
  try {
    fs.writeFileSync(file, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
    return true;
  } catch (error) {
    report({ receiptWriteError: errorDetail(error) });
    return false;
  }
}

async function main() {
  if (
    process.platform !== "win32" ||
    process.arch !== "arm64" ||
    process.env.GITHUB_ACTIONS !== "true" ||
    !/^[a-f0-9]{40}$/u.test(process.env.GITHUB_SHA ?? "")
  )
    throw new Error("The Personal candidate probe requires disposable Windows ARM64 CI.");
  const runtime = fs.realpathSync(argument("--runtime-root"));
  const mxc = argument("--mxc");
  const stockMxc = argument("--stock-mxc");
  const hostControllerPython = argument("--host-controller-python");
  const compatibilityRoot = fs.realpathSync(argument("--compatibility-root"));
  const compatibilityReceipt = argument("--compatibility-receipt");
  const compatibilityProof = argument("--compatibility-proof");
  const mxcBuildReceipt = argument("--mxc-build-receipt");
  const derivedRuntimeReceipt = argument("--derived-runtime-receipt");
  const replayDocument = process.argv.includes("--replay-receipt")
    ? receiptDocument(argument("--replay-receipt"))
    : null;
  const output = argument("--output");
  const windows = path.dirname(process.env.ComSpec ?? process.env.COMSPEC ?? "");
  const windowsRoot = path.dirname(windows);
  if (
    !/^[A-Za-z]:\\NemoClawHermesProbe-[a-f0-9]{12}$/u.test(runtime) ||
    !/^[A-Za-z]:\\Windows$/iu.test(windowsRoot)
  )
    throw new Error("The candidate and Windows roots differ from the owned probe contract.");
  if (!replayDocument && compatibilityRoot !== path.join(runtime, "mxc-compat"))
    throw new Error("Compatibility binaries must remain inside the read-only canonical runtime.");
  fs.mkdirSync(output);
  const nonce = randomBytes(12).toString("hex");
  const root = path.parse(runtime).root;
  const launcher = path.join(root, `NemoClawPersonalNode-${nonce.slice(0, 12)}`);
  const share = path.join(root, `NemoClawMsysProof-${nonce.slice(0, 12)}-state-start`);
  const hostScratch = path.join(root, `NemoClawBashHost-${nonce.slice(0, 12)}`);
  const currentNativeRoot = replayDocument
    ? path.join(root, `NemoClawPersonalCompat-${nonce.slice(0, 12)}`)
    : compatibilityRoot;
  let nativeRootCreated = false;
  let replayInventory: any;
  const stagedNativeFiles: any[] = [];
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    "SystemRoot",
    "SystemDrive",
    "WINDIR",
    "COMSPEC",
    "ComSpec",
    "OS",
    "TEMP",
    "TMP",
    "LOCALAPPDATA",
    "APPDATA",
    "USERPROFILE",
    "RUNNER_TRACKING_ID",
  ])
    if (process.env[key]) environment[key] = process.env[key];
  environment.PATH = path.join(windowsRoot, "System32");
  environment.GITHUB_ACTIONS = "true";
  environment.NEMOCLAW_MSYS_TOKEN_INSPECTION = "repair-query";
  const cleanup = {
    executorClosed: false,
    hostDiagnosticChildrenClosed: true,
    profileDeleted: false,
    ownedRootsRemoved: false,
    browserDiagnosticComplete: true,
  };
  const receipt: Record<string, unknown> = {
    schemaVersion: 1,
    classification: "canonical-personal-mxc-feasibility",
    sourceRevision: process.env.GITHUB_SHA,
    runtime,
    installedAcceptance: false,
    fullAgentQualified: false,
    privateStateLeaseTested: false,
    feasibilityPassed: false,
    cleanup,
  };
  const errors: unknown[] = [];
  let attempted = false;
  let failure: unknown = null;
  let request: ReturnType<typeof personalRequest> | undefined;
  let compatibility: ReturnType<typeof validatePersonalCompatibility> | undefined;
  let browserDiagnosticChildrenClosed = true;
  try {
    const proof = JSON.parse(fs.readFileSync(compatibilityProof, "utf8"));
    const build = JSON.parse(fs.readFileSync(compatibilityReceipt, "utf8"));
    const mxcBuild = JSON.parse(fs.readFileSync(mxcBuildReceipt, "utf8"));
    compatibility = validatePersonalCompatibility(
      proof,
      build,
      mxcBuild,
      fileIdentity(
        fileURLToPath(new URL("../mxc-bash/mxc-token-inspection.patch", import.meta.url)),
      ).sha256,
    );
    assert(Array.isArray(build.sourceFiles) && build.sourceFiles.length > 0);
    for (const source of build.sourceFiles) {
      assert.equal(path.basename(source.path), source.path);
      assert.equal(
        fileIdentity(fileURLToPath(new URL("../mxc-bash/" + source.path, import.meta.url))).sha256,
        source.sha256,
      );
    }
    const derived = loadDerivedPersonalInputs(
      derivedRuntimeReceipt,
      runtime,
      process.env.GITHUB_SHA!,
      proof,
      build,
      mxcBuild,
      replayDocument?.value,
    );
    const { inventoryValue, ...derivedReceipt } = derived;
    replayInventory = inventoryValue;
    receipt.candidateSource = derived.candidate.value.controllerSource;
    receipt.derivedRuntime = derivedReceipt;
    if (replayDocument) receipt.runtimeReplay = { ...replayDocument.value, after: null };
    for (const file of [...compatibility.files, compatibility.license]) {
      const actual = fileIdentity(path.join(compatibilityRoot, file.file));
      if (actual.sha256 !== file.sha256 || actual.bytes !== file.bytes)
        throw new Error(`A proved compatibility file changed: ${file.file}`);
      if (file.machine && actual.architecture !== file.machine)
        throw new Error(`A proved compatibility architecture changed: ${file.file}`);
    }
    if (replayDocument) {
      fs.mkdirSync(currentNativeRoot);
      nativeRootCreated = true;
      for (const file of [
        ...compatibility.files,
        compatibility.license,
        { file: "build-receipt.json", ...fileIdentity(compatibilityReceipt) },
      ]) {
        const input =
          file.file === "build-receipt.json"
            ? compatibilityReceipt
            : path.join(compatibilityRoot, file.file);
        const target = path.join(currentNativeRoot, file.file);
        assert.equal(fileIdentity(input).sha256, file.sha256);
        fs.copyFileSync(input, target, fs.constants.COPYFILE_EXCL);
        const actual = fileIdentity(target);
        assert.equal(actual.bytes, file.bytes);
        assert.equal(actual.sha256, file.sha256);
        assert.equal(fileIdentity(input).sha256, file.sha256);
        stagedNativeFiles.push({ ...file, path: target });
      }
      const currentDocuments: Record<string, unknown> = {};
      for (const [kind, input, filename, value] of [
        ["proof", compatibilityProof, "current-native-proof.json", proof],
        ["compatibility", compatibilityReceipt, "current-msys-build.json", build],
        ["mxc", mxcBuildReceipt, "current-mxc-build.json", mxcBuild],
      ] as const) {
        const document = receiptDocument(input);
        assert.deepEqual(document.value, value);
        const saved = path.join(output, filename);
        fs.copyFileSync(input, saved, fs.constants.COPYFILE_EXCL);
        const actual = fileIdentity(saved);
        assert.equal(actual.bytes, document.bytes);
        assert.equal(actual.sha256, document.sha256);
        assert.equal(fileIdentity(input).sha256, document.sha256);
        currentDocuments[kind] = { file: filename, bytes: actual.bytes, sha256: actual.sha256 };
      }
      (receipt.runtimeReplay as any).nativeComponent = {
        root: currentNativeRoot,
        sourceRevision: compatibility.sourceRevision,
        proof: fileIdentity(compatibilityProof),
        build: fileIdentity(compatibilityReceipt),
        executor: fileIdentity(mxc),
        files: stagedNativeFiles,
        documents: currentDocuments,
      };
    }
    const nodeIdentity = fileIdentity(process.execPath);
    const mxcIdentity = fileIdentity(mxc);
    if (
      nodeIdentity.sha256 !== "97cce5301a815d2dce07ac5bfd1e6039eae88185ec1d10ae4f8cb712f1732878" ||
      mxcIdentity.sha256 !== compatibility.mxcFile.sha256 ||
      mxcIdentity.bytes !== compatibility.mxcFile.bytes ||
      mxcIdentity.peMachine !== 0xaa64
    )
      throw new Error("An executed host binary differs from its immutable pin.");
    receipt.hostInputs = { node: nodeIdentity, mxc: mxcIdentity, compatibility };
    receipt.inputReceipts = [
      compatibilityProof,
      compatibilityReceipt,
      mxcBuildReceipt,
      derivedRuntimeReceipt,
    ].map(fileIdentity);
    fs.mkdirSync(launcher);
    fs.mkdirSync(share);
    fs.mkdirSync(hostScratch);
    for (const name of ["home", "temp"]) fs.mkdirSync(path.join(share, name));
    for (const name of ["home", "temp"]) fs.mkdirSync(path.join(hostScratch, name));
    fs.copyFileSync(process.execPath, path.join(launcher, "node.exe"));
    for (const name of [
      "probe-component-workload.mts",
      "probe-personal-workload.mts",
      "probe-personal-python.py",
    ])
      fs.copyFileSync(
        fileURLToPath(new URL("./" + name, import.meta.url)),
        path.join(launcher, name),
      );
    const workloadInput = validatePersonalWorkloadInput(
      {
        schemaVersion: 1,
        nonce,
        runtime,
        compatibilityProofSource: compatibility.sourceRevision,
        gitPins: compatibility.gitPins,
        files: derived.criticalFiles,
      },
      runtime,
      nonce,
    );
    fs.writeFileSync(
      path.join(launcher, "personal-workload-input.json"),
      JSON.stringify(workloadInput, null, 2) + "\n",
      { flag: "wx" },
    );
    request = personalRequest(
      path.join(launcher, "node.exe"),
      path.join(launcher, "probe-personal-workload.mts"),
      runtime,
      share,
      nonce,
      windowsRoot,
      currentNativeRoot,
    );
    const policy = path.join(output, "personal-request.json");
    const bytes = JSON.stringify(request, null, 2) + "\n";
    fs.writeFileSync(policy, bytes, { flag: "wx" });
    receipt.requestSha256 = createHash("sha256").update(bytes).digest("hex");
    attempted = true;
    const execution = await personalCommand(
      mxc,
      [policy, "--log-file", path.join(output, "mxc-native.log")],
      environment,
      share,
      120_000,
    );
    receipt.execution = execution;
    cleanup.executorClosed = execution.childClosed;
    const result = path.join(share, "result.json");
    if (fs.existsSync(result)) {
      fs.copyFileSync(result, path.join(output, "workload.json"));
      receipt.workload = JSON.parse(fs.readFileSync(result, "utf8"));
    }
    if (execution.childClosed) {
      // Run the same bytes after containment has ended, so a host process
      // cannot initialize MSYS state before the canonical contained attempt.
      const hostEnvironment = Object.fromEntries(
        request.process.env.map((value) => {
          const split = value.indexOf("=");
          return [value.slice(0, split), value.slice(split + 1)];
        }),
      );
      for (const key of ["HOME", "HERMES_HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"])
        hostEnvironment[key] = path.join(hostScratch, "home");
      for (const key of ["TEMP", "TMP"]) hostEnvironment[key] = path.join(hostScratch, "temp");
      cleanup.hostDiagnosticChildrenClosed = false;
      const diagnostic = await bashDiagnostics(
        runtime,
        hostScratch,
        nonce,
        hostEnvironment,
        "host",
        compatibility.gitPins,
      );
      receipt.hostBashDiagnostic = diagnostic;
      cleanup.hostDiagnosticChildrenClosed = diagnostic.childrenClosed;
    }
    if (
      execution.exitCode !== 0 ||
      execution.timedOut ||
      execution.outputExceeded ||
      execution.error ||
      !execution.childClosed
    )
      throw new Error("The owned MXC executor did not finish successfully; see its exact output.");
    const workload = receipt.workload as
      | { nonce?: string; passed?: boolean; components?: unknown[] }
      | undefined;
    if (workload?.nonce !== nonce || workload.passed !== true || workload.components?.length !== 4)
      throw new Error("One or more canonical Personal component operations failed.");
    const log = fs
      .readFileSync(path.join(output, "mxc-native.log"), "utf8")
      .replace(/\[\d+\][ \t]*/gu, "");
    if (
      !/^selected isolation tier:\s*appcontainer-dacl\s*$/mu.test(log) ||
      log.includes("Win32k mitigation applied to child process")
    )
      throw new Error(
        "The actual MXC log does not confirm the intended Personal UI-compatible tier.",
      );
    receipt.selectedTier = "appcontainer-dacl";
  } catch (error) {
    failure = error;
  } finally {
    if (attempted && cleanup.executorClosed && cleanup.hostDiagnosticChildrenClosed && request) {
      // This supplementary control cannot replace the primary component result.
      // Both comparisons share the one final immutable inventory check.
      try {
        const python = (receipt.derivedRuntime as any).criticalFiles.find(
          (file: any) => file.path === "hermes-agent/venv/Scripts/python.exe",
        );
        for (const [key, directory, executor, hostEnvironment, variant] of [
          ["directBrowserDiagnostic", "browser-direct-diagnostic", mxc, environment, "patched"],
          [
            "stockBrowserDiagnostic",
            "browser-stock-diagnostic",
            stockMxc,
            stockBrowserEnvironment(environment),
            "stock",
          ],
          [
            "stockDebugBrowserDiagnostic",
            "browser-stock-debug-diagnostic",
            stockMxc,
            stockBrowserEnvironment(environment),
            "stock-debug",
          ],
        ] as const) {
          if (!browserDiagnosticChildrenClosed) {
            receipt[key] = {
              diagnosticOnly: true,
              canonicalQualification: false,
              skipped: "A previous diagnostic child did not close.",
            };
            continue;
          }
          const diagnosticNonce = randomBytes(12).toString("hex");
          const probe = path.join(launcher, "probe-personal-python.py");
          const command =
            variant === "stock-debug"
              ? stockDebugCommand(hostControllerPython, runtime, probe, diagnosticNonce)
              : personalCommand;
          const diagnostic = await directBrowserDiagnostic(
            request,
            runtime,
            probe,
            executor,
            hostEnvironment,
            path.join(output, directory),
            diagnosticNonce,
            python,
            command,
            variant,
          );
          receipt[key] = diagnostic;
          browserDiagnosticChildrenClosed = diagnostic.childrenClosed;
          cleanup.browserDiagnosticComplete &&= diagnostic.cleanupComplete;
          if (!diagnostic.cleanupComplete)
            errors.push({ browserDiagnostic: key, cleanup: diagnostic.cleanup });
        }
        if (browserDiagnosticChildrenClosed) {
          const host = await hostBrowserDiagnostic(
            request,
            runtime,
            path.join(launcher, "probe-personal-python.py"),
            hostControllerPython,
            environment,
            path.join(output, "browser-host-diagnostic"),
            python,
          );
          receipt.hostBrowserDiagnostic = host;
          browserDiagnosticChildrenClosed = host.childrenClosed;
          cleanup.browserDiagnosticComplete &&= host.cleanupComplete;
          if (!host.cleanupComplete)
            errors.push({
              browserDiagnostic: "host",
              error: host.error,
              cleanup: host.receipt?.value?.cleanup,
            });
        } else {
          receipt.hostBrowserDiagnostic = {
            diagnosticOnly: true,
            canonicalQualification: false,
            skipped: "A previous diagnostic child did not close.",
          };
        }
      } catch (error) {
        // Before the helper returns, uncertain ownership must retain the runtime.
        browserDiagnosticChildrenClosed = false;
        cleanup.browserDiagnosticComplete = false;
        errors.push({ browserDiagnosticError: errorDetail(error) });
      }
    }
    if (attempted && cleanup.executorClosed && request) {
      try {
        const deletion = await personalCommand(
          mxc,
          ["--delete", "--containername", request.containerId],
          environment,
          root,
        );
        receipt.profileDeletion = deletion;
        cleanup.profileDeleted =
          deletion.exitCode === 0 &&
          deletion.childClosed &&
          !deletion.error &&
          !deletion.timedOut &&
          !deletion.outputExceeded;
      } catch (error) {
        errors.push(errorDetail(error));
      }
    }
    const allClosed =
      cleanup.executorClosed &&
      cleanup.hostDiagnosticChildrenClosed &&
      browserDiagnosticChildrenClosed;
    if (replayDocument && replayInventory && (!attempted || allClosed)) {
      try {
        (receipt.runtimeReplay as any).after = verifyPersonalReplayInventory(
          runtime,
          replayInventory,
          completedPersonalReplayPin.inventorySha256,
        );
        for (const file of stagedNativeFiles) {
          const actual = fileIdentity(file.path);
          assert.equal(actual.bytes, file.bytes);
          assert.equal(actual.sha256, file.sha256);
        }
        (receipt.runtimeReplay as any).nativeComponentUnchanged = true;
      } catch (error) {
        failure ??= error;
        errors.push(errorDetail(error));
      }
    }
    const roots = removePersonalRoots(
      [share, launcher, hostScratch, ...(nativeRootCreated ? [currentNativeRoot] : [])],
      attempted,
      allClosed,
    );
    errors.push(...roots.errors);
    cleanup.ownedRootsRemoved = roots.removed;
    receipt.executorAttempted = attempted;
    receipt.rootsRetainedForUnclosedExecutor = attempted && !allClosed;
    receipt.error = failure ? errorDetail(failure) : null;
    receipt.cleanupErrors = errors;
    receipt.feasibilityPassed =
      failure === null && errors.length === 0 && Object.values(cleanup).every(Boolean);
    const published = publishPersonalReceipt(
      path.join(output, "personal-feasibility.json"),
      receipt,
      failure,
    );
    if (!receipt.feasibilityPassed || !published) process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(errorDetail(error));
    process.exitCode = 1;
  });
}
