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

// Startup persists the generation-scoped handles injected for these providers.
// Check every assignment so a valid value cannot hide a duplicate raw token.
export const HERMES_SLACK_ENV_PROBE = String.raw`
from pathlib import Path
import re
import sys

text = Path(sys.argv[1]).read_text(encoding="utf-8")
lines = text.splitlines()
missing = sorted({"API_SERVER_PORT=18642"} - set(lines))
injected_pattern = ${JSON.stringify(HERMES_SLACK_INJECTED_TOKEN_PATTERN)}
invalid = set()
for key in ("SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"):
    values = re.findall(r"^\s*(?:export\s+)?" + key + r"\s*=(.*)$", text, re.MULTILINE)
    expected = injected_pattern.removeprefix("^").removesuffix("$").replace(
        "(SLACK_BOT_TOKEN|SLACK_APP_TOKEN)", re.escape(key)
    )
    quoted = r"(?P<quote>['\"]?)" + expected + r"(?P=quote)"
    if any(not re.fullmatch(quoted, value.strip()) for value in values):
        invalid.add(key)
if missing:
    print("FAIL missing " + ", ".join(missing))
elif invalid:
    print("FAIL invalid " + ", ".join(sorted(invalid)))
else:
    print("OK")
`;
