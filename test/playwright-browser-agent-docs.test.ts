// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const guide = readFileSync(
  new URL("../docs/manage-sandboxes/run-playwright-browser-agent.mdx", import.meta.url),
  "utf8",
);

describe("Playwright browser agent guide", () => {
  it("keeps browser commands behind the credential-scrubbing exec boundary", () => {
    const commandBlock = guide.match(/```bash\nnemoclaw playwright-agent upload[\s\S]*?\n```/)?.[0];

    expect(commandBlock).toContain(
      "nemoclaw playwright-agent exec -- \\\n  python3 /sandbox/fill_form_example.py",
    );
    expect(guide).toContain("removes `OPENCLAW_GATEWAY_TOKEN`");
    expect(guide).toContain("do not source `/tmp/nemoclaw-proxy-env.sh`");
    expect(commandBlock).not.toContain("nemoclaw-proxy-env.sh");
    expect(commandBlock).not.toContain("bash -lc");
  });
});
