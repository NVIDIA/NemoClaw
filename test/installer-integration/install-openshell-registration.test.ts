// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { runCommandWithInstalledVersion } from "../support/openshell-installed-version";

describe("OpenShell installer gateway registrations", { timeout: 15_000 }, () => {
  it.each(["user", "system", "fixed-system"] as const)(
    "preserves components when the %s gateway registration is a regular file",
    (legacyRegistrationFile) => {
      const result = runCommandWithInstalledVersion("0.0.116", {}, { legacyRegistrationFile });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("a legacy gateway registration is not a directory");
      expect(result.downloads).toBe("");
      expect(result.retainedFilesUnchanged).toBe(true);
    },
  );
});
