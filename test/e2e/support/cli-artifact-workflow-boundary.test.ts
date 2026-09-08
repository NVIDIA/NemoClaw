// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = path.join(import.meta.dirname, "..", "..", "..");
const CANDIDATE_SHA = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const PAYLOAD_SHA256 = "b".repeat(64);
const IDENTITY_SCRIPT = path.resolve("scripts/e2e/validate-cli-artifact-identity.sh");
const PACKAGE_SCRIPT = path.resolve("scripts/e2e/package-cli-artifact.sh");
const RESTORE_SCRIPT = path.resolve("scripts/e2e/restore-cli-artifact.sh");

function runIdentityValidation(overrides: Record<string, unknown> = {}, consumerAttempt = "1") {
  const workflowSha = "d".repeat(40);
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "cli-artifact-identity-"));
  try {
    const outputPath = path.join(outputDirectory, "github-output");
    const result = spawnSync(IDENTITY_SCRIPT, [], {
      encoding: "utf8",
      env: {
        ...process.env,
        CALLER_WORKFLOW_SHA: workflowSha,
        GITHUB_OUTPUT: outputPath,
        GITHUB_RUN_ATTEMPT: consumerAttempt,
        GITHUB_RUN_ID: "98765",
        PROVENANCE_JSON: JSON.stringify({
          kind: "nemoclaw-e2e-cli-provenance-v1",
          artifactDigest: "c".repeat(64),
          artifactId: "12345",
          artifactName: `nemoclaw-cli-${CANDIDATE_SHA}-${PAYLOAD_SHA256}`,
          candidateRepository: "NVIDIA/NemoClaw",
          candidateSha: CANDIDATE_SHA,
          payloadSha256: PAYLOAD_SHA256,
          runAttempt: "1",
          runId: "98765",
          workflowSha,
          ...overrides,
        }),
      },
    });
    return {
      ...result,
      outputs: fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "",
    };
  } finally {
    fs.rmSync(outputDirectory, { force: true, recursive: true });
  }
}

type RestoreFixtureOptions = {
  archive?:
    | "valid"
    | "cli-directory"
    | "functional-snapshot-sanitizer"
    | "missing-snapshot-helper"
    | "missing-snapshot-protocol"
    | "missing-shared"
    | "non-dist"
    | "link"
    | "managed-catalog"
    | "shared-module-directory"
    | "traversal";
  buildIdentitySha?: string;
  consumerRunAttempt?: string;
  expectedPayloadSha256?: string;
  manifestCandidateSha?: string;
  manifestRunAttempt?: string;
  preexistingDist?:
    | "dangling-symlink"
    | "directory"
    | "plugin-directory"
    | "symlinked-plugin-parent";
  producerRunAttempt?: string;
};

type ArchiveFixtureContext = {
  buildIdentitySha: string;
  payload: string;
  payloadRoot: string;
};

