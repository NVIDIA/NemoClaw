// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const E2E_ACTION_PROVENANCE = {
  prepareWorkspace: {
    reference:
      "NVIDIA/NemoClaw/.github/actions/prepare-e2e@f6304bc25fc35bfaa441c8c2fbfee38f72805a75",
    contentSha256: "1283c2eadfbc38ccb3b795684ba5ced9c89ae2040fffbb6b81854a9d1926802b",
  },
  restoreCliArtifact: {
    reference:
      "NVIDIA/NemoClaw/.github/actions/restore-e2e-cli-artifact@c246409193a31133cab10c8a3589001cc0d59eb3",
    contentSha256: "3a81ad631b839aa938eaaf1ad6777bab247204bf86fbca3c43c326a44dfb9c6c",
  },
  uploadArtifacts: {
    reference:
      "NVIDIA/NemoClaw/.github/actions/upload-e2e-artifacts@7768e15eb90d3ee2d33432f481dfe8747e4f6d57",
    contentSha256: "8f6f71a0e6d71d85418fa88c2b26a4d601f568bdcaae20aca4085ae423c5044b",
  },
  dockerAuth: {
    reference:
      "NVIDIA/NemoClaw/.github/actions/docker-auth-setup@78091da47e290f49b8fe3f3e70b72362a0853928",
    actionSha256: "cf93dcbd19589a56d1d58225fd6b3f8ad2180705662ff79a3407f340b5dba4c0",
    scriptSha256: "853a3f742f057c29ed465b63bed1ec8d8f306a1c046877a8556cadf290ef0cb6",
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
  prepareNoBuild: [
    "bootstrap-install-smoke",
    "llama-cpp-dgx-spark-qualification",
    "managed-image-multiarch-startup",
    "ollama-auth-proxy",
    "shields-config",
    "snapshot-commands",
    "spark-install",
    "whatsapp-qr-compact",
  ],
  prepareTrustedBuild: ["managed-image-protected-runtime"],
} as const;
