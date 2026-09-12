// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import path from "node:path";

import { cloneAndDeepFreeze } from "../../core/immutable";
import type { WindowsMxcQualifiedNativeArchitecture } from "../windows-mxc/host-qualification";

export const MXC_OPENSHELL_ATTACHMENT_CONTRACT_VERSION = 3 as const;
export const MXC_OPENSHELL_DISTRIBUTION_AUTHORITY_CONTRACT_VERSION = 1 as const;
export const MXC_OPENSHELL_V0_0_24_MXC_V0_7_0_RC1_QUALIFICATION_PROFILE_ID =
  "openshell-v0-0-24-mxc-v0-7-0-rc1-qualification" as const;
export const MXC_OPENSHELL_V0_0_30_MXC_V0_8_0_ACCEPTED_PROFILE_ID =
  "openshell-v0-0-30-mxc-v0-8-0-accepted" as const;
export const MXC_OPENSHELL_V0_0_59_DEV_837_MR105_MXC_V0_8_0_QUALIFICATION_PROFILE_ID =
  "openshell-v0-0-59-dev-837-mr105-mxc-v0-8-0-qualification" as const;
export const MXC_OPENSHELL_V0_0_59_DEV_838_MR105_MXC_V0_8_0_QUALIFICATION_PROFILE_ID =
  "openshell-v0-0-59-dev-838-mr105-mxc-v0-8-0-qualification" as const;
export const MXC_OPENSHELL_V0_0_59_DEV_839_MR105_MXC_V0_8_0_QUALIFICATION_PROFILE_ID =
  "openshell-v0-0-59-dev-839-mr105-mxc-v0-8-0-qualification" as const;
export const MXC_OPENSHELL_V0_0_59_DEV_840_MR105_MXC_V0_7_0_RC1_QUALIFICATION_PROFILE_ID =
  "openshell-v0-0-59-dev-840-mr105-mxc-v0-7-0-rc1-qualification" as const;
export const MXC_OPENSHELL_V0_0_59_DEV_841_MR105_MXC_V0_7_0_RC1_QUALIFICATION_PROFILE_ID =
  "openshell-v0-0-59-dev-841-mr105-mxc-v0-7-0-rc1-qualification" as const;
export const MXC_OPENSHELL_V0_0_59_DEV_843_MR105_MXC_V0_7_0_RC1_QUALIFICATION_PROFILE_ID =
  "openshell-v0-0-59-dev-843-mr105-mxc-v0-7-0-rc1-qualification" as const;
export const MXC_OPENSHELL_V0_0_59_DEV_843_MR105_MXC_V0_8_0_QUALIFICATION_PROFILE_ID =
  "openshell-v0-0-59-dev-843-mr105-mxc-v0-8-0-qualification" as const;
export const MXC_OPENSHELL_V0_0_59_DEV_909_MR108_MXC_V0_8_0_QUALIFICATION_PROFILE_ID =
  "openshell-v0-0-59-dev-909-mr108-mxc-v0-8-0-qualification" as const;
export const MXC_OPENSHELL_V0_0_59_DEV_925_MR108_MXC_V0_8_0_QUALIFICATION_PROFILE_ID =
  "openshell-v0-0-59-dev-925-mr108-mxc-v0-8-0-qualification" as const;
export const MXC_OPENSHELL_V0_0_59_DEV_927_MR105_MXC_V0_8_0_QUALIFICATION_PROFILE_ID =
  "openshell-v0-0-59-dev-927-mr105-mxc-v0-8-0-qualification" as const;

