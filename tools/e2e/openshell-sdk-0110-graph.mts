// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";
import { reviewedNpmDependencyLocations } from "../../scripts/lib/reviewed-npm-archive.mts";

type JsonObject = Record<string, unknown>;

// Official registry archives were checked against their SHA-512 identities.
// The compatibility package re-exports the public SDK, which needs newer peers.
// This graph grants no candidate admission and contains no candidate code.
const REVIEWED_GRAPH: Record<string, JsonObject> = {
  "node_modules/@nvidia/openshell-sdk": {
    version: "0.1.10",
    resolved:
      "https://npm.pkg.github.com/download/@nvidia/openshell-sdk/0.1.10/09792a4aca8e55bc312bda80bfebc4dec441c0e3",
    integrity:
      "sha512-IGRHqQZ38AHbtx6mfyrpVRrHjSwg+jaSxKVOsuqKUUftdrN4FNe0FosNUbIq/KDmTQPRURbm+JPWg9mRmvaetg==",
    inBundle: true,
    license: "Apache-2.0",
    optional: true,
    dependencies: {
      "@ai-openshell/sdk": "^0.1.0",
    },
    engines: {
      node: ">=20.3",
    },
  },
  "node_modules/@ai-openshell/sdk": {
    version: "0.1.10",
    resolved: "https://registry.npmjs.org/@ai-openshell/sdk/-/sdk-0.1.10.tgz",
    integrity:
      "sha512-ugu1XQAS2rJl9Gy54ubDZQl+AlDCgxAZYVwPfzb+x7ZBw5yAnIj92dizEXduQ5np7FNQJzMdZ5PcCWVA+p6s+Q==",
    inBundle: true,
    license: "Apache-2.0",
    optional: true,
    dependencies: {
      "@bufbuild/protobuf": "^2.17.0",
      "@connectrpc/connect": "^2.3.0",
      "@connectrpc/connect-node": "^2.3.0",
    },
    engines: {
      node: ">=20.3",
    },
  },
  "node_modules/@bufbuild/protobuf": {
    version: "2.17.0",
    resolved: "https://registry.npmjs.org/@bufbuild/protobuf/-/protobuf-2.17.0.tgz",
    integrity:
      "sha512-hcPkSz6D7MiTU/5VBBhK+kxaYDoOdQ6yJRFJ3kS8Nydp+VZXfg1vrpABKPNod8bXMufsVCmiUJVIKFzCzta4uw==",
    inBundle: true,
    license: "(Apache-2.0 AND BSD-3-Clause)",
    optional: true,
  },
  "node_modules/@connectrpc/connect": {
    version: "2.3.0",
    resolved: "https://registry.npmjs.org/@connectrpc/connect/-/connect-2.3.0.tgz",
    integrity:
      "sha512-rjAn8L9KbAZrkwiB8m1qzDsLs74hkYmwwM2iSWuxTPVOTRm/EZw31smKbQqPU50AXqJC5eKKpEnA6Uf/swQOgQ==",
    inBundle: true,
    license: "Apache-2.0",
    optional: true,
    peerDependencies: {
      "@bufbuild/protobuf": "^2.7.0",
    },
  },
  "node_modules/@connectrpc/connect-node": {
    version: "2.3.0",
    resolved: "https://registry.npmjs.org/@connectrpc/connect-node/-/connect-node-2.3.0.tgz",
    integrity:
      "sha512-kcQgV4GqFIESsl0MOHInC9/wNYU4aJDvG1OfGR5Lq6/l0gqycSGqEk+fixXGcUtPLc8vJBgS4V1nTmWlh4o9gw==",
    inBundle: true,
    license: "Apache-2.0",
    optional: true,
    engines: {
      node: ">=22",
    },
    peerDependencies: {
      "@bufbuild/protobuf": "^2.7.0",
      "@connectrpc/connect": "2.3.0",
    },
  },
};

/** Project only the reviewed 0.1.10 SDK graph into the trusted controller. */
export function projectReviewedOpenShell0110Graph(
  candidate: Record<string, JsonObject>,
  trusted: Record<string, JsonObject>,
  manifest: JsonObject,
  root: JsonObject,
  dependencies: JsonObject,
): void {
  const locations = reviewedNpmDependencyLocations(candidate, "@nvidia/openshell-sdk");
  if (
    !isDeepStrictEqual([...locations].sort(), Object.keys(REVIEWED_GRAPH).sort()) ||
    Object.entries(REVIEWED_GRAPH).some(
      ([location, entry]) => !isDeepStrictEqual(candidate[location], entry),
    )
  ) {
    throw new Error("Protected OpenShell 0.1.10 SDK graph is not base-trusted");
  }
  for (const [location, entry] of Object.entries(REVIEWED_GRAPH)) {
    const name = location.slice("node_modules/".length);
    dependencies[name] = entry.version;
    (root.optionalDependencies as JsonObject)[name] = entry.version;
    trusted[location] = structuredClone(entry);
  }
  // Preserve every unrelated trusted dependency and bundle member.
  for (const record of [manifest, root]) {
    if (
      !Array.isArray(record.bundleDependencies) ||
      record.bundleDependencies.some((name) => typeof name !== "string")
    ) {
      throw new Error("Protected OpenShell 0.1.10 requires trusted bundle declarations");
    }
    record.bundleDependencies = [...new Set(["@ai-openshell/sdk", ...record.bundleDependencies])];
  }
}
