// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const HELPER = path.join(REPO_ROOT, "scripts", "managed-gateway-control.py");
const GATEWAY_LIFECYCLE_DOCS = path.join(
  REPO_ROOT,
  "docs",
  "manage-sandboxes",
  "gateway-lifecycle-control.mdx",
);

describe("managed gateway control trust contract", () => {
  it("keeps the shared-UID and mutable-config limits explicit in code and docs", () => {
    const helper = fs.readFileSync(HELPER, "utf8");
    const docs = fs.readFileSync(GATEWAY_LIFECYCLE_DOCS, "utf8");

    expect(helper).toContain("malicious same-UID agent");
    expect(helper).toContain("mutable config retains the same trust/TOCTOU limitations");
    expect(helper).toContain("cannot manufacture gateway/agent UID isolation");
    expect(helper).toContain(
      "minimum supported OpenShell launches a root-owned lifecycle supervisor",
    );

    expect(docs).toContain("malicious process running under the same sandbox UID");
    expect(docs).toContain("time-of-check/time-of-use limits of managed cold start");
    expect(docs).toContain("does not create gateway and agent UID isolation");
    expect(docs).toContain(
      "minimum supported OpenShell provides a root-owned lifecycle supervisor",
    );
  });
});
