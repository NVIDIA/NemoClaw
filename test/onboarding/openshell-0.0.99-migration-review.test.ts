// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { parseGatewayInference } from "../../src/lib/inference/config.js";
import { resolveOnboardManagedBootstrapLaunch } from "../../src/lib/onboard/managed-workload/onboard-orchestration.js";
import { validateName } from "../../src/lib/runner.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const review = fs.readFileSync(
  path.join(repoRoot, "internal", "security-reviews", "openshell-0.0.99-migration-review.md"),
  "utf8",
);

const SOURCE_COMMIT = "8c7dd148a9e6360c9d5b2830e339a0dc4b3f3032";
const SUPERVISOR_DIGESTS = {
  index: "sha256:ea3632b6e9528e2309103af5b6949606fcdc83ca1f69e8db81482a25bea84bb6",
  amd64: "sha256:4adea8392a81ef34b3cc3284e693ac3cc6c13362fad84a492d95b53b3eb403b9",
  arm64: "sha256:b548fd939331d830cd9197f20fca9a5d95383c5e67f64929d632a37403115f38",
} as const;

const ranges = [
  [
    "85",
    "86",
    109,
    "dd3f27c8 077adb79 008193a2 cf4deccd 1a0c1013 fe7135a2 d0961cdb aa483ecb 32f05244 54025517 d70adafe d5567487",
  ],
  ["86", "87", 12, "06062027 98f253b8 1fd4d2b9 8cf2673c 9a4f8a80"],
  [
    "87",
    "88",
    169,
    "339eae5a 80987e91 a2cd5f8e a9f71313 f32c46d4 2575585b 9377e0d5 745512e3 ad29ab96 5952a5a2 f1690849 8d9502d9 e9ac0ee6 744a65d5 3ff15a16",
  ],
  [
    "88",
    "89",
    49,
    "dae92616 472e23f9 bdd1ce87 396a3b7b d35d52d4 8b0e54b2 2d5652b2 ac3d5c96 cbdeb4d5",
  ],
  [
    "89",
    "90",
    24,
    "fd1d3de8 5432d01d ca318058 cd9a0bf2 7b444bd8 0674a00b 8a14b3a4 541b97f0 1d4ac708",
  ],
  ["90", "91", 33, "75d24688 59f7839f 21da343c"],
  [
    "91",
    "92",
    55,
    "f7cd9108 b422b678 850bd42e 77e5c322 01daf3a5 deced871 d4cd37be afb462f3 516be602 76a5397e 2d108818",
  ],
  ["92", "93", 24, "39bf94e5 79bcf296 2022d537 0d5e5c53 52f9e9e9 24d491a0 f00ad23a"],
  [
    "93",
    "94",
    68,
    "7e9a7f51 b78c8615 efb2d9c2 b1c7ff68 2b7f04fe 7955c830 bc14018c 101cbc97 8d252f47 662dee68 d0f9301c 1221b586",
  ],
  ["94", "95", 107, "eb380d71 0cecb542 1cbfc0d5 9c019a93 7f53f78b fe15caa8 df698042"],
  ["95", "96", 38, "28f3bee0 fa242990 02e890cc 596d729e 5541398c"],
  [
    "96",
    "97",
    144,
    "1a25439c d220d894 489bb0d5 770d4e6b 905b554c 06c2db75 584f7dbf c42268ba e7533177 736e431d 1959ea19 fde96f04",
  ],
  ["97", "98", 50, "704880e5 0a3ec7a1 83284129"],
  ["98", "99", 79, "b9818619 0e9a44cf 4d55265f d063751c 53780556 490f66f4 8c7dd148"],
] as const;

type DigestMatrix = Record<"CLI" | "Gateway" | "Sandbox", readonly [string, string, string | null]>;

const archiveDigests: DigestMatrix = {
  CLI: [
    "35725a358e42ef7f0f0393035536da317706b0febcc459a2011e0555f6c2b71c",
    "d00cbf0d8779c01ddea6453ead2ad4db3d89a1f14eb6f0785f7919f42813a279",
    "e31cac5360e2adf3c971d5742a516626c58acf2fd3db4dcb0e45804def3dc844",
  ],
  Gateway: [
    "640d204dc3c6bc28bffa1f3d870897fc23bbc5ec0151a6c642083e958455cb49",
    "3a5d3092ae34356beb0ff2a920f9a87af4233c7a1086a53cd9429d48358f5c09",
    "4340619292ecb565f90eb2250db504baa37dd410361b366b42e174d34512cb6c",
  ],
  Sandbox: [
    "84caed3dec4390e0938e89b38b1256d31e8970b4bfd85437bf92ed79f5b1ff05",
    "c758e7dc2b8c904baa01e2ccce0f08daf96ede0c648478b23346d8c4dd16f432",
    null,
  ],
};