const PROVIDER_ID = "mxc";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const REVISION_PATTERN = /^[a-f0-9]{7,64}$/u;
const VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+(?:[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const LOCAL_DRIVE_PATH_PATTERN = /^[A-Za-z]:\\/u;
const MAX_TEXT_BYTES = 4096;
const QUALIFICATION_AGENT_ENVIRONMENT_NAMES = [
  "COMSPEC",
  "NEMOCLAW_MXC_E2E_COMPAT_PRELOAD",
  "NEMOCLAW_MXC_E2E_DENY_PATH",
  "NEMOCLAW_MXC_E2E_ENTRY",
  "NEMOCLAW_MXC_E2E_HEARTBEAT_PATH",
  "NEMOCLAW_MXC_E2E_HOME",
  "NEMOCLAW_MXC_E2E_MOCK_PORT",
  "NEMOCLAW_MXC_E2E_NODE",
  "NEMOCLAW_MXC_E2E_OPENCLAW_PORT",
  "NEMOCLAW_MXC_E2E_OPENCLAW_PID_PATH",
  "NEMOCLAW_MXC_E2E_OPENCLAW_STATE_DIR",
  "NEMOCLAW_MXC_E2E_OUTCOME_PATH",
  "NEMOCLAW_MXC_E2E_READY_PATH",
  "NEMOCLAW_MXC_E2E_RESULT_PATH",
  "NEMOCLAW_MXC_E2E_STOP_PATH",
  "NEMOCLAW_MXC_E2E_TOKEN",
  "PATH",
  "SYSTEMROOT",
  "WINDIR",
] as const;

type ExactDistributionIdentity = {
  readonly version: string;
  readonly revision: string;
  readonly sha256: string;
};

type ExactComponentIdentity = {
  readonly cliSha256: string;
  readonly gatewaySha256: string;
  readonly wxcExecSha256: string;
};

type ExactGatewayIdentity = {
  readonly configSha256: string;
  readonly driver: "mxc";
  readonly backend: "process_container";
};

interface MxcOpenShellAttachmentExpectation {
  readonly distribution: ExactDistributionIdentity;
  readonly components: ExactComponentIdentity;
  readonly gateway: ExactGatewayIdentity;
}

export type MxcOpenShellDistributionAcceptance = "qualification" | "accepted";

export type MxcOpenShellDistributionProfileId =
  | typeof MXC_OPENSHELL_V0_0_24_MXC_V0_7_0_RC1_QUALIFICATION_PROFILE_ID
  | typeof MXC_OPENSHELL_V0_0_30_MXC_V0_8_0_ACCEPTED_PROFILE_ID
  | typeof MXC_OPENSHELL_V0_0_59_DEV_837_MR105_MXC_V0_8_0_QUALIFICATION_PROFILE_ID
  | typeof MXC_OPENSHELL_V0_0_59_DEV_838_MR105_MXC_V0_8_0_QUALIFICATION_PROFILE_ID
  | typeof MXC_OPENSHELL_V0_0_59_DEV_839_MR105_MXC_V0_8_0_QUALIFICATION_PROFILE_ID
  | typeof MXC_OPENSHELL_V0_0_59_DEV_840_MR105_MXC_V0_7_0_RC1_QUALIFICATION_PROFILE_ID
  | typeof MXC_OPENSHELL_V0_0_59_DEV_841_MR105_MXC_V0_7_0_RC1_QUALIFICATION_PROFILE_ID
  | typeof MXC_OPENSHELL_V0_0_59_DEV_843_MR105_MXC_V0_7_0_RC1_QUALIFICATION_PROFILE_ID
  | typeof MXC_OPENSHELL_V0_0_59_DEV_843_MR105_MXC_V0_8_0_QUALIFICATION_PROFILE_ID
  | typeof MXC_OPENSHELL_V0_0_59_DEV_909_MR108_MXC_V0_8_0_QUALIFICATION_PROFILE_ID
  | typeof MXC_OPENSHELL_V0_0_59_DEV_925_MR108_MXC_V0_8_0_QUALIFICATION_PROFILE_ID
  | typeof MXC_OPENSHELL_V0_0_59_DEV_927_MR105_MXC_V0_8_0_QUALIFICATION_PROFILE_ID;

export interface MxcOpenShellQualificationGatewayConfiguration {
  readonly content: string;
  readonly distributionAuthority: MxcOpenShellDistributionAuthority;
}

export interface MxcOpenShellAttachmentObservation extends MxcOpenShellAttachmentExpectation {
  readonly distributionRoot: string;
  readonly mxcRoot: string;
  readonly cliPath: string;
  readonly gatewayPath: string;
  readonly wxcExecPath: string;
  readonly gatewayConfigPath: string;
}

export interface MxcOpenShellAttachmentAuthority {
  readonly contractVersion: typeof MXC_OPENSHELL_ATTACHMENT_CONTRACT_VERSION;
  readonly providerId: "mxc";
  readonly mode: "attach-existing";
  readonly acceptance: MxcOpenShellDistributionAcceptance;
  readonly distributionProfileId: MxcOpenShellDistributionProfileId;
  readonly acceptedIdentitySha256: string;
  readonly nativeArchitecture: WindowsMxcQualifiedNativeArchitecture;
}

export interface MxcOpenShellDistributionAuthority {
  readonly contractVersion: typeof MXC_OPENSHELL_DISTRIBUTION_AUTHORITY_CONTRACT_VERSION;
  readonly providerId: "mxc";
  readonly profileId: MxcOpenShellDistributionProfileId;
  readonly acceptance: MxcOpenShellDistributionAcceptance;
  readonly acceptedIdentitySha256: string;
  readonly nativeArchitecture: WindowsMxcQualifiedNativeArchitecture;
}

export interface MxcOpenShellAttachmentReceipt {
  readonly contractVersion: typeof MXC_OPENSHELL_ATTACHMENT_CONTRACT_VERSION;
  readonly providerId: "mxc";
  readonly mode: "attach-existing";
  readonly acceptance: MxcOpenShellDistributionAcceptance;
  readonly distributionProfileId: MxcOpenShellDistributionProfileId;
  readonly authoritySha256: string;
  readonly distribution: ExactDistributionIdentity & { readonly root: string };
  readonly components: {
    readonly cli: { readonly path: string; readonly sha256: string };
    readonly gateway: { readonly path: string; readonly sha256: string };
    readonly wxcExec: {
      readonly root: string;
      readonly path: string;
      readonly sha256: string;
    };
  };
  readonly gateway: ExactGatewayIdentity & { readonly configPath: string };
}

export class MxcOpenShellAttachmentError extends Error {
  constructor(message: string) {
    super(`Invalid OpenShell MXC attachment: ${message}`);
    this.name = "MxcOpenShellAttachmentError";
  }
}

const ACCEPTED_IDENTITIES = new WeakMap<
  MxcOpenShellAttachmentAuthority,
  Readonly<{
    acceptance: MxcOpenShellDistributionAcceptance;
    distributionProfileId: MxcOpenShellAttachmentAuthority["distributionProfileId"];
    expectation: MxcOpenShellAttachmentExpectation;
  }>
>();

const DISTRIBUTION_AUTHORITIES = new WeakMap<
  MxcOpenShellDistributionAuthority,
  MxcOpenShellAttachmentAuthority
>();

/** Immutable development checkpoint supplied by the OpenShell/MXC team. */
export const MXC_OPENSHELL_V0_0_24_MXC_V0_7_0_RC1_QUALIFICATION_PROFILE = cloneAndDeepFreeze({
  profileId: MXC_OPENSHELL_V0_0_24_MXC_V0_7_0_RC1_QUALIFICATION_PROFILE_ID,
  acceptance: "qualification" as const,
  compatibility: {
    nativeArchitecture: "x64" as const,
    backend: "process_container" as const,
    mxcVersion: "0.7.0-rc1",
    networkMode: "local-network" as const,
  },
  expectation: {
    distribution: {
      version: "0.0.24",
      revision: "e1b48323e4efcb560900508bdcd76d2b5d216678",
      sha256: "296ba2677f8f692b1c3f14b4fae6bb2a75d52f94c071ec2ebdf676405a80613d",
    },
    components: {
      cliSha256: "23d00a88daa5f2aa6151d9112a6845e843ca1e08cbaf55f8eaa337b72dd9155a",
      gatewaySha256: "62b3e231f5d40c5d178d08172ddb65536f124bdb8c7c04d90fb9dca50a5ac137",
      wxcExecSha256: "6049c64723af1173c3739dc6cd6b2f33f6c021bb2832c4216233cba7f71aee9a",
    },
    gateway: {
      configSha256: "1c86a32a52d068677b5140975c6b870d5ed46dc553500ebb790b58e207ac7290",
      driver: "mxc" as const,
      backend: "process_container" as const,
    },
  },
});

/** Accepted Windows package supplied for the inactive MXC qualification gate. */
export const MXC_OPENSHELL_V0_0_30_MXC_V0_8_0_ACCEPTED_PROFILE = cloneAndDeepFreeze({
  profileId: MXC_OPENSHELL_V0_0_30_MXC_V0_8_0_ACCEPTED_PROFILE_ID,
  acceptance: "accepted" as const,
  compatibility: {
    nativeArchitecture: "x64" as const,
    backend: "process_container" as const,
    mxcVersion: "0.8.0",
    networkMode: "local-network" as const,
  },
  expectation: {
    distribution: {
      version: "0.0.30",
      revision: "c2e3e1357caa1b652b31601f385dc62e43387f27",
      sha256: "790768cc73f5befae7c9cb616342eb75582419fcbbbb1617d5e5c47482a7178d",
    },
    components: {
      cliSha256: "85c165d7516f386933b23b602c8a318880b267703e03a4de6758b858d650aa96",
      gatewaySha256: "ea32571e94f612ebee0261705226ee97a6ed5dd7c35a20fde0b8a741e99d06d7",
      wxcExecSha256: "6049c64723af1173c3739dc6cd6b2f33f6c021bb2832c4216233cba7f71aee9a",
    },
    gateway: {
      configSha256: "3516d19504a6154afcdba8d5e0ce4e81bfb4a5eab7d2ad57caae57a3ab3b89df",
      driver: "mxc" as const,
      backend: "process_container" as const,
    },
  },
});

/** Qualification-only developer package built from OpenShell GitLab MR !105. */
export const MXC_OPENSHELL_V0_0_59_DEV_837_MR105_MXC_V0_8_0_QUALIFICATION_PROFILE =
  cloneAndDeepFreeze({
    profileId: MXC_OPENSHELL_V0_0_59_DEV_837_MR105_MXC_V0_8_0_QUALIFICATION_PROFILE_ID,
    acceptance: "qualification" as const,
    compatibility: {
      nativeArchitecture: "x64" as const,
      backend: "process_container" as const,
      mxcVersion: "0.8.0",
      networkMode: "local-network" as const,
    },
    expectation: {
      distribution: {
        version: "0.0.59-dev.837+g0e92923f5",
        revision: "0e92923f531efb71a17f7706a48f29ada782eae8",
        sha256: "e96c02487f8067dd39c5bb5033ebcc12528f1e2f2df1985a328b3590d924101e",
      },
      components: {
        cliSha256: "d0f086f386e69d23127d019e0df88632273ac60cea1a1112f88d27637b475b63",
        gatewaySha256: "5571d6bc7365a82f6a30f757f801495709af757d886d685d0a1316f88edbc429",
        wxcExecSha256: "6049c64723af1173c3739dc6cd6b2f33f6c021bb2832c4216233cba7f71aee9a",
      },
      gateway: {
        configSha256: "3516d19504a6154afcdba8d5e0ce4e81bfb4a5eab7d2ad57caae57a3ab3b89df",
        driver: "mxc" as const,
        backend: "process_container" as const,
      },
    },
  });

/** Qualification-only developer package rebuilt from OpenShell GitLab MR !105. */
export const MXC_OPENSHELL_V0_0_59_DEV_838_MR105_MXC_V0_8_0_QUALIFICATION_PROFILE =
  cloneAndDeepFreeze({
    profileId: MXC_OPENSHELL_V0_0_59_DEV_838_MR105_MXC_V0_8_0_QUALIFICATION_PROFILE_ID,
    acceptance: "qualification" as const,
    compatibility: {
      nativeArchitecture: "x64" as const,
      backend: "process_container" as const,
      mxcVersion: "0.8.0",
      networkMode: "local-network" as const,
    },
    expectation: {
      distribution: {
        version: "0.0.59-dev.838+g4822b7a6",
        revision: "4822b7a6d6626341673a6c9511e7ff20ba9d9f4f",
        sha256: "b6023097c451b9b1e097bc81ef9376f2fddd15d8e12b3573956f8606b9f8d07b",
      },
      components: {
        cliSha256: "5a8b6f3a601306baacc5294ccc486eda26178d4f383f222c451750f5a144c21c",
        gatewaySha256: "05542ef4e178af8ef60108961a94d0f516d93d86052337b24fbf3f4fb3e88461",
        wxcExecSha256: "6049c64723af1173c3739dc6cd6b2f33f6c021bb2832c4216233cba7f71aee9a",
      },
      gateway: {
        configSha256: "3516d19504a6154afcdba8d5e0ce4e81bfb4a5eab7d2ad57caae57a3ab3b89df",
        driver: "mxc" as const,
        backend: "process_container" as const,
      },
    },
  });

/** Qualification-only developer package with the MR !105 host-reachable relay fix. */
export const MXC_OPENSHELL_V0_0_59_DEV_839_MR105_MXC_V0_8_0_QUALIFICATION_PROFILE =
  cloneAndDeepFreeze({
    profileId: MXC_OPENSHELL_V0_0_59_DEV_839_MR105_MXC_V0_8_0_QUALIFICATION_PROFILE_ID,
    acceptance: "qualification" as const,
    compatibility: {
      nativeArchitecture: "x64" as const,
      backend: "process_container" as const,
      mxcVersion: "0.8.0",
      networkMode: "local-network" as const,
    },
    expectation: {
      distribution: {
        version: "0.0.59-dev.839+g3ffdd8a3",
        revision: "3ffdd8a392c10d3b686e46f96c4939dd501292a2",
        sha256: "80c8aa5ed6f0a754d0aea4440216d6f4e98e7ff65c7e3c28ac11dc4f6be13161",
      },
      components: {
        cliSha256: "55ee662d2036efdcf622657250faef5a42a0c55fbcbca0ef2868807a2f9e2283",
        gatewaySha256: "dc687c3a643be902f105f46a78ac03162bede33c79af87bef9a91f3b3c0b24fb",
        wxcExecSha256: "6049c64723af1173c3739dc6cd6b2f33f6c021bb2832c4216233cba7f71aee9a",
      },
      gateway: {
        configSha256: "cafc36920c9caba0a1c540c00e91b3f8ecec95e02fbe7c30cf9ca6603fcb79a4",
        driver: "mxc" as const,
        backend: "process_container" as const,
      },
    },
  });

/** Qualification-only MR !105 package paired with the x64 MXC build verified by upstream. */
export const MXC_OPENSHELL_V0_0_59_DEV_840_MR105_MXC_V0_7_0_RC1_QUALIFICATION_PROFILE =
  cloneAndDeepFreeze({
    profileId: MXC_OPENSHELL_V0_0_59_DEV_840_MR105_MXC_V0_7_0_RC1_QUALIFICATION_PROFILE_ID,
    acceptance: "qualification" as const,
    compatibility: {
      nativeArchitecture: "x64" as const,
      backend: "process_container" as const,
      mxcVersion: "0.7.0-rc1",
      networkMode: "local-network" as const,
    },
    expectation: {
      distribution: {
        version: "0.0.59-dev.840+g51fad3f4",
        revision: "51fad3f49a594f23c00da992944420b8aad355bf",
        sha256: "79979cae3a2e3df4af65948f835813de02873146c131b9c1aaed523285fec2bb",
      },
      components: {
        cliSha256: "68ffcfdc514762fd0832185f80d975f32ba4c4fea39a65e979eba131345f6efc",
        gatewaySha256: "4f161d683f58a63848998b5d9c6698fd78b8f2325a490b16cb8ba9d4c3e00ea4",
        wxcExecSha256: "db0a3422be9e1b396cc1b2547c70ff16b27412438a31c10a45abf370cac86ae2",
      },
      gateway: {
        configSha256: "cafc36920c9caba0a1c540c00e91b3f8ecec95e02fbe7c30cf9ca6603fcb79a4",
        driver: "mxc" as const,
        backend: "process_container" as const,
      },
    },
  });

/** Qualification-only MR !105 package with the OpenClaw AppContainer compatibility fixes. */
export const MXC_OPENSHELL_V0_0_59_DEV_841_MR105_MXC_V0_7_0_RC1_QUALIFICATION_PROFILE =
  cloneAndDeepFreeze({
    profileId: MXC_OPENSHELL_V0_0_59_DEV_841_MR105_MXC_V0_7_0_RC1_QUALIFICATION_PROFILE_ID,
    acceptance: "qualification" as const,
    compatibility: {
      nativeArchitecture: "x64" as const,
      backend: "process_container" as const,
      mxcVersion: "0.7.0-rc1",
      networkMode: "local-network" as const,
    },
    expectation: {
      distribution: {
        version: "0.0.59-dev.841+g464d88fd9",
        revision: "464d88fd9ed333db5a66529e8451e94c10e0168d",
        sha256: "b7896f32108ee217bcd8a5529fb6e934ba89c20dba7644c087b1ad78d47f6816",
      },
      components: {
        cliSha256: "047ec27950c785f8ca80b4bbb41fb51700f7c7b34723744a883b917229afeb57",
        gatewaySha256: "44f90f9866cd52d66aed49dd5cc9c86d5bd0dbaaf6414861000da2891b6f517e",
        wxcExecSha256: "db0a3422be9e1b396cc1b2547c70ff16b27412438a31c10a45abf370cac86ae2",
      },
      gateway: {
        configSha256: "cafc36920c9caba0a1c540c00e91b3f8ecec95e02fbe7c30cf9ca6603fcb79a4",
        driver: "mxc" as const,
        backend: "process_container" as const,
      },
    },
  });

/** Qualification-only package from the current MR !105 head paired with the native N1X MXC build. */
export const MXC_OPENSHELL_V0_0_59_DEV_843_MR105_MXC_V0_7_0_RC1_QUALIFICATION_PROFILE =
  cloneAndDeepFreeze({
    profileId: MXC_OPENSHELL_V0_0_59_DEV_843_MR105_MXC_V0_7_0_RC1_QUALIFICATION_PROFILE_ID,
    acceptance: "qualification" as const,
    compatibility: {
      nativeArchitecture: "arm64" as const,
      backend: "process_container" as const,
      mxcVersion: "0.7.0-rc1",
      networkMode: "local-network" as const,
    },
    expectation: {
      distribution: {
        version: "0.0.59-dev.843+gd785dc8d8",
        revision: "d785dc8d86439b3289b0294829aaebd849d01f73",
        sha256: "d6f56305b3a72b66f46beab47e186182140fec6e10c0eab48a5e07a60bbac18b",
      },
      components: {
        cliSha256: "ec5bb29d106f6ac6288dace57012f33a3d402c64f7e88132b3d0b29268ddcdd8",
        gatewaySha256: "198b353025b6276347a9bf321e92c7614f1d61c7fea889fa6f0f2fcf2555dff0",
        wxcExecSha256: "e430d0e4f44f616e91db684f8d825a6dc93e06a1262b8d00bcaac7522a317aab",
      },
      gateway: {
        configSha256: "cafc36920c9caba0a1c540c00e91b3f8ecec95e02fbe7c30cf9ca6603fcb79a4",
        driver: "mxc" as const,
        backend: "process_container" as const,
      },
    },
  });

/** Qualification-only current MR !105 package paired with the native N1X MXC 0.8 build. */
export const MXC_OPENSHELL_V0_0_59_DEV_843_MR105_MXC_V0_8_0_QUALIFICATION_PROFILE =
  cloneAndDeepFreeze({
    profileId: MXC_OPENSHELL_V0_0_59_DEV_843_MR105_MXC_V0_8_0_QUALIFICATION_PROFILE_ID,
    acceptance: "qualification" as const,
    compatibility: {
      nativeArchitecture: "arm64" as const,
      backend: "process_container" as const,
      mxcVersion: "0.8.0",
      networkMode: "egress-proxy" as const,
    },
    expectation: {
      distribution: {
        version: "0.0.59-dev.843+gd785dc8d8",
        revision: "d785dc8d86439b3289b0294829aaebd849d01f73",
        sha256: "d6f56305b3a72b66f46beab47e186182140fec6e10c0eab48a5e07a60bbac18b",
      },
      components: {
        cliSha256: "ec5bb29d106f6ac6288dace57012f33a3d402c64f7e88132b3d0b29268ddcdd8",
        gatewaySha256: "198b353025b6276347a9bf321e92c7614f1d61c7fea889fa6f0f2fcf2555dff0",
        wxcExecSha256: "dde1c592270e9a659b01dccad70362da7b99fec114885fa4d625507aa775a503",
      },
      gateway: {
        configSha256: "cafc36920c9caba0a1c540c00e91b3f8ecec95e02fbe7c30cf9ca6603fcb79a4",
        driver: "mxc" as const,
        backend: "process_container" as const,
      },
    },
  });

/** Qualification-only MR !108 package with per-sandbox egress-proxy authentication. */
export const MXC_OPENSHELL_V0_0_59_DEV_909_MR108_MXC_V0_8_0_QUALIFICATION_PROFILE =
  cloneAndDeepFreeze({
    profileId: MXC_OPENSHELL_V0_0_59_DEV_909_MR108_MXC_V0_8_0_QUALIFICATION_PROFILE_ID,
    acceptance: "qualification" as const,
    compatibility: {
      nativeArchitecture: "arm64" as const,
      backend: "process_container" as const,
      mxcVersion: "0.8.0",
      networkMode: "egress-proxy" as const,
    },
    expectation: {
      distribution: {
        version: "0.0.59-dev.909+g0c1e7ba92",
        revision: "0c1e7ba92dde5e3a30c57e5e3729e182d67492de",
        sha256: "54ee15b29ea54a1723434c2c34f6846a3ff1f861cc0c444f92229911de3d3293",
      },
      components: {
        cliSha256: "4d1258f0634a6a684b12d147a2053e36d82df00c025f944da2350a0b5fab007c",
        gatewaySha256: "16700d57ecc8a6b566468040ab93944e694192e4be9d404362fa053da7b3bdca",
        wxcExecSha256: "dde1c592270e9a659b01dccad70362da7b99fec114885fa4d625507aa775a503",
      },
      gateway: {
        configSha256: "cafc36920c9caba0a1c540c00e91b3f8ecec95e02fbe7c30cf9ca6603fcb79a4",
        driver: "mxc" as const,
        backend: "process_container" as const,
      },
    },
  });

/** Qualification-only MR !108 package restacked after MR !98 merged into main. */
export const MXC_OPENSHELL_V0_0_59_DEV_925_MR108_MXC_V0_8_0_QUALIFICATION_PROFILE =
  cloneAndDeepFreeze({
    profileId: MXC_OPENSHELL_V0_0_59_DEV_925_MR108_MXC_V0_8_0_QUALIFICATION_PROFILE_ID,
    acceptance: "qualification" as const,
    compatibility: {
      nativeArchitecture: "arm64" as const,
      backend: "process_container" as const,
      mxcVersion: "0.8.0",
      networkMode: "egress-proxy" as const,
    },
    expectation: {
      distribution: {
        version: "0.0.59-dev.925+g28fc07191",
        revision: "28fc0719168dbc1698ee4701d6a7af2c19262be1",
        sha256: "6751269e91dc245163de6ee46c4b548aaaa46a89eee680b8a77a7042b5ee287d",
      },
      components: {
        cliSha256: "d742b5d9fe44a2a0008ceca02d810407f6f8499a49a804ef30e4a5c07f92ab02",
        gatewaySha256: "be9ba6118a969f91014312ffee5e77f6ffa07333d12f2771ae71edaf49d1bc2a",
        wxcExecSha256: "dde1c592270e9a659b01dccad70362da7b99fec114885fa4d625507aa775a503",
      },
      gateway: {
        configSha256: "cafc36920c9caba0a1c540c00e91b3f8ecec95e02fbe7c30cf9ca6603fcb79a4",
        driver: "mxc" as const,
        backend: "process_container" as const,
      },
    },
  });

/** Qualification-only MR !105 review fixes after merging MR !108. */
export const MXC_OPENSHELL_V0_0_59_DEV_927_MR105_MXC_V0_8_0_QUALIFICATION_PROFILE =
  cloneAndDeepFreeze({
    profileId: MXC_OPENSHELL_V0_0_59_DEV_927_MR105_MXC_V0_8_0_QUALIFICATION_PROFILE_ID,
    acceptance: "qualification" as const,
    compatibility: {
      nativeArchitecture: "arm64" as const,
      backend: "process_container" as const,
      mxcVersion: "0.8.0",
      networkMode: "egress-proxy" as const,
    },
    expectation: {
      distribution: {
        version: "0.0.59-dev.927+g01053b261",
        revision: "01053b261ab38f5a9458f331009a374805fe28ec",
        sha256: "21f216568f4884a5bcfedf43620dde64455c21e88c7d012a99bc4c9fafcb93d9",
      },
      components: {
        cliSha256: "459f4cb5fabbb2bdb52e3d3d8f1690cdf9ed2e854e2c84182d5c9088ff19dfd1",
        gatewaySha256: "f8c35961f08290282ef18b3fb2c59bc8ec43c328e9e411e8afc83300b65a4bff",
        wxcExecSha256: "dde1c592270e9a659b01dccad70362da7b99fec114885fa4d625507aa775a503",
      },
      gateway: {
        configSha256: "cafc36920c9caba0a1c540c00e91b3f8ecec95e02fbe7c30cf9ca6603fcb79a4",
        driver: "mxc" as const,
        backend: "process_container" as const,
      },
    },
  });

const DISTRIBUTION_PROFILES = {
  [MXC_OPENSHELL_V0_0_24_MXC_V0_7_0_RC1_QUALIFICATION_PROFILE_ID]:
    MXC_OPENSHELL_V0_0_24_MXC_V0_7_0_RC1_QUALIFICATION_PROFILE,
  [MXC_OPENSHELL_V0_0_30_MXC_V0_8_0_ACCEPTED_PROFILE_ID]:
    MXC_OPENSHELL_V0_0_30_MXC_V0_8_0_ACCEPTED_PROFILE,
  [MXC_OPENSHELL_V0_0_59_DEV_837_MR105_MXC_V0_8_0_QUALIFICATION_PROFILE_ID]:
    MXC_OPENSHELL_V0_0_59_DEV_837_MR105_MXC_V0_8_0_QUALIFICATION_PROFILE,
  [MXC_OPENSHELL_V0_0_59_DEV_838_MR105_MXC_V0_8_0_QUALIFICATION_PROFILE_ID]:
    MXC_OPENSHELL_V0_0_59_DEV_838_MR105_MXC_V0_8_0_QUALIFICATION_PROFILE,
  [MXC_OPENSHELL_V0_0_59_DEV_839_MR105_MXC_V0_8_0_QUALIFICATION_PROFILE_ID]:
    MXC_OPENSHELL_V0_0_59_DEV_839_MR105_MXC_V0_8_0_QUALIFICATION_PROFILE,
  [MXC_OPENSHELL_V0_0_59_DEV_840_MR105_MXC_V0_7_0_RC1_QUALIFICATION_PROFILE_ID]:
    MXC_OPENSHELL_V0_0_59_DEV_840_MR105_MXC_V0_7_0_RC1_QUALIFICATION_PROFILE,
  [MXC_OPENSHELL_V0_0_59_DEV_841_MR105_MXC_V0_7_0_RC1_QUALIFICATION_PROFILE_ID]:
    MXC_OPENSHELL_V0_0_59_DEV_841_MR105_MXC_V0_7_0_RC1_QUALIFICATION_PROFILE,
  [MXC_OPENSHELL_V0_0_59_DEV_843_MR105_MXC_V0_7_0_RC1_QUALIFICATION_PROFILE_ID]:
    MXC_OPENSHELL_V0_0_59_DEV_843_MR105_MXC_V0_7_0_RC1_QUALIFICATION_PROFILE,
  [MXC_OPENSHELL_V0_0_59_DEV_843_MR105_MXC_V0_8_0_QUALIFICATION_PROFILE_ID]:
    MXC_OPENSHELL_V0_0_59_DEV_843_MR105_MXC_V0_8_0_QUALIFICATION_PROFILE,
  [MXC_OPENSHELL_V0_0_59_DEV_909_MR108_MXC_V0_8_0_QUALIFICATION_PROFILE_ID]:
    MXC_OPENSHELL_V0_0_59_DEV_909_MR108_MXC_V0_8_0_QUALIFICATION_PROFILE,
  [MXC_OPENSHELL_V0_0_59_DEV_925_MR108_MXC_V0_8_0_QUALIFICATION_PROFILE_ID]:
    MXC_OPENSHELL_V0_0_59_DEV_925_MR108_MXC_V0_8_0_QUALIFICATION_PROFILE,
  [MXC_OPENSHELL_V0_0_59_DEV_927_MR105_MXC_V0_8_0_QUALIFICATION_PROFILE_ID]:
    MXC_OPENSHELL_V0_0_59_DEV_927_MR105_MXC_V0_8_0_QUALIFICATION_PROFILE,
} as const;

function record(value: unknown, label: string): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw new MxcOpenShellAttachmentError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new MxcOpenShellAttachmentError(`${label} has unknown or missing fields`);
  }
}

