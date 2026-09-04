// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const HERMES_ARCHIVE_HELPER = path.join(
  ROOT,
  "scripts",
  "checks",
  "download-hermes-source-archive.sh",
);
const PRIVATE_CURL_DIAGNOSTIC = "private curl diagnostic must stay redacted";
const temporaryDirectories: string[] = [];

type ArchiveResponse = `http:${number}` | `exit:${number}`;

function runArchiveDownload(
  responses: readonly ArchiveResponse[],
  input: { output?: string; version?: string } = {},
) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-archive-"));
  temporaryDirectories.push(tmp);
  const fakeBin = path.join(tmp, "bin");
  const output = input.output ?? path.join(tmp, "hermes.tar.gz");
  const source = path.join(tmp, "source.tar.gz");
  const responseFile = path.join(tmp, "responses");
  const stateFile = path.join(tmp, "attempt");
  const callLog = path.join(tmp, "calls.log");
  const urlLog = path.join(tmp, "urls.log");

  fs.mkdirSync(fakeBin);
  fs.writeFileSync(source, "verified archive payload\n");
  fs.writeFileSync(responseFile, `${responses.join("\n")}\n`);
  fs.writeFileSync(
    path.join(fakeBin, "curl"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "attempt=1",
      'if [ -f "$ARCHIVE_STATE" ]; then attempt=$(( $(cat "$ARCHIVE_STATE") + 1 )); fi',
      'printf "%s\\n" "$attempt" > "$ARCHIVE_STATE"',
      'response="$(sed -n "${attempt}p" "$ARCHIVE_RESPONSES")"',
      '[ -n "$response" ] || response="$(tail -n 1 "$ARCHIVE_RESPONSES")"',
      'printf "curl %s\\n" "$response" >> "$ARCHIVE_CALL_LOG"',
      '[ "${1:-}" = "--disable" ] || exit 67',
      'output=""',
      'url=""',
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in',
      '    -o|--output) shift; output="$1" ;;',
      '    --output=*) output="${1#--output=}" ;;',
      "    --retry|--retry=*|--retry-*) exit 66 ;;",
      '    https://*) url="$1" ;;',
      "  esac",
      "  shift",
      "done",
      '[ -n "$output" ]',
      '[ -n "$url" ]',
      'printf "%s\\n" "$url" >> "$ARCHIVE_URL_LOG"',
      'if [ "$attempt" -gt 1 ] && [ -e "$output" ]; then exit 65; fi',
      'case "$response" in',
      '  http:200) cp "$ARCHIVE_SOURCE" "$output"; printf 200 ;;',
      `  http:*) printf partial > "$output"; printf "%s" "\${response#http:}"; printf "%s\\n" ${JSON.stringify(PRIVATE_CURL_DIAGNOSTIC)} >&2 ;;`,
      `  exit:*) printf partial > "$output"; printf 000; printf "%s\\n" ${JSON.stringify(PRIVATE_CURL_DIAGNOSTIC)} >&2; exit "\${response#exit:}" ;;`,
      "  *) exit 64 ;;",
      "esac",
    ].join("\n"),
    { mode: 0o700 },
  );
  fs.writeFileSync(
    path.join(fakeBin, "sleep"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'printf "sleep %s\\n" "$*" >> "$ARCHIVE_CALL_LOG"',
    ].join("\n"),
    { mode: 0o700 },
  );

  const result = spawnSync("bash", [HERMES_ARCHIVE_HELPER, input.version ?? "v2026.8.27", output], {
    cwd: tmp,
    encoding: "utf8",
    env: {
      ...process.env,
      ARCHIVE_CALL_LOG: callLog,
      ARCHIVE_RESPONSES: responseFile,
      ARCHIVE_SOURCE: source,
      ARCHIVE_STATE: stateFile,
      ARCHIVE_URL_LOG: urlLog,
      PATH: `${fakeBin}:${process.env.PATH}`,
    },
    timeout: 15_000,
  });

  return {
    calls: fs.existsSync(callLog) ? fs.readFileSync(callLog, "utf8").trim().split("\n") : [],
    output,
    result,
    source,
    urls: fs.existsSync(urlLog) ? fs.readFileSync(urlLog, "utf8").trim().split("\n") : [],
  };
}

afterEach(() => {
  for (const tmp of temporaryDirectories.splice(0)) {
    fs.rmSync(tmp, { force: true, recursive: true });
  }
});
describe("Hermes source archive download", () => {
  it.each([
    ["invalid version", { version: "v2026.8" }, "failure=invalid-version"],
    ["relative output", { output: "hermes.tar.gz" }, "failure=invalid-output"],
  ])("rejects %s before network access", (_name, input, expectedError) => {
    const { calls, result } = runArchiveDownload(["http:200"], input);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(expectedError);
    expect(calls).toEqual([]);
  });

  it("publishes a successful archive without exposing curl diagnostics", () => {
    const { calls, output, result, source, urls } = runArchiveDownload(["http:200"]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("outcome=passed-first-attempt attempt=1/3");
    expect(result.stderr).not.toContain(PRIVATE_CURL_DIAGNOSTIC);
    expect(fs.readFileSync(output)).toEqual(fs.readFileSync(source));
    expect(calls).toEqual(["curl http:200"]);
    expect(urls).toEqual([
      "https://github.com/NousResearch/hermes-agent/archive/refs/tags/v2026.8.27.tar.gz",
    ]);
  });

  it("retries only HTTP 429 and replaces partial output", () => {
    const { calls, output, result } = runArchiveDownload(["http:429", "http:200"]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("outcome=transient-external attempt=1/3");
    expect(result.stderr).toContain("outcome=passed-after-retry attempt=2/3");
    expect(result.stderr).not.toContain(PRIVATE_CURL_DIAGNOSTIC);
    expect(calls).toEqual(["curl http:429", "sleep 1", "curl http:200"]);
    expect(fs.readFileSync(output, "utf8")).toBe("verified archive payload\n");
  });

  it("bounds HTTP 429 retries and removes partial output", () => {
    const { calls, output, result } = runArchiveDownload(["http:429", "http:429", "http:429"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("outcome=exhausted attempt=3/3 failure=http-429");
    expect(result.stderr).not.toContain(PRIVATE_CURL_DIAGNOSTIC);
    expect(calls).toEqual([
      "curl http:429",
      "sleep 1",
      "curl http:429",
      "sleep 2",
      "curl http:429",
    ]);
    expect(fs.existsSync(output)).toBe(false);
  });

  it.each([
    ["terminal HTTP response", ["http:404"] as const, "failure=http-404"],
    ["server error", ["http:500"] as const, "failure=http-500"],
    ["curl failure", ["exit:35"] as const, "failure=curl-exit-35"],
  ])("fails closed after a %s", (_name, responses, expectedError) => {
    const { calls, output, result } = runArchiveDownload(responses);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("outcome=failed-no-retry attempt=1/3");
    expect(result.stderr).toContain(expectedError);
    expect(result.stderr).not.toContain(PRIVATE_CURL_DIAGNOSTIC);
    expect(calls).toHaveLength(1);
    expect(fs.existsSync(output)).toBe(false);
  });
});
