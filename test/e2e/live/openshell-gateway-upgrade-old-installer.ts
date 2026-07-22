// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

// The frozen release installers are the source of truth, but their embedded
// Dockerfiles predate the fixture pins needed for a deterministic upgrade test.
// Keep this adapter scoped to the frozen historical lanes and retire it with
// them; changing the tagged release payloads is not viable.
export function patchOldInstallerFixture(installer: string): void {
  const needle = '  legacy_script="${source_root}/install.sh"\n';
  const hook =
    String.raw`  if [[ -n "\${NEMOCLAW_OLD_OPENCLAW_VERSION:-}" && -f "$payload_script" ]]; then
    python3 - "$payload_script" <<'NEMOCLAW_OLD_PAYLOAD_PIN_PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
needle = '    spin "Cloning \${_CLI_DISPLAY} source" clone_nemoclaw_ref "$release_ref" "$nemoclaw_src"\n'
hook = r'''    if [[ -n "\${NEMOCLAW_OLD_OPENCLAW_VERSION:-}" ]]; then
      python3 - "$nemoclaw_src/Dockerfile" "$NEMOCLAW_OLD_OPENCLAW_VERSION" <<'NEMOCLAW_OLD_DOCKERFILE_PIN_PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
version = sys.argv[2]
text = path.read_text(encoding="utf-8")
injection = (
    "# E2E old-upgrade fixture: force the historical OpenClaw before the old Dockerfile's version gate.\n"
    "RUN rm -rf /usr/local/lib/node_modules/openclaw /usr/local/bin/openclaw \\\n"
    f"    && npm install -g --no-audit --no-fund --no-progress \"openclaw@{version}\" \\\n"
    "    && openclaw --version\n\n"
)
if injection not in text:
    arg_markers = [
        line for line in text.splitlines(keepends=True)
        if line.startswith("ARG OPENCLAW_VERSION=")
    ]
    if len(arg_markers) == 1:
        marker = arg_markers[0]
        text = text.replace(marker, marker + "\n" + injection, 1)
    elif len(arg_markers) > 1:
        raise SystemExit(
            f"{path}: found {len(arg_markers)} OpenClaw version ARGs; expected exactly one"
        )
    else:
        marker = "RUN set -eu; \\\n    MIN_VER=$(grep -m 1 'min_openclaw_version'"
        if marker not in text:
            raise SystemExit(f"{path}: old OpenClaw version gate not found")
        text = text.replace(marker, injection + marker, 1)

advisory_audit = '    npm --prefix /usr/local/lib/nemoclaw/mcporter-runtime audit --omit=dev --audit-level=low; \\\n'
advisory_audit_count = text.count(advisory_audit)
if advisory_audit_count > 1:
    raise SystemExit(
        f"{path}: found {advisory_audit_count} historical mcporter advisory audits; expected at most one"
    )
if advisory_audit_count == 1:
    audit_fixture_note = (
        '    echo "INFO: Skipping current advisory audit for the immutable historical mcporter lock"; \\\n'
    )
    text = text.replace(advisory_audit, audit_fixture_note, 1)

path.write_text(text, encoding="utf-8")
print(f"INFO: Forced OpenClaw {version} in old upgrade fixture Dockerfile", flush=True)
NEMOCLAW_OLD_DOCKERFILE_PIN_PY
    fi
'''
if hook not in text:
    if needle not in text:
        raise SystemExit(f"{path}: old source clone hook not found")
    text = text.replace(needle, needle + hook, 1)
    path.write_text(text, encoding="utf-8")
NEMOCLAW_OLD_PAYLOAD_PIN_PY
  fi
`.replaceAll("\\${", "${");

  const text = fs.readFileSync(installer, "utf8");
  const patchedText = text.includes(hook)
    ? text
    : text.includes(needle)
      ? text.replace(needle, needle + hook)
      : (() => {
          throw new Error(`${installer}: old bootstrap payload hook not found`);
        })();
  fs.writeFileSync(installer, patchedText, "utf8");
}
