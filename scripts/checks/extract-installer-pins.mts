// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Token = {
  end: number;
  kind: "newline" | "operator" | "word";
  start: number;
  value: string;
};

export type InstallerPin = {
  asset: string;
  releaseVersion: string;
  sha256: string;
  source: string;
};

type ExtractOptions = {
  functionName: string;
  sourceLabel: string;
};

type SandboxBuildPin = {
  sha256: string;
  version: string;
};

type TrustedSandboxBuild = {
  required: boolean;
  sha256: string;
};

type SupervisorManifestPin = {
  image: string;
  manifestDigest: string;
  version: string;
};

type TrustedSupervisorManifest = {
  image: string;
  manifestDigest: string;
  required: boolean;
  runtimeTemplateSha256: readonly string[];
};

type OpenShellReleaseTrust = {
  brevTemplateSha256: readonly string[];
  formula: {
    asset: "openshell.rb";
    sha256: string;
    url: string;
  };
  installerTemplateSha256: readonly string[];
  manifests: readonly {
    asset: string;
    sha256: string;
  }[];
  sandboxBuilds: readonly TrustedSandboxBuild[];
  supervisor: TrustedSupervisorManifest | null;
  version: string;
};

type CliOptions = {
  blueprint: string;
  brevInstaller: string;
  format: "json" | "release-tsv" | "tsv";
  installer: string;
  supervisorRuntime: string;
};

const FUNCTION_LOCAL_SOURCE_PATTERN =
  /^local[ \t]+release_tag[ \t]*=[ \t]*(?:"\$1"|\$1)[ \t]+asset[ \t]*=[ \t]*(?:"\$2"|\$2)$/u;
