// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAXIMUM_NPM_DIAGNOSTIC_INPUT_CHARACTERS = 4096;
const MAXIMUM_NPM_DIAGNOSTIC_CHARACTERS = 512;
const NPM_DIAGNOSTIC_URL_PATTERN = /[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/giu;
const NPM_DIAGNOSTIC_AUTH_HEADER_PATTERN =
  /(\b(?:authorization|proxy-authorization|cookie|set-cookie)[ \t]*[:=])[^\r\n]*/giu;
const NPM_DIAGNOSTIC_CREDENTIAL_ASSIGNMENT_PATTERN =
  /((?:^|[^A-Za-z0-9])(?:[A-Za-z0-9._-]*(?:auth|credential|key|pass|passwd|password|secret|token)[A-Za-z0-9._-]*)[ \t]*(?:=|:)[ \t]*)(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s]+)/giu;
const NPM_DIAGNOSTIC_PRIVATE_KEY_PATTERN =
  /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----/gu;
const NPM_DIAGNOSTIC_TOKEN_PATTERN =
  /\b(?:github_pat_|ghp_|glpat-|gsk_|hf_|nvcf-|nvapi-|pypi-|sk-(?:ant-|proj-)?|tvly-|xapp-|xox[bpas]-)[A-Za-z0-9_-]{8,}/giu;
const NPM_DIAGNOSTIC_JWT_PATTERN =
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{10,}\b/gu;
const NPM_DIAGNOSTIC_OPAQUE_VALUE_PATTERN = /\b[A-Za-z0-9_+/=-]{32,}\b/gu;

type NpmCacheStageRequest = Readonly<{
  archive: Buffer;
  artifactName: string;
  cacheDirectory: string;
}>;

export type NpmCacheStager = (request: NpmCacheStageRequest) => void;

function npmCacheFailureDiagnostic(
  stderr: string,
  request: NpmCacheStageRequest,
  stagingRoot: string,
): string {
  return stderr
    .slice(0, MAXIMUM_NPM_DIAGNOSTIC_INPUT_CHARACTERS)
    .replace(NPM_DIAGNOSTIC_PRIVATE_KEY_PATTERN, "<REDACTED>")
    .replace(NPM_DIAGNOSTIC_URL_PATTERN, "<REDACTED_URL>")
    .replace(NPM_DIAGNOSTIC_AUTH_HEADER_PATTERN, "$1 <REDACTED>")
    .replace(NPM_DIAGNOSTIC_CREDENTIAL_ASSIGNMENT_PATTERN, "$1<REDACTED>")
    .replace(/\bBearer[ \t]+\S+/giu, "Bearer <REDACTED>")
    .replace(NPM_DIAGNOSTIC_TOKEN_PATTERN, "<REDACTED>")
    .replace(NPM_DIAGNOSTIC_JWT_PATTERN, "<REDACTED>")
    .replace(NPM_DIAGNOSTIC_OPAQUE_VALUE_PATTERN, "<REDACTED>")
    .replaceAll(stagingRoot, "<staging-root>")
    .replaceAll(request.cacheDirectory, "<npm-cache>")
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .trim()
    .slice(0, MAXIMUM_NPM_DIAGNOSTIC_CHARACTERS);
}

export function stageReviewedArchiveWithNpm(request: NpmCacheStageRequest): void {
  const stagingRoot = mkdtempSync(join(tmpdir(), "nemoclaw-reviewed-npm-cache-add-"));
  try {
    const archivePath = join(stagingRoot, request.artifactName);
    writeFileSync(archivePath, request.archive, { mode: 0o600 });
    const result = spawnSync(
      "npm",
      [
        "cache",
        "add",
        archivePath,
        "--cache",
        request.cacheDirectory,
        "--offline",
        "--ignore-scripts",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, NPM_CONFIG_UPDATE_NOTIFIER: "false" },
        maxBuffer: 16 * 1024 * 1024,
        timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const diagnostic = npmCacheFailureDiagnostic(result.stderr, request, stagingRoot);
      const detail = diagnostic ? `: ${diagnostic}` : "";
      throw new Error(
        `npm could not stage the reviewed OpenShell SDK archive (exit ${String(result.status ?? "unavailable")})${detail}`,
      );
    }
  } finally {
    rmSync(stagingRoot, { force: true, recursive: true });
  }
}
