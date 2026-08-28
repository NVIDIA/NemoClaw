// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { shellQuote } from "../../../src/lib/core/shell-quote";

export interface LegacyOpenClawOpenShellWrapper {
  directory: string;
  executable: string;
  logFile: string;
}

export function createLegacyOpenClawOpenShellWrapper(options: {
  root: string;
  realOpenShell: string;
  baseImage: string;
  openClawVersion: string;
}): LegacyOpenClawOpenShellWrapper {
  const directory = path.join(options.root, "bin");
  const executable = path.join(directory, "openshell");
  const logFile = path.join(options.root, "sandbox-create-patch.log");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.rmSync(logFile, { force: true });
  fs.writeFileSync(
    executable,
    `#!/usr/bin/env bash
set -euo pipefail
real_openshell=${shellQuote(options.realOpenShell)}
base_image=${shellQuote(options.baseImage)}
openclaw_version=${shellQuote(options.openClawVersion)}
log_file=${shellQuote(logFile)}

if [ "\${1:-}" != "sandbox" ] || [ "\${2:-}" != "create" ]; then
  exec "$real_openshell" "$@"
fi

dockerfile=""
previous=""
for argument in "$@"; do
  if [ "$previous" = "--from" ]; then
    dockerfile="$argument"
  fi
  case "$argument" in
    --from=*) dockerfile="\${argument#--from=}" ;;
  esac
  previous="$argument"
done
if [ -z "$dockerfile" ] || [ ! -f "$dockerfile" ]; then
  echo "legacy OpenClaw fixture expected sandbox create --from <Dockerfile>" >&2
  exit 64
fi

blueprint="$(dirname "$dockerfile")/nemoclaw-blueprint/blueprint.yaml"
if [ ! -f "$blueprint" ]; then
  echo "legacy OpenClaw fixture expected staged blueprint beside $dockerfile" >&2
  exit 64
fi

chmod u+w "$dockerfile" "$blueprint"
python3 - "$dockerfile" "$blueprint" "$base_image" "$openclaw_version" <<'PY'
import pathlib
import re
import sys

dockerfile = pathlib.Path(sys.argv[1])
blueprint = pathlib.Path(sys.argv[2])
base_image = sys.argv[3]
version = sys.argv[4]


def replace_one(source: str, pattern: str, replacement: str, label: str) -> str:
    updated, count = re.subn(pattern, lambda _match: replacement, source, flags=re.MULTILINE)
    if count != 1:
        raise SystemExit(f"expected one {label}; found {count}")
    return updated


dockerfile_source = dockerfile.read_text(encoding="utf-8")
dockerfile_source = replace_one(
    dockerfile_source,
    r"^ARG BASE_IMAGE=.*$",
    f"ARG BASE_IMAGE={base_image}",
    "Dockerfile BASE_IMAGE default",
)
dockerfile_source = replace_one(
    dockerfile_source,
    r"^ARG OPENCLAW_VERSION=.*$",
    f"ARG OPENCLAW_VERSION={version}",
    "Dockerfile OPENCLAW_VERSION default",
)
dockerfile_source = replace_one(
    dockerfile_source,
    r"^ARG NEMOCLAW_E2E_FIXTURE_LEGACY_OPENCLAW=.*$",
    "ARG NEMOCLAW_E2E_FIXTURE_LEGACY_OPENCLAW=1",
    "Dockerfile legacy OpenClaw fixture flag",
)
dockerfile.write_text(dockerfile_source, encoding="utf-8")

blueprint_source = blueprint.read_text(encoding="utf-8")
blueprint_source = replace_one(
    blueprint_source,
    r"^min_openclaw_version:.*$",
    f'min_openclaw_version: "{version}"',
    "blueprint min_openclaw_version",
)
blueprint.write_text(blueprint_source, encoding="utf-8")
PY
chmod a-w "$dockerfile" "$blueprint"

printf 'patch sandbox create BASE_IMAGE=%s\n' "$base_image" >>"$log_file"
printf 'patch sandbox create OPENCLAW_VERSION=%s\n' "$openclaw_version" >>"$log_file"
printf 'patch sandbox create NEMOCLAW_E2E_FIXTURE_LEGACY_OPENCLAW=1\n' >>"$log_file"
printf 'patch sandbox create min_openclaw_version=%s\n' "$openclaw_version" >>"$log_file"
exec "$real_openshell" "$@"
`,
    { encoding: "utf8", mode: 0o755 },
  );
  fs.chmodSync(executable, 0o755);
  return { directory, executable, logFile };
}
