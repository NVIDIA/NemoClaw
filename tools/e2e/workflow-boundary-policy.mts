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
      "NVIDIA/NemoClaw/.github/actions/setup-native-podman-e2e@b39c9ee2bba1bffaabcfe97ae4a7787a5c603ee8",
    contentSha256: "85f2fd3760a2ccff1946c8aa1390156cd106b51bbd8596ce59d626def7b78de9",
  },
  restoreNativePodmanRuntime: {
    reference:
      "NVIDIA/NemoClaw/.github/actions/restore-native-podman-e2e@b39c9ee2bba1bffaabcfe97ae4a7787a5c603ee8",
    contentSha256: "17a7b3c8675897fcc2f4da62b83a47ecd43ad46c37f7c42948aa99775d917f76",
  },
  stageNativePodmanToolchains: {
    reference:
      "NVIDIA/NemoClaw/.github/actions/stage-native-podman-e2e-toolchains@8d7409d66a0e664829f9ddab177aa8460974291f",
    contentSha256: "4178d1938477d197033b5e73cca34417eb9b31302af3714a2a7c584c2b0f2810",
  },
  restoreCliArtifact: {
    reference:
      "NVIDIA/NemoClaw/.github/actions/restore-e2e-cli-artifact@4e9f579183477b984c009cce0f47a1361e5eddef",
    contentSha256: "4a6a6b21993e579855916dfb897995a3f35dc4461d04666094af7eddb8676077",
  },
  reviewedSdkInstall: {
    reference:
      "NVIDIA/NemoClaw/.github/actions/install-reviewed-openshell-sdk@f880dd17b871a9a9440aa8468b55e96a4541dfd6",
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
      "NVIDIA/NemoClaw/.github/actions/host-dependency-setup@4def1501b34ce586f83b91af50a66b5d22b31d75",
    actionSha256: "1ac05a0e0a0159fa0850eb82fccb0704d0e49b15bc6f2d6e3b6bb04c7ab94923",
    scriptSha256: "2e910ed80b5dcf9aaf94230371fe586376c46f6df8fcbd76229063cbda1852c8",
  },
} as const;

export const E2E_JOB_POLICY = {
  cliArtifactProducer: "generate-matrix",
  prepareNoBuild: ["managed-image-multiarch-startup"],
  prepareTrustedBuild: ["managed-image-protected-runtime"],
} as const;