function sha256File(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function writeCliArchive(
  context: ArchiveFixtureContext,
  customizeDist: (dist: string) => void,
  customizeShared: (shared: string) => void = () => undefined,
): void {
  const dist = path.join(context.payloadRoot, "dist");
  const shared = path.join(context.payloadRoot, "nemoclaw", "dist", "shared");
  fs.mkdirSync(path.join(dist, "lib"), { recursive: true });
  fs.mkdirSync(path.join(dist, "nemoclaw", "blueprint"), { recursive: true });
  fs.mkdirSync(shared, { recursive: true });
  fs.writeFileSync(
    path.join(dist, "nemoclaw.js"),
    'require("../nemoclaw/dist/shared/sandbox-name.cjs");\nconsole.log("nemoclaw v0.0.0");\n',
  );
  fs.writeFileSync(
    path.join(dist, "build-identity.json"),
    `${JSON.stringify({
      nemoclawVersion: "0.0.0",
      sourceRevision: context.buildIdentitySha,
    })}\n`,
  );
  fs.writeFileSync(path.join(dist, "lib", "blueprint-runner.js"), "export {};\n");
  fs.writeFileSync(path.join(dist, "nemoclaw", "package.json"), '{"type":"module"}\n');
  fs.writeFileSync(path.join(dist, "nemoclaw", "blueprint", "runner.js"), "export {};\n");
  fs.writeFileSync(path.join(shared, "openshell-gateway-health-sdk.js"), "export {};\n");
  for (const boundary of [
    "openshell-observation-boundary.cjs",
    "openshell-policy-boundary.cjs",
    "sandbox-name.cjs",
    "snapshot-sanitizer-boundary.cjs",
    "snapshot-sanitizer-helper.mjs",
    "snapshot-sanitizer-protocol.cjs",
  ]) {
    fs.writeFileSync(path.join(shared, boundary), "module.exports = {};\n");
  }
  customizeShared(shared);

  customizeDist(dist);
  execFileSync("tar", [
    "-cf",
    context.payload,
    "-C",
    context.payloadRoot,
    "dist",
    "nemoclaw/dist/shared",
  ]);
}

function writeValidArchive(context: ArchiveFixtureContext): void {
  writeCliArchive(context, () => undefined);
}

function transpileArtifactModule(source: string, destination: string, module: ModuleKind): void {
  const output = transpileModule(fs.readFileSync(path.join(REPOSITORY_ROOT, source), "utf8"), {
    compilerOptions: {
      esModuleInterop: true,
      module,
      target: ScriptTarget.ES2022,
    },
    fileName: source,
  });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, output.outputText);
}

function writeFunctionalSnapshotSanitizerArchive(context: ArchiveFixtureContext): void {
  writeCliArchive(
    context,
    (dist) => {
      for (const module of ["credential-filter", "snapshot-sanitizer"]) {
        transpileArtifactModule(
          `src/lib/security/${module}.ts`,
          path.join(dist, "lib", "security", `${module}.js`),
          ModuleKind.CommonJS,
        );
      }
    },
    (shared) => {
      for (const module of [
        "credential-filter-boundary",
        "snapshot-sanitizer-boundary",
        "snapshot-sanitizer-protocol",
      ]) {
        transpileArtifactModule(
          `nemoclaw/src/shared/${module}.cts`,
          path.join(shared, `${module}.cjs`),
          ModuleKind.CommonJS,
        );
      }
      transpileArtifactModule(
        "nemoclaw/src/shared/snapshot-sanitizer-helper.mts",
        path.join(shared, "snapshot-sanitizer-helper.mjs"),
        ModuleKind.ES2022,
      );
    },
  );
}

function writeLinkArchive(context: ArchiveFixtureContext): void {
  writeCliArchive(context, (dist) => {
    fs.symlinkSync("nemoclaw.js", path.join(dist, "linked-cli.js"));
  });
}

const MANAGED_IMAGE_REVISION = "e".repeat(40);

function writeManagedCatalogArchive(context: ArchiveFixtureContext): void {
  writeCliArchive(context, (dist) => {
    fs.writeFileSync(
      path.join(dist, "e2e-managed-image-catalog.json"),
      `${JSON.stringify({
        openclaw: { source: { revision: MANAGED_IMAGE_REVISION } },
        hermes: { source: { revision: MANAGED_IMAGE_REVISION } },
      })}\n`,
    );
  });
}

function writeCliDirectoryArchive(context: ArchiveFixtureContext): void {
  writeCliArchive(context, (dist) => {
    const entrypoint = path.join(dist, "nemoclaw.js");
    fs.rmSync(entrypoint);
    fs.mkdirSync(entrypoint);
    fs.writeFileSync(path.join(entrypoint, "index.js"), 'console.log("nemoclaw v0.0.0");\n');
  });
}

function writeMissingSharedArchive(context: ArchiveFixtureContext): void {
  writeCliArchive(
    context,
    () => undefined,
    (shared) => fs.rmSync(path.join(shared, "sandbox-name.cjs")),
  );
}

function writeMissingSnapshotHelperArchive(context: ArchiveFixtureContext): void {
  writeCliArchive(
    context,
    () => undefined,
    (shared) => fs.rmSync(path.join(shared, "snapshot-sanitizer-helper.mjs")),
  );
}