function exactText(value: unknown, label: string, pattern: RegExp): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_TEXT_BYTES ||
    CONTROL_CHARACTER_PATTERN.test(value) ||
    !pattern.test(value)
  ) {
    throw new MxcOpenShellAttachmentError(`${label} is invalid`);
  }
  return value;
}

function sha256(value: unknown, label: string): string {
  return exactText(value, label, SHA256_PATTERN);
}

function canonicalWindowsPath(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > MAX_TEXT_BYTES ||
    CONTROL_CHARACTER_PATTERN.test(value) ||
    !LOCAL_DRIVE_PATH_PATTERN.test(value) ||
    !path.win32.isAbsolute(value) ||
    path.win32.normalize(value) !== value
  ) {
    throw new MxcOpenShellAttachmentError(
      `${label} must be a canonical absolute local-drive Windows path`,
    );
  }
  return value;
}

function parseDistribution(value: unknown, label: string): ExactDistributionIdentity {
  const input = record(value, label);
  exactKeys(input, ["revision", "sha256", "version"], label);
  return {
    version: exactText(input.version, `${label} version`, VERSION_PATTERN),
    revision: exactText(input.revision, `${label} revision`, REVISION_PATTERN),
    sha256: sha256(input.sha256, `${label} digest`),
  };
}

