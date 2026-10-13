// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type HermesSlackApiProof =
  | { readonly kind: "passed" }
  | { readonly kind: "timeout"; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string };

export function classifyHermesSlackApiProof(output: string): HermesSlackApiProof {
  const timeout = output.match(/^TIMEOUT[^\r\n]*/mu)?.[0];
  if (timeout) return { kind: "timeout", reason: timeout };

  const failure = output.match(/^(?:FAIL|ERROR)[^\r\n]*/mu)?.[0];
  if (failure) return { kind: "failed", reason: failure };

  const expectedMarkers: ReadonlyArray<readonly [string, RegExp]> = [
    ["auth.test", /^OK auth[.]test:/mu],
    ["apps.connections.open", /^OK apps[.]connections[.]open:/mu],
  ];
  const missing = expectedMarkers.flatMap(([label, pattern]) =>
    pattern.test(output) ? [] : [label],
  );
  if (missing.length > 0) {
    return { kind: "failed", reason: `missing successful probe marker: ${missing.join(", ")}` };
  }
  return { kind: "passed" };
}

export function assertHermesSlackApiProof(output: string): void {
  const proof = classifyHermesSlackApiProof(output);
  if (proof.kind === "passed") return;

  const result = proof.kind === "timeout" ? "incomplete required evidence" : "failed";
  throw new Error(`Slack API proof ${result}: ${proof.reason}`);
}

export const HERMES_SLACK_INJECTED_TOKEN_PATTERN =
  "^openshell:resolve:env:(?:v[0-9]{1,20}|s[a-f0-9]{64})_(SLACK_BOT_TOKEN|SLACK_APP_TOKEN)$";

// Startup persists the current generation-scoped handles for both providers.
export const HERMES_SLACK_ENV_PROBE = String.raw`
import glob
import os
import re
import sys
from pathlib import Path
text = Path(sys.argv[1]).read_text(encoding="utf-8")
lines = text.splitlines()
required = {"API_SERVER_PORT=18642"}
missing = sorted(required - set(lines))
# Hermes loads this file with override=True. Its startup guard intentionally
# persists OpenShell's scoped placeholders here, so each assignment must match
# the currently injected generation exactly. A raw, stale, or duplicate value
# would shadow that injection and fail this boundary.
def assignment_key(line):
    stripped = line.strip()
    if stripped.startswith("export "):
        stripped = stripped[len("export ") :].lstrip()
    return stripped.split("=", 1)[0].strip() if "=" in stripped else ""

def scoped_placeholder(value, key):
    match = re.fullmatch(${JSON.stringify(HERMES_SLACK_INJECTED_TOKEN_PATTERN)}, value)
    return match is not None and match.group(1) == key

def injected_placeholder(key):
    direct = os.environ.get(key, "")
    observed = {direct} - {""}
    for entry in glob.glob("/proc/[0-9]*/environ"):
        try:
            items = Path(entry).read_bytes().decode("utf-8", errors="replace").split("\0")
        except (OSError, PermissionError):
            continue
        observed.update(item.split("=", 1)[1] for item in items if item.startswith(key + "=") and item.split("=", 1)[1])
    value = next(iter(observed), "")
    return value if len(observed) == 1 and scoped_placeholder(value, key) else ""

injected = {key: injected_placeholder(key) for key in ("SLACK_BOT_TOKEN", "SLACK_APP_TOKEN")}
invalid = sorted(
    key for key in ("SLACK_BOT_TOKEN", "SLACK_APP_TOKEN")
    if [line.split("=", 1)[1].strip() for line in lines if assignment_key(line) == key] != [injected[key]]
    or not injected[key]
)
failures = missing + invalid
print("FAIL missing or unsafe " + ", ".join(failures) if failures else "OK")
`;