const LITERAL_PIN_PATTERN = /^v([0-9]+\.[0-9]+\.[0-9]+):([A-Za-z0-9._+-]+)$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_INSTALLER_INPUT_BYTES = 1024 * 1024;
// Each release record is one base-trusted qualification unit. The parser
// selects one record before it accepts candidate release data or emits the
// manifest and formula identities consumed by the shell checker.
const TRUSTED_OPENSHELL_RELEASES: readonly OpenShellReleaseTrust[] = [
  {
    brevTemplateSha256: ["c0a4ddf25a02a9fe02b2df53a60942ea887610f04d4ce16a121b6e79a5aeff1a"],
    formula: {
      asset: "openshell.rb",
      sha256: "4b75a7e3a7630eb8954d73ca828b394d5e0646adbaa4b087b2435329d53b61b3",
      url: "https://github.com/NVIDIA/OpenShell/releases/download/v0.0.72/openshell.rb",
    },
    installerTemplateSha256: [
      "6226811887cc5c1a721a96fbf062f5ce5f75b09d3a8a1de49ed4dadc3236eb0c",
      "c3418c0837c450df89ca1b6ca3a598cdee47b0d30e2c2433fd7732ec35c2ccc2",
    ],
    manifests: [
      {
        asset: "openshell-checksums-sha256.txt",
        sha256: "0049181983eaf925ef9510382f75348229a9511d02e27196107782e7c3259ae1",
      },
      {
        asset: "openshell-gateway-checksums-sha256.txt",
        sha256: "3c454dc15154b8c700ec820628559ea8964c6e552d9c5f8af78b6ee19cf34547",
      },
      {
        asset: "openshell-sandbox-checksums-sha256.txt",
        sha256: "d38507501338576437cf3e554df71fefe927dc0d72758f88e260069527ed9ccc",
      },
    ],
    sandboxBuilds: [
      {
        required: true,
        sha256: "f9f991a24d10772ad5d24ae27a8ea6baad8cac671695bd90fcd0355e0e0ad198",
      },
      {
        required: true,
        sha256: "32ca44fe7d9e6d332f2a753c6b8a1a6117b7388281dad9b5274d23ffc67e216f",
      },
    ],
    supervisor: {
      image: "ghcr.io/nvidia/openshell/supervisor",
      manifestDigest: "sha256:80ed9cda5bf672fefdb9dcd4604b40a8b09c0891b6eb9d03e10227c7e3dfb49d",
      required: true,
      runtimeTemplateSha256: ["c1922eaa4f73c1a05aa8bccf50fc40208d7f71db0e6c110dcd09d0372d1aa068"],
    },
    version: "0.0.72",
  },
  {
    brevTemplateSha256: ["c0a4ddf25a02a9fe02b2df53a60942ea887610f04d4ce16a121b6e79a5aeff1a"],
    formula: {
      asset: "openshell.rb",
      sha256: "fa54640184e22fa74500ab24f5b4372582616c7e12a1152cb6983bc0738c5a74",
      url: "https://github.com/NVIDIA/OpenShell/releases/download/v0.0.82/openshell.rb",
    },
    installerTemplateSha256: [
      "6226811887cc5c1a721a96fbf062f5ce5f75b09d3a8a1de49ed4dadc3236eb0c",
      "c3418c0837c450df89ca1b6ca3a598cdee47b0d30e2c2433fd7732ec35c2ccc2",
    ],
    manifests: [
      {
        asset: "openshell-checksums-sha256.txt",
        sha256: "74ba77d368744f412b2dd246099b63b38937962807333ded2b6284580a2d014e",
      },
      {
        asset: "openshell-gateway-checksums-sha256.txt",
        sha256: "c0a369ba2c66bcde3c18ce2753b04ff942d1fe1b5f3e4656de520f6d4b175477",
      },
      {
        asset: "openshell-sandbox-checksums-sha256.txt",
        sha256: "3300b9856cdbe8e3f9b0f8068bbad93673739c4cfd3212c80dc0675168ee2b8d",
      },
    ],
    sandboxBuilds: [
      {
        required: true,
        sha256: "145246049bd73c60452ac3c2b4b1801663196c8e2f80575af820289c78c1cf09",
      },
      {
        required: true,
        sha256: "76bc19b70d9f1e1e9871307045796cd39cc7b8fc4c08ffc90593cc934f36d500",
      },
    ],
    supervisor: null,
    version: "0.0.82",
  },
  {
    brevTemplateSha256: ["c0a4ddf25a02a9fe02b2df53a60942ea887610f04d4ce16a121b6e79a5aeff1a"],
    formula: {
      asset: "openshell.rb",
      sha256: "f53c62777fed23b42427822d231670451ee4358efeb2660c41a7a38919211b23",
      url: "https://github.com/NVIDIA/OpenShell/releases/download/v0.0.85/openshell.rb",
    },
    installerTemplateSha256: [
      "6226811887cc5c1a721a96fbf062f5ce5f75b09d3a8a1de49ed4dadc3236eb0c",
      "c3418c0837c450df89ca1b6ca3a598cdee47b0d30e2c2433fd7732ec35c2ccc2",
    ],
    manifests: [
      {
        asset: "openshell-checksums-sha256.txt",
        sha256: "6554b3f96c04006d661519786d40d17e34c7860b7aac8fd35259ef2aea01567f",
      },
      {
        asset: "openshell-gateway-checksums-sha256.txt",
        sha256: "cc4f32afed376ebe9b43cccdb4d2a77b2524b57132a6b56bb88d705e02420f86",
      },
      {
        asset: "openshell-sandbox-checksums-sha256.txt",
        sha256: "b6ac353c933fa4cf9a3ef11d66cce6635f39ecc2e928d9c8ff1783ca797308b3",
      },
    ],
    sandboxBuilds: [],
    supervisor: null,
    version: "0.0.85",
  },
  {
    brevTemplateSha256: ["c0a4ddf25a02a9fe02b2df53a60942ea887610f04d4ce16a121b6e79a5aeff1a"],
    formula: {
      asset: "openshell.rb",
      sha256: "8dd34fc17ee9a30327664a18c9509c8a765cb010de38cda8e22841bddbe92713",
      url: "https://github.com/NVIDIA/OpenShell/releases/download/v0.0.99/openshell.rb",
    },
    installerTemplateSha256: [
      "6226811887cc5c1a721a96fbf062f5ce5f75b09d3a8a1de49ed4dadc3236eb0c",
      "c3418c0837c450df89ca1b6ca3a598cdee47b0d30e2c2433fd7732ec35c2ccc2",
    ],
    manifests: [
      {
        asset: "openshell-checksums-sha256.txt",
        sha256: "ea3e2c1a583e5ea00332c3b65a18068bd1f9b090f7ff0f5e24b29762cfc3b4c7",
      },
      {
        asset: "openshell-gateway-checksums-sha256.txt",
        sha256: "7f84f728412548720c8ef51993c58414c4f04598451c282b26ead233185e40c5",
      },
      {
        asset: "openshell-sandbox-checksums-sha256.txt",
        sha256: "9e67af6bab9f975432a1045fcfea5ab182ab585b17886c8c290c1eb77232b87a",
      },
    ],
    sandboxBuilds: [
      {
        required: true,
        sha256: "a4b0c38ed90a6dd4b4f312ad3727824a25ec478d88d4e65d22a82377b18e6214",
      },
      {
        required: true,
        sha256: "f60ce5b76e4dbd645f690c8519852d261c8cf6a70b5fc56db329a23d68bc7b2e",
      },
    ],
    supervisor: {
      image: "ghcr.io/nvidia/openshell/supervisor",
      manifestDigest: "sha256:ea3632b6e9528e2309103af5b6949606fcdc83ca1f69e8db81482a25bea84bb6",
      required: true,
      runtimeTemplateSha256: ["c1922eaa4f73c1a05aa8bccf50fc40208d7f71db0e6c110dcd09d0372d1aa068"],
    },
    version: "0.0.99",
  },
  {
    brevTemplateSha256: ["c0a4ddf25a02a9fe02b2df53a60942ea887610f04d4ce16a121b6e79a5aeff1a"],
    formula: {
      asset: "openshell.rb",
      sha256: "87fadc7b0c854aa44f71d5b3a206865070117cd27825d59c61da252a99f402a2",
      url: "https://github.com/NVIDIA/OpenShell/releases/download/v0.0.101/openshell.rb",
    },
    installerTemplateSha256: [
      "6226811887cc5c1a721a96fbf062f5ce5f75b09d3a8a1de49ed4dadc3236eb0c",
      "d3ee11fd805d84c0e0f760831e091c1f16632e61cf9c1af7e7856e0aafc9de54",
      "c3418c0837c450df89ca1b6ca3a598cdee47b0d30e2c2433fd7732ec35c2ccc2",
      "741febd02f3a6b18c8aa5e34e42e23a200c8a4b09b41a7c0de045bf65b0a9bdd",
    ],
    manifests: [
      {
        asset: "openshell-checksums-sha256.txt",
        sha256: "9c90869d00b109b5ac1062b1a9808a592c2311d3c0c4926bae44d136b979d8a9",
      },
      {
        asset: "openshell-gateway-checksums-sha256.txt",
        sha256: "dcb3f1917713bf2a8e8e1803ac42c5e39d9dd41e644136b05def32b077082777",
      },
      {
        asset: "openshell-sandbox-checksums-sha256.txt",
        sha256: "d16f7d369c54d74d36c7df036565267a960e7ce6fb143012fe9d77f257d6e8b3",
      },
    ],
    sandboxBuilds: [
      {
        required: false,
        sha256: "a2704babbb468fd0a359bfdd9844de71095b730758541b4ca8cbab77d4018920",
      },
      {
        required: false,
        sha256: "88300e35f153123e4dc3021c537834dd6c0a09665a4a6d3974cd285d512345c4",
      },
    ],
    supervisor: {
      image: "ghcr.io/nvidia/openshell/supervisor",
      manifestDigest: "sha256:b58be5e40c788977ffa0e8305a8cad9c656efdf1a3fe182582a00ca870bb0edb",
      required: true,
      runtimeTemplateSha256: ["c1922eaa4f73c1a05aa8bccf50fc40208d7f71db0e6c110dcd09d0372d1aa068"],
    },
    version: "0.0.101",
  },
  {
    brevTemplateSha256: ["c0a4ddf25a02a9fe02b2df53a60942ea887610f04d4ce16a121b6e79a5aeff1a"],
    formula: {
      asset: "openshell.rb",
      sha256: "95a290f0e0e2f57d7d46ba9171fca6e99e5226875cd12e12391b7338f6c219f9",
      url: "https://github.com/NVIDIA/OpenShell/releases/download/v0.0.103/openshell.rb",
    },
    installerTemplateSha256: [
      "6226811887cc5c1a721a96fbf062f5ce5f75b09d3a8a1de49ed4dadc3236eb0c",
      "c3418c0837c450df89ca1b6ca3a598cdee47b0d30e2c2433fd7732ec35c2ccc2",
    ],
    manifests: [
      {
        asset: "openshell-checksums-sha256.txt",
        sha256: "1a9016cfb9219ad6ea3dc623b3dfd517dbce062cba9484964a8ca9175c7d1c9d",
      },
      {
        asset: "openshell-gateway-checksums-sha256.txt",
        sha256: "800f8501329b27b79d260f21de088d8aea36de45021eaa3d29d189c433fc04b5",
      },
      {
        asset: "openshell-sandbox-checksums-sha256.txt",
        sha256: "ab7c77fe40e93b293e4d34e892824ed0cb131e8b973ba2660b155cdd0fa0f604",
      },
    ],
    sandboxBuilds: [
      {
        required: false,
        sha256: "412dc28fa288938373aca0a95c6be3f890066c377992bb75b3ca078d92dbef00",
      },
      {
        required: false,
        sha256: "fc1454705fad9cc0890297a84d2b7869670a364d01d5398685e3c987d2b6c123",
      },
    ],
    supervisor: {
      image: "ghcr.io/nvidia/openshell/supervisor",
      manifestDigest: "sha256:96228f110362ffd415bb12d3b7f584063c3c52c0c93f3ccf59faada1dc2dd5d3",
      required: false,
      runtimeTemplateSha256: ["c1922eaa4f73c1a05aa8bccf50fc40208d7f71db0e6c110dcd09d0372d1aa068"],
    },
    version: "0.0.103",
  },
  {
    brevTemplateSha256: [
      "c0a4ddf25a02a9fe02b2df53a60942ea887610f04d4ce16a121b6e79a5aeff1a",
      "56fc6482d1508b73604099e6fd6c16daea16275cf36cc25c1c5366c82a4394e3",
    ],
    formula: {
      asset: "openshell.rb",
      sha256: "f0f86519e227b3b326431410058ba690b1a7b83e5af7384014e4b96283d3a642",
      url: "https://github.com/NVIDIA/OpenShell/releases/download/v0.0.106/openshell.rb",
    },
    // The first template came from the downstream 0.0.106 pin. The second authorizes its
    // fail-before-download strings preflight. The third authorizes repair when an existing formula
    // has an invalid checksum or its release formula is unavailable. The fourth preserves that
    // template after installer tests moved under test/install. Homebrew owns the formula source
    // state, so NemoClaw cannot correct it there; the installer verifies the trusted release
    // formula before reuse. installer-homebrew-formula-reuse-trust.test.ts and
    // installer-hash-check.test.ts lock the template and trust transitions. Remove the repair
    // digests when supported Homebrew installs no longer need this repair path.
    installerTemplateSha256: [
      "5d4cdb2db60df7539193b486ac15bb9be96ec1d40fc0f739a94d4d2f0bf597a0",
      "e850e927aab619d52c5de72967137569d65dd7fa669920c7c5b558f0770140d1",
      "e7d51536442b217e3d5e77c4ba3b7c25e6a74898bf22523f7fb58627d34329cb",
      "18175cf47a0fece8ce75e5d523185062c7a7c913a3f4ceafbba4a7ca4df7c69b",
    ],
    manifests: [
      {
        asset: "openshell-checksums-sha256.txt",
        sha256: "7421aaf9d5550dc15aa33b523fa3dfe78571811e4ddf76f9f6c29576438bdb27",
      },
      {
        asset: "openshell-gateway-checksums-sha256.txt",
        sha256: "26e4345449e02475e27a7c59cd0cf39199dd6c91b0aa635fbb8cb834835f4b39",
      },
      {
        asset: "openshell-sandbox-checksums-sha256.txt",
        sha256: "88bc98ffdc915fb7598f39df84ab37a1a31e40e33e4125b37ed13adecd447dbb",
      },
    ],
    sandboxBuilds: [
      {
        required: false,
        sha256: "0031c6b257a23ecc1a2333153918324f3af0005e68abde388858d682ec646c55",
      },
      {
        required: false,
        sha256: "019301ec8618abbed8135e8d39dde7bea47e5e92813bbc17768550de34db59f8",
      },
    ],
    supervisor: {
      image: "ghcr.io/nvidia/openshell/supervisor",
      manifestDigest: "sha256:722f44669722961b7f432b0b81de25b91a58f34a61d6403bef967acaf2b3af01",
      required: false,
      runtimeTemplateSha256: ["c1922eaa4f73c1a05aa8bccf50fc40208d7f71db0e6c110dcd09d0372d1aa068"],
    },
    version: "0.0.106",
  },
] as const;
const EXPECTED_INSTALLER_ASSETS = [
  "openshell-x86_64-unknown-linux-musl.tar.gz",
  "openshell-aarch64-unknown-linux-musl.tar.gz",
  "openshell-aarch64-apple-darwin.tar.gz",
  "openshell-gateway-x86_64-unknown-linux-gnu.tar.gz",
  "openshell-gateway-aarch64-unknown-linux-gnu.tar.gz",
  "openshell-gateway-aarch64-apple-darwin.tar.gz",
  "openshell-sandbox-x86_64-unknown-linux-gnu.tar.gz",
  "openshell-sandbox-aarch64-unknown-linux-gnu.tar.gz",
  "openshell.rb",
] as const;
const EXPECTED_BREV_ASSETS = [
  "openshell-x86_64-unknown-linux-musl.tar.gz",
  "openshell-aarch64-unknown-linux-musl.tar.gz",
] as const;

