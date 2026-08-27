# NemoClaw sandbox image — OpenClaw + NemoClaw plugin inside OpenShell
#
# Layers PR-specific code (plugin, blueprint, config, startup script) on top
# of the pre-built base image from GHCR. The base image contains all the
# expensive, rarely-changing layers (apt, setpriv, users, openclaw CLI).
#
# For local builds without GHCR access, build the base first:
#   docker build -f Dockerfile.base -t ghcr.io/nvidia/nemoclaw/sandbox-base:latest .

# Global ARG — must be declared before the first FROM to be visible
# to all FROM directives. Can be overridden via --build-arg.
ARG BASE_IMAGE=ghcr.io/nvidia/nemoclaw/sandbox-base:latest
ARG NEMOCLAW_CORPORATE_CA_B64=
ARG NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION=0
ARG TARGETARCH
ARG CODEX_ACP_0_11_1_INTEGRITY=sha512-My2VSlBtvJipJhImHjFDej2ut/p00QqOISRnZgLgLrSIzjgvdcQvAhaZviWj7XPhk4UIdIb0OoA+Lrls824uiQ==
ARG CODEX_ACP_LINUX_AMD64_0_11_1_INTEGRITY=sha512-30vSoZuW1DP6Nuz24Gg3jgVC37IYe0bZ/Fgc5+372gc0h72NN4zHYAbu5bRd/gUJ9GdwABKrrEPCoFPlOTVTnQ==
ARG CODEX_ACP_LINUX_ARM64_0_11_1_INTEGRITY=sha512-I1f6WoSLbLlsWq4zH+vtwdoc4Y41mqRXPpSkfgIifxBw34QmWJmi37etZ7lKTYp6R+J/Z4PUN0rsmnsmKpBZTw==

# Stage 1: Build TypeScript plugin from source
FROM node:22-trixie-slim@sha256:db8a96a63e5264607ada2d206758876ebbed6a12be2ada7517793cbfb0c2a29c AS builder
ENV NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NODE_OPTIONS=--dns-result-order=ipv4first \
    NPM_CONFIG_MAXSOCKETS=4 \
    NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=1000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=20000 \
    NPM_CONFIG_FETCH_TIMEOUT=60000
COPY nemoclaw/package.json nemoclaw/package-lock.json nemoclaw/tsconfig.json /opt/nemoclaw/
COPY tools/mcp-tool-discovery-runtime/npm-ci-locked.sh /opt/nemoclaw-build-tools/npm-ci-locked.sh
COPY tools/mcp-tool-discovery-runtime/npm-cache-seed/ /opt/nemoclaw-build-tools/npm-cache-seed/
WORKDIR /opt/nemoclaw
RUN --network=default /opt/nemoclaw-build-tools/npm-ci-locked.sh \
    && rm -rf /opt/nemoclaw-build-tools/npm-cache-seed
COPY nemoclaw/src/ /opt/nemoclaw/src/
COPY scripts/checks/verify-openshell-policy-boundary-dependencies.mts /opt/nemoclaw-build-checks/
RUN npm run build \
    && node --experimental-strip-types \
        /opt/nemoclaw-build-checks/verify-openshell-policy-boundary-dependencies.mts \
        /opt/nemoclaw/dist/shared/openshell-policy-boundary.cjs

# Stage 2: Build TypeScript messaging runtime preloads.
FROM builder AS runtime-preload-builder
WORKDIR /opt/nemoclaw-root
COPY tsconfig.runtime-preloads.json /opt/nemoclaw-root/
COPY src/lib/messaging/channels/ /opt/nemoclaw-root/src/lib/messaging/channels/
RUN ln -s /opt/nemoclaw/node_modules /opt/nemoclaw-root/node_modules \
    && /opt/nemoclaw/node_modules/.bin/tsc -p tsconfig.runtime-preloads.json

# Copy the reviewed, CI-audited runtime artifacts without materializing an npm
# graph during image assembly. Protected rebuilds remain network-free and the
# final image still receives only the generated bundles.
FROM scratch AS mcp-tool-discovery-runtime
COPY tools/mcp-tool-discovery-runtime/reviewed-runtime-bundle/mcp-tool-discovery/BUNDLED_PACKAGES.json tools/mcp-tool-discovery-runtime/reviewed-runtime-bundle/mcp-tool-discovery/THIRD_PARTY_LICENSES.txt /opt/mcp-tool-discovery-runtime/dist/
COPY tools/mcp-tool-discovery-runtime/reviewed-runtime-bundle/mcp-tool-discovery/mcp-tool-discovery.bundle /opt/mcp-tool-discovery-runtime/dist/mcp-tool-discovery.mjs

FROM scratch AS managed-startup-runtime-builder
COPY tools/mcp-tool-discovery-runtime/reviewed-runtime-bundle/managed-startup-image-runtime.bundle /out/managed-startup-image-runtime.cjs

# Compile the bootstrap boundary on the target platform. The output is a
# freestanding static ELF; only its reviewed, non-executable Bash body remains
# interpreted at runtime after the native boundary has scrubbed process control.
FROM node:22-trixie@sha256:a566dd560283ae5615c8bb86b58fa8a1b6f3c82b492473a061672416266625da AS managed-bootstrap-entrypoint-builder
ARG TARGETARCH
WORKDIR /opt/nemoclaw-managed-bootstrap-build
COPY scripts/managed-bootstrap-entrypoint.c ./
COPY scripts/managed-bootstrap-trampoline.sh ./
# hadolint ignore=DL4006
RUN set -eu; \
    target_arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "$target_arch" in \
        amd64) expected_machine='Advanced Micro Devices X86-64' ;; \
        arm64) expected_machine='AArch64' ;; \
        *) echo "ERROR: unsupported managed bootstrap target architecture: $target_arch" >&2; exit 1 ;; \
    esac; \
    install -d -o root -g root -m 0755 /out/usr/local/bin /out/usr/local/lib/nemoclaw; \
    gcc \
        -std=c11 -O2 -Wall -Wextra -Werror \
        -DNEMOCLAW_MANAGED_BOOTSTRAP_FREESTANDING=1 \
        -ffreestanding -fno-asynchronous-unwind-tables -fno-builtin -fno-ident \
        -fno-pie -fno-stack-protector -fno-unwind-tables \
        -no-pie -nostdlib -static \
        -Wl,--build-id=none -Wl,-z,noexecstack \
        managed-bootstrap-entrypoint.c -o /tmp/nemoclaw-managed-bootstrap; \
    install -o root -g root -m 0755 \
        /tmp/nemoclaw-managed-bootstrap /out/usr/local/bin/nemoclaw-managed-bootstrap; \
    install -o root -g root -m 0444 \
        managed-bootstrap-trampoline.sh \
        /out/usr/local/lib/nemoclaw/managed-bootstrap-trampoline.sh; \
    binary=/out/usr/local/bin/nemoclaw-managed-bootstrap; \
    body=/out/usr/local/lib/nemoclaw/managed-bootstrap-trampoline.sh; \
    test -f "$binary" && test ! -L "$binary"; \
    test -f "$body" && test ! -L "$body"; \
    test "$(stat -c '%u:%g:%a' "$binary")" = '0:0:755'; \
    test "$(stat -c '%u:%g:%a' "$body")" = '0:0:444'; \
    /bin/bash -n "$body"; \
    test "$(readelf -hW "$binary" | sed -n 's/^[[:space:]]*Class:[[:space:]]*//p')" = 'ELF64'; \
    test "$(readelf -hW "$binary" | sed -n 's/^[[:space:]]*Type:[[:space:]]*//p')" = 'EXEC (Executable file)'; \
    test "$(readelf -hW "$binary" | sed -n 's/^[[:space:]]*Machine:[[:space:]]*//p')" = "$expected_machine"; \
    program_headers="$(readelf -lW "$binary")"; \
    case "$program_headers" in *INTERP*) echo 'ERROR: managed bootstrap ELF has an interpreter' >&2; exit 1 ;; esac; \
    readelf -dW "$binary" | grep -Fq 'There is no dynamic section'; \
    test -z "$(nm --undefined-only "$binary")"; \
    strings "$binary" | grep -Fq '/usr/local/bin/nemoclaw-managed-bootstrap'; \
    strings "$binary" | grep -Fq '/usr/local/lib/nemoclaw/managed-bootstrap-trampoline.sh'

# Fetch immutable reviewed archives outside RUN instructions. The protected
# GPU rebuild imports these checksum-addressed source records from the exact
# amd64 build cache, while every package-materialization RUN remains offline.
FROM scratch AS wechat-npm-archives

ADD --checksum=sha256:422ee96c2fca294d6d80c193c2797d2a046cb8b512b84b0705c85865f0251bb7 https://registry.npmjs.org/@tencent-weixin/openclaw-weixin/-/openclaw-weixin-2.4.3.tgz /openclaw-weixin-2.4.3.tgz
ADD --checksum=sha256:3a6260c4e0d80bd527a3f930e90ea2348c03646621f25aa0bd960ee205a0a706 https://registry.npmjs.org/qrcode-terminal/-/qrcode-terminal-0.12.0.tgz /qrcode-terminal-0.12.0.tgz
ADD --checksum=sha256:ee38f17f533fd500610685a483ae2f413c26f4eb33a51684314563c8d60f279c https://registry.npmjs.org/zod/-/zod-4.4.3.tgz /zod-4.4.3.tgz

FROM scratch AS codex-acp-common-archive

ADD --checksum=sha256:b287fe7bce0dc0b3d0c69400ab7d47567680439628ad22a89f0557cc736d64b8 https://registry.npmjs.org/@zed-industries/codex-acp/-/codex-acp-0.11.1.tgz /codex-acp.tgz

FROM scratch AS codex-acp-amd64-archive

ADD --checksum=sha256:051cc1c1b632797b65b574e31b3eebaa0b8795639a3080c93710b96755e62be3 https://registry.npmjs.org/@zed-industries/codex-acp-linux-x64/-/codex-acp-linux-x64-0.11.1.tgz /codex-acp-platform.tgz

FROM scratch AS codex-acp-arm64-archive

ADD --checksum=sha256:0ec75f1cd0bd6011b687d0aac25478f3123ffa81ec299281bcb1747dd3162e2a https://registry.npmjs.org/@zed-industries/codex-acp-linux-arm64/-/codex-acp-linux-arm64-0.11.1.tgz /codex-acp-platform.tgz

FROM scratch AS openclaw-optional-plugin-archives

ADD --chmod=0444 --checksum=sha256:a447a223cf4764865570e71e92fb5173bf79a3d8307dd99382eb56ea6aff93f6 https://registry.npmjs.org/@openclaw/diagnostics-otel/-/diagnostics-otel-2026.7.1.tgz /diagnostics-otel-2026.7.1.tgz
ADD --chmod=0444 --checksum=sha256:f5198ea18ea0adebc376c669b8e5e1100781f07ec2d9e24e86c90cb82acb039c https://registry.npmjs.org/@openclaw/brave-plugin/-/brave-plugin-2026.7.1.tgz /brave-plugin-2026.7.1.tgz
ADD --chmod=0444 --checksum=sha256:2ed6796c07bb15b8d98ff7ae178b94327d570dcbc9a99a81f3e12ecf938ded61 https://registry.npmjs.org/@opentelemetry/propagator-jaeger/-/propagator-jaeger-2.9.0.tgz /propagator-jaeger-2.9.0.tgz
ADD --chmod=0444 --checksum=sha256:b1b01eb1522aea8f652cc7b692d1c417195713deb12b348955e3ac8d608fc9ab https://registry.npmjs.org/@opentelemetry/core/-/core-2.9.0.tgz /core-2.9.0.tgz

# hadolint ignore=DL3006
FROM codex-acp-${TARGETARCH}-archive AS codex-acp-platform-archive

# Reviewed-archive invariants (#5896): checksum-addressed source archives,
# committed SRI verification, offline installation, and exact architecture.
FROM node:22-trixie-slim@sha256:db8a96a63e5264607ada2d206758876ebbed6a12be2ada7517793cbfb0c2a29c AS codex-acp-runtime
ARG TARGETARCH
ARG CODEX_ACP_0_11_1_INTEGRITY
ARG CODEX_ACP_LINUX_AMD64_0_11_1_INTEGRITY
ARG CODEX_ACP_LINUX_ARM64_0_11_1_INTEGRITY
COPY --from=codex-acp-common-archive /codex-acp.tgz /tmp/codex-acp/codex-acp.tgz
COPY --from=codex-acp-platform-archive /codex-acp-platform.tgz /tmp/codex-acp/codex-acp-platform.tgz
# hadolint ignore=DL4006,DL3016,SC2016
RUN --network=none set -eu; \
    case "$TARGETARCH" in \
      amd64) platform_integrity="$CODEX_ACP_LINUX_AMD64_0_11_1_INTEGRITY" ;; \
      arm64) platform_integrity="$CODEX_ACP_LINUX_ARM64_0_11_1_INTEGRITY" ;; \
      *) echo "ERROR: unsupported codex-acp target architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    node -e 'const fs=require("node:fs"); const crypto=require("node:crypto"); const actual="sha512-"+crypto.createHash("sha512").update(fs.readFileSync(process.argv[1])).digest("base64"); if(actual!==process.argv[2]) { console.error(`integrity mismatch for ${process.argv[1]}`); process.exit(1); }' \
      /tmp/codex-acp/codex-acp.tgz "$CODEX_ACP_0_11_1_INTEGRITY"; \
    node -e 'const fs=require("node:fs"); const crypto=require("node:crypto"); const actual="sha512-"+crypto.createHash("sha512").update(fs.readFileSync(process.argv[1])).digest("base64"); if(actual!==process.argv[2]) { console.error(`integrity mismatch for ${process.argv[1]}`); process.exit(1); }' \
      /tmp/codex-acp/codex-acp-platform.tgz "$platform_integrity"; \
    npm install -g --offline --no-audit --no-fund --no-progress --ignore-scripts \
      /tmp/codex-acp/codex-acp-platform.tgz /tmp/codex-acp/codex-acp.tgz; \
    rm -rf /tmp/codex-acp; \
    command -v codex-acp >/dev/null

FROM node:22-trixie-slim@sha256:db8a96a63e5264607ada2d206758876ebbed6a12be2ada7517793cbfb0c2a29c AS wechat-npm-cache
COPY agents/openclaw/wechat-runtime/package.json agents/openclaw/wechat-runtime/package-lock.json /opt/wechat-runtime/
COPY scripts/checks/materialize-locked-npm-cache-seed.mts /opt/checks/
COPY scripts/lib/reviewed-npm-archive.mts scripts/lib/seed-reviewed-npm-cache.mts /opt/nemoclaw-build-tools/
COPY --from=wechat-npm-archives / /opt/wechat-npm-archives/
RUN --network=none install -d -o root -g root -m 0755 /out/wechat-npm-cache \
    && node --experimental-strip-types /opt/nemoclaw-build-tools/seed-reviewed-npm-cache.mts \
        --lockfile /opt/wechat-runtime/package-lock.json \
        --cache /out/wechat-npm-cache \
        --registry-origin https://registry.npmjs.org/ \
        --archive @tencent-weixin/openclaw-weixin@2.4.3=/opt/wechat-npm-archives/openclaw-weixin-2.4.3.tgz \
        --archive qrcode-terminal@0.12.0=/opt/wechat-npm-archives/qrcode-terminal-0.12.0.tgz \
        --archive zod@4.4.3=/opt/wechat-npm-archives/zod-4.4.3.tgz \
    && NPM_CONFIG_OFFLINE=true npm ci --prefix /opt/wechat-runtime \
        --ignore-scripts --omit=dev --legacy-peer-deps \
        --userconfig /dev/null --registry https://registry.npmjs.org/ \
        --cache /out/wechat-npm-cache \
    && NPM_CONFIG_OFFLINE=true \
        node --experimental-strip-types /opt/nemoclaw-build-tools/reviewed-npm-archive.mts \
        --lockfile /opt/wechat-runtime/package-lock.json \
        --cache /out/wechat-npm-cache \
        --registry-origin https://registry.npmjs.org/ \
    && rm -rf /opt/wechat-runtime/node_modules \
    && chown -R root:root /out/wechat-npm-cache \
    && chmod -R a+rX,go-w /out/wechat-npm-cache

# Fetch every exact-lock messaging archive outside RUN instructions. BuildKit
# verifies the committed SHA-256 source pins before the selected architecture
# enters the cache stage; SHA-512 verification against package-lock.json and
# every package-materialization command then execute with networking disabled.
FROM scratch AS openclaw-managed-messaging-npm-common-archives-1

ADD --chmod=0444 --checksum=sha256:d98ffa76628ea162ddf7539b7b84ab851ef889689b16d454483456ba2e166d84 https://registry.npmjs.org/@azure/abort-controller/-/abort-controller-2.1.2.tgz /abort-controller-2.1.2.tgz
ADD --chmod=0444 --checksum=sha256:173d915f7d88df8cd4db2129a030c3b1c9cafd3b7aee5b89465bf3ad18372542 https://registry.npmjs.org/accepts/-/accepts-2.0.0.tgz /accepts-2.0.0.tgz
ADD --chmod=0444 --checksum=sha256:bc6da06f2a2e6bc80fa5878bd7227bd0318812976d45f47f17e1aafcec2be831 https://registry.npmjs.org/agent-base/-/agent-base-6.0.2.tgz /agent-base-6.0.2.tgz
ADD --chmod=0444 --checksum=sha256:7dd4a61668a9a4e8d4e903f1a254f94d53dafd3f316f2b9b597c5ad8c79cb57e https://registry.npmjs.org/agent-base/-/agent-base-7.1.4.tgz /agent-base-7.1.4.tgz
ADD --chmod=0444 --checksum=sha256:0041878b8209f2fa4bcc5e0666355ebc96ff97f360c3054ffe83dbb78ee1c119 https://registry.npmjs.org/@protobufjs/aspromise/-/aspromise-1.1.2.tgz /aspromise-1.1.2.tgz
ADD --chmod=0444 --checksum=sha256:f05a60581cd0c5e70a025fa51ae0cd699a7edf3db64043e69715d5cf79b35af8 https://registry.npmjs.org/async-mutex/-/async-mutex-0.5.0.tgz /async-mutex-0.5.0.tgz
ADD --chmod=0444 --checksum=sha256:8c254f30f70792645042e4d71f590ec49f8e386a475772f7430c73b964b57dcf https://registry.npmjs.org/asynckit/-/asynckit-0.4.0.tgz /asynckit-0.4.0.tgz
ADD --chmod=0444 --checksum=sha256:44749ee4b82d2b5fa66323af77c5b836c08368667015a9c8a966033801a56964 https://registry.npmjs.org/atomic-sleep/-/atomic-sleep-1.0.0.tgz /atomic-sleep-1.0.0.tgz
ADD --chmod=0444 --checksum=sha256:76b4890271f3a1882ceb7968362ae551687cc8244749371e399ff4112b5776fa https://registry.npmjs.org/audio-buffer/-/audio-buffer-5.0.0.tgz /audio-buffer-5.0.0.tgz
ADD --chmod=0444 --checksum=sha256:1c04c7be41a4124efa569cbfcf3807bd2b351924c17dee9cfb81721979b21b92 https://registry.npmjs.org/audio-decode/-/audio-decode-2.2.3.tgz /audio-decode-2.2.3.tgz
ADD --chmod=0444 --checksum=sha256:811be12f19eaf0f89c3cd3a219046cdf94e32cf54e866208eebf80aaf4f4c18f https://registry.npmjs.org/audio-type/-/audio-type-2.4.1.tgz /audio-type-2.4.1.tgz
ADD --chmod=0444 --checksum=sha256:1897a043ad06c9d96784dd729b30d6d16dc638e9feee987c6ce987c5dfddacd4 https://registry.npmjs.org/axios/-/axios-1.16.0.tgz /axios-1.16.0.tgz
ADD --chmod=0444 --checksum=sha256:5cd85fce29cbc3c1f2fafbad54721a6f27e76a32b5bfb5003b2c92393a8357cf https://registry.npmjs.org/axios/-/axios-1.18.0.tgz /axios-1.18.0.tgz
ADD --chmod=0444 --checksum=sha256:5967d7b471213ab39485b6dd5d24d0b8f1267a65fdb55cccc8a8500efb143933 https://registry.npmjs.org/baileys/-/baileys-7.0.0-rc13.tgz /baileys-7.0.0-rc13.tgz
ADD --chmod=0444 --checksum=sha256:d67e6ee6e1445512478cdfc34c12144f579bdd9f06529eef3ef8d88f84031a6a https://registry.npmjs.org/@protobufjs/base64/-/base64-1.1.2.tgz /base64-1.1.2.tgz
ADD --chmod=0444 --checksum=sha256:b1b7a945b52685269083425216d6597e33d97bf21699d656e92fdb3eb5210a85 https://registry.npmjs.org/base64-js/-/base64-js-1.5.1.tgz /base64-js-1.5.1.tgz
ADD --chmod=0444 --checksum=sha256:054607db65aa02c4f2d82d81a9a5c4d0d00386e2af77135893ea067a834ffb79 https://registry.npmjs.org/@keyv/bigmap/-/bigmap-1.3.1.tgz /bigmap-1.3.1.tgz
ADD --chmod=0444 --checksum=sha256:f5a943ea290e66f64cb9adaaed2ff1b7c4ee02a4cca9d709d9c9c6c222512e82 https://registry.npmjs.org/bignumber.js/-/bignumber.js-9.3.1.tgz /bignumber.js-9.3.1.tgz
ADD --chmod=0444 --checksum=sha256:7f4aa165d56b17dfc82500016f9f83ca6a7a3fa34fecc26bf036abe18a4f9211 https://registry.npmjs.org/@thi.ng/bitstream/-/bitstream-2.4.53.tgz /bitstream-2.4.53.tgz
ADD --chmod=0444 --checksum=sha256:031d7f6c5142e31be91d36a43f541f02a505943e3b871aa44ef5fb6939be258e https://registry.npmjs.org/body-parser/-/body-parser-2.3.0.tgz /body-parser-2.3.0.tgz
ADD --chmod=0444 --checksum=sha256:455afc51e720c29a70cece533ca7008e35dd122bf81dc8603f872d02a492f0de https://registry.npmjs.org/@slack/bolt/-/bolt-4.7.3.tgz /bolt-4.7.3.tgz
ADD --chmod=0444 --checksum=sha256:e29b7bf5e6c1bb5119ce74adbbf27cb55f5132435f16fa7aaa6788d0161d0269 https://registry.npmjs.org/@hapi/boom/-/boom-9.1.4.tgz /boom-9.1.4.tgz
ADD --chmod=0444 --checksum=sha256:8f455159e342103e7854ed6a4cc73edbab144d857917c88edefea862f09fe75a https://registry.npmjs.org/buffer-equal-constant-time/-/buffer-equal-constant-time-1.0.1.tgz /buffer-equal-constant-time-1.0.1.tgz
ADD --chmod=0444 --checksum=sha256:35e49d4240c91cbe4ca29926139feea848302e9eea317f31d9e81b972ce90911 https://registry.npmjs.org/bundle-name/-/bundle-name-4.1.0.tgz /bundle-name-4.1.0.tgz
ADD --chmod=0444 --checksum=sha256:835e37ad5a40da45eaed6e32d99847627a15b2a4671741182521fe48dee3c581 https://registry.npmjs.org/bytes/-/bytes-3.1.2.tgz /bytes-3.1.2.tgz
ADD --chmod=0444 --checksum=sha256:69a2c0e6d81c1a38c601bf34bf0935998823043a219a01401455d23e29377bab https://registry.npmjs.org/cacheable/-/cacheable-2.5.0.tgz /cacheable-2.5.0.tgz
ADD --chmod=0444 --checksum=sha256:073e9ff9dbabedf5c128020a677381e9f92c90188d118830b30a7656a7c37d2c https://registry.npmjs.org/call-bind-apply-helpers/-/call-bind-apply-helpers-1.0.2.tgz /call-bind-apply-helpers-1.0.2.tgz
ADD --chmod=0444 --checksum=sha256:32086f492fedf1b9b34811f2ee50ca2cca53da5c783f7cd5f939d3f1e86bbd32 https://registry.npmjs.org/call-bound/-/call-bound-1.0.4.tgz /call-bound-1.0.4.tgz
ADD --chmod=0444 --checksum=sha256:37cfcc258a77800d370b841e33cf19a18a3be6a990c0d1332ea3e01cb4ac4272 https://registry.npmjs.org/codec-parser/-/codec-parser-2.5.0.tgz /codec-parser-2.5.0.tgz
ADD --chmod=0444 --checksum=sha256:20bafed1221bcba23a2450a841998edaef9a56bc2101d6e38c2117dd58a13a01 https://registry.npmjs.org/@protobufjs/codegen/-/codegen-2.0.5.tgz /codegen-2.0.5.tgz
ADD --chmod=0444 --checksum=sha256:b6be5aabe53e90635beb77cd0e0ba7ae6a25c8cf903b15fcc342353e732e1512 https://registry.npmjs.org/combined-stream/-/combined-stream-1.0.8.tgz /combined-stream-1.0.8.tgz
ADD --chmod=0444 --checksum=sha256:052220a48a739f2de5419d35dd393ebd89b06ffa2b69f4e9cd6742bfd7c37070 https://registry.npmjs.org/@wasm-audio-decoders/common/-/common-9.0.7.tgz /common-9.0.7.tgz
ADD --chmod=0444 --checksum=sha256:2f8b1925a8b123a86606c11322fc10aafc1dd85f2860fffe32893e20aef4093c https://registry.npmjs.org/content-disposition/-/content-disposition-1.1.0.tgz /content-disposition-1.1.0.tgz
ADD --chmod=0444 --checksum=sha256:ac31d098405f0242dd712218f38a14a6202bd4eb01067db05db765d9a9bd12c8 https://registry.npmjs.org/content-type/-/content-type-1.0.5.tgz /content-type-1.0.5.tgz
ADD --chmod=0444 --checksum=sha256:a2d4689d44f4de2c2c5039f58e01279f2d4bb13994a5046de413e772a5a1bc06 https://registry.npmjs.org/content-type/-/content-type-2.0.0.tgz /content-type-2.0.0.tgz
ADD --chmod=0444 --checksum=sha256:76b160f8251c630a116a2e0acf03557b0758975b2c0df800607248fc9aae9e20 https://registry.npmjs.org/cookie/-/cookie-0.7.2.tgz /cookie-0.7.2.tgz
ADD --chmod=0444 --checksum=sha256:4d2bbaaf1c299e60ef0d7df952b52af95b20d56cbcbd4468d4210650083553d3 https://registry.npmjs.org/cookie-signature/-/cookie-signature-1.2.2.tgz /cookie-signature-1.2.2.tgz
ADD --chmod=0444 --checksum=sha256:e993cb3c4532e3bc165590d7bc0b99b47d5b2de843ce4ee0c106dc896e2402f5 https://registry.npmjs.org/@azure/core-auth/-/core-auth-1.10.1.tgz /core-auth-1.10.1.tgz
ADD --chmod=0444 --checksum=sha256:680a0a7867e926a1c9dd52c272d8cfc9b5d7e497fec4e89ab8733c41b6e9832d https://registry.npmjs.org/@azure/core-client/-/core-client-1.10.2.tgz /core-client-1.10.2.tgz
ADD --chmod=0444 --checksum=sha256:1ae445bd85dea54707e7bff73a437942e496fe286ac519e14d95b2c5b5c0ddde https://registry.npmjs.org/@azure/core-rest-pipeline/-/core-rest-pipeline-1.24.0.tgz /core-rest-pipeline-1.24.0.tgz
ADD --chmod=0444 --checksum=sha256:52f588b0f2efa667e863df855c1470253d32dc46fee3a33a7734edf210f33c2f https://registry.npmjs.org/@azure/core-tracing/-/core-tracing-1.3.1.tgz /core-tracing-1.3.1.tgz
ADD --chmod=0444 --checksum=sha256:a03d763406b766aee921955f2531a608658e03b82ce20f455f972560dffeafb1 https://registry.npmjs.org/@azure/core-util/-/core-util-1.13.1.tgz /core-util-1.13.1.tgz
ADD --chmod=0444 --checksum=sha256:32242124397140800e1238a252b4cd74669d58c81b655d9d3721789b56c1c1ff https://registry.npmjs.org/cors/-/cors-2.8.6.tgz /cors-2.8.6.tgz
ADD --chmod=0444 --checksum=sha256:eb81efb34061b1dc995374ded0e0ef0e9bd3bb4715be4029abed76193fefa38d https://registry.npmjs.org/curve25519-js/-/curve25519-js-0.0.4.tgz /curve25519-js-0.0.4.tgz
ADD --chmod=0444 --checksum=sha256:a5742b1b775d0b29fb562ff7e12f7ca19874e1c47322087b47a79230791642a1 https://registry.npmjs.org/data-uri-to-buffer/-/data-uri-to-buffer-4.0.1.tgz /data-uri-to-buffer-4.0.1.tgz
ADD --chmod=0444 --checksum=sha256:fe86bdcca1256437e5781f74784a143e526e62d281df0abc4e91c9cec2143ef2 https://registry.npmjs.org/@snazzah/davey/-/davey-0.1.12.tgz /davey-0.1.12.tgz
ADD --chmod=0444 --checksum=sha256:89c1ac9c946ee8905a875837114528e97eeae35e03be3190584b2216af43e4a7 https://registry.npmjs.org/debug/-/debug-4.4.3.tgz /debug-4.4.3.tgz
ADD --chmod=0444 --checksum=sha256:efe35ce84f4b4aad7d7125435562f3207a429353423c4643b4c982f5ea8612b7 https://registry.npmjs.org/default-browser/-/default-browser-5.5.0.tgz /default-browser-5.5.0.tgz
ADD --chmod=0444 --checksum=sha256:3c94fbe0d90b610de6dc068180c780cbb7ef0ade6d2f3a7b5401f99f215d7429 https://registry.npmjs.org/default-browser-id/-/default-browser-id-5.0.1.tgz /default-browser-id-5.0.1.tgz
ADD --chmod=0444 --checksum=sha256:bbe9fe67a229c64ff9b8c77ace12278e2d44048a2a5af96e5fc95abbc94c49b5 https://registry.npmjs.org/define-lazy-prop/-/define-lazy-prop-3.0.0.tgz /define-lazy-prop-3.0.0.tgz
ADD --chmod=0444 --checksum=sha256:ac38fce4217dfb1d772427c7d8d0d073e35ecd832915e97a61d9ab5c504129d3 https://registry.npmjs.org/delayed-stream/-/delayed-stream-1.0.0.tgz /delayed-stream-1.0.0.tgz
ADD --chmod=0444 --checksum=sha256:28a58a2056093441f1d00d677d95918d2e4b3e98bac86237159101cae315d4a7 https://registry.npmjs.org/depd/-/depd-2.0.0.tgz /depd-2.0.0.tgz
ADD --chmod=0444 --checksum=sha256:28f1511de04906def70f7ff6950cd2d26f52be0ec93c5efce8f5c07cb46bc521 https://registry.npmjs.org/@openclaw/discord/-/discord-2026.7.1.tgz /discord-2026.7.1.tgz
ADD --chmod=0444 --checksum=sha256:0184d637297b25e341758ef724387b9716dd1ee233ffa55d758fba0e0c990c7f https://registry.npmjs.org/discord-api-types/-/discord-api-types-0.38.49.tgz /discord-api-types-0.38.49.tgz
ADD --chmod=0444 --checksum=sha256:3675a81353c4150ec0659ba22d7df2e95bc330968ac08fa848cb269fc1d4fc8c https://registry.npmjs.org/@nolyfill/domexception/-/domexception-1.0.28.tgz /domexception-1.0.28.tgz
ADD --chmod=0444 --checksum=sha256:ed1342228c82c10df9921c59d684df516a0cd6ed25b61e5f9d6330895326cfdb https://registry.npmjs.org/dunder-proto/-/dunder-proto-1.0.1.tgz /dunder-proto-1.0.1.tgz
ADD --chmod=0444 --checksum=sha256:487cb94dff2414772c3bb648a5e4e41c03cbbcc64263d08a56e36d735fc848fe https://registry.npmjs.org/ecdsa-sig-formatter/-/ecdsa-sig-formatter-1.0.11.tgz /ecdsa-sig-formatter-1.0.11.tgz
ADD --chmod=0444 --checksum=sha256:5148e8eb7e222b2a09127618bbdb5033daf6262cfc735d3101ea98620128b99c https://registry.npmjs.org/ee-first/-/ee-first-1.1.1.tgz /ee-first-1.1.1.tgz
ADD --chmod=0444 --checksum=sha256:9b2e418b8851b8f9e7a13d5ada3bd4d3c5ef042885867261f556347d4bbefb29 https://registry.npmjs.org/encodeurl/-/encodeurl-2.0.0.tgz /encodeurl-2.0.0.tgz
ADD --chmod=0444 --checksum=sha256:1ac56a4d6d22fc5819f9db2998d425c1321a7c599af2e06e700cc28483f2d96d https://registry.npmjs.org/@thi.ng/errors/-/errors-2.6.15.tgz /errors-2.6.15.tgz
ADD --chmod=0444 --checksum=sha256:5986b8b13121340a8b0d5c7d8f0f961aa80ef3a74515ca9cb7a78d86ed0385f7 https://registry.npmjs.org/es-define-property/-/es-define-property-1.0.1.tgz /es-define-property-1.0.1.tgz
ADD --chmod=0444 --checksum=sha256:d14dd1c35b4bd3b8aca3219fd3627eb7f3eb49cf6b4c8a7ca58b91fd7a190993 https://registry.npmjs.org/es-errors/-/es-errors-1.3.0.tgz /es-errors-1.3.0.tgz
ADD --chmod=0444 --checksum=sha256:f295c5df6751c65b4b9492b03c88fab5e13419de28a51ecdf17e693b4a421af0 https://registry.npmjs.org/es-object-atoms/-/es-object-atoms-1.1.2.tgz /es-object-atoms-1.1.2.tgz
ADD --chmod=0444 --checksum=sha256:5675f51a5c33ee402bff8a2a341a0390f85e82d3c199859244d2f67091b0b93d https://registry.npmjs.org/es-set-tostringtag/-/es-set-tostringtag-2.1.0.tgz /es-set-tostringtag-2.1.0.tgz
ADD --chmod=0444 --checksum=sha256:a101155c3cbdfb1e4f98f2f83c8b5e392db6accfa606df0eba8b87a5762b0366 https://registry.npmjs.org/escape-html/-/escape-html-1.0.3.tgz /escape-html-1.0.3.tgz
ADD --chmod=0444 --checksum=sha256:f6a96c78a973d2ab660c9efeee6aa74a399cd9e770625ba1ed95e1aca9fd0faf https://registry.npmjs.org/etag/-/etag-1.8.1.tgz /etag-1.8.1.tgz
ADD --chmod=0444 --checksum=sha256:5536b98cb7062e771c1dadd1828e352ebe40034f1480836f21c776ec372a797c https://registry.npmjs.org/@protobufjs/eventemitter/-/eventemitter-1.1.1.tgz /eventemitter-1.1.1.tgz
ADD --chmod=0444 --checksum=sha256:703cdecfa6951d9ad258f615ab96895750add3cb2d95e3727837b78709975de8 https://registry.npmjs.org/eventemitter3/-/eventemitter3-4.0.7.tgz /eventemitter3-4.0.7.tgz
ADD --chmod=0444 --checksum=sha256:21d4a36175672b9e6640c39a68613af73f9a4c47a4a4da39993e8cd085564eb6 https://registry.npmjs.org/eventemitter3/-/eventemitter3-5.0.4.tgz /eventemitter3-5.0.4.tgz
ADD --chmod=0444 --checksum=sha256:1773a16c02b4422653479b9c4d211268f7022bdac0d817b5698535bb485dd005 https://registry.npmjs.org/express/-/express-5.2.1.tgz /express-5.2.1.tgz
ADD --chmod=0444 --checksum=sha256:1d91d0b0faa50cba223fa937c7b5a4a662968b1d78b3e59dca5c917dd5cf72b2 https://registry.npmjs.org/extend/-/extend-3.0.2.tgz /extend-3.0.2.tgz
ADD --chmod=0444 --checksum=sha256:54481d9c62debce1c38b0239f2358eeb3b73f7bb1ba3105bd6123fd81b8b7268 https://registry.npmjs.org/@protobufjs/fetch/-/fetch-1.1.1.tgz /fetch-1.1.1.tgz
ADD --chmod=0444 --checksum=sha256:4abf0d58a4977fce2240e08c280a2bc59f5363e9553a4f236cea6d74cce40c52 https://registry.npmjs.org/fetch-blob/-/fetch-blob-3.2.0.tgz /fetch-blob-3.2.0.tgz
ADD --chmod=0444 --checksum=sha256:87fdc6557e71ec47373edfbde774165e976c760845d02733f81fbfe1ad232780 https://registry.npmjs.org/file-type/-/file-type-22.0.1.tgz /file-type-22.0.1.tgz
ADD --chmod=0444 --checksum=sha256:22949bfc51a620b3598bbe67d65619a9efd781d52704a38d7ba675e248a8b872 https://registry.npmjs.org/finalhandler/-/finalhandler-2.1.1.tgz /finalhandler-2.1.1.tgz
ADD --chmod=0444 --checksum=sha256:ca8b00245b783f6f6f85e55b6df3d51be88ad74c4881a8ebf8e0796231352c5f https://registry.npmjs.org/@wasm-audio-decoders/flac/-/flac-0.2.10.tgz /flac-0.2.10.tgz
ADD --chmod=0444 --checksum=sha256:20b3d612d53281b754602d52a8e6a6e09032169d5399e515f6f5e8b7d3de712d https://registry.npmjs.org/@protobufjs/float/-/float-1.0.2.tgz /float-1.0.2.tgz
ADD --chmod=0444 --checksum=sha256:eba127bdabdf79d668187c7bac7123c136eee08930dd421416ba8a72613bae77 https://registry.npmjs.org/follow-redirects/-/follow-redirects-1.16.0.tgz /follow-redirects-1.16.0.tgz
ADD --chmod=0444 --checksum=sha256:de54fd307f6a0b4586ca67e6544f0dc63a17b87133a579a1fa223cafca0e64dd https://registry.npmjs.org/form-data/-/form-data-2.5.6.tgz /form-data-2.5.6.tgz
ADD --chmod=0444 --checksum=sha256:fc4d94e9b629f5378367ba46da7d96115696c01e25c99cd57c2c9a3d098bb557 https://registry.npmjs.org/form-data/-/form-data-4.0.6.tgz /form-data-4.0.6.tgz
ADD --chmod=0444 --checksum=sha256:1ff73b4138ea33f0fd0f41b67910409a2c8eb1b71a4cf1a4f8ab738a6e8487e9 https://registry.npmjs.org/formdata-polyfill/-/formdata-polyfill-4.0.10.tgz /formdata-polyfill-4.0.10.tgz
ADD --chmod=0444 --checksum=sha256:9b5a5de95fb85fcb58db5e4fcd94ce8ab9f0476d02202e20a5225cec60431c99 https://registry.npmjs.org/forwarded/-/forwarded-0.2.0.tgz /forwarded-0.2.0.tgz
ADD --chmod=0444 --checksum=sha256:ad08397ab05f62b2b507682e23aad699cf8cc33922e0030be0cb640a23277ad7 https://registry.npmjs.org/fresh/-/fresh-2.0.0.tgz /fresh-2.0.0.tgz
ADD --chmod=0444 --checksum=sha256:704402651b02a1454f17d445fc7dd716efc282d059407126d58ef30a47e807aa https://registry.npmjs.org/function-bind/-/function-bind-1.1.2.tgz /function-bind-1.1.2.tgz
ADD --chmod=0444 --checksum=sha256:8bef405e734a145716140d8dd9e3338f45e1bad7b751e45aea5490ac481fb7f8 https://registry.npmjs.org/gaxios/-/gaxios-7.1.5.tgz /gaxios-7.1.5.tgz
ADD --chmod=0444 --checksum=sha256:f9c3f2c868755c074152ecd291733c56c536678b0284c34c3613365bc730db94 https://registry.npmjs.org/gcp-metadata/-/gcp-metadata-8.1.2.tgz /gcp-metadata-8.1.2.tgz
ADD --chmod=0444 --checksum=sha256:662e27e54e00fe46fbb08f9f4aacb054e3695dbe72cc14b436613fbcfb780544 https://registry.npmjs.org/get-intrinsic/-/get-intrinsic-1.3.0.tgz /get-intrinsic-1.3.0.tgz
ADD --chmod=0444 --checksum=sha256:eb2cc52afb1f1fd82c5fc2a58c2380f0f16fdcdb5631538f3c66887435d70681 https://registry.npmjs.org/get-proto/-/get-proto-1.0.1.tgz /get-proto-1.0.1.tgz
ADD --chmod=0444 --checksum=sha256:38b6f95064454daf55a9e66c726a8189fe569357ca2a693a375e70a65501a02f https://registry.npmjs.org/google-auth-library/-/google-auth-library-10.9.0.tgz /google-auth-library-10.9.0.tgz

