// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const EXTERNAL_HOST_HELPER = path.join(ROOT, "agents", "hermes", "dashboard-external-host.sh");

function resolveExternalHost(url: string) {
  return spawnSync(
    "bash",
    [
      "-c",
      'set -eo pipefail; source "$1"; nemoclaw_hermes_dashboard_external_host "$2"',
      "bash",
      EXTERNAL_HOST_HELPER,
      url,
    ],
    { encoding: "utf8", timeout: 5000 },
  );
}

it("derives the canonical hostname from an HTTPS CHAT_UI_URL with a port and path (#10651)", () => {
  const run = resolveExternalHost("https://NEMOCLAW0-ABC123.BREVLAB.COM.:29443/dashboard");

  expect(run.status).toBe(0);
  expect(run.stdout).toBe("nemoclaw0-abc123.brevlab.com\n");
});

it.each([
  {
    condition: "the external scheme is not HTTPS",
    status: 1,
    url: "http://dashboard.example.test:29443",
  },
  { condition: "the host is an IPv4 loopback address", status: 2, url: "https://127.0.0.1:29443" },
  { condition: "the host is localhost", status: 2, url: "http://localhost.:29443" },
  {
    condition: "the host is an unspecified address",
    status: 1,
    url: "https://0.0.0.0:29443",
  },
  {
    condition: "the hostname is only a root label",
    status: 1,
    url: "https://./",
  },
  {
    condition: "the URL includes user information",
    status: 1,
    url: "https://user@dashboard.example.test",
  },
  {
    condition: "the port is malformed",
    status: 1,
    url: "https://dashboard.example.test:invalid",
  },
])("does not derive an external host when $condition (#10651)", ({ status, url }) => {
  const run = resolveExternalHost(url);

  expect(run.status).toBe(status);
  expect(run.stdout).toBe("");
});