function parseComponents(value: unknown, label: string): ExactComponentIdentity {
  const input = record(value, label);
  exactKeys(input, ["cliSha256", "gatewaySha256", "wxcExecSha256"], label);
  return {
    cliSha256: sha256(input.cliSha256, `${label} CLI digest`),
    gatewaySha256: sha256(input.gatewaySha256, `${label} gateway digest`),
    wxcExecSha256: sha256(input.wxcExecSha256, `${label} wxc-exec digest`),
  };
}

function parseGateway(value: unknown, label: string): ExactGatewayIdentity {
  const input = record(value, label);
  exactKeys(input, ["backend", "configSha256", "driver"], label);
  if (input.driver !== "mxc") {
    throw new MxcOpenShellAttachmentError(`${label} driver must be 'mxc'`);
  }
  if (input.backend !== "process_container") {
    throw new MxcOpenShellAttachmentError(`${label} backend must be 'process_container'`);
  }
  return {
    configSha256: sha256(input.configSha256, `${label} config digest`),
    driver: "mxc",
    backend: "process_container",
  };
}

function parseExpectation(value: unknown, label: string): MxcOpenShellAttachmentExpectation {
  const input = record(value, label);
  exactKeys(input, ["components", "distribution", "gateway"], label);
  return {
    distribution: parseDistribution(input.distribution, `${label} distribution`),
    components: parseComponents(input.components, `${label} components`),
    gateway: parseGateway(input.gateway, `${label} gateway`),
  };
}