FROM scratch AS openclaw-managed-messaging-npm-common-archives-2

ADD --chmod=0444 --checksum=sha256:3a921c0d4e333f94be726fc2c0ce10025f8d87f8fae5affa01a52b2da7970bbd https://registry.npmjs.org/google-logging-utils/-/google-logging-utils-1.1.3.tgz /google-logging-utils-1.1.3.tgz
ADD --chmod=0444 --checksum=sha256:fe035c9489db54aa424fc60b5987d629fffa1bd28b81407c535ebeea958b767d https://registry.npmjs.org/@openclaw/googlechat/-/googlechat-2026.7.1.tgz /googlechat-2026.7.1.tgz
ADD --chmod=0444 --checksum=sha256:d536d0de4dd285dc1468fbb7f39334a47ee0eec9c27f9b626a6e71466c9fda82 https://registry.npmjs.org/gopd/-/gopd-1.2.0.tgz /gopd-1.2.0.tgz
ADD --chmod=0444 --checksum=sha256:4460c7532f28b8df2ddc9a1ec17816d43c24d4b9591dc6c5936b82f7f86ae7c5 https://registry.npmjs.org/has-symbols/-/has-symbols-1.1.0.tgz /has-symbols-1.1.0.tgz
ADD --chmod=0444 --checksum=sha256:dc1c74e3f1179a6271f84747d72c89f258aa46ad3e6464fae0e41737a7f0ef7b https://registry.npmjs.org/has-tostringtag/-/has-tostringtag-1.0.2.tgz /has-tostringtag-1.0.2.tgz
ADD --chmod=0444 --checksum=sha256:9a174c770b98d20b26e16a6563b37f79d53d3bcef6dadcf08507dd4993158d0f https://registry.npmjs.org/hashery/-/hashery-1.5.1.tgz /hashery-1.5.1.tgz
ADD --chmod=0444 --checksum=sha256:e9d2b03f95573600e1c13124ce618e3142ed2c538d164595bedcd4408b8a4e4c https://registry.npmjs.org/hasown/-/hasown-2.0.4.tgz /hasown-2.0.4.tgz
ADD --chmod=0444 --checksum=sha256:557ff1ff42d1ae2b5d73fda777d06d387ee17adf9e60dc179e975057c0af0066 https://registry.npmjs.org/@hapi/hoek/-/hoek-9.3.0.tgz /hoek-9.3.0.tgz
ADD --chmod=0444 --checksum=sha256:7f96a9aa7ee1230008083deecaf2b512f9d2b9b8c08efe1a3252fccd09edca70 https://registry.npmjs.org/hookified/-/hookified-1.15.1.tgz /hookified-1.15.1.tgz
ADD --chmod=0444 --checksum=sha256:01aa4e32fec989b18ab2b7a6b593ec968efdd4db287d7fef94813678bc2b1564 https://registry.npmjs.org/hookified/-/hookified-2.2.0.tgz /hookified-2.2.0.tgz
ADD --chmod=0444 --checksum=sha256:ad62bbb11baf079699a3f269ed089efdb589be16083ceed94a1117801e1a6c61 https://registry.npmjs.org/http-errors/-/http-errors-2.0.1.tgz /http-errors-2.0.1.tgz
ADD --chmod=0444 --checksum=sha256:785f73faa92bfba8d61da20bf59325ab2b3dca1bbc0bbac523406f404d8a6f02 https://registry.npmjs.org/http-proxy-agent/-/http-proxy-agent-7.0.2.tgz /http-proxy-agent-7.0.2.tgz
ADD --chmod=0444 --checksum=sha256:6da16fb44331f2e5d30bd21bf880aa934c1ad4fe7da7187910ef2b2509712019 https://registry.npmjs.org/https-proxy-agent/-/https-proxy-agent-5.0.1.tgz /https-proxy-agent-5.0.1.tgz
ADD --chmod=0444 --checksum=sha256:960f89e8e5240882f64249d04a538421dd39d62ffacc138544647cc3251bc0e0 https://registry.npmjs.org/https-proxy-agent/-/https-proxy-agent-7.0.6.tgz /https-proxy-agent-7.0.6.tgz
ADD --chmod=0444 --checksum=sha256:61d46769e71f9235ae4d2f5652e5742e3beb83fb096a9d84247103624e8da03e https://registry.npmjs.org/iconv-lite/-/iconv-lite-0.7.2.tgz /iconv-lite-0.7.2.tgz
ADD --chmod=0444 --checksum=sha256:0022f11f6dcaf3cc662b2122c23e5da284a241939d5bffd8ca243b026398e9b6 https://registry.npmjs.org/@azure/identity/-/identity-4.13.1.tgz /identity-4.13.1.tgz
ADD --chmod=0444 --checksum=sha256:8ef14b9b397e339db89db97881fb714f49319d8f0eb1275901f45567b28f9dac https://registry.npmjs.org/ieee754/-/ieee754-1.2.1.tgz /ieee754-1.2.1.tgz
ADD --chmod=0444 --checksum=sha256:41f6a60b13cf29eebdd06723223dc68ff1d47721d56e4fef93d2d450167d9dc0 https://registry.npmjs.org/@tokenizer/inflate/-/inflate-0.4.1.tgz /inflate-0.4.1.tgz
ADD --chmod=0444 --checksum=sha256:d94dbc6c1bb3c5ac0fb12a73ade187108fc60de273a1b754f55044eb5e24afaf https://registry.npmjs.org/inherits/-/inherits-2.0.4.tgz /inherits-2.0.4.tgz
ADD --chmod=0444 --checksum=sha256:2ad382b4e119874271424d00044194b2e3dce38e11c2c341f460113963a8a7aa https://registry.npmjs.org/@protobufjs/inquire/-/inquire-1.1.2.tgz /inquire-1.1.2.tgz
ADD --chmod=0444 --checksum=sha256:7441d9623f67fe4160eccfd82ae9a404dcd55e1e4f1b68e06e2374dade4e8fee https://registry.npmjs.org/ipaddr.js/-/ipaddr.js-1.9.1.tgz /ipaddr.js-1.9.1.tgz
ADD --chmod=0444 --checksum=sha256:1a230b0b25c81eff06bdee3856a742fd17260169b0bf958de9368c4b3ce2ddee https://registry.npmjs.org/is-docker/-/is-docker-3.0.0.tgz /is-docker-3.0.0.tgz
ADD --chmod=0444 --checksum=sha256:e3491fc018fc80fc20bf2dc198983c6283e3be203461de5f312149353cc5944a https://registry.npmjs.org/is-electron/-/is-electron-2.2.2.tgz /is-electron-2.2.2.tgz
ADD --chmod=0444 --checksum=sha256:dbde95b8434fc4757624974d4139c4f32391d08c4153565ae91a5f3fd772e07b https://registry.npmjs.org/is-inside-container/-/is-inside-container-1.0.0.tgz /is-inside-container-1.0.0.tgz
ADD --chmod=0444 --checksum=sha256:853891173876fa03b8762cf63e7f0c0d60e524947f4e4d5852d94c22acb445a7 https://registry.npmjs.org/is-promise/-/is-promise-4.0.0.tgz /is-promise-4.0.0.tgz
ADD --chmod=0444 --checksum=sha256:3501ff72a20b78f1a2170a4982d82d9a71d16b99a935bec9787f1c486d61b6d7 https://registry.npmjs.org/is-stream/-/is-stream-2.0.1.tgz /is-stream-2.0.1.tgz
ADD --chmod=0444 --checksum=sha256:f0f93f9796c2e768a487a35bbe8f96c0b703edeb01add088686ba91a72b92eb2 https://registry.npmjs.org/is-wsl/-/is-wsl-3.1.1.tgz /is-wsl-3.1.1.tgz
ADD --chmod=0444 --checksum=sha256:15d92c0711c570e8a900770ca4545fbf872fed252ce153c263e0e030f21ddaa0 https://registry.npmjs.org/jose/-/jose-4.15.9.tgz /jose-4.15.9.tgz
ADD --chmod=0444 --checksum=sha256:4c4f502953cfb36cfe1c6c4989676bf9b76899a253237fc0220814b88ff903b6 https://registry.npmjs.org/json-bigint/-/json-bigint-1.0.0.tgz /json-bigint-1.0.0.tgz
ADD --chmod=0444 --checksum=sha256:ba70d14832394c094607e2cbb98d126cf51352e3d810caf1e52e7bcc15177aae https://registry.npmjs.org/@types/jsonwebtoken/-/jsonwebtoken-9.0.10.tgz /jsonwebtoken-9.0.10.tgz
ADD --chmod=0444 --checksum=sha256:d9af2628a7a4dda25acf1e19c7ecc2468e1e9e8d4619fe2cae829e89d96f6b82 https://registry.npmjs.org/jsonwebtoken/-/jsonwebtoken-9.0.3.tgz /jsonwebtoken-9.0.3.tgz
ADD --chmod=0444 --checksum=sha256:c8bc0cf9fbbdc9d2f1b6f3f97ab9c1f70130eec6b153f29fd69baa5a6aa8341d https://registry.npmjs.org/jwa/-/jwa-2.0.1.tgz /jwa-2.0.1.tgz
ADD --chmod=0444 --checksum=sha256:01c60583d8f3b098580792e5362447c2ffb6857dda4ff4ecc0c2a5a4514513f6 https://registry.npmjs.org/jwks-rsa/-/jwks-rsa-3.2.2.tgz /jwks-rsa-3.2.2.tgz
ADD --chmod=0444 --checksum=sha256:ed3a5fb027f8ce1006c8e30a37e88e7cd49824d4873efca8765304b20fe92e12 https://registry.npmjs.org/jws/-/jws-4.0.1.tgz /jws-4.0.1.tgz
ADD --chmod=0444 --checksum=sha256:d16dfbf80fa1f084be989d790e89c496cb71ec3f96c278fbbe4801a5ccb4e6eb https://registry.npmjs.org/jwt-decode/-/jwt-decode-4.0.0.tgz /jwt-decode-4.0.0.tgz
ADD --chmod=0444 --checksum=sha256:db982b7c83daadc135266141d1cb542443f26d42c72f25ee2d45644fc631e7e0 https://registry.npmjs.org/keyv/-/keyv-5.6.0.tgz /keyv-5.6.0.tgz
ADD --chmod=0444 --checksum=sha256:1e21c10c247a4e7ef40874d74553dbe11954f343fef2a377b71307c8751f52df https://registry.npmjs.org/libopus-wasm/-/libopus-wasm-0.2.0.tgz /libopus-wasm-0.2.0.tgz
ADD --chmod=0444 --checksum=sha256:121278ea39d5bceb6efeb5e5daab1a790b044840be6e117ae74ec74e82d72ba7 https://registry.npmjs.org/libsignal/-/libsignal-6.0.0.tgz /libsignal-6.0.0.tgz
ADD --chmod=0444 --checksum=sha256:84ff39cceb2eaef0800daa64a5ac16138c073308437a97ec6a8b4728c1f86ded https://registry.npmjs.org/limiter/-/limiter-1.1.5.tgz /limiter-1.1.5.tgz
ADD --chmod=0444 --checksum=sha256:cd3630dddc6fcb73e1bd27fce6972b2d20aa0ecadb001c523174648efbfe0312 https://registry.npmjs.org/lodash.clonedeep/-/lodash.clonedeep-4.5.0.tgz /lodash.clonedeep-4.5.0.tgz
ADD --chmod=0444 --checksum=sha256:ad1fb3f7aa3c53d2aa7b5fd006507404d71fcccb341162b6423645d997c808d7 https://registry.npmjs.org/lodash.includes/-/lodash.includes-4.3.0.tgz /lodash.includes-4.3.0.tgz
ADD --chmod=0444 --checksum=sha256:11a52014f5d33bdc0b58a79fd10355b8209aeb1b2c57f2c13b7395ca57dcee9d https://registry.npmjs.org/lodash.isboolean/-/lodash.isboolean-3.0.3.tgz /lodash.isboolean-3.0.3.tgz
ADD --chmod=0444 --checksum=sha256:7885443a78d4400274bf42a5929f6aaab23ca5d7e303deee76fe702ffe873b7d https://registry.npmjs.org/lodash.isinteger/-/lodash.isinteger-4.0.4.tgz /lodash.isinteger-4.0.4.tgz
ADD --chmod=0444 --checksum=sha256:73e5167e1e06f496cbad0f96afda0590302c0867f9840730e2600edf03c29b63 https://registry.npmjs.org/lodash.isnumber/-/lodash.isnumber-3.0.3.tgz /lodash.isnumber-3.0.3.tgz
ADD --chmod=0444 --checksum=sha256:986420e1ce139727af84069d7b88912facac64e5ca1281efd9f55b228fad72d0 https://registry.npmjs.org/lodash.isplainobject/-/lodash.isplainobject-4.0.6.tgz /lodash.isplainobject-4.0.6.tgz
ADD --chmod=0444 --checksum=sha256:45fd48aeca41f05f44fd413471f254c472e1e7a811ab84ea41448d2e7155cd5f https://registry.npmjs.org/lodash.isstring/-/lodash.isstring-4.0.1.tgz /lodash.isstring-4.0.1.tgz
ADD --chmod=0444 --checksum=sha256:0d67808f6f1d4c35c65e0e34c19e0a2de02727616cc8e276535f3eae98ce23b5 https://registry.npmjs.org/lodash.once/-/lodash.once-4.1.1.tgz /lodash.once-4.1.1.tgz
ADD --chmod=0444 --checksum=sha256:4a8aac68a201fe0ed1eae25ad6d8161967d2a1f75f55f0b08c5fc10ac36c90af https://registry.npmjs.org/@azure/logger/-/logger-1.3.0.tgz /logger-1.3.0.tgz
ADD --chmod=0444 --checksum=sha256:572e17d49f67723a3631869a484a2eacd2da977e88d60144488da48f0f27ac7d https://registry.npmjs.org/@slack/logger/-/logger-4.0.1.tgz /logger-4.0.1.tgz
ADD --chmod=0444 --checksum=sha256:68033e466773df7d52c9e59341bb729d83716cd920c56460395724456d646b26 https://registry.npmjs.org/long/-/long-5.3.2.tgz /long-5.3.2.tgz
ADD --chmod=0444 --checksum=sha256:305fc63289b98a4a33ac2f1807ea7ddc25c366bb416dfa822832f879217b29e5 https://registry.npmjs.org/lru-cache/-/lru-cache-11.5.1.tgz /lru-cache-11.5.1.tgz
ADD --chmod=0444 --checksum=sha256:5ce40deb031cf6968f3832502a68f8d26be09764dc4f8fc07957a2fd7e8cdf5e https://registry.npmjs.org/lru-cache/-/lru-cache-6.0.0.tgz /lru-cache-6.0.0.tgz
ADD --chmod=0444 --checksum=sha256:4fe2dc759c1113c1df731891b02601e9af9670ce2a344ce36b07285294496445 https://registry.npmjs.org/lru-memoizer/-/lru-memoizer-2.3.0.tgz /lru-memoizer-2.3.0.tgz
ADD --chmod=0444 --checksum=sha256:b8c2c35575493dc086df88cfc468a9e2651b6617336480ab3f00fcf853f443a7 https://registry.npmjs.org/math-intrinsics/-/math-intrinsics-1.1.0.tgz /math-intrinsics-1.1.0.tgz
ADD --chmod=0444 --checksum=sha256:b5dc531e1d1efc92cfb659be11e74e7e697caef935c233e05016a7b2997c19be https://registry.npmjs.org/media-typer/-/media-typer-1.1.0.tgz /media-typer-1.1.0.tgz
ADD --chmod=0444 --checksum=sha256:9b50410e3d25f14da0ec92ca6d245f55f15ac6ee9c452900bf8907aaa79279d6 https://registry.npmjs.org/media-typer/-/media-typer-2.0.0.tgz /media-typer-2.0.0.tgz
ADD --chmod=0444 --checksum=sha256:9dffad84622ba74be37dcec88ba7537cc9d168551e349588757add056f5289b9 https://registry.npmjs.org/@cacheable/memory/-/memory-2.2.0.tgz /memory-2.2.0.tgz
ADD --chmod=0444 --checksum=sha256:ae88322a5fc71952d3990ae999a7afc7a4bf7cba086b9ccc1c9482432b101dce https://registry.npmjs.org/merge-descriptors/-/merge-descriptors-2.0.0.tgz /merge-descriptors-2.0.0.tgz
ADD --chmod=0444 --checksum=sha256:b8e70bb4d52acd5d0d1ed848c0e6e3c903a533aa500acffbe003f011b18f9e3b https://registry.npmjs.org/mime-db/-/mime-db-1.52.0.tgz /mime-db-1.52.0.tgz
ADD --chmod=0444 --checksum=sha256:2b21054e65d0eabd58c5002d2713e968dd47b15700bfed4b7281a344ded1c420 https://registry.npmjs.org/mime-db/-/mime-db-1.54.0.tgz /mime-db-1.54.0.tgz
ADD --chmod=0444 --checksum=sha256:49734fc98906e9baaacf8034923470a4c84de72943a7c005face63360701d1c3 https://registry.npmjs.org/mime-types/-/mime-types-2.1.35.tgz /mime-types-2.1.35.tgz
ADD --chmod=0444 --checksum=sha256:2f9dd28353c303ff8750fbf68e474755b01c54a989883d227d605f7bfa3dd2ac https://registry.npmjs.org/mime-types/-/mime-types-3.0.2.tgz /mime-types-3.0.2.tgz
ADD --chmod=0444 --checksum=sha256:5207b35109ec884e7d47ab89b670bc86438399f681e1a6c26716003b3949cc5c https://registry.npmjs.org/mpg123-decoder/-/mpg123-decoder-1.0.3.tgz /mpg123-decoder-1.0.3.tgz
ADD --chmod=0444 --checksum=sha256:a07f7b4d84e44bd8c55e44ee084f3529d5b3bbb2f212ef1749aced718bcb6c09 https://registry.npmjs.org/@types/ms/-/ms-2.1.0.tgz /ms-2.1.0.tgz
ADD --chmod=0444 --checksum=sha256:f6616e15e530ed552f9daa2d3ce71963947c6bc7c98c9b64fd3e673fd02622c6 https://registry.npmjs.org/ms/-/ms-2.1.3.tgz /ms-2.1.3.tgz
ADD --chmod=0444 --checksum=sha256:3a10b0b0694a9d46e4e4af0cfdf6ffee9ed705bf3372e20fbb639ad7f98d84bd https://registry.npmjs.org/@azure/msal-browser/-/msal-browser-5.16.0.tgz /msal-browser-5.16.0.tgz
ADD --chmod=0444 --checksum=sha256:37c1324439e70d7599949c79aa9eea99ad26c7f78c3526a57b2cc9ad357520c6 https://registry.npmjs.org/@azure/msal-common/-/msal-common-16.11.0.tgz /msal-common-16.11.0.tgz
ADD --chmod=0444 --checksum=sha256:38197844b3edef99c23b7af71ca0874d967811ccebfc3b29dae03a9024d99077 https://registry.npmjs.org/@azure/msal-node/-/msal-node-5.3.1.tgz /msal-node-5.3.1.tgz
ADD --chmod=0444 --checksum=sha256:03fc4181fa52c1982b68d23d5c32221d6216d1620675a62b9a50d03f14d4e452 https://registry.npmjs.org/@openclaw/msteams/-/msteams-2026.7.1.tgz /msteams-2026.7.1.tgz
ADD --chmod=0444 --checksum=sha256:a8049e71f007232b9597322670fb16a2738d342a8ca61b4e63509faad93f06f3 https://registry.npmjs.org/music-metadata/-/music-metadata-11.13.0.tgz /music-metadata-11.13.0.tgz
ADD --chmod=0444 --checksum=sha256:b5a2dfee1dc0ac52c623cd5c0304be5a8a41cfad40e09f1a13606972cb2dbc04 https://registry.npmjs.org/negotiator/-/negotiator-1.0.0.tgz /negotiator-1.0.0.tgz
ADD --chmod=0444 --checksum=sha256:b99ec57cfdd28256a22b9308425709e9c94fbfdb3dea1fd6ab193010adb01832 https://registry.npmjs.org/@types/node/-/node-26.1.0.tgz /node-26.1.0.tgz
ADD --chmod=0444 --checksum=sha256:02a71bfedcef6479c6e576a60b19c966abcfd6ddc9fcb18ccd193749a6280deb https://registry.npmjs.org/@cacheable/node-cache/-/node-cache-1.7.6.tgz /node-cache-1.7.6.tgz
ADD --chmod=0444 --checksum=sha256:615af90e363f8f276b4b54f8e6c163cf3686dce1d8867dd7e52cbed4d38d2dab https://registry.npmjs.org/node-fetch/-/node-fetch-3.3.2.tgz /node-fetch-3.3.2.tgz
ADD --chmod=0444 --checksum=sha256:41e932bc7fb027c8e5d5725aeeaf8174c35d2d7521d1b8e18baedc1d7d8b2e23 https://registry.npmjs.org/node-wav/-/node-wav-0.0.2.tgz /node-wav-0.0.2.tgz
ADD --chmod=0444 --checksum=sha256:55f8ccb72315749da800595d305cc9102a4ae63f55a4f9e4425292548e1e3c1a https://registry.npmjs.org/@slack/oauth/-/oauth-3.0.5.tgz /oauth-3.0.5.tgz
ADD --chmod=0444 --checksum=sha256:782d726a263ba7b26cced612af97b80035516df4b0cd788524e7b2cebc4e29ed https://registry.npmjs.org/object-assign/-/object-assign-4.1.1.tgz /object-assign-4.1.1.tgz
ADD --chmod=0444 --checksum=sha256:8324967a3afd8a45b0401e3554aebc1843f493bec46a89a7ce8cf072e62e90bf https://registry.npmjs.org/object-inspect/-/object-inspect-1.13.4.tgz /object-inspect-1.13.4.tgz
ADD --chmod=0444 --checksum=sha256:b173dfcaa897eec1fb303a4810b02aaa95dd0dcedb16c6cc056410d2bd9c01d3 https://registry.npmjs.org/ogg-opus-decoder/-/ogg-opus-decoder-1.7.3.tgz /ogg-opus-decoder-1.7.3.tgz
ADD --chmod=0444 --checksum=sha256:64c914f05c5dd46e7e54f36919447ba59968a7eb87beda7669fec33e2234fc8e https://registry.npmjs.org/@wasm-audio-decoders/ogg-vorbis/-/ogg-vorbis-0.1.20.tgz /ogg-vorbis-0.1.20.tgz
ADD --chmod=0444 --checksum=sha256:1ed10cfc6a8a8807b1c7b7eae520dbd15a104d5d0256202f8b08e1ec56cda1a8 https://registry.npmjs.org/on-exit-leak-free/-/on-exit-leak-free-2.1.2.tgz /on-exit-leak-free-2.1.2.tgz
ADD --chmod=0444 --checksum=sha256:f64d42f1049c386cdac5204737e09564271639b2b7d203a3ea07ec07d5ddbd0a https://registry.npmjs.org/on-finished/-/on-finished-2.4.1.tgz /on-finished-2.4.1.tgz
ADD --chmod=0444 --checksum=sha256:cf51460ba370c698f68b976e514d113497339ba018b6003e8e8eb569c6fccfcf https://registry.npmjs.org/once/-/once-1.4.0.tgz /once-1.4.0.tgz
ADD --chmod=0444 --checksum=sha256:b5b60d1271802682a5c8e0ed1cc8e825d3be7fd610afaaf3d4d8ce799e825be9 https://registry.npmjs.org/open/-/open-10.2.0.tgz /open-10.2.0.tgz
ADD --chmod=0444 --checksum=sha256:422ee96c2fca294d6d80c193c2797d2a046cb8b512b84b0705c85865f0251bb7 https://registry.npmjs.org/@tencent-weixin/openclaw-weixin/-/openclaw-weixin-2.4.3.tgz /openclaw-weixin-2.4.3.tgz
ADD --chmod=0444 --checksum=sha256:1c8c0b27f5b4e941e8059bbbf8d26ff8e9f7c882e2465bb68da1b19ceaa64e25 https://registry.npmjs.org/opus-decoder/-/opus-decoder-0.7.11.tgz /opus-decoder-0.7.11.tgz
ADD --chmod=0444 --checksum=sha256:63c6cdb9895ee0bf65aa8fe17b49ab4678b68cacfc5b239ce19133ce806a85d5 https://registry.npmjs.org/@wasm-audio-decoders/opus-ml/-/opus-ml-0.0.2.tgz /opus-ml-0.0.2.tgz
ADD --chmod=0444 --checksum=sha256:effd84e09e1330542a84a243f1f4da21a700d459b83761eaca16070eb1fb8841 https://registry.npmjs.org/p-finally/-/p-finally-1.0.0.tgz /p-finally-1.0.0.tgz
ADD --chmod=0444 --checksum=sha256:4d94fe81f32ce77f88f6d7b676fdff3a844a1ac445da522b2a1d9467b86a405d https://registry.npmjs.org/p-queue/-/p-queue-6.6.2.tgz /p-queue-6.6.2.tgz
ADD --chmod=0444 --checksum=sha256:b78dd7f04d342af574ebf9b039ef47b37e259963c3c4dc739269eeb432bb9cd8 https://registry.npmjs.org/p-queue/-/p-queue-9.3.0.tgz /p-queue-9.3.0.tgz