const binaryDigests: DigestMatrix = {
  CLI: [
    "5c0dabb90152a3cfae9005731771da99f00a22403080c81952c7be8ba4b5728f",
    "9390eac019d2bcabec1cac950ca97982fb3d7bce2560ae00e9c3f237d50b8481",
    "578048e527b8fbb6741bbdacd55ac65bf0cb0776964ea8f18cd24cc979a1006f",
  ],
  Gateway: [
    "05bd6c982dd72b73364b91ab694487c026bc56d0cd869f4289b44cc392a5c2ba",
    "35c1e1be9c8766de2bfd457e54918d6b2019c16da815ec4c45ce9ebb45aaa571",
    "e53b0788d1fdc3e933bb11f13b02c5c1d8c6635bfb3166264558ac3272426113",
  ],
  Sandbox: [
    "a4b0c38ed90a6dd4b4f312ad3727824a25ec478d88d4e65d22a82377b18e6214",
    "f60ce5b76e4dbd645f690c8519852d261c8cf6a70b5fc56db329a23d68bc7b2e",
    null,
  ],
};

function parseLedger(): Map<string, string[]> {
  const parsed = new Map<string, string[]>();
  for (const match of review.matchAll(/^- `([0-9]+->[0-9]+)`: ((?:[0-9a-f]{8} ?)+)$/gmu)) {
    parsed.set(match[1], match[2].trim().split(/\s+/u));
  }
  return parsed;
}

function parseRangeTable(): Map<string, { commits: number; paths: number }> {
  const parsed = new Map<string, { commits: number; paths: number }>();
  for (const match of review.matchAll(
    /^\| `(v0\.0\.[0-9]+ -> v0\.0\.[0-9]+)` \| ([0-9]+) \| ([0-9]+) \|/gmu,
  )) {
    parsed.set(match[1], { commits: Number(match[2]), paths: Number(match[3]) });
  }
  return parsed;
}

function parseDigestTable(start: string, end: string): DigestMatrix {
  const section = review.split(start)[1]?.split(end)[0] ?? "";
  const parsed = {} as DigestMatrix;
  for (const match of section.matchAll(
    /^\| (CLI|Gateway|Sandbox) \| (`[0-9a-f]{64}`|not published) \| (`[0-9a-f]{64}`|not published) \| (`[0-9a-f]{64}`|not published) \|$/gmu,
  )) {
    const digest = (cell: string): string | null =>
      cell === "not published" ? null : cell.slice(1, -1);
    parsed[match[1] as keyof DigestMatrix] = [
      digest(match[2]),
      digest(match[3]),
      digest(match[4]),
    ] as [string, string, string | null];
  }
  return parsed;
}

describe("OpenShell 0.0.99 migration review", () => {
  it("binds managed Docker activation to the v0.0.99 supervisor workdir argv (#8497)", () => {
    const authorityStore = {};
    const launch = resolveOnboardManagedBootstrapLaunch({
      runtime: {
        runtimeProvider: {
          bootstrap: {
            supported: true,
            bootstrapKind: "managed-image",
            createAuthorityStore: () => authorityStore,
          },
        },
      } as never,
      workload: {
        source: {
          kind: "managed-image",
          contract: {
            agent: "openclaw",
            image: "registry.example/nemoclaw/openclaw",
            digest: `sha256:${"1".repeat(64)}`,
          },
        },
      } as never,
      stateRoot: "/tmp/nemoclaw-state",
      bootstrapIdentity: "bootstrap-identity",
      request: {} as never,
      intendedWorkloadArgv: ["/usr/local/bin/nemoclaw-start"],
    });

    expect(launch?.expectedSupervisorArgv).toEqual([
      "/opt/openshell/bin/openshell-sandbox",
      "--workdir",
      "/sandbox",
    ]);
    expect(launch?.authorityStore).toBe(authorityStore);
  });

  it.each(ranges)(
    "binds every adjacent range to its declared unique commit ledger [case %#] (#8497)",
    (from, to, paths, commitText) => {
      const ledger = parseLedger();
      const table = parseRangeTable();

      expect(ledger.size).toBe(ranges.length);
      expect(table.size).toBe(ranges.length);

      const key = `${from}->${to}`;
      const rangeName = `v0.0.${from} -> v0.0.${to}`;
      const commits = commitText.split(" ");
      expect(ledger.get(key), `${key} commit membership`).toEqual(commits);
      expect(table.get(rangeName), `${rangeName} declared counts`).toEqual({
        commits: commits.length,
        paths,
      });
      expect(new Set(commits).size, `${key} duplicate commits`).toBe(commits.length);
    },
  );

  it("keeps adjacent range commit ledgers globally unique (#8497)", () => {
    const allCommits = ranges.flatMap(([, , , commitText]) => commitText.split(" "));

    expect(allCommits).toHaveLength(117);
    expect(new Set(allCommits).size).toBe(117);
    expect(review).toContain("515 distinct changed paths");
  });

  it("proves the exposed 0.0.99 compatibility contracts through behavior (#8497)", () => {
    expect(
      parseGatewayInference(
        `Inference:\n  Workspace: default\n  Provider: compatible-endpoint\n  Model: review-model\n  Version: 1\n\nSystem inference: Not configured`,
      ),
    ).toMatchObject({ provider: "compatible-endpoint", model: "review-model" });

    expect(validateName("a".repeat(19), "sandbox name")).toBe("a".repeat(19));
    expect(() => validateName("a".repeat(20), "sandbox name")).toThrow(
      "sandbox name too long (max 19 chars)",
    );
    expect(review).toContain("without conditional skips or expected failures");
    expect(review).toContain("0.0.85 -> 0.0.99");
  });
});