function pathWithin(root: string, candidate: string): boolean {
  const relative = path.win32.relative(root, candidate);
  return (
    relative.length > 0 &&
    !path.win32.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith(`..${path.win32.sep}`)
  );
}

function tomlWindowsPath(value: string): string {
  return JSON.stringify(value.replaceAll("\\", "/"));
}

function parseObservation(value: unknown): MxcOpenShellAttachmentObservation {
  const input = record(value, "observed attachment");
  exactKeys(
    input,
    [
      "cliPath",
      "components",
      "distribution",
      "distributionRoot",
      "gateway",
      "gatewayConfigPath",
      "gatewayPath",
      "mxcRoot",
      "wxcExecPath",
    ],
    "observed attachment",
  );
  const identity = {
    distribution: parseDistribution(input.distribution, "observed attachment distribution"),
    components: parseComponents(input.components, "observed attachment components"),
    gateway: parseGateway(input.gateway, "observed attachment gateway"),
  };
  const distributionRoot = canonicalWindowsPath(input.distributionRoot, "distribution root");
  const mxcRoot = canonicalWindowsPath(input.mxcRoot, "MXC root");
  const cliPath = canonicalWindowsPath(input.cliPath, "OpenShell CLI path");
  const gatewayPath = canonicalWindowsPath(input.gatewayPath, "OpenShell gateway path");
  const wxcExecPath = canonicalWindowsPath(input.wxcExecPath, "wxc-exec path");
  const gatewayConfigPath = canonicalWindowsPath(
    input.gatewayConfigPath,
    "OpenShell gateway config path",
  );
  for (const [label, candidate] of [
    ["OpenShell CLI", cliPath],
    ["OpenShell gateway", gatewayPath],
  ] as const) {
    if (!pathWithin(distributionRoot, candidate)) {
      throw new MxcOpenShellAttachmentError(
        `${label} path must remain inside the observed distribution root`,
      );
    }
  }
  if (!pathWithin(mxcRoot, wxcExecPath)) {
    throw new MxcOpenShellAttachmentError("wxc-exec path must remain inside the observed MXC root");
  }
  return {
    ...identity,
    distributionRoot,
    mxcRoot,
    cliPath,
    gatewayPath,
    wxcExecPath,
    gatewayConfigPath,
  };
}