FROM scratch AS openclaw-managed-messaging-npm-common-archives-3

ADD --chmod=0444 --checksum=sha256:21112bb484de3120e9e85f1ebe6a66125ecfda48072ae48b0d202693337fb558 https://registry.npmjs.org/p-retry/-/p-retry-4.6.2.tgz /p-retry-4.6.2.tgz
ADD --chmod=0444 --checksum=sha256:226b0886e0a837928501e3f5f96c5ec2f4c97aa2e287719b50d5341678da1c67 https://registry.npmjs.org/p-timeout/-/p-timeout-3.2.0.tgz /p-timeout-3.2.0.tgz
ADD --chmod=0444 --checksum=sha256:0a39ef5e2e147e571a668c47a1e8b33961ae6764379ce65bc523e6bc80b13c02 https://registry.npmjs.org/p-timeout/-/p-timeout-7.0.1.tgz /p-timeout-7.0.1.tgz
ADD --chmod=0444 --checksum=sha256:56ef4bfa11e097ce8196b26fa04b42d6091c32498fcab4478e6dd298435f021a https://registry.npmjs.org/parseurl/-/parseurl-1.3.3.tgz /parseurl-1.3.3.tgz
ADD --chmod=0444 --checksum=sha256:cc364ee910173c36d5734535a2bb53b8e7e86d2d219f27218158ab3f3dca328c https://registry.npmjs.org/@protobufjs/path/-/path-1.1.2.tgz /path-1.1.2.tgz
ADD --chmod=0444 --checksum=sha256:29d04afd81fc75b664674fb38f18694d801aa27d023572d1538bbe46f330240b https://registry.npmjs.org/path-to-regexp/-/path-to-regexp-8.4.0.tgz /path-to-regexp-8.4.0.tgz
ADD --chmod=0444 --checksum=sha256:e3cf66fc547c957aad15864cdf980dd14d8c9a1f5a363134ffe25c599a769508 https://registry.npmjs.org/pino/-/pino-9.14.0.tgz /pino-9.14.0.tgz
ADD --chmod=0444 --checksum=sha256:eded21b859cbee8e21988d1a32f95a00cb4f15a528a3708aac654d0cd647149c https://registry.npmjs.org/pino-abstract-transport/-/pino-abstract-transport-2.0.0.tgz /pino-abstract-transport-2.0.0.tgz
ADD --chmod=0444 --checksum=sha256:c8ee1578a9fd84a929924515d7572eaeb4a3944d38953eaf8eb3dbd165020763 https://registry.npmjs.org/pino-std-serializers/-/pino-std-serializers-7.1.0.tgz /pino-std-serializers-7.1.0.tgz
ADD --chmod=0444 --checksum=sha256:f721dbd27282d2c7d1c2bf1ae9f7a03cc3ef9cf882fe469a32c14d1dae732703 https://registry.npmjs.org/@protobufjs/pool/-/pool-1.1.0.tgz /pool-1.1.0.tgz
ADD --chmod=0444 --checksum=sha256:cb092328f50c6f8d29a7e78f1cc0be5f41373c8eb9eedf9ff3364784e301b432 https://registry.npmjs.org/prism-media/-/prism-media-1.3.5.tgz /prism-media-1.3.5.tgz
ADD --chmod=0444 --checksum=sha256:9220188a409e3593eb8fb481d2f4714edfb8514aedfb8711a713fc2338fc6b92 https://registry.npmjs.org/process-warning/-/process-warning-5.0.0.tgz /process-warning-5.0.0.tgz
ADD --chmod=0444 --checksum=sha256:fab4af9004100a959d999f11b006e4307a2e18257c7f7f8a37a75d53a5e8b69e https://registry.npmjs.org/protobufjs/-/protobufjs-7.6.3.tgz /protobufjs-7.6.3.tgz
ADD --chmod=0444 --checksum=sha256:a0d1b6f34f6d4e733429ba95f7adb7833c8ceab916ba574a93f8a8476bee46d9 https://registry.npmjs.org/proxy-addr/-/proxy-addr-2.0.7.tgz /proxy-addr-2.0.7.tgz
ADD --chmod=0444 --checksum=sha256:e9c52dbf1e382319d5da00b8d964805859b7eb1424450e049d12743d7e19fc9a https://registry.npmjs.org/proxy-from-env/-/proxy-from-env-2.1.0.tgz /proxy-from-env-2.1.0.tgz
ADD --chmod=0444 --checksum=sha256:5acca41a42576ff888cf16cbcf505efbe3b0d4f55232edf3a931298a4b5ca662 https://registry.npmjs.org/qified/-/qified-0.10.1.tgz /qified-0.10.1.tgz
ADD --chmod=0444 --checksum=sha256:329df324f93519ccf718a45f9ed802e823d6cae8d97a0b974d09dc4b90091e3e https://registry.npmjs.org/qoa-format/-/qoa-format-1.0.1.tgz /qoa-format-1.0.1.tgz
ADD --chmod=0444 --checksum=sha256:3a6260c4e0d80bd527a3f930e90ea2348c03646621f25aa0bd960ee205a0a706 https://registry.npmjs.org/qrcode-terminal/-/qrcode-terminal-0.12.0.tgz /qrcode-terminal-0.12.0.tgz
ADD --chmod=0444 --checksum=sha256:e699d4b3ac62181f5bcd29c1d15224054c20d81aab67f7b2e75b7f7a2185b897 https://registry.npmjs.org/qs/-/qs-6.15.2.tgz /qs-6.15.2.tgz
ADD --chmod=0444 --checksum=sha256:acba54ec5587ffddfb0811b693aad4844366772f01511291302d3380d431a485 https://registry.npmjs.org/quick-format-unescaped/-/quick-format-unescaped-4.0.4.tgz /quick-format-unescaped-4.0.4.tgz
ADD --chmod=0444 --checksum=sha256:51b79ec072db6788b132680256e9e733af8bb091df4f8ce8562ca631118f0fae https://registry.npmjs.org/range-parser/-/range-parser-1.3.0.tgz /range-parser-1.3.0.tgz
ADD --chmod=0444 --checksum=sha256:66de2a025036de58bbe50ab1d42a24ec6d33eda338b8115a3ebf942dae8419db https://registry.npmjs.org/raw-body/-/raw-body-3.0.2.tgz /raw-body-3.0.2.tgz
ADD --chmod=0444 --checksum=sha256:2aa86d462e4bcec95cca91c935002e102644e1bb2fcd36a9b52e4f4555c73f96 https://registry.npmjs.org/real-require/-/real-require-0.2.0.tgz /real-require-0.2.0.tgz
ADD --chmod=0444 --checksum=sha256:d66004def64efb6c13629b0740639344e0775fe537373674571711a2bb2fc704 https://registry.npmjs.org/@pinojs/redact/-/redact-0.4.0.tgz /redact-0.4.0.tgz
ADD --chmod=0444 --checksum=sha256:cad52ea77001223648829bfa3c4e677d30939928b12ed3566148bf2b7e1df18f https://registry.npmjs.org/reflect-metadata/-/reflect-metadata-0.2.2.tgz /reflect-metadata-0.2.2.tgz
ADD --chmod=0444 --checksum=sha256:062c4d9d2b7ba41a3869cf55903d0b5d439d838e241b6b0f42d53aa22d3debd8 https://registry.npmjs.org/@types/retry/-/retry-0.12.5.tgz /retry-0.12.5.tgz
ADD --chmod=0444 --checksum=sha256:7521d8445e845475e888ccb7af473c4afb17aabafefe35a23371a8a8c79b8084 https://registry.npmjs.org/retry/-/retry-0.13.1.tgz /retry-0.13.1.tgz
ADD --chmod=0444 --checksum=sha256:b144af37b39a9517f7a89f1d867e9c2cf29f13f4147d3e80c499fe6ffab69461 https://registry.npmjs.org/router/-/router-2.2.0.tgz /router-2.2.0.tgz
ADD --chmod=0444 --checksum=sha256:d29ace7117aaa0d6b119027e9a157c238e6899bbb35d03f508ae8d4fa9ca8c9d https://registry.npmjs.org/run-applescript/-/run-applescript-7.1.0.tgz /run-applescript-7.1.0.tgz
ADD --chmod=0444 --checksum=sha256:5d181804516c4a693a384272a7bd0e42d17e0d4b301ccfbe408669ccafdcb3e8 https://registry.npmjs.org/safe-buffer/-/safe-buffer-5.2.1.tgz /safe-buffer-5.2.1.tgz
ADD --chmod=0444 --checksum=sha256:acf5b4e0f8e5f0bfd9479eae41a6dd90e175d89eecd98fe1c834eab602073e91 https://registry.npmjs.org/safe-stable-stringify/-/safe-stable-stringify-2.5.0.tgz /safe-stable-stringify-2.5.0.tgz
ADD --chmod=0444 --checksum=sha256:78812f65ae3b98071ce1c9bacbe0666f4220d0b2753c2a11530eb27df440a3b3 https://registry.npmjs.org/safer-buffer/-/safer-buffer-2.1.2.tgz /safer-buffer-2.1.2.tgz
ADD --chmod=0444 --checksum=sha256:d85045d4300d7d57c891336b95df532e73f34c22ffcd222452b6d08b9d127d5d https://registry.npmjs.org/semver/-/semver-7.8.5.tgz /semver-7.8.5.tgz
ADD --chmod=0444 --checksum=sha256:fa254fb316dd23ddcb2beebd533b23788aec4cf6a3dba58af34150170435c472 https://registry.npmjs.org/send/-/send-1.2.1.tgz /send-1.2.1.tgz
ADD --chmod=0444 --checksum=sha256:5730adf7d1edef7c84a7ce658c3a2915386529b4d795523265c30a2e94f91366 https://registry.npmjs.org/@keyv/serialize/-/serialize-1.1.1.tgz /serialize-1.1.1.tgz
ADD --chmod=0444 --checksum=sha256:36d4f72bb59372eb18202fee25ff3d8bf46655f0121830fbe32e32cbdc625f43 https://registry.npmjs.org/serve-static/-/serve-static-2.2.1.tgz /serve-static-2.2.1.tgz
ADD --chmod=0444 --checksum=sha256:c83bcc6ea632567e3f6928a83a1c0c7073519aaca9b88b847a3b404417eadfe2 https://registry.npmjs.org/setprototypeof/-/setprototypeof-1.2.0.tgz /setprototypeof-1.2.0.tgz
ADD --chmod=0444 --checksum=sha256:e6edbc8f203901612a3cd938f940ed520333923986d5427b95c87aa1882e7bd5 https://registry.npmjs.org/side-channel/-/side-channel-1.1.1.tgz /side-channel-1.1.1.tgz
ADD --chmod=0444 --checksum=sha256:793c94ac215be772757045f8804406578b8cbc1bda7e1cde23011f9145af74f7 https://registry.npmjs.org/side-channel-list/-/side-channel-list-1.0.1.tgz /side-channel-list-1.0.1.tgz
ADD --chmod=0444 --checksum=sha256:3b256b6421300bcc962d891b1588fd4b64e84e339b9c29f78c61b72f2a7116d6 https://registry.npmjs.org/side-channel-map/-/side-channel-map-1.0.1.tgz /side-channel-map-1.0.1.tgz
ADD --chmod=0444 --checksum=sha256:3b2a54f0c5e7ad898c8f0ffda2a6805fb2cc5d68f53addf0b4a9ec0db9d0d06e https://registry.npmjs.org/side-channel-weakmap/-/side-channel-weakmap-1.0.2.tgz /side-channel-weakmap-1.0.2.tgz
ADD --chmod=0444 --checksum=sha256:52151d29797654e08019f3d45e5f22c16ebc3c356258b00926aa4db636012fbd https://registry.npmjs.org/simple-yenc/-/simple-yenc-1.0.4.tgz /simple-yenc-1.0.4.tgz
ADD --chmod=0444 --checksum=sha256:d6ae8745867d812560e917707e633c8b66b36f7270124a8cca9602c6dc98ef46 https://registry.npmjs.org/@openclaw/slack/-/slack-2026.7.1.tgz /slack-2026.7.1.tgz
ADD --chmod=0444 --checksum=sha256:7630e4606e5cc42195711f097a2d6b719e295847a37b10dc159a53051728936d https://registry.npmjs.org/@slack/socket-mode/-/socket-mode-2.0.7.tgz /socket-mode-2.0.7.tgz
ADD --chmod=0444 --checksum=sha256:bf128eca0c2a2ed9eb9f598a69eb374df08f3886dd9c506c5129935487166b87 https://registry.npmjs.org/sonic-boom/-/sonic-boom-4.2.1.tgz /sonic-boom-4.2.1.tgz
ADD --chmod=0444 --checksum=sha256:e0061e7f042fc5ff6dcda8afb66619757d92ab1ff514a28a5904f2ebde27bf54 https://registry.npmjs.org/split2/-/split2-4.2.0.tgz /split2-4.2.0.tgz
ADD --chmod=0444 --checksum=sha256:ca800a24710488b568f4e73e8f570dd6b911c122cbf42b06930dee7c25949fe0 https://registry.npmjs.org/statuses/-/statuses-2.0.2.tgz /statuses-2.0.2.tgz
ADD --chmod=0444 --checksum=sha256:58595fe65b2340514ea1c74dbae2bc4d8e5049c4d060cc38eed745da48fa7c96 https://registry.npmjs.org/strtok3/-/strtok3-10.3.5.tgz /strtok3-10.3.5.tgz
ADD --chmod=0444 --checksum=sha256:ad8ac7ebf8ed4a4fd9d79e01f9928602c0c62aeb4bb657589a43021a795583c1 https://registry.npmjs.org/@microsoft/teams.api/-/teams.api-2.0.13.tgz /teams.api-2.0.13.tgz
ADD --chmod=0444 --checksum=sha256:2581963dc2749b5833595489f8f767d616046fc723df67862b23d343a26a46bc https://registry.npmjs.org/@microsoft/teams.apps/-/teams.apps-2.0.13.tgz /teams.apps-2.0.13.tgz
ADD --chmod=0444 --checksum=sha256:75bd4ee076340d62565f611440a5a8c57528d9c2b23d680e3ad087c589db3ace https://registry.npmjs.org/@microsoft/teams.cards/-/teams.cards-2.0.13.tgz /teams.cards-2.0.13.tgz
ADD --chmod=0444 --checksum=sha256:fb9d41d2491340a97196f94256f9dfd42fe68d101390695d50e62c016309c725 https://registry.npmjs.org/@microsoft/teams.common/-/teams.common-2.0.13.tgz /teams.common-2.0.13.tgz
ADD --chmod=0444 --checksum=sha256:281259676f833d8386e0f8a4e4fff46dd8e9d0c282ff0ba0b201ea4184306c66 https://registry.npmjs.org/@microsoft/teams.graph/-/teams.graph-2.0.13.tgz /teams.graph-2.0.13.tgz
ADD --chmod=0444 --checksum=sha256:991d87763add805a12d5b3e67b201476681a5b738d8dcb9229bed1df755acba0 https://registry.npmjs.org/@borewit/text-codec/-/text-codec-0.2.2.tgz /text-codec-0.2.2.tgz
ADD --chmod=0444 --checksum=sha256:99ec7b0a30060ca693bebe16c780642ecd2b4b92b1e7ab89ef0cd8014f78ecf1 https://registry.npmjs.org/thread-stream/-/thread-stream-3.2.0.tgz /thread-stream-3.2.0.tgz
ADD --chmod=0444 --checksum=sha256:186fcc77488de327daf911d362d4e773bab9909f1df2a5f0c20b875205b92e08 https://registry.npmjs.org/toidentifier/-/toidentifier-1.0.1.tgz /toidentifier-1.0.1.tgz
ADD --chmod=0444 --checksum=sha256:911758ceca239c8e5372700eedfbbd514f16d3c117b5af0a648f6e720487c209 https://registry.npmjs.org/@tokenizer/token/-/token-0.3.0.tgz /token-0.3.0.tgz
ADD --chmod=0444 --checksum=sha256:eb4820714d28f6dad949d392e7b74ec919ae3b120421240a032027bf2bd25f41 https://registry.npmjs.org/token-types/-/token-types-6.1.2.tgz /token-types-6.1.2.tgz
ADD --chmod=0444 --checksum=sha256:74a77ed8979f4f2187fa24ef6fcd5431049f58310214ff93db9184f58aa0f68e https://registry.npmjs.org/@typespec/ts-http-runtime/-/ts-http-runtime-0.3.6.tgz /ts-http-runtime-0.3.6.tgz
ADD --chmod=0444 --checksum=sha256:66f635d5eeabae44807534976913a102cf615b9a045368359c9f79ae6ee2119e https://registry.npmjs.org/tslib/-/tslib-2.8.1.tgz /tslib-2.8.1.tgz
ADD --chmod=0444 --checksum=sha256:0abaf4f02f0140b331fe6125b7556d5974a627a53734f73ce4c46f5615d1f9de https://registry.npmjs.org/tsscmp/-/tsscmp-1.0.6.tgz /tsscmp-1.0.6.tgz
ADD --chmod=0444 --checksum=sha256:9a53088d69cd488e0c2cb4fcee5a983089c0d492404cf212161c77501fb302fc https://registry.npmjs.org/type-is/-/type-is-2.1.0.tgz /type-is-2.1.0.tgz
ADD --chmod=0444 --checksum=sha256:32accdf2534503b9c6d0a70eb138188307d230bf645f9382a6e6f7aad161b4dc https://registry.npmjs.org/typebox/-/typebox-1.3.3.tgz /typebox-1.3.3.tgz
ADD --chmod=0444 --checksum=sha256:f5422a83e79e1737b2ebd8d501d373e5952ab6ea623072a9c608691a06742887 https://registry.npmjs.org/@slack/types/-/types-2.21.1.tgz /types-2.21.1.tgz
ADD --chmod=0444 --checksum=sha256:65834dc9ce7ecceff4334a14796c85960cbf665d09364698bf3196ceed04d677 https://registry.npmjs.org/uint8array-extras/-/uint8array-extras-1.5.0.tgz /uint8array-extras-1.5.0.tgz
ADD --chmod=0444 --checksum=sha256:9d72c56c17ad2b3d66f006d53945374cc0d2bc68f322439495b972269f4de6bc https://registry.npmjs.org/undici/-/undici-8.10.0.tgz /undici-8.10.0.tgz
ADD --chmod=0444 --checksum=sha256:164b59cd288030078e5ebc4f33bae472009ec3d974b1dd78c2ec5045fc7d0111 https://registry.npmjs.org/undici/-/undici-8.5.0.tgz /undici-8.5.0.tgz
ADD --chmod=0444 --checksum=sha256:07a721cb2cd0dd798c24757de34d14e8b640ff8fddef85d662e00b392562a1f2 https://registry.npmjs.org/undici-types/-/undici-types-8.3.0.tgz /undici-types-8.3.0.tgz
ADD --chmod=0444 --checksum=sha256:2dfb5e06d1d4bf1fe9f0fa7f633c4a2fde04d8b41cf0b9bd249a42561d5edfb6 https://registry.npmjs.org/unpipe/-/unpipe-1.0.0.tgz /unpipe-1.0.0.tgz
ADD --chmod=0444 --checksum=sha256:46ea4e6d025995a9e0a1ae98b4371e03179827d6dc09a7a0d4263a9b864673ef https://registry.npmjs.org/@protobufjs/utf8/-/utf8-1.1.1.tgz /utf8-1.1.1.tgz
ADD --chmod=0444 --checksum=sha256:243841e7a895205b7984be00bfd162aab703423d878a4837367e617033689a02 https://registry.npmjs.org/@cacheable/utils/-/utils-2.5.0.tgz /utils-2.5.0.tgz
ADD --chmod=0444 --checksum=sha256:7378860671377a35e7a443ecfdca0745cfd066f595c90d581b827defea246e71 https://registry.npmjs.org/vary/-/vary-1.1.2.tgz /vary-1.1.2.tgz
ADD --chmod=0444 --checksum=sha256:d73df40425aad46ab0b13e9424731b2855c1c8c52d36b7cf0d2c8cf9a7bf0200 https://registry.npmjs.org/@discordjs/voice/-/voice-0.19.2.tgz /voice-0.19.2.tgz
ADD --chmod=0444 --checksum=sha256:2a352d4b79ecb9ec565d7e02b48225da186a1e1947b4edf45db681c036482ffb https://registry.npmjs.org/@slack/web-api/-/web-api-7.18.0.tgz /web-api-7.18.0.tgz
ADD --chmod=0444 --checksum=sha256:1ee138d3dc0263ead35c40604da75d7d56c4fa0ef32dc2e3a7fbac10480ebb54 https://registry.npmjs.org/web-streams-polyfill/-/web-streams-polyfill-3.3.3.tgz /web-streams-polyfill-3.3.3.tgz
ADD --chmod=0444 --checksum=sha256:92af6282372f58bba0bc3afbb6df63136e3efd9ab9afa4262be0de0d6ccb682d https://registry.npmjs.org/@eshaz/web-worker/-/web-worker-1.2.2.tgz /web-worker-1.2.2.tgz
ADD --chmod=0444 --checksum=sha256:a00dab45c1f2e99e6d28796b4cd20ccc4c4f10309e99bb53c95783774622f098 https://registry.npmjs.org/@openclaw/whatsapp/-/whatsapp-2026.7.1.tgz /whatsapp-2026.7.1.tgz
ADD --chmod=0444 --checksum=sha256:063a810df0af84c49c4acc03de91f5f51d29135f84a443a002efb400f5251387 https://registry.npmjs.org/whatsapp-rust-bridge/-/whatsapp-rust-bridge-0.5.4.tgz /whatsapp-rust-bridge-0.5.4.tgz
ADD --chmod=0444 --checksum=sha256:38ae8b4e3926453bd8b23f5a0b134c0599ae51c47c1d20eedde56cf06fb4878b https://registry.npmjs.org/win-guid/-/win-guid-0.2.1.tgz /win-guid-0.2.1.tgz
ADD --chmod=0444 --checksum=sha256:aff3730d91b7b1e143822956d14608f563163cf11b9d0ae602df1fe1e430fdfb https://registry.npmjs.org/wrappy/-/wrappy-1.0.2.tgz /wrappy-1.0.2.tgz
ADD --chmod=0444 --checksum=sha256:dc2763952a24bf15dc920830a2d2884c23bccc08a853e8556e34771401254fa5 https://registry.npmjs.org/@types/ws/-/ws-8.18.1.tgz /ws-8.18.1.tgz
ADD --chmod=0444 --checksum=sha256:d08b726b3aae3a0fed5218a0d9a4b2ac8d75d4ad453a9271db55fe38e94eb4cf https://registry.npmjs.org/ws/-/ws-8.21.0.tgz /ws-8.21.0.tgz
ADD --chmod=0444 --checksum=sha256:d2cbb69eb9d502a5248d79232b18d7fcbf23c9d33b8045f9bc01250650d98dd4 https://registry.npmjs.org/wsl-utils/-/wsl-utils-0.1.0.tgz /wsl-utils-0.1.0.tgz
ADD --chmod=0444 --checksum=sha256:a80c78aa276536615891ef66efbc17d3bd07c8cb14e3bd5298eed3006bfa4d49 https://registry.npmjs.org/yallist/-/yallist-4.0.0.tgz /yallist-4.0.0.tgz
ADD --chmod=0444 --checksum=sha256:ee38f17f533fd500610685a483ae2f413c26f4eb33a51684314563c8d60f279c https://registry.npmjs.org/zod/-/zod-4.4.3.tgz /zod-4.4.3.tgz

FROM scratch AS openclaw-managed-messaging-npm-common-archives
COPY --from=openclaw-managed-messaging-npm-common-archives-1 / /
COPY --from=openclaw-managed-messaging-npm-common-archives-2 / /
COPY --from=openclaw-managed-messaging-npm-common-archives-3 / /

# hadolint ignore=DL3006
FROM openclaw-managed-messaging-npm-common-archives AS openclaw-managed-messaging-npm-amd64-archives

ADD --chmod=0444 --checksum=sha256:67a7e52a3d0990dcac2e9e3f3be52a7a31500202a3248725922ae0a42f902fa8 https://registry.npmjs.org/@snazzah/davey-linux-x64-gnu/-/davey-linux-x64-gnu-0.1.12.tgz /davey-linux-x64-gnu-0.1.12.tgz
ADD --chmod=0444 --checksum=sha256:836b7b1c248d96e9c29082dfe8e5c5fa565aed2c6dda205c2f0d933efd796069 https://registry.npmjs.org/@snazzah/davey-linux-x64-musl/-/davey-linux-x64-musl-0.1.12.tgz /davey-linux-x64-musl-0.1.12.tgz

# hadolint ignore=DL3006
FROM openclaw-managed-messaging-npm-common-archives AS openclaw-managed-messaging-npm-arm64-archives

ADD --chmod=0444 --checksum=sha256:b99b75f3f91e908c5417417f8df58d5487e953ddae2b9f286f28baa353cd0603 https://registry.npmjs.org/@snazzah/davey-linux-arm64-gnu/-/davey-linux-arm64-gnu-0.1.12.tgz /davey-linux-arm64-gnu-0.1.12.tgz
ADD --chmod=0444 --checksum=sha256:a6fda898620be2c49d477a0b266f4be3a9eb16da47426d99dc089509922c32d5 https://registry.npmjs.org/@snazzah/davey-linux-arm64-musl/-/davey-linux-arm64-musl-0.1.12.tgz /davey-linux-arm64-musl-0.1.12.tgz

