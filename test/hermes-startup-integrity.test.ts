// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const START_SH = path.join(import.meta.dirname, "..", "agents", "hermes", "start.sh");

describe("Hermes startup integrity verification", () => {
  it("anchors verification to root hash and validates via sandbox user", () => {
    const src = fs.readFileSync(START_SH, "utf-8");

    expect(src).toContain('HERMES_HASH_FILE="/etc/nemoclaw/hermes.config-hash"');
    expect(src).toContain("verify_hermes_config_integrity() {");
    expect(src).toContain('gosu sandbox bash -c "source \\\"${_SANDBOX_INIT}\\\"; verify_config_integrity \\\"${HERMES_IMMUTABLE}\\\" \\\"${HERMES_HASH_FILE}\\\""');
    expect(src).toContain('verify_config_integrity "${HERMES_IMMUTABLE}" "${HERMES_HASH_FILE}"');
    expect(src).toContain('if [ -L "${HERMES_WRITABLE}" ]; then');
    expect(src).toContain('mkdir -p "${HERMES_WRITABLE}"');
    expect(src).toContain("validate_config_symlinks /sandbox/.hermes /sandbox/.hermes/runtime");
    expect(src).toContain("gosu gateway sh -c 'exec \"$@\" >/tmp/gateway.log 2>&1' sh \"$HERMES\" gateway run &");
  });
});
