// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import YAML from "yaml";
import type { NetworkDocument } from "../../../nemoclaw/src/shared/private-networks-boundary.cts";

// The source-mode early Windows preflight has no npm installation. Its generated
// data is checked against the canonical YAML before any runtime is packaged.
export function renderNativeEndpointPolicy(runtime: string) {
  const source = path.resolve(runtime, "../../../nemoclaw-blueprint/private-networks.yaml");
  const raw = fs.readFileSync(source, "utf8").replace(/\r\n/gu, "\n");
  const networks = YAML.parse(raw) as NetworkDocument;
  const data = {
    source: "nemoclaw-blueprint/private-networks.yaml",
    sourceSha256: createHash("sha256").update(raw).digest("hex"),
    ipv4: networks.ipv4.map(({ address, prefix }) => [address, prefix]),
    ipv6: networks.ipv6.map(({ address, prefix }) => [address, prefix]),
    names: networks.names.map(({ name }) => name.replace(/\.$/u, "").toLowerCase()),
  };
  return `${JSON.stringify(data, null, 2)}\n`;
}

export function verifyNativeEndpointPolicy(runtime: string, canonicalRuntime = runtime) {
  const expected = renderNativeEndpointPolicy(canonicalRuntime);
  const actual = fs.readFileSync(
    path.join(runtime, "native-endpoint-policy.generated.json"),
    "utf8",
  );
  if (JSON.stringify(JSON.parse(actual)) !== JSON.stringify(JSON.parse(expected)))
    throw new Error("The native endpoint policy is stale; regenerate it from the canonical YAML.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const runtime = fileURLToPath(new URL("../runtime/", import.meta.url));
  fs.writeFileSync(
    path.join(runtime, "native-endpoint-policy.generated.json"),
    renderNativeEndpointPolicy(runtime),
  );
}
