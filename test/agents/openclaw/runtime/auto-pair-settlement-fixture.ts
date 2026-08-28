// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PUBLIC_KEY = "y3vjb9p8tAecivI1l5f1Hdc9QdZJSt3BmLkJMM7wZD8";
const DEVICE_ID = "04a4c561c730435e9f6a2e38d2e7b929bcbec2ea1c37d3dd053f3341ecce4e47";

export function createCanonicalCliFixture(stateDir: string) {
  fs.mkdirSync(path.join(stateDir, "identity"), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "identity", "device.json"),
    JSON.stringify({
      deviceId: DEVICE_ID,
      publicKeyPem:
        "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAy3vjb9p8tAecivI1l5f1Hdc9QdZJSt3BmLkJMM7wZD8=\n-----END PUBLIC KEY-----\n",
    }),
  );
  return {
    deviceId: DEVICE_ID,
    publicKey: PUBLIC_KEY,
    clientId: "cli",
    clientMode: "cli",
    role: "operator",
    roles: ["operator"],
    scopes: ["operator.pairing", "operator.write"],
    approvedScopes: ["operator.pairing", "operator.write"],
    tokens: {
      operator: {
        role: "operator",
        revokedAtMs: null,
        scopes: ["operator.pairing", "operator.read", "operator.write"],
      },
    },
  };
}

export function setupLateCliFixture(prefix: string): {
  tmpDir: string;
  fakeOpenclaw: string;
  approveLog: string;
  stateDir: string;
} {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const fakeOpenclaw = path.join(tmpDir, "openclaw");
  const stateDir = path.join(tmpDir, "state");
  const stateFile = path.join(tmpDir, "list-count");
  const approveLog = path.join(tmpDir, "approvals.log");
  const browserClient = { clientId: "openclaw-control-ui", clientMode: "webchat" };
  const cliClient = { clientId: "cli", clientMode: "cli" };
  const canonicalCliClient = createCanonicalCliFixture(stateDir);
  const initialPending = JSON.stringify({
    pending: [{ requestId: "browser-pair", ...browserClient }],
    paired: [],
  });
  const browserPaired = JSON.stringify({ pending: [], paired: [browserClient] });
  const lateCli = JSON.stringify({
    pending: [
      { requestId: "late-cli", ...cliClient },
      { requestId: "late-cli-b", ...cliClient },
    ],
    paired: [browserClient],
  });
  const allPaired = JSON.stringify({
    pending: [],
    paired: [browserClient, canonicalCliClient],
  });
  fs.writeFileSync(
    fakeOpenclaw,
    `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "list" ]; then
  count="$(cat ${JSON.stringify(stateFile)} 2>/dev/null || echo 0)"
  count=$((count + 1))
  echo "$count" > ${JSON.stringify(stateFile)}
  if [ "$count" -le 2 ]; then printf '%s\n' ${JSON.stringify(initialPending)}
  elif [ "$count" -le 6 ]; then printf '%s\n' ${JSON.stringify(browserPaired)}
  elif [ "$count" -le 10 ]; then printf '%s\n' ${JSON.stringify(lateCli)}
  else printf '%s\n' ${JSON.stringify(allPaired)}; fi
  exit 0
fi
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "approve" ]; then
  echo "$3" >> ${JSON.stringify(approveLog)}
  printf '{}\n'
  exit 0
fi
echo "unexpected: $*" >&2
exit 2
`,
    { mode: 0o755 },
  );
  return { tmpDir, fakeOpenclaw, approveLog, stateDir };
}