function sameIdentity(
  expected: MxcOpenShellAttachmentExpectation,
  observed: MxcOpenShellAttachmentExpectation,
): boolean {
  return (
    JSON.stringify(expected.distribution) === JSON.stringify(observed.distribution) &&
    JSON.stringify(expected.components) === JSON.stringify(observed.components) &&
    JSON.stringify(expected.gateway) === JSON.stringify(observed.gateway)
  );
}

/**
 * Bind a provider-owned accepted identity to an opaque attachment authority.
 *
 * The caller must obtain the expectation from a trusted provider source, not
 * from the host observation that will be qualified against it.
 */
function createMxcOpenShellAttachmentAuthority(
  expectation: unknown,
  acceptance: MxcOpenShellDistributionAcceptance,
  distributionProfileId: MxcOpenShellAttachmentAuthority["distributionProfileId"],
  nativeArchitecture: WindowsMxcQualifiedNativeArchitecture,
): MxcOpenShellAttachmentAuthority {
  const accepted = cloneAndDeepFreeze(parseExpectation(expectation, "accepted attachment"));
  const acceptedIdentitySha256 = createHash("sha256")
    .update(
      JSON.stringify({
        contractVersion: MXC_OPENSHELL_ATTACHMENT_CONTRACT_VERSION,
        providerId: PROVIDER_ID,
        mode: "attach-existing",
        acceptance,
        distributionProfileId,
        nativeArchitecture,
        accepted,
      }),
      "utf8",
    )
    .digest("hex");
  const authority = Object.freeze({
    contractVersion: MXC_OPENSHELL_ATTACHMENT_CONTRACT_VERSION,
    providerId: PROVIDER_ID,
    mode: "attach-existing" as const,
    acceptance,
    distributionProfileId,
    acceptedIdentitySha256,
    nativeArchitecture,
  });
  ACCEPTED_IDENTITIES.set(
    authority,
    cloneAndDeepFreeze({
      acceptance,
      distributionProfileId,
      expectation: accepted,
    }),
  );
  return authority;
}