function fail(message: string): never {
  throw new Error(`Installer pin extraction failed: ${message}`);
}

function validateTrustedRelease(release: OpenShellReleaseTrust): void {
  const requiredManifests = [
    "openshell-checksums-sha256.txt",
    "openshell-gateway-checksums-sha256.txt",
    "openshell-sandbox-checksums-sha256.txt",
  ] as const;
  const manifestAssets = release.manifests.map((manifest) => manifest.asset).sort();
  if (
    !/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(release.version) ||
    manifestAssets.length !== requiredManifests.length ||
    manifestAssets.some((asset, index) => asset !== [...requiredManifests].sort()[index]) ||
    release.manifests.some((manifest) => !SHA256_PATTERN.test(manifest.sha256))
  ) {
    fail(`OpenShell v${release.version} must have exactly three trusted release-manifest digests`);
  }
  if (
    !release.formula ||
    release.formula.asset !== "openshell.rb" ||
    release.formula.url !==
      `https://github.com/NVIDIA/OpenShell/releases/download/v${release.version}/openshell.rb` ||
    !SHA256_PATTERN.test(release.formula.sha256)
  ) {
    fail(`trusted OpenShell v${release.version} formula record is invalid`);
  }
  if (
    release.installerTemplateSha256.length === 0 ||
    release.installerTemplateSha256.some((sha256) => !SHA256_PATTERN.test(sha256)) ||
    release.brevTemplateSha256.length === 0 ||
    release.brevTemplateSha256.some((sha256) => !SHA256_PATTERN.test(sha256)) ||
    release.sandboxBuilds.some((pin) => !SHA256_PATTERN.test(pin.sha256))
  ) {
    fail(`trusted OpenShell v${release.version} template or sandbox record is invalid`);
  }
  if (
    release.supervisor &&
    (release.supervisor.image !== "ghcr.io/nvidia/openshell/supervisor" ||
      !/^sha256:[a-f0-9]{64}$/u.test(release.supervisor.manifestDigest) ||
      release.supervisor.runtimeTemplateSha256.length === 0 ||
      release.supervisor.runtimeTemplateSha256.some((sha256) => !SHA256_PATTERN.test(sha256)))
  ) {
    fail(`trusted OpenShell v${release.version} supervisor record is invalid`);
  }
}

function trustedRelease(version: string): OpenShellReleaseTrust {
  const duplicateVersions = TRUSTED_OPENSHELL_RELEASES.map((release) => release.version).filter(
    (candidate, index, versions) => versions.indexOf(candidate) !== index,
  );
  if (duplicateVersions.length > 0) {
    fail(
      `trusted OpenShell release records contain duplicate versions: ${[
        ...new Set(duplicateVersions),
      ].join(", ")}`,
    );
  }
  for (const release of TRUSTED_OPENSHELL_RELEASES) validateTrustedRelease(release);
  const release = TRUSTED_OPENSHELL_RELEASES.find((candidate) => candidate.version === version);
  if (!release) fail(`OpenShell v${version} is not in the base-trusted release records`);
  return release;
}

