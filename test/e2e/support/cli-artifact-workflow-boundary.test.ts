// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile, execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, type TestContext, vi } from "vitest";

const CANDIDATE_SHA = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const PAYLOAD_SHA256 = "b".repeat(64);
const IDENTITY_SCRIPT = path.resolve("scripts/e2e/validate-cli-artifact-identity.sh");
const RESTORE_SCRIPT = path.resolve("scripts/e2e/restore-cli-artifact.sh");

type RunProcessOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

type RunProcessResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

function runProcess(
  file: string,
  args: readonly string[],
  options: RunProcessOptions = {},
): Promise<RunProcessResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { cwd: options.cwd, encoding: "utf8", env: options.env },
      (error, stdout, stderr) => {
        const signal = error?.signal ?? null;
        resolve({
          status: signal ? null : Number(error?.code) || (error ? -1 : 0),
          signal,
          stdout,
          stderr,
        });
      },
    );
  });
}

async function runSuccessfulProcess(
  file: string,
  args: readonly string[],
  options: RunProcessOptions = {},
): Promise<RunProcessResult> {
  const result = await runProcess(file, args, options);
  assert.equal(result.status, 0, `${file} failed: ${result.stdout}${result.stderr}`);
  return result;
}

vi.setConfig({ maxConcurrency: 4 });