function createDistributionAuthority(
  profileId: MxcOpenShellDistributionAuthority["profileId"],
  acceptance: MxcOpenShellDistributionAcceptance,
  expectation: unknown,
  nativeArchitecture: WindowsMxcQualifiedNativeArchitecture,
): MxcOpenShellDistributionAuthority {
  const attachmentAuthority = createMxcOpenShellAttachmentAuthority(
    expectation,
    acceptance,
    profileId,
    nativeArchitecture,
  );
  const authority = Object.freeze({
    contractVersion: MXC_OPENSHELL_DISTRIBUTION_AUTHORITY_CONTRACT_VERSION,
    providerId: PROVIDER_ID,
    profileId,
    acceptance,
    acceptedIdentitySha256: attachmentAuthority.acceptedIdentitySha256,
    nativeArchitecture,
  });
  DISTRIBUTION_AUTHORITIES.set(authority, attachmentAuthority);
  return authority;
}

/**
 * Create qualification authority from one provider-owned immutable development checkpoint.
 *
 * Stable-release acceptance remains a separate record and decision. Host observations cannot add
 * or replace a record in this catalogue.
 */
export function createMxcOpenShellDistributionAuthority(
  profileId: MxcOpenShellDistributionProfileId,
): MxcOpenShellDistributionAuthority {
  if (!Object.hasOwn(DISTRIBUTION_PROFILES, profileId)) {
    throw new MxcOpenShellAttachmentError("distribution profile is not provider-owned");
  }
  const profile = DISTRIBUTION_PROFILES[profileId];
  return createDistributionAuthority(
    profile.profileId,
    profile.acceptance,
    profile.expectation,
    profile.compatibility.nativeArchitecture,
  );
}

/**
 * Render the only gateway configuration authorized for a provider-owned inactive
 * Windows qualification profile and bind its digest to an opaque authority.
 *
 * The caller supplies run-local paths and a loopback target port, but cannot
 * supply configuration text, security semantics, or an accepted digest.
 */
