// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { REVIEWED_GATEWAY_UPGRADE_FIXTURE } from "../../../tools/e2e/openshell-gateway-upgrade-fixture.mts";

type ReviewedOldOpenClawArchive = typeof REVIEWED_GATEWAY_UPGRADE_FIXTURE.openClawArchive;
type OldInstallerFixtureIdentity = Readonly<{
  nemoclawCommit: string;
  nemoclawRef: string;
  openclawVersion: string;
}>;
type ReviewedOldInstallerProfile = Pick<
  typeof REVIEWED_GATEWAY_UPGRADE_FIXTURE,
  "expectedAdvisoryAuditCount" | "nemoclawCommit" | "nemoclawRef" | "openclawVersion"
>;

export const OLD_INSTALLER_BOOTSTRAP_NEEDLE = '  legacy_script="${source_root}/install.sh"\n';
export const OLD_INSTALLER_CLONE_NEEDLE =
  '    spin "Cloning ${_CLI_DISPLAY} source" clone_nemoclaw_ref "$release_ref" "$nemoclaw_src"\n';
export const OLD_INSTALLER_ADVISORY_AUDIT =
  "    npm --prefix /usr/local/lib/nemoclaw/mcporter-runtime audit --omit=dev --audit-level=low; \\\n";
export const OLD_INSTALLER_ARCHIVE_CONTEXT_PATH = "nemoclaw/src/.nemoclaw-e2e-old-openclaw.tgz";

export function reviewedOldOpenClawArchive(version: string): ReviewedOldOpenClawArchive {
  if (version !== REVIEWED_GATEWAY_UPGRADE_FIXTURE.openclawVersion) {
    throw new Error(`Historical gateway upgrade OpenClaw ${version} has no reviewed archive pin`);
  }
  return REVIEWED_GATEWAY_UPGRADE_FIXTURE.openClawArchive;
}

export function reviewedOldInstallerProfile(
  identity: OldInstallerFixtureIdentity,
): ReviewedOldInstallerProfile {
  const profile = REVIEWED_GATEWAY_UPGRADE_FIXTURE;
  if (
    profile.nemoclawRef !== identity.nemoclawRef ||
    profile.nemoclawCommit !== identity.nemoclawCommit ||
    profile.openclawVersion !== identity.openclawVersion
  ) {
    throw new Error(
      `Historical gateway upgrade fixture must match the reviewed descriptor's ref, commit, and OpenClaw version; got ${identity.nemoclawRef}/${identity.nemoclawCommit}/${identity.openclawVersion}`,
    );
  }
  return profile;
}

// The frozen release installers are the source of truth, but their embedded
// Dockerfiles predate the fixture pins needed for a deterministic upgrade test.
// Keep this adapter scoped to the frozen historical lanes and retire it with
// them; changing the tagged release payloads is not viable.
export function patchOldInstallerFixture(
  installer: string,
  identity: OldInstallerFixtureIdentity,
): void {
  const profile = reviewedOldInstallerProfile(identity);
  const expectedAdvisoryAuditCount = profile.expectedAdvisoryAuditCount;

  const hook =
    String.raw`  if [[ -n "\${NEMOCLAW_OLD_OPENCLAW_VERSION:-}" && -f "$payload_script" ]]; then
    python3 - "$payload_script" <<'NEMOCLAW_OLD_PAYLOAD_PIN_PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
needle = ${JSON.stringify(OLD_INSTALLER_CLONE_NEEDLE)}
hook = r'''    if [[ -n "\${NEMOCLAW_OLD_OPENCLAW_VERSION:-}" ]]; then
      if [[ -z "\${NEMOCLAW_OLD_OPENCLAW_ARCHIVE:-}" || ! -f "$NEMOCLAW_OLD_OPENCLAW_ARCHIVE" ]]; then
        echo "ERROR: reviewed historical OpenClaw archive is missing" >&2
        exit 1
      fi
      archive_context_path="$nemoclaw_src/${OLD_INSTALLER_ARCHIVE_CONTEXT_PATH}"
      if [[ ! -d "$(dirname "$archive_context_path")" ]]; then
        echo "ERROR: historical OpenClaw archive context directory is missing" >&2
        exit 1
      fi
      cp -- "$NEMOCLAW_OLD_OPENCLAW_ARCHIVE" "$archive_context_path"
      python3 - "$nemoclaw_src/Dockerfile" "$NEMOCLAW_OLD_OPENCLAW_VERSION" <<'NEMOCLAW_OLD_DOCKERFILE_PIN_PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
version = sys.argv[2]
text = path.read_text(encoding="utf-8")
injection = (
    "# E2E old-upgrade fixture: force the historical OpenClaw before the old Dockerfile's version gate.\n"
    "COPY ${OLD_INSTALLER_ARCHIVE_CONTEXT_PATH} /tmp/nemoclaw-e2e-old-openclaw.tgz\n"
    "RUN rm -rf /usr/local/lib/node_modules/openclaw /usr/local/bin/openclaw \\\n"
    "    && npm install -g --ignore-scripts --no-audit --no-fund --no-progress /tmp/nemoclaw-e2e-old-openclaw.tgz \\\n"
    "    && node /usr/local/lib/node_modules/openclaw/scripts/postinstall-bundled-plugins.mjs \\\n"
    f"    && test \"$(openclaw --version | awk '{{print $2}}')\" = \"{version}\" \\\n"
    "    && rm -f /tmp/nemoclaw-e2e-old-openclaw.tgz\n\n"
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

advisory_audit = ${JSON.stringify(OLD_INSTALLER_ADVISORY_AUDIT)}
advisory_audit_count = text.count(advisory_audit)
expected_advisory_audit_count = ${expectedAdvisoryAuditCount}
if advisory_audit_count != expected_advisory_audit_count:
    raise SystemExit(
        f"{path}: found {advisory_audit_count} historical mcporter advisory audits; "
        f"expected {expected_advisory_audit_count}"
    )
if expected_advisory_audit_count == 1:
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
    : text.includes(OLD_INSTALLER_BOOTSTRAP_NEEDLE)
      ? text.replace(OLD_INSTALLER_BOOTSTRAP_NEEDLE, OLD_INSTALLER_BOOTSTRAP_NEEDLE + hook)
      : (() => {
          throw new Error(`${installer}: old bootstrap payload hook not found`);
        })();
  fs.writeFileSync(installer, patchedText, "utf8");
}
