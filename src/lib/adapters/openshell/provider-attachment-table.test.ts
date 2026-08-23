// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { parseProviderAttachmentNames } from "./provider-attachment-table";

describe("OpenShell provider attachment table", () => {
  it("parses empty, populated, and ANSI-decorated attachment output", () => {
    expect(parseProviderAttachmentNames("No providers attached to sandbox alpha.")).toEqual([]);
    expect(
      parseProviderAttachmentNames(
        "\u001b[1mNAME TYPE CREDENTIAL_KEYS CONFIG_KEYS\u001b[0m\nalpha-token generic 1 0\n",
      ),
    ).toEqual(["alpha-token"]);
  });

  it("rejects output without the attachment table header", () => {
    expect(() => parseProviderAttachmentNames("alpha-token generic 1 0\n")).toThrow(
      "missing provider attachment table header",
    );
  });

  it("rejects malformed attachment table rows", () => {
    expect(() =>
      parseProviderAttachmentNames(
        "NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS\nalpha-token generic one zero\n",
      ),
    ).toThrow("invalid provider attachment table row");
  });
});
