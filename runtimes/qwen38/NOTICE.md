<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Qwen3.8 Spark Runtime Sources and Notices

This artifact contains separately licensed components.
Original NemoClaw build and supervision code is Apache-2.0.
The recipe adaptations identified below use AGPL-3.0-or-later.
Its license does not replace the upstream licenses.

- The recipe is MiaAI Lab's `Qwen3.8-Flash-Next-Single-DGX-Spark`, revision
  `d03809008834124e80223c3482f2ddb59577a48f`, copyright 2026 MiaAI Lab,
  AGPL-3.0-or-later. The complete pinned source archive, extracted source, and
  license are under `/opt/nemoclaw/source/recipe*`. This includes the launcher,
  downloader, preparation tools, patches, watchdog, and their attribution notices.
- The recipe's QSA patch credits the Apache-2.0 FP8 KV approach from
  `lancelind/qwen3.8-Flash-DGX`. Its PLE patch identifies the upstream vLLM work it
  ports. Those notices remain in the original patch sources.
- vLLM and the runtime's dependencies retain the licenses and notices in the
  pinned base image. Original vLLM files and their patched versions are retained
  under the recipe's `files` directory. `patched-files.json` records their hashes.
- The model snapshot is `Mia-AiLab/Qwen3.8-Flash-Next-NVFP4` revision
  `925d7be6c14c6c9442ef83e8f05b5a3c39304f69`. Its model card declares Apache-2.0
  and credits `local-inference-lab/Qwen3.8-Flash-Next-NVFP4` and the Qwen base model.
  The complete snapshot, including that card, is retained in persistent storage.

## Recipe Adaptations

The upstream project is [MiaAI Lab's single-Spark recipe](https://github.com/MiaAI-Lab/Qwen3.8-Flash-Next-Single-DGX-Spark/tree/d03809008834124e80223c3482f2ddb59577a48f).
Its copyright notice is `Copyright (C) 2026 MiaAI Lab (https://x.com/MiaAI_lab)`.
NVIDIA notices identify NemoClaw contributions; they do not replace upstream ownership or license terms.

| File | Origin and changes | License |
| --- | --- | --- |
| `verify_packed.py` | Adapted from `files/build_ple_packed_table.py` on 2026-09-11. Verifies tensor shape, size, snapshot identity, and every packed row, then emits a hash. | AGPL-3.0-or-later |
| `apply_patches.py` | Adapts `start.sh` patch installation and the `files/patch_ple_offload.py` worker patch. On 2026-09-11, added immutable input checks, source retention, and rejection of a missing packed PLE table. | AGPL-3.0-or-later |
| `prepare.py`, `verify.py` | NemoClaw JSON protocol adapters that invoke the separately licensed preparation and verification programs as subprocesses. | Apache-2.0 |
| `test_prepare.py`, `test_attribution.py`, `crates/nemoclaw-e2e/fixtures/spark_preparation.py` | NemoClaw tests of recovery, generated notices, and the upstream packed-table format. | Apache-2.0 |

The adaptation headers were corrected on 2026-09-15.
The same change makes generated vLLM files carry MiaAI Lab attribution, a patch-source reference, and a dated modification notice.
Original vLLM copyright and Apache-2.0 license notices remain unchanged.
The pinned upstream [README license scope](https://github.com/MiaAI-Lab/Qwen3.8-Flash-Next-Single-DGX-Spark/blob/d03809008834124e80223c3482f2ddb59577a48f/README.md#what-the-license-does-and-does-not-cover) explicitly keeps generated vLLM files under Apache-2.0.
The patch generators remain AGPL-3.0-or-later; their generated outputs use Apache-2.0.

| Generated file under `recipe/files/` | Upstream patch under `recipe/files/` |
| --- | --- |
| `ple_layer_patched.py` | `patch_ple_layer.py` |
| `modelopt_patched.py` | `patch_modelopt_mxfp8.py` |
| `qsa_ops_patched.py`, `qsa_nvidia_patched.py` | `patch_qsa_fp8_kv.py` |
| `mtp_patched.py` | `patch_mtp_draft_vocab.py` |
| `ple_offload/ple_offload_layer.py`, `ple_offload/connector.py`, `ple_offload/worker.py`, `ple_offload/protocol.py` | `patch_ple_offload.py` |

The installed vLLM files contain the same notices as their retained generated sources.
The original `.orig` files and upstream archive remain unchanged.
The recipe's generated draft vocabulary, `files/draft_vocab_en_code_47k.txt`, stays with its upstream archive and `build_draft_vocab.py` provenance.

## Related NemoClaw Code

MiaAI Lab's `files/memwatch.sh` informed the available/free-memory thresholds and free-memory gate in `crates/nemoclaw-sdk/src/hardware/mod.rs`.
NemoClaw uses one combined pressure counter and a latched stop; upstream uses two counters and stops a Docker container.
`hardware/capacity.rs`, `config/constraints.rs`, and `backends/vllm.rs` use the recipe's host-reserve and serving-budget guidance.
`examples/spark-inline.yaml` records model settings informed by `start.sh`.
These Rust implementations and configuration values remain Apache-2.0; this credit identifies the source of their operational policy.
The snapshot downloader, recipe protocol, supervisor lifecycle, and preparation receipts are NemoClaw implementations.
Calling a recipe program does not replace that program's license with the caller's license.

## Retained Sources

The build recipe, original sources, modified sources, licenses, and immutable input pins remain available inside the image for inspection and source retrieval.
The build does not publish artifacts.

The supervisor and workspace source are retained in `/opt/nemoclaw/source/supervisor-source.tar.gz`.
The archive includes `Cargo.lock`, vendored dependencies with their original licenses, OpenShell protobuf build inputs and license, and Cargo source replacement configuration.
The supervisor is compiled offline from that exact archive.
`supervisor.json` records the compiler version, source version, binary hash, and archive hash.

Building requires the pinned Rust toolchain, Protocol Buffers compiler, and a native C build toolchain.

These corrections apply to newly built artifacts; they do not alter previously built images or historical validation records.
Retaining source and attribution does not itself provide the remote-user source offer required by AGPL section 13 for a modified network service.
Deployment and distribution obligations must also be satisfied.