export function createMxcOpenShellQualificationGatewayConfiguration(
  inputValue: unknown,
): MxcOpenShellQualificationGatewayConfiguration {
  const input = record(inputValue, "qualification gateway configuration");
  exactKeys(
    input,
    [
      "agentPath",
      "distributionRevision",
      "distributionProfileId",
      "distributionVersion",
      "egressProxyPort",
      "relayPath",
      "shareDirectory",
      "targetPort",
      "wxcExecPath",
    ],
    "qualification gateway configuration",
  );
  const distributionVersion = exactText(
    input.distributionVersion,
    "qualification distribution version",
    VERSION_PATTERN,
  );
  const distributionRevision = exactText(
    input.distributionRevision,
    "qualification distribution revision",
    REVISION_PATTERN,
  );
  if (
    typeof input.distributionProfileId !== "string" ||
    !Object.hasOwn(DISTRIBUTION_PROFILES, input.distributionProfileId)
  ) {
    throw new MxcOpenShellAttachmentError(
      "qualification distribution profile is not provider-owned",
    );
  }
  const distributionProfileId = input.distributionProfileId as MxcOpenShellDistributionProfileId;
  const profile = DISTRIBUTION_PROFILES[distributionProfileId];
  if (
    profile.expectation.distribution.version !== distributionVersion ||
    profile.expectation.distribution.revision !== distributionRevision
  ) {
    throw new MxcOpenShellAttachmentError(
      "qualification distribution does not match the provider-owned profile",
    );
  }
  const agentPath = canonicalWindowsPath(input.agentPath, "qualification agent path");
  const relayPath = canonicalWindowsPath(input.relayPath, "qualification relay path");
  const shareDirectory = canonicalWindowsPath(
    input.shareDirectory,
    "qualification share directory",
  );
  const wxcExecPath = canonicalWindowsPath(input.wxcExecPath, "qualification wxc-exec path");
  if (!pathWithin(shareDirectory, relayPath)) {
    throw new MxcOpenShellAttachmentError(
      "qualification relay path must remain inside the qualification share directory",
    );
  }
  if (
    typeof input.targetPort !== "number" ||
    !Number.isSafeInteger(input.targetPort) ||
    input.targetPort < 1 ||
    input.targetPort > 65_535
  ) {
    throw new MxcOpenShellAttachmentError("qualification target port is invalid");
  }
  if (
    typeof input.egressProxyPort !== "number" ||
    !Number.isSafeInteger(input.egressProxyPort) ||
    input.egressProxyPort < 1 ||
    input.egressProxyPort > 65_535 ||
    input.egressProxyPort === input.targetPort
  ) {
    throw new MxcOpenShellAttachmentError("qualification egress proxy port is invalid");
  }

  const sandboxTempDirectory = path.win32.join(shareDirectory, "temp");
  const probeAgentPath = path.win32.join(shareDirectory, "probe-agent.mjs");
  const agentEnvironment = [
    ...QUALIFICATION_AGENT_ENVIRONMENT_NAMES,
    `LOCALAPPDATA=${path.win32.join(shareDirectory, "home", "AppData", "Local")}`,
    `TEMP=${sandboxTempDirectory}`,
    `TMP=${sandboxTempDirectory}`,
  ];
  const content = [
    "[openshell.drivers.mxc]",
    `wxc_exec_path = ${tomlWindowsPath(wxcExecPath)}`,
    'backend = "process_container"',
    'default_configuration_id = "composable"',
    `share_dir = ${tomlWindowsPath(shareDirectory)}`,
    `agent_cwd = ${tomlWindowsPath(shareDirectory)}`,
    "agent_command = [",
    `  ${tomlWindowsPath(agentPath)},`,
    `  ${tomlWindowsPath(probeAgentPath)},`,
    "]",
    "agent_env = [",
    ...agentEnvironment.map((value) => `  ${tomlWindowsPath(value)},`),
    "]",
    "pc_least_privilege = false",
    'pc_capabilities = ["privateNetworkClientServer"]',
    ...(profile.compatibility.networkMode === "egress-proxy"
      ? ["egress_proxy = true", `egress_proxy_addr = "127.0.0.1:${input.egressProxyPort}"`]
      : ["pc_allow_local_network = true"]),
    "pc_minimal_env = true",
    `pc_relay_spawner_path = ${tomlWindowsPath(relayPath)}`,
    `pc_relay_target_port = ${input.targetPort}`,
    "debug = false",
    "",
  ].join("\n");
  const expectation = {
    ...profile.expectation,
    gateway: {
      ...profile.expectation.gateway,
      configSha256: createHash("sha256").update(content, "utf8").digest("hex"),
    },
  };
  return Object.freeze({
    content,
    distributionAuthority: createDistributionAuthority(
      profile.profileId,
      profile.acceptance,
      expectation,
      profile.compatibility.nativeArchitecture,
    ),
  });
}

/** Resolve the opaque attachment capability carried by a provider-owned distribution authority. */
export function resolveMxcOpenShellDistributionAuthority(
  authority: MxcOpenShellDistributionAuthority,
): MxcOpenShellAttachmentAuthority {
  if (typeof authority !== "object" || authority === null) {
    throw new MxcOpenShellAttachmentError("distribution authority is not provider-owned");
  }
  const attachmentAuthority = DISTRIBUTION_AUTHORITIES.get(authority);
  if (!attachmentAuthority) {
    throw new MxcOpenShellAttachmentError("distribution authority is not provider-owned");
  }
  return attachmentAuthority;
}

function acceptedIdentity(authority: unknown): Readonly<{
  acceptance: MxcOpenShellDistributionAcceptance;
  distributionProfileId: MxcOpenShellAttachmentAuthority["distributionProfileId"];
  expectation: MxcOpenShellAttachmentExpectation;
}> {
  if (typeof authority !== "object" || authority === null) {
    throw new MxcOpenShellAttachmentError("accepted identity authority is not provider-owned");
  }
  const accepted = ACCEPTED_IDENTITIES.get(authority as MxcOpenShellAttachmentAuthority);
  if (!accepted) {
    throw new MxcOpenShellAttachmentError("accepted identity authority is not provider-owned");
  }
  return accepted;
}

/**
 * Bind a provider-owned accepted OpenShell identity to one observed Windows installation.
 *
 * The trusted host adapter must collect the observation without executing the
 * untrusted agent artifact. This function does not install, start, or replace a
 * gateway and does not authorize MXC activation.
 */
export function qualifyMxcOpenShellAttachment(
  authority: MxcOpenShellAttachmentAuthority,
  observation: unknown,
): MxcOpenShellAttachmentReceipt {
  const accepted = acceptedIdentity(authority);
  const observed = parseObservation(observation);
  if (!sameIdentity(accepted.expectation, observed)) {
    throw new MxcOpenShellAttachmentError(
      "observed distribution identity does not match the accepted identity",
    );
  }
  const receiptIdentity = {
    contractVersion: MXC_OPENSHELL_ATTACHMENT_CONTRACT_VERSION,
    providerId: PROVIDER_ID,
    mode: "attach-existing" as const,
    acceptance: accepted.acceptance,
    distributionProfileId: accepted.distributionProfileId,
    distribution: { ...observed.distribution, root: observed.distributionRoot },
    components: {
      cli: { path: observed.cliPath, sha256: observed.components.cliSha256 },
      gateway: {
        path: observed.gatewayPath,
        sha256: observed.components.gatewaySha256,
      },
      wxcExec: {
        root: observed.mxcRoot,
        path: observed.wxcExecPath,
        sha256: observed.components.wxcExecSha256,
      },
    },
    gateway: {
      ...observed.gateway,
      configPath: observed.gatewayConfigPath,
    },
  } as const;
  const authoritySha256 = createHash("sha256")
    .update(JSON.stringify(receiptIdentity), "utf8")
    .digest("hex");
  return cloneAndDeepFreeze({ ...receiptIdentity, authoritySha256 });
}