async function runIdentityValidation(
  overrides: Record<string, unknown> = {},
  consumerAttempt = "1",
) {
  const workflowSha = "d".repeat(40);
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "cli-artifact-identity-"));
  try {
    const outputPath = path.join(outputDirectory, "github-output");
    const result = await runProcess(IDENTITY_SCRIPT, [], {
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

async function writeCliArchive(
  context: ArchiveFixtureContext,
  customizeDist: (dist: string) => void,
  customizeShared: (shared: string) => void = () => undefined,
): Promise<void> {
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
  ]) {
    fs.writeFileSync(path.join(shared, boundary), "module.exports = {};\n");
  }
  customizeShared(shared);

  customizeDist(dist);
  await runSuccessfulProcess("tar", [
    "-cf",
    context.payload,
    "-C",
    context.payloadRoot,
    "dist",
    "nemoclaw/dist/shared",
  ]);
}

async function writeValidArchive(context: ArchiveFixtureContext): Promise<void> {
  await writeCliArchive(context, () => undefined);
}

async function writeLinkArchive(context: ArchiveFixtureContext): Promise<void> {
  await writeCliArchive(context, (dist) => {
    fs.symlinkSync("nemoclaw.js", path.join(dist, "linked-cli.js"));
  });
}

const MANAGED_IMAGE_REVISION = "e".repeat(40);

async function writeManagedCatalogArchive(context: ArchiveFixtureContext): Promise<void> {
  await writeCliArchive(context, (dist) => {
    fs.writeFileSync(
      path.join(dist, "e2e-managed-image-catalog.json"),
      `${JSON.stringify({
        openclaw: { source: { revision: MANAGED_IMAGE_REVISION } },
        hermes: { source: { revision: MANAGED_IMAGE_REVISION } },
      })}\n`,
    );
  });
}

async function writeCliDirectoryArchive(context: ArchiveFixtureContext): Promise<void> {
  await writeCliArchive(context, (dist) => {
    const entrypoint = path.join(dist, "nemoclaw.js");
    fs.rmSync(entrypoint);
    fs.mkdirSync(entrypoint);
    fs.writeFileSync(path.join(entrypoint, "index.js"), 'console.log("nemoclaw v0.0.0");\n');
  });
}

async function writeMissingSharedArchive(context: ArchiveFixtureContext): Promise<void> {
  await writeCliArchive(
    context,
    () => undefined,
    (shared) => fs.rmSync(path.join(shared, "sandbox-name.cjs")),
  );
}

async function writeSharedModuleDirectoryArchive(context: ArchiveFixtureContext): Promise<void> {
  await writeCliArchive(
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

async function writeNonDistArchive(context: ArchiveFixtureContext): Promise<void> {
  fs.writeFileSync(path.join(context.payloadRoot, "outside.txt"), "outside dist\n");
  await runSuccessfulProcess("tar", [
    "-cf",
    context.payload,
    "-C",
    context.payloadRoot,
    "outside.txt",
  ]);
}

async function writeTraversalArchive(context: ArchiveFixtureContext): Promise<void> {
  fs.writeFileSync(path.join(context.payloadRoot, "outside.txt"), "outside dist\n");
  const transform =
    process.platform === "darwin"
      ? ["-s", "|^outside.txt$|dist/../outside.txt|"]
      : ["--transform=s|^outside.txt$|dist/../outside.txt|"];
  await runSuccessfulProcess("tar", [
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
  link: writeLinkArchive,
  "managed-catalog": writeManagedCatalogArchive,
  "missing-shared": writeMissingSharedArchive,

  "non-dist": writeNonDistArchive,
  "shared-module-directory": writeSharedModuleDirectoryArchive,
  traversal: writeTraversalArchive,
  valid: writeValidArchive,
} satisfies Record<
  NonNullable<RestoreFixtureOptions["archive"]>,
  (context: ArchiveFixtureContext) => Promise<void>
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

async function runRestoreValidation(options: RestoreFixtureOptions = {}) {
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
  await runSuccessfulProcess("git", ["init", "--quiet"], { cwd: workspace });
  await runSuccessfulProcess(
    "git",
    ["remote", "add", "origin", "https://github.com/NVIDIA/NemoClaw.git"],
    { cwd: workspace },
  );
  await runSuccessfulProcess("git", ["add", "."], { cwd: workspace });
  await runSuccessfulProcess(
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
  const candidateSha = (
    await runSuccessfulProcess("git", ["rev-parse", "HEAD"], { cwd: workspace })
  ).stdout.trim();
  const sourceTree = (
    await runSuccessfulProcess("git", ["rev-parse", "HEAD^{tree}"], { cwd: workspace })
  ).stdout.trim();

  const payload = path.join(artifactDirectory, "nemoclaw-cli.tar");
  await ARCHIVE_FIXTURE_WRITERS[options.archive ?? "valid"]({
    buildIdentitySha: options.buildIdentitySha ?? candidateSha,
    payload,
    payloadRoot,
  });

  const actualPayloadSha256 = sha256File(payload);
  const expectedPayloadSha256 = options.expectedPayloadSha256 ?? actualPayloadSha256;
  const artifactName = `nemoclaw-cli-${candidateSha}-${expectedPayloadSha256}`;
  const producerRunAttempt = options.producerRunAttempt ?? "1";
  const workflowSha = "d".repeat(40);
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

  const nodeWrapper = path.join(toolDirectory, "node");
  fs.writeFileSync(
    nodeWrapper,
    `#!/usr/bin/env bash\nset -euo pipefail\nif [[ "$#" -eq 1 && "$1" == "--version" ]]; then\n  echo v22.23.1\n  exit 0\nfi\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
    { mode: 0o755 },
  );
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
  const identityResult = await runProcess(IDENTITY_SCRIPT, [], {
    cwd: workspace,
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
  const runRestoreStep = async () => {
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
    return runProcess(RESTORE_SCRIPT, [], {
      cwd: workspace,
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
  const restoreResult = identitySucceeded ? await runRestoreStep() : identityResult;
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

async function expectRestoreFailure(
  expect: TestContext["expect"],
  options: RestoreFixtureOptions,
  message: string,
): Promise<void> {
  const fixture = await runRestoreValidation(options);
  try {
    expect(fixture.result.status, fixture.output).not.toBe(0);
    expect(fixture.output).toContain(message);
    expect(fs.existsSync(path.join(fixture.workspace, "dist"))).toBe(false);
    expect(fs.existsSync(path.join(fixture.workspace, "nemoclaw", "dist"))).toBe(false);
  } finally {
    fixture.cleanup();
  }
}

describe.concurrent("exact-commit CLI artifact restore", () => {
  it("accepts matching artifact, candidate source, and workflow identities", async ({ expect }) => {
    const result = await runIdentityValidation();
    expect(result.status, "matching artifact identity validation failed").toBe(0);
  });

  it("reuses an immutable producer artifact during a later failed-job rerun", async ({
    expect,
  }) => {
    const fixture = await runRestoreValidation({
      consumerRunAttempt: "2",
      producerRunAttempt: "1",
    });
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

  it("rejects a producer attempt that does not match the restored artifact manifest", async ({
    expect,
  }) => {
    await expectRestoreFailure(
      expect,
      { manifestRunAttempt: "2", producerRunAttempt: "1" },
      "exact-commit CLI artifact provenance mismatch",
    );
  });

  it("rejects consumer workflow attempt zero", async ({ expect }) => {
    const result = await runIdentityValidation({}, "0");
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "consumer workflow run attempt is invalid",
    );
  });

  it.for([
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
  ] as const)(
    ([caseName]: readonly [string, Record<string, unknown>, string]) =>
      `fails closed for ${caseName}`,
    async ([, overrides, expectedError], { expect }) => {
      const result = await runIdentityValidation(overrides);
      expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain(expectedError);
    },
  );

  it.for([
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
  ] as const)(
    ([caseName]: readonly [string, Record<string, unknown>, string]) =>
      `rejects a mismatched ${caseName} before artifact download`,
    async ([, overrides, expectedError], { expect }) => {
      const result = await runIdentityValidation(overrides);
      expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain(expectedError);
    },
  );

  it("restores a payload whose compiled identity matches the candidate commit (#7915)", async ({
    expect,
  }) => {
    const fixture = await runRestoreValidation();
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

  it("exports restored managed-image catalog publication authority", async ({ expect }) => {
    const fixture = await runRestoreValidation({ archive: "managed-catalog" });
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

  it("restores a binary payload when the host SHA-256 utility reports a different digest (#10569)", async ({
    expect,
  }) => {
    const fixture = await runRestoreValidation();
    try {
      expect(fixture.result.status, fixture.output).toBe(0);
      expect(fs.existsSync(path.join(fixture.workspace, "dist", "nemoclaw.js"))).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects manifest provenance before artifact extraction (#7915)", async ({ expect }) => {
    await expectRestoreFailure(
      expect,
      { manifestCandidateSha: "e".repeat(40) },
      "exact-commit CLI artifact provenance mismatch",
    );
  });

  it("rejects a payload digest mismatch before artifact extraction (#7915)", async ({ expect }) => {
    await expectRestoreFailure(
      expect,
      { expectedPayloadSha256: "f".repeat(64) },
      "exact-commit CLI artifact payload digest mismatch",
    );
  });

  it("rejects a payload missing a compiled shared module before activation (#7915)", async ({
    expect,
  }) => {
    await expectRestoreFailure(
      expect,
      { archive: "missing-shared" },
      "restored CLI artifact shared module is missing or is not a nonempty regular file: sandbox-name.cjs",
    );
  });

  it("rejects a directory in place of the CLI entry point before activation (#7915)", async ({
    expect,
  }) => {
    await expectRestoreFailure(
      expect,
      { archive: "cli-directory" },
      "restored CLI artifact entry point is missing or is not a nonempty regular file",
    );
  });

  it("rejects a directory in place of a shared module before activation (#7915)", async ({
    expect,
  }) => {
    await expectRestoreFailure(
      expect,
      { archive: "shared-module-directory" },
      "restored CLI artifact shared module is missing or is not a nonempty regular file: sandbox-name.cjs",
    );
  });

  it("rejects an archive member outside dist before artifact extraction (#7915)", async ({
    expect,
  }) => {
    await expectRestoreFailure(
      expect,
      { archive: "non-dist" },
      "CLI artifact contains an unsafe member: outside.txt",
    );
  });

  it("rejects traversal through a dist-prefixed archive member before extraction (#7915)", async ({
    expect,
  }) => {
    await expectRestoreFailure(expect, { archive: "traversal" }, "CLI artifact contains traversal");
  });

  it("rejects an archive link before artifact extraction (#7915)", async ({ expect }) => {
    await expectRestoreFailure(
      expect,
      { archive: "link" },
      "CLI artifact contains a link or special file",
    );
  });

  it("does not overwrite a preexisting dist directory (#7915)", async ({ expect }) => {
    const fixture = await runRestoreValidation({ preexistingDist: "directory" });
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

  it("does not overwrite a preexisting nemoclaw/dist directory (#7915)", async ({ expect }) => {
    const fixture = await runRestoreValidation({ preexistingDist: "plugin-directory" });
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

  it("rejects a symlinked nemoclaw directory without writing outside the workspace (#7915)", async ({
    expect,
  }) => {
    const fixture = await runRestoreValidation({ preexistingDist: "symlinked-plugin-parent" });
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

  it("does not overwrite a dangling dist symlink (#7915)", async ({ expect }) => {
    const fixture = await runRestoreValidation({ preexistingDist: "dangling-symlink" });
    try {
      expect(fixture.result.status, fixture.output).not.toBe(0);
      expect(fixture.output).toContain("consumer unexpectedly built dist before artifact restore");
      expect(fs.lstatSync(path.join(fixture.workspace, "dist")).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(path.join(fixture.workspace, "dist"))).toBe("missing-dist");
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects a compiled identity mismatch before artifact activation (#7915)", async ({
    expect,
  }) => {
    await expectRestoreFailure(
      expect,
      { buildIdentitySha: "e".repeat(40) },
      "restored CLI build identity does not match the candidate SHA",
    );
  });
});
