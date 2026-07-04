// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runRealOpenClawDeviceSelfApprovalProof } from "./helpers/openclaw-real-device-self-approval-proof";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const DOCKERFILE = path.join(REPO_ROOT, "Dockerfile");
const PATCH_OPENCLAW_CHAT_SEND = path.join(REPO_ROOT, "scripts", "patch-openclaw-chat-send.js");
const PATCH_OPENCLAW_ISSUE_4434_DIAGNOSTICS = path.join(
  REPO_ROOT,
  "scripts",
  "patch-openclaw-issue-4434-diagnostics.ts",
);
// Focused patch scripts also scan the full generated dist. APFS cold-cache
// reads can exceed one minute, so keep them bounded without using unit-fixture
// timings as the real-artifact limit.
const PATCH_COMMAND_TIMEOUT_MS = 120_000;
// The compiled-dist classifier performs several full-tree grep/sed passes.
// A cold 2026.6.10 materialization can exceed three minutes on macOS while the
// same patch completes normally; keep this bounded below the 12-minute CI job.
const DOCKERFILE_PATCH_TIMEOUT_MS = 300_000;

function readRequiredDockerArg(name: string): string {
  const match = fs
    .readFileSync(DOCKERFILE, "utf-8")
    .match(new RegExp(`^ARG ${name}=([^\\s]+)`, "m"));
  return match?.[1] ?? runtimeMismatch("missing", "pinned", `Dockerfile ARG ${name}`);
}

function dockerRunCommandBetween(startMarker: string, endMarker: string): string {
  const dockerfile = fs.readFileSync(DOCKERFILE, "utf-8");
  const start = dockerfile.indexOf(startMarker);
  const end = dockerfile.indexOf(endMarker, start);
  const runIndex = dockerfile.indexOf("RUN ", start);
  start >= 0 || runtimeMismatch(String(start), ">= 0", startMarker);
  end > start || runtimeMismatch(String(end), `> ${start}`, endMarker);
  runIndex >= start || runtimeMismatch(String(runIndex), `>= ${start}`, `RUN after ${startMarker}`);
  runIndex < end || runtimeMismatch(String(runIndex), `< ${end}`, `RUN before ${endMarker}`);
  return dockerfile
    .slice(runIndex, end)
    .trim()
    .replace(/^RUN\s+/, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n")
    .replace(/\\\n/g, " ")
    .replace(/\\\s*$/, "");
}

function createSedWrapper(tmp: string): string {
  const fakeBin = path.join(tmp, "bin");
  fs.mkdirSync(fakeBin);
  const sedWrapper = path.join(fakeBin, "sed");
  fs.writeFileSync(
    sedWrapper,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [ "${1:-}" = "-i" ]; then',
      "  extended=0",
      '  if [ "${2:-}" = "-E" ]; then',
      "    extended=1",
      "    expr=$3",
      "    shift 3",
      "  else",
      "    expr=$2",
      "    shift 2",
      "  fi",
      '  for file in "$@"; do',
      "    tmp=$(mktemp)",
      '    if [ "$extended" = "1" ]; then',
      '      /usr/bin/sed -E "$expr" "$file" > "$tmp"',
      "    else",
      '      /usr/bin/sed "$expr" "$file" > "$tmp"',
      "    fi",
      '    mv "$tmp" "$file"',
      "  done",
      "  exit 0",
      "fi",
      'exec /usr/bin/sed "$@"',
    ].join("\n"),
    { mode: 0o755 },
  );
  return fakeBin;
}

function sha512Sri(file: string): string {
  return `sha512-${crypto.createHash("sha512").update(fs.readFileSync(file)).digest("base64")}`;
}

