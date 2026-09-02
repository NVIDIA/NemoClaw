// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, assert, describe, expect, it, vi } from "vitest";

import {
  assertNoHermesPortableHostAuthority,
  defaultPortableStateDir,
  getHermesPortableHostAuthorityEntryCount,
  hasPortableRetirementRecord,
  inspectPortableRetirementRecovery,
  portableRetirementFingerprint,
  preparePortableRetirement,
  publishAndRetirePortableEvidence,
  resumePortableEvidenceRetirement,
  supersedePortableRetirementAfterOnboard,
  type PortableOnboardAuthorityAdmission,
} from "./portable-uninstall-retirement";

const RECEIPT_BASENAME = `${"d".repeat(64)}.json`;
const temporaryDirectories: string[] = [];

function fixture() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-retirement-"));
  temporaryDirectories.push(homeDir);
  const stateDir = path.join(homeDir, ".nemoclaw");
  const receipt = path.join(stateDir, "portable-demo-lifecycle", RECEIPT_BASENAME);
  const registryFile = path.join(stateDir, "sandboxes.json");
  const config = path.join(homeDir, ".config/nemoclaw/portable/containers.conf");
  fs.mkdirSync(path.dirname(receipt), { mode: 0o700, recursive: true });
  fs.mkdirSync(path.dirname(config), { mode: 0o700, recursive: true });
  fs.writeFileSync(receipt, "{}\n", { mode: 0o600 });
  fs.writeFileSync(registryFile, "{}\n", { mode: 0o600 });
  fs.writeFileSync(config, "[engine]\n", { mode: 0o600 });
  return { config, homeDir, receipt, registryFile, stateDir };
}

type Fixture = ReturnType<typeof fixture>;
type TargetRole = "config" | "receipt" | "registry";
const noMutation = (): void => undefined;

function prepareFixture(test: Fixture) {
  return preparePortableRetirement(test.homeDir, [RECEIPT_BASENAME]);
}

function retirementRecordPath(test: Fixture): string {
  return path.join(test.stateDir, "portable-uninstall-retirement.json");
}

function targetPath(test: Fixture, role: TargetRole): string {
  return role === "config" ? test.config : role === "receipt" ? test.receipt : test.registryFile;
}

function retiredFixture() {
  const test = fixture();
  publishAndRetirePortableEvidence(prepareFixture(test));
  const files = [
    path.join(test.stateDir, "onboard-session.json"),
    test.registryFile,
    path.join(test.stateDir, "portable-demo-lifecycle", `${"e".repeat(64)}.json`),
  ];
  fs.mkdirSync(path.dirname(files[2]!), { mode: 0o700, recursive: true });
  for (const target of files) fs.writeFileSync(target, "{}\n", { mode: 0o600 });
  const admission: PortableOnboardAuthorityAdmission = { files, verify: () => {} };
  return { admission, test };
}

