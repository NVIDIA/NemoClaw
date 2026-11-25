<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# llama.cpp Runtime Sources

This artifact extends llama.cpp's `server-cuda13-b12679` image, pinned by the multi-platform manifest digest in its Dockerfile.
That image is llama.cpp's daily build of release [b12679](https://github.com/ggml-org/llama.cpp/releases/tag/b12679), from source revision [`af5c58347fdbc2cd19e65b278e81c8f528f8a175`](https://github.com/ggml-org/llama.cpp/tree/af5c58347fdbc2cd19e65b278e81c8f528f8a175), with CUDA 13.5 on Ubuntu 24.04.
On both ARM64 and AMD64, its CUDA backend carries machine code for `sm_86`, `sm_89`, `sm_103` (GB300), `sm_120a`, and `sm_121a` (GB10), and PTX for `sm_75`, `sm_80`, and `sm_90`.
CUDA 13.5 needs NVIDIA driver 580 or newer.
[llama.cpp](https://github.com/ggml-org/llama.cpp) is distributed under its [MIT license](https://github.com/ggml-org/llama.cpp/blob/af5c58347fdbc2cd19e65b278e81c8f528f8a175/LICENSE).

The upstream image keeps no llama.cpp license, so the overlay retains these unmodified license files from that revision in `/opt/nemoclaw/source/`, downloaded with the SHA-256 that `versions.json` pins:

- `llama.cpp-LICENSE`: llama.cpp, MIT.
- `nlohmann-json-LICENSE`: nlohmann/json, MIT.
- `cpp-httplib-LICENSE`: cpp-httplib, MIT.
- `rotate-bits-LICENSE.md`: rotate-bits, MIT.
- `xxhash-LICENSE`: xxHash, BSD-2-Clause.

The other libraries llama.cpp compiles into the server, miniaudio, stb_image, subprocess.h, and the SHA-1 and SHA-256 code, state public-domain or MIT-0 terms in their sources.
Llama Chat, the web interface built into `llama-server`, also uses third-party code and assets.
The overlay retains these additional unmodified upstream files under `/opt/nemoclaw/source/`, with URLs and SHA-256 values pinned in `versions.json`:

- `llama-ui-big-integer-LICENSE`, `llama-ui-nerdamer-LICENSE`, and `llama-ui-decimal-js-LICENCE.md`: the MIT notices of big-integer, nerdamer, and decimal.js from the UI's vendored source at the llama.cpp revision above; the UI bundles all three into its math sandbox.
- `llama-brand-LICENSE` and `llama-brand-BRAND-USAGE.md`: the logo license and additional commercial redistribution permission from [ggml-org/llama-brand](https://github.com/ggml-org/llama-brand/tree/9e91eb167731ae69a3f2108b3b577b6baf32dede), the source of the marks used to identify llama.cpp in its UI.
- `llama-brand-css-LICENSE`: the MIT license of that brand's CSS, which the UI bundles.
- `llama-brand-fonts-OFL.txt`: the font copyright and SIL Open Font License 1.1 from that same brand revision. The UI bundles Llama Sans and Llama Mono from llama.cpp's copy in `ui/lib/ui/src/lib/assets/fonts`, whose `OFL.txt` is identical.

The UI lock pins `@ggml-org/llama-brand` 0.1.0 from npm, whose files match that brand revision.
The brand permission covers qualifying commercial redistribution to identify or refer to Llama.app and llama.cpp; it does not grant unrestricted trademark use or imply endorsement.
The overlay does not modify those assets.
`llama-ui-NOTICES.md` retains the license and notice texts of each npm package whose code the UI build bundles, as its source maps list them, and of the brand package, including the upstream notices that the rehype-katex and remark-math packages omit.
`llama-source.tar.gz` retains the unmodified llama.cpp source archive at the revision above, including the UI source, npm lockfile, engine source, build definitions, and upstream notices.
It does not vendor every external UI dependency or supply the source of the base image's operating-system and proprietary components.
Final bundle/source reconciliation remains part of [the image license review](../../internal-docs/contributing/image-licenses.md#remaining-release-evidence).
The overlay preserves the base image filesystem and doesn't replace its notices: the NVIDIA CUDA libraries under the CUDA EULA at `/usr/local/cuda-13.5/EULA.txt`, NVIDIA's container license at `/NGC-DL-CONTAINER-LICENSE`, and the Ubuntu packages' copyright files under `/usr/share/doc`.

The NemoClaw integration added on 2026-11-19 supplies the shared supervisor and selects it as the entrypoint.
It doesn't patch llama.cpp; `llama-server` stays at `/app/llama-server`.
The supervisor runs `llama-server` for a `llamaCpp` service.

The retained supervisor archive contains the exact Rust sources, vendored dependency sources and notices, and the build instructions used by this artifact.
`/opt/nemoclaw/source/rust-COPYRIGHT-library.html` retains the notices of the Rust standard library the supervisor links.
Live GPU inference qualification of this artifact remains TBD; an upstream image pin and successful build alone do not qualify a GPU or model.
