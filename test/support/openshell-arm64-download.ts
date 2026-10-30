// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import credentialBoundaryManifest from "../../src/lib/actions/sandbox/openshell-child-visible-credentials.v0.0.116.json";
import {
  OPENSHELL_FEATURE_MARKERS,
  OPENSHELL_MCP_FEATURE_MARKER,
  PINNED_OPEN_SHELL_SHA256,
} from "../helpers/openshell-release-fixtures";

const REQUIRED_OPENSHELL_VERSION = credentialBoundaryManifest.openshellVersion;

function writeExecutable(target: string, contents: string) {
  fs.writeFileSync(target, contents, { mode: 0o755 });
}

export function createLinuxArm64DownloadFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-linux-arm64-assets-"));
  const fakeBin = path.join(tmp, "bin");
  const downloadLog = path.join(tmp, "downloads.log");
  const checksumLog = path.join(tmp, "checksums.log");
  fs.mkdirSync(fakeBin);

  writeExecutable(
    path.join(fakeBin, "uname"),
    `#!/usr/bin/env bash
if [ "\${1:-}" = "-m" ]; then echo "aarch64"; else echo "Linux"; fi`,
  );
  writeExecutable(
    path.join(fakeBin, "openshell"),
    `#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then echo "openshell 0.0.36"; exit 0; fi
exit 99`,
  );
  writeExecutable(path.join(fakeBin, "gh"), "#!/usr/bin/env bash\nexit 1\n");
  writeExecutable(
    path.join(fakeBin, "curl"),
    `#!/usr/bin/env bash
echo "$@" >> ${JSON.stringify(downloadLog)}
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then shift; out="$1"; fi
  shift || true
done
case "$(basename "$out")" in
openshell-checksums-sha256.txt)
  printf '%s\n' '${PINNED_OPEN_SHELL_SHA256.cliLinuxArm64}  openshell-aarch64-unknown-linux-musl.tar.gz' > "$out" ;;
openshell-gateway-checksums-sha256.txt)
  printf '%s\n' '${PINNED_OPEN_SHELL_SHA256.gatewayLinuxArm64}  openshell-gateway-aarch64-unknown-linux-gnu.tar.gz' > "$out" ;;
openshell-sandbox-checksums-sha256.txt)
  printf '%s\n' '${PINNED_OPEN_SHELL_SHA256.sandboxLinuxArm64}  openshell-sandbox-aarch64-unknown-linux-musl.tar.gz' > "$out" ;;
*) : > "$out" ;;
esac
exit 0`,
  );
  writeExecutable(
    path.join(fakeBin, "sha256sum"),
    `#!/usr/bin/env bash
[ "$#" -eq 2 ] && [ "$1" = "-c" ] && [ "$2" = "-" ] || exit 9
line="$(cat)"
case "$line" in
'${PINNED_OPEN_SHELL_SHA256.cliLinuxArm64}  openshell-aarch64-unknown-linux-musl.tar.gz'|\
'${PINNED_OPEN_SHELL_SHA256.gatewayLinuxArm64}  openshell-gateway-aarch64-unknown-linux-gnu.tar.gz'|\
'${PINNED_OPEN_SHELL_SHA256.sandboxLinuxArm64}  openshell-sandbox-aarch64-unknown-linux-musl.tar.gz') ;;
*) exit 10 ;;
esac
printf '%s\n' "$line" >> ${JSON.stringify(checksumLog)}
printf '%s\n' 'checksum OK'`,
  );
  writeExecutable(
    path.join(fakeBin, "tar"),
    `#!/usr/bin/env bash
case "$*" in
*openshell-gateway*) name="openshell-gateway" ;;
*openshell-sandbox*) name="openshell-sandbox" ;;
*) name="openshell" ;;
esac
case "\${1:-}" in
-tzf) printf '%s\\n' "$name"; exit 0 ;;
-tvzf) printf '%s\\n' "-rwxr-xr-x 0/0 1 2026-01-01 00:00 $name"; exit 0 ;;
esac
outdir=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-C" ]; then outdir="$arg"; break; fi
  prev="$arg"
done
printf '#!/usr/bin/env bash\nexit 0\n' > "$outdir/$name"
chmod 755 "$outdir/$name"`,
  );
  writeExecutable(
    path.join(fakeBin, "install"),
    `#!/usr/bin/env bash
dest="\${@: -1}"
if [ "\${NEMOCLAW_TEST_USER_LOCAL_ONLY:-}" = "1" ] && [[ "$dest" = /usr/local/bin/* ]]; then
  exit 90
fi
mkdir -p "$(dirname "$dest")"
case "$(basename "$dest")" in
openshell)
  printf '#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then echo "openshell ${REQUIRED_OPENSHELL_VERSION}"; else exit 0; fi\n# ${OPENSHELL_FEATURE_MARKERS}\n' > "$dest"
  ;;
openshell-sandbox)
  printf '#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then echo "openshell-sandbox ${REQUIRED_OPENSHELL_VERSION}"; exit 0; fi\n# ${OPENSHELL_MCP_FEATURE_MARKER}\nexit 0\n' > "$dest"
  ;;
openshell-gateway)
  printf '#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then echo "openshell-gateway ${REQUIRED_OPENSHELL_VERSION}"; exit 0; fi\nexit 0\n' > "$dest"
  ;;
*)
  printf '#!/usr/bin/env bash\nexit 0\n' > "$dest"
  ;;
esac
chmod 755 "$dest"`,
  );

  return { tmp, fakeBin, downloadLog, checksumLog };
}
