import { describe, expect, it } from "vitest";
import path from "node:path";

describe("probe", () => {
  it("checks require availability for source modules", () => {
    const p = path.join(process.cwd(), "src", "commands", "sandbox", "policy", "exclude.ts");
    const loaded = require(p) as { default: { flags?: Record<string, unknown> } };
    console.log("require ok, flags:", Object.keys(loaded.default.flags ?? {}));
    expect(typeof loaded.default).toBe("function");
  });
});
