// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const START_SH = path.join(import.meta.dirname, "..", "agents", "hermes", "start.sh");

describe("Hermes startup rc rewrite", () => {
  it("stages edits in /tmp and writes rc files in-place", () => {
    const src = fs.readFileSync(START_SH, "utf-8");

    const fnStart = src.indexOf("rewrite_rc_marker_block()");
    const fnEnd = src.indexOf("rewrite_rc_marker_block_or_fail_in_root()");

    expect(fnStart).toBeGreaterThan(-1);
    expect(fnEnd).toBeGreaterThan(fnStart);

    const block = src.substring(fnStart, fnEnd);
    expect(block).toContain('mktemp "/tmp/.${base}.tmp.XXXXXX"');
    expect(block).toContain('chmod u+w "$rc_file" 2>/dev/null || true');
    expect(block).toContain('tee "$rc_file" >/dev/null <"$tmp"');
    expect(block).toContain('gosu sandbox bash -c "chmod u+w \\\"${rc_file}\\\" 2>/dev/null || true; cat \\\"${tmp}\\\" > \\\"${rc_file}\\\""');
  });
});