// Pull-request CI executes this parser from a trusted checkout while these
// paths point into the mutable PR tree. Reject links and special files before
// reading, verify that the opened file is still the one inspected, and cap the
// bytes consumed so PR-authored input cannot redirect or exhaust the verifier.
// Regression coverage lives in test/install/installer-hash-check.test.ts.
function readInstallerInput(inputPath: string, sourceLabel: string): string {
  let parentStats: fs.Stats;
  try {
    parentStats = fs.lstatSync(path.dirname(inputPath));
  } catch {
    fail(`${sourceLabel} input parent directory is unavailable`);
  }
  if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) {
    fail(`${sourceLabel} input parent must be a real directory and not a symbolic link`);
  }

  let pathStats: fs.Stats;
  try {
    pathStats = fs.lstatSync(inputPath);
  } catch {
    fail(`${sourceLabel} input is unavailable`);
  }
  if (pathStats.isSymbolicLink() || !pathStats.isFile()) {
    fail(`${sourceLabel} input must be a regular file and not a symbolic link`);
  }

  let descriptor: number;
  try {
    descriptor = fs.openSync(
      inputPath,
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW,
    );
  } catch {
    fail(`${sourceLabel} input must be a regular file and not a symbolic link`);
  }

  try {
    const openedStats = fs.fstatSync(descriptor);
    if (
      !openedStats.isFile() ||
      openedStats.dev !== pathStats.dev ||
      openedStats.ino !== pathStats.ino
    ) {
      fail(`${sourceLabel} input changed during validation or is not a regular file`);
    }
    if (openedStats.size > MAX_INSTALLER_INPUT_BYTES) {
      fail(`${sourceLabel} input exceeds the ${MAX_INSTALLER_INPUT_BYTES}-byte limit`);
    }

    const buffer = Buffer.allocUnsafe(MAX_INSTALLER_INPUT_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunkSize = fs.readSync(descriptor, buffer, bytesRead, buffer.length - bytesRead, null);
      if (chunkSize === 0) {
        break;
      }
      bytesRead += chunkSize;
    }
    if (bytesRead > MAX_INSTALLER_INPUT_BYTES) {
      fail(`${sourceLabel} input exceeds the ${MAX_INSTALLER_INPUT_BYTES}-byte limit`);
    }
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

// invalidState: base-trusted CI accepts the right number of valid published
// hashes while a pull request swaps in a different official release asset.
// sourceBoundary: these expected asset names live only in base-trusted parser
// code; the PR-head installer and Brev script remain inert input data.
// whyNotSourceFix: OpenShell can attest what it publishes but cannot determine
// which exact downstream assets NemoClaw consumes.
// regressionTest: test/install/installer-hash-check.test.ts substitutes official but
// unexpected assets while keeping valid upstream digests and record counts.
// removalCondition: remove this set check only when one base-trusted canonical
// dependency manifest directly drives both installer consumers.
function assertExactAssetSet(
  pins: InstallerPin[],
  expectedAssets: readonly string[],
  label: string,
): void {
  const actual = [...new Set(pins.map((pin) => pin.asset))].sort();
  const expected = [...expectedAssets].sort();
  const missing = expected.filter((asset) => !actual.includes(asset));
  const unexpected = actual.filter((asset) => !expected.includes(asset));
  if (missing.length > 0 || unexpected.length > 0) {
    fail(
      `${label} must contain the exact consumed asset set; ` +
        `missing=[${missing.join(", ")}], unexpected=[${unexpected.join(", ")}]`,
    );
  }
}

// invalidState: the blueprint and stable runtime selectors request a newer
// OpenShell release while both embedded hash tables still name an older,
// independently valid release, so separate dependency and hash checks pass but
// installation cannot find a hash for the selected version.
// sourceBoundary: this base-trusted parser reads the PR blueprint and installer
// sources only as inert, bounded files and binds every stable selector to the
// single release extracted from the static hash tables.
// whyNotSourceFix: OpenShell can attest its release but cannot keep NemoClaw's
// blueprint, installer selector, Brev selector, and embedded tables coherent.
// regressionTest: test/install/installer-hash-check.test.ts moves all runtime consumers
// to 0.0.85 while leaving both valid pin tables at 0.0.72 and requires failure.
// removalCondition: remove these comparisons only when one base-trusted,
// machine-readable pin manifest directly drives every runtime consumer.
function extractSingleVersion(
  source: string,
  pattern: RegExp,
  label: string,
  captureIndex = 1,
): string {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const matches = [...source.matchAll(new RegExp(pattern.source, flags))];
  const version = matches[0]?.[captureIndex];
  if (matches.length !== 1 || !version) {
    fail(`${label} must contain exactly one literal X.Y.Z version`);
  }
  return version;
}

function extractBlueprintMaxVersion(source: string): string {
  return extractSingleVersion(
    source,
    /^max_openshell_version:\s*(["'])([0-9]+\.[0-9]+\.[0-9]+)\1\s*$/gm,
    "blueprint max_openshell_version",
    2,
  );
}

function extractInstallerRuntimeVersion(source: string): string {
  const maxVersion = extractSingleVersion(
    source,
    /^MAX_VERSION="([0-9]+\.[0-9]+\.[0-9]+)"\s*$/gm,
    "installer MAX_VERSION",
  );
  const pinVersionAssignments = [...source.matchAll(/^PIN_VERSION=(.*)\s*$/gm)];
  if (
    pinVersionAssignments.length !== 1 ||
    pinVersionAssignments[0]?.[1]?.trim() !== '"$MAX_VERSION"'
  ) {
    fail('installer PIN_VERSION must be exactly "$MAX_VERSION"');
  }
  return maxVersion;
}

function extractInstallerMinimumVersion(source: string): string {
  return extractSingleVersion(
    source,
    /^MIN_VERSION="([0-9]+\.[0-9]+\.[0-9]+)"\s*$/gm,
    "installer MIN_VERSION",
  );
}

function extractInstallerDevelopmentMinimumVersion(source: string): string {
  return extractSingleVersion(
    source,
    /^DEV_MIN_VERSION="([0-9]+\.[0-9]+\.[0-9]+)"\s*$/gm,
    "installer DEV_MIN_VERSION",
  );
}

function extractBrevStableRuntimeVersion(source: string): string {
  return extractSingleVersion(
    source,
    /^\s*stable\s*\|\s*auto\)\s*OPENSHELL_VERSION="v([0-9]+\.[0-9]+\.[0-9]+)"\s*;;\s*$/gm,
    "Brev stable OpenShell default",
  );
}

function isOperatorStart(character: string): boolean {
  return "(){};".includes(character);
}

function tokenizeShellSubset(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < source.length) {
    const character = source[index] ?? "";
    const next = source[index + 1] ?? "";

    if (character === "\\" && (next === "\n" || (next === "\r" && source[index + 2] === "\n"))) {
      index += next === "\n" ? 2 : 3;
      continue;
    }
    if (character === " " || character === "\t" || character === "\r") {
      index += 1;
      continue;
    }
    if (character === "\n") {
      tokens.push({
        end: index + 1,
        kind: "newline",
        start: index,
        value: "\n",
      });
      index += 1;
      continue;
    }
    if (character === "#") {
      while (index < source.length && source[index] !== "\n") {
        index += 1;
      }
      continue;
    }
    if (character === ";" && next === ";") {
      tokens.push({
        end: index + 2,
        kind: "operator",
        start: index,
        value: ";;",
      });
      index += 2;
      continue;
    }
    if (isOperatorStart(character)) {
      tokens.push({
        end: index + 1,
        kind: "operator",
        start: index,
        value: character,
      });
      index += 1;
      continue;
    }

    const wordStart = index;
    let value = "";
    while (index < source.length) {
      const wordCharacter = source[index] ?? "";
      const wordNext = source[index + 1] ?? "";
      if (
        wordCharacter === " " ||
        wordCharacter === "\t" ||
        wordCharacter === "\r" ||
        wordCharacter === "\n" ||
        isOperatorStart(wordCharacter)
      ) {
        break;
      }
      if (wordCharacter === "\\") {
        if (wordNext === "\n" || (wordNext === "\r" && source[index + 2] === "\n")) {
          index += wordNext === "\n" ? 2 : 3;
          continue;
        }
        if (!wordNext) {
          fail("source ends with an incomplete escape");
        }
        value += wordNext;
        index += 2;
        continue;
      }
      if (wordCharacter === "'") {
        const closingQuote = source.indexOf("'", index + 1);
        if (closingQuote === -1) {
          fail("source contains an unterminated single-quoted word");
        }
        value += source.slice(index + 1, closingQuote);
        index = closingQuote + 1;
        continue;
      }
      if (wordCharacter === '"') {
        index += 1;
        let closed = false;
        while (index < source.length) {
          const quotedCharacter = source[index] ?? "";
          const quotedNext = source[index + 1] ?? "";
          if (quotedCharacter === '"') {
            index += 1;
            closed = true;
            break;
          }
          if (quotedCharacter === "\\") {
            if (quotedNext === "\n" || (quotedNext === "\r" && source[index + 2] === "\n")) {
              index += quotedNext === "\n" ? 2 : 3;
              continue;
            }
            if ('$`"\\'.includes(quotedNext)) {
              value += quotedNext;
              index += 2;
              continue;
            }
          }
          value += quotedCharacter;
          index += 1;
        }
        if (!closed) {
          fail("source contains an unterminated double-quoted word");
        }
        continue;
      }
      value += wordCharacter;
      index += 1;
    }
    if (!value) {
      fail(`unsupported shell token near ${JSON.stringify(source.slice(index, index + 16))}`);
    }
    tokens.push({ end: index, kind: "word", start: wordStart, value });
  }

  return tokens;
}

function isToken(token: Token | undefined, kind: Token["kind"], value?: string): boolean {
  return token?.kind === kind && (value === undefined || token.value === value);
}

function rawToken(source: string, token: Token | undefined): string {
  if (!token) fail("required shell token is unavailable");
  return source.slice(token.start, token.end);
}

function functionBodyRanges(tokens: Token[], functionName: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (let index = 0; index < tokens.length - 3; index += 1) {
    const nameIndex = isToken(tokens[index], "word", "function") ? index + 1 : index;
    if (!isToken(tokens[nameIndex], "word", functionName)) {
      continue;
    }
    let cursor = nameIndex + 1;
    if (isToken(tokens[cursor], "operator", "(")) {
      if (!isToken(tokens[cursor + 1], "operator", ")")) {
        continue;
      }
      cursor += 2;
    }
    if (!isToken(tokens[cursor], "operator", "{")) {
      continue;
    }

    let depth = 1;
    for (let bodyCursor = cursor + 1; bodyCursor < tokens.length; bodyCursor += 1) {
      if (isToken(tokens[bodyCursor], "operator", "{")) {
        depth += 1;
      } else if (isToken(tokens[bodyCursor], "operator", "}")) {
        depth -= 1;
        if (depth === 0) {
          ranges.push([cursor + 1, bodyCursor]);
          index = bodyCursor;
          break;
        }
      }
    }
    if (depth !== 0) {
      fail(`${functionName} has an unterminated function body`);
    }
  }
  return ranges;
}

type SourceEdit = {
  end: number;
  replacement: string;
  start: number;
};

function functionDefinitionSourceRanges(source: string, functionName: string): SourceEdit[] {
  const tokens = tokenizeShellSubset(source);
  const ranges: SourceEdit[] = [];
  for (let index = 0; index < tokens.length - 3; index += 1) {
    const definitionStart = index;
    const nameIndex = isToken(tokens[index], "word", "function") ? index + 1 : index;
    if (!isToken(tokens[nameIndex], "word", functionName)) continue;
    let cursor = nameIndex + 1;
    if (isToken(tokens[cursor], "operator", "(")) {
      if (!isToken(tokens[cursor + 1], "operator", ")")) continue;
      cursor += 2;
    }
    if (!isToken(tokens[cursor], "operator", "{")) continue;

    let depth = 1;
    for (let bodyCursor = cursor + 1; bodyCursor < tokens.length; bodyCursor += 1) {
      if (isToken(tokens[bodyCursor], "operator", "{")) {
        depth += 1;
      } else if (isToken(tokens[bodyCursor], "operator", "}")) {
        depth -= 1;
        if (depth === 0) {
          const start = tokens[definitionStart]?.start;
          const end = tokens[bodyCursor]?.end;
          if (start === undefined || end === undefined) {
            fail(`${functionName} source range is unavailable`);
          }
          ranges.push({
            end,
            replacement: `<${functionName}:trusted-release-data>`,
            start,
          });
          index = bodyCursor;
          break;
        }
      }
    }
    if (depth !== 0) fail(`${functionName} has an unterminated function body`);
  }
  return ranges;
}

function selectorVersionEdit(source: string, pattern: RegExp, label: string): SourceEdit {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const matches = [...source.matchAll(new RegExp(pattern.source, flags))];
  const match = matches[0];
  const version = match?.[1];
  if (matches.length !== 1 || !match || !version || match.index === undefined) {
    fail(`${label} must contain exactly one permitted release selector literal`);
  }
  const relativeStart = match[0].indexOf(version);
  if (relativeStart === -1) fail(`${label} release selector range is unavailable`);
  const start = match.index + relativeStart;
  return {
    end: start + version.length,
    replacement: "<trusted-release-version>",
    start,
  };
}

// invalidState: a dependency pin PR needs to add standalone sandbox binary
// identities but could hide control flow or arbitrary commands inside the map
// if the whole function were normalized without first parsing its grammar.
// sourceBoundary: this base-trusted parser accepts only literal digest case
// alternatives that print literal versions and a fail-closed default branch.
// regressionTest: installer-hash-check.test.ts covers valid additions plus
// control-flow, unknown-command, duplicate-digest, and malformed-version edits.
// removalCondition: remove this parser only when the standalone sandbox build
// identity map is generated from a base-trusted machine-readable manifest.
function extractSandboxBuildPins(source: string): SandboxBuildPin[] {
  const functionName = "pinned_sandbox_build_version";
  const tokens = tokenizeShellSubset(source);
  const bodyRanges = functionBodyRanges(tokens, functionName);
  if (bodyRanges.length !== 1) {
    fail(`installer must contain exactly one ${functionName} release-data function`);
  }
  const [bodyStart, bodyEnd] = bodyRanges[0] ?? fail(`${functionName} body range is unavailable`);
  let cursor = skipSeparators(tokens, bodyStart);

  const localCommand = commandBeforeSeparator(tokens, cursor);
  if (
    localCommand.command.length !== 2 ||
    !isToken(localCommand.command[0], "word", "local") ||
    !isToken(localCommand.command[1], "word", "digest=$1") ||
    rawToken(source, localCommand.command[1]) !== 'digest="$1"'
  ) {
    fail(`${functionName} must begin with exactly local digest="$1"`);
  }
  cursor = skipSeparators(tokens, localCommand.next);

  const caseCommand = commandBeforeSeparator(tokens, cursor);
  if (
    caseCommand.command.length !== 3 ||
    !isToken(caseCommand.command[0], "word", "case") ||
    !isToken(caseCommand.command[1], "word", "$digest") ||
    rawToken(source, caseCommand.command[1]) !== '"$digest"' ||
    !isToken(caseCommand.command[2], "word", "in")
  ) {
    fail(`${functionName} must dispatch exactly on "$digest"`);
  }
  cursor = skipSeparators(tokens, caseCommand.next);

  const pins: SandboxBuildPin[] = [];
  const seenDigests = new Set<string>();
  let sawDefaultBranch = false;
  while (cursor < bodyEnd) {
    if (isToken(tokens[cursor], "word", "*")) {
      sawDefaultBranch = true;
      cursor += 1;
      if (!isToken(tokens[cursor], "operator", ")")) {
        fail(`${functionName} default branch must be exactly *)`);
      }
      cursor = skipSeparators(tokens, cursor + 1);
      const defaultCommand = commandBeforeSeparator(tokens, cursor);
      if (
        defaultCommand.command.length !== 2 ||
        !isToken(defaultCommand.command[0], "word", "return") ||
        !isToken(defaultCommand.command[1], "word", "1")
      ) {
        fail(`${functionName} default branch must return 1`);
      }
      cursor = skipSeparators(tokens, defaultCommand.next);
      if (!isToken(tokens[cursor], "operator", ";;")) {
        fail(`${functionName} default branch must end with ;;`);
      }
      cursor = skipSeparators(tokens, cursor + 1);
      if (!isToken(tokens[cursor], "word", "esac")) {
        fail(`${functionName} must end with esac after its default branch`);
      }
      cursor = skipSeparators(tokens, cursor + 1);
      if (cursor !== bodyEnd) {
        fail(`${functionName} contains commands after its case statement`);
      }
      break;
    }

    const digests: string[] = [];
    let expectDigest = true;
    while (cursor < bodyEnd && !isToken(tokens[cursor], "operator", ")")) {
      const token = tokens[cursor];
      if (expectDigest) {
        if (!isToken(token, "word") || !SHA256_PATTERN.test(token.value)) {
          fail(`${functionName} case patterns must contain literal SHA-256 digests`);
        }
        if (seenDigests.has(token.value)) {
          fail(`${functionName} contains duplicate digest ${token.value}`);
        }
        seenDigests.add(token.value);
        digests.push(token.value);
      } else if (!isToken(token, "word", "|")) {
        fail(`${functionName} digest alternatives must be separated by |`);
      }
      expectDigest = !expectDigest;
      cursor += 1;
    }
    if (digests.length === 0 || expectDigest || !isToken(tokens[cursor], "operator", ")")) {
      fail(`${functionName} contains a malformed digest case pattern`);
    }
    cursor = skipSeparators(tokens, cursor + 1);

    const printfCommand = commandBeforeSeparator(tokens, cursor);
    const version = printfCommand.command[2]?.value ?? "";
    if (
      printfCommand.command.length !== 3 ||
      !isToken(printfCommand.command[0], "word", "printf") ||
      !isToken(printfCommand.command[1], "word", "%s\\n") ||
      !/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(version)
    ) {
      fail(`${functionName} digest branches must print exactly one literal X.Y.Z version`);
    }
    for (const sha256 of digests) pins.push({ sha256, version });
    cursor = skipSeparators(tokens, printfCommand.next);
    if (!isToken(tokens[cursor], "operator", ";;")) {
      fail(`${functionName} digest branches must end with ;;`);
    }
    cursor = skipSeparators(tokens, cursor + 1);
  }

  if (!sawDefaultBranch) fail(`${functionName} must contain a fail-closed default branch`);
  if (pins.length === 0) fail(`${functionName} must contain at least one sandbox build pin`);
  return pins;
}

// invalidState: a selector PR adds an arbitrary standalone sandbox binary
// digest to the normalized shell map and thereby labels candidate-controlled
// bytes as the selected OpenShell release when `--version` cannot execute.
// sourceBoundary: this allowlist and comparison execute from the base-trusted
// parser; the PR-head shell function remains bounded inert input.
// whyNotSourceFix: OpenShell authenticates the outer archives, while NemoClaw
// owns the inner-binary fallback used by its downstream installer.
// regressionTest: installer-sandbox-build-trust.test.ts rejects arbitrary,
// remapped, missing, and self-authorized identities while accepting a
// prerequisite that adds only exact digest/version pairs from a reviewed release.
// removalCondition: remove this check only when the standalone sandbox exposes
// a reliable authenticated build identity on every supported host.
function assertTrustedSandboxBuildPins(
  pins: SandboxBuildPin[],
  release: OpenShellReleaseTrust,
): void {
  const pinKey = (pin: SandboxBuildPin): string => `${pin.version}:${pin.sha256}`;
  const trustedPins = TRUSTED_OPENSHELL_RELEASES.flatMap((trustedRelease) =>
    trustedRelease.sandboxBuilds.map((pin) => ({ ...pin, version: trustedRelease.version })),
  );
  const trustedKeys = new Set(trustedPins.map(pinKey));
  const actualKeys = new Set(pins.map(pinKey));
  const selectedPins = release.sandboxBuilds;
  if (selectedPins.length === 0) {
    fail(
      `no base-trusted standalone sandbox binary identities exist for release ${release.version}`,
    );
  }

  const missing = trustedPins
    .filter(
      (pin) => (pin.required || pin.version === release.version) && !actualKeys.has(pinKey(pin)),
    )
    .map(pinKey)
    .sort();
  const unexpected = pins
    .filter((pin) => !trustedKeys.has(pinKey(pin)))
    .map(pinKey)
    .sort();
  if (missing.length > 0 || unexpected.length > 0) {
    fail(
      `pinned_sandbox_build_version must use only base-trusted binary identities; ` +
        `missing=[${missing.join(", ")}], unexpected=[${unexpected.join(", ")}]`,
    );
  }
}

function extractSupervisorManifestPins(
  source: string,
  trustedSupervisor: TrustedSupervisorManifest,
): SupervisorManifestPin[] {
  const mapHeader =
    "const OPENSHELL_SUPERVISOR_MANIFEST_DIGESTS: Readonly<Record<string, string>> = {\n";
  const mapStart = source.indexOf(mapHeader);
  if (mapStart === -1 || source.indexOf(mapHeader, mapStart + mapHeader.length) !== -1) {
    fail("supervisor runtime must contain exactly one literal manifest digest map");
  }
  const bodyStart = mapStart + mapHeader.length;
  const mapEnd = source.indexOf("\n};", bodyStart);
  if (mapEnd === -1) fail("supervisor runtime manifest digest map is unterminated");

  const pins = source
    .slice(bodyStart, mapEnd)
    .split("\n")
    .map((line) => {
      const match = /^  "([0-9]+\.[0-9]+\.[0-9]+)": "(sha256:[a-f0-9]{64})",$/u.exec(line);
      if (!match) fail("supervisor runtime manifest digest map must contain only literal pins");
      return {
        image: trustedSupervisor.image,
        manifestDigest: match[2] ?? "",
        version: match[1] ?? "",
      };
    });
  if (pins.length === 0) fail("supervisor runtime manifest digest map must not be empty");
  const duplicateVersions = pins
    .map((pin) => pin.version)
    .filter((version, index, versions) => versions.indexOf(version) !== index);
  if (duplicateVersions.length > 0) {
    fail(
      `supervisor runtime manifest digest map contains duplicate versions: ${[
        ...new Set(duplicateVersions),
      ].join(", ")}`,
    );
  }
  const normalized = `${source.slice(0, bodyStart)}<normalized-supervisor-manifest-pins>${source.slice(
    mapEnd,
  )}`;
  const templateSha256 = createHash("sha256").update(normalized).digest("hex");
  if (!trustedSupervisor.runtimeTemplateSha256.includes(templateSha256)) {
    fail(
      `supervisor runtime operational template is not base-trusted; ` +
        `expected_sha256=[${trustedSupervisor.runtimeTemplateSha256.join(", ")}], ` +
        `actual_sha256=${templateSha256}`,
    );
  }
  return pins;
}

// invalidState: a selector PR adds or remaps a supervisor OCI digest and then
// changes its own dependency checker to label that candidate-controlled image
// as reviewed.
// sourceBoundary: this exact image/version/index allowlist and whole-file
// template lock execute from the base-trusted parser; only the strictly parsed
// PR runtime map body is normalized as inert release data.
// whyNotSourceFix: the upstream registry publishes the index, while NemoClaw
// owns the downstream version-to-image selection contract.
// regressionTest: installer-supervisor-manifest-trust.test.ts covers dormant,
// wrong-digest, remapped, missing, decoy/shadow, mutation, resolver-drift, and
// self-authorization paths.
// removalCondition: remove this check only when an authenticated upstream
// manifest directly drives the runtime selector without PR-authored identity data.
function assertTrustedSupervisorManifestPins(
  pins: SupervisorManifestPin[],
  release: OpenShellReleaseTrust,
): void {
  const pinKey = (pin: SupervisorManifestPin): string =>
    `${pin.image}|${pin.version}|${pin.manifestDigest}`;
  const trustedPins = TRUSTED_OPENSHELL_RELEASES.flatMap((trustedRelease) =>
    trustedRelease.supervisor
      ? [{ ...trustedRelease.supervisor, version: trustedRelease.version }]
      : [],
  );
  const trustedKeys = new Set(trustedPins.map(pinKey));
  const actualKeys = new Set(pins.map(pinKey));
  const selectedPins = release.supervisor ? [release.supervisor] : [];
  if (selectedPins.length !== 1) {
    fail(
      `release ${release.version} must have exactly one base-trusted supervisor manifest identity`,
    );
  }

  const missing = trustedPins
    .filter(
      (pin) => (pin.required || pin.version === release.version) && !actualKeys.has(pinKey(pin)),
    )
    .map(pinKey)
    .sort();
  const unexpected = pins
    .filter((pin) => !trustedKeys.has(pinKey(pin)))
    .map(pinKey)
    .sort();
  if (missing.length > 0 || unexpected.length > 0) {
    fail(
      `OpenShell supervisor manifest map must use only base-trusted identities; ` +
        `missing=[${missing.join(", ")}], unexpected=[${unexpected.join(", ")}]`,
    );
  }
}

function normalizeTrustedInstallerTemplate(
  source: string,
  functionNames: readonly string[],
  selectorPatterns: readonly RegExp[],
  label: string,
): string {
  const functionRanges = functionNames.flatMap((functionName) => {
    const ranges = functionDefinitionSourceRanges(source, functionName);
    if (ranges.length !== 1) {
      fail(`${label} must contain exactly one ${functionName} release-data function`);
    }
    return ranges;
  });
  const edits = [
    ...functionRanges,
    ...selectorPatterns.map((pattern, index) =>
      selectorVersionEdit(source, pattern, `${label} selector ${index + 1}`),
    ),
  ].sort((left, right) => right.start - left.start);
  for (let index = 0; index < edits.length - 1; index += 1) {
    const current = edits[index];
    const next = edits[index + 1];
    if (current && next && next.end > current.start) {
      fail(`${label} normalized release-data regions overlap`);
    }
  }
  return edits.reduce(
    (normalized, edit) =>
      `${normalized.slice(0, edit.start)}${edit.replacement}${normalized.slice(edit.end)}`,
    source,
  );
}

// invalidState: a mutable PR leaves a valid-looking pin table in inert text but
// changes which release, URL, checksum verifier, archive validator, or install
// path actually executes. sourceBoundary: the expected hashes and normalizer
// execute from the base-trusted checkout; PR installer files are inert input.
// regressionTest: test/install/installer-hash-check.test.ts mutates comments, control
// flow, indirect selectors, SHA commands, and alternate download/extract paths.
// removalCondition: remove this template lock only when a base-trusted,
// machine-readable manifest directly drives every installer operation.
function assertTrustedTemplate(
  source: string,
  functionNames: readonly string[],
  selectorPatterns: readonly RegExp[],
  expectedSha256: readonly string[],
  label: string,
): string {
  const normalized = normalizeTrustedInstallerTemplate(
    source,
    functionNames,
    selectorPatterns,
    label,
  );
  const actualSha256 = createHash("sha256").update(normalized).digest("hex");
  if (!expectedSha256.includes(actualSha256)) {
    fail(
      `${label} operational template is not base-trusted; ` +
        `expected_sha256=[${expectedSha256.join(", ")}], actual_sha256=${actualSha256}`,
    );
  }
  return actualSha256;
}

function skipSeparators(tokens: Token[], start: number): number {
  let cursor = start;
  while (isToken(tokens[cursor], "newline") || isToken(tokens[cursor], "operator", ";")) {
    cursor += 1;
  }
  return cursor;
}

function commandBeforeSeparator(
  tokens: Token[],
  start: number,
): { command: Token[]; next: number } {
  let cursor = start;
  while (
    cursor < tokens.length &&
    !isToken(tokens[cursor], "newline") &&
    !isToken(tokens[cursor], "operator", ";")
  ) {
    cursor += 1;
  }
  return {
    command: tokens.slice(start, cursor),
    next: skipSeparators(tokens, cursor),
  };
}

function staticPinFromArm(
  source: string,
  patternToken: Token,
  commandTokens: Token[],
): InstallerPin | undefined {
  const pattern = patternToken.value;
  const match = LITERAL_PIN_PATTERN.exec(pattern);
  const rawPattern = rawToken(source, patternToken);
  if (!match) {
    if (pattern !== "*") {
      fail(`unsupported case pattern ${JSON.stringify(pattern)}`);
    }
    if (rawPattern !== "*") {
      fail("the fallback case pattern must be one unquoted wildcard");
    }
    const wildcardTokens = commandTokens.filter(
      (token) => token.kind !== "newline" && token.value !== ";",
    );
    const wildcardCommand = wildcardTokens.map((token) => token.value);
    if (wildcardCommand.join(" ") !== "return 1") {
      fail("the fallback case arm must contain only 'return 1'");
    }
    if (
      rawToken(source, wildcardTokens[0]) !== "return" ||
      rawToken(source, wildcardTokens[1]) !== "1"
    ) {
      fail("the fallback case arm must use literal 'return 1'");
    }
    return undefined;
  }

  if (![pattern, `'${pattern}'`, `"${pattern}"`].includes(rawPattern)) {
    fail(`case arm ${pattern} must be one literal release-and-asset pattern`);
  }

  const staticCommandTokens = commandTokens.filter(
    (token) => token.kind !== "newline" && token.value !== ";",
  );
  const command = staticCommandTokens.map((token) => token.value);
  if (command.length !== 3 || command[0] !== "printf" || command[1] !== "%s\\n") {
    fail(`case arm ${pattern} must contain exactly one static printf '%s\\n' SHA-256 command`);
  }
  if (
    rawToken(source, staticCommandTokens[0]) !== "printf" ||
    !["'%s\\n'", '"%s\\n"'].includes(rawToken(source, staticCommandTokens[1]))
  ) {
    fail(`case arm ${pattern} must use a literal printf '%s\\n' command`);
  }
  const sha256 = command[2] ?? "";
  if (!SHA256_PATTERN.test(sha256)) {
    fail(`case arm ${pattern} does not contain one literal lowercase SHA-256 digest`);
  }
  if (![sha256, `'${sha256}'`, `"${sha256}"`].includes(rawToken(source, staticCommandTokens[2]))) {
    fail(`case arm ${pattern} must print one literal lowercase SHA-256 digest`);
  }
  return {
    asset: match[2] ?? "",
    releaseVersion: match[1] ?? "",
    sha256,
    source: "",
  };
}

// invalidState: trusted CI accepts a pin table whose shell formatting hides,
// duplicates, or changes a consumed release-asset digest.
// sourceBoundary: this trusted parser owns the accepted static shell subset;
// pull-request installer files provide data only and are never sourced or run.
// whyNotSourceFix: the bootstrap installers need self-contained shell lookup
// functions before package dependencies are available, so JSON is not their
// runtime source of truth.
// regressionTest: test/install/installer-hash-check.test.ts covers whitespace, comments,
// continuations, quote styles, mixed indentation, missing pins, and ambiguity.
// removalCondition: remove shell parsing when both installers and this verifier
// consume one canonical machine-readable pin manifest directly.
export function extractInstallerPins(source: string, options: ExtractOptions): InstallerPin[] {
  const tokens = tokenizeShellSubset(source);
  const ranges = functionBodyRanges(tokens, options.functionName);
  if (ranges.length !== 1) {
    fail(`expected exactly one ${options.functionName} definition, found ${ranges.length}`);
  }
  const headerIndex = tokens.findIndex(
    (token, index) =>
      token.kind === "word" &&
      token.value === options.functionName &&
      ((isToken(tokens[index + 1], "operator", "(") &&
        isToken(tokens[index + 2], "operator", ")") &&
        isToken(tokens[index + 3], "operator", "{")) ||
        isToken(tokens[index + 1], "operator", "{")),
  );
  if (headerIndex === -1 || rawToken(source, tokens[headerIndex]) !== options.functionName) {
    fail(`${options.functionName} must use one literal unquoted function name`);
  }
  if (
    isToken(tokens[headerIndex - 1], "word", "function") &&
    rawToken(source, tokens[headerIndex - 1]) !== "function"
  ) {
    fail(`${options.functionName} must use a literal function keyword`);
  }
  const [bodyStart, bodyEnd] = ranges[0] ?? fail(`missing ${options.functionName} body`);
  const body = tokens.slice(bodyStart, bodyEnd);
  let cursor = skipSeparators(body, 0);

  const local = commandBeforeSeparator(body, cursor);
  const localStart = local.command[0];
  const localEnd = local.command.at(-1);
  const localSource = localStart && localEnd ? source.slice(localStart.start, localEnd.end) : "";
  if (!FUNCTION_LOCAL_SOURCE_PATTERN.test(localSource)) {
    fail(`${options.functionName} must start with local release_tag and asset inputs`);
  }
  cursor = local.next;
  if (!isToken(body[cursor], "word", "case")) {
    fail(`${options.functionName} must contain one static case table`);
  }
  if (rawToken(source, body[cursor]) !== "case") {
    fail(`${options.functionName} must use a literal case keyword`);
  }
  const selector = body[cursor + 1];
  if (
    !isToken(selector, "word", "${release_tag}:${asset}") ||
    rawToken(source, selector) !== '"${release_tag}:${asset}"'
  ) {
    fail(`${options.functionName} must select on release_tag and asset`);
  }
  if (!isToken(body[cursor + 2], "word", "in")) {
    fail(`${options.functionName} case table is missing 'in'`);
  }
  if (rawToken(source, body[cursor + 2]) !== "in") {
    fail(`${options.functionName} must use a literal in keyword`);
  }
  cursor = skipSeparators(body, cursor + 3);

  const pins: InstallerPin[] = [];
  let fallbackCount = 0;
  while (!isToken(body[cursor], "word", "esac")) {
    const pattern = body[cursor];
    if (!isToken(pattern, "word") || !isToken(body[cursor + 1], "operator", ")")) {
      fail(`${options.functionName} contains an invalid case arm`);
    }
    cursor += 2;
    const commandStart = cursor;
    while (cursor < body.length && !isToken(body[cursor], "operator", ";;")) {
      cursor += 1;
    }
    if (cursor >= body.length) {
      fail(`${options.functionName} case arm ${pattern.value} is missing ';;'`);
    }
    const pin = staticPinFromArm(source, pattern, body.slice(commandStart, cursor));
    if (pattern.value === "*") {
      fallbackCount += 1;
    } else if (pin) {
      pins.push({ ...pin, source: options.sourceLabel });
    }
    cursor = skipSeparators(body, cursor + 1);
  }
  if (rawToken(source, body[cursor]) !== "esac") {
    fail(`${options.functionName} must use a literal esac keyword`);
  }
  cursor = skipSeparators(body, cursor + 1);
  if (cursor !== body.length) {
    fail(`${options.functionName} contains commands after its case table`);
  }
  if (fallbackCount !== 1) {
    fail(`${options.functionName} must contain exactly one fail-closed fallback arm`);
  }

  if (pins.length === 0) {
    fail(`${options.functionName} contains no versioned pins`);
  }
  const releaseVersions = [...new Set(pins.map((pin) => pin.releaseVersion))];
  const duplicateAssets = pins
    .map((pin) => `${pin.releaseVersion}:${pin.asset}`)
    .filter((asset, index, assets) => assets.indexOf(asset) !== index)
    .map((asset) => (releaseVersions.length === 1 ? asset.slice(asset.indexOf(":") + 1) : asset));
  if (duplicateAssets.length > 0) {
    fail(
      `${options.functionName} contains duplicate assets: ${[...new Set(duplicateAssets)].join(", ")}`,
    );
  }
  return pins;
}

function parseCliOptions(argv: string[]): CliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index] ?? "";
    const value = argv[index + 1] ?? "";
    if (!option.startsWith("--") || !value) {
      fail(
        "usage: extract-installer-pins.mts --blueprint PATH --installer PATH --brev-installer PATH --supervisor-runtime PATH [--format json|release-tsv|tsv]",
      );
    }
    if (values.has(option)) {
      fail(`duplicate CLI option ${option}`);
    }
    values.set(option, value);
  }
  const blueprint = values.get("--blueprint") ?? "";
  const installer = values.get("--installer") ?? "";
  const brevInstaller = values.get("--brev-installer") ?? "";
  const supervisorRuntime = values.get("--supervisor-runtime") ?? "";
  const format = values.get("--format") ?? "json";
  const allowedOptions = new Set([
    "--blueprint",
    "--brev-installer",
    "--format",
    "--installer",
    "--supervisor-runtime",
  ]);
  const unknownOptions = [...values.keys()].filter((option) => !allowedOptions.has(option));
  if (
    unknownOptions.length > 0 ||
    !blueprint ||
    !installer ||
    !brevInstaller ||
    !supervisorRuntime ||
    (format !== "json" && format !== "release-tsv" && format !== "tsv")
  ) {
    fail(`invalid CLI options${unknownOptions.length > 0 ? `: ${unknownOptions.join(", ")}` : ""}`);
  }
  return { blueprint, brevInstaller, format, installer, supervisorRuntime };
}

