// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { BoundedLineDecoder, BoundedTextTranscript } from "./bounded-line-transcript";

describe("BoundedLineDecoder", () => {
  it("preserves split UTF-8 characters and line boundaries", () => {
    const lines: string[] = [];
    const decoder = new BoundedLineDecoder({
      maxPendingChars: 32,
      onLine: (line) => lines.push(line),
    });
    const encoded = Buffer.from("alpha\n안녕\r\nomega");

    decoder.write(encoded.subarray(0, 8));
    decoder.write(encoded.subarray(8, 11));
    decoder.write(encoded.subarray(11));
    decoder.end();

    expect(lines).toEqual(["alpha", "안녕", "omega"]);
  });

  it("treats a carriage return and line feed split across chunks as one boundary", () => {
    const lines: string[] = [];
    const decoder = new BoundedLineDecoder({
      maxPendingChars: 32,
      onLine: (line) => lines.push(line),
    });

    decoder.write("alpha\r");
    decoder.write("\nbeta\r");
    decoder.write("gamma\n");
    decoder.end();

    expect(lines).toEqual(["alpha", "beta", "gamma"]);
  });

  it("bounds a child stream that never emits a line break", () => {
    const lines: string[] = [];
    const decoder = new BoundedLineDecoder({
      maxPendingChars: 8,
      onLine: (line) => lines.push(line),
    });

    decoder.write("unbounded-prefix-terminal");
    decoder.end();

    expect(lines).toEqual([
      "[NemoClaw] 17 leading characters omitted from oversized output line: terminal",
    ]);
  });
});

describe("BoundedTextTranscript", () => {
  it("keeps leading and trailing evidence within a fixed budget", () => {
    const transcript = new BoundedTextTranscript({ maxChars: 20, headChars: 5 });
    transcript.appendLine("first");
    transcript.appendLine("middle-middle-middle");
    transcript.appendLine("terminal");

    const output = transcript.toString();
    expect(output).toContain("first");
    expect(output).toContain("terminal");
    expect(output).toContain("transcript characters omitted");
    expect(output.length).toBeLessThan(100);
  });
});
