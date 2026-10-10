// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { consumeNativeGatewayCreation, prepareNativeGatewayCreation } from "./native-creation";

const endpoint = "http://127.0.0.1:8080";
const roots: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-creation-"));
  roots.push(root);
  const write = () => {
    fs.mkdirSync(path.join(root, "jwt"), { recursive: true, mode: 0o700 });
    for (const file of ["openshell-gateway.toml", "jwt/signing.pem", "jwt/public.pem", "jwt/kid"])
      fs.writeFileSync(path.join(root, file), `fixture ${file}`, { mode: 0o600 });
    return "prepared";
  };
  return { root, write, prepare: () => prepareNativeGatewayCreation(root, endpoint, write) };
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    consumeNativeGatewayCreation(root, endpoint);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("current-invocation native gateway creation authority", () => {
  it("survives its own repeated preparation and is consumed once (#12558)", () => {
    const f = fixture();
    expect(f.prepare()).toBe("prepared");
    f.prepare();
    const proof = consumeNativeGatewayCreation(f.root, endpoint);
    expect(proof?.()).toBe(true);
    expect(consumeNativeGatewayCreation(f.root, endpoint)).toBeUndefined();
    f.prepare();
    expect(consumeNativeGatewayCreation(f.root, endpoint)).toBeUndefined();
  });
  it.each(["openshell.db", "runtime.json", "openshell-gateway.toml"])(
    "does not activate preexisting %s state (#12558)",
    (name) => {
      const f = fixture();
      fs.writeFileSync(path.join(f.root, name), "existing");
      f.prepare();
      expect(consumeNativeGatewayCreation(f.root, endpoint)).toBeUndefined();
    },
  );
  it("does not activate a preexisting JWT directory (#12558)", () => {
    const f = fixture();
    fs.mkdirSync(path.join(f.root, "jwt"));
    f.prepare();
    expect(consumeNativeGatewayCreation(f.root, endpoint)).toBeUndefined();
  });
  it.each(["openshell.db", "runtime.json", "openshell-gateway.toml", "jwt/kid"])(
    "rejects intervening %s writes even through another preparation (#12558)",
    (name) => {
      const f = fixture();
      f.prepare();
      fs.writeFileSync(path.join(f.root, name), "changed");
      f.prepare();
      expect(consumeNativeGatewayCreation(f.root, endpoint)).toBeUndefined();
    },
  );
  it("does not retain authority after a preparation throws (#12558)", () => {
    const f = fixture();
    f.prepare();
    expect(() =>
      prepareNativeGatewayCreation(f.root, endpoint, () => {
        f.write();
        throw new Error("partial preparation");
      }),
    ).toThrow("partial preparation");
    f.prepare();
    expect(consumeNativeGatewayCreation(f.root, endpoint)).toBeUndefined();
  });
  it("cannot transfer authority between endpoints or state directories (#12558)", () => {
    const a = fixture();
    const b = fixture();
    a.prepare();
    expect(consumeNativeGatewayCreation(b.root, endpoint)).toBeUndefined();
    expect(consumeNativeGatewayCreation(a.root, "http://127.0.0.1:8081")).toBeUndefined();
    expect(consumeNativeGatewayCreation(a.root, endpoint)).toBeUndefined();
  });
  it("rejects a replacement file even with identical contents (#12558)", () => {
    const f = fixture();
    f.prepare();
    const file = path.join(f.root, "jwt/kid");
    fs.writeFileSync(`${file}.new`, fs.readFileSync(file), { mode: 0o600 });
    fs.renameSync(`${file}.new`, file);
    expect(consumeNativeGatewayCreation(f.root, endpoint)).toBeUndefined();
  });
  it("does not follow a replaced JWT file symlink (#12558)", () => {
    const f = fixture();
    f.prepare();
    const file = path.join(f.root, "jwt/kid");
    fs.renameSync(file, `${file}.saved`);
    fs.symlinkSync(`${file}.saved`, file);
    expect(consumeNativeGatewayCreation(f.root, endpoint)).toBeUndefined();
  });
  it("allows runtime creation after consumption but rejects generated config drift (#12558)", () => {
    const f = fixture();
    f.prepare();
    const proof = consumeNativeGatewayCreation(f.root, endpoint);
    fs.writeFileSync(path.join(f.root, "openshell.db"), "new runtime");
    fs.writeFileSync(path.join(f.root, "runtime.json"), "new runtime marker");
    expect(proof?.()).toBe(true);
    fs.appendFileSync(path.join(f.root, "openshell-gateway.toml"), "changed");
    expect(proof?.()).toBe(false);
  });
});