function runCli(): void {
  const options = parseCliOptions(process.argv.slice(2));
  const blueprintSource = readInstallerInput(options.blueprint, "blueprint");
  const installerSource = readInstallerInput(options.installer, "installer");
  const brevInstallerSource = readInstallerInput(options.brevInstaller, "Brev launchable");
  const supervisorRuntimeSource = readInstallerInput(
    options.supervisorRuntime,
    "supervisor runtime",
  );
  const installerPins = extractInstallerPins(installerSource, {
    functionName: "openshell_pinned_sha256",
    sourceLabel: "installer",
  });
  const brevPins = extractInstallerPins(brevInstallerSource, {
    functionName: "openshell_cli_pinned_sha256",
    sourceLabel: "Brev launchable",
  });
  const installerReleaseVersions = [
    ...new Set(installerPins.map((pin) => pin.releaseVersion)),
  ].sort();
  for (const version of installerReleaseVersions) {
    assertExactAssetSet(
      installerPins.filter((pin) => pin.releaseVersion === version),
      EXPECTED_INSTALLER_ASSETS,
      installerReleaseVersions.length === 1
        ? "installer pin table"
        : `installer pin table for ${version}`,
    );
  }
  assertExactAssetSet(brevPins, EXPECTED_BREV_ASSETS, "Brev pin table");
  const brevReleaseVersions = [...new Set(brevPins.map((pin) => pin.releaseVersion))].sort();
  if (brevReleaseVersions.length !== 1) {
    fail(
      `Brev launchable pin table must contain exactly one release version, found ${brevReleaseVersions.join(", ")}`,
    );
  }
  const releaseVersion = brevReleaseVersions[0] ?? fail("Brev pin table contains no release");
  if (!installerReleaseVersions.includes(releaseVersion)) {
    fail(`installer pin table has no assets for selected release ${releaseVersion}`);
  }
  const pins = [...installerPins, ...brevPins];
  const release = trustedRelease(releaseVersion);
  const installerReleases = installerReleaseVersions.map(trustedRelease);
  const sandboxBuildPins = extractSandboxBuildPins(installerSource);
  assertTrustedSandboxBuildPins(sandboxBuildPins, release);
  const supervisor =
    release.supervisor ??
    fail(
      `release ${release.version} must have exactly one base-trusted supervisor manifest identity`,
    );
  const supervisorManifestPins = extractSupervisorManifestPins(supervisorRuntimeSource, supervisor);
  assertTrustedSupervisorManifestPins(supervisorManifestPins, release);
  const installerTemplateSha256 = assertTrustedTemplate(
    installerSource,
    ["openshell_pinned_sha256", "pinned_sandbox_build_version"],
    [
      /^MIN_VERSION="([0-9]+\.[0-9]+\.[0-9]+)"$/gm,
      /^MAX_VERSION="([0-9]+\.[0-9]+\.[0-9]+)"$/gm,
      /^DEV_MIN_VERSION="([0-9]+\.[0-9]+\.[0-9]+)"$/gm,
    ],
    release.installerTemplateSha256,
    "installer",
  );
  const brevTemplateSha256 = assertTrustedTemplate(
    brevInstallerSource,
    ["openshell_cli_pinned_sha256"],
    [/^\s*stable\s*\|\s*auto\)\s*OPENSHELL_VERSION="v([0-9]+\.[0-9]+\.[0-9]+)"\s*;;\s*$/gm],
    release.brevTemplateSha256,
    "Brev launchable",
  );
  for (const [label, runtimeVersion] of [
    ["blueprint max_openshell_version", extractBlueprintMaxVersion(blueprintSource)],
    ["installer MIN_VERSION", extractInstallerMinimumVersion(installerSource)],
    ["installer MAX_VERSION", extractInstallerRuntimeVersion(installerSource)],
    ["installer DEV_MIN_VERSION", extractInstallerDevelopmentMinimumVersion(installerSource)],
    ["Brev stable OpenShell default", extractBrevStableRuntimeVersion(brevInstallerSource)],
  ] as const) {
    if (runtimeVersion !== releaseVersion) {
      fail(`installer pin-table release ${releaseVersion} must match ${label} ${runtimeVersion}`);
    }
  }
  if (options.format === "json") {
    process.stdout.write(
      `${JSON.stringify(
        pins.map((pin) => ({
          ...pin,
          operationalTemplateSha256:
            pin.source === "installer" ? installerTemplateSha256 : brevTemplateSha256,
        })),
      )}\n`,
    );
    return;
  }
  if (options.format === "release-tsv") {
    process.stdout.write(
      [
        ...installerReleases.flatMap((installerRelease) =>
          installerRelease.manifests.map(
            (manifest) =>
              `manifest\t${installerRelease.version}\tOpenShell release\t${manifest.asset}\t${manifest.sha256}`,
          ),
        ),
        ...installerReleases.map(
          (installerRelease) =>
            `formula\t${installerRelease.version}\t${installerRelease.formula.url}\t${installerRelease.formula.asset}\t${installerRelease.formula.sha256}`,
        ),
        ...pins.map(
          (pin) => `pin\t${pin.releaseVersion}\t${pin.source}\t${pin.asset}\t${pin.sha256}`,
        ),
      ].join("\n"),
    );
    process.stdout.write("\n");
    return;
  }
  process.stdout.write(
    pins
      .map((pin) => `${pin.releaseVersion}\t${pin.source}\t${pin.asset}\t${pin.sha256}`)
      .join("\n"),
  );
  process.stdout.write("\n");
}

const invokedPath = process.argv[1];
if (
  invokedPath &&
  fs.realpathSync(path.resolve(invokedPath)) === fs.realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