# hadolint ignore=DL3006
FROM openclaw-managed-messaging-npm-${TARGETARCH}-archives AS openclaw-managed-messaging-npm-archives

# Keep the complete managed-image messaging dependency graph inert for normal
# Dockerfile builds. Release-image builds select the exact-lock cache stage.
FROM node:22-trixie-slim@sha256:db8a96a63e5264607ada2d206758876ebbed6a12be2ada7517793cbfb0c2a29c AS openclaw-managed-messaging-npm-cache-0
RUN install -d -o root -g root -m 0755 /out/npm-cache

FROM node:22-trixie-slim@sha256:db8a96a63e5264607ada2d206758876ebbed6a12be2ada7517793cbfb0c2a29c AS openclaw-managed-messaging-npm-cache-1
ARG TARGETARCH
ENV NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false
COPY agents/openclaw/managed-image-messaging-runtime/package.json agents/openclaw/managed-image-messaging-runtime/package-lock.json /opt/managed-image-messaging-runtime/
COPY scripts/checks/materialize-locked-npm-cache-seed.mts /opt/nemoclaw-build-tools/checks/
COPY scripts/lib/reviewed-npm-archive.mts scripts/lib/seed-reviewed-npm-cache.mts /opt/nemoclaw-build-tools/lib/
COPY --from=openclaw-managed-messaging-npm-archives / /opt/nemoclaw-build-tools/npm-cache-seed/
RUN --network=none set -eu; \
    case "$TARGETARCH" in \
        amd64) npm_target_cpu=x64 ;; \
        arm64) npm_target_cpu=arm64 ;; \
        *) echo "ERROR: unsupported managed messaging npm target: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    install -d -o root -g root -m 0755 /out/npm-cache; \
    node --experimental-strip-types /opt/nemoclaw-build-tools/lib/seed-reviewed-npm-cache.mts \
        --lockfile /opt/managed-image-messaging-runtime/package-lock.json \
        --cache /out/npm-cache \
        --registry-origin https://registry.npmjs.org/ \
        --archive-directory /opt/nemoclaw-build-tools/npm-cache-seed \
        --os linux --cpu "$npm_target_cpu" --libc glibc; \
    NPM_CONFIG_OFFLINE=true npm ci --prefix /opt/managed-image-messaging-runtime \
        --ignore-scripts --omit=dev --legacy-peer-deps \
        --userconfig /dev/null --registry https://registry.npmjs.org/ \
        --cache /out/npm-cache; \
    node --experimental-strip-types /opt/nemoclaw-build-tools/lib/seed-reviewed-npm-cache.mts \
        --packuments-only \
        --lockfile /opt/managed-image-messaging-runtime/package-lock.json \
        --cache /out/npm-cache \
        --registry-origin https://registry.npmjs.org/; \
    npm cache verify --cache /out/npm-cache; \
    rm -rf /opt/managed-image-messaging-runtime/node_modules \
        /opt/nemoclaw-build-tools/npm-cache-seed; \
    chown -R root:root /out/npm-cache; \
    chmod -R a+rX,go-w /out/npm-cache

# hadolint ignore=DL3006
FROM openclaw-managed-messaging-npm-cache-${NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION} AS openclaw-managed-messaging-npm-cache

# Group repository-owned files outside the final image so both Docker builders
# can collapse related payloads without invalidating earlier final-image work.
FROM scratch AS openclaw-dependency-payload

COPY agents/openclaw/openclaw-runtime/package.json /usr/local/lib/nemoclaw/openclaw-runtime/package.json
COPY agents/openclaw/openclaw-runtime/package-lock.json /usr/local/lib/nemoclaw/openclaw-runtime/package-lock.json
COPY agents/openclaw/mcporter-runtime/package.json /usr/local/lib/nemoclaw/mcporter-runtime/package.json
COPY agents/openclaw/mcporter-runtime/package-lock.json /usr/local/lib/nemoclaw/mcporter-runtime/package-lock.json
COPY agents/openclaw/wechat-runtime/package.json /usr/local/lib/nemoclaw/wechat-runtime/package.json
COPY agents/openclaw/wechat-runtime/package-lock.json /usr/local/lib/nemoclaw/wechat-runtime/package-lock.json
COPY ci/npm-audit-exceptions.json /scripts/npm-audit-exceptions.json
COPY scripts/lib/reviewed-npm-archive.mts /scripts/lib/reviewed-npm-archive.mts
COPY scripts/lib/bundled-npm-package.mts /scripts/lib/bundled-npm-package.mts
COPY scripts/lib/reviewed-npm-audit.mts /scripts/lib/reviewed-npm-audit.mts
COPY scripts/lib/openclaw-npm-remediation.mts /scripts/lib/openclaw-npm-remediation.mts
COPY scripts/patch-bundled-npm-brace-expansion.mts /scripts/patch-bundled-npm-brace-expansion.mts
COPY scripts/lib/patch-bundled-npm-ip-address.mts /scripts/lib/patch-bundled-npm-ip-address.mts
COPY scripts/patch-bundled-npm-tar.mts /scripts/patch-bundled-npm-tar.mts

FROM scratch AS openclaw-plugin-payload

COPY --from=builder /opt/nemoclaw/dist/ /opt/nemoclaw/dist/
COPY nemoclaw/openclaw.plugin.json /opt/nemoclaw/
COPY nemoclaw-blueprint/ /opt/nemoclaw-blueprint/

FROM scratch AS openclaw-patch-payload

COPY scripts/patch-openclaw-tool-catalog.mts /usr/local/lib/nemoclaw/patch-openclaw-tool-catalog.mts
COPY scripts/patch-openclaw-chat-send.mts /usr/local/lib/nemoclaw/patch-openclaw-chat-send.mts
COPY scripts/patch-openclaw-mcp-npx.mts /usr/local/lib/nemoclaw/patch-openclaw-mcp-npx.mts
COPY scripts/patch-openclaw-mcp-reliability.mts /usr/local/lib/nemoclaw/patch-openclaw-mcp-reliability.mts
COPY scripts/patch-openclaw-mcp-tools-list-timeout.mts /usr/local/lib/nemoclaw/patch-openclaw-mcp-tools-list-timeout.mts
COPY scripts/patch-openclaw-issue-4434-diagnostics.mts /usr/local/lib/nemoclaw/patch-openclaw-issue-4434-diagnostics.mts
COPY scripts/patch-openclaw-managed-transport-diagnostics.mts /usr/local/lib/nemoclaw/patch-openclaw-managed-transport-diagnostics.mts
COPY scripts/patch-openclaw-device-self-approval.mts /usr/local/lib/nemoclaw/patch-openclaw-device-self-approval.mts
COPY scripts/openclaw/patch-gateway-daemon-dialback.mts /usr/local/lib/nemoclaw/patch-openclaw-gateway-daemon-dialback.mts
COPY scripts/extract-semver.sh /usr/local/lib/nemoclaw/extract-semver
COPY scripts/patch-openclaw-shared-state-permissions.mts /usr/local/lib/nemoclaw/patch-openclaw-shared-state-permissions.mts
COPY scripts/verify-wechat-runtime-lock.mts /usr/local/lib/nemoclaw/verify-wechat-runtime-lock.mts

FROM scratch AS openclaw-runtime-payload

