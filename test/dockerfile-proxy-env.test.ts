// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DOCKERFILE = join(import.meta.dirname, "..", "Dockerfile");

// Assert per-variable rather than as one exact multi-line block. The values
// (each proxy var pointing at the OpenShell proxy template) are what matter;
// an exact block match is brittle and breaks on benign reformatting or
// line-continuation differences introduced when the branch is merged with main
// (this is what previously turned the check red without any value change). #4304
const PROXY_URL = String.raw`http://\$\{NEMOCLAW_PROXY_HOST\}:\$\{NEMOCLAW_PROXY_PORT\}`;
const NO_PROXY_VAL = String.raw`localhost,127\.0\.0\.1,::1,\$\{NEMOCLAW_PROXY_HOST\}`;

describe("Dockerfile runtime proxy environment (#4304)", () => {
  const dockerfile = readFileSync(DOCKERFILE, "utf8");

  it.each(["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"])(
    "seeds %s from NEMOCLAW_PROXY_HOST/PORT",
    (key) => {
      expect(dockerfile).toMatch(new RegExp(`(?<![A-Za-z_])${key}=${PROXY_URL}`));
    },
  );

  it.each(["NO_PROXY", "no_proxy"])(
    "seeds %s with local exclusions plus the proxy host",
    (key) => {
      expect(dockerfile).toMatch(new RegExp(`(?<![A-Za-z_])${key}=${NO_PROXY_VAL}`));
    },
  );
});
