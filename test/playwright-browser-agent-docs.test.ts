// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const guide = readFileSync(
  new URL("../docs/manage-sandboxes/run-playwright-browser-agent.mdx", import.meta.url),
  "utf8",
);

describe("Playwright browser agent guide", () => {
  it("pins the custom-image base by digest (#4218)", () => {
    const onboardingBlock = guide.match(
      /```bash\n\s*NEMOCLAW_SANDBOX_BASE_IMAGE_REF=[\s\S]*?--from "\$PWD\/Dockerfile"\n\s*```/,
    )?.[0];

    expect(onboardingBlock).toMatch(/ghcr\.io\/nvidia\/nemoclaw\/sandbox-base@sha256:[0-9a-f]{64}/);
    expect(onboardingBlock).not.toContain("sandbox-base:v0.0.80");
  });

  it("keeps the browser policy and TLS trust boundaries (#4218)", () => {
    const policyBlock = guide.match(/```yaml\npreset:[\s\S]*?\n```/)?.[0];
    const browserBlock = guide.match(/```python\nimport hashlib[\s\S]*?\n```/)?.[0];

    expect(policyBlock).toContain("- { path: /usr/local/lib/ms-playwright/** }");
    expect(browserBlock).toContain('ca_bundle = os.environ.get("SSL_CERT_FILE")');
    expect(browserBlock).toMatch(/["']certutil["'][\s\S]*?["']-A["']/);
    expect(browserBlock).not.toMatch(/ignore_https_errors|--ignore-certificate-errors/i);
  });

  it("keeps browser commands behind the credential-scrubbing exec boundary (#4218)", () => {
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