function runtimeMismatch(actual: string, expected: string, label: string): never {
  throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

function requireRuntimeEqual(actual: string, expected: string, label: string): void {
  actual === expected || runtimeMismatch(actual, expected, label);
}

function requireRuntimeIncludes(actual: string, expected: string, label: string): void {
  actual.includes(expected) || runtimeMismatch(actual, `text containing ${expected}`, label);
}

function requireSpawnSuccess(
  result: { status: number | null; stdout?: string | null; stderr?: string | null },
  label: string,
): void {
  const detail = String(result.stderr || result.stdout || "").trim();
  requireRuntimeEqual(String(result.status), "0", detail ? `${label}: ${detail}` : label);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function runDockerfilePatchBlock(dist: string, tmp: string, version: string) {
  const command = dockerRunCommandBetween(
    "# Patch OpenClaw media fetch for proxy-only sandbox",
    "# Patch OpenClaw chat.send gateway behavior",
  ).replaceAll("/usr/local/lib/node_modules/openclaw/dist", dist);
  const scriptPath = path.join(tmp, "patch-openclaw-dist.sh");
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `openclaw() { case "\${1:-}" in --version) printf 'OpenClaw ${version}\\n';; *) return 127;; esac; }`,
      command,
    ].join("\n"),
    { mode: 0o700 },
  );
  const fakeBin = createSedWrapper(tmp);
  return spawnSync("bash", [scriptPath], {
    encoding: "utf-8",
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH || ""}` },
    timeout: DOCKERFILE_PATCH_TIMEOUT_MS,
  });
}

function grepRealDist(dist: string, needle: string) {
  return spawnSync(
    "bash",
    ["-lc", `grep -RIlF --include='*.js' ${shellQuote(needle)} ${shellQuote(dist)}`],
    {
      encoding: "utf-8",
      timeout: PATCH_COMMAND_TIMEOUT_MS,
    },
  );
}

interface PackCommandResult {
  status: number | null;
  stdout: string | null;
  stderr: string | null;
}

type PackReviewedTarball = (tarballUrl: string, destination: string) => PackCommandResult;

function packReviewedTarball(tarballUrl: string, destination: string): PackCommandResult {
  const runPack = () =>
    spawnSync("npm", ["pack", tarballUrl, "--pack-destination", destination, "--silent"], {
      encoding: "utf-8",
      timeout: 90000,
    });
  const first = runPack();
  return first.status === 0 ? first : runPack();
}

function materializeReviewedTarball(
  tarballUrl: string,
  destination: string,
  expectedIntegrity: string,
  packTarball: PackReviewedTarball = packReviewedTarball,
): string {
  const pack = packTarball(tarballUrl, destination);
  requireSpawnSuccess(pack, "npm pack reviewed OpenClaw tarball");

  const reportedFilenames = (pack.stdout ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  reportedFilenames.length === 1 ||
    runtimeMismatch(
      String(reportedFilenames.length),
      "exactly one archive",
      "npm pack reviewed OpenClaw tarball archive count",
    );

  const filename = reportedFilenames[0] as string;
  const filenameParts = filename.split(/[\\/]+/);
  const unsafeFilename =
    path.isAbsolute(filename) ||
    filename === "." ||
    filename === ".." ||
    filename.includes("/") ||
    filename.includes("\\") ||
    filenameParts.includes("..") ||
    filenameParts.includes("");
  !unsafeFilename ||
    runtimeMismatch(
      filename,
      "one safe archive filename",
      "npm pack reviewed OpenClaw tarball unsafe archive filename",
    );

  const packRoot = path.resolve(destination);
  const tarballPath = path.resolve(packRoot, filename);
  tarballPath.startsWith(`${packRoot}${path.sep}`) ||
    runtimeMismatch(tarballPath, `path under ${packRoot}`, "OpenClaw tarball path");
  fs.existsSync(tarballPath) || runtimeMismatch("missing", "present", tarballPath);
  requireRuntimeEqual(sha512Sri(tarballPath), expectedIntegrity, "OpenClaw tarball SRI");
  return tarballPath;
}

describe("OpenClaw real patched-dist materialization guard", () => {
  it("rejects drifted tarball integrity before install can start", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-drifted-dist-"));
    let installStarted = false;
    try {
      const fakePack: PackReviewedTarball = (_tarballUrl, destination) => {
        const filename = "openclaw-drifted.tgz";
        fs.writeFileSync(path.join(destination, filename), "drifted tarball");
        return {
          status: 0,
          stdout: filename,
          stderr: "",
        };
      };

      expect(() => {
        materializeReviewedTarball(
          "https://registry.npmjs.org/openclaw/-/openclaw-drifted.tgz",
          tmp,
          "sha512-reviewed-integrity",
          fakePack,
        );
        installStarted = true;
      }).toThrow(/OpenClaw tarball SRI/);
      expect(installStarted).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects an unsafe reported tarball filename before install can start", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-unsafe-dist-"));
    let installStarted = false;
    try {
      const fakePack: PackReviewedTarball = () => ({
        status: 0,
        stdout: "../package.tgz",
        stderr: "",
      });

      expect(() => {
        materializeReviewedTarball(
          "https://registry.npmjs.org/openclaw/-/openclaw-unsafe.tgz",
          tmp,
          "sha512-reviewed-integrity",
          fakePack,
        );
        installStarted = true;
      }).toThrow(/unsafe archive filename/);
      expect(installStarted).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.env.NEMOCLAW_REAL_OPENCLAW_DIST_HARNESS !== "1")(
  "OpenClaw real patched-dist harness",
  () => {
    it("materializes the reviewed tarball and applies NemoClaw's Dockerfile OpenClaw patches", async () => {
      const version = readRequiredDockerArg("OPENCLAW_VERSION");
      const integrity = readRequiredDockerArg("OPENCLAW_2026_6_10_INTEGRITY");
      const tarballUrl = readRequiredDockerArg("OPENCLAW_2026_6_10_TARBALL");
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-real-dist-"));
      try {
        const tarballPath = materializeReviewedTarball(tarballUrl, tmp, integrity);

        const extractDir = path.join(tmp, "extract");
        fs.mkdirSync(extractDir);
        const extract = spawnSync("tar", ["-xzf", tarballPath, "-C", extractDir], {
          encoding: "utf-8",
          timeout: 60000,
        });
        requireSpawnSuccess(extract, "extract reviewed OpenClaw tarball");

        const dist = path.join(extractDir, "package", "dist");
        fs.statSync(dist).isDirectory() || runtimeMismatch("not a directory", "directory", dist);

        const dockerPatch = runDockerfilePatchBlock(dist, tmp, version);
        requireSpawnSuccess(dockerPatch, "apply Dockerfile OpenClaw patches");
        requireRuntimeIncludes(
          dockerPatch.stdout,
          `Patch 2 applied to OpenClaw ${version}`,
          "Patch 2",
        );
        requireRuntimeIncludes(
          dockerPatch.stdout,
          `Patch 2b applied to OpenClaw ${version}`,
          "Patch 2b",
        );
        requireRuntimeIncludes(
          dockerPatch.stdout,
          `Patch 4 applied to OpenClaw ${version}`,
          "Patch 4",
        );
        requireRuntimeIncludes(
          dockerPatch.stdout,
          `Patch 6 applied to OpenClaw ${version}`,
          "Patch 6",
        );

        for (const marker of [
          "nemoclaw: env-gated bypass",
          "nemoclaw: OpenShell host gateway for web_fetch trusted env proxy",
          "nemoclaw: route unconfigured strict fetch through sandbox egress proxy",
          'mode: "trusted_env_proxy", auditContext: "cron-model-provider-preflight"',
        ]) {
          const grep = grepRealDist(dist, marker);
          requireSpawnSuccess(grep, `find real-dist marker ${marker}`);
          grep.stdout.trim().length > 0 || runtimeMismatch("empty", "non-empty", marker);
        }

        const retryPersistencePreimage = [
          "\t\t\tlet suppressNextUserMessagePersistence = params.suppressNextUserMessagePersistence ?? false;",
          "\t\t\tlet lastPersistedCurrentMessageId;",
          "\t\t\tconst onUserMessagePersisted = (message) => {",
          "\t\t\t\tif (params.currentMessageId !== void 0) lastPersistedCurrentMessageId = params.currentMessageId;",
        ].join("\n");
        const embeddedAgentFiles = fs
          .readdirSync(dist)
          .filter((file) => file.startsWith("embedded-agent-") && file.endsWith(".js"))
          .map((file) => path.join(dist, file));
        const retryPersistenceTargets = embeddedAgentFiles.filter(
          (file) => fs.readFileSync(file, "utf-8").split(retryPersistencePreimage).length === 2,
        );
        requireRuntimeEqual(
          String(retryPersistenceTargets.length),
          "1",
          "embedded-agent retry persistence patch preimage count",
        );

        const chatPatch = spawnSync(process.execPath, [PATCH_OPENCLAW_CHAT_SEND, dist], {
          encoding: "utf-8",
          timeout: PATCH_COMMAND_TIMEOUT_MS,
        });
        requireSpawnSuccess(chatPatch, "apply chat.send compatibility patch");
        requireRuntimeIncludes(
          chatPatch.stdout,
          "patched OpenClaw chat.send compatibility",
          "chat.send patch output",
        );

        const audit = spawnSync(process.execPath, [PATCH_OPENCLAW_CHAT_SEND, "--audit", dist], {
          encoding: "utf-8",
          timeout: PATCH_COMMAND_TIMEOUT_MS,
        });
        requireSpawnSuccess(audit, "audit chat.send compatibility patch");
        requireRuntimeIncludes(audit.stdout, "chat.send runtime:", "chat.send audit");
        requireRuntimeIncludes(audit.stdout, "get-reply runtime:", "get-reply audit");
        requireRuntimeIncludes(audit.stdout, "followup runner runtime:", "followup audit");
        requireRuntimeIncludes(
          audit.stdout,
          "embedded-agent retry runtime:",
          "embedded-agent retry audit",
        );
        const retryPersistenceMarker = "nemoclaw: suppress persisted user turn on embedded retries";
        const retryPersistenceSource = fs.readFileSync(
          retryPersistenceTargets[0] as string,
          "utf-8",
        );
        requireRuntimeEqual(
          String(retryPersistenceSource.split(retryPersistenceMarker).length - 1),
          "1",
          "embedded-agent retry persistence marker count",
        );
        const embeddedAgentSyntax = spawnSync(
          process.execPath,
          ["--check", retryPersistenceTargets[0] as string],
          { encoding: "utf-8", timeout: PATCH_COMMAND_TIMEOUT_MS },
        );
        requireSpawnSuccess(embeddedAgentSyntax, "validate patched embedded-agent syntax");

        const issue4434Patch = spawnSync(
          process.execPath,
          ["--experimental-strip-types", PATCH_OPENCLAW_ISSUE_4434_DIAGNOSTICS, dist],
          {
            encoding: "utf-8",
            timeout: PATCH_COMMAND_TIMEOUT_MS,
          },
        );
        requireSpawnSuccess(issue4434Patch, "apply #4434 diagnostics patch");
        requireRuntimeIncludes(
          issue4434Patch.stdout,
          "patched OpenClaw #4434 diagnostics",
          "#4434 patch output",
        );

        const issue4434Audit = spawnSync(
          process.execPath,
          ["--experimental-strip-types", PATCH_OPENCLAW_ISSUE_4434_DIAGNOSTICS, "--audit", dist],
          {
            encoding: "utf-8",
            timeout: PATCH_COMMAND_TIMEOUT_MS,
          },
        );
        requireSpawnSuccess(issue4434Audit, "audit #4434 diagnostics patch");
        requireRuntimeIncludes(
          issue4434Audit.stdout,
          "assistant error formatter:",
          "#4434 assistant error formatter audit",
        );
        requireRuntimeIncludes(
          issue4434Audit.stdout,
          "issue-4434-diagnostics: already-applied",
          "#4434 patch state audit",
        );

        // This proof installs the reviewed shrinkwrapped runtime dependencies
        // with lifecycle scripts disabled. Keep it after every shape-only dist
        // scan so dependency materialization cannot perturb their timing.
        await runRealOpenClawDeviceSelfApprovalProof({
          dist,
          patchScript: path.join(REPO_ROOT, "scripts", "patch-openclaw-device-self-approval.ts"),
          timeoutMs: PATCH_COMMAND_TIMEOUT_MS,
          tmp,
        });
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }, 600000);
  },
);
