// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import * as policies from "../src/lib/policy";

type GmailPolicy = {
  name: string;
  endpoints: Array<Record<string, unknown>>;
  binaries: Array<{ path: string }>;
};

describe("gmail policy preset", () => {
  it("supports App Password IMAP and SMTP for Gmail attachment workflows (#3714)", () => {
    const gmail = policies.loadPreset("gmail");
    expect(gmail).not.toBeNull();

    const parsed = YAML.parse(String(gmail)) as {
      preset?: { name?: string; description?: string };
      network_policies?: { gmail_mail?: GmailPolicy };
    };

    expect(parsed.preset).toEqual({
      name: "gmail",
      description: "Gmail IMAP and SMTP access for Python App Password workflows",
    });
    expect(parsed.network_policies).toEqual({
      gmail_mail: {
        name: "gmail_mail",
        endpoints: [
          { host: "imap.gmail.com", port: 993, access: "full", tls: "skip" },
          { host: "smtp.gmail.com", port: 465, access: "full", tls: "skip" },
        ],
        binaries: [{ path: "/usr/bin/python3" }],
      },
    });

    for (const endpoint of parsed.network_policies?.gmail_mail?.endpoints ?? []) {
      expect(endpoint).not.toHaveProperty("protocol");
      expect(endpoint).not.toHaveProperty("enforcement");
      expect(endpoint).not.toHaveProperty("rules");
    }
  });
});