function writeMissingSnapshotProtocolArchive(context: ArchiveFixtureContext): void {
  writeCliArchive(
    context,
    () => undefined,
    (shared) => fs.rmSync(path.join(shared, "snapshot-sanitizer-protocol.cjs")),
  );
}

function writeSharedModuleDirectoryArchive(context: ArchiveFixtureContext): void {
  writeCliArchive(
    context,
    () => undefined,
    (shared) => {
      const modulePath = path.join(shared, "sandbox-name.cjs");
      fs.rmSync(modulePath);
      fs.mkdirSync(modulePath);
      fs.writeFileSync(path.join(modulePath, "index.js"), "module.exports = {};\n");
    },
  );
}

function writeNonDistArchive(context: ArchiveFixtureContext): void {
  fs.writeFileSync(path.join(context.payloadRoot, "outside.txt"), "outside dist\n");
  execFileSync("tar", ["-cf", context.payload, "-C", context.payloadRoot, "outside.txt"]);
}

function writeTraversalArchive(context: ArchiveFixtureContext): void {
  fs.writeFileSync(path.join(context.payloadRoot, "outside.txt"), "outside dist\n");
  const transform =
    process.platform === "darwin"
      ? ["-s", "|^outside.txt$|dist/../outside.txt|"]
      : ["--transform=s|^outside.txt$|dist/../outside.txt|"];
  execFileSync("tar", [
    "-cf",
    context.payload,
    ...transform,
    "-C",
    context.payloadRoot,
    "outside.txt",
  ]);
}

const ARCHIVE_FIXTURE_WRITERS = {
  "cli-directory": writeCliDirectoryArchive,
  "functional-snapshot-sanitizer": writeFunctionalSnapshotSanitizerArchive,
  link: writeLinkArchive,
  "managed-catalog": writeManagedCatalogArchive,
  "missing-snapshot-helper": writeMissingSnapshotHelperArchive,
  "missing-snapshot-protocol": writeMissingSnapshotProtocolArchive,
  "missing-shared": writeMissingSharedArchive,
  "non-dist": writeNonDistArchive,
  "shared-module-directory": writeSharedModuleDirectoryArchive,
  traversal: writeTraversalArchive,
  valid: writeValidArchive,
} satisfies Record<
  NonNullable<RestoreFixtureOptions["archive"]>,
  (context: ArchiveFixtureContext) => void
>;

function writeDanglingDistSymlink(workspace: string): void {
  const dist = path.join(workspace, "dist");
  fs.symlinkSync("missing-dist", dist);
}

function writePreexistingDistDirectory(workspace: string): void {
  const dist = path.join(workspace, "dist");
  fs.mkdirSync(dist);
  fs.writeFileSync(path.join(workspace, "dist", "existing.txt"), "preserve\n");
}

function writePreexistingPluginDistDirectory(workspace: string): void {
  const shared = path.join(workspace, "nemoclaw", "dist", "shared");
  fs.mkdirSync(shared, { recursive: true });
  fs.writeFileSync(path.join(shared, "existing.cjs"), "module.exports = {};\n");
}

function writeSymlinkedPluginParent(workspace: string): void {
  const escaped = path.join(path.dirname(workspace), "escaped");
  fs.rmSync(path.join(workspace, "nemoclaw"), { force: true, recursive: true });
  fs.mkdirSync(escaped);
  fs.symlinkSync(escaped, path.join(workspace, "nemoclaw"), "dir");
}

const PREEXISTING_DIST_WRITERS = {
  "dangling-symlink": writeDanglingDistSymlink,
  directory: writePreexistingDistDirectory,
  "plugin-directory": writePreexistingPluginDistDirectory,
  "symlinked-plugin-parent": writeSymlinkedPluginParent,

  none: () => undefined,
} satisfies Record<
  NonNullable<RestoreFixtureOptions["preexistingDist"]> | "none",
  (workspace: string) => void
>;

