// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const E2E_ACTION_PROVENANCE = {
  reviewedNpmSetup: {
    reference:
      "NVIDIA/NemoClaw/.github/actions/setup-reviewed-npm@98669f24d35f18e49b6b2769cd68709509ea24f2",
  },
  prepareWorkspace: {
    reference:
      "NVIDIA/NemoClaw/.github/actions/prepare-e2e@afffe9cdedd168bfd7116c53846ddffe32eadd4c",
    contentSha256: "4458b3491e5e01097db99a212c4a7bf5ae0cc62cdeda7fef8e3862ed572d2c2b",
  },
  nativePodmanRuntime: {
    reference:
      "NVIDIA/NemoClaw/.github/actions/setup-native-podman-e2e@22789bcaf835db7cf6390781c8d0f454f1e73dec",
    contentSha256: "71b047434bb457bd0e7f7d1b8dec9c5c803f2e74de3cdc92381652dbd77d82c8",
  },
  restoreNativePodmanRuntime: {
    reference:
      "NVIDIA/NemoClaw/.github/actions/restore-native-podman-e2e@9650336899bf836db5844381a97cbc2b0fe4a2b8",
    contentSha256: "8a1f5ef5b8ecb170b65aa8c1bac1a6aee148375f39711a61c64186e54e60e4be",
  },
  stageNativePodmanToolchains: {
    reference:
      "NVIDIA/NemoClaw/.github/actions/stage-native-podman-e2e-toolchains@dfb7fb7c0ae86b2926ec6e896bec72bacd9b23a2",
    contentSha256: "60e4a4e39c06c9de3c2e64caaafcb232e0742c5a9afa7a9b472a9ee086123897",
  },
  restoreCliArtifact: {
    reference:
      "NVIDIA/NemoClaw/.github/actions/restore-e2e-cli-artifact@b1494a0828a80a8d5dc862effc9e85ac987f8b4a",
    contentSha256: "4a6a6b21993e579855916dfb897995a3f35dc4461d04666094af7eddb8676077",
  },
  reviewedSdkInstall: {
    reference:
      "NVIDIA/NemoClaw/.github/actions/install-reviewed-openshell-sdk@697af6ed24d88e7a8cbb0409acde3398e12f8eae",
    contentSha256: "09f77858c4025bdef9c3ffb184a53041c9be8cc87f7853c403f22ea70391228b",
  },
  uploadArtifacts: {
    reference:
      "NVIDIA/NemoClaw/.github/actions/upload-e2e-artifacts@7768e15eb90d3ee2d33432f481dfe8747e4f6d57",
    contentSha256: "8f6f71a0e6d71d85418fa88c2b26a4d601f568bdcaae20aca4085ae423c5044b",
  },
  dockerAuth: {
    reference:
      "NVIDIA/NemoClaw/.github/actions/docker-auth-setup@05fa6b810017752ab21148cb7e9d82d12a88c92f",
    actionSha256: "cf93dcbd19589a56d1d58225fd6b3f8ad2180705662ff79a3407f340b5dba4c0",
    scriptSha256: "f4c7ba1d7c3dc5e82bacfdb85c94ed0838251dfaa88a081b4f64fba4f744b6dc",
  },
  dockerCleanup: {
    reference:
      "NVIDIA/NemoClaw/.github/actions/docker-auth-cleanup@d5f37099766ca82a4516e7d8f0de117cda197fe3",
    actionSha256: "8b7bf4bdb793ddd27aa9bab2e38157e91f0401148f6ba684acb516fc75e8d367",
    scriptSha256: "4e5ce850c28f309b97695d61e11bcf1f154eae2b1d58c9697a3f49631c76abb4",
  },
  hostDependencies: {
    reference:
      "NVIDIA/NemoClaw/.github/actions/host-dependency-setup@d511d704980d651909b52b18ee42fad41a017b7d",
    actionSha256: "6eabd4f7f0d1eb0d3e1788323a0222173dc574f1f722c0ae302cacb268327154",
    scriptSha256: "13211c558ff3c7816fe3b3936a0d62f87c28ebd721b295f4571431d59cfcc04a",
  },
} as const;

export const E2E_JOB_POLICY = {
  cliArtifactProducer: "generate-matrix",
  prepareNoBuild: ["managed-image-multiarch-startup"],
  prepareTrustedBuild: ["managed-image-protected-runtime"],
} as const;
