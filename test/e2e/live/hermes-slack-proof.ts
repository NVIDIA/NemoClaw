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