COPY scripts/lib/sandbox-init.sh /usr/local/lib/nemoclaw/sandbox-init.sh
COPY --chmod=0444 scripts/lib/corporate-ca-runtime.sh /usr/local/lib/nemoclaw/corporate-ca-runtime.sh
COPY scripts/lib/entrypoint-env-wrapper.sh /usr/local/lib/nemoclaw/entrypoint-env-wrapper.sh
COPY scripts/lib/gateway-supervisor.sh /usr/local/lib/nemoclaw/gateway-supervisor.sh
COPY scripts/lib/sandbox-rlimits.sh /usr/local/lib/nemoclaw/sandbox-rlimits.sh
COPY scripts/lib/openclaw_device_approval_policy.py /usr/local/lib/nemoclaw/openclaw_device_approval_policy.py
COPY scripts/lib/clean_runtime_shell_env_shim.py /usr/local/lib/nemoclaw/clean_runtime_shell_env_shim.py
COPY scripts/lib/normalize_mutable_config_perms.py /usr/local/lib/nemoclaw/normalize_mutable_config_perms.py
COPY scripts/state-dir-guard.py /usr/local/lib/nemoclaw/state-dir-guard.py
COPY agents/openclaw/state-lock-plan.json /usr/local/share/nemoclaw/state-lock-plan.json
COPY scripts/openclaw-config-guard.py /usr/local/lib/nemoclaw/openclaw-config-guard.py
COPY scripts/managed-gateway-control.py /usr/local/lib/nemoclaw/managed-gateway-control.py
COPY scripts/nemoclaw-start.sh /usr/local/bin/nemoclaw-start
COPY scripts/managed-startup-hold.sh /usr/local/bin/nemoclaw-managed-startup-hold
COPY --from=managed-bootstrap-entrypoint-builder /out/usr/local/bin/nemoclaw-managed-bootstrap /usr/local/bin/nemoclaw-managed-bootstrap
COPY --from=managed-bootstrap-entrypoint-builder /out/usr/local/lib/nemoclaw/managed-bootstrap-trampoline.sh /usr/local/lib/nemoclaw/managed-bootstrap-trampoline.sh
COPY scripts/gateway-control.sh /usr/local/bin/nemoclaw-gateway-control
COPY nemoclaw-blueprint/scripts/*.js /usr/local/lib/nemoclaw/preloads/
COPY --from=runtime-preload-builder /opt/nemoclaw-root/dist/lib/messaging/channels/ /usr/local/lib/nemoclaw/preloads-compiled-channels/
COPY scripts/codex-acp-wrapper.sh /usr/local/bin/nemoclaw-codex-acp
COPY scripts/generate-openclaw-config.mts /scripts/generate-openclaw-config.mts
COPY scripts/validate-openclaw-tool-search.mts /scripts/validate-openclaw-tool-search.mts
COPY --from=managed-startup-runtime-builder /out/managed-startup-image-runtime.cjs /usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs
COPY src/lib/tool-disclosure.ts /src/lib/tool-disclosure.ts
COPY nemoclaw-blueprint/openclaw-plugins/ /usr/local/share/nemoclaw/openclaw-plugins/
COPY --from=mcp-tool-discovery-runtime /opt/mcp-tool-discovery-runtime/dist/ /usr/local/lib/nemoclaw/mcp-tool-discovery-runtime/

# Stage 3: Runtime image — pull cached base from GHCR
# hadolint ignore=DL3006
FROM ${BASE_IMAGE}
ARG BASE_IMAGE
# OpenShell blocks the link-local EC2 Instance Metadata Service. Keep AWS SDK
# credential chains from attempting an impossible metadata discovery path.
ENV AWS_EC2_METADATA_DISABLED=true

# Upgrade the final runtime even when an install or rebuild starts from a
# published sandbox base with Node 22.22.2. OpenClaw 2026.7.1 requires the
# SQLite WAL fix in Node 22.22.3 or newer. The trusted managed-image staging
# path removes this one instruction when it has just built Dockerfile.base from
# the same Node image, avoiding a redundant 125 MB layer in that local-only case.
COPY --from=builder /usr/local/bin/node /usr/local/bin/node

# Dependency review evidence for this runtime pin lives in
# internal/security-reviews/openclaw-2026.7.1-dependency-review.md.
ARG OPENCLAW_VERSION=2026.7.1
ARG OPENCLAW_2026_7_1_INTEGRITY=sha512-ge/Xss99CHAjPL/ikmH/UFoiOrjcxDB4sW3y9mhyCD+dYW3wzV7TKbAVdkrXFgAG2d2BjpJofP97zUZ+umxo8g==
ARG OPENCLAW_2026_7_1_TARBALL=https://registry.npmjs.org/openclaw/-/openclaw-2026.7.1.tgz
ARG OPENCLAW_DIAGNOSTICS_OTEL_2026_7_1_INTEGRITY=sha512-XXhMifYWTgoR6yFN4T3JkHxdPvQCe8k1cNZjVIgXNmk1svCdBWuALfQQicmpemlmWwauIQuHYgBURY6k63e+rw==
ARG OPENCLAW_BRAVE_PLUGIN_2026_7_1_INTEGRITY=sha512-7Z+GZ/6K6a8LlkTsWVnAZ1hv8EarORzHQvFHD7ekcg033FGJOXYPEZSbvvE3qR9vM+vnoZplNjMZ7vFMRcvQgw==
# E2E-only legacy fixture pins used by stale-sandbox/rebuild tests that
# intentionally build an older OpenClaw base image before proving upgrade
# behavior. Production workflows reject the fixture flag, both legacy version
# values, and these four pin overrides before docker build. Only explicit
# fixture paths may select them; retirement is tracked in #5896 section 9.
ARG NEMOCLAW_E2E_FIXTURE_LEGACY_OPENCLAW=0
ARG OPENCLAW_2026_3_11_INTEGRITY=sha512-bxwiBmHPakwfpY5tqC9lrV5TCu5PKf0c1bHNc3nhrb+pqKcPEWV4zOjDVFLQUHr98ihgWA+3pacy4b3LQ8wduQ==
ARG OPENCLAW_2026_3_11_TARBALL=https://registry.npmjs.org/openclaw/-/openclaw-2026.3.11.tgz
ARG OPENCLAW_2026_4_24_INTEGRITY=sha512-W6u4XeIIP4+uG4DYV9G3JeS6QNuKwfhQIej1GIoL4BdcnUFgrnB8kHYNXL3MxiHRKuhZB9OYwUMGs8jKFZR/Vg==
ARG OPENCLAW_2026_4_24_TARBALL=https://registry.npmjs.org/openclaw/-/openclaw-2026.4.24.tgz
# Keep the mcporter version, integrity, runtime lock, license, and advisory baseline
# synchronized with agents/openclaw/dependency-review.md.
ARG MCPORTER_VERSION=0.7.3
ARG MCPORTER_0_7_3_INTEGRITY=sha512-egoPVYqTnWb3NjRIxo+xc8OrAI0dlPrJm9pAiZx0pImuNIV5rKhGtTnIfH/Y1ldGPVu74ibj3KR5c9U/QSdQFA==
ARG MCPORTER_0_7_3_TARBALL=https://registry.npmjs.org/mcporter/-/mcporter-0.7.3.tgz

# A cross-stage root copy is accepted by Docker's legacy builder and creates one
# final-image layer while preserving metadata on existing parent directories.
COPY --from=openclaw-dependency-payload / /

# OpenClaw 2026.7.1 loads some generated source through jiti. Disable its
# filesystem transform cache so source fragments that mention provider marker
# names do not persist under /tmp/jiti inside the sandbox.
ENV JITI_FS_CACHE=false

# Base64-encoded host corporate-proxy CA bundle (#6210). Empty by default. When
# onboard detects an operator-supplied corporate CA on the host it bakes it
# here; the RUN below decodes it to a root-owned file that the entrypoint
# appends to the OpenShell trust bundle at runtime. The CA is a public
# certificate, not a secret, so baking it into an image layer is acceptable.
ARG NEMOCLAW_CORPORATE_CA_B64

# Decode the host corporate-proxy CA (#6210) to a root-owned, read-only file
# when onboard baked one in. No-op when NEMOCLAW_CORPORATE_CA_B64 is empty. The
# ARG is expanded by the shell (not interpolated into source), and its value is
# base64 sanitized host-side, so this is not an injection vector.
# hadolint ignore=DL3059,DL4006
RUN if [ -n "${NEMOCLAW_CORPORATE_CA_B64}" ]; then \
      command -v base64 >/dev/null 2>&1 || { echo "[nemoclaw] base64 is required to decode NEMOCLAW_CORPORATE_CA_B64 but is not installed in the build image" >&2; exit 1; }; \
      command -v openssl >/dev/null 2>&1 || { echo "[nemoclaw] openssl is required to validate NEMOCLAW_CORPORATE_CA_B64 but is not installed in the build image (#6210)" >&2; exit 1; }; \
      command -v update-ca-certificates >/dev/null 2>&1 || { echo "[nemoclaw] update-ca-certificates is required to anchor NEMOCLAW_CORPORATE_CA_B64 for the OpenShell proxy" >&2; exit 1; }; \
      case "${NEMOCLAW_CORPORATE_CA_B64}" in *[!A-Za-z0-9+/=]*) echo "[nemoclaw] NEMOCLAW_CORPORATE_CA_B64 is not valid base64; expected a single-line base64-encoded PEM (#6210)" >&2; exit 1 ;; esac; \
      mkdir -p /usr/local/share/nemoclaw /usr/local/share/ca-certificates \
      && { printf '%s' "${NEMOCLAW_CORPORATE_CA_B64}" | base64 --decode > /tmp/nemoclaw-corporate-ca.decoded 2>/dev/null \
           || { echo "[nemoclaw] NEMOCLAW_CORPORATE_CA_B64 is not valid base64; expected a single-line base64-encoded PEM (#6210)" >&2; exit 1; }; } \
      && awk '/-----BEGIN CERTIFICATE-----/{f=1} f{print} /-----END CERTIFICATE-----/{f=0}' /tmp/nemoclaw-corporate-ca.decoded > /usr/local/share/nemoclaw/corporate-ca.pem \
      && rm -f /tmp/nemoclaw-corporate-ca.decoded \
      && { grep -qF -- "-----BEGIN CERTIFICATE-----" /usr/local/share/nemoclaw/corporate-ca.pem || { echo "[nemoclaw] NEMOCLAW_CORPORATE_CA_B64 did not decode to a bundle of valid X.509 certificates (#6210)" >&2; exit 1; }; } \
      && { openssl crl2pkcs7 -nocrl -certfile /usr/local/share/nemoclaw/corporate-ca.pem >/dev/null 2>&1 || { echo "[nemoclaw] NEMOCLAW_CORPORATE_CA_B64 did not decode to a bundle of valid X.509 certificates (#6210)" >&2; exit 1; }; } \
      && node -e 'const fs = require("node:fs"); const { X509Certificate } = require("node:crypto"); const pemPath = process.argv[1]; const anchorDir = process.argv[2]; const pem = fs.readFileSync(pemPath, "utf8"); const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g); if (!blocks?.length) process.exit(1); fs.writeFileSync(pemPath, blocks.map((block) => block.trim()).join("\n") + "\n"); blocks.forEach((block, index) => { if (!new X509Certificate(block).ca) process.exit(1); const name = anchorDir + "/nemoclaw-corporate-ca-" + String(index + 1).padStart(2, "0") + ".crt"; fs.writeFileSync(name, block.trim() + "\n"); });' /usr/local/share/nemoclaw/corporate-ca.pem /usr/local/share/ca-certificates \
      && chown root:root /usr/local/share/nemoclaw/corporate-ca.pem /usr/local/share/ca-certificates/nemoclaw-corporate-ca-*.crt \
      && chmod 0444 /usr/local/share/nemoclaw/corporate-ca.pem /usr/local/share/ca-certificates/nemoclaw-corporate-ca-*.crt \
      && update-ca-certificates \
      && echo "[nemoclaw] baked host corporate-proxy CA into image trust (#6210)"; \
    fi

# Use the corporate CA for build-time Node TLS only when onboarding supplied
# it. The runtime entrypoint builds its own merged OpenShell and corporate
# bundle.

# The final image owns the shipped dependency boundary independently of base
# freshness. Reassert the idempotent npm-private fixes after corporate CA setup
# so cold registry-backed remediation can use the operator-supplied trust root.
RUN if [ -f /usr/local/share/nemoclaw/corporate-ca.pem ]; then \
      export CURL_CA_BUNDLE=/usr/local/share/nemoclaw/corporate-ca.pem; \
      export NODE_EXTRA_CA_CERTS=/usr/local/share/nemoclaw/corporate-ca.pem; \
    fi; \
    node --experimental-strip-types /scripts/patch-bundled-npm-tar.mts \
      --npm-root /usr/local/lib/node_modules/npm

# Reassert the npm-private brace-expansion fix for the exact final filesystem.
# hadolint ignore=DL3059
RUN if [ -f /usr/local/share/nemoclaw/corporate-ca.pem ]; then \
      export CURL_CA_BUNDLE=/usr/local/share/nemoclaw/corporate-ca.pem; \
      export NODE_EXTRA_CA_CERTS=/usr/local/share/nemoclaw/corporate-ca.pem; \
    fi; \
    node --experimental-strip-types /scripts/patch-bundled-npm-brace-expansion.mts \
      --npm-root /usr/local/lib/node_modules/npm

# Reassert the npm-private ip-address fix for the exact final filesystem. When
# onboarding supplied a corporate CA, use it for the registry-backed download.
# hadolint ignore=DL3059
RUN if [ -f /usr/local/share/nemoclaw/corporate-ca.pem ]; then \
      export CURL_CA_BUNDLE=/usr/local/share/nemoclaw/corporate-ca.pem; \
      export NODE_EXTRA_CA_CERTS=/usr/local/share/nemoclaw/corporate-ca.pem; \
    fi; \
    node --experimental-strip-types /scripts/lib/patch-bundled-npm-ip-address.mts \
      --npm-root /usr/local/lib/node_modules/npm

# Harden: remove unnecessary build tools and network probes from base image (#830)
# Protect runtime tools before autoremove — the GHCR base may predate the
# procps/e2fsprogs/tmux additions, leaving ps/chattr/tmux absent or auto-marked.
# The conditional install keeps stale bases usable while fresh bases skip apt.
# tmux is required by OpenClaw's bundled tmux-session flow (#4513); a stale base
# without it makes that flow fail with `tmux: command not found`.
# Refs: #2343, #4513, shields-up chattr hardening
# hadolint ignore=DL3001
RUN set -eu; \
    apt-mark manual procps e2fsprogs tmux 2>/dev/null || true; \
    (apt-get remove --purge -y gcc gcc-12 g++ g++-12 cpp cpp-12 make \
        netcat-openbsd netcat-traditional ncat 2>/dev/null || true); \
    apt-get autoremove --purge -y; \
    needs_ps=0; \
    needs_chattr=0; \
    needs_tmux=0; \
    if ! command -v ps >/dev/null 2>&1; then needs_ps=1; fi; \
    if ! command -v chattr >/dev/null 2>&1; then needs_chattr=1; fi; \
    if ! command -v tmux >/dev/null 2>&1; then needs_tmux=1; fi; \
    if [ "$needs_ps" = "1" ] || [ "$needs_chattr" = "1" ] || [ "$needs_tmux" = "1" ]; then \
        apt-get update; \
        if [ "$needs_ps" = "1" ]; then \
            apt-get install -y --no-install-recommends procps=2:4.0.4-9; \
        fi; \
        if [ "$needs_chattr" = "1" ]; then \
            apt-get install -y --no-install-recommends e2fsprogs=1.47.2-3+b11; \
        fi; \
        if [ "$needs_tmux" = "1" ]; then \
            apt-get install -y --no-install-recommends tmux=3.5a-3; \
        fi; \
    fi; \
    rm -rf /var/lib/apt/lists/*; \
    ps --version; \
    command -v chattr >/dev/null; \
    command -v tmux >/dev/null


# Install runtime dependencies before copying mutable build outputs so source
# and blueprint changes keep the production dependency layer cached.
COPY nemoclaw/package.json nemoclaw/package-lock.json /opt/nemoclaw/
COPY tools/mcp-tool-discovery-runtime/npm-ci-locked.sh /usr/local/lib/nemoclaw-build-tools/npm-ci-locked.sh
COPY tools/mcp-tool-discovery-runtime/npm-cache-seed/ /usr/local/lib/nemoclaw-build-tools/npm-cache-seed/
WORKDIR /opt/nemoclaw
ENV NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_MAXSOCKETS=4 \
    NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=1000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=20000 \
    NPM_CONFIG_FETCH_TIMEOUT=60000
RUN --network=default if [ -f /usr/local/share/nemoclaw/corporate-ca.pem ]; then \
      export CURL_CA_BUNDLE=/usr/local/share/nemoclaw/corporate-ca.pem; \
      export NODE_EXTRA_CA_CERTS=/usr/local/share/nemoclaw/corporate-ca.pem; \
    fi; \
    NODE_OPTIONS=--dns-result-order=ipv4first \
        /usr/local/lib/nemoclaw-build-tools/npm-ci-locked.sh --omit=dev \
    && rm -rf /usr/local/lib/nemoclaw-build-tools/npm-cache-seed \
    && rm -f /usr/local/lib/nemoclaw-build-tools/npm-ci-locked.sh

# Copy the grouped plugin and blueprint payload after runtime dependency
# installation so source-only changes do not invalidate that cache boundary.
COPY --from=openclaw-plugin-payload / /

# Copy built plugin and blueprint into the sandbox
RUN chmod -R a+rX /opt/nemoclaw /opt/nemoclaw-blueprint/

# The builder-stage verify-openshell-policy-boundary-dependencies.mts check is
# the primary security gate: it enforces the generated boundary's strict module
# dependency allowlist before this stage copies it. The node check below is
# defense in depth only and proves the copied runtime still exports the complete
# audited interface; function availability does not replace dependency lockdown.
RUN test -f /usr/local/bin/node \
    && test -d /opt/nemoclaw/node_modules/json5 \
    && node -e 'const boundary = require("/opt/nemoclaw/dist/shared/openshell-policy-boundary.cjs"); for (const name of ["parseOpenShellPolicy", "stripProviderComposedPolicies", "withoutProviderComposedPolicies"]) { if (typeof boundary[name] !== "function") throw new Error("OpenShell policy boundary export is unavailable: " + name); }' \
    && node_unsafe="$(find -L /usr/local/bin/node -maxdepth 0 \( ! -user root -o -perm /022 \) -print -quit)" \
    && test -z "$node_unsafe" \
    && json5_unsafe="$(find -L /opt/nemoclaw/node_modules/json5 \( ! -user root -o -perm /022 \) -print -quit)" \
    && test -z "$json5_unsafe"
# Reviewed-archive invariants (#5896): the dedicated build stage materializes
# the exact lock, seeds resolver metadata, and re-packs every archive offline
# before this root-owned immutable cache enters the final image.
COPY --from=wechat-npm-cache /out/wechat-npm-cache/ /usr/local/share/nemoclaw/wechat-npm-cache/
COPY --from=openclaw-patch-payload / /

RUN chmod 755 /usr/local/lib/nemoclaw/patch-openclaw-tool-catalog.mts \
        /usr/local/lib/nemoclaw/patch-openclaw-chat-send.mts \
        /usr/local/lib/nemoclaw/patch-openclaw-mcp-npx.mts \
        /usr/local/lib/nemoclaw/patch-openclaw-mcp-reliability.mts \
        /usr/local/lib/nemoclaw/patch-openclaw-mcp-tools-list-timeout.mts \
        /usr/local/lib/nemoclaw/patch-openclaw-issue-4434-diagnostics.mts \
        /usr/local/lib/nemoclaw/patch-openclaw-managed-transport-diagnostics.mts \
        /usr/local/lib/nemoclaw/patch-openclaw-device-self-approval.mts \
        /usr/local/lib/nemoclaw/patch-openclaw-gateway-daemon-dialback.mts \
        /usr/local/lib/nemoclaw/extract-semver \
        /usr/local/lib/nemoclaw/patch-openclaw-shared-state-permissions.mts \
        /usr/local/lib/nemoclaw/verify-wechat-runtime-lock.mts

# Pre-install the codex-acp package so the embedded ACPx runtime can
# call the local binary instead of `npx @zed-industries/codex-acp`.
#
# The sandbox's L7 proxy denies @zed-industries/* package URLs
# (403 policy_denied), and npm still refreshes registry metadata for
# versioned npx package specs even when the package is globally installed.
# Installing the binary at build time and configuring ACPx to use it
# directly keeps TC-SBX-02 off the runtime npm path.
# The architecture-selected installer stage consumes checksum-addressed local
# archives with the network disabled, verifies their committed SRI values, and
# installs both the launcher and its native package together.
#
# hadolint ignore=DL3059,DL4006,DL3016
COPY --from=codex-acp-runtime /usr/local/lib/node_modules/@zed-industries/ /usr/local/lib/node_modules/@zed-industries/
COPY --from=codex-acp-runtime /usr/local/bin/codex-acp /usr/local/bin/codex-acp
RUN command -v codex-acp >/dev/null

# Upgrade OpenClaw if the base image is stale.
# Reuse exact OpenClaw and locked-mcporter base installs only from a published
# NemoClaw base whose package provenance marker matches this build target;
# otherwise reinstall both.
#
# The GHCR base image (sandbox-base:latest) may lag behind the version pinned in
# Dockerfile.base, and legacy/custom bases may report the target version without
# proving which archive and lifecycle produced it. The marker records package
# and advisory-audit metadata, not trusted-CI signature attestation. Only a
# digest-pinned base from the official GHCR publication path supplies that
# independent gate. Mutable tags and local bases cannot authorize reuse even
# when their marker matches; the existing version checks reinstall the locked
# runtimes or reject a newer base. The final image consumes the marker before
# applying NemoClaw patches so a custom base cannot masquerade as a pristine
# published base.
#
# OPENCLAW_VERSION is the NemoClaw runtime build target. It must be at least the
# blueprint minimum, which also supports the legacy direct-blueprint image path.
# Reviewed-archive invariants (#5896): registry SRI, packed-byte SRI, contained
# basename in a fresh directory, local-archive-only install, and cleanup.
# hadolint ignore=DL3059,DL4006,DL3016
RUN --network=default set -eu; \
    if [ -f /usr/local/share/nemoclaw/corporate-ca.pem ]; then \
        export CURL_CA_BUNDLE=/usr/local/share/nemoclaw/corporate-ca.pem; \
        export NODE_EXTRA_CA_CERTS=/usr/local/share/nemoclaw/corporate-ca.pem; \
    fi; \
    echo "$OPENCLAW_VERSION" | grep -qxE '[0-9]+(\.[0-9]+)*' \
        || { echo "ERROR: OPENCLAW_VERSION='$OPENCLAW_VERSION' is invalid (expected e.g. 2026.3.11)" >&2; exit 1; }; \
    MIN_VER=$(grep -m 1 'min_openclaw_version' /opt/nemoclaw-blueprint/blueprint.yaml | awk '{print $2}' | tr -d '"'); \
    [ -n "$MIN_VER" ] || { echo "ERROR: Could not parse min_openclaw_version from blueprint.yaml" >&2; exit 1; }; \
    if [ "$(printf '%s\n%s' "$MIN_VER" "$OPENCLAW_VERSION" | sort -V | head -n1)" != "$MIN_VER" ]; then \
        echo "ERROR: OpenClaw build target ${OPENCLAW_VERSION} is below blueprint minimum ${MIN_VER}" >&2; exit 1; \
    fi; \
    if [ "$OPENCLAW_VERSION" = "2026.3.11" ] || [ "$OPENCLAW_VERSION" = "2026.4.24" ]; then \
        if [ "$NEMOCLAW_E2E_FIXTURE_LEGACY_OPENCLAW" != "1" ]; then \
            echo "ERROR: OpenClaw ${OPENCLAW_VERSION} is a legacy E2E fixture pin; set NEMOCLAW_E2E_FIXTURE_LEGACY_OPENCLAW=1 for stale-upgrade fixture builds" >&2; exit 1; \
        fi; \
    fi; \
    EXPECTED_INTEGRITY=""; \
    EXPECTED_TARBALL=""; \
    if [ "$OPENCLAW_VERSION" = "2026.7.1" ]; then EXPECTED_INTEGRITY="$OPENCLAW_2026_7_1_INTEGRITY"; EXPECTED_TARBALL="$OPENCLAW_2026_7_1_TARBALL"; fi; \
    if [ "$OPENCLAW_VERSION" = "2026.3.11" ]; then EXPECTED_INTEGRITY="$OPENCLAW_2026_3_11_INTEGRITY"; EXPECTED_TARBALL="$OPENCLAW_2026_3_11_TARBALL"; fi; \
    if [ "$OPENCLAW_VERSION" = "2026.4.24" ]; then EXPECTED_INTEGRITY="$OPENCLAW_2026_4_24_INTEGRITY"; EXPECTED_TARBALL="$OPENCLAW_2026_4_24_TARBALL"; fi; \
    if [ -z "$EXPECTED_INTEGRITY" ]; then \
        echo "ERROR: OpenClaw ${OPENCLAW_VERSION} has no committed npm integrity pin" >&2; exit 1; \
    fi; \
    OPENCLAW_LOCK_SHA256=none-legacy-fixture; \
    OPENCLAW_RECIPE='ignore-scripts+reviewed-lifecycle-v1'; \
    if [ "$OPENCLAW_VERSION" = "2026.7.1" ]; then \
        OPENCLAW_LOCK_SHA256=60f816dcff6f35179b1c48b4c06db9473497760d45ca1831252c27e8b1d2d665; \
        ACTUAL_OPENCLAW_LOCK_SHA256="$(sha256sum /usr/local/lib/nemoclaw/openclaw-runtime/package-lock.json | awk '{print $1}')"; \
        [ "$ACTUAL_OPENCLAW_LOCK_SHA256" = "$OPENCLAW_LOCK_SHA256" ] \
            || { echo "ERROR: OpenClaw lock SHA-256 mismatch (expected $OPENCLAW_LOCK_SHA256, found $ACTUAL_OPENCLAW_LOCK_SHA256)" >&2; exit 1; }; \
        OPENCLAW_RECIPE='locked-ci+reviewed-lifecycle-v2'; \
    elif [ "$OPENCLAW_VERSION" = "2026.3.11" ]; then \
        OPENCLAW_RECIPE='ignore-scripts+reviewed-lifecycle+transitive-remediation-v1'; \
    fi; \
    MCPORTER_EXPECTED_INTEGRITY=""; \
    MCPORTER_EXPECTED_TARBALL=""; \
    if [ "$MCPORTER_VERSION" = "0.7.3" ]; then MCPORTER_EXPECTED_INTEGRITY="$MCPORTER_0_7_3_INTEGRITY"; MCPORTER_EXPECTED_TARBALL="$MCPORTER_0_7_3_TARBALL"; fi; \
    if [ -z "$MCPORTER_EXPECTED_INTEGRITY" ]; then \
        echo "ERROR: mcporter ${MCPORTER_VERSION} has no committed npm integrity pin" >&2; exit 1; \
    fi; \
    MCPORTER_LOCK_SHA256="$(sha256sum /usr/local/lib/nemoclaw/mcporter-runtime/package-lock.json | awk '{print $1}')"; \
    [ -n "$MCPORTER_LOCK_SHA256" ] \
        || { echo "ERROR: Could not hash the committed mcporter lockfile" >&2; exit 1; }; \
    MCPORTER_AUDIT_POLICY_SHA256="$(sha256sum /scripts/npm-audit-exceptions.json | awk '{print $1}')"; \
    MCPORTER_EXPECTED_AUDIT_EXCEPTIONS="$(node --experimental-strip-types --input-type=module -e \
        'import fs from "node:fs"; import { parseAuditExceptionRegistry } from "/scripts/lib/reviewed-npm-audit.mts"; const policy=parseAuditExceptionRegistry(fs.readFileSync("/scripts/npm-audit-exceptions.json", "utf-8")); const ids=policy.exceptions.filter((entry)=>entry.graph==="mcporter-runtime").map((entry)=>entry.advisory).sort(); process.stdout.write(ids.join(",") || "none");')"; \
    MCPORTER_EXPECTED_AUDIT_STATUS=clean; \
    if [ "$MCPORTER_EXPECTED_AUDIT_EXCEPTIONS" != "none" ]; then MCPORTER_EXPECTED_AUDIT_STATUS=accepted-exceptions; fi; \
    CUR_VER_OUTPUT="$(openclaw --version 2>/dev/null)" \
        || { echo "ERROR: Could not execute openclaw --version" >&2; exit 1; }; \
    CUR_VER="$(printf '%s\n' "$CUR_VER_OUTPUT" | /usr/local/lib/nemoclaw/extract-semver openclaw)" \
        || { echo "ERROR: Could not parse OpenClaw version output" >&2; exit 1; }; \
    CUR_MCPORTER_VER=$(mcporter --version 2>/dev/null || true); \
    CUR_MCPORTER_VER="${CUR_MCPORTER_VER:-0.0.0}"; \
    OPENCLAW_PROVENANCE_PATH=/usr/local/share/nemoclaw/openclaw-base-provenance-v1; \
    OPENCLAW_EXPECTED_PROVENANCE="$(mktemp)"; \
    printf '%s\n' \
        'schema=4' \
        "package=openclaw@${OPENCLAW_VERSION}" \
        "integrity=${EXPECTED_INTEGRITY}" \
        "tarball=${EXPECTED_TARBALL}" \
        "lock-sha256=${OPENCLAW_LOCK_SHA256}" \
        "recipe=${OPENCLAW_RECIPE}" \
        "mcporter-package=mcporter@${MCPORTER_VERSION}" \
        "mcporter-integrity=${MCPORTER_EXPECTED_INTEGRITY}" \
        "mcporter-tarball=${MCPORTER_EXPECTED_TARBALL}" \
        "mcporter-lock-sha256=${MCPORTER_LOCK_SHA256}" \
        "mcporter-audit-policy-sha256=${MCPORTER_AUDIT_POLICY_SHA256}" \
        "mcporter-audit-status=${MCPORTER_EXPECTED_AUDIT_STATUS}" \
        "mcporter-audit-exceptions=${MCPORTER_EXPECTED_AUDIT_EXCEPTIONS}" \
        'mcporter-recipe=locked-ci+reviewed-audit-v3' \
        > "$OPENCLAW_EXPECTED_PROVENANCE"; \
    CI_GATED_BASE_IMAGE=0; \
    case "$BASE_IMAGE" in \
        ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:*) CI_GATED_BASE_IMAGE=1 ;; \
    esac; \
    USE_REVIEWED_BASE_RUNTIME=0; \
    if [ "$CI_GATED_BASE_IMAGE" = "1" ] \
        && [ -f "$OPENCLAW_PROVENANCE_PATH" ] \
        && [ ! -L "$OPENCLAW_PROVENANCE_PATH" ] \
        && [ "$(stat -c '%u:%g:%a' "$OPENCLAW_PROVENANCE_PATH" 2>/dev/null || true)" = "0:0:444" ] \
        && cmp -s "$OPENCLAW_EXPECTED_PROVENANCE" "$OPENCLAW_PROVENANCE_PATH" \
        && [ "$CUR_VER" = "$OPENCLAW_VERSION" ] \
        && [ "$CUR_MCPORTER_VER" = "$MCPORTER_VERSION" ]; then \
        USE_REVIEWED_BASE_RUNTIME=1; \
    fi; \
    rm -f "$OPENCLAW_EXPECTED_PROVENANCE"; \
    rm -rf "$OPENCLAW_PROVENANCE_PATH"; \
    if [ "$USE_REVIEWED_BASE_RUNTIME" = "1" ]; then \
        echo "INFO: Reusing reviewed base OpenClaw $CUR_VER with exact provenance"; \
    elif [ "$(printf '%s\n%s' "$OPENCLAW_VERSION" "$CUR_VER" | sort -V | head -n1)" = "$OPENCLAW_VERSION" ] \
        && [ "$CUR_VER" != "$OPENCLAW_VERSION" ]; then \
        echo "ERROR: Base image has OpenClaw $CUR_VER, which is newer than reviewed target $OPENCLAW_VERSION" >&2; exit 1; \
    else \
        echo "INFO: Base image OpenClaw $CUR_VER lacks exact reviewed provenance; installing $OPENCLAW_VERSION"; \
        # npm 10's atomic-move install can hit EROFS on overlayfs when the prior
        # install spans image layers. Removing it first also prevents unreviewed
        # files from surviving a same-version reinstall.
        rm -rf /usr/local/lib/node_modules/openclaw /usr/local/bin/openclaw; \
        if [ "$OPENCLAW_VERSION" = "2026.7.1" ]; then \
            node --experimental-strip-types /scripts/lib/reviewed-npm-archive.mts --verify-lock \
                --lock-sha256 "$OPENCLAW_LOCK_SHA256" \
                --lockfile /usr/local/lib/nemoclaw/openclaw-runtime/package-lock.json \
                --registry-origin https://registry.npmjs.org/ \
                --package-spec "openclaw@${OPENCLAW_VERSION}" --integrity "$EXPECTED_INTEGRITY" \
                --tarball-url "$EXPECTED_TARBALL" --label "OpenClaw ${OPENCLAW_VERSION}"; \
            npm --prefix /usr/local/lib/nemoclaw/openclaw-runtime ci \
                --ignore-scripts --omit=dev --no-audit --no-fund --no-progress \
                --userconfig /dev/null --registry https://registry.npmjs.org/; \
            node --experimental-strip-types /scripts/lib/reviewed-npm-archive.mts \
                --verify-installed-lock --lock-sha256 "$OPENCLAW_LOCK_SHA256" \
                --lockfile /usr/local/lib/nemoclaw/openclaw-runtime/package-lock.json \
                --install-root /usr/local/lib/nemoclaw/openclaw-runtime \
                --label "OpenClaw ${OPENCLAW_VERSION}"; \
            node /usr/local/lib/nemoclaw/openclaw-runtime/node_modules/openclaw/scripts/postinstall-bundled-plugins.mjs; \
            mkdir -p /usr/local/lib/node_modules; \
            ln -s /usr/local/lib/nemoclaw/openclaw-runtime/node_modules/openclaw /usr/local/lib/node_modules/openclaw; \
            ln -s /usr/local/lib/nemoclaw/openclaw-runtime/node_modules/.bin/openclaw /usr/local/bin/openclaw; \
        else \
            OPENCLAW_SOURCE_PACK_PATH="$(node --experimental-strip-types /scripts/lib/reviewed-npm-archive.mts \
                --package-spec "openclaw@${OPENCLAW_VERSION}" --integrity "$EXPECTED_INTEGRITY" \
                --tarball-url "$EXPECTED_TARBALL" --label "OpenClaw ${OPENCLAW_VERSION}")"; \
            OPENCLAW_PACK_PATH="$OPENCLAW_SOURCE_PACK_PATH"; \
            OPENCLAW_PACK_DIR="$(dirname "$OPENCLAW_PACK_PATH")"; \
            if [ "$OPENCLAW_VERSION" = "2026.3.11" ]; then \
                OPENCLAW_REMEDIATION_JSON="$(node --experimental-strip-types /scripts/lib/openclaw-npm-remediation.mts \
                    --archive "$OPENCLAW_SOURCE_PACK_PATH" --package-spec "openclaw@${OPENCLAW_VERSION}" \
                    --working-directory "$OPENCLAW_PACK_DIR")"; \
                OPENCLAW_PACK_PATH="$(node -e 'const value = JSON.parse(process.argv[1]); if (!value.remediated || typeof value.archivePath !== "string") process.exit(1); process.stdout.write(value.archivePath)' "$OPENCLAW_REMEDIATION_JSON")"; \
            fi; \
            npm install -g --no-audit --no-fund --no-progress --ignore-scripts "$OPENCLAW_PACK_PATH"; \
            case "$OPENCLAW_VERSION" in \
                2026.4.24) node /usr/local/lib/node_modules/openclaw/scripts/postinstall-bundled-plugins.mjs ;; \
                2026.3.11) ;; \
                *) echo "ERROR: OpenClaw ${OPENCLAW_VERSION} has no reviewed lifecycle policy" >&2; exit 1 ;; \
            esac; \
            rm -rf "$OPENCLAW_PACK_DIR"; \
        fi; \
    fi; \
    case "$OPENCLAW_VERSION" in \
        2026.3.11) npm ls -g --depth=1 openclaw tar >/dev/null ;; \
    esac; \
    if [ "$USE_REVIEWED_BASE_RUNTIME" = "1" ]; then \
        echo "INFO: Reusing reviewed base mcporter $CUR_MCPORTER_VER with exact lock provenance"; \
    else \
        node --experimental-strip-types /scripts/lib/reviewed-npm-archive.mts --verify-only \
            --package-spec "mcporter@${MCPORTER_VERSION}" --integrity "$MCPORTER_EXPECTED_INTEGRITY" \
            --tarball-url "$MCPORTER_EXPECTED_TARBALL" --label "mcporter ${MCPORTER_VERSION}"; \
        # Reinstall from the committed lock when exact protected base provenance
        # is unavailable; matching top-level versions can hide transitive drift.
        echo "INFO: Installing locked mcporter $MCPORTER_VERSION dependency graph"; \
        rm -rf /usr/local/lib/node_modules/mcporter /usr/local/bin/mcporter; \
        npm --prefix /usr/local/lib/nemoclaw/mcporter-runtime ci \
            --ignore-scripts --omit=dev --no-audit --no-fund --no-progress; \
        npm --prefix /usr/local/lib/nemoclaw/mcporter-runtime ls \
            --omit=dev --all @hono/node-server @modelcontextprotocol/sdk hono mcporter >/dev/null; \
        node --input-type=module -e \
            'const { StreamableHTTPServerTransport } = await import("file:///usr/local/lib/nemoclaw/mcporter-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/server/streamableHttp.js"); const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined }); await transport.close();'; \
        ln -s /usr/local/lib/nemoclaw/mcporter-runtime/node_modules/.bin/mcporter /usr/local/bin/mcporter; \
        test "$(mcporter --version)" = "$MCPORTER_VERSION"; \
        node --experimental-strip-types /scripts/lib/reviewed-npm-audit.mts \
            --directory /usr/local/lib/nemoclaw/mcporter-runtime \
            --exceptions /scripts/npm-audit-exceptions.json --graph mcporter-runtime --threshold high; \
    fi

# Patch OpenClaw media fetch for proxy-only sandbox (NVIDIA/NemoClaw#1755).
#
# NemoClaw forces all sandbox egress through the OpenShell L7 proxy
# (default 10.200.0.1:3128). Two layers of OpenClaw must be patched for
# Telegram/Discord/Slack media downloads to work in this environment:
#
# === Patch 1: redirect strict-mode export to trusted-env-proxy ===
# OpenClaw's media fetch path (fetch-ClF-ZgDC.js → fetchRemoteMedia) calls
# fetchWithSsrFGuard(withStrictGuardedFetchMode({...})) unconditionally.
# Strict mode does DNS-pinning + direct connect, which fails in the sandbox
# netns where only the proxy is reachable. Rewriting the fetch-guard module
# export so the strict alias maps to withTrustedEnvProxyGuardedFetchMode
# makes the existing callsite request proxy mode without touching callers.
# The export pattern `withStrictGuardedFetchMode as <letter>` is stable
# across versions while alias letters drift between minified bundles.
# Files that define withStrictGuardedFetchMode locally without an export
# (e.g. mattermost.js) keep their original strict behavior.
#
# === Patch 2: env-gated bypass for assertExplicitProxyAllowed ===
# OpenClaw 2026.4.2 added assertExplicitProxyAllowed() in fetch-guard,
# which validates the explicit proxy URL by passing the proxy hostname
# through resolvePinnedHostnameWithPolicy() with the *target's* SsrfPolicy.
# When the target uses hostnameAllowlist (Telegram media policy:
# `["api.telegram.org"]`), the proxy hostname (e.g. 10.200.0.1) gets
# rejected with "Blocked hostname (not in allowlist)". This is an upstream
# OpenClaw design flaw: a proxy is infrastructure, not a fetch target, and
# should not be filtered through the target's allowlist.
#
# Inject an early-return guarded by `process.env.OPENSHELL_SANDBOX === "1"`
# so the bypass only activates inside an OpenShell sandbox runtime, which
# is what NemoClaw deploys into. OpenShell injects this env var when it
# starts a sandbox pod; any consumer running the same openclaw bundle
# outside an OpenShell sandbox (bare-metal, another wrapper) does not have
# OPENSHELL_SANDBOX set and keeps the full upstream SSRF check. The L7
# proxy itself enforces per-endpoint network policy inside the sandbox,
# so the trust boundary for SSRF protection is unchanged.
#
# Image-level `ENV` does NOT work here: OpenShell controls the pod env at
# runtime and image ENV vars set by Dockerfile are stripped. OPENSHELL_SANDBOX
# is the only marker reliably present in the runtime.
#
# === Patch 2b: allow OpenShell host gateway through web_fetch guard ===
# OpenClaw's web_fetch SSRF guard blocks *.internal hostnames before the
# OpenShell L7 proxy sees the request. NemoClaw users legitimately reach
# host-local approved services through host.openshell.internal after the
# OpenShell policy explicitly allows that host:port. Add this exact hostname
# only to the web_fetch trusted-env-proxy policy, only inside an OpenShell
# sandbox. The generic SSRF helper and strict/direct DNS-pinned paths remain
# unmodified, so metadata/link-local/private IP literals are unchanged.
#
# === Patch 4: route unconfigured strict SSRF fetches through the egress proxy ===
# (NVIDIA/NemoClaw#4687). fetchWithSsrFGuard builds a per-request DNS-pinned
# *direct* undici dispatcher for STRICT-mode fetches that pass no explicit
# dispatcherPolicy — e.g. the @openclaw/googlechat inbound JWT signing-cert
# fetch from www.googleapis.com/service_accounts/v1/metadata/x509/.... A direct
# dispatcher ignores the global EnvHttpProxyAgent installed by
# NODE_USE_ENV_PROXY=1, so the request never reaches the OpenShell L7 proxy and
# fails in the proxy-only sandbox netns — rejecting every inbound Google Chat
# webhook. OpenClaw already has a "managed proxy" branch that routes such
# fetches through the env proxy (createHttp1EnvHttpProxyAgent) while still
# resolving + SSRF-validating the target hostname, but it is gated on
# isManagedProxyActive() (OPENCLAW_PROXY_ACTIVE=1), which NemoClaw does not set.
# Inside an OpenShell sandbox the configured egress proxy IS the managed proxy,
# so extend that activation to OPENSHELL_SANDBOX=1 for fetches that supply no
# explicit dispatcherPolicy. Explicit-proxy and direct(mTLS) dispatcher policies
# (Google auth proxy / client-cert paths) keep their existing behavior, and
# resolvePinnedHostnameWithPolicy still blocks private/link-local targets.
#
# === Removal criteria ===
# Patch 1: drop when OpenClaw deprecates withStrictGuardedFetchMode or
#   when all media-fetch callsites unconditionally pass useEnvProxy.
# Patch 2: drop when OpenClaw fixes assertExplicitProxyAllowed to skip the
#   target hostname allowlist for the proxy hostname check (or exposes config
#   to disable the check).
# Patch 2b: drop when OpenClaw ships a reviewed web_fetch trusted-proxy SSRF
#   policy surface that can allow host.openshell.internal without allowing
#   broader private/special-use hostnames.
# Patch 4: drop when OpenClaw routes unconfigured strict fetches through the
#   env proxy in proxy-only environments without OPENCLAW_PROXY_ACTIVE, or when
#   NemoClaw sets OPENCLAW_PROXY_ACTIVE=1 in the sandbox runtime instead.
#
# SYNC WITH OPENCLAW: these patches classify the compiled OpenClaw dist at
# build time. They apply the legacy patch when the old target exists, skip
# only when the dist shape proves OpenClaw no longer needs that patch, and
# fail with the OpenClaw version plus dist path for mixed or unknown shapes.
# When bumping OPENCLAW_VERSION, verify the new dist
# takes the expected branch and update the regex / sed replacement if needed.
# hadolint ignore=SC2016,DL3059,DL4006
RUN set -eu; \
    OC_DIST=/usr/local/lib/node_modules/openclaw/dist; \
    OC_VERSION_OUTPUT="$(openclaw --version 2>/dev/null)" \
        || { echo "ERROR: Could not execute openclaw --version" >&2; exit 1; }; \
    OC_VERSION="$(printf '%s\n' "$OC_VERSION_OUTPUT" | /usr/local/lib/nemoclaw/extract-semver openclaw)" \
        || { echo "ERROR: Could not parse OpenClaw version output" >&2; exit 1; }; \
    patch_fail() { \
        echo "ERROR: OpenClaw ${OC_VERSION} fetch-guard patch cannot classify this dist shape: $*" >&2; \
        echo "       Inspect ${OC_DIST} and update the Dockerfile patch rules for this OpenClaw layout." >&2; \
        exit 1; \
    }; \
    # --- Patch 1: rewrite fetch-guard export --- \
    fg_export="$(grep -RIlE --include='*.js' 'export \{[^}]*withStrictGuardedFetchMode as [a-z]' "$OC_DIST" || true)"; \
    if [ -n "$fg_export" ]; then \
        for f in $fg_export; do \
            grep -q 'withTrustedEnvProxyGuardedFetchMode' "$f" || patch_fail "Patch 1 target $f is missing withTrustedEnvProxyGuardedFetchMode"; \
        done; \
        printf '%s\n' "$fg_export" | xargs sed -i -E 's|withStrictGuardedFetchMode as ([a-z])|withTrustedEnvProxyGuardedFetchMode as \1|g'; \
        if grep -REq --include='*.js' 'withStrictGuardedFetchMode as [a-z]' "$OC_DIST"; then echo "ERROR: Patch 1 left strict-mode export alias" >&2; exit 1; fi; \
        echo "INFO: Patch 1 applied to OpenClaw ${OC_VERSION} strict fetch export"; \
    else \
        strict_refs="$(grep -RIl --include='*.js' 'withStrictGuardedFetchMode' "$OC_DIST" || true)"; \
        trusted_refs="$(grep -RIl --include='*.js' 'withTrustedEnvProxyGuardedFetchMode' "$OC_DIST" || true)"; \
        media_fetch_files="$(grep -RIl --include='*.js' 'fetchGuardedMediaResponse' "$OC_DIST" || true)"; \
        trusted_media_fetch=0; \
        untrusted_media_fetch=0; \
        for f in $media_fetch_files; do \
            if ! grep -q 'fetchWithSsrFGuard' "$f"; then \
                continue; \
            elif grep -E 'fetchWithSsrFGuard' "$f" | grep -q 'withTrustedEnvProxyGuardedFetchMode' \
                && ! grep -E 'fetchWithSsrFGuard' "$f" | grep -vq 'withTrustedEnvProxyGuardedFetchMode'; then \
                trusted_media_fetch=1; \
            else \
                echo "ERROR: Patch 1 unreviewed media fetch shape in $f" >&2; \
                untrusted_media_fetch=1; \
            fi; \
        done; \
        if [ "$OC_VERSION" != "unknown" ] && [ -z "$strict_refs" ] && [ -n "$trusted_refs" ] && [ "$trusted_media_fetch" = "1" ] && [ "$untrusted_media_fetch" = "0" ]; then \
            echo "INFO: OpenClaw ${OC_VERSION} has no withStrictGuardedFetchMode references; Patch 1 not needed"; \
        elif [ -z "$trusted_refs" ]; then \
            patch_fail "Patch 1 target missing and withTrustedEnvProxyGuardedFetchMode is also absent"; \
        else \
            echo "ERROR: Patch 1 target missing but the fetch-guard shape is not a reviewed trusted-proxy-only layout:" >&2; \
            if [ -n "$strict_refs" ]; then printf '%s\n' "$strict_refs" | head -n 5 >&2; fi; \
            patch_fail "Patch 1 cannot safely skip"; \
        fi; \
    fi; \
    # --- Patch 2: neutralize assertExplicitProxyAllowed --- \
    fg_assert="$(grep -RIlE --include='*.js' 'async function assertExplicitProxyAllowed' "$OC_DIST" || true)"; \
    if [ -n "$fg_assert" ]; then \
        patched_assert=0; \
        for f in $fg_assert; do \
            if grep -q 'process.env.OPENSHELL_SANDBOX === "1"' "$f"; then \
                echo "INFO: Patch 2 already present in $f"; \
            else \
                sed -i -E 's|(async function assertExplicitProxyAllowed\([^)]*\) \{)|\1 if (process.env.OPENSHELL_SANDBOX === "1") return; /* nemoclaw: env-gated bypass, see Dockerfile */ |' "$f"; \
                grep -Eq 'assertExplicitProxyAllowed\([^)]*\) \{ if \(process\.env\.OPENSHELL_SANDBOX === "1"\) return; /\* nemoclaw' "$f" \
                    || patch_fail "Patch 2 verification failed for $f"; \
                patched_assert=1; \
            fi; \
        done; \
        if [ "$patched_assert" = "1" ]; then \
            echo "INFO: Patch 2 applied to OpenClaw ${OC_VERSION} explicit proxy validator"; \
        fi; \
    else \
        proxy_hostname_checks="$(grep -RIlE --include='*.js' 'resolvePinnedHostnameWithPolicy' "$OC_DIST" | while IFS= read -r f; do \
            if grep -Eq 'parsedProxyUrl|proxyUrl|proxyHostname|proxy.*[Hh]ostname|[Hh]ostname.*proxy|allowPrivateProxy' "$f"; then \
                printf '%s\n' "$f"; \
            fi; \
        done || true)"; \
        if [ -z "$proxy_hostname_checks" ]; then \
            echo "INFO: OpenClaw ${OC_VERSION} has no assertExplicitProxyAllowed proxy hostname validator; Patch 2 not needed"; \
        else \
            echo "ERROR: Patch 2 target missing but proxy hostname validation references remain:" >&2; \
            printf '%s\n' "$proxy_hostname_checks" | head -n 5 >&2; \
            patch_fail "Patch 2 cannot safely skip"; \
        fi; \
    fi; \
    # --- Patch 2b: allow OpenShell host gateway only through web_fetch trusted env proxy --- \
    # Reviewed against openclaw@2026.7.1 dist: fetchWithWebToolsNetworkGuard \
    # passes useEnvProxy into withTrustedEnvProxyGuardedFetchMode(resolved), and \
    # the SSRF guard consumes policy.allowedHostnames to skip private-network \
    # checks for an exact normalized hostname. hostnameAllowlist only gates \
    # hostname pattern matching and does not bypass .internal/private blocking. \
    # Executable fixture proof lives in test/security/fetch-guard-patch-regression.test.ts; \
    # the live network-policy E2E exercises this path in the assembled image. \
    web_guard_files="$(grep -RIlE --include='*.js' 'function fetchWithWebToolsNetworkGuard\(params\)' "$OC_DIST" || true)"; \
    if [ -n "$web_guard_files" ]; then \
        patched_host_gateway=0; \
        for f in $web_guard_files; do \
            if grep -q 'nemoclaw: OpenShell host gateway for web_fetch trusted env proxy' "$f"; then \
                echo "INFO: Patch 2b already present in $f"; \
            else \
                grep -q 'withTrustedEnvProxyGuardedFetchMode(resolved)' "$f" \
                    || patch_fail "Patch 2b target $f is missing reviewed trusted env-proxy web_fetch call"; \
                sed -i -E 's|return fetchWithSsrFGuard\(useEnvProxy \? withTrustedEnvProxyGuardedFetchMode\(resolved\) : withStrictGuardedFetchMode\(resolved\)\);|const hostGatewayPolicy = process.env.OPENSHELL_SANDBOX === "1" \&\& useEnvProxy \&\& new URL(resolved.url).hostname === "host.openshell.internal" ? { ...resolved.policy, allowedHostnames: [...resolved.policy?.allowedHostnames ?? [], "host.openshell.internal"] } : resolved.policy; return fetchWithSsrFGuard(useEnvProxy ? withTrustedEnvProxyGuardedFetchMode({ ...resolved, policy: hostGatewayPolicy }) : withStrictGuardedFetchMode(resolved)); /* nemoclaw: OpenShell host gateway for web_fetch trusted env proxy, see Dockerfile */|' "$f"; \
                grep -Fq 'process.env.OPENSHELL_SANDBOX === "1" && useEnvProxy && new URL(resolved.url).hostname === "host.openshell.internal"' "$f" \
                    || patch_fail "Patch 2b verification failed for $f"; \
                patched_host_gateway=1; \
            fi; \
        done; \
        if [ "$patched_host_gateway" = "1" ]; then \
            echo "INFO: Patch 2b applied to OpenClaw ${OC_VERSION} web_fetch trusted-proxy host-gateway policy"; \
        fi; \
    else \
        web_fetch_proxy_refs="$(grep -RIlE --include='*.js' 'web_fetch|useEnvProxy|useTrustedEnvProxy|withTrustedEnvProxyGuardedFetchMode\(resolved\)' "$OC_DIST" || true)"; \
        if [ -z "$web_fetch_proxy_refs" ]; then \
            echo "INFO: OpenClaw ${OC_VERSION} has no web_fetch trusted env-proxy callsite; Patch 2b not needed"; \
        else \
            echo "ERROR: Patch 2b target missing but web_fetch/trusted-proxy references remain:" >&2; \
            printf '%s\n' "$web_fetch_proxy_refs" | head -n 5 >&2; \
            patch_fail "Patch 2b cannot safely skip"; \
        fi; \
    fi; \
    # --- Patch 4: route unconfigured strict fetches through the sandbox egress proxy (#4687) --- \
    # Reviewed against openclaw@2026.7.1 dist fetch-guard: the STRICT-mode \
    # managed-proxy gate is `mode === GUARDED_FETCH_MODE.STRICT && \
    # isManagedProxyActive()`. Extend activation to OPENSHELL_SANDBOX=1 only \
    # for fetches with no explicit dispatcherPolicy so \
    # the per-request direct dispatcher reuses the env proxy (EnvHttpProxyAgent) \
    # like the managed-proxy path already does; explicit-proxy / direct dispatcher \
    # policies and out-of-sandbox behavior are unchanged. \
    mp_files="$(grep -RIlF --include='*.js' 'const isStrictManagedProxyActive = mode === GUARDED_FETCH_MODE.STRICT && isManagedProxyActive();' "$OC_DIST" || true)"; \
    if [ -n "$mp_files" ]; then \
        patched_managed_proxy=0; \
        for f in $mp_files; do \
            if grep -q 'nemoclaw: route unconfigured strict fetch' "$f"; then \
                echo "INFO: Patch 4 already present in $f"; \
            else \
                sed -i -E 's#const isStrictManagedProxyActive = mode === GUARDED_FETCH_MODE\.STRICT \&\& isManagedProxyActive\(\);#const isStrictManagedProxyActive = mode === GUARDED_FETCH_MODE.STRICT \&\& (isManagedProxyActive() || (process.env.OPENSHELL_SANDBOX === "1" \&\& !dispatcherPolicy)); /* nemoclaw: route unconfigured strict fetch through sandbox egress proxy, see Dockerfile */#' "$f"; \
                grep -Fq 'process.env.OPENSHELL_SANDBOX === "1" && !dispatcherPolicy' "$f" \
                    || patch_fail "Patch 4 verification failed for $f"; \
                patched_managed_proxy=1; \
            fi; \
        done; \
        if [ "$patched_managed_proxy" = "1" ]; then \
            echo "INFO: Patch 4 applied to OpenClaw ${OC_VERSION} managed-proxy strict-fetch activation"; \
        fi; \
    else \
        managed_proxy_refs="$(grep -RIlE --include='*.js' 'canUseManagedProxy|isStrictManagedProxyActive' "$OC_DIST" || true)"; \
        if [ -z "$managed_proxy_refs" ]; then \
            echo "INFO: OpenClaw ${OC_VERSION} has no managed-proxy strict-fetch gate; Patch 4 not needed"; \
        else \
            echo "ERROR: Patch 4 target missing but managed-proxy references remain:" >&2; \
            printf '%s\n' "$managed_proxy_refs" | head -n 5 >&2; \
            patch_fail "Patch 4 cannot safely skip"; \
        fi; \
    fi; \
    # --- Patch 6: cron model-provider preflight opts into trusted env-proxy mode --- \
    # Reviewed against openclaw@2026.7.1 dist: the cron isolated-agent preflight \
    # (`probeLocalProviderEndpoint`) calls `fetchWithSsrFGuard` with \
    # `auditContext: "cron-model-provider-preflight"` and a narrow hostname-allowlist \
    # SsrFPolicy from `buildLocalProviderSsrFPolicy`, but does not pass a `mode`. \
    # Default STRICT mode pins DNS for the managed inference hostname \
    # (`inference.local`), which is intentionally only resolvable through the \
    # OpenShell L7 proxy — pinned `dns.lookup` therefore fails with EAI_AGAIN and \
    # the scheduler permanently skips every cron run. Inject \
    # `mode: "trusted_env_proxy"` so the call uses the env proxy dispatcher; SSRF \
    # protection is retained through the existing hostname allowlist and the \
    # proxy's own ACLs. \
    # \
    # The patch keys on the co-located shape of the reviewed preflight call: in \
    # any file that mentions the audit context literal, both the \
    # `fetchWithSsrFGuard(` helper and the `buildLocalProviderSsrFPolicy` policy \
    # builder must appear. The audit-property matcher tolerates quote and same-line \
    # whitespace changes; the audit literal itself must appear exactly once; and \
    # after patching exactly one patched literal must remain. Any ambiguous \
    # multi-callsite or mixed patched/unpatched layout fails the image build \
    # rather than silently widening the rewrite. \
    # \
    # Removal condition: drop this block (and any related `OC_VERSION` floor bump) \
    # once an OpenClaw release sets `mode: "trusted_env_proxy"` directly at the \
    # preflight call site or otherwise routes the managed inference base URL \
    # through the env-proxy dispatcher by default. The reviewed shape lives at \
    # `src/cron/isolated-agent/model-preflight.runtime.ts` in the openclaw repo. \
    preflight_files="$(grep -RIlF --include='*.js' 'cron-model-provider-preflight' "$OC_DIST" || true)"; \
    if [ -n "$preflight_files" ]; then \
        patched_preflight=0; \
        audit_pattern="auditContext[[:space:]]*:[[:space:]]*(\"cron-model-provider-preflight\"|'cron-model-provider-preflight')"; \
        patched_pattern="mode[[:space:]]*:[[:space:]]*(\"trusted_env_proxy\"|'trusted_env_proxy')[[:space:]]*,[[:space:]]*${audit_pattern}"; \
        for f in $preflight_files; do \
            audit_count="$( { grep -Eo "$audit_pattern" "$f" || true; } | awk 'END { print NR }')"; \
            [ "${audit_count:-0}" -ge 1 ] \
                || patch_fail "Patch 6 shape gate: $f mentions cron-model-provider-preflight but has no auditContext literal"; \
            [ "${audit_count:-0}" -eq 1 ] \
                || patch_fail "Patch 6 shape gate: $f has ${audit_count} auditContext literals (expected exactly 1); refusing ambiguous multi-callsite rewrite"; \
            grep -Fq 'fetchWithSsrFGuard(' "$f" \
                || patch_fail "Patch 6 shape gate: $f has cron-model-provider-preflight but no fetchWithSsrFGuard call"; \
            grep -Fq 'buildLocalProviderSsrFPolicy' "$f" \
                || patch_fail "Patch 6 shape gate: $f has cron-model-provider-preflight but no buildLocalProviderSsrFPolicy"; \
            patched_count="$( { grep -Eo "$patched_pattern" "$f" || true; } | awk 'END { print NR }')"; \
            if [ "${patched_count:-0}" -eq 1 ]; then \
                echo "INFO: Patch 6 already present in $f"; \
            elif [ "${patched_count:-0}" -eq 0 ]; then \
                sed -i -E "s#${audit_pattern}#mode: \"trusted_env_proxy\", &#g" "$f"; \
                new_patched_count="$( { grep -Eo "$patched_pattern" "$f" || true; } | awk 'END { print NR }')"; \
                [ "${new_patched_count:-0}" -eq 1 ] \
                    || patch_fail "Patch 6 verification: expected exactly one patched literal in $f, found ${new_patched_count}"; \
                patched_preflight=1; \
            else \
                patch_fail "Patch 6 shape gate: $f has ${patched_count} already-patched literals (expected 0 or 1); refusing mixed-state rewrite"; \
            fi; \
        done; \
        if [ "$patched_preflight" = "1" ]; then \
            echo "INFO: Patch 6 applied to OpenClaw ${OC_VERSION} cron preflight trusted env-proxy"; \
        fi; \
    else \
        preflight_refs="$(grep -RIlE --include='*.js' 'preflightCronModelProvider|probeLocalProviderEndpoint' "$OC_DIST" || true)"; \
        if [ -z "$preflight_refs" ]; then \
            echo "INFO: OpenClaw ${OC_VERSION} has no cron model-provider preflight; Patch 6 not needed"; \
        else \
            echo "ERROR: Patch 6 target missing but cron preflight references remain:" >&2; \
            printf '%s\n' "$preflight_refs" | head -n 5 >&2; \
            patch_fail "Patch 6 cannot safely skip"; \
        fi; \
    fi; \
    # --- Patch 3: follow symlinks in plugin-install path checks (#2203) --- \
    # OpenClaw's install-safe-path and install-package-dir reject symlinked \
    # directories via lstat. Changing lstat → stat in these two modules lets \
    # symlinks resolve; the real security gates (realpath + isPathInside \
    # containment) remain intact — a symlink escaping the base tree is still caught. \
    # Scoped to install-safe-path + install-package-dir only. \
    isp_file="$(grep -RIlE --include='*.js' 'const baseLstat = await fs\.(lstat|stat)\(baseDir\)' "$OC_DIST/install-safe-path-"*.js || true)"; \
    test -n "$isp_file" || { echo "ERROR: install-safe-path baseLstat pattern not found" >&2; exit 1; }; \
    sed -i 's/const baseLstat = await fs\.lstat(baseDir)/const baseLstat = await fs.stat(baseDir)/' "$isp_file"; \
    if grep -q 'const baseLstat = await fs\.lstat(baseDir)' "$isp_file"; then echo "ERROR: Patch 3a (install-safe-path) left baseLstat lstat call" >&2; exit 1; fi; \
    if ! grep -q 'const baseLstat = await fs\.stat(baseDir)' "$isp_file"; then echo "ERROR: Patch 3a (install-safe-path) did not find patched baseLstat stat call" >&2; exit 1; fi; \
    ipd_file="$(grep -RIlE --include='*.js' 'assertInstallBaseStable' "$OC_DIST/install-package-dir-"*.js || true)"; \
    test -n "$ipd_file" || { echo "ERROR: install-package-dir assertInstallBaseStable not found" >&2; exit 1; }; \
	    if grep -q 'const baseLstat = await fs\.lstat(params\.installBaseDir)' "$ipd_file"; then \
	        sed -i 's/const baseLstat = await fs\.lstat(params\.installBaseDir)/const baseLstat = await fs.stat(params.installBaseDir)/' "$ipd_file"; \
	        sed -i 's/baseLstat\.isSymbolicLink()/false \/* nemoclaw: symlink check disabled, realpath guards containment *\//' "$ipd_file"; \
	        if grep -q 'fs\.lstat(params\.installBaseDir)' "$ipd_file"; then echo "ERROR: Patch 3b (install-package-dir) left lstat in assertInstallBaseStable" >&2; exit 1; fi; \
	        if ! grep -q 'const baseLstat = await fs\.stat(params\.installBaseDir)' "$ipd_file" && ! grep -q 'await fs\.stat(params\.installBaseDir)).isDirectory()' "$ipd_file"; then echo "ERROR: Patch 3b (install-package-dir) did not find patched/safe installBaseDir stat call" >&2; exit 1; fi; \
	        if grep -q 'baseLstat\.isSymbolicLink()' "$ipd_file"; then echo "ERROR: Patch 3b (install-package-dir) left baseLstat symlink check" >&2; exit 1; fi; \
	    else \
	        grep -q 'await fs\.realpath(params\.installBaseDir) !== params\.expectedRealPath' "$ipd_file" || { echo "ERROR: install-package-dir lacks expected realpath stability guard" >&2; exit 1; }; \
	    fi; \
    # --- Patch 5: bump default WS handshake timeout 10s -> 60s (#2484) --- \
    # OpenClaw's WS connect handshake has a hard-coded 10s timeout on both \
    # client and server. Server-side connect-handler processing can exceed \
    # that limit under load (multiple concurrent connects on slow CI infra), \
    # causing `openclaw agent --json` to fail with "gateway timeout after \
    # <timeout>ms" and TC-SBX-02 to hit its 90s SSH timeout. \
    # \
    # Both env vars (OPENCLAW_HANDSHAKE_TIMEOUT_MS, \
    # OPENCLAW_CONNECT_CHALLENGE_TIMEOUT_MS) are clamped at the same \
    # DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS constant, so we patch the \
    # constant itself.  Affects both client.js (used by openclaw CLI) and \
    # server.impl.js (gateway side). \
    # \
    # Removal criteria: drop when openclaw fixes the underlying connect \
    # latency, or exposes the timeout as an unbounded env override. \
    hto_files="$(grep -RIlE --include='*.js' 'DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS = (1e4|15e3|6e4)' "$OC_DIST" || true)"; \
    test -n "$hto_files" || { echo "ERROR: handshake-timeout constant not found" >&2; exit 1; }; \
    printf '%s\n' "$hto_files" | xargs sed -i -E 's#DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS = (1e4|15e3)#DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS = 6e4#g'; \
    if grep -REq --include='*.js' 'DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS = (1e4|15e3)' "$OC_DIST"; then echo "ERROR: Patch 5 left a short handshake-timeout constant" >&2; exit 1; fi; \
    if ! grep -REq --include='*.js' 'DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS = 6e4' "$OC_DIST"; then echo "ERROR: Patch 5 did not find patched 6e4 constant" >&2; exit 1; fi

# Patch OpenClaw chat.send gateway behavior for OpenClaw 2026.7.1.
#
# OpenClaw can accept rapid TUI/WebChat chat.send requests and then emit a
# terminal chat event with state="final" but no assistant message for the later
# submitted run. That makes clients treat the turn as complete even though no
# visible reply was delivered. The shim also correlates real agent run IDs back
# to the submitted chat.send run ID when OpenClaw starts an internal run with a
# different ID, carries that submitted ID through queued follow-up turns, and
# adds the submitted run ID as the transcript idempotency key.
#
# Removal criteria: drop when upstream OpenClaw fixes openclaw/openclaw#70164
# and openclaw/openclaw#50298, or when NemoClaw no longer ships an affected OpenClaw.
# hadolint ignore=DL3059
RUN node --experimental-strip-types /usr/local/lib/nemoclaw/patch-openclaw-chat-send.mts \
    /usr/local/lib/node_modules/openclaw/dist

# Keep OpenClaw 2026.7.1 scope-upgrade approvals inside the gateway's
# canonical locked pairing writer (#4462). The upstream devices CLI otherwise
# asks for the very scopes it is trying to approve, so the handshake fails
# before device.pair.approve runs and its operator.admin retry fails likewise.
# This exact-dist patch allows only a signed, device-token-authenticated CLI to
# approve its own complete operator-only request while it already holds
# operator.pairing; the canonical pairing function repeats identity, role, and
# bounded-scope validation after acquiring its state lock.
#
# Removal criteria: drop when upstream OpenClaw can approve the same bounded
# self-upgrade through the gateway using only operator.pairing.
# hadolint ignore=DL3059
RUN node --experimental-strip-types /usr/local/lib/nemoclaw/patch-openclaw-device-self-approval.mts \
    /usr/local/lib/node_modules/openclaw/dist

# Keep backend RPC initiated by the OpenClaw gateway daemon on loopback while
# preserving OPENCLAW_GATEWAY_URL for agent processes that OpenShell requires
# to use the private sandbox interface. This avoids pairing failures when the
# transparent proxy makes gateway daemon self-dialback appear to originate from
# a private IP address and trigger pairing while preserving sessions_spawn
# routing (#7215).
#
# Removal criteria: drop when upstream OpenClaw distinguishes gateway daemon
# self-dialback from descendant agent routing without changing the inherited
# gateway URL.
# hadolint ignore=DL3059
RUN if [ "$OPENCLAW_VERSION" = "2026.7.1" ]; then \
      node --experimental-strip-types /usr/local/lib/nemoclaw/patch-openclaw-gateway-daemon-dialback.mts \
        /usr/local/lib/node_modules/openclaw/dist; \
    fi

# Patch OpenClaw TUI unreachable-inference diagnostics for #4434.
#
# OpenClaw 2026.7.1 formats sandbox inference egress failures as either generic
# `TypeError: fetch failed` or `LLM request timed out.` messages, which leave the
# TUI without the required HTTP/cause, gateway/upstream reporting layer, and
# recovery hint fields. This version-scoped shim enriches only those reviewed
# formatter paths, and only inside OpenShell sandboxes where
# OPENSHELL_SANDBOX=1 is supplied at runtime.
#
# Removal criteria: drop when upstream OpenClaw emits these structured fields
# from its assistant error formatter for unreachable inference failures.
# hadolint ignore=DL3059
RUN node --experimental-strip-types /usr/local/lib/nemoclaw/patch-openclaw-issue-4434-diagnostics.mts \
    /usr/local/lib/node_modules/openclaw/dist

# Patch OpenClaw's MCP stdio launcher so npx-backed MCP servers run with -y.
# Without this, npx can prompt on cold package resolution and consume the MCP
# JSON-RPC stdin pipe, causing the initialize handshake to time out.
#
# Removal criteria: drop when upstream OpenClaw normalizes npx MCP server args
# and emits actionable MCP startup timeout diagnostics.
# hadolint ignore=DL3059
RUN node --experimental-strip-types /usr/local/lib/nemoclaw/patch-openclaw-mcp-npx.mts \
    /usr/local/lib/node_modules/openclaw/dist

# Recover from a transient remote Streamable HTTP MCP startup failure. OpenClaw
# 2026.7.1 turns one reset or request timeout into an empty tool set plus
# catalog diagnostics, and keeps that degraded catalog for the whole session, so
# the agent reports the integration as unavailable until a new session starts.
# The patch retries a classified transient startup once with a fresh transport
# and drops a diagnostics-carrying catalog at the next agent run. Authentication,
# authorization, TLS, policy, and configuration failures are never retried.
#
# Removal criterion: drop when upstream OpenClaw provides bounded startup retry,
# negative-catalog invalidation, and temporary-transport failure attribution.
# hadolint ignore=DL3059
RUN node --experimental-strip-types /usr/local/lib/nemoclaw/patch-openclaw-mcp-reliability.mts \
    /usr/local/lib/node_modules/openclaw/dist

# Keep OpenClaw's 1,500 ms tools/list catalog timeout by default. A validated
# OpenClaw sandbox runtime setting can override only this discovery budget from
# 1,500 ms through 10,000 ms. Invalid direct runtime values stop OpenClaw before
# it connects to an MCP server.
#
# Removal criterion: drop when upstream OpenClaw exposes an equivalent bounded
# tools/list-only runtime setting.
# hadolint ignore=DL3059
RUN node --experimental-strip-types /usr/local/lib/nemoclaw/patch-openclaw-mcp-tools-list-timeout.mts \
    /usr/local/lib/node_modules/openclaw/dist

# Emit a redacted managed-transport diagnostic when a remote Streamable HTTP MCP
# request fails. OpenClaw 2026.7.1 surfaces only the transport error text, which
# does not say whether policy, CONNECT, TLS, the upstream connection, the
# request, or response headers failed. The fetch-boundary wrapper is
# failure-only by default, never retries, never alters the request, and never
# reads a 2xx body, so streaming responses stay behaviorally unchanged. Successful request
# timing is silent unless NEMOCLAW_MCP_SHADOW_DIAGNOSTICS=1 is explicitly
# forwarded into an OpenClaw sandbox. The wrapper is inert unless
# OPENSHELL_SANDBOX=1.
#
# Removal criterion: drop when upstream OpenClaw emits phase-classified,
# redacted transport diagnostics for remote MCP fetch failures.
# hadolint ignore=DL3059
RUN node --experimental-strip-types /usr/local/lib/nemoclaw/patch-openclaw-managed-transport-diagnostics.mts \
    /usr/local/lib/node_modules/openclaw/dist

# Run the compact tool catalog shim for OpenClaw selection runtimes that still
# need it. OpenClaw 2026.7.1 ships a built-in catalog surface, so the script
# skips cleanly after classifying the compiled selection-*.js shape.
# hadolint ignore=DL3059
RUN node --experimental-strip-types /usr/local/lib/nemoclaw/patch-openclaw-tool-catalog.mts \
    /usr/local/lib/node_modules/openclaw/dist

# OpenClaw 2026.7.1 moved gateway startup work into shared and per-agent SQLite
# databases, but hardens them to owner-only modes on every open. NemoClaw's
# root entrypoint runs the CLI and gateway as separate users in the sandbox
# group, so use group-shared modes only when that split-user runtime marker is
# present. Same-UID OpenShell sandboxes retain OpenClaw's private modes. The
# patch leaves generic credential and identity store enforcement unchanged,
# avoids a non-owner chmod when a reviewed shared database mode is already
# safe, keeps generated models files readable by the shared group, and ignores
# the obsolete update-check cache migration that cannot archive across a
# shields-protected parent.
#
# Removal criteria: drop when upstream OpenClaw supports a split-user,
# group-shared state databases and split-user cache migrations without
# startup warnings.
# hadolint ignore=DL3059
RUN node --experimental-strip-types /usr/local/lib/nemoclaw/patch-openclaw-shared-state-permissions.mts \
    /usr/local/lib/node_modules/openclaw/dist

# Set up blueprint for local resolution.
# Blueprints are immutable at runtime; DAC protection (root ownership) is applied
# later since /sandbox/.nemoclaw is Landlock read_write for plugin state (#804).
RUN mkdir -p /sandbox/.nemoclaw/blueprints/0.1.0 \
    && cp -r /opt/nemoclaw-blueprint/* /sandbox/.nemoclaw/blueprints/0.1.0/

# Copy only the configuration inputs needed by the expensive non-messaging
# offline plugin install. The full candidate runtime payload is copied after
# all offline installs so unrelated runtime changes retain these cached layers.
COPY scripts/generate-openclaw-config.mts /scripts/generate-openclaw-config.mts
COPY scripts/validate-openclaw-tool-search.mts /scripts/validate-openclaw-tool-search.mts
COPY src/lib/tool-disclosure.ts /src/lib/tool-disclosure.ts
COPY nemoclaw-blueprint/openclaw-plugins/ /usr/local/share/nemoclaw/openclaw-plugins/

RUN chmod 755 /scripts/generate-openclaw-config.mts \
        /scripts/validate-openclaw-tool-search.mts \
    && chmod 444 /src/lib/tool-disclosure.ts \
    && chmod 755 /usr/local/share/nemoclaw \
        /usr/local/share/nemoclaw/openclaw-plugins \
    && find /usr/local/share/nemoclaw/openclaw-plugins -type d -exec chmod 755 {} + \
    && find /usr/local/share/nemoclaw/openclaw-plugins -type f -exec chmod 644 {} +

# Build args for config that varies per deployment.
# nemoclaw onboard passes these at image build time.
ARG NEMOCLAW_MODEL=nvidia/nemotron-3-super-120b-a12b
ARG NEMOCLAW_INFERENCE_PROVIDER_ID=inference
# User-selected upstream provider (e.g. ollama-local, nim-local, nvidia-prod),
# carried separately from NEMOCLAW_INFERENCE_PROVIDER_ID, which identifies the
# managed route as "inference". generate-openclaw-config.mts reads this to apply
# provider-specific config such as the Local Ollama small-context compaction
# policy (#5468). Empty default keeps prior behavior when onboard does not supply
# a value.
ARG NEMOCLAW_UPSTREAM_PROVIDER=
ARG NEMOCLAW_PRIMARY_MODEL_REF=inference/nvidia/nemotron-3-super-120b-a12b
# Default dashboard port 18789 — override at runtime via NEMOCLAW_DASHBOARD_PORT.
ARG CHAT_UI_URL=http://127.0.0.1:18789
ARG NEMOCLAW_DASHBOARD_BIND=
# Internal audit provenance for WSL's default all-interface dashboard forward.
# Onboarding rewrites this for managed OpenClaw images built on WSL.
ARG NEMOCLAW_WSL_DASHBOARD_EXPOSURE=0
ARG NEMOCLAW_INFERENCE_BASE_URL=https://inference.local/v1
ARG NEMOCLAW_INFERENCE_API=openai-completions
ARG NEMOCLAW_CONTEXT_WINDOW=131072
ARG NEMOCLAW_MAX_TOKENS=4096
ARG NEMOCLAW_REASONING=false
ARG NEMOCLAW_REASONING_EFFORT=
ARG NEMOCLAW_TOOL_DISCLOSURE=progressive
# Comma-separated list of input modalities accepted by the primary model
# (e.g. "text" or "text,image" for vision-capable models). OpenClaw's
# model schema currently accepts "text" and "image". See #2421.
ARG NEMOCLAW_INFERENCE_INPUTS=text
# Per-request inference timeout (seconds) baked into agents.defaults.timeoutSeconds
# and models.providers.<provider-id>.timeoutSeconds.
# Increase for slow local inference (e.g., CPU Ollama). openclaw.json is
# immutable at runtime (Landlock read-only), so this can only be changed by
# rebuilding via `nemoclaw onboard`. Ref: issue #2281
ARG NEMOCLAW_AGENT_TIMEOUT=600
# Cadence for OpenClaw's periodic heartbeat
# (agents.defaults.heartbeat.every). Accepts Go-style durations like "30m",
# "5m", "1h"; "0m" disables heartbeat. Empty default preserves the OpenClaw
# built-in cadence. openclaw.json is immutable at runtime, so this can only
# change at image build time. Ref: issue #2880
ARG NEMOCLAW_AGENT_HEARTBEAT_EVERY=
ARG NEMOCLAW_INFERENCE_COMPAT_B64=e30=
# Base64-encoded messaging build plan for messaging build inputs and agent
# rendering. The plan contains placeholders only; secrets are resolved at
# runtime via OpenShell providers.
ARG NEMOCLAW_MESSAGING_PLAN_B64=
# Release-image mode preinstalls the complete reviewed optional dependency
# union. It is inert by default and must never be enabled for a deployment-
# specific Dockerfile build carrying an active messaging plan.
ARG NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION=0
# OpenShell requires USER sandbox as the image default. The managed-image
# publication workflow selects root to preserve gateway and agent UID isolation.
ARG NEMOCLAW_MANAGED_IMAGE_RUNTIME_USER=sandbox
# Base64-encoded JSON array of secondary OpenClaw agent config entries
# (e.g. [{"id":"research","workspace":"/sandbox/.openclaw/workspace-research",
# "agentDir":"/sandbox/.openclaw/agents/research", ...}]).
# Each entry is appended to agents.list[] after the canonical "main" entry, so
# the primary agent always remains the default. See generate-openclaw-config.mts
# for the validator. Default: empty array (W10= == base64("[]")).
ARG NEMOCLAW_EXTRA_AGENTS_JSON_B64=W10=
# Set to "1" to force-disable device-pairing auth. Also auto-disabled when
# CHAT_UI_URL is a non-loopback address (Brev Launchable, remote deployments)
# since terminal-based pairing is impossible in those contexts.
# Default: "0" (device auth enabled for local deployments — secure by default).
ARG NEMOCLAW_DISABLE_DEVICE_AUTH=0
# Internal audit provenance for the opt-out above. Standard onboarding rewrites
# this to managed-onboard; direct image builders retain operator provenance.
ARG NEMOCLAW_DEVICE_AUTH_OPT_OUT_SOURCE=operator
# Compatibility build arg for older custom Dockerfiles and rebuild tooling.
# NemoClaw-managed images intentionally do not consume it; gateway auth tokens
# are generated at container startup and are never baked into image layers.
ARG NEMOCLAW_BUILD_ID=default
# macOS OpenShell VM backend imports the Docker image into a virtiofs rootfs
# where image uid/gid ownership is presented as the host user. The VM also
# starts NemoClaw as the non-root sandbox user, so uid-owned 770/660 paths
# become unreadable unless this Darwin-only compatibility mode is enabled.
ARG NEMOCLAW_DARWIN_VM_COMPAT=0
# Sandbox egress proxy host/port. Defaults match the OpenShell-injected
# gateway (10.200.0.1:3128). Operators on non-default networks can override
# at sandbox creation time by exporting NEMOCLAW_PROXY_HOST / NEMOCLAW_PROXY_PORT
# before running `nemoclaw onboard`. See #1409.
ARG NEMOCLAW_PROXY_HOST=10.200.0.1
ARG NEMOCLAW_PROXY_PORT=3128
# Non-secret web-search selection from onboard. The actual API key is injected
# at runtime via openshell:resolve:env, never baked into the image.
ARG NEMOCLAW_WEB_SEARCH_ENABLED=0
ARG NEMOCLAW_WEB_SEARCH_PROVIDER=brave
ARG NEMOCLAW_OPENCLAW_OTEL=0
# The default local OTEL endpoint is intentionally the single host-gateway
# collector path covered by the openclaw-diagnostics-otel-local policy preset.
# @openclaw/diagnostics-otel@2026.7.1 exports through OpenTelemetry's OTLP
# trace exporter path, not OpenClaw web_fetch, so Patch 2b's host gateway
# exception remains scoped to user-requested web_fetch proxy calls.
ARG NEMOCLAW_OPENCLAW_OTEL_ENDPOINT=http://host.openshell.internal:4318
ARG NEMOCLAW_OPENCLAW_OTEL_SERVICE_NAME=openclaw-gateway
ARG NEMOCLAW_OPENCLAW_OTEL_SAMPLE_RATE=1.0
# SECURITY: Promote persistent image config to env vars so TypeScript reads it
# via process.env, never via string interpolation into executable source code.
# NEMOCLAW_MESSAGING_PLAN_B64 intentionally remains ARG-only: Docker exposes it
# to build RUN processes without retaining the full plan in the final image env.
# Direct ARG interpolation into inline source is a code injection vector (C-2).
ENV NEMOCLAW_MODEL=${NEMOCLAW_MODEL} \
    NEMOCLAW_INFERENCE_PROVIDER_ID=${NEMOCLAW_INFERENCE_PROVIDER_ID} \
    NEMOCLAW_UPSTREAM_PROVIDER=${NEMOCLAW_UPSTREAM_PROVIDER} \
    NEMOCLAW_PRIMARY_MODEL_REF=${NEMOCLAW_PRIMARY_MODEL_REF} \
    CHAT_UI_URL=${CHAT_UI_URL} \
    NEMOCLAW_INFERENCE_BASE_URL=${NEMOCLAW_INFERENCE_BASE_URL} \
    NEMOCLAW_INFERENCE_API=${NEMOCLAW_INFERENCE_API} \
    NEMOCLAW_CONTEXT_WINDOW=${NEMOCLAW_CONTEXT_WINDOW} \
    NEMOCLAW_MAX_TOKENS=${NEMOCLAW_MAX_TOKENS} \
    NEMOCLAW_REASONING=${NEMOCLAW_REASONING} \
    NEMOCLAW_REASONING_EFFORT=${NEMOCLAW_REASONING_EFFORT} \
    NEMOCLAW_TOOL_DISCLOSURE=${NEMOCLAW_TOOL_DISCLOSURE} \
    NEMOCLAW_INFERENCE_INPUTS=${NEMOCLAW_INFERENCE_INPUTS} \
    NEMOCLAW_AGENT_TIMEOUT=${NEMOCLAW_AGENT_TIMEOUT} \
    NEMOCLAW_AGENT_HEARTBEAT_EVERY=${NEMOCLAW_AGENT_HEARTBEAT_EVERY} \
    NEMOCLAW_INFERENCE_COMPAT_B64=${NEMOCLAW_INFERENCE_COMPAT_B64} \
    NEMOCLAW_EXTRA_AGENTS_JSON_B64=${NEMOCLAW_EXTRA_AGENTS_JSON_B64} \
    NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION=${NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION} \
    NEMOCLAW_OPENCLAW_WECHAT_PLUGIN_PREINSTALLED=1 \
    NEMOCLAW_DASHBOARD_BIND=${NEMOCLAW_DASHBOARD_BIND} \
    NEMOCLAW_WSL_DASHBOARD_EXPOSURE=${NEMOCLAW_WSL_DASHBOARD_EXPOSURE} \
    NEMOCLAW_DISABLE_DEVICE_AUTH=${NEMOCLAW_DISABLE_DEVICE_AUTH} \
    NEMOCLAW_DEVICE_AUTH_OPT_OUT_SOURCE=${NEMOCLAW_DEVICE_AUTH_OPT_OUT_SOURCE} \
    NEMOCLAW_PROXY_HOST=${NEMOCLAW_PROXY_HOST} \
    NEMOCLAW_PROXY_PORT=${NEMOCLAW_PROXY_PORT} \
    NEMOCLAW_WEB_SEARCH_ENABLED=${NEMOCLAW_WEB_SEARCH_ENABLED} \
    NEMOCLAW_WEB_SEARCH_PROVIDER=${NEMOCLAW_WEB_SEARCH_PROVIDER} \
    NEMOCLAW_OPENCLAW_OTEL=${NEMOCLAW_OPENCLAW_OTEL} \
    NEMOCLAW_OPENCLAW_OTEL_ENDPOINT=${NEMOCLAW_OPENCLAW_OTEL_ENDPOINT} \
    NEMOCLAW_OPENCLAW_OTEL_SERVICE_NAME=${NEMOCLAW_OPENCLAW_OTEL_SERVICE_NAME} \
    NEMOCLAW_OPENCLAW_OTEL_SAMPLE_RATE=${NEMOCLAW_OPENCLAW_OTEL_SAMPLE_RATE}

RUN case "$NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION" in \
        0) ;; \
        1) \
            test -z "$NEMOCLAW_MESSAGING_PLAN_B64" \
                || { echo "ERROR: managed-image capability union requires an empty messaging plan" >&2; exit 1; }; \
            test "$NEMOCLAW_WEB_SEARCH_ENABLED" = "0" \
                || { echo "ERROR: managed-image capability union requires web search disabled in the neutral image" >&2; exit 1; }; \
            test "$NEMOCLAW_OPENCLAW_OTEL" = "0" \
                || { echo "ERROR: managed-image capability union requires OTEL disabled in the neutral image" >&2; exit 1; } \
            ;; \
        *) echo "ERROR: NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION must be 0 or 1" >&2; exit 1 ;; \
    esac \
    && case "$NEMOCLAW_MANAGED_IMAGE_RUNTIME_USER" in \
        root|sandbox) ;; \
        *) echo "ERROR: NEMOCLAW_MANAGED_IMAGE_RUNTIME_USER must be root or sandbox" >&2; exit 1 ;; \
    esac \
    && command -v setpriv >/dev/null 2>&1

WORKDIR /sandbox
RUN test "$(id -u sandbox):$(id -g sandbox):$(pwd)" = "998:998:/sandbox"
USER sandbox

# Write openclaw.json with gateway config but WITHOUT the real auth token.
# The gateway auth token is generated at container startup by the entrypoint
# and passed via OPENCLAW_GATEWAY_TOKEN env var only to the gateway process
# (running as 'gateway' user). The token file location depends on startup mode:
#   Root mode:     /run/nemoclaw/gateway-token (gateway:gateway 0400)
#   Non-root mode: $XDG_RUNTIME_DIR/nemoclaw/gateway-token (sandbox:sandbox 0400)
# See: scripts/nemoclaw-start.sh generate_gateway_token()
#
# Config is mutable by default (group-writable sandbox:sandbox). Immutability
# is opt-in via `shields up` (DAC 444 root:root + chattr +i).
# Build args (NEMOCLAW_MODEL, CHAT_UI_URL) customize per deployment.
#
# Generate base openclaw.json from environment variables. Messaging build
# steps run through src/lib/messaging/applier/build/messaging-build-applier.mts.
#
# OpenClaw's managed proxy config activates process-wide HTTP_PROXY/HTTPS_PROXY
# for child npm processes. During image build the OpenShell gateway is not
# available at the runtime sandbox proxy address yet, so defer the final proxy
# block until after build-time OpenClaw doctor/plugin commands complete.
RUN NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION=0 \
    NEMOCLAW_OPENCLAW_MANAGED_PROXY=0 \
    node --experimental-strip-types /scripts/generate-openclaw-config.mts

# Validate the patched OpenClaw tool-search contract against real generated
# configs for both supported disclosure modes. This runs at image build time so
# OpenClaw dist drift or a generator/schema mismatch fails the build closed.
# hadolint ignore=DL3059
RUN set -eu; \
    validation_root="$(mktemp -d /tmp/nemoclaw-openclaw-tool-search.XXXXXX)"; \
    trap 'rm -rf "$validation_root"' EXIT; \
    for mode in progressive direct; do \
        validation_home="$validation_root/$mode"; \
        mkdir -p "$validation_home"; \
        HOME="$validation_home" \
            NEMOCLAW_MODEL=test-model \
            NEMOCLAW_PRIMARY_MODEL_REF=inference/test-model \
            NEMOCLAW_TOOL_DISCLOSURE="$mode" \
            NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION=0 \
            NEMOCLAW_OPENCLAW_MANAGED_PROXY=0 \
            node --experimental-strip-types /scripts/generate-openclaw-config.mts; \
        node --experimental-strip-types /scripts/validate-openclaw-tool-search.mts \
            /usr/local/lib/node_modules/openclaw/dist \
            "$validation_home/.openclaw/openclaw.json" \
            "$mode" \
            "$OPENCLAW_VERSION"; \
    done; \
    rm -rf "$validation_root"; \
    trap - EXIT

# Install non-messaging OpenClaw plugins that need to match the runtime.
# Reviewed-archive invariants (#5896): registry SRI, packed-byte SRI, contained
# basename in a fresh directory, local-archive-only install, and cleanup.
# The verified tarball installs through the `npm-pack:` spec so OpenClaw
# records npm provenance; bare archive-path installs record archive
# provenance, which fails the trusted-official-install check gating
# openKeyedStore on OpenClaw >= 2026.6.10.
# hadolint ignore=DL3059,DL4006,SC2016
RUN --network=none --mount=from=openclaw-optional-plugin-archives,target=/opt/nemoclaw-reviewed-npm-archives,ro set -eu; \
    export NEMOCLAW_REVIEWED_NPM_ARCHIVE_DIR=/opt/nemoclaw-reviewed-npm-archives; \
    managed_image_union="${NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION:-0}"; \
    verify_openclaw_plugin_integrity() { \
        plugin_spec="$1"; \
        expected_integrity=""; \
        expected_tarball=""; \
        archive_name=""; \
        case "$plugin_spec" in \
            "@openclaw/diagnostics-otel@2026.7.1") expected_integrity="$OPENCLAW_DIAGNOSTICS_OTEL_2026_7_1_INTEGRITY"; expected_tarball="https://registry.npmjs.org/@openclaw/diagnostics-otel/-/diagnostics-otel-2026.7.1.tgz"; archive_name="diagnostics-otel-2026.7.1.tgz" ;; \
            "@openclaw/brave-plugin@2026.7.1") expected_integrity="$OPENCLAW_BRAVE_PLUGIN_2026_7_1_INTEGRITY"; expected_tarball="https://registry.npmjs.org/@openclaw/brave-plugin/-/brave-plugin-2026.7.1.tgz"; archive_name="brave-plugin-2026.7.1.tgz" ;; \
        esac; \
        if [ -z "$expected_integrity" ]; then \
            echo "ERROR: OpenClaw plugin ${plugin_spec} has no committed npm integrity pin" >&2; exit 1; \
        fi; \
        if [ -n "${NEMOCLAW_REVIEWED_NPM_ARCHIVE_DIR:-}" ]; then \
            plugin_archive="$NEMOCLAW_REVIEWED_NPM_ARCHIVE_DIR/$archive_name"; \
            node -e 'const fs=require("node:fs"); const crypto=require("node:crypto"); const actual="sha512-"+crypto.createHash("sha512").update(fs.readFileSync(process.argv[1])).digest("base64"); if(actual!==process.argv[2]) { console.error(`integrity mismatch for ${process.argv[1]}`); process.exit(1); }' \
                "$plugin_archive" "$expected_integrity"; \
            printf '%s\n' "$plugin_archive"; \
        else \
            node --experimental-strip-types /scripts/lib/reviewed-npm-archive.mts \
                --package-spec "$plugin_spec" --integrity "$expected_integrity" \
                --tarball-url "$expected_tarball" --label "OpenClaw plugin ${plugin_spec}"; \
        fi; \
    }; \
    install_reviewed_openclaw_plugin() { \
        plugin_spec="${1}@${OPENCLAW_VERSION}"; \
        plugin_archive="$(verify_openclaw_plugin_integrity "$plugin_spec")"; \
        plugin_source_root="$(dirname "$plugin_archive")"; \
        plugin_work_root="$(mktemp -d /tmp/nemoclaw-openclaw-plugin.XXXXXX)"; \
        plugin_install_archive="$plugin_archive"; \
        case "$plugin_spec" in \
            "@openclaw/diagnostics-otel@2026.7.1") \
                remediation_json="$(node --experimental-strip-types /scripts/lib/openclaw-npm-remediation.mts \
                    --archive "$plugin_archive" --package-spec "$plugin_spec" \
                    --working-directory "$plugin_work_root")"; \
                plugin_install_archive="$(node -e 'const value = JSON.parse(process.argv[1]); if (!value.remediated || typeof value.archivePath !== "string") process.exit(1); process.stdout.write(value.archivePath)' "$remediation_json")" \
                ;; \
        esac; \
        NPM_CONFIG_IGNORE_SCRIPTS=true npm_config_ignore_scripts=true \
            openclaw plugins install "npm-pack:${plugin_install_archive}"; \
        rm -rf "$plugin_work_root"; \
        if [ -z "${NEMOCLAW_REVIEWED_NPM_ARCHIVE_DIR:-}" ]; then rm -rf "$plugin_source_root"; fi; \
    }; \
    if [ "$managed_image_union" = "1" ] || [ "$NEMOCLAW_OPENCLAW_OTEL" = "1" ] || [ "$NEMOCLAW_WEB_SEARCH_ENABLED" = "1" ]; then \
        test -n "$OPENCLAW_VERSION"; \
    fi; \
    if [ "$managed_image_union" = "1" ]; then \
        install_reviewed_openclaw_plugin "@openclaw/diagnostics-otel"; \
        install_reviewed_openclaw_plugin "@openclaw/brave-plugin"; \
    elif [ "$NEMOCLAW_OPENCLAW_OTEL" = "1" ]; then \
        install_reviewed_openclaw_plugin "@openclaw/diagnostics-otel"; \
    fi; \
    if [ "$managed_image_union" != "1" ] && [ "$NEMOCLAW_WEB_SEARCH_ENABLED" = "1" ]; then \
        case "${NEMOCLAW_WEB_SEARCH_PROVIDER:-brave}" in \
            brave) \
                install_reviewed_openclaw_plugin "@openclaw/brave-plugin"; \
                BRAVE_API_KEY=openshell:resolve:env:BRAVE_API_KEY openclaw doctor --fix --non-interactive \
                ;; \
            tavily) \
                openclaw plugins inspect tavily --json > /dev/null; \
                TAVILY_API_KEY=openshell:resolve:env:TAVILY_API_KEY openclaw doctor --fix --non-interactive \
                ;; \
            *) \
                echo "ERROR: unsupported web-search provider: $NEMOCLAW_WEB_SEARCH_PROVIDER" >&2; \
                exit 1 \
                ;; \
        esac; \
    elif [ "$NEMOCLAW_OPENCLAW_OTEL" = "1" ]; then \
        openclaw doctor --fix --non-interactive; \
    fi; \
    :

# The reviewed cache stays root-owned and immutable to the sandbox user.
# Prepare messaging source and runtime metadata before consuming that cache.
# Add messaging source after the non-messaging install so channel-only changes
# invalidate only the matching offline plugin layer. Keep this as the single
# owner; messaging intentionally stays out of openclaw-runtime-payload.
USER root
COPY src/lib/messaging/ /src/lib/messaging/
RUN chmod 755 /src/lib/messaging/applier/build/messaging-build-applier.mts \
    && chmod -R a+rX /src/lib/messaging

# Bake reduced messaging runtime metadata for the entrypoint. The full
# NEMOCLAW_MESSAGING_PLAN_B64 is a build input; OpenShell sandbox create only
# forwards explicit runtime env, so nemoclaw-start reads this generic artifact
# when the env plan is absent.
# hadolint ignore=DL3059
RUN OPENCLAW_VERSION="${OPENCLAW_VERSION}" node --experimental-strip-types /src/lib/messaging/applier/build/messaging-build-applier.mts --agent openclaw --phase runtime-setup
USER sandbox

# npm still needs a writable _cacache/tmp while OpenClaw packs the verified archive,
# so materialize a sandbox-owned throwaway copy for this RUN and remove it before
# committing the layer. Never point npm directly at the trusted source cache.
# Normal images use --phase agent-install; capability-union images select the
# managed phase instead so each build invokes the messaging applier exactly once.
# hadolint ignore=DL3059,DL4006
RUN --mount=from=openclaw-managed-messaging-npm-cache,source=/out/npm-cache,target=/opt/nemoclaw-managed-messaging-npm-cache,ro set -eu; \
    if [ "$NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION" = "1" ]; then \
        trusted_cache=/opt/nemoclaw-managed-messaging-npm-cache; \
    else \
        trusted_cache=/usr/local/share/nemoclaw/wechat-npm-cache; \
    fi; \
    unsafe_cache_entry="$(find -L "$trusted_cache" \( ! -user root -o -perm /022 \) -print -quit)"; \
    if [ -n "$unsafe_cache_entry" ]; then \
        printf 'ERROR: trusted messaging cache is unsafe phase=before-install path=%s reason=not-root-owned-or-group-world-writable\n' \
            "$unsafe_cache_entry" >&2; \
        exit 1; \
    fi; \
    install_cache="$(mktemp -d /tmp/nemoclaw-wechat-npm-cache.XXXXXX)"; \
    trap 'rm -rf "$install_cache"' EXIT; \
    cp -R "$trusted_cache"/. "$install_cache"/; \
    chmod -R u+rwX,go-w "$install_cache"; \
    messaging_phase=agent-install; \
    if [ "$NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION" = "1" ]; then \
        export NPM_CONFIG_CACHE="$install_cache"; \
        export NPM_CONFIG_OFFLINE=true; \
        export NPM_CONFIG_AUDIT=false; \
        export NPM_CONFIG_FUND=false; \
        messaging_phase=managed-image-capability-union; \
    fi; \
    NEMOCLAW_WECHAT_NPM_INSTALL_CACHE="$install_cache" \
        OPENCLAW_VERSION="${OPENCLAW_VERSION}" \
        node --experimental-strip-types /src/lib/messaging/applier/build/messaging-build-applier.mts \
            --agent openclaw --phase "$messaging_phase"; \
    rm -rf "$install_cache"; \
    trap - EXIT; \
    test ! -e "$install_cache"

USER root

# Copy the full candidate runtime payload after the stable offline plugin
# installs so runtime-only changes do not invalidate those expensive layers.
# NODE_OPTIONS preload modules use a Landlock-accessible path. OpenShell ≥0.0.36
# blocks /opt/nemoclaw-blueprint/ from non-root users, but the entrypoint
# needs to read these files to install Node runtime preloads under /tmp.
# Channel runtime preloads are authored as TypeScript and compiled in the
# runtime-preload-builder stage before being flattened by filename for --require.
COPY --from=openclaw-runtime-payload / /

# Keep the root-owned managed-startup handoff in this image-only layer. The
# following permissions block is replayed on the host by regression tests.
RUN managed_runtime_assertion_failed() { \
      nemoclaw_assertion="$1"; \
      nemoclaw_artifact_path="$2"; \
      if [ -e "$nemoclaw_artifact_path" ] || [ -L "$nemoclaw_artifact_path" ]; then \
        if [ "${3:-}" = dereference ] && [ -e "$nemoclaw_artifact_path" ]; then \
          nemoclaw_metadata="$(stat -L -c 'uid=%u gid=%g type=%F mode=%a' -- "$nemoclaw_artifact_path" 2>/dev/null)" \
            || nemoclaw_metadata='uid=unavailable gid=unavailable type=unavailable mode=unavailable'; \
        else \
          nemoclaw_metadata="$(stat -c 'uid=%u gid=%g type=%F mode=%a' -- "$nemoclaw_artifact_path" 2>/dev/null)" \
            || nemoclaw_metadata='uid=unavailable gid=unavailable type=unavailable mode=unavailable'; \
        fi; \
        if [ -L "$nemoclaw_artifact_path" ]; then nemoclaw_symlink_state='yes'; else nemoclaw_symlink_state='no'; fi; \
      else \
        nemoclaw_metadata='uid=unavailable gid=unavailable type=missing mode=unavailable'; \
        nemoclaw_symlink_state='no'; \
      fi; \
      printf 'ERROR: managed image assertion failed: %s path=%s %s symlink=%s\n' \
        "$nemoclaw_assertion" "$nemoclaw_artifact_path" "$nemoclaw_metadata" "$nemoclaw_symlink_state" >&2; \
      exit 1; \
    }; \
    managed_image_command_failed() { \
      nemoclaw_command_assertion="$1"; \
      nemoclaw_command_status="$2"; \
      printf 'ERROR: managed image assertion failed: %s exit-status=%s\n' \
        "$nemoclaw_command_assertion" "$nemoclaw_command_status" >&2; \
      exit 1; \
    }; \
    if find -P /usr/local/lib/nemoclaw/mcp-tool-discovery-runtime -exec chown -h root:root '{}' + \
      && find -P /usr/local/lib/nemoclaw/mcp-tool-discovery-runtime -type d -exec chmod 0555 '{}' + \
      && find -P /usr/local/lib/nemoclaw/mcp-tool-discovery-runtime -type f -exec chmod 0444 '{}' +; then \
      :; \
    else \
      managed_image_command_failed mcp-tool-discovery-tree-permission-replay "$?"; \
    fi; \
    discovery_contract="$(node /usr/local/lib/nemoclaw/mcp-tool-discovery-runtime/mcp-tool-discovery.mjs)" \
      || managed_image_command_failed mcp-tool-discovery-bundle-execution "$?"; \
    node -e 'const expected = { protocol: 1, ok: false, detail: "tool discovery received invalid runtime arguments" }; const standaloneSecretPatterns = [/(?:nvapi-|nvcf-|gh[pousr]_|sk-proj-|sk-ant-|hf_|glpat-|gsk_|pypi-|tvly-)[A-Za-z0-9_-]{10,}/gu, /github_pat_[A-Za-z0-9_]{30,}/gu, /sk-[A-Za-z0-9_-]{20,}/gu, /(?:xox[bpas]|xapp)-[A-Za-z0-9-]{10,}/gu, /A(?:K|S)IA[A-Z0-9]{16}/gu, /\bbot\d{8,10}:[A-Za-z0-9_-]{35}\b/gu, /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/gu, /\b[A-Za-z0-9]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b/gu, /lsv2_(?:pt|sk)_[A-Za-z0-9]{10,}(?:_[A-Za-z0-9]+)*/gu, /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{10,}\b/gu, /\b[A-Za-z0-9_=-]{32,}\b/gu]; const redactContextSecrets = (value) => value.replace(/\b(?:Bearer|Basic)\s+\S+/giu, "<REDACTED>").replace(/((?:^|[^A-Za-z0-9])(?:[A-Za-z0-9]{1,128}_(?:KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD|PASSWD|PASS)|(?:X[-_])?API[-_]KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD|PASSWD|PASS)["\x27]?(?:[ \t]{0,32}[=:][ \t]{0,32}|[ \t]{1,32})["\x27]?)[^\s"\x27]+/giu, (_match, prefix) => prefix + "<REDACTED>").replace(/((?:^|[^A-Za-z0-9])(?:[A-Za-z0-9]{1,128}(?:Token|Secret|Credential)|[A-Za-z0-9]{0,128}(?:[Aa]ccess|[Rr]efresh|[Cc]lient|[Bb]earer|[Aa]uth|[Aa][Pp][Ii]|[Pp]rivate|[Ss]igning|[Ss]ession|[Bb]ot|[Aa]pp|[Rr]esolved)Key|[A-Za-z0-9]{1,128}(?:Password|Passwd|Pass))["\x27]?(?:[ \t]{0,32}[=:][ \t]{0,32}|[ \t]{1,32})["\x27]?)[^\s"\x27]+/gu, (_match, prefix) => prefix + "<REDACTED>").replace(/((?:^|[^A-Za-z0-9])KEY["\x27]?(?:[ \t]{0,32}[=:][ \t]{0,32}|[ \t]{1,32})["\x27]?)[^\s"\x27]+/gu, (_match, prefix) => prefix + "<REDACTED>"); const sanitize = (value) => { if (value === undefined) return "<missing>"; if (value === null || typeof value === "boolean" || typeof value === "number") return value; if (typeof value !== "string") return "<" + (Array.isArray(value) ? "array" : typeof value) + ">"; let printable = value.replace(/-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*/gu, "<REDACTED>").replace(/[^\x20-\x7e]/gu, "?"); for (const pattern of standaloneSecretPatterns) printable = printable.replace(pattern, "<REDACTED>"); printable = redactContextSecrets(printable); return printable.length <= 240 ? printable : printable.slice(0, 237) + "..."; }; let result; let parsed = true; try { result = JSON.parse(process.argv[1]); } catch { parsed = false; } const record = parsed && result !== null && typeof result === "object" && !Array.isArray(result) ? result : undefined; if (record && record.protocol === expected.protocol && record.ok === expected.ok && record.detail === expected.detail) process.exit(0); const actual = record ? { protocol: sanitize(record.protocol), ok: sanitize(record.ok), detail: sanitize(record.detail) } : parsed ? { type: result === null ? "null" : Array.isArray(result) ? "array" : typeof result, value: sanitize(result) } : { type: "invalid-json", preview: sanitize(process.argv[1]) }; console.error("ERROR: managed image assertion failed: mcp-tool-discovery-json-contract actual=%s expected=%s", JSON.stringify(actual), JSON.stringify(expected)); process.exit(1);' "$discovery_contract" \
      || exit 1; \
    discovery_unsafe="$(find -L /usr/local/lib/nemoclaw/mcp-tool-discovery-runtime \( ! -user root -o -perm /022 \) -print -quit)" \
      || managed_image_command_failed mcp-tool-discovery-tree-find-execution "$?"; \
    { test -z "$discovery_unsafe" || managed_runtime_assertion_failed mcp-tool-discovery-tree-safety "$discovery_unsafe" dereference; } \
    && { test -f /usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs || managed_runtime_assertion_failed regular-file /usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs; } \
    && { test ! -L /usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs || managed_runtime_assertion_failed non-symlink /usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs; } \
    && { chown root:root /usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs 2>/dev/null || managed_runtime_assertion_failed owner-root-root /usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs; } \
    && { chmod 0444 /usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs 2>/dev/null || managed_runtime_assertion_failed mode-0444 /usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs; } \
    && { test "$(stat -c '%u:%g:%a' /usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs 2>/dev/null)" = '0:0:444' || managed_runtime_assertion_failed metadata-0:0:444 /usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs; } \
    && test -f /usr/local/bin/nemoclaw-managed-bootstrap \
    && test ! -L /usr/local/bin/nemoclaw-managed-bootstrap \
    && test "$(stat -c '%u:%g:%a' /usr/local/bin/nemoclaw-managed-bootstrap)" = '0:0:755' \
    && test -f /usr/local/lib/nemoclaw/managed-bootstrap-trampoline.sh \
    && test ! -L /usr/local/lib/nemoclaw/managed-bootstrap-trampoline.sh \
    && test "$(stat -c '%u:%g:%a' /usr/local/lib/nemoclaw/managed-bootstrap-trampoline.sh)" = '0:0:444' \
    && install -d -o root -g root -m 0755 /run/nemoclaw

# Copy startup script and shared sandbox initialisation library.
RUN chmod 755 /usr/local/bin/nemoclaw-start /usr/local/bin/nemoclaw-codex-acp \
        /usr/local/bin/nemoclaw-managed-bootstrap \
        /usr/local/bin/nemoclaw-managed-startup-hold \
        /usr/local/lib/nemoclaw/sandbox-init.sh \
        /scripts/generate-openclaw-config.mts \
        /scripts/validate-openclaw-tool-search.mts \
    && chmod 444 /src/lib/tool-disclosure.ts \
        /usr/local/lib/nemoclaw/entrypoint-env-wrapper.sh \
    && chown root:root /usr/local/bin/nemoclaw-gateway-control \
        /usr/local/lib/nemoclaw/gateway-supervisor.sh \
        /usr/local/lib/nemoclaw/state-dir-guard.py \
        /usr/local/share/nemoclaw/state-lock-plan.json \
        /usr/local/lib/nemoclaw/openclaw-config-guard.py \
        /usr/local/lib/nemoclaw/managed-gateway-control.py \
    && chmod 700 /usr/local/bin/nemoclaw-gateway-control \
    && chmod 500 /usr/local/lib/nemoclaw/state-dir-guard.py \
        /usr/local/lib/nemoclaw/openclaw-config-guard.py \
        /usr/local/lib/nemoclaw/managed-gateway-control.py \
    && chmod 444 /usr/local/share/nemoclaw/state-lock-plan.json \
    && chmod 444 /usr/local/lib/nemoclaw/gateway-supervisor.sh \
        /usr/local/lib/nemoclaw/entrypoint-env-wrapper.sh \
        /usr/local/lib/nemoclaw/sandbox-rlimits.sh \
    && chmod 644 /usr/local/lib/nemoclaw/openclaw_device_approval_policy.py \
        /usr/local/lib/nemoclaw/clean_runtime_shell_env_shim.py \
    && chmod 555 /usr/local/lib/nemoclaw/normalize_mutable_config_perms.py \
    && if [ -d /usr/local/lib/nemoclaw/preloads-compiled-channels ]; then \
        find /usr/local/lib/nemoclaw/preloads-compiled-channels -path '*/runtime/*.js' -type f \
            -exec sh -c 'for file do cp "$file" "/usr/local/lib/nemoclaw/preloads/$(basename "$file")"; done' sh {} +; \
    fi \
    && rm -rf /usr/local/lib/nemoclaw/preloads-compiled-channels \
    && if [ -d /usr/local/lib/nemoclaw/preloads ]; then find /usr/local/lib/nemoclaw/preloads -type f -name '*.js' -exec chmod 644 {} +; fi \
    && chmod 755 /usr/local/share/nemoclaw \
        /usr/local/share/nemoclaw/openclaw-plugins \
    && find /usr/local/share/nemoclaw/openclaw-plugins -type d -exec chmod 755 {} + \
    && find /usr/local/share/nemoclaw/openclaw-plugins -type f -exec chmod 644 {} +

USER sandbox
# Lock down npm for the next RUN: the local OpenClaw plugin install must
# resolve from /opt/nemoclaw and the staged plugin-runtime-deps tree without
# touching the registry. Reset to false after that RUN so the runtime image
# does not propagate `only-if-cached` mode to in-sandbox `npx` / `npm install`.
ENV NPM_CONFIG_OFFLINE=true \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false

# Install NemoClaw plugin into OpenClaw (local /opt/nemoclaw, no network).
# This must fail the image build if registration fails; otherwise the sandbox
# can boot with a discoverable plugin manifest but without the /nemoclaw runtime
# command registered in the active Gateway.
# Messaging post-agent-install hooks run after the OpenClaw agent and
# NemoClaw plugin are installed; for example, WeChat seed files are written
# from messaging hook build-file outputs before the sandbox starts.
# Prune non-runtime metadata from staged bundled plugin dependencies before
# this layer is committed; deleting it in a later layer would not reduce the
# OCI image imported by k3s.
# hadolint ignore=DL3059,DL4006
RUN NPM_CONFIG_IGNORE_SCRIPTS=true npm_config_ignore_scripts=true \
    openclaw plugins install /opt/nemoclaw \
    && openclaw plugins inspect nemoclaw --json > /dev/null \
    && if [ -d /sandbox/.openclaw/plugin-runtime-deps ]; then \
        find /sandbox/.openclaw/plugin-runtime-deps -type f \( \
            -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' -o \
            -name '*.map' -o -name '*.tsbuildinfo' \
        \) -delete; \
        find /sandbox/.openclaw/plugin-runtime-deps -type d \( \
            -name __tests__ -o -name test -o -name tests -o -name docs -o \
            -name examples \
        \) -prune -exec rm -rf {} +; \
    fi

# Apply messaging render and post-agent-install build-file hooks after agent/plugin installation.
# hadolint ignore=DL3059,DL4006
RUN OPENCLAW_VERSION="${OPENCLAW_VERSION}" node --experimental-strip-types /src/lib/messaging/applier/build/messaging-build-applier.mts --agent openclaw --phase post-agent-install

# A managed image is a neutral capability carrier, not an all-channels-enabled
# deployment. Regenerate after every optional plugin is installed so OpenClaw's
# install registry survives while every optional plugin/channel remains inert.
# Validate the exact generated file through the pinned OpenClaw CLI.
# hadolint ignore=DL3059,DL4006,SC2016
RUN if [ "$NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION" = "1" ]; then \
        node --experimental-strip-types /scripts/generate-openclaw-config.mts; \
        validation="$(openclaw config validate --json)"; \
        node -e 'const result=JSON.parse(process.argv[1]); if (result.valid !== true) process.exit(1)' "$validation"; \
        node -e 'const fs=require("node:fs"), path=require("node:path"); const config=JSON.parse(fs.readFileSync("/sandbox/.openclaw/openclaw.json", "utf8")); const root="/usr/local/lib/node_modules/openclaw/dist/extensions"; const bundled=fs.readdirSync(root, {withFileTypes:true}).filter((entry)=>entry.isDirectory()).map((entry)=>entry.name).flatMap((id)=>{ const packagePath=path.join(root, id, "package.json"); if (!fs.existsSync(packagePath)) return []; const packageManifest=JSON.parse(fs.readFileSync(packagePath, "utf8")); if (!packageManifest.openclaw?.channel?.id) return []; const pluginManifest=JSON.parse(fs.readFileSync(path.join(root, id, "openclaw.plugin.json"), "utf8")); return [{channelId:packageManifest.openclaw.channel.id, pluginId:pluginManifest.id}]; }); if (!bundled.some(({channelId})=>channelId === "imessage") || !bundled.some(({channelId})=>channelId === "telegram")) throw new Error(`unexpected bundled OpenClaw channel inventory: ${bundled.map(({channelId})=>channelId).join(",")}`); for (const {channelId, pluginId} of bundled) { if (config.plugins?.entries?.[pluginId]?.enabled !== false || config.channels?.[channelId]?.enabled !== false) throw new Error(`bundled OpenClaw channel is not neutral: ${channelId}`); }'; \
    fi

# Release the offline lock so the runtime sandbox can install MCP servers,
# skills, and ad-hoc packages via the OpenShell L7 proxy.
ENV NPM_CONFIG_OFFLINE=false

# SECURITY: Clear any gateway auth token that openclaw doctor/plugins may have
# auto-generated. The real token is created at container startup by the
# entrypoint (generate_gateway_token) and never stored in openclaw.json.
# Also add the final OpenClaw managed proxy config after build-time OpenClaw
# commands are done, so runtime Discord/WebSocket traffic uses the OpenShell
# gateway proxy without forcing image-build npm traffic through that proxy.
RUN python3 -c "\
import json, os; \
path = os.path.expanduser('~/.openclaw/openclaw.json'); \
cfg = json.load(open(path)); \
cfg.setdefault('gateway', {}).setdefault('auth', {})['token'] = ''; \
proxy_host = os.environ.get('NEMOCLAW_PROXY_HOST') or '10.200.0.1'; \
proxy_port = os.environ.get('NEMOCLAW_PROXY_PORT') or '3128'; \
cfg['proxy'] = { \
    'enabled': True, \
    'proxyUrl': f'http://{proxy_host}:{proxy_port}', \
    'loopbackMode': 'gateway-only', \
}; \
json.dump(cfg, open(path, 'w'), indent=2); \
os.chmod(path, 0o600)"

# Flatten stale published base images that still contain the old
# .openclaw-data symlink bridge. OpenShell starts the sandbox as the sandbox
# user, so runtime migration cannot rely on root privileges inside the pod.
# Doing this in the image build guarantees new PR images have only the unified
# .openclaw layout even when sandbox-base:latest has not been rebuilt yet.
# hadolint ignore=DL3002
USER root
# hadolint ignore=DL4006
RUN set -eu; \
    config_dir=/sandbox/.openclaw; \
    data_dir=/sandbox/.openclaw-data; \
    legacy_layout=0; \
    legacy_marker=/tmp/nemoclaw-legacy-openclaw-layout; \
    rm -f "$legacy_marker"; \
    mkdir -p "$config_dir"; \
    if [ -L "$data_dir" ]; then \
        echo "ERROR: refusing legacy layout cleanup because $data_dir is a symlink" >&2; \
        exit 1; \
    fi; \
    if [ -d "$data_dir" ]; then \
        legacy_layout=1; \
        for entry in "$data_dir"/*; do \
            [ -e "$entry" ] || [ -L "$entry" ] || continue; \
            if [ -L "$entry" ]; then \
                echo "ERROR: refusing legacy layout cleanup because $entry is a symlink" >&2; \
                exit 1; \
            fi; \
            name="$(basename "$entry")"; \
            target="$config_dir/$name"; \
            if [ -L "$target" ]; then \
                rm -f "$target"; \
            fi; \
            if [ -d "$entry" ]; then \
                mkdir -p "$target"; \
                cp -a "$entry"/. "$target"/; \
            elif [ ! -e "$target" ]; then \
                cp -a "$entry" "$target"; \
            fi; \
        done; \
        data_real="$(readlink -f "$data_dir" 2>/dev/null || printf '%s' "$data_dir")"; \
        while :; do \
            replaced_marker="$(mktemp)"; \
            rm -f "$replaced_marker"; \
            find "$config_dir" -type l -print | while IFS= read -r link; do \
                raw_target="$(readlink "$link" 2>/dev/null || true)"; \
                resolved_target="$(readlink -f "$link" 2>/dev/null || true)"; \
                legacy_target=0; \
                case "$raw_target" in "$data_real"/* | "$data_dir"/*) legacy_target=1 ;; esac; \
                case "$resolved_target" in "$data_real"/* | "$data_dir"/*) legacy_target=1 ;; esac; \
                if [ "$legacy_target" -eq 1 ]; then \
                    copy_target="$resolved_target"; \
                    if [ -z "$copy_target" ] || { [ ! -e "$copy_target" ] && [ ! -L "$copy_target" ]; }; then \
                        copy_target="$raw_target"; \
                    fi; \
                    if [ -d "$copy_target" ] && [ ! -L "$copy_target" ]; then \
                            rm -f "$link"; \
                            mkdir -p "$link"; \
                            cp -a "$copy_target"/. "$link"/; \
                    elif [ -e "$copy_target" ] || [ -L "$copy_target" ]; then \
                            rm -f "$link"; \
                            cp -a "$copy_target" "$link"; \
                    else \
                        echo "ERROR: legacy symlink target missing: $link -> ${raw_target:-$resolved_target}" >&2; \
                        exit 1; \
                    fi; \
                    : > "$replaced_marker"; \
                fi; \
            done; \
            if [ ! -e "$replaced_marker" ]; then \
                rm -f "$replaced_marker"; \
                break; \
            fi; \
            rm -f "$replaced_marker"; \
        done; \
        rm -rf "$data_dir"; \
    fi; \
    if [ -e "$data_dir" ] || [ -L "$data_dir" ]; then \
        echo "ERROR: legacy data dir still exists after cleanup: $data_dir" >&2; \
        exit 1; \
    fi; \
    if [ "$legacy_layout" = "1" ]; then \
        data_real="$(readlink -f "$data_dir" 2>/dev/null || printf '%s' "$data_dir")"; \
        find "$config_dir" -type l -print | while IFS= read -r link; do \
            raw_target="$(readlink "$link" 2>/dev/null || true)"; \
            resolved_target="$(readlink -f "$link" 2>/dev/null || true)"; \
            case "$raw_target" in \
                "$data_real"/* | "$data_dir"/*) \
                    echo "ERROR: legacy symlink remains after cleanup: $link -> $raw_target" >&2; \
                    exit 1; \
                    ;; \
            esac; \
            case "$resolved_target" in \
                "$data_real"/* | "$data_dir"/*) \
                    echo "ERROR: legacy symlink remains after cleanup: $link -> $resolved_target" >&2; \
                    exit 1; \
                    ;; \
            esac; \
        done; \
        : > "$legacy_marker"; \
    fi; \
    for dir in \
        "$config_dir/agents/main/agent" \
        "$config_dir/extensions" \
        "$config_dir/workspace" \
        "$config_dir/skills" \
        "$config_dir/hooks" \
        "$config_dir/identity" \
        "$config_dir/devices" \
        "$config_dir/canvas" \
        "$config_dir/cron" \
        "$config_dir/memory" \
        "$config_dir/logs" \
        "$config_dir/credentials" \
        "$config_dir/flows" \
        "$config_dir/sandbox" \
        "$config_dir/state" \
        "$config_dir/telegram" \
        "$config_dir/wechat" \
        "$config_dir/media" \
        "$config_dir/plugin-runtime-deps"; do \
        install -d -o sandbox -g sandbox -m 2770 "$dir"; \
    done; \
    update_check="$config_dir/update-check.json"; \
    [ ! -L "$update_check" ] \
        || { echo "ERROR: refusing symlinked OpenClaw update-check state" >&2; exit 1; }; \
    [ ! -e "$update_check" ] || [ -f "$update_check" ] \
        || { echo "ERROR: refusing non-regular OpenClaw update-check state" >&2; exit 1; }; \
    rm -f "$update_check"; \
    exec_approvals="$config_dir/exec-approvals.json"; \
    [ ! -L "$exec_approvals" ] \
        || { echo "ERROR: refusing unsafe OpenClaw state file: $exec_approvals" >&2; exit 1; }; \
    [ ! -e "$exec_approvals" ] || [ -f "$exec_approvals" ] \
        || { echo "ERROR: refusing unsafe OpenClaw state file: $exec_approvals" >&2; exit 1; }; \
    [ ! -e "$exec_approvals" ] || [ "$(stat -c '%h' "$exec_approvals")" = "1" ] \
        || { echo "ERROR: refusing unsafe OpenClaw state file: $exec_approvals" >&2; exit 1; }; \
    touch "$exec_approvals"; \
    chown sandbox:sandbox "$exec_approvals"; \
    chmod 660 "$exec_approvals"; \
    for file in \
        "$config_dir/state/openclaw.sqlite" \
        "$config_dir/state/openclaw.sqlite-wal" \
        "$config_dir/state/openclaw.sqlite-shm" \
        "$config_dir/state/openclaw.sqlite-journal"; do \
        [ -e "$file" ] || [ -L "$file" ] || continue; \
        [ -f "$file" ] && [ ! -L "$file" ] \
            || { echo "ERROR: refusing unsafe OpenClaw state file: $file" >&2; exit 1; }; \
        [ "$(stat -c '%h' "$file")" = "1" ] \
            || { echo "ERROR: refusing unsafe OpenClaw state file: $file" >&2; exit 1; }; \
        chown sandbox:sandbox "$file"; \
        chmod 660 "$file"; \
    done; \
    rm -rf /root/.npm /sandbox/.npm

# Stale-base fallback for the gateway/root-in-sandbox-group setup (#2681).
# Newer base images already add both users to the sandbox group, but the
# derived image must remain build-clean against older sandbox-base:latest
# tags too. Root membership preserves PID 1 access when CAP_DAC_OVERRIDE is
# dropped. The `id -nG` checks make this idempotent. Remove this block after
# the minimum supported OpenClaw sandbox base tag is v0.0.71 or newer and
# Dockerfile.base guarantees both memberships; keep that base contract covered
# by test/runtime/sandbox/sandbox-provisioning.test.ts.
# hadolint ignore=DL4006
RUN if id gateway >/dev/null 2>&1 && id sandbox >/dev/null 2>&1; then \
        if ! id -nG gateway | tr ' ' '\n' | grep -qx sandbox; then \
            usermod -aG sandbox gateway; \
        fi; \
    fi \
    && if id root >/dev/null 2>&1 && id sandbox >/dev/null 2>&1; then \
        if ! id -nG root | tr ' ' '\n' | grep -qx sandbox; then \
            usermod -aG sandbox root; \
        fi; \
    fi

# Keep the image readable to the root entrypoint after capabilities are dropped.
# Current base images already have a unified .openclaw tree. Avoid walking
# plugin-runtime-deps on every build; only fall back to the broad repair when
# the stale .openclaw-data migration path actually ran.
RUN set -eu; \
    if [ -e /tmp/nemoclaw-legacy-openclaw-layout ]; then \
        chown -R sandbox:sandbox /sandbox/.openclaw; \
        chmod -R g+rwX,o-rwx /sandbox/.openclaw; \
        find /sandbox/.openclaw -type d -exec chmod g+s {} +; \
        rm -f /tmp/nemoclaw-legacy-openclaw-layout; \
    else \
        chown sandbox:sandbox \
            /sandbox/.openclaw \
            /sandbox/.openclaw/openclaw.json \
            /sandbox/.openclaw/plugin-runtime-deps; \
        chmod 2770 /sandbox/.openclaw /sandbox/.openclaw/plugin-runtime-deps; \
        chmod 660 /sandbox/.openclaw/openclaw.json; \
    fi

# System-wide shell hooks for shells where ~/.bashrc / ~/.profile aren't
# sourced (e.g. `bash -ic` / `bash -lc` invoked under a different user or
# without HOME=/sandbox). Dockerfile.base is the source of truth. This final
# image replay only repairs stale published bases that predate the v0.0.69
# base layer and therefore lack /etc/profile.d/nemoclaw-rlimits.sh, the
# /etc/bash.bashrc hook, or the root-owned helper mode. Remove this block after
# the minimum supported OpenClaw sandbox base tag is v0.0.69 or newer and those
# three artifacts are guaranteed by the base image and covered by
# test/runtime/sandbox/sandbox-provisioning.test.ts.
# Ref: https://github.com/NVIDIA/NemoClaw/issues/2704
# hadolint ignore=SC2028,DL4006
RUN chmod 444 /usr/local/lib/nemoclaw/sandbox-rlimits.sh \
    && if ! grep -q "sandbox-rlimits.sh" /etc/profile.d/nemoclaw-rlimits.sh 2>/dev/null; then \
        printf '%s\n' \
            '# NemoClaw sandbox resource limits — see sandbox-rlimits.sh (#2173)' \
            '[ -f /usr/local/lib/nemoclaw/sandbox-rlimits.sh ] && . /usr/local/lib/nemoclaw/sandbox-rlimits.sh && harden_resource_limits --quiet && verify_resource_limits --quiet || true' \
            > /etc/profile.d/nemoclaw-rlimits.sh \
        && chmod 444 /etc/profile.d/nemoclaw-rlimits.sh; \
    fi \
    && if ! grep -q "/tmp/nemoclaw-proxy-env.sh" /etc/profile.d/nemoclaw-proxy.sh 2>/dev/null; then \
        printf '%s\n' \
            '# NemoClaw runtime proxy config — see /tmp/nemoclaw-proxy-env.sh (#2704)' \
            '[ -f /tmp/nemoclaw-proxy-env.sh ] && . /tmp/nemoclaw-proxy-env.sh' \
            > /etc/profile.d/nemoclaw-proxy.sh \
        && chmod 444 /etc/profile.d/nemoclaw-proxy.sh; \
    fi \
    && (chmod 644 /etc/bash.bashrc 2>/dev/null || true) \
    && { printf '%s\n' \
          '# NemoClaw runtime proxy config — see /tmp/nemoclaw-proxy-env.sh (#2704)' \
          '[ -f /tmp/nemoclaw-proxy-env.sh ] && . /tmp/nemoclaw-proxy-env.sh' \
          '' \
          '# NemoClaw sandbox resource limits — see sandbox-rlimits.sh (#2173)' \
          '[ -f /usr/local/lib/nemoclaw/sandbox-rlimits.sh ] && . /usr/local/lib/nemoclaw/sandbox-rlimits.sh && harden_resource_limits --quiet && verify_resource_limits --quiet || true' \
          ''; \
        grep -Ev 'NemoClaw runtime proxy config|nemoclaw-proxy-env[.]sh|NemoClaw sandbox resource limits|sandbox-rlimits[.]sh' /etc/bash.bashrc || true; \
      } > /etc/bash.bashrc.new \
    && mv /etc/bash.bashrc.new /etc/bash.bashrc \
    && chmod 444 /etc/bash.bashrc

# Pin config hash at build time so the entrypoint can verify integrity.
RUN sha256sum /sandbox/.openclaw/openclaw.json > /sandbox/.openclaw/.config-hash \
    && chmod 660 /sandbox/.openclaw/.config-hash \
    && chown sandbox:sandbox /sandbox/.openclaw/.config-hash

# DAC-protect .nemoclaw directory: /sandbox/.nemoclaw is Landlock read_write
# (for plugin state/config), but the parent and blueprints are immutable at
# runtime. Root ownership on the parent prevents the agent from renaming or
# replacing the root-owned blueprints directory. Only state/, migration/,
# snapshots/, and config.json are sandbox-owned for runtime writes.
# Sticky bit (1755): OpenShell's prepare_filesystem() chowns read_write paths
# to run_as_user at sandbox start, flipping this dir to sandbox:sandbox.
# The sticky bit survives the chown and prevents the sandbox user from
# renaming or deleting root-owned entries (blueprints/).
# Ref: https://github.com/NVIDIA/NemoClaw/issues/804
# Ref: https://github.com/NVIDIA/NemoClaw/issues/1607
RUN chown root:root /sandbox/.nemoclaw \
    && chmod 1755 /sandbox/.nemoclaw \
    && chown -R root:root /sandbox/.nemoclaw/blueprints \
    && chmod -R 755 /sandbox/.nemoclaw/blueprints \
    && mkdir -p /sandbox/.nemoclaw/state /sandbox/.nemoclaw/migration /sandbox/.nemoclaw/snapshots /sandbox/.nemoclaw/staging \
    && chown sandbox:sandbox /sandbox/.nemoclaw/state /sandbox/.nemoclaw/migration /sandbox/.nemoclaw/snapshots /sandbox/.nemoclaw/staging \
    && printf '%s' '{}' > /sandbox/.nemoclaw/config.json \
    && chown sandbox:sandbox /sandbox/.nemoclaw/config.json

# OpenShell 0.0.37's macOS VM backend currently remaps rootfs ownership to the
# host uid/gid inside the guest, while the entrypoint runs as non-root sandbox.
# Enable this only for Darwin VM builds so Linux Docker-driver sandboxes keep
# the tighter group-only mutable-default permissions.
RUN if [ "$NEMOCLAW_DARWIN_VM_COMPAT" = "1" ]; then \
        chmod -R a+rwX /sandbox/.openclaw; \
        find /sandbox/.openclaw -type d -exec chmod a+rwx {} +; \
        chmod a+rw /sandbox/.openclaw/openclaw.json /sandbox/.openclaw/.config-hash; \
        for p in /sandbox/.nemoclaw/state /sandbox/.nemoclaw/migration /sandbox/.nemoclaw/snapshots /sandbox/.nemoclaw/staging; do \
            chmod -R a+rwX "$p"; \
            find "$p" -type d -exec chmod a+rwx {} +; \
        done; \
        chmod a+rw /sandbox/.nemoclaw/config.json; \
    fi

# Temporary workaround for OpenTelemetry JS OTLP/HTTP proxy handling.
# When diagnostics OTEL is enabled, patch the bundled exporter so Node's
# NODE_USE_ENV_PROXY=1 handling can apply instead of forcing the default agent.
# Remove once https://github.com/open-telemetry/opentelemetry-js/issues/6638
# is fixed in @opentelemetry/otlp-exporter-base.
# hadolint ignore=DL4006
RUN set -eu; \
    if [ "$NEMOCLAW_OPENCLAW_OTEL" = "1" ]; then \
        target="$(find /sandbox/.openclaw \
            -path '*/@opentelemetry/otlp-exporter-base/build/src/transport/http-transport-utils.js' \
            -print -quit 2>/dev/null || true)"; \
        if [ -z "$target" ]; then \
            echo "ERROR: NEMOCLAW_OPENCLAW_OTEL=1 but otlp-exporter-base transport was not found" >&2; \
            exit 1; \
        fi; \
        if grep -q 'NODE_USE_ENV_PROXY' "$target"; then \
            echo "INFO: OpenTelemetry OTLP proxy patch already present in $target"; \
        else \
            owner="$(stat -c '%u:%g' "$target")"; \
            mode="$(stat -c '%a' "$target")"; \
            cp -p "$target" "$target.bak"; \
            sed -i "0,/^[[:space:]]*agent,$/s//        agent: process.env.NODE_USE_ENV_PROXY === '1' ? undefined : agent,/" "$target"; \
            grep -q 'NODE_USE_ENV_PROXY' "$target" || { \
                echo "ERROR: failed to patch OpenTelemetry OTLP transport at $target" >&2; \
                exit 1; \
            }; \
            chown "$owner" "$target"; \
            chmod "$mode" "$target"; \
            echo "INFO: patched OpenTelemetry OTLP proxy handling in $target"; \
        fi; \
    fi

RUN check_metadata() { \
      metadata_path="$1"; \
      expected_metadata="$2"; \
      actual_metadata="$(stat -c '%U:%G:%a' "$metadata_path")"; \
      if [ "$actual_metadata" != "$expected_metadata" ]; then \
        echo "ERROR: payload metadata mismatch at $metadata_path: expected $expected_metadata, got $actual_metadata" >&2; \
        exit 1; \
      fi; \
    } \
    && check_metadata /scripts/lib/bundled-npm-package.mts 'root:root:644' \
    && check_metadata /scripts/patch-bundled-npm-brace-expansion.mts 'root:root:755' \
    && check_metadata /scripts/lib/patch-bundled-npm-ip-address.mts 'root:root:755' \
    && check_metadata /scripts/patch-bundled-npm-tar.mts 'root:root:755' \
    && check_metadata /opt/nemoclaw/openclaw.plugin.json 'root:root:644' \
    && check_metadata /usr/local/lib/nemoclaw/patch-openclaw-tool-catalog.mts 'root:root:755' \
    && check_metadata /usr/local/lib/nemoclaw/patch-openclaw-gateway-daemon-dialback.mts 'root:root:755' \
    && test ! -L /usr/local/bin/nemoclaw-managed-bootstrap \
    && check_metadata /usr/local/bin/nemoclaw-managed-bootstrap 'root:root:755' \
    && test ! -L /usr/local/lib/nemoclaw/managed-bootstrap-trampoline.sh \
    && check_metadata /usr/local/lib/nemoclaw/managed-bootstrap-trampoline.sh 'root:root:444' \
    && check_metadata /usr/local/bin/nemoclaw-gateway-control 'root:root:700' \
    && check_metadata /usr/local/lib/nemoclaw/state-dir-guard.py 'root:root:500' \
    && check_metadata /usr/local/share/nemoclaw/state-lock-plan.json 'root:root:444' \
    && check_metadata /usr/local/lib/nemoclaw/preloads/sandbox-safety-net.js 'root:root:644'

# Health check: poll the gateway's /health endpoint so Docker (and Compose)
# can detect and restart unhealthy containers in standalone deployments.
# Ref: https://github.com/NVIDIA/NemoClaw/issues/1430
#
# Layered probe so Docker health does not contradict the NemoClaw delivery
# chain on runtimes where the dashboard port lives in a different network
# namespace (e.g. DGX Spark / aarch64 with OpenShell-managed forwarding).
# The reporter saw `nemoclaw status` Ready + the host forward succeed while
# Docker marked the container unhealthy because the in-container curl could
# not see the dashboard listener. See #3975.
#
#   1. Direct in-container probe (HTTP 200) — definitive when it works,
#      preserves the original Compose/standalone health signal.
#   2. A connect timeout (curl exit 28) or HTTP 4xx/5xx (curl exit 22) is a
#      real bad signal: a listener exists but is wedged or answered with a
#      failure inside this container, so Docker should restart it.
#   3. ONLY on curl exit 7 ("Couldn't connect" — the kernel refused the
#      in-container TCP connect because nothing is bound to the dashboard
#      port in THIS network namespace) the meaning depends on whether this
#      container is the one running the OpenClaw gateway:
#        a. If nemoclaw-start launched the gateway in this container it
#           drops the /tmp/nemoclaw-gateway-local marker (see
#           scripts/nemoclaw-start.sh). The gateway is local but its port
#           may be forwarded out of this namespace (#3975), so confirm the
#           gateway came up: the process is still alive (pgrep
#           --ignore-ancestors) AND the gateway log is non-empty. A
#           standalone deployment whose gateway never started fails here so
#           Docker restarts it (#1430).
#        b. If the marker is ABSENT the OpenClaw gateway is delivered
#           outside this container (OpenShell docker-driver deployments run
#           it on the host / in a host-side process chain — #4503). An
#           in-container curl/pgrep cannot observe an out-of-namespace
#           gateway, so a process-name fallback here produced false
#           "unhealthy" while `nemoclaw status` and OpenShell reported the
#           sandbox Ready. We must not drive Docker health off a signal we
#           cannot prove: report healthy and defer to NemoClaw/OpenShell's
#           host-side delivery-chain monitoring (verify-deployment.ts, host
#           port forward, sandbox status).
#
# nemoclaw-start records `pid starttime` for the exact gateway process in
# /tmp/nemoclaw-gateway.pid on every launch.  When curl sees connection
# refused, validate both values against `/proc/<pid>/stat` field 22 before
# accepting the exact OpenClaw gateway cmdline fallback.  A numeric PID or
# OpenClaw-looking argv alone is insufficient because either can belong to a
# recycled process.
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
    CMD port="${NEMOCLAW_DASHBOARD_PORT:-${OPENCLAW_GATEWAY_PORT:-}}"; \
        if [ -z "$port" ]; then \
            port="$(python3 -c 'import os; from urllib.parse import urlparse; raw = os.environ.get("CHAT_UI_URL") or "http://127.0.0.1:18789"; raw = raw if "://" in raw else "http://" + raw; u = urlparse(raw); print(u.port or 18789)' 2>/dev/null || printf '18789')"; \
        fi; \
        rc=0; \
        curl -sf --max-time 3 "http://127.0.0.1:${port}/health" > /dev/null 2>&1 || rc=$?; \
        if [ "$rc" = 0 ]; then exit 0; fi; \
        if [ "$rc" != 7 ]; then exit 1; fi; \
        [ -f /tmp/nemoclaw-gateway-local ] || exit 0; \
        gwpid=; gwstart=; gwextra=; \
        IFS=' ' read -r gwpid gwstart gwextra </tmp/nemoclaw-gateway.pid 2>/dev/null || exit 1; \
        case "${gwpid:-x}" in *[!0-9]*) exit 1 ;; esac; \
        case "${gwstart:-x}" in *[!0-9]*) exit 1 ;; esac; \
        [ -z "$gwextra" ] || exit 1; \
        python3 -c 'import pathlib, sys; proc = pathlib.Path(sys.argv[1]); expected = sys.argv[2].encode("ascii"); port = sys.argv[3].encode(); parse = lambda data: (lambda fields: (fields[0], fields[19]))(data.rsplit(b") ", 1)[1].split()); before = parse((proc / "stat").read_bytes()); raw = (proc / "cmdline").read_bytes(); after = parse((proc / "stat").read_bytes()); trimmed = raw.rstrip(b"\0"); padding = len(raw) - len(trimmed); title = padding >= 1 and trimmed in (b"openclaw", b"openclaw-gateway"); argv = raw[:-1].split(b"\0") if padding == 1 else []; interpreters = (b"node", b"nodejs", b"/usr/local/bin/node", b"/usr/local/bin/nodejs", b"/usr/bin/node", b"/usr/bin/nodejs"); launchers = (b"/usr/local/bin/openclaw", b"/usr/local/lib/node_modules/openclaw/openclaw.mjs"); index = 1 if argv and argv[0] in interpreters else 0; command = index < len(argv) and argv[index] in launchers and argv[index + 1:] in ([b"gateway", b"run", b"--port", port], [b"gateway", b"run", b"--port=" + port]); identity = before[1] == expected == after[1] and before[0] != b"Z" and after[0] != b"Z"; raise SystemExit(not (identity and (title or command)))' "/proc/$gwpid" "$gwstart" "$port" 2>/dev/null || exit 1; \
        [ -s /tmp/gateway.log ]

# Verify the immutable security package inventory in the completed image.
# hadolint ignore=DL4006
RUN set -eu; \
    security_inventory=/usr/local/share/nemoclaw/security-packages.txt; \
    arch="$(dpkg --print-architecture)"; \
    test -f "$security_inventory"; \
    test ! -L "$security_inventory"; \
    test "$(stat -c '%u:%g:%a' "$security_inventory")" = "0:0:444"; \
    printf '%s\n' \
        "architecture=$arch" \
        "libexpat1=2.8.3-1" \
        "libonig5=6.9.9-1+b1" \
        "libjq1=1.8.2-1" \
        "jq=1.8.2-1" \
        "vim-common=2:9.2.0858-1" \
        "vim-tiny=2:9.2.0858-1" \
        "libssh2-1t64=1.11.1-1+deb13u1+nemoclaw2" \
        "libssl3t64=3.5.7-1~deb13u2" \
        "nemoclaw-python3.13-htmlparser-fix=3.13.5-2+deb13u4+nemoclaw1" \
        "perl-base=5.44.0-1nemoclaw1" \
        "perl=5.44.0-1nemoclaw1" \
        | cmp -s - "$security_inventory"; \
    test "$(dpkg-query -W -f='${Version}' libexpat1)" = "2.8.3-1"; \
    test "$(dpkg-query -W -f='${Version}' libonig5)" = "6.9.9-1+b1"; \
    test "$(dpkg-query -W -f='${Version}' libjq1)" = "1.8.2-1"; \
    test "$(dpkg-query -W -f='${Version}' jq)" = "1.8.2-1"; \
    test "$(dpkg-query -W -f='${Version}' vim-common)" = "2:9.2.0858-1"; \
    test "$(dpkg-query -W -f='${Version}' vim-tiny)" = "2:9.2.0858-1"; \
    test "$(dpkg-query -W -f='${Version}' libssh2-1t64)" = "1.11.1-1+deb13u1+nemoclaw2"; \
    test "$(dpkg-query -W -f='${Version}' libssl3t64)" = "3.5.7-1~deb13u2"; \
    test "$(dpkg-query -W -f='${Version}' nemoclaw-python3.13-htmlparser-fix)" = "3.13.5-2+deb13u4+nemoclaw1"; \
    test "$(dpkg-query -W -f='${Version}' perl-base)" = "5.44.0-1nemoclaw1"; \
    test "$(dpkg-query -W -f='${Version}' perl)" = "5.44.0-1nemoclaw1"; \
    test "$(perl -e 'print $^V')" = "v5.44.0"; \
    ldd /usr/bin/jq | grep -Eq 'libonig[.]so[.]5'; \
    test "$(jq --version)" = "jq-1.8.2"; \
    printf '%s\n' '{"sandbox":"healthy"}' | jq -e '.sandbox == "healthy"' >/dev/null; \
    python3 -c "import pyexpat; assert pyexpat.EXPAT_VERSION == 'expat_2.8.3', pyexpat.EXPAT_VERSION"; \
    printf '%s  %s\n' \
        "4ff43a8578bda2f14686c67911b64c18e869841973722b1c623b5727491bdaf7" \
        /usr/lib/python3.13/html/parser.py \
        | sha256sum -c -; \
    python3 -c "import sys; from pathlib import Path; import html.parser; Path(html.parser.__file__).resolve() == Path('/usr/lib/python3.13/html/parser.py').resolve() or sys.exit('html.parser loaded from an unexpected path'); from html.parser import HTMLParser; p=HTMLParser(); [p.feed('') for _ in range(20000)]; p._pending == [] or sys.exit('empty feeds accumulated pending entries'); p.feed('<!--'); [p.feed('a' * 64) for _ in range(20000)]; p.feed('-->'); p.close(); p.rawdata == '' or sys.exit('incremental parsing retained raw data')"; \
    python3 -c "import ctypes, sys; lib=ctypes.CDLL('libssh2.so.1'); lib.libssh2_version.restype=ctypes.c_char_p; lib.libssh2_version(0) == b'1.11.1' or sys.exit('unexpected libssh2 runtime version')"; \
    vim.tiny --version | head -n 1 | grep -Eq '^VIM - Vi IMproved 9[.]2 '; \
    vim.tiny --version | grep -Fx 'Included patches: 1-858'; \
    test -z "$(dpkg --audit)"
# End completed-image security package verification.

# Stock builds use a non-root OCI default for OpenShell compatibility.
# Deployments that require gateway and agent UID isolation can override
# the runtime user to root.
USER ${NEMOCLAW_MANAGED_IMAGE_RUNTIME_USER}
ENTRYPOINT ["/usr/local/bin/nemoclaw-start"]
CMD ["/bin/bash"]