function spawnForSignal(
  args: readonly string[],
): Promise<{ signal: NodeJS.Signals | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += String(chunk)));
    child.once("close", (_code, signal) => resolve({ signal, stderr }));
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("portable uninstall retirement state", () => {
  it("shares the guarded portable state root across host admission owners (#9203)", () => {
    const homeDir = "/home/nemoclaw-test";
    const stateDir = "/private/nemoclaw-test-state";

    expect(
      defaultPortableStateDir({
        HOME: homeDir,
        NEMOCLAW_TEST_STATE_DIR: stateDir,
      }),
    ).toBe(path.join(homeDir, ".nemoclaw"));
    expect(
      defaultPortableStateDir({
        HOME: homeDir,
        VITEST: "true",
        NEMOCLAW_TEST_BASE_HOME: homeDir,
        NEMOCLAW_TEST_STATE_DIR: stateDir,
      }),
    ).toBe(stateDir);
    expect(defaultPortableStateDir({ HOME: "" })).toBe(path.join(os.homedir(), ".nemoclaw"));
    expect(defaultPortableStateDir({})).toBe(path.join(os.homedir(), ".nemoclaw"));
  });

  it.each([1, 2])(
    "fails closed on %i malformed or ambiguous schema-5 authority entries (#9203)",
    (entryCount) => {
      const test = fixture();
      const authorityRoot = path.join(test.stateDir, "hermes-portable-lifecycle");
      fs.mkdirSync(authorityRoot, { mode: 0o700 });
      Array.from({ length: entryCount }, (_unused, index) =>
        fs.writeFileSync(path.join(authorityRoot, `ambiguous-${index}`), "not-a-receipt\n", {
          mode: 0o600,
        }),
      );

      expect(getHermesPortableHostAuthorityEntryCount(test.stateDir)).toBe(entryCount);
      expect(() => assertNoHermesPortableHostAuthority(test.stateDir, "list")).toThrow(
        "Command 'list' is not supported while an experimental Hermes portable lifecycle receipt exists. No legacy Docker or OpenShell action was attempted.",
      );
    },
  );

  it("preserves ordinary host command admission when schema-5 authority is absent (#9203)", () => {
    const test = fixture();

    expect(getHermesPortableHostAuthorityEntryCount(test.stateDir)).toBe(0);
    expect(() => assertNoHermesPortableHostAuthority(test.stateDir, "list")).not.toThrow();
  });

  it("publishes the sole private retry record without raw cleanup authority (#9189)", () => {
    const test = fixture();
    const prepared = prepareFixture(test);
    const parsed = JSON.parse(prepared.recordBytes.toString("utf8")) as { targets: unknown[] };

    expect(
      portableRetirementFingerprint(
        "a".repeat(64),
        "receipt",
        `${"b".repeat(64)}.json`,
        Buffer.from('{"a":1}\n'),
      ),
    ).toBe("6316a6763402558ab9baccade86232099b32cdc73a52e6627b5e9098a4bf314e");
    expect(
      portableRetirementFingerprint(
        "a".repeat(64),
        "receipt",
        `${"b".repeat(64)}.json`,
        Buffer.from("c"),
      ),
    ).not.toBe(
      portableRetirementFingerprint(
        "a".repeat(64),
        "receipt",
        `${"c".repeat(64)}.json`,
        Buffer.from("bc"),
      ),
    );
    expect(
      (
        [
          [255, "09adecb5bfc2c496d9e1f4e737b4973699fa3f6f4a9027c0633bda893f7d9cfb"],
          [256, "a62d83f4aa319e94abbccbb75d1dea277e450e5167be6872d87eb52d2e7a8b30"],
          [65_535, "ab48f19398e2af46d86be80dea98e8326b67360e6cd8d3a171cc8c1a2b67a1b7"],
          [65_536, "e868451822f03cecc74591d7785d6799f01d6742a83082d45d9f033c970afdbd"],
        ] as const
      ).every(([size, vector]) =>
        Object.is(
          portableRetirementFingerprint(
            "a".repeat(64),
            "config",
            "containers.conf",
            Buffer.alloc(size, 1),
          ),
          vector,
        ),
      ),
    ).toBe(true);
    (
      [
        ["", "config", "containers.conf", Buffer.from("x")],
        [new String("a".repeat(64)), "config", "containers.conf", Buffer.from("x")],
        ["A".repeat(64), "config", "containers.conf", Buffer.from("x")],
        ["a".repeat(64), "invalid", "containers.conf", Buffer.from("x")],
        ["a".repeat(64), "config", "containers.conf\0", Buffer.from("x")],
        ["a".repeat(64), "receipt", "../receipt.json", Buffer.from("x")],
        ["a".repeat(64), "registry", "sandboxes.json", Buffer.alloc(0)],
        ["a".repeat(64), "receipt", `${"b".repeat(64)}.json`, Buffer.alloc(4_097)],
        ["a".repeat(64), "config", "containers.conf", Buffer.alloc(65_537)],
        ["a".repeat(64), "registry", "sandboxes.json", Buffer.alloc(1_048_577)],
      ] as const
    ).forEach((input) => {
      expect(() =>
        portableRetirementFingerprint(
          ...(input as unknown as Parameters<typeof portableRetirementFingerprint>),
        ),
      ).toThrow(/invalid/);
    });
    expect(JSON.stringify(parsed)).not.toContain("alpha");
    expect(JSON.stringify(parsed)).not.toContain(test.homeDir);
    expect(JSON.stringify(parsed)).not.toContain("helper_binaries_dir");
    expect(parsed.targets.every((target) => Array.isArray(target) && target.length === 11)).toBe(
      true,
    );
    const configTarget = parsed.targets[0] as string[];
    const configStat = fs.statSync(test.config, { bigint: true });
    expect(configTarget.slice(2, 10)).toEqual(
      [
        configStat.dev,
        configStat.ino,
        configStat.size,
        configStat.uid,
        configStat.mode,
        configStat.nlink,
        configStat.mtimeNs,
        configStat.ctimeNs,
      ].map(String),
    );

    publishAndRetirePortableEvidence(prepared);
    const record = retirementRecordPath(test);
    expect(fs.statSync(test.stateDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(record).mode & 0o777).toBe(0o600);
    expect(
      [test.config, test.receipt, test.registryFile].every((target) => !fs.existsSync(target)),
    ).toBe(true);
    expect(fs.existsSync(path.dirname(test.config))).toBe(false);
    expect(fs.existsSync(path.dirname(path.dirname(test.config)))).toBe(false);
    expect(inspectPortableRetirementRecovery(test.homeDir)).toEqual({
      artifacts: [],
      fixedState: "1000",
      registryBytes: null,
    });
    expect(() => resumePortableEvidenceRetirement(test.homeDir)).not.toThrow();
    expect(hasPortableRetirementRecord(test.homeDir)).toBe(true);
  });

  it.each([
    [
      "portable configuration",
      (test: Fixture) => path.join(path.dirname(test.config), "kept.conf"),
      true,
    ],
    [
      "NemoClaw configuration",
      (test: Fixture) => path.join(path.dirname(path.dirname(test.config)), "kept.conf"),
      false,
    ],
  ])(
    "preserves unrelated %s content during retirement (#9189)",
    (_label, markerPath, portableDirectoryRemains) => {
      const test = fixture();
      const marker = markerPath(test);
      fs.writeFileSync(marker, "operator-owned\n", { mode: 0o600 });

      publishAndRetirePortableEvidence(prepareFixture(test));

      expect(fs.existsSync(test.config)).toBe(false);
      expect(fs.readFileSync(marker, "utf8")).toBe("operator-owned\n");
      expect(fs.existsSync(path.dirname(test.config))).toBe(portableDirectoryRemains);
      expect(fs.existsSync(path.dirname(path.dirname(test.config)))).toBe(true);
    },
  );

  it("preserves a NemoClaw configuration directory with more than 1,024 entries (#9189)", () => {
    const test = fixture();
    const prepared = prepareFixture(test);
    const configDir = path.dirname(path.dirname(test.config));
    const readdir = fs.readdirSync.bind(fs);
    vi.spyOn(fs, "readdirSync").mockImplementation(((target, options) =>
      String(target) === configDir
        ? new Array<string>(1_025).fill("operator-owned.conf")
        : readdir(target, options as never)) as typeof fs.readdirSync);

    expect(() => publishAndRetirePortableEvidence(prepared)).not.toThrow();
    expect(fs.existsSync(test.config)).toBe(false);
    expect(fs.existsSync(path.dirname(test.config))).toBe(false);
    expect(fs.existsSync(configDir)).toBe(true);
  });

  it("rejects a symlink that replaces the portable configuration directory (#9189)", () => {
    const test = fixture();
    const portableDir = path.dirname(test.config);
    const outside = path.join(test.homeDir, "outside");
    fs.mkdirSync(outside, { mode: 0o700 });
    const unlink = fs.unlinkSync.bind(fs);
    const replacePortableDirectory = () => {
      fs.rmdirSync(portableDir);
      fs.symlinkSync(outside, portableDir, "dir");
    };
    vi.spyOn(fs, "unlinkSync").mockImplementation((target) => {
      unlink(target);
      (String(target).includes(".containers.conf.portable-uninstall-")
        ? replacePortableDirectory
        : noMutation)();
    });

    expect(() => publishAndRetirePortableEvidence(prepareFixture(test))).toThrow();
    expect(fs.lstatSync(portableDir).isSymbolicLink()).toBe(true);
    expect(fs.statSync(outside).isDirectory()).toBe(true);
    expect(hasPortableRetirementRecord(test.homeDir)).toBe(true);
  });

  it("rejects a symlink that replaces the NemoClaw configuration directory (#9189)", () => {
    const test = fixture();
    const portableDir = path.dirname(test.config);
    const configDir = path.dirname(portableDir);
    const outside = path.join(test.homeDir, "outside");
    fs.mkdirSync(path.join(outside, "portable"), { mode: 0o700, recursive: true });
    const unlink = fs.unlinkSync.bind(fs);
    const replaceConfigDirectory = () => {
      fs.rmdirSync(portableDir);
      fs.rmdirSync(configDir);
      fs.symlinkSync(outside, configDir, "dir");
    };
    vi.spyOn(fs, "unlinkSync").mockImplementation((target) => {
      unlink(target);
      (String(target).includes(".containers.conf.portable-uninstall-")
        ? replaceConfigDirectory
        : noMutation)();
    });

    expect(() => publishAndRetirePortableEvidence(prepareFixture(test))).toThrow();
    expect(fs.lstatSync(configDir).isSymbolicLink()).toBe(true);
    expect(fs.statSync(path.join(outside, "portable")).isDirectory()).toBe(true);
    expect(hasPortableRetirementRecord(test.homeDir)).toBe(true);
  });

  it("rejects group-writable portable configuration authority (#9189)", () => {
    const test = fixture();
    fs.chmodSync(path.dirname(test.config), 0o770);

    expect(() => publishAndRetirePortableEvidence(prepareFixture(test))).toThrow(/Unsafe/);
    expect(fs.existsSync(path.dirname(test.config))).toBe(true);
    expect(hasPortableRetirementRecord(test.homeDir)).toBe(true);
  });

  it("rejects portable configuration ownership drift (#9189)", () => {
    const test = fixture();
    const portableDir = path.dirname(test.config);
    const lstat = fs.lstatSync.bind(fs);
    vi.spyOn(fs, "lstatSync").mockImplementation(((target, options) => {
      const stat = lstat(target, options as never);
      return String(target) === portableDir && typeof stat.uid === "bigint"
        ? new Proxy(stat, {
            get(current, property) {
              const value = Reflect.get(current, property, current) as unknown;
              return property === "uid"
                ? typeof current.uid === "bigint"
                  ? current.uid + 1n
                  : current.uid + 1
                : typeof value === "function"
                  ? value.bind(current)
                  : value;
            },
          })
        : stat;
    }) as typeof fs.lstatSync);

    expect(() => publishAndRetirePortableEvidence(prepareFixture(test))).toThrow(/Unsafe/);
    expect(fs.existsSync(portableDir)).toBe(true);
    expect(hasPortableRetirementRecord(test.homeDir)).toBe(true);
  });

  it("preserves an entry inserted before empty-directory removal (#9189)", () => {
    const test = fixture();
    const portableDir = path.dirname(test.config);
    const marker = path.join(portableDir, "concurrent.conf");
    const rmdir = fs.rmdirSync.bind(fs);
    let inserted = false;
    const insertMarker = () => {
      inserted = true;
      fs.writeFileSync(marker, "concurrent\n", { mode: 0o600 });
    };
    vi.spyOn(fs, "rmdirSync").mockImplementation((target) => {
      (!inserted && String(target) === portableDir ? insertMarker : noMutation)();
      return rmdir(target);
    });

    expect(() => publishAndRetirePortableEvidence(prepareFixture(test))).not.toThrow();
    expect(fs.readFileSync(marker, "utf8")).toBe("concurrent\n");
    expect(fs.existsSync(portableDir)).toBe(true);
  });

  it("rejects portable configuration directory replacement between identity checks (#9189)", () => {
    const test = fixture();
    const portableDir = path.dirname(test.config);
    const readdir = fs.readdirSync.bind(fs);
    let replaced = false;
    const replacePortableDirectory = () => {
      replaced = true;
      fs.rmdirSync(portableDir);
      fs.mkdirSync(portableDir, { mode: 0o700 });
    };
    vi.spyOn(fs, "readdirSync").mockImplementation(((target, options) => {
      const entries = readdir(target, options as never);
      (!replaced && String(target) === portableDir ? replacePortableDirectory : noMutation)();
      return entries;
    }) as typeof fs.readdirSync);

    expect(() => publishAndRetirePortableEvidence(prepareFixture(test))).toThrow(/changed/);
    expect(fs.statSync(portableDir).isDirectory()).toBe(true);
    expect(hasPortableRetirementRecord(test.homeDir)).toBe(true);
  });

  it("rejects non-UTF-8 retirement and authority JSON before cleanup (#9189)", () => {
    const malformedRecord = fixture();
    fs.writeFileSync(retirementRecordPath(malformedRecord), Buffer.from([0xff]), { mode: 0o600 });
    expect(() => hasPortableRetirementRecord(malformedRecord.homeDir)).toThrow(/malformed/);

    const malformedAuthority = fixture();
    fs.writeFileSync(malformedAuthority.registryFile, Buffer.from([0xff]), { mode: 0o600 });
    expect(() => prepareFixture(malformedAuthority)).toThrow();
  });

  it.each([
    ["config", 65_536],
    ["receipt", 4_096],
    ["registry", 1_048_576],
  ] as const)(
    "enforces the exact %s target bound before record publication (#9189)",
    (role, limit) => {
      const exact = fixture();
      const exactTarget = targetPath(exact, role);
      fs.writeFileSync(
        exactTarget,
        Buffer.concat([Buffer.from("{}"), Buffer.alloc(limit - 2, 0x20)]),
        { mode: 0o600 },
      );
      expect(() => prepareFixture(exact)).not.toThrow();

      const oversized = fixture();
      const oversizedTarget = targetPath(oversized, role);
      fs.writeFileSync(oversizedTarget, Buffer.alloc(limit + 1, 0x20), { mode: 0o600 });
      expect(() => prepareFixture(oversized)).toThrow(/Unsafe/);
      expect(fs.existsSync(retirementRecordPath(oversized))).toBe(false);
    },
  );

  it.each([
    ["config", 65_536],
    ["receipt", 4_096],
    ["registry", 1_048_576],
  ] as const)("enforces the exact %s target bound during recovery (#9189)", (role, limit) => {
    const test = fixture();
    const rename = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      String(source) === test.config && assert.fail("pause before target retirement");
      rename(source, destination);
    });
    expect(() => publishAndRetirePortableEvidence(prepareFixture(test))).toThrow(/pause/);
    vi.restoreAllMocks();
    const target = targetPath(test, role);
    fs.writeFileSync(target, Buffer.alloc(limit + 1, 0x20), { mode: 0o600 });
    expect(() => inspectPortableRetirementRecovery(test.homeDir)).toThrow(/Unsafe/);
    expect(hasPortableRetirementRecord(test.homeDir)).toBe(true);
  });

  it("rejects same-byte canonical and staged metadata drift (#9189)", () => {
    const canonical = fixture();
    const preparedCanonical = prepareFixture(canonical);
    const canonicalTime = fs.statSync(canonical.receipt).mtimeMs + 1_000;
    fs.utimesSync(canonical.receipt, new Date(canonicalTime), new Date(canonicalTime));
    expect(() => publishAndRetirePortableEvidence(preparedCanonical)).toThrow(/changed/);

    const staged = fixture();
    const unlink = fs.unlinkSync.bind(fs);
    vi.spyOn(fs, "unlinkSync").mockImplementation((target) => {
      String(target).includes(`.${RECEIPT_BASENAME}.portable-uninstall-`) &&
        assert.fail("injected staged receipt crash");
      unlink(target);
    });
    expect(() => publishAndRetirePortableEvidence(prepareFixture(staged))).toThrow(/injected/);
    vi.restoreAllMocks();
    const artifact = inspectPortableRetirementRecovery(staged.homeDir)!.artifacts[0]!;
    expect(artifact).toMatchObject({ root: "receipt" });
    const stagedReceipt = path.join(path.dirname(staged.receipt), artifact.basename);
    const stagedTime = fs.statSync(stagedReceipt).mtimeMs + 1_000;
    fs.utimesSync(stagedReceipt, new Date(stagedTime), new Date(stagedTime));
    expect(() => resumePortableEvidenceRetirement(staged.homeDir)).toThrow(/changed/);
  });

  it.each([false, true])(
    "rejects noncanonical record fields and incomplete supersession before retirement [%s] (#9189)",
    (extra) => {
      const invalidIdentity = fixture();
      const invalidPrepared = prepareFixture(invalidIdentity);
      const invalidRecord = JSON.parse(invalidPrepared.recordBytes.toString("utf8")) as {
        targets: string[][];
      };
      invalidRecord.targets[0]![2] = "01";
      fs.writeFileSync(
        retirementRecordPath(invalidIdentity),
        `${JSON.stringify(invalidRecord)}\n`,
        {
          mode: 0o600,
        },
      );
      expect(() => hasPortableRetirementRecord(invalidIdentity.homeDir)).toThrow(/values/);

      const shape = fixture();
      const shaped = JSON.parse(prepareFixture(shape).recordBytes.toString("utf8")) as {
        targets: string[][];
      };
      extra ? shaped.targets[0]!.push("0") : shaped.targets[0]!.pop();
      fs.writeFileSync(retirementRecordPath(shape), `${JSON.stringify(shaped)}\n`, { mode: 0o600 });
      expect(() => hasPortableRetirementRecord(shape.homeDir)).toThrow(/invalid/);

      const missingConfig = fixture();
      const missingPrepared = prepareFixture(missingConfig);
      const missingRecord = JSON.parse(missingPrepared.recordBytes.toString("utf8")) as {
        targets: unknown[];
      };
      missingRecord.targets.shift();
      fs.writeFileSync(retirementRecordPath(missingConfig), `${JSON.stringify(missingRecord)}\n`, {
        mode: 0o600,
      });
      expect(() => hasPortableRetirementRecord(missingConfig.homeDir)).toThrow(/order/);

      const incomplete = fixture();
      const prepared = prepareFixture(incomplete);
      fs.writeFileSync(
        path.join(incomplete.stateDir, ".portable-uninstall-retirement.superseded"),
        prepared.recordBytes,
        { mode: 0o600 },
      );
      expect(() => publishAndRetirePortableEvidence(prepared)).toThrow(/incomplete/);
      expect(fs.existsSync(incomplete.receipt)).toBe(true);
      expect(fs.existsSync(incomplete.registryFile)).toBe(true);
    },
  );

  it.each([
    ["T", [".portable-uninstall-retirement.tmp"]],
    ["TC", [".portable-uninstall-retirement.tmp.cleanup"]],
    ["R", ["portable-uninstall-retirement.json"]],
    ["S", [".portable-uninstall-retirement.superseded"]],
    ["SC", [".portable-uninstall-retirement.superseded.cleanup"]],
    ["R+T", ["portable-uninstall-retirement.json", ".portable-uninstall-retirement.tmp"]],
    ["R+TC", ["portable-uninstall-retirement.json", ".portable-uninstall-retirement.tmp.cleanup"]],
    ["R+S", ["portable-uninstall-retirement.json", ".portable-uninstall-retirement.superseded"]],
    [
      "RC+S",
      [
        ".portable-uninstall-retirement.canonical.cleanup",
        ".portable-uninstall-retirement.superseded",
      ],
    ],
  ])("rejects an unexpected hard link in fixed state %s (#9189)", (_state, names) => {
    const test = fixture();
    const prepared = prepareFixture(test);
    const first = path.join(test.stateDir, names[0]!);
    fs.writeFileSync(first, prepared.recordBytes, { mode: 0o600 });
    names.slice(1).forEach((name) => {
      fs.linkSync(first, path.join(test.stateDir, name));
    });
    fs.linkSync(first, path.join(test.stateDir, "unexpected-record-link"));
    expect(() => hasPortableRetirementRecord(test.homeDir)).toThrow();
  });

  it.each(["config", "receipt", "registry"])(
    "rejects an unexpected hard link to the %s target (#9189)",
    (role) => {
      const test = fixture();
      fs.linkSync(targetPath(test, role as TargetRole), path.join(test.homeDir, `${role}.link`));
      expect(() => prepareFixture(test)).toThrow(/Unsafe/);
    },
  );

  it("rejects a new link that prevents the published-record survivor decrement (#9189)", () => {
    const test = fixture();
    const prepared = prepareFixture(test);
    const temporary = path.join(test.stateDir, ".portable-uninstall-retirement.tmp");
    const record = retirementRecordPath(test);
    fs.writeFileSync(temporary, prepared.recordBytes, { mode: 0o600 });
    fs.linkSync(temporary, record);
    const unlink = fs.unlinkSync.bind(fs);
    vi.spyOn(fs, "unlinkSync").mockImplementation((target) => {
      String(target).endsWith(".tmp.cleanup") &&
        fs.linkSync(record, path.join(test.stateDir, "unexpected-survivor-link"));
      unlink(target);
    });
    expect(() => hasPortableRetirementRecord(test.homeDir)).toThrow(/survivor|Unsafe/);
  });

  it("rejects a new link that prevents the superseded survivor decrement (#9189)", () => {
    const scope = retiredFixture();
    const superseded = path.join(scope.test.stateDir, ".portable-uninstall-retirement.superseded");
    const unlink = fs.unlinkSync.bind(fs);
    vi.spyOn(fs, "unlinkSync").mockImplementation((target) => {
      String(target).endsWith(".canonical.cleanup") &&
        fs.linkSync(superseded, path.join(scope.test.stateDir, "unexpected-survivor-link"));
      unlink(target);
    });
    expect(() =>
      supersedePortableRetirementAfterOnboard(scope.test.homeDir, scope.admission),
    ).toThrow(/survivor|Unsafe/);
  });

  it("recovers after SIGKILL at every record and evidence durability boundary (#9189)", async () => {
    const moduleUrl = new URL("./portable-uninstall-retirement.ts", import.meta.url).href;
    const childScript = String.raw`
      import fs from "node:fs";
      const [home, receipt, operation, boundary, moduleUrl] = process.argv.slice(1);
      const retirement = (await import(moduleUrl)).default;
      const prepared = retirement.preparePortableRetirement(home, [receipt]);
      const original = fs[operation].bind(fs);
      let calls = 0;
      fs[operation] = (...args) => {
        const result = original(...args);
        if (++calls === Number(boundary)) process.kill(process.pid, "SIGKILL");
        return result;
      };
      retirement.publishAndRetirePortableEvidence(prepared);
    `;
    const boundaries = {
      fsyncSync: 12,
      linkSync: 1,
      renameSync: 4,
      rmdirSync: 2,
      unlinkSync: 4,
    } as const;
    const cases = Object.entries(boundaries).flatMap(([operation, count]) =>
      Array.from({ length: count }, (_value, index) => [operation, index + 1] as const),
    );
    for (let offset = 0; offset < cases.length; offset += 12) {
      await Promise.all(
        cases.slice(offset, offset + 12).map(async ([operation, boundary]) => {
          const test = fixture();
          const result = await spawnForSignal([
            "--no-warnings",
            "--import",
            "tsx",
            "--input-type=module",
            "-e",
            childScript,
            test.homeDir,
            RECEIPT_BASENAME,
            operation,
            String(boundary),
            moduleUrl,
          ]);
          expect(result.signal, `${operation}:${String(boundary)} ${result.stderr}`).toBe(
            "SIGKILL",
          );
          const targets = [test.receipt, test.registryFile, test.config];
          const assertRecovered = () => {
            resumePortableEvidenceRetirement(test.homeDir);
            expect(targets.every((target) => !fs.existsSync(target))).toBe(true);
            expect(fs.existsSync(path.dirname(test.config))).toBe(false);
            expect(fs.existsSync(path.dirname(path.dirname(test.config)))).toBe(false);
          };
          const assertPrior = () => expect(targets.every(fs.existsSync)).toBe(true);
          (hasPortableRetirementRecord(test.homeDir) ? assertRecovered : assertPrior)();
        }),
      );
    }
  }, 30_000);

  it("recovers completed onboarding after SIGKILL at every supersession boundary (#9189)", async () => {
    const moduleUrl = new URL("./portable-uninstall-retirement.ts", import.meta.url).href;
    const childScript = String.raw`
      import fs from "node:fs";
      const [home, filesJson, operation, boundary, moduleUrl] = process.argv.slice(1);
      const retirement = (await import(moduleUrl)).default;
      if (operation !== "afterReturn") {
        const original = fs[operation].bind(fs);
        let calls = 0;
        fs[operation] = (...args) => {
          const result = original(...args);
          if (++calls === Number(boundary)) process.kill(process.pid, "SIGKILL");
          return result;
        };
      }
      retirement.supersedePortableRetirementAfterOnboard(home, {
        files: JSON.parse(filesJson),
        verify: () => {},
      });
      process.kill(process.pid, "SIGKILL");
    `;
    const boundaries = { afterReturn: 1, fsyncSync: 12, linkSync: 1, renameSync: 2, unlinkSync: 2 };
    const cases = Object.entries(boundaries).flatMap(([operation, count]) =>
      Array.from({ length: count }, (_value, index) => [operation, index + 1] as const),
    );
    for (let offset = 0; offset < cases.length; offset += 12) {
      await Promise.all(
        cases.slice(offset, offset + 12).map(async ([operation, boundary]) => {
          const scope = retiredFixture();
          const result = await spawnForSignal([
            "--no-warnings",
            "--import",
            "tsx",
            "--input-type=module",
            "-e",
            childScript,
            scope.test.homeDir,
            JSON.stringify(scope.admission.files),
            operation,
            String(boundary),
            moduleUrl,
          ]);
          expect(result.signal, `${operation}:${String(boundary)} ${result.stderr}`).toBe(
            "SIGKILL",
          );
          expect(() =>
            supersedePortableRetirementAfterOnboard(scope.test.homeDir, scope.admission),
          ).not.toThrow();
          expect(hasPortableRetirementRecord(scope.test.homeDir)).toBe(false);
        }),
      );
    }
  }, 30_000);
});
