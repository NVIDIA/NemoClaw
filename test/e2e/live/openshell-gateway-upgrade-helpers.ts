// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { shellQuote } from "../fixtures/clients/command.ts";

const NON_INTERACTIVE_INSTALLER_ARGS = ["--non-interactive", "--yes-i-accept-third-party-software"];
const GATEWAY_VOLUME_PREFIX = "openshell-cluster-nemoclaw";

export interface LegacyGatewayUpgradeFixture {
  nemoclawRef: string;
  nemoclawCommit: string;
  installerSha256: string;
  openclawVersion: string;
  sandboxBaseImageRef: string;
}

export function validateLegacyGatewayUpgradeFixture(fixture: LegacyGatewayUpgradeFixture): {
  sandboxBaseDigest: string;
} {
  if (!/^v\d+\.\d+\.\d+$/.test(fixture.nemoclawRef)) {
    throw new Error(`NEMOCLAW_OLD_NEMOCLAW_REF must be a release tag; got ${fixture.nemoclawRef}`);
  }
  if (!/^[0-9a-f]{40}$/.test(fixture.nemoclawCommit)) {
    throw new Error(
      `NEMOCLAW_OLD_NEMOCLAW_COMMIT must be a full lowercase commit SHA; got ${fixture.nemoclawCommit}`,
    );
  }
  if (!/^[0-9a-f]{64}$/.test(fixture.installerSha256)) {
    throw new Error(
      `NEMOCLAW_OLD_INSTALLER_SHA256 must be a lowercase SHA-256 digest; got ${fixture.installerSha256}`,
    );
  }
  if (!/^\d{4}\.\d{1,2}\.\d{1,2}$/.test(fixture.openclawVersion)) {
    throw new Error(
      `NEMOCLAW_OLD_OPENCLAW_VERSION must use the YYYY.M.D release format; got ${fixture.openclawVersion}`,
    );
  }
  const sandboxBaseDigest = fixture.sandboxBaseImageRef.match(
    /^[^@\s]+@sha256:([0-9a-f]{64})$/,
  )?.[1];
  if (!sandboxBaseDigest) {
    throw new Error(
      `NEMOCLAW_OLD_SANDBOX_BASE_IMAGE_REF must be digest-pinned; got ${fixture.sandboxBaseImageRef}`,
    );
  }
  return { sandboxBaseDigest };
}

export function oldGatewayUpgradeInstallerArgs(installer: string): string[] {
  return [installer, ...NON_INTERACTIVE_INSTALLER_ARGS, "--fresh"];
}

export function currentGatewayUpgradeInstallerArgs(
  installer: string,
  options: { interactive?: boolean } = {},
): string[] {
  return options.interactive ? [installer] : [installer, ...NON_INTERACTIVE_INSTALLER_ARGS];
}

export function currentNemoclawUpgradeRef(env: NodeJS.ProcessEnv): string {
  for (const candidate of [
    env.NEMOCLAW_CURRENT_NEMOCLAW_REF,
    env.NEMOCLAW_E2E_EXPECTED_SHA,
    env.GITHUB_SHA,
  ]) {
    if (candidate?.trim()) return candidate.trim();
  }
  return "HEAD";
}

// Frozen v0.0.74 and v0.0.89 sources run a live low-severity npm audit while
// assembling their historical image. New non-critical advisories must not make
// an immutable installed-base fixture impossible to create, so change only the
// cloned old Dockerfile to the reviewed critical threshold. The current
// candidate image keeps its low threshold unchanged.
export function patchHistoricalInstallerAdvisoryThreshold(source: string): string {
  const needle = '  legacy_script="${source_root}/install.sh"\n';
  const hook =
    String.raw`  if [[ -n "\${NEMOCLAW_OLD_OPENCLAW_VERSION:-}" && -f "$payload_script" ]]; then
    python3 - "$payload_script" <<'NEMOCLAW_OLD_AUDIT_THRESHOLD_PAYLOAD_PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
needle = '    spin "Cloning \${_CLI_DISPLAY} source" clone_nemoclaw_ref "$release_ref" "$nemoclaw_src"\n'
hook = r'''    python3 - "$nemoclaw_src/Dockerfile" <<'NEMOCLAW_OLD_AUDIT_THRESHOLD_DOCKERFILE_PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
needle = "npm --prefix /usr/local/lib/nemoclaw/mcporter-runtime audit --omit=dev --audit-level=low"
replacement = "npm --prefix /usr/local/lib/nemoclaw/mcporter-runtime audit --omit=dev --audit-level=critical"
if text.count(needle) != 1:
    raise SystemExit(f"{path}: expected exactly one historical mcporter audit threshold")
path.write_text(text.replace(needle, replacement, 1), encoding="utf-8")
print("INFO: Historical upgrade fixture retains npm audit at the reviewed critical threshold", flush=True)
NEMOCLAW_OLD_AUDIT_THRESHOLD_DOCKERFILE_PY
'''
if hook not in text:
    if needle not in text:
        raise SystemExit(f"{path}: old source clone hook not found")
    text = text.replace(needle, needle + hook, 1)
    path.write_text(text, encoding="utf-8")
NEMOCLAW_OLD_AUDIT_THRESHOLD_PAYLOAD_PY
  fi
`.replaceAll("\\${", "${");

  if (source.includes(hook)) return source;
  if (!source.includes(needle)) {
    throw new Error("historical installer bootstrap payload hook not found");
  }
  return source.replace(needle, needle + hook);
}

export function expectedLegacyRegistryMetadata(nemoclawRef: string): {
  nemoclawVersion: string | undefined;
  fromDockerfile: null | undefined;
} {
  switch (nemoclawRef) {
    case "v0.0.36":
    case "v0.0.55":
      return { nemoclawVersion: undefined, fromDockerfile: undefined };
    case "v0.0.74":
      return { nemoclawVersion: "0.0.74", fromDockerfile: null };
    case "v0.0.89":
      return { nemoclawVersion: "0.0.89", fromDockerfile: null };
    default:
      throw new Error(`Unsupported gateway-upgrade registry fixture: ${nemoclawRef}`);
  }
}

export function upgradeGatewayStateCleanupScript(pidFile: string): string {
  return `set -e
volume_prefix=${GATEWAY_VOLUME_PREFIX}
gateway_volumes="$(docker volume ls -q --filter "name=\${volume_prefix}")"
while IFS= read -r volume; do
  [ -n "$volume" ] || continue
  case "$volume" in
    ${GATEWAY_VOLUME_PREFIX}|${GATEWAY_VOLUME_PREFIX}-*)
      printf 'Removing stale OpenShell gateway volume %s\\n' "$volume"
      docker volume rm "$volume" >/dev/null
      ;;
  esac
done <<<"$gateway_volumes"
rm -f ${shellQuote(pidFile)}`;
}

export function upgradeGatewayCleanupScript(pidFile: string): string {
  return `if command -v openshell >/dev/null 2>&1; then
  openshell gateway remove nemoclaw >/dev/null 2>&1 \\
    || openshell gateway destroy -g nemoclaw >/dev/null 2>&1 \\
    || openshell gateway destroy >/dev/null 2>&1 \\
    || true
fi
${upgradeGatewayStateCleanupScript(pidFile)}`;
}
