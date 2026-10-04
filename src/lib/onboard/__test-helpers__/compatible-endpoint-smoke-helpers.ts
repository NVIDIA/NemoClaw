// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function writeSmokeConfig(tmpDir: string, model: string): string {
  const configDir = path.join(tmpDir, ".openclaw");
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, "openclaw.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      agents: { defaults: { model: { primary: `inference/${model}` } } },
      models: {
        providers: {
          inference: {
            baseUrl: "https://inference.local/v1",
            apiKey: "unused",
          },
        },
      },
    }),
  );
  return configPath;
}

export function writeFakeCurl(
  tmpDir: string,
  bodyForCall: string,
): { binDir: string; callFile: string; requestFile: string } {
  const binDir = path.join(tmpDir, "bin");
  const callFile = path.join(tmpDir, "curl-calls");
  const requestFile = path.join(tmpDir, "curl-request.json");
  const responseScript = path.join(tmpDir, "fake-curl-response.sh");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(responseScript, `#!/usr/bin/env bash\nset -eu\n${bodyForCall}\n`, {
    mode: 0o755,
  });
  fs.writeFileSync(
    path.join(binDir, "curl"),
    `#!/usr/bin/env bash
set -eu
call_file="${callFile}"
count=0
if [ -f "$call_file" ]; then
  count="$(cat "$call_file")"
fi
count=$((count + 1))
printf '%s' "$count" >"$call_file"
output_file=""
write_out=""
data_file=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o)
      output_file="$2"
      shift 2
      ;;
    -w)
      write_out="$2"
      shift 2
      ;;
    -d)
      data_file="\${2#@}"
      shift 2
      ;;
    *) shift ;;
  esac
done
if [ -n "$data_file" ]; then
  cp "$data_file" "${requestFile}"
fi
set +e
body="$(count="$count" "${responseScript}")"
rc=$?
set -e
if [ "$rc" -ne 0 ]; then
  exit "$rc"
fi
http_status=200
case "$body" in
  __HTTP_STATUS__=*)
    status_line="\${body%%$'\n'*}"
    http_status="\${status_line#__HTTP_STATUS__=}"
    body="\${body#*$'\n'}"
    ;;
  *"504 Gateway Time-out"*) http_status=504 ;;
esac
if [ -n "$output_file" ]; then
  printf '%s' "$body" >"$output_file"
  if [ "$write_out" = '%{http_code}' ]; then
    printf '%s' "$http_status"
  fi
else
  printf '%s\n' "$body"
fi
`,
    { mode: 0o755 },
  );
  return { binDir, callFile, requestFile };
}

export function writeFakeSleep(tmpDir: string, binDir: string): string {
  const sleepFile = path.join(tmpDir, "sleep-calls");
  fs.writeFileSync(
    path.join(binDir, "sleep"),
    `#!/usr/bin/env bash
set -eu
printf '%s\n' "$1" >>"${sleepFile}"
`,
    { mode: 0o755 },
  );
  return sleepFile;
}

export function runSmokeScript(script: string, tmpDir: string, binDir: string) {
  return spawnSync("sh", ["-c", script], {
    cwd: tmpDir,
    encoding: "utf-8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH || ""}`,
    },
  });
}
