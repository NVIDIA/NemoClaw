// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const E2E_ACTION_PROVENANCE = {
  prepareWorkspace: {
    reference:
      "NVIDIA/NemoClaw/.github/actions/prepare-e2e@f6304bc25fc35bfaa441c8c2fbfee38f72805a75",
    contentSha256: "1283c2eadfbc38ccb3b795684ba5ced9c89ae2040fffbb6b81854a9d1926802b",
  },
  nativePodmanRuntime: {
    reference:
      "NVIDIA/NemoClaw/.github/actions/setup-native-podman-e2e@c87144de2c8e2d90b14cf11b31718846e32c65de",
    contentSha256: "ea633b602a0c44f19cdb4c4e4ca28c9b22732e848c34edd871c148675da83349",
  },
  stageNativePodmanToolchains: {
    reference:
      "NVIDIA/NemoClaw/.github/actions/stage-native-podman-e2e-toolchains@1a0f53d5d7e5420556be72b50d79ed5a333d637d",
    contentSha256: "e6be7f926407795a2575a6dac8dc8b61738c9f19f7dd09ff6e52dff50ec2140f",
  },
  restoreCliArtifact: {
    reference:
      "NVIDIA/NemoClaw/.github/actions/restore-e2e-cli-artifact@17759906bd7f80319c58af759dd60cfb893109bf",
    contentSha256: "4a6a6b21993e579855916dfb897995a3f35dc4461d04666094af7eddb8676077",
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
  prepareNoBuild: ["llama-cpp-dgx-spark-qualification", "managed-image-multiarch-startup"],
  prepareTrustedBuild: ["managed-image-protected-runtime"],
} as const;
