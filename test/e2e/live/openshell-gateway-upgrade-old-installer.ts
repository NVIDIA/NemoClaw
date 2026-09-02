// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

export type ReviewedOldOpenClawArchive = Readonly<{
  expectedIntegrity: string;
  label: string;
  packageSpec: string;
  tarballUrl: string;
}>;

export type OldInstallerFixtureIdentity = Readonly<{
  nemoclawCommit: string;
  nemoclawRef: string;
  openclawVersion: string;
}>;

type ReviewedOldInstallerProfile = OldInstallerFixtureIdentity &
  Readonly<{
    expectedAdvisoryAuditCount: 0 | 1;
  }>;

const REVIEWED_OLD_OPENCLAW_ARCHIVES: Readonly<Record<string, ReviewedOldOpenClawArchive>> =
  Object.freeze({
    "2026.4.24": {
      expectedIntegrity:
        "sha512-W6u4XeIIP4+uG4DYV9G3JeS6QNuKwfhQIej1GIoL4BdcnUFgrnB8kHYNXL3MxiHRKuhZB9OYwUMGs8jKFZR/Vg==",
      label: "historical fixture OpenClaw 2026.4.24",
      packageSpec: "openclaw@2026.4.24",
      tarballUrl: "https://registry.npmjs.org/openclaw/-/openclaw-2026.4.24.tgz",
    },
    "2026.5.22": {
      expectedIntegrity:
        "sha512-m+zgBELGbCHjWB1IWF5WSWNPr480cMKOMff2OF72c8A0AMD4hC/9+qwYtzjYmGkETcffnB711JymlVsQnh2Tow==",
      label: "historical fixture OpenClaw 2026.5.22",
      packageSpec: "openclaw@2026.5.22",
      tarballUrl: "https://registry.npmjs.org/openclaw/-/openclaw-2026.5.22.tgz",
    },
    "2026.5.27": {
      expectedIntegrity:
        "sha512-2N93zhdAo88KAbHt6T7KvYXf4s7XIkYXBgv1npYpn7e1Y9FvrtgtpsA38my9rtFW+70uXEojRPX5/OqnuDqJPw==",
      label: "historical fixture OpenClaw 2026.5.27",
      packageSpec: "openclaw@2026.5.27",
      tarballUrl: "https://registry.npmjs.org/openclaw/-/openclaw-2026.5.27.tgz",
    },
    "2026.6.10": {
      expectedIntegrity:
        "sha512-LcooND2tBQw8A+kc1Ujltu3lg30bJ0w7XaeRy7eYzobb8BBdcW6DOGbwJL4vpj1vl9+gjRceOtlh5nh9OARcug==",
      label: "historical fixture OpenClaw 2026.6.10",
      packageSpec: "openclaw@2026.6.10",
      tarballUrl: "https://registry.npmjs.org/openclaw/-/openclaw-2026.6.10.tgz",
    },
  });

export const OLD_INSTALLER_BOOTSTRAP_NEEDLE = '  legacy_script="${source_root}/install.sh"\n';
export const OLD_INSTALLER_CLONE_NEEDLE =
  '    spin "Cloning ${_CLI_DISPLAY} source" clone_nemoclaw_ref "$release_ref" "$nemoclaw_src"\n';
export const OLD_INSTALLER_ADVISORY_AUDIT =
  "    npm --prefix /usr/local/lib/nemoclaw/mcporter-runtime audit --omit=dev --audit-level=low; \\\n";
export const OLD_INSTALLER_ARCHIVE_CONTEXT_PATH = "nemoclaw/src/.nemoclaw-e2e-old-openclaw.tgz";

const REVIEWED_OLD_INSTALLER_PROFILES: Readonly<Record<string, ReviewedOldInstallerProfile>> =
  Object.freeze({
    "v0.0.36": Object.freeze({
      expectedAdvisoryAuditCount: 0,
      nemoclawCommit: "3351fbdd4eb7d9b80ec471545083956327da2b10",
      nemoclawRef: "v0.0.36",
      openclawVersion: "2026.4.24",
    }),
    "v0.0.55": Object.freeze({
      expectedAdvisoryAuditCount: 0,
      nemoclawCommit: "95d483fe2b6569d68e59493c60f19df09a068e8f",
      nemoclawRef: "v0.0.55",
      openclawVersion: "2026.5.22",
    }),
    "v0.0.74": Object.freeze({
      expectedAdvisoryAuditCount: 1,
      nemoclawCommit: "3a05b54e8ec3e1d5550ec5c728de54af872bffe3",
      nemoclawRef: "v0.0.74",
      openclawVersion: "2026.5.27",
    }),
    "v0.0.89": Object.freeze({
      expectedAdvisoryAuditCount: 1,
      nemoclawCommit: "1143aa5cce77f3bad1b3b5588bd7fddbe438237e",
      nemoclawRef: "v0.0.89",
      openclawVersion: "2026.6.10",
    }),
  });

export function reviewedOldOpenClawArchive(version: string): ReviewedOldOpenClawArchive {
  const reviewedArchive = REVIEWED_OLD_OPENCLAW_ARCHIVES[version];
  if (!reviewedArchive) {
    throw new Error(`Historical gateway upgrade OpenClaw ${version} has no reviewed archive pin`);
  }
  return reviewedArchive;
}

export function reviewedOldInstallerProfile(
  identity: OldInstallerFixtureIdentity,
): ReviewedOldInstallerProfile {
  const profile = REVIEWED_OLD_INSTALLER_PROFILES[identity.nemoclawRef];
  if (
    !profile ||
    profile.nemoclawCommit !== identity.nemoclawCommit ||
    profile.openclawVersion !== identity.openclawVersion
  ) {
    throw new Error(
      `Historical gateway upgrade fixture must match an exact reviewed ref/commit/OpenClaw profile; got ${identity.nemoclawRef}/${identity.nemoclawCommit}/${identity.openclawVersion}`,
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