function runRestoreValidation(options: RestoreFixtureOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cli-artifact-restore-"));
  const workspace = path.join(root, "workspace");
  const runnerTemp = path.join(root, "runner-temp");
  const artifactDirectory = path.join(runnerTemp, "nemoclaw-cli-artifact");
  const payloadRoot = path.join(root, "payload-root");
  const toolDirectory = path.join(root, "tools");
  fs.mkdirSync(path.join(workspace, "bin"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "nemoclaw"), { recursive: true });

  fs.mkdirSync(artifactDirectory, { recursive: true });
  fs.mkdirSync(payloadRoot, { recursive: true });
  fs.mkdirSync(toolDirectory, { recursive: true });
  fs.writeFileSync(path.join(workspace, "package-lock.json"), '{"lockfileVersion":3}\n');
  fs.writeFileSync(
    path.join(workspace, "bin", "nemoclaw.js"),
    '#!/usr/bin/env node\nrequire("../dist/nemoclaw.js");\n',
    { mode: 0o755 },
  );
  execFileSync("git", ["init", "--quiet"], { cwd: workspace });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/NVIDIA/NemoClaw.git"], {
    cwd: workspace,
  });
  execFileSync("git", ["add", "."], { cwd: workspace });
  execFileSync(
    "git",
    [
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=NemoClaw Test",
      "-c",
      "user.email=test@localhost",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ],
    { cwd: workspace },
  );
  const candidateSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: workspace,
    encoding: "utf8",
  }).trim();
  const sourceTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
    cwd: workspace,
    encoding: "utf8",
  }).trim();

  const nodeWrapper = path.join(toolDirectory, "node");
  fs.writeFileSync(
    nodeWrapper,
    `#!/usr/bin/env bash\nset -euo pipefail\nif [[ "$#" -eq 1 && "$1" == "--version" ]]; then\n  echo v22.23.1\n  exit 0\nfi\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
    { mode: 0o755 },
  );
  const archive = options.archive ?? "valid";
  const usesProducerArtifact = archive === "functional-snapshot-sanitizer";
  const payload = path.join(artifactDirectory, "nemoclaw-cli.tar");
  const producerRunAttempt = options.producerRunAttempt ?? "1";
  const workflowSha = "d".repeat(40);
  ARCHIVE_FIXTURE_WRITERS[archive]({
    buildIdentitySha: options.buildIdentitySha ?? candidateSha,
    payload,
    payloadRoot: usesProducerArtifact ? workspace : payloadRoot,
  });
  const packageProducerArtifact = () => {
    const packageOutput = path.join(root, "package-output");
    const packageResult = spawnSync(PACKAGE_SCRIPT, [], {
      cwd: workspace,
      encoding: "utf8",
      env: {
        ...process.env,
        CANDIDATE_REPOSITORY: "NVIDIA/NemoClaw",
        CANDIDATE_SHA: candidateSha,
        GITHUB_OUTPUT: packageOutput,
        MANAGED_IMAGE_CATALOG: "",
        MANAGED_IMAGE_CATALOG_SHA256: "",
        PATH: `${toolDirectory}:${process.env.PATH ?? ""}`,
        RUN_ATTEMPT: producerRunAttempt,
        RUN_ID: "98765",
        RUNNER_ARCH: "X64",
        RUNNER_OS: "Linux",
        RUNNER_TEMP: runnerTemp,
        WORKFLOW_SHA: workflowSha,
      },
    });
    expect(packageResult.status, `${packageResult.stdout}${packageResult.stderr}`).toBe(0);
    fs.rmSync(path.join(workspace, "dist"), { recursive: true });
    fs.rmSync(path.join(workspace, "nemoclaw", "dist"), { recursive: true });
  };
  (usesProducerArtifact ? packageProducerArtifact : () => undefined)();

  const actualPayloadSha256 = sha256File(payload);
  const expectedPayloadSha256 = options.expectedPayloadSha256 ?? actualPayloadSha256;
  const artifactName = `nemoclaw-cli-${candidateSha}-${expectedPayloadSha256}`;
  const writeFixtureManifest = () => {
    fs.writeFileSync(
      path.join(artifactDirectory, "manifest.json"),
      `${JSON.stringify({
        kind: "nemoclaw-e2e-cli-artifact-v1",
        artifactName,
        candidate: {
          repository: "NVIDIA/NemoClaw",
          sha: options.manifestCandidateSha ?? candidateSha,
          sourceTree,
          lockfileSha256: sha256File(path.join(workspace, "package-lock.json")),
        },
        workflow: {
          sha: workflowSha,
          runId: "98765",
          runAttempt: options.manifestRunAttempt ?? options.producerRunAttempt ?? "1",
        },
        toolchain: {
          node: "v22.23.1",
          npm: "10.9.2",
          runnerOs: "Linux",
          runnerArch: "X64",
        },
        build: { command: "npm run build:cli", sourceRevision: candidateSha },
        payload: { file: "nemoclaw-cli.tar", sha256: expectedPayloadSha256 },
      })}\n`,
    );
  };
  (usesProducerArtifact ? () => undefined : writeFixtureManifest)();

  const lockfileSha256 = sha256File(path.join(workspace, "package-lock.json"));
  fs.writeFileSync(
    path.join(toolDirectory, "sha256sum"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'case "${1:-}" in',
      `  package-lock.json|*/nemoclaw-cli.tar) printf '%s  %s\\n' '${"0".repeat(64)}' "$1" ;;`,
      `  *) printf '%s  %s\\n' '${lockfileSha256}' "$1" ;;`,
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  PREEXISTING_DIST_WRITERS[options.preexistingDist ?? "none"](workspace);

  const githubOutput = path.join(root, "github-output");
  const githubEnv = path.join(root, "github-env");
  const identityResult = spawnSync(IDENTITY_SCRIPT, [], {
    cwd: workspace,
    encoding: "utf8",
    env: {
      ...process.env,
      CALLER_WORKFLOW_SHA: workflowSha,
      GITHUB_OUTPUT: githubOutput,
      GITHUB_RUN_ATTEMPT: options.consumerRunAttempt ?? producerRunAttempt,
      GITHUB_RUN_ID: "98765",
      PROVENANCE_JSON: JSON.stringify({
        kind: "nemoclaw-e2e-cli-provenance-v1",
        artifactDigest: "c".repeat(64),
        artifactId: "12345",
        artifactName,
        candidateRepository: "NVIDIA/NemoClaw",
        candidateSha,
        payloadSha256: expectedPayloadSha256,
        runAttempt: producerRunAttempt,
        runId: "98765",
        workflowSha,
      }),
    },
  });
  const runRestoreStep = () => {
    const identityOutputs = Object.fromEntries(
      fs
        .readFileSync(githubOutput, "utf8")
        .trim()
        .split("\n")
        .map((line) => {
          const separator = line.indexOf("=");
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
    return spawnSync(RESTORE_SCRIPT, [], {
      cwd: workspace,
      encoding: "utf8",
      env: {
        ...process.env,
        ARTIFACT_NAME: identityOutputs.artifact_name,
        CANDIDATE_REPOSITORY: identityOutputs.candidate_repository,
        CANDIDATE_SHA: identityOutputs.candidate_sha,
        GITHUB_ENV: githubEnv,
        GITHUB_WORKSPACE: workspace,
        PATH: `${toolDirectory}:${process.env.PATH ?? ""}`,
        PAYLOAD_SHA256: identityOutputs.payload_sha256,
        PRODUCER_RUN_ATTEMPT: identityOutputs.producer_run_attempt,
        RUN_ID: identityOutputs.run_id,
        RUNNER_TEMP: runnerTemp,
        WORKFLOW_SHA: identityOutputs.workflow_sha,
      },
    });
  };
  const identitySucceeded = identityResult.status === 0;
  const restoreResult = identitySucceeded ? runRestoreStep() : identityResult;
  return {
    candidateSha,
    cleanup: () => fs.rmSync(root, { force: true, recursive: true }),
    githubEnv: fs.existsSync(githubEnv) ? fs.readFileSync(githubEnv, "utf8") : "",
    output: `${identityResult.stdout}${identityResult.stderr}${
      identitySucceeded ? `${restoreResult.stdout}${restoreResult.stderr}` : ""
    }`,
    result: restoreResult,
    runnerTemp,
    workspace,
  };
}

function expectRestoreFailure(options: RestoreFixtureOptions, message: string): void {
  const fixture = runRestoreValidation(options);
  try {
    expect(fixture.result.status, fixture.output).not.toBe(0);
    expect(fixture.output).toContain(message);
    expect(fs.existsSync(path.join(fixture.workspace, "dist"))).toBe(false);
    expect(fs.existsSync(path.join(fixture.workspace, "nemoclaw", "dist"))).toBe(false);
  } finally {
    fixture.cleanup();
  }
}

describe("exact-commit CLI artifact restore", () => {
  it("accepts matching artifact, candidate source, and workflow identities", () => {
    const result = runIdentityValidation();
    expect(result.status, "matching artifact identity validation failed").toBe(0);
  });

  it("reuses an immutable producer artifact during a later failed-job rerun", () => {
    const fixture = runRestoreValidation({ consumerRunAttempt: "2", producerRunAttempt: "1" });
    try {
      expect(fixture.result.status, "cross-attempt CLI artifact restore failed").toBe(0);
      expect(
        JSON.parse(
          fs.readFileSync(path.join(fixture.workspace, "dist", "build-identity.json"), "utf8"),
        ),
      ).toEqual({ nemoclawVersion: "0.0.0", sourceRevision: fixture.candidateSha });
      expect(fs.existsSync(path.join(fixture.workspace, "dist", "nemoclaw.js"))).toBe(true);
      expect(
        fs.existsSync(
          path.join(fixture.workspace, "nemoclaw", "dist", "shared", "sandbox-name.cjs"),
        ),
      ).toBe(true);
      expect(
        fs.existsSync(path.join(fixture.workspace, "dist", "lib", "blueprint-runner.js")),
      ).toBe(true);
      expect(
        fs.existsSync(path.join(fixture.workspace, "dist", "nemoclaw", "blueprint", "runner.js")),
      ).toBe(true);
      expect(
        JSON.parse(
          fs.readFileSync(path.join(fixture.workspace, "dist", "nemoclaw", "package.json"), "utf8"),
        ),
      ).toEqual({ type: "module" });
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects a producer attempt that does not match the restored artifact manifest", () => {
    expectRestoreFailure(
      { manifestRunAttempt: "2", producerRunAttempt: "1" },
      "exact-commit CLI artifact provenance mismatch",
    );
  });

  it("rejects consumer workflow attempt zero", () => {
    const result = runIdentityValidation({}, "0");
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "consumer workflow run attempt is invalid",
    );
  });

  it.each([
    ["empty artifact ID", { artifactId: "" }, "producer CLI artifact provenance is invalid"],
    [
      "prefixed upload digest",
      { artifactDigest: `sha256:${"c".repeat(64)}` },
      "producer CLI artifact provenance is invalid",
    ],
    [
      "malformed candidate SHA",
      { candidateSha: "abc" },
      "producer CLI artifact provenance is invalid",
    ],
    [
      "different candidate SHA",
      { candidateSha: "e".repeat(40) },
      "producer CLI artifact provenance is invalid",
    ],
    [
      "unbound artifact name",
      { artifactName: `nemoclaw-cli-${CANDIDATE_SHA}` },
      "producer CLI artifact provenance is invalid",
    ],
    [
      "malformed payload digest",
      { payloadSha256: "abc" },
      "producer CLI artifact provenance is invalid",
    ],
    [
      "malformed workflow SHA",
      { workflowSha: "abc" },
      "producer CLI artifact provenance is invalid",
    ],
    [
      "unknown provenance field",
      { unexpected: "value" },
      "producer CLI artifact provenance is invalid",
    ],
  ])("fails closed for %s", (_case, overrides, expectedError) => {
    const result = runIdentityValidation(overrides);
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(expectedError);
  });

  it.each([
    [
      "candidate repository",
      { candidateRepository: "example/other-repository" },
      "consumer checkout repository does not match producer provenance",
    ],
    ["workflow SHA", { workflowSha: "e".repeat(40) }, "consumer and producer workflow SHAs differ"],
    ["run ID", { runId: "98766" }, "consumer and producer workflow run IDs differ"],
    [
      "future producer attempt",
      { runAttempt: "2" },
      "producer workflow attempt is newer than the consumer attempt",
    ],
  ])("rejects a mismatched %s before artifact download", (_case, overrides, expectedError) => {
    const result = runIdentityValidation(overrides);
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(expectedError);
  });

  it("restores a payload whose compiled identity matches the candidate commit (#7915)", () => {
    const fixture = runRestoreValidation();
    try {
      expect(fixture.result.status, fixture.output).toBe(0);
      expect(
        JSON.parse(
          fs.readFileSync(path.join(fixture.workspace, "dist", "build-identity.json"), "utf8"),
        ),
      ).toEqual({ nemoclawVersion: "0.0.0", sourceRevision: fixture.candidateSha });
      expect(
        fs.existsSync(
          path.join(fixture.workspace, "nemoclaw", "dist", "shared", "sandbox-name.cjs"),
        ),
      ).toBe(true);
      expect(
        JSON.parse(
          fs.readFileSync(path.join(fixture.workspace, "dist", "nemoclaw", "package.json"), "utf8"),
        ),
      ).toEqual({ type: "module" });

      expect(
        fs
          .readdirSync(fixture.runnerTemp)
          .filter((entry) => entry.startsWith("nemoclaw-cli-restore.")),
      ).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  it("packages and restores snapshot sanitization through the artifact helper", () => {
    const fixture = runRestoreValidation({ archive: "functional-snapshot-sanitizer" });
    try {
      expect(fixture.result.status, fixture.output).toBe(0);
      fs.symlinkSync(
        path.join(REPOSITORY_ROOT, "node_modules"),
        path.join(fixture.workspace, "node_modules"),
        "dir",
      );
      const snapshot = path.join(fixture.workspace, "snapshot");
      const config = path.join(snapshot, "config.json");
      const secret = "sk-restored-artifact-secret";
      fs.mkdirSync(snapshot);
      fs.writeFileSync(config, JSON.stringify({ apiKey: secret, label: "safe" }), { mode: 0o600 });

      const result = spawnSync(
        process.execPath,
        [
          "--eval",
          "require(process.argv[1]).sanitizeSnapshotDirectory(process.argv[2]);",
          path.join(fixture.workspace, "dist", "lib", "security", "snapshot-sanitizer.js"),
          snapshot,
        ],
        { cwd: fixture.workspace, encoding: "utf8" },
      );

      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(fs.readFileSync(config, "utf8")).not.toContain(secret);
      expect(JSON.parse(fs.readFileSync(config, "utf8"))).toEqual({
        apiKey: "[STRIPPED_BY_MIGRATION]",
        label: "safe",
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("exports restored managed-image catalog publication authority", () => {
    const fixture = runRestoreValidation({ archive: "managed-catalog" });
    try {
      expect(fixture.result.status, fixture.output).toBe(0);
      expect(fixture.githubEnv).toBe(
        `NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG=${fixture.workspace}/dist/e2e-managed-image-catalog.json\n` +
          `NEMOCLAW_E2E_MANAGED_IMAGE_REVISION=${MANAGED_IMAGE_REVISION}\n`,
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("restores a binary payload when the host SHA-256 utility reports a different digest (#10569)", () => {
    const fixture = runRestoreValidation();
    try {
      expect(fixture.result.status, fixture.output).toBe(0);
      expect(fs.existsSync(path.join(fixture.workspace, "dist", "nemoclaw.js"))).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects manifest provenance before artifact extraction (#7915)", () => {
    expectRestoreFailure(
      { manifestCandidateSha: "e".repeat(40) },
      "exact-commit CLI artifact provenance mismatch",
    );
  });

  it("rejects a payload digest mismatch before artifact extraction (#7915)", () => {
    expectRestoreFailure(
      { expectedPayloadSha256: "f".repeat(64) },
      "exact-commit CLI artifact payload digest mismatch",
    );
  });

  it("rejects a payload missing a compiled shared module before activation (#7915)", () => {
    expectRestoreFailure(
      { archive: "missing-shared" },
      "restored CLI artifact shared module is missing or is not a nonempty regular file: sandbox-name.cjs",
    );
  });

  it("rejects a payload missing the snapshot sanitizer helper before activation", () => {
    expectRestoreFailure(
      { archive: "missing-snapshot-helper" },
      "restored CLI artifact shared module is missing or is not a nonempty regular file: snapshot-sanitizer-helper.mjs",
    );
  });

  it("rejects a payload missing the snapshot sanitizer protocol before activation", () => {
    expectRestoreFailure(
      { archive: "missing-snapshot-protocol" },
      "restored CLI artifact shared module is missing or is not a nonempty regular file: snapshot-sanitizer-protocol.cjs",
    );
  });

  it("rejects a directory in place of the CLI entry point before activation (#7915)", () => {
    expectRestoreFailure(
      { archive: "cli-directory" },
      "restored CLI artifact entry point is missing or is not a nonempty regular file",
    );
  });

  it("rejects a directory in place of a shared module before activation (#7915)", () => {
    expectRestoreFailure(
      { archive: "shared-module-directory" },
      "restored CLI artifact shared module is missing or is not a nonempty regular file: sandbox-name.cjs",
    );
  });

  it("rejects an archive member outside dist before artifact extraction (#7915)", () => {
    expectRestoreFailure(
      { archive: "non-dist" },
      "CLI artifact contains an unsafe member: outside.txt",
    );
  });

  it("rejects traversal through a dist-prefixed archive member before extraction (#7915)", () => {
    expectRestoreFailure({ archive: "traversal" }, "CLI artifact contains traversal");
  });

  it("rejects an archive link before artifact extraction (#7915)", () => {
    expectRestoreFailure({ archive: "link" }, "CLI artifact contains a link or special file");
  });

  it("does not overwrite a preexisting dist directory (#7915)", () => {
    const fixture = runRestoreValidation({ preexistingDist: "directory" });
    try {
      expect(fixture.result.status, fixture.output).not.toBe(0);
      expect(fixture.output).toContain("consumer unexpectedly built dist before artifact restore");
      expect(fs.readFileSync(path.join(fixture.workspace, "dist", "existing.txt"), "utf8")).toBe(
        "preserve\n",
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("does not overwrite a preexisting nemoclaw/dist directory (#7915)", () => {
    const fixture = runRestoreValidation({ preexistingDist: "plugin-directory" });
    try {
      expect(fixture.result.status, fixture.output).not.toBe(0);
      expect(fixture.output).toContain(
        "consumer unexpectedly built nemoclaw/dist before artifact restore",
      );
      expect(
        fs.readFileSync(
          path.join(fixture.workspace, "nemoclaw", "dist", "shared", "existing.cjs"),
          "utf8",
        ),
      ).toBe("module.exports = {};\n");
      expect(fs.existsSync(path.join(fixture.workspace, "dist"))).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects a symlinked nemoclaw directory without writing outside the workspace (#7915)", () => {
    const fixture = runRestoreValidation({ preexistingDist: "symlinked-plugin-parent" });
    try {
      expect(fixture.result.status, fixture.output).not.toBe(0);
      expect(fixture.output).toContain(
        "consumer nemoclaw directory must be a non-symlink directory",
      );
      expect(fs.lstatSync(path.join(fixture.workspace, "nemoclaw")).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(path.join(path.dirname(fixture.workspace), "escaped", "dist"))).toBe(
        false,
      );
      expect(fs.existsSync(path.join(fixture.workspace, "dist"))).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  it("does not overwrite a dangling dist symlink (#7915)", () => {
    const fixture = runRestoreValidation({ preexistingDist: "dangling-symlink" });
    try {
      expect(fixture.result.status, fixture.output).not.toBe(0);
      expect(fixture.output).toContain("consumer unexpectedly built dist before artifact restore");
      expect(fs.lstatSync(path.join(fixture.workspace, "dist")).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(path.join(fixture.workspace, "dist"))).toBe("missing-dist");
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects a compiled identity mismatch before artifact activation (#7915)", () => {
    expectRestoreFailure(
      { buildIdentitySha: "e".repeat(40) },
      "restored CLI build identity does not match the candidate SHA",
    );
  });
});
