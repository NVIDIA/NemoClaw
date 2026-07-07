// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.join(import.meta.dirname, "..");
const dockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");

describe("messaging runtime preload packaging", () => {
  it("packages preload JavaScript compiled from TypeScript without requiring root npm metadata", () => {
    expect(dockerfile).toContain("AS runtime-preload-builder");
    expect(dockerfile).toContain("FROM builder AS runtime-preload-builder");
    expect(dockerfile).toContain("COPY tsconfig.runtime-preloads.json /opt/nemoclaw-root/");
    expect(dockerfile).toContain(
      "COPY src/lib/messaging/channels/ /opt/nemoclaw-root/src/lib/messaging/channels/",
    );
    expect(dockerfile).toContain(
      "/opt/nemoclaw/node_modules/.bin/tsc -p tsconfig.runtime-preloads.json",
    );
    expect(dockerfile).toContain(
      "COPY --from=runtime-preload-builder /opt/nemoclaw-root/dist/lib/messaging/channels/",
    );
    expect(dockerfile).toContain("-path '*/runtime/*.js'");
    expect(dockerfile).not.toContain("COPY package.json package-lock.json tsconfig.src.json");
    expect(dockerfile).not.toContain("npm ci --ignore-scripts");
    expect(dockerfile).not.toContain(
      "COPY src/lib/messaging/channels/*/runtime/*.ts /usr/local/lib/nemoclaw/preloads-ts/",
    );
    expect(dockerfile).not.toContain('basename "$file" .ts');
  });
});
