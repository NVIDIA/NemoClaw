// Verify shellQuote is applied to sandboxName in shell commands
import fs from "fs";
import path from "path";
import { describe, it, expect } from "vitest";

describe("sandboxName shell quoting in onboard.js", () => {
  const src = fs.readFileSync(
    path.join(import.meta.dirname, "..", "bin", "lib", "onboard.js"),
    "utf-8",
  );

  it("quotes sandboxName in openshell sandbox exec command", () => {
    expect(src).toMatch(/openshell sandbox exec \$\{shellQuote\(sandboxName\)\}/);
  });

  it("quotes sandboxName in setup-dns-proxy.sh command", () => {
    expect(src).toMatch(
      /setup-dns-proxy\.sh.*\$\{shellQuote\(GATEWAY_NAME\)\}.*\$\{shellQuote\(sandboxName\)\}/,
    );
  });

  it("does not have unquoted sandboxName in runCapture or run calls", () => {
    const lines = src.split("\n");
    const violations = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (
        (line.includes("run(") || line.includes("runCapture(")) &&
        line.includes("${sandboxName}") &&
        !line.includes("shellQuote(sandboxName)")
      ) {
        violations.push(`Line ${i + 1}: ${line.trim()}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
