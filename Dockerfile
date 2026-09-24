# NemoClaw sandbox image layers PR-specific code on the pre-built OpenClaw and OpenShell base.
# Build the base first when GHCR is unavailable:
#   docker build -f Dockerfile.base -t ghcr.io/nvidia/nemoclaw/sandbox-base:latest .

# Global ARG values precede FROM so every stage can use them.
ARG BASE_IMAGE=ghcr.io/nvidia/nemoclaw/sandbox-base:latest
ARG NEMOCLAW_CORPORATE_CA_B64=
ARG NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION=0
ARG TARGETARCH
ARG CODEX_ACP_0_11_1_INTEGRITY=sha512-My2VSlBtvJipJhImHjFDej2ut/p00QqOISRnZgLgLrSIzjgvdcQvAhaZviWj7XPhk4UIdIb0OoA+Lrls824uiQ==
ARG CODEX_ACP_LINUX_AMD64_0_11_1_INTEGRITY=sha512-30vSoZuW1DP6Nuz24Gg3jgVC37IYe0bZ/Fgc5+372gc0h72NN4zHYAbu5bRd/gUJ9GdwABKrrEPCoFPlOTVTnQ==
ARG CODEX_ACP_LINUX_ARM64_0_11_1_INTEGRITY=sha512-I1f6WoSLbLlsWq4zH+vtwdoc4Y41mqRXPpSkfgIifxBw34QmWJmi37etZ7lKTYp6R+J/Z4PUN0rsmnsmKpBZTw==

FROM scratch AS reviewed-npm-archive
ADD --chmod=0444 --checksum=sha256:5dbb86c71d07a1957f2e90734092dd6a58bdcd9ebc2d8d41ca1c6e6a21d364e1 https://registry.npmjs.org/npm/-/npm-12.0.2.tgz /npm-12.0.2.tgz
FROM node:24.18.1-trixie-slim@sha256:ac39e4b5fcb2b1b34b20364fd58b2e898f3bb80731ee6f62a7536f9df3d6aadc AS npm12
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates=20250419 curl=8.14.1-2+deb13u5 && rm -rf /var/lib/apt/lists/*
COPY scripts/lib/reviewed-npm-archive.mts scripts/lib/bundled-npm-package.mts scripts/lib/reviewed-npm-audit.mts scripts/lib/patch-bundled-npm-ip-address.mts scripts/lib/reviewed-npm-identity.mts /scripts/lib/
COPY scripts/patch-bundled-npm-brace-expansion.mts scripts/patch-bundled-npm-tar.mts scripts/upgrade-bundled-npm.mts /scripts/
COPY ci/reviewed-npm-audit.json /ci/reviewed-npm-audit.json
COPY --from=reviewed-npm-archive /npm-12.0.2.tgz /tmp/npm-12.0.2.tgz
RUN node /scripts/upgrade-bundled-npm.mts --npm-root /usr/local/lib/node_modules/npm --archive /tmp/npm-12.0.2.tgz
# hadolint ignore=DL3059
RUN rm /tmp/npm-12.0.2.tgz
# hadolint ignore=DL3059
RUN node /scripts/patch-bundled-npm-tar.mts --npm-root /usr/local/lib/node_modules/npm
# hadolint ignore=DL3059
RUN node /scripts/patch-bundled-npm-brace-expansion.mts --npm-root /usr/local/lib/node_modules/npm
# hadolint ignore=DL3059
RUN node /scripts/lib/patch-bundled-npm-ip-address.mts --npm-root /usr/local/lib/node_modules/npm
FROM npm12 AS builder
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
    && node \
        /opt/nemoclaw-build-checks/verify-openshell-policy-boundary-dependencies.mts \
        /opt/nemoclaw/dist/shared/openshell-policy-boundary.cjs
FROM builder AS runtime-preload-builder
WORKDIR /opt/nemoclaw-root
COPY tsconfig.runtime-preloads.json /opt/nemoclaw-root/
COPY src/lib/messaging/channels/ /opt/nemoclaw-root/src/lib/messaging/channels/
RUN ln -s /opt/nemoclaw/node_modules /opt/nemoclaw-root/node_modules \
    && /opt/nemoclaw/node_modules/.bin/tsc -p tsconfig.runtime-preloads.json

# Copy reviewed generated runtime bundles without materializing an npm graph.
FROM scratch AS mcp-tool-discovery-runtime
COPY tools/mcp-tool-discovery-runtime/reviewed-runtime-bundle/mcp-tool-discovery/BUNDLED_PACKAGES.json tools/mcp-tool-discovery-runtime/reviewed-runtime-bundle/mcp-tool-discovery/THIRD_PARTY_LICENSES.txt /opt/mcp-tool-discovery-runtime/dist/
COPY tools/mcp-tool-discovery-runtime/reviewed-runtime-bundle/mcp-tool-discovery/mcp-tool-discovery.bundle /opt/mcp-tool-discovery-runtime/dist/mcp-tool-discovery.mjs

FROM scratch AS managed-startup-runtime-builder
COPY tools/mcp-tool-discovery-runtime/reviewed-runtime-bundle/managed-startup-direct-image-runtime.bundle /out/managed-startup-image-runtime.cjs

# Fetch immutable reviewed archives outside RUN instructions. The protected
# GPU rebuild imports these checksum-addressed source records from the
# amd64 build cache, while every package-materialization RUN remains offline.
FROM scratch AS wechat-npm-archives

ADD --checksum=sha256:467e8047f7114e45944961fcd3eda9421843c9c65db61ea24176e252ab800ee4 https://registry.npmjs.org/@tencent-weixin/openclaw-weixin/-/openclaw-weixin-2.4.9.tgz /openclaw-weixin-2.4.9.tgz
ADD --checksum=sha256:3a6260c4e0d80bd527a3f930e90ea2348c03646621f25aa0bd960ee205a0a706 https://registry.npmjs.org/qrcode-terminal/-/qrcode-terminal-0.12.0.tgz /qrcode-terminal-0.12.0.tgz
ADD --checksum=sha256:ee38f17f533fd500610685a483ae2f413c26f4eb33a51684314563c8d60f279c https://registry.npmjs.org/zod/-/zod-4.4.3.tgz /zod-4.4.3.tgz

FROM scratch AS codex-acp-common-archive

ADD --checksum=sha256:b287fe7bce0dc0b3d0c69400ab7d47567680439628ad22a89f0557cc736d64b8 https://registry.npmjs.org/@zed-industries/codex-acp/-/codex-acp-0.11.1.tgz /codex-acp.tgz

FROM scratch AS codex-acp-amd64-archive

ADD --checksum=sha256:051cc1c1b632797b65b574e31b3eebaa0b8795639a3080c93710b96755e62be3 https://registry.npmjs.org/@zed-industries/codex-acp-linux-x64/-/codex-acp-linux-x64-0.11.1.tgz /codex-acp-platform.tgz

FROM scratch AS codex-acp-arm64-archive

ADD --checksum=sha256:0ec75f1cd0bd6011b687d0aac25478f3123ffa81ec299281bcb1747dd3162e2a https://registry.npmjs.org/@zed-industries/codex-acp-linux-arm64/-/codex-acp-linux-arm64-0.11.1.tgz /codex-acp-platform.tgz

FROM scratch AS openclaw-optional-plugin-archives

ADD --chmod=0444 --checksum=sha256:df2c7f5f880da6ab13a43d0cf2efdd8f196802db9ebbffb9492cf81d32b15a62 https://registry.npmjs.org/@openclaw/diagnostics-otel/-/diagnostics-otel-2026.9.1.tgz /diagnostics-otel-2026.9.1.tgz
ADD --chmod=0444 --checksum=sha256:f679af12fa00947d994e6a8454aded205b5bf2454dce0674bff88f741dfb9af8 https://registry.npmjs.org/@openclaw/brave-plugin/-/brave-plugin-2026.9.1.tgz /brave-plugin-2026.9.1.tgz

# hadolint ignore=DL3006
FROM codex-acp-${TARGETARCH}-archive AS codex-acp-platform-archive

# Reviewed-archive invariants (#5896): checksum-addressed source archives,
# committed SRI verification, offline installation, and architecture selection.
FROM npm12 AS codex-acp-runtime
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

FROM npm12 AS wechat-npm-cache
COPY agents/openclaw/wechat-runtime/package.json agents/openclaw/wechat-runtime/package-lock.json /opt/wechat-runtime/
COPY scripts/checks/materialize-locked-npm-cache-seed.mts /scripts/checks/materialize-locked-npm-cache-seed.mts
COPY scripts/lib/seed-reviewed-npm-cache.mts /scripts/lib/seed-reviewed-npm-cache.mts
COPY --from=wechat-npm-archives / /opt/wechat-npm-archives/
RUN --network=none install -d -o root -g root -m 0755 /out/wechat-npm-cache \
    && node /scripts/lib/seed-reviewed-npm-cache.mts \
        --lockfile /opt/wechat-runtime/package-lock.json \
        --cache /out/wechat-npm-cache \
        --registry-origin https://registry.npmjs.org/ \
        --archive @tencent-weixin/openclaw-weixin@2.4.9=/opt/wechat-npm-archives/openclaw-weixin-2.4.9.tgz \
        --archive qrcode-terminal@0.12.0=/opt/wechat-npm-archives/qrcode-terminal-0.12.0.tgz \
        --archive zod@4.4.3=/opt/wechat-npm-archives/zod-4.4.3.tgz \
    && NPM_CONFIG_OFFLINE=true npm ci --prefix /opt/wechat-runtime \
        --ignore-scripts --omit=dev --legacy-peer-deps \
        --userconfig /dev/null --registry https://registry.npmjs.org/ \
        --cache /out/wechat-npm-cache \
    && NPM_CONFIG_OFFLINE=true \
        node /scripts/lib/reviewed-npm-archive.mts \
        --lockfile /opt/wechat-runtime/package-lock.json \
        --cache /out/wechat-npm-cache \
        --registry-origin https://registry.npmjs.org/ \
    && rm -rf /opt/wechat-runtime/node_modules \
    && chown -R root:root /out/wechat-npm-cache \
    && chmod -R a+rX,go-w /out/wechat-npm-cache

FROM scratch AS openclaw-managed-messaging-npm-common-archives-1

ADD --chmod=0444 --checksum=sha256:9d6a926982795204bed8fb5d02537a08b74d0b8f85ec715808fe713e48d14a79 https://registry.npmjs.org/@azure/abort-controller/-/abort-controller-2.2.0.tgz /abort-controller-2.2.0.tgz
ADD --chmod=0444 --checksum=sha256:d2e249d5d010eb18e57c12c610d63e3ca3fa9dd0a5378009c1f465e21f50ab2f https://registry.npmjs.org/abort-controller/-/abort-controller-3.0.0.tgz /abort-controller-3.0.0.tgz
ADD --chmod=0444 --checksum=sha256:173d915f7d88df8cd4db2129a030c3b1c9cafd3b7aee5b89465bf3ad18372542 https://registry.npmjs.org/accepts/-/accepts-2.0.0.tgz /accepts-2.0.0.tgz
ADD --chmod=0444 --checksum=sha256:0ad4c0f28f9bc5bb6f3eb879b4fd38265def6d7e1e5d61f96f78ee6a8a7be94a https://registry.npmjs.org/acorn/-/acorn-8.18.0.tgz /acorn-8.18.0.tgz
ADD --chmod=0444 --checksum=sha256:bc6da06f2a2e6bc80fa5878bd7227bd0318812976d45f47f17e1aafcec2be831 https://registry.npmjs.org/agent-base/-/agent-base-6.0.2.tgz /agent-base-6.0.2.tgz
ADD --chmod=0444 --checksum=sha256:7dd4a61668a9a4e8d4e903f1a254f94d53dafd3f316f2b9b597c5ad8c79cb57e https://registry.npmjs.org/agent-base/-/agent-base-7.1.4.tgz /agent-base-7.1.4.tgz
ADD --chmod=0444 --checksum=sha256:ce2f6c3e6b9f465775bb03625ca4c9dc51c45fce6a81723475681b9e3034c4bd https://registry.npmjs.org/@openclaw/ai/-/ai-2026.9.1.tgz /ai-2026.9.1.tgz
ADD --chmod=0444 --checksum=sha256:b2f0b3a893bbb8cc5efb6814f08b1499e19e31d5dd73683f5893382f48f6e7b3 https://registry.npmjs.org/ajv/-/ajv-8.20.0.tgz /ajv-8.20.0.tgz
ADD --chmod=0444 --checksum=sha256:f4d6980fd367381fd29199066911e863db8d97496613b6c2c5b91563a150acc5 https://registry.npmjs.org/ajv-formats/-/ajv-formats-3.0.1.tgz /ajv-formats-3.0.1.tgz
ADD --chmod=0444 --checksum=sha256:0e0eadcdaada805db5d85b53ad5cdca0760b996ee199ec9658e7b34aa6c8e0d9 https://registry.npmjs.org/ansi-regex/-/ansi-regex-5.0.1.tgz /ansi-regex-5.0.1.tgz
ADD --chmod=0444 --checksum=sha256:2c539a46d85ab6033183997434d2d9a5ca2ceefc12b4db9022f564784cd7987f https://registry.npmjs.org/ansi-styles/-/ansi-styles-4.3.0.tgz /ansi-styles-4.3.0.tgz
ADD --chmod=0444 --checksum=sha256:9cc59e0b515f254ee8ecc9fe584d6fb02d86b2a10f6de6c5d6923ef0d8f8c2a1 https://registry.npmjs.org/asn1.js/-/asn1.js-5.4.1.tgz /asn1.js-5.4.1.tgz
ADD --chmod=0444 --checksum=sha256:0041878b8209f2fa4bcc5e0666355ebc96ff97f360c3054ffe83dbb78ee1c119 https://registry.npmjs.org/@protobufjs/aspromise/-/aspromise-1.1.2.tgz /aspromise-1.1.2.tgz
ADD --chmod=0444 --checksum=sha256:8c254f30f70792645042e4d71f590ec49f8e386a475772f7430c73b964b57dcf https://registry.npmjs.org/asynckit/-/asynckit-0.4.0.tgz /asynckit-0.4.0.tgz
ADD --chmod=0444 --checksum=sha256:a511049fdaec40a320368b3ee965079b3e14481f82d052584f746bbdc3f01ede https://registry.npmjs.org/axios/-/axios-1.19.0.tgz /axios-1.19.0.tgz
ADD --chmod=0444 --checksum=sha256:5aa2dc9a5d6ced926e4b6ca8ef8e0253b118867e240db8650c49379e972c12ac https://registry.npmjs.org/axios/-/axios-1.20.0.tgz /axios-1.20.0.tgz
ADD --chmod=0444 --checksum=sha256:9025508d9125eee531bbc49ce3ae560183975ad595f058c378bd56af4152fb16 https://registry.npmjs.org/balanced-match/-/balanced-match-4.0.4.tgz /balanced-match-4.0.4.tgz
ADD --chmod=0444 --checksum=sha256:0130711d2e0d3f87436c7825db1f35bd6134fba2eda64b0df43d781f9b6a596a https://registry.npmjs.org/@stablelib/base64/-/base64-1.0.1.tgz /base64-1.0.1.tgz
ADD --chmod=0444 --checksum=sha256:d67e6ee6e1445512478cdfc34c12144f579bdd9f06529eef3ef8d88f84031a6a https://registry.npmjs.org/@protobufjs/base64/-/base64-1.1.2.tgz /base64-1.1.2.tgz
ADD --chmod=0444 --checksum=sha256:b1b7a945b52685269083425216d6597e33d97bf21699d656e92fdb3eb5210a85 https://registry.npmjs.org/base64-js/-/base64-js-1.5.1.tgz /base64-js-1.5.1.tgz
ADD --chmod=0444 --checksum=sha256:f5a943ea290e66f64cb9adaaed2ff1b7c4ee02a4cca9d709d9c9c6c222512e82 https://registry.npmjs.org/bignumber.js/-/bignumber.js-9.3.1.tgz /bignumber.js-9.3.1.tgz
ADD --chmod=0444 --checksum=sha256:50c550f01680444f2d5985b78bab8976ea17c3f43963a8fdc39bdbb4489fb5fb https://registry.npmjs.org/bn.js/-/bn.js-4.12.5.tgz /bn.js-4.12.5.tgz
ADD --chmod=0444 --checksum=sha256:031d7f6c5142e31be91d36a43f541f02a505943e3b871aa44ef5fb6939be258e https://registry.npmjs.org/body-parser/-/body-parser-2.3.0.tgz /body-parser-2.3.0.tgz
ADD --chmod=0444 --checksum=sha256:9c8433ec18090ee5b75246976b368169aa7af7685626fdb41deaffdbe683fb92 https://registry.npmjs.org/boolbase/-/boolbase-2.0.0.tgz /boolbase-2.0.0.tgz
ADD --chmod=0444 --checksum=sha256:a62dcc8a1260148fde067d36acc601a20532a34626e3b862b5f9eea140d97060 https://registry.npmjs.org/bottleneck/-/bottleneck-2.19.5.tgz /bottleneck-2.19.5.tgz
ADD --chmod=0444 --checksum=sha256:5d06001fddd25cbee90c96db4dc5b7b57711b984c3141e28d10f143deb52dbaf https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.9.tgz /brace-expansion-5.0.9.tgz
ADD --chmod=0444 --checksum=sha256:8f455159e342103e7854ed6a4cc73edbab144d857917c88edefea862f09fe75a https://registry.npmjs.org/buffer-equal-constant-time/-/buffer-equal-constant-time-1.0.1.tgz /buffer-equal-constant-time-1.0.1.tgz
ADD --chmod=0444 --checksum=sha256:9c2b03d59eca8f463a1927e07273ddaa87785fe3f61626c42b005540e962e343 https://registry.npmjs.org/buffer-from/-/buffer-from-1.1.2.tgz /buffer-from-1.1.2.tgz
ADD --chmod=0444 --checksum=sha256:35e49d4240c91cbe4ca29926139feea848302e9eea317f31d9e81b972ce90911 https://registry.npmjs.org/bundle-name/-/bundle-name-4.1.0.tgz /bundle-name-4.1.0.tgz
ADD --chmod=0444 --checksum=sha256:835e37ad5a40da45eaed6e32d99847627a15b2a4671741182521fe48dee3c581 https://registry.npmjs.org/bytes/-/bytes-3.1.2.tgz /bytes-3.1.2.tgz
ADD --chmod=0444 --checksum=sha256:073e9ff9dbabedf5c128020a677381e9f92c90188d118830b30a7656a7c37d2c https://registry.npmjs.org/call-bind-apply-helpers/-/call-bind-apply-helpers-1.0.2.tgz /call-bind-apply-helpers-1.0.2.tgz
ADD --chmod=0444 --checksum=sha256:32086f492fedf1b9b34811f2ee50ca2cca53da5c783f7cd5f939d3f1e86bbd32 https://registry.npmjs.org/call-bound/-/call-bound-1.0.4.tgz /call-bound-1.0.4.tgz
ADD --chmod=0444 --checksum=sha256:c609324ab889515f2f7354ddcc319b6080c9b76f2ac1441c03da031c85458696 https://registry.npmjs.org/camelcase/-/camelcase-5.3.1.tgz /camelcase-5.3.1.tgz
ADD --chmod=0444 --checksum=sha256:85d0ce26b8a6098d3826d9ec17cf16c7a9326dfce3f2545ecc1133581c981399 https://registry.npmjs.org/chalk/-/chalk-6.0.0.tgz /chalk-6.0.0.tgz
ADD --chmod=0444 --checksum=sha256:45d07ea7d57ee482c733ab3c547cc49edc1423bc231507e41ff99d2711f7f5e3 https://registry.npmjs.org/chokidar/-/chokidar-5.0.0.tgz /chokidar-5.0.0.tgz
ADD --chmod=0444 --checksum=sha256:4c24f5daa630142252da89de655f7df090ea479450a8825897751d78321b1360 https://registry.npmjs.org/chownr/-/chownr-3.0.0.tgz /chownr-3.0.0.tgz
ADD --chmod=0444 --checksum=sha256:1ff67ff6e5c7272a6e9ed3fc1b247375e5951552d756aef2edb32e9fcbfdd54c https://registry.npmjs.org/@homebridge/ciao/-/ciao-1.3.12.tgz /ciao-1.3.12.tgz
ADD --chmod=0444 --checksum=sha256:c40842cd98848293638a1db177c326ec42b97376994ed0238ebf20f7515b7ac2 https://registry.npmjs.org/clawpdf/-/clawpdf-0.3.1.tgz /clawpdf-0.3.1.tgz
ADD --chmod=0444 --checksum=sha256:538bfc9753338f8eb816c46e7e541b3bbada18446cf8b5149cfaaafff01acbd8 https://registry.npmjs.org/cliui/-/cliui-6.0.0.tgz /cliui-6.0.0.tgz
ADD --chmod=0444 --checksum=sha256:defad1e25e8a349ea9cdd1066abf5e1e762f7f909de72bdca67bb35f77468c8d https://registry.npmjs.org/cliui/-/cliui-8.0.1.tgz /cliui-8.0.1.tgz
ADD --chmod=0444 --checksum=sha256:20bafed1221bcba23a2450a841998edaef9a56bc2101d6e38c2117dd58a13a01 https://registry.npmjs.org/@protobufjs/codegen/-/codegen-2.0.5.tgz /codegen-2.0.5.tgz
ADD --chmod=0444 --checksum=sha256:920fa43538c019a085dbbf04cb6f72cc337624e5f5217519f0e7b2ef784e7ce1 https://registry.npmjs.org/color-convert/-/color-convert-2.0.1.tgz /color-convert-2.0.1.tgz
ADD --chmod=0444 --checksum=sha256:507b7c4461e8eb941355af9a59e9a7e02cd0e7c6176b48d1809766344f3f1708 https://registry.npmjs.org/color-name/-/color-name-1.1.4.tgz /color-name-1.1.4.tgz
ADD --chmod=0444 --checksum=sha256:b6be5aabe53e90635beb77cd0e0ba7ae6a25c8cf903b15fcc342353e732e1512 https://registry.npmjs.org/combined-stream/-/combined-stream-1.0.8.tgz /combined-stream-1.0.8.tgz
ADD --chmod=0444 --checksum=sha256:632c1e039b31e98fa79c4fae5b10a5ffbbf9df0f21c9ffb3d74e95734b30696f https://registry.npmjs.org/commander/-/commander-15.0.0.tgz /commander-15.0.0.tgz
ADD --chmod=0444 --checksum=sha256:2f8b1925a8b123a86606c11322fc10aafc1dd85f2860fffe32893e20aef4093c https://registry.npmjs.org/content-disposition/-/content-disposition-1.1.0.tgz /content-disposition-1.1.0.tgz
ADD --chmod=0444 --checksum=sha256:ac31d098405f0242dd712218f38a14a6202bd4eb01067db05db765d9a9bd12c8 https://registry.npmjs.org/content-type/-/content-type-1.0.5.tgz /content-type-1.0.5.tgz
ADD --chmod=0444 --checksum=sha256:47a08ee5ddf87a96dd263aa942c5e04b2c5d26251e04affa8ace6804b450d758 https://registry.npmjs.org/content-type/-/content-type-2.1.0.tgz /content-type-2.1.0.tgz
ADD --chmod=0444 --checksum=sha256:76b160f8251c630a116a2e0acf03557b0758975b2c0df800607248fc9aae9e20 https://registry.npmjs.org/cookie/-/cookie-0.7.2.tgz /cookie-0.7.2.tgz
ADD --chmod=0444 --checksum=sha256:4d2bbaaf1c299e60ef0d7df952b52af95b20d56cbcbd4468d4210650083553d3 https://registry.npmjs.org/cookie-signature/-/cookie-signature-1.2.2.tgz /cookie-signature-1.2.2.tgz
ADD --chmod=0444 --checksum=sha256:74d7950698bdc74569a8e754b2d5dc055a43afdd0647c0171595f9b77e8c7151 https://registry.npmjs.org/@ubjs/core/-/core-0.31.0-3.tgz /core-0.31.0-3.tgz
ADD --chmod=0444 --checksum=sha256:caf1d94fa748509b3fa6c91bf051547df62bcae204ec521d418759da1f573950 https://registry.npmjs.org/@emnapi/core/-/core-1.11.1.tgz /core-1.11.1.tgz
ADD --chmod=0444 --checksum=sha256:f5931d5be3c05b61a77eaacad34ce63ac55f3778a19f18dd2895e5fa143e1350 https://registry.npmjs.org/@clack/core/-/core-1.4.3.tgz /core-1.4.3.tgz
ADD --chmod=0444 --checksum=sha256:bf85fa99c2ee437ddeb8170239831ad3ed0a5e3ce4373cecbb75d0968ea94b46 https://registry.npmjs.org/@azure/core-auth/-/core-auth-1.11.0.tgz /core-auth-1.11.0.tgz
ADD --chmod=0444 --checksum=sha256:b930d21bfea5de2d2fb4ea6cfd503d5efe39e9fe7237a27a91c1a4140a260da1 https://registry.npmjs.org/@azure/core-client/-/core-client-1.11.1.tgz /core-client-1.11.1.tgz
ADD --chmod=0444 --checksum=sha256:9baf4ef06cad5cacc1631ac280f13fd77b47afc60cbdebb83d69f3b6c4c575af https://registry.npmjs.org/@azure/core-process/-/core-process-1.0.0.tgz /core-process-1.0.0.tgz
ADD --chmod=0444 --checksum=sha256:a30ebbee6ac861222deec7398ea217a53e40e39f765c4ce07ff262328b79e318 https://registry.npmjs.org/@azure/core-rest-pipeline/-/core-rest-pipeline-1.25.0.tgz /core-rest-pipeline-1.25.0.tgz
ADD --chmod=0444 --checksum=sha256:714a6d1ece81b22c3091d0637a884179eabd4c890699b0ab5fe9b94b42aeca3e https://registry.npmjs.org/@azure/core-tracing/-/core-tracing-1.4.0.tgz /core-tracing-1.4.0.tgz
ADD --chmod=0444 --checksum=sha256:4ddc509f4a86499a5455e73eeed2101a56d3e3261ae22950d5829644904f20eb https://registry.npmjs.org/@azure/core-util/-/core-util-1.14.0.tgz /core-util-1.14.0.tgz
ADD --chmod=0444 --checksum=sha256:4430fdc71f2cf3b5e297113b9a692da2d6cff96cf84da00f0ecef5e5a6e74d0c https://registry.npmjs.org/core-util-is/-/core-util-is-1.0.3.tgz /core-util-is-1.0.3.tgz
ADD --chmod=0444 --checksum=sha256:32242124397140800e1238a252b4cd74669d58c81b655d9d3721789b56c1c1ff https://registry.npmjs.org/cors/-/cors-2.8.6.tgz /cors-2.8.6.tgz
ADD --chmod=0444 --checksum=sha256:d6d93c286125fed567b986a576ff1daa74e72d56bb63fe28248ca17cfcb00cee https://registry.npmjs.org/croner/-/croner-10.0.1.tgz /croner-10.0.1.tgz
ADD --chmod=0444 --checksum=sha256:188c320cdc413adfec03098fda72af7a9b02152ba13d3a8f87f172d93ced38ea https://registry.npmjs.org/cross-spawn/-/cross-spawn-7.0.6.tgz /cross-spawn-7.0.6.tgz
ADD --chmod=0444 --checksum=sha256:7c35ad92211a399ed536174c12ede417bc8b96100895cad78be9010e9c84419f https://registry.npmjs.org/css-select/-/css-select-7.0.0.tgz /css-select-7.0.0.tgz
ADD --chmod=0444 --checksum=sha256:1eccce8f4d523832253a082815495f823b8621d0aab6a2eea5853d0d37eb4417 https://registry.npmjs.org/css-what/-/css-what-8.0.0.tgz /css-what-8.0.0.tgz
ADD --chmod=0444 --checksum=sha256:3c5d870a99e6d22f185a606adb757937975a6cecbbc7eeacd7340382438be599 https://registry.npmjs.org/cssom/-/cssom-0.5.0.tgz /cssom-0.5.0.tgz
ADD --chmod=0444 --checksum=sha256:63f39252e4ac367fc212bd550ce0d9de72753672cb08301fe8f80ea99e8782a7 https://registry.npmjs.org/@trycua/cua-driver/-/cua-driver-0.22.0.tgz /cua-driver-0.22.0.tgz
ADD --chmod=0444 --checksum=sha256:a5742b1b775d0b29fb562ff7e12f7ca19874e1c47322087b47a79230791642a1 https://registry.npmjs.org/data-uri-to-buffer/-/data-uri-to-buffer-4.0.1.tgz /data-uri-to-buffer-4.0.1.tgz
ADD --chmod=0444 --checksum=sha256:89c1ac9c946ee8905a875837114528e97eeae35e03be3190584b2216af43e4a7 https://registry.npmjs.org/debug/-/debug-4.4.3.tgz /debug-4.4.3.tgz
ADD --chmod=0444 --checksum=sha256:b4adeff510e38c3a02703bcba72ffbe3c65b591f13c78c6a459b5e801a3e2864 https://registry.npmjs.org/decamelize/-/decamelize-1.2.0.tgz /decamelize-1.2.0.tgz
ADD --chmod=0444 --checksum=sha256:221997185065b746a870ddd6f1ed85aaeeaf666183ee927d0ab9a6fe29f1be26 https://registry.npmjs.org/default-browser/-/default-browser-5.5.1.tgz /default-browser-5.5.1.tgz
ADD --chmod=0444 --checksum=sha256:3c94fbe0d90b610de6dc068180c780cbb7ef0ade6d2f3a7b5401f99f215d7429 https://registry.npmjs.org/default-browser-id/-/default-browser-id-5.0.1.tgz /default-browser-id-5.0.1.tgz
ADD --chmod=0444 --checksum=sha256:bbe9fe67a229c64ff9b8c77ace12278e2d44048a2a5af96e5fc95abbc94c49b5 https://registry.npmjs.org/define-lazy-prop/-/define-lazy-prop-3.0.0.tgz /define-lazy-prop-3.0.0.tgz
ADD --chmod=0444 --checksum=sha256:ac38fce4217dfb1d772427c7d8d0d073e35ecd832915e97a61d9ab5c504129d3 https://registry.npmjs.org/delayed-stream/-/delayed-stream-1.0.0.tgz /delayed-stream-1.0.0.tgz
ADD --chmod=0444 --checksum=sha256:28a58a2056093441f1d00d677d95918d2e4b3e98bac86237159101cae315d4a7 https://registry.npmjs.org/depd/-/depd-2.0.0.tgz /depd-2.0.0.tgz
ADD --chmod=0444 --checksum=sha256:b898bf23c95594607576e25ddd4013f1d51ed0e862aaf0732815830c87b3b58f https://registry.npmjs.org/diff/-/diff-9.0.0.tgz /diff-9.0.0.tgz
ADD --chmod=0444 --checksum=sha256:07149886ab98299c227b8de61912770b24b8a17b250996a4b5727c9f8bff4c00 https://registry.npmjs.org/dijkstrajs/-/dijkstrajs-1.0.3.tgz /dijkstrajs-1.0.3.tgz
ADD --chmod=0444 --checksum=sha256:4437fb157829af52cdfe2acc19cc03378db5052f8e521862ee702293e01c28ac https://registry.npmjs.org/@openclaw/discord/-/discord-2026.9.1.tgz /discord-2026.9.1.tgz
ADD --chmod=0444 --checksum=sha256:e34511f144fc6b34ce536bd60fb1ed27dd965f07a7c317407e79dd6be9e8f399 https://registry.npmjs.org/dom-serializer/-/dom-serializer-2.0.0.tgz /dom-serializer-2.0.0.tgz
ADD --chmod=0444 --checksum=sha256:12272f96b8a76363d78b67d7695b73410f339171f56a6cc5793cb4bfc6b15aa0 https://registry.npmjs.org/dom-serializer/-/dom-serializer-3.1.1.tgz /dom-serializer-3.1.1.tgz
ADD --chmod=0444 --checksum=sha256:c67164b4a994eaeaecbd968c2e5e5415407ae6fb4486bbb470594154e25feb45 https://registry.npmjs.org/domelementtype/-/domelementtype-2.3.0.tgz /domelementtype-2.3.0.tgz
ADD --chmod=0444 --checksum=sha256:078a496be3f33f3268f6749b3a5d45629f4b98beca1e53e3ef6d1ba2040811d5 https://registry.npmjs.org/domelementtype/-/domelementtype-3.0.0.tgz /domelementtype-3.0.0.tgz
ADD --chmod=0444 --checksum=sha256:f3952abb7e2635d8e942822d68cfb1fdaba61148d17a1a5692bdd163d6ca4784 https://registry.npmjs.org/domhandler/-/domhandler-5.0.3.tgz /domhandler-5.0.3.tgz
ADD --chmod=0444 --checksum=sha256:c42bd0d96c5a10ebcfd938fa1fd97db12b9f592a485fb75d9aba5fa66e66d93b https://registry.npmjs.org/domhandler/-/domhandler-6.0.1.tgz /domhandler-6.0.1.tgz
ADD --chmod=0444 --checksum=sha256:272918a13e7e093ddc983666954164e098fb2443f06f476f34bf47005e12c140 https://registry.npmjs.org/domutils/-/domutils-3.2.2.tgz /domutils-3.2.2.tgz
ADD --chmod=0444 --checksum=sha256:64922a8f80c4c31a0d146e563ba054de86453c0d78e50fba66e4e8c8462a95ac https://registry.npmjs.org/domutils/-/domutils-4.0.2.tgz /domutils-4.0.2.tgz
ADD --chmod=0444 --checksum=sha256:8648852be8209110b34dca75dcc3ed12ce7fae9fcc8edd1ef9e180e708af1398 https://registry.npmjs.org/dotenv/-/dotenv-17.4.2.tgz /dotenv-17.4.2.tgz
ADD --chmod=0444 --checksum=sha256:ed1342228c82c10df9921c59d684df516a0cd6ed25b61e5f9d6330895326cfdb https://registry.npmjs.org/dunder-proto/-/dunder-proto-1.0.1.tgz /dunder-proto-1.0.1.tgz
ADD --chmod=0444 --checksum=sha256:487cb94dff2414772c3bb648a5e4e41c03cbbcc64263d08a56e36d735fc848fe https://registry.npmjs.org/ecdsa-sig-formatter/-/ecdsa-sig-formatter-1.0.11.tgz /ecdsa-sig-formatter-1.0.11.tgz
ADD --chmod=0444 --checksum=sha256:5148e8eb7e222b2a09127618bbdb5033daf6262cfc735d3101ea98620128b99c https://registry.npmjs.org/ee-first/-/ee-first-1.1.1.tgz /ee-first-1.1.1.tgz
ADD --chmod=0444 --checksum=sha256:b5ccd9fbfb08098eefbeb6b6b4b40db6db3acf9243e327e039925aa8661cb107 https://registry.npmjs.org/emoji-regex/-/emoji-regex-8.0.0.tgz /emoji-regex-8.0.0.tgz

FROM scratch AS openclaw-managed-messaging-npm-common-archives-2

ADD --chmod=0444 --checksum=sha256:9b2e418b8851b8f9e7a13d5ada3bd4d3c5ef042885867261f556347d4bbefb29 https://registry.npmjs.org/encodeurl/-/encodeurl-2.0.0.tgz /encodeurl-2.0.0.tgz
ADD --chmod=0444 --checksum=sha256:6b0c60f7351a0b65bb1fc8dbb9299f09e7ecf6d89103d0651bf369e6f463a632 https://registry.npmjs.org/entities/-/entities-4.5.0.tgz /entities-4.5.0.tgz
ADD --chmod=0444 --checksum=sha256:554b7e2a79fa9eda0439714011fa42d77c6829842faa91e022070015bfd483a0 https://registry.npmjs.org/entities/-/entities-7.0.1.tgz /entities-7.0.1.tgz
ADD --chmod=0444 --checksum=sha256:8e8b16388e19c12fc80f9f75f518a0f83d99428be6765a38f04c264a078cc25b https://registry.npmjs.org/entities/-/entities-8.0.0.tgz /entities-8.0.0.tgz
ADD --chmod=0444 --checksum=sha256:5986b8b13121340a8b0d5c7d8f0f961aa80ef3a74515ca9cb7a78d86ed0385f7 https://registry.npmjs.org/es-define-property/-/es-define-property-1.0.1.tgz /es-define-property-1.0.1.tgz
ADD --chmod=0444 --checksum=sha256:d14dd1c35b4bd3b8aca3219fd3627eb7f3eb49cf6b4c8a7ca58b91fd7a190993 https://registry.npmjs.org/es-errors/-/es-errors-1.3.0.tgz /es-errors-1.3.0.tgz
ADD --chmod=0444 --checksum=sha256:f295c5df6751c65b4b9492b03c88fab5e13419de28a51ecdf17e693b4a421af0 https://registry.npmjs.org/es-object-atoms/-/es-object-atoms-1.1.2.tgz /es-object-atoms-1.1.2.tgz
ADD --chmod=0444 --checksum=sha256:5675f51a5c33ee402bff8a2a341a0390f85e82d3c199859244d2f67091b0b93d https://registry.npmjs.org/es-set-tostringtag/-/es-set-tostringtag-2.1.0.tgz /es-set-tostringtag-2.1.0.tgz
ADD --chmod=0444 --checksum=sha256:ba2755afc0e6c6705326711fd218ebe107a527eccbd6485155fde98ed000bee7 https://registry.npmjs.org/escalade/-/escalade-3.2.0.tgz /escalade-3.2.0.tgz
ADD --chmod=0444 --checksum=sha256:a101155c3cbdfb1e4f98f2f83c8b5e392db6accfa606df0eba8b87a5762b0366 https://registry.npmjs.org/escape-html/-/escape-html-1.0.3.tgz /escape-html-1.0.3.tgz
ADD --chmod=0444 --checksum=sha256:f6a96c78a973d2ab660c9efeee6aa74a399cd9e770625ba1ed95e1aca9fd0faf https://registry.npmjs.org/etag/-/etag-1.8.1.tgz /etag-1.8.1.tgz
ADD --chmod=0444 --checksum=sha256:f0717da2cde5c703b92e66906623724959c23ac14e9439c436b84c8a4f5b26bc https://registry.npmjs.org/event-target-shim/-/event-target-shim-5.0.1.tgz /event-target-shim-5.0.1.tgz
ADD --chmod=0444 --checksum=sha256:5536b98cb7062e771c1dadd1828e352ebe40034f1480836f21c776ec372a797c https://registry.npmjs.org/@protobufjs/eventemitter/-/eventemitter-1.1.1.tgz /eventemitter-1.1.1.tgz
ADD --chmod=0444 --checksum=sha256:7c62d4bb196e59b39c5af79e550d6fe4261649a74d9f5e605b071e1da6081c92 https://registry.npmjs.org/eventsource/-/eventsource-3.0.7.tgz /eventsource-3.0.7.tgz
ADD --chmod=0444 --checksum=sha256:44a0a0ca6cecea76ac47de3e73414ceb32dbbfb8f3b6408906d81170c68e36ed https://registry.npmjs.org/eventsource-parser/-/eventsource-parser-3.1.1.tgz /eventsource-parser-3.1.1.tgz
ADD --chmod=0444 --checksum=sha256:b2f53cb1b3da8f1e3f27007641cdd419df34215eb704dfccfe0899603da64cc8 https://registry.npmjs.org/execa/-/execa-10.0.1.tgz /execa-10.0.1.tgz
ADD --chmod=0444 --checksum=sha256:1773a16c02b4422653479b9c4d211268f7022bdac0d817b5698535bb485dd005 https://registry.npmjs.org/express/-/express-5.2.1.tgz /express-5.2.1.tgz
ADD --chmod=0444 --checksum=sha256:1e3ed770c901156477986dfc189fb0b5bd8d8a8e6481393954ed4f6265d139b0 https://registry.npmjs.org/express-rate-limit/-/express-rate-limit-8.7.0.tgz /express-rate-limit-8.7.0.tgz
ADD --chmod=0444 --checksum=sha256:1d91d0b0faa50cba223fa937c7b5a4a662968b1d78b3e59dca5c917dd5cf72b2 https://registry.npmjs.org/extend/-/extend-3.0.2.tgz /extend-3.0.2.tgz
ADD --chmod=0444 --checksum=sha256:b019a0980f27638dc3f85836b0e478f188e00d7a6e5852c0819fa86f56e47b8f https://registry.npmjs.org/fast-deep-equal/-/fast-deep-equal-3.1.3.tgz /fast-deep-equal-3.1.3.tgz
ADD --chmod=0444 --checksum=sha256:4f897ea2594dc9cfb1250e7d4d0f65b4f105952a802fff2d06990bf1dc2c84f6 https://registry.npmjs.org/fast-sha256/-/fast-sha256-1.3.0.tgz /fast-sha256-1.3.0.tgz
ADD --chmod=0444 --checksum=sha256:b5dace35423470b453ed5dba20419052124b8a65cb233833f17e5483523b5eb1 https://registry.npmjs.org/fast-string-truncated-width/-/fast-string-truncated-width-3.0.3.tgz /fast-string-truncated-width-3.0.3.tgz
ADD --chmod=0444 --checksum=sha256:72daf113df209b0e55a227ff5f62683ca99da07b59c5da36a2da62920cb3752a https://registry.npmjs.org/fast-string-width/-/fast-string-width-3.0.2.tgz /fast-string-width-3.0.2.tgz
ADD --chmod=0444 --checksum=sha256:3fa380284be4ecbf471c1dbb8c5da6f517c95f54279f88c2037985d03fdc6d92 https://registry.npmjs.org/fast-uri/-/fast-uri-3.1.7.tgz /fast-uri-3.1.7.tgz
ADD --chmod=0444 --checksum=sha256:678d765d4c73db3173506593cae33d6a8437ed32a95ac02dc878a5f0b03bca5c https://registry.npmjs.org/fast-uri/-/fast-uri-4.1.4.tgz /fast-uri-4.1.4.tgz
ADD --chmod=0444 --checksum=sha256:f6b4a10f346b4405f01a1734be4c29b1aba315977f409ed11ea12ff2d3fae051 https://registry.npmjs.org/fast-wrap-ansi/-/fast-wrap-ansi-0.2.2.tgz /fast-wrap-ansi-0.2.2.tgz
ADD --chmod=0444 --checksum=sha256:54481d9c62debce1c38b0239f2358eeb3b73f7bb1ba3105bd6123fd81b8b7268 https://registry.npmjs.org/@protobufjs/fetch/-/fetch-1.1.1.tgz /fetch-1.1.1.tgz
ADD --chmod=0444 --checksum=sha256:4abf0d58a4977fce2240e08c280a2bc59f5363e9553a4f236cea6d74cce40c52 https://registry.npmjs.org/fetch-blob/-/fetch-blob-3.2.0.tgz /fetch-blob-3.2.0.tgz
ADD --chmod=0444 --checksum=sha256:30fb155c772891ddf5611d238216eab7a4b4088492abed725b3809f038e51dfc https://registry.npmjs.org/figures/-/figures-6.1.0.tgz /figures-6.1.0.tgz
ADD --chmod=0444 --checksum=sha256:3e4b714a5392181ea09eed71fc09dfcadd9791d4ace8a877dcb46e416c512df6 https://registry.npmjs.org/file-type/-/file-type-22.0.2.tgz /file-type-22.0.2.tgz
ADD --chmod=0444 --checksum=sha256:22949bfc51a620b3598bbe67d65619a9efd781d52704a38d7ba675e248a8b872 https://registry.npmjs.org/finalhandler/-/finalhandler-2.1.1.tgz /finalhandler-2.1.1.tgz
ADD --chmod=0444 --checksum=sha256:33a9b0535306d2e05e0a27088b68344b52ac767d576ef60b7ab173aa0d5a26eb https://registry.npmjs.org/find-up/-/find-up-4.1.0.tgz /find-up-4.1.0.tgz
ADD --chmod=0444 --checksum=sha256:20b3d612d53281b754602d52a8e6a6e09032169d5399e515f6f5e8b7d3de712d https://registry.npmjs.org/@protobufjs/float/-/float-1.0.2.tgz /float-1.0.2.tgz
ADD --chmod=0444 --checksum=sha256:eba127bdabdf79d668187c7bac7123c136eee08930dd421416ba8a72613bae77 https://registry.npmjs.org/follow-redirects/-/follow-redirects-1.16.0.tgz /follow-redirects-1.16.0.tgz
ADD --chmod=0444 --checksum=sha256:fc4d94e9b629f5378367ba46da7d96115696c01e25c99cd57c2c9a3d098bb557 https://registry.npmjs.org/form-data/-/form-data-4.0.6.tgz /form-data-4.0.6.tgz
ADD --chmod=0444 --checksum=sha256:1ff73b4138ea33f0fd0f41b67910409a2c8eb1b71a4cf1a4f8ab738a6e8487e9 https://registry.npmjs.org/formdata-polyfill/-/formdata-polyfill-4.0.10.tgz /formdata-polyfill-4.0.10.tgz
ADD --chmod=0444 --checksum=sha256:9b5a5de95fb85fcb58db5e4fcd94ce8ab9f0476d02202e20a5225cec60431c99 https://registry.npmjs.org/forwarded/-/forwarded-0.2.0.tgz /forwarded-0.2.0.tgz
ADD --chmod=0444 --checksum=sha256:ad08397ab05f62b2b507682e23aad699cf8cc33922e0030be0cb640a23277ad7 https://registry.npmjs.org/fresh/-/fresh-2.0.0.tgz /fresh-2.0.0.tgz
ADD --chmod=0444 --checksum=sha256:7ac286e3cccc1ea8980e79e2039def6bb97d3182e17951cd9094f0400ed98236 https://registry.npmjs.org/@isaacs/fs-minipass/-/fs-minipass-4.0.1.tgz /fs-minipass-4.0.1.tgz
ADD --chmod=0444 --checksum=sha256:bf8e6564a22636bae6a96efc6935482902c12ea8fea94799b00794406be52b54 https://registry.npmjs.org/@openclaw/fs-safe/-/fs-safe-0.7.0.tgz /fs-safe-0.7.0.tgz
ADD --chmod=0444 --checksum=sha256:704402651b02a1454f17d445fc7dd716efc282d059407126d58ef30a47e807aa https://registry.npmjs.org/function-bind/-/function-bind-1.1.2.tgz /function-bind-1.1.2.tgz
ADD --chmod=0444 --checksum=sha256:439c4c3b435011c92f9c725bd461e2253a4e0c6d780f1b7057a45f591c69999c https://registry.npmjs.org/gaxios/-/gaxios-7.3.1.tgz /gaxios-7.3.1.tgz
ADD --chmod=0444 --checksum=sha256:f9c3f2c868755c074152ecd291733c56c536678b0284c34c3613365bc730db94 https://registry.npmjs.org/gcp-metadata/-/gcp-metadata-8.1.2.tgz /gcp-metadata-8.1.2.tgz
ADD --chmod=0444 --checksum=sha256:4d86f0ad25dc3ea6cbbbd274dc0ef199614cedb795bba388befaee364022f69a https://registry.npmjs.org/@google/genai/-/genai-2.18.0.tgz /genai-2.18.0.tgz
ADD --chmod=0444 --checksum=sha256:7b13e1c81949ff4c1baae4ac4e34990492d5e8a86dab7e3b90027b1f5126935f https://registry.npmjs.org/get-caller-file/-/get-caller-file-2.0.5.tgz /get-caller-file-2.0.5.tgz
ADD --chmod=0444 --checksum=sha256:4451f58e2f5a4ef27ae8b4ba25b64be97d3a8413dc8614a4321a10d418eee6d7 https://registry.npmjs.org/get-east-asian-width/-/get-east-asian-width-1.6.0.tgz /get-east-asian-width-1.6.0.tgz
ADD --chmod=0444 --checksum=sha256:662e27e54e00fe46fbb08f9f4aacb054e3695dbe72cc14b436613fbcfb780544 https://registry.npmjs.org/get-intrinsic/-/get-intrinsic-1.3.0.tgz /get-intrinsic-1.3.0.tgz
ADD --chmod=0444 --checksum=sha256:eb2cc52afb1f1fd82c5fc2a58c2380f0f16fdcdb5631538f3c66887435d70681 https://registry.npmjs.org/get-proto/-/get-proto-1.0.1.tgz /get-proto-1.0.1.tgz
ADD --chmod=0444 --checksum=sha256:8e676f6d730ce38f01d0772936df1b33750c38e5dec6ad18c522a6a1622124c6 https://registry.npmjs.org/get-stream/-/get-stream-9.0.1.tgz /get-stream-9.0.1.tgz
ADD --chmod=0444 --checksum=sha256:499530b85428ea27785a8ea1772458d6b821d2c917cbc1ae8f8843dca9b5327a https://registry.npmjs.org/google-auth-library/-/google-auth-library-10.9.1.tgz /google-auth-library-10.9.1.tgz
ADD --chmod=0444 --checksum=sha256:3a921c0d4e333f94be726fc2c0ce10025f8d87f8fae5affa01a52b2da7970bbd https://registry.npmjs.org/google-logging-utils/-/google-logging-utils-1.1.3.tgz /google-logging-utils-1.1.3.tgz
ADD --chmod=0444 --checksum=sha256:e546bf34ceb7c7e68a72fe2653e7a8a1a6580a0d94f9c9586b8e67e4b54ac06b https://registry.npmjs.org/@openclaw/googlechat/-/googlechat-2026.9.1.tgz /googlechat-2026.9.1.tgz
ADD --chmod=0444 --checksum=sha256:d536d0de4dd285dc1468fbb7f39334a47ee0eec9c27f9b626a6e71466c9fda82 https://registry.npmjs.org/gopd/-/gopd-1.2.0.tgz /gopd-1.2.0.tgz
ADD --chmod=0444 --checksum=sha256:458f09c6841494e240e64c3b0d2fab86aa84387d9a4d1abb44909a39c1e857cb https://registry.npmjs.org/grammy/-/grammy-1.46.0.tgz /grammy-1.46.0.tgz
ADD --chmod=0444 --checksum=sha256:4460c7532f28b8df2ddc9a1ec17816d43c24d4b9591dc6c5936b82f7f86ae7c5 https://registry.npmjs.org/has-symbols/-/has-symbols-1.1.0.tgz /has-symbols-1.1.0.tgz
ADD --chmod=0444 --checksum=sha256:dc1c74e3f1179a6271f84747d72c89f258aa46ad3e6464fae0e41737a7f0ef7b https://registry.npmjs.org/has-tostringtag/-/has-tostringtag-1.0.2.tgz /has-tostringtag-1.0.2.tgz
ADD --chmod=0444 --checksum=sha256:e9d2b03f95573600e1c13124ce618e3142ed2c538d164595bedcd4408b8a4e4c https://registry.npmjs.org/hasown/-/hasown-2.0.4.tgz /hasown-2.0.4.tgz
ADD --chmod=0444 --checksum=sha256:accbfaaab745088609b4eea2bdca2ad62f1f1dd27304e0f8df65cfe0fe042143 https://registry.npmjs.org/highlight.js/-/highlight.js-11.12.0.tgz /highlight.js-11.12.0.tgz
ADD --chmod=0444 --checksum=sha256:f65df37793984664c02158c11575ebaf922bc50ef2de36dfa96f311519c5e95d https://registry.npmjs.org/hono/-/hono-4.13.7.tgz /hono-4.13.7.tgz
ADD --chmod=0444 --checksum=sha256:4ebca2d4a11bf7fcf6898fb17fb3ba6d7ac9bbda226a9064bc1a4488bbe8a0be https://registry.npmjs.org/hosted-git-info/-/hosted-git-info-10.1.1.tgz /hosted-git-info-10.1.1.tgz
ADD --chmod=0444 --checksum=sha256:19c5627ca8032d56a0ddbf2c80132ee8f5ab257161e3767b608cb5e3b96dd109 https://registry.npmjs.org/html-escaper/-/html-escaper-3.0.3.tgz /html-escaper-3.0.3.tgz
ADD --chmod=0444 --checksum=sha256:0651eb776dbf530c8c77fb4ca6ad39fc14863a44eac2486981e78d004fad877d https://registry.npmjs.org/htmlparser2/-/htmlparser2-10.1.0.tgz /htmlparser2-10.1.0.tgz
ADD --chmod=0444 --checksum=sha256:24d56ba3da8f09b34544eccbe34634b38683457c665569cb9c70b94a8eb7706e https://registry.npmjs.org/http_ece/-/http_ece-1.2.0.tgz /http_ece-1.2.0.tgz
ADD --chmod=0444 --checksum=sha256:ad62bbb11baf079699a3f269ed089efdb589be16083ceed94a1117801e1a6c61 https://registry.npmjs.org/http-errors/-/http-errors-2.0.1.tgz /http-errors-2.0.1.tgz
ADD --chmod=0444 --checksum=sha256:785f73faa92bfba8d61da20bf59325ab2b3dca1bbc0bbac523406f404d8a6f02 https://registry.npmjs.org/http-proxy-agent/-/http-proxy-agent-7.0.2.tgz /http-proxy-agent-7.0.2.tgz
ADD --chmod=0444 --checksum=sha256:6da16fb44331f2e5d30bd21bf880aa934c1ad4fe7da7187910ef2b2509712019 https://registry.npmjs.org/https-proxy-agent/-/https-proxy-agent-5.0.1.tgz /https-proxy-agent-5.0.1.tgz
ADD --chmod=0444 --checksum=sha256:960f89e8e5240882f64249d04a538421dd39d62ffacc138544647cc3251bc0e0 https://registry.npmjs.org/https-proxy-agent/-/https-proxy-agent-7.0.6.tgz /https-proxy-agent-7.0.6.tgz
ADD --chmod=0444 --checksum=sha256:b2397ed9013d69c3de60256cb3a55c5a651b9c860caf8470a17e70eb7129d4f6 https://registry.npmjs.org/human-signals/-/human-signals-8.0.1.tgz /human-signals-8.0.1.tgz
ADD --chmod=0444 --checksum=sha256:40789b7733e230a0439e07075fe2f37819f4a47ee7115fe17188451fab8e3941 https://registry.npmjs.org/iconv-lite/-/iconv-lite-0.7.3.tgz /iconv-lite-0.7.3.tgz
ADD --chmod=0444 --checksum=sha256:2ac4ba0e58a0472a1a133589060781ebc7754f478cfe30695a7870e94fc5dcbd https://registry.npmjs.org/@azure/identity/-/identity-4.13.2.tgz /identity-4.13.2.tgz
ADD --chmod=0444 --checksum=sha256:8ef14b9b397e339db89db97881fb714f49319d8f0eb1275901f45567b28f9dac https://registry.npmjs.org/ieee754/-/ieee754-1.2.1.tgz /ieee754-1.2.1.tgz
ADD --chmod=0444 --checksum=sha256:c47facddf618449cb90e606bbdd927120bf9613bc1579c168120de9b58c67d68 https://registry.npmjs.org/ignore/-/ignore-7.0.6.tgz /ignore-7.0.6.tgz
ADD --chmod=0444 --checksum=sha256:98c792f39650b00818c05dcc407902034dc4092f368596b37658d44f28739d11 https://registry.npmjs.org/immediate/-/immediate-3.0.6.tgz /immediate-3.0.6.tgz
ADD --chmod=0444 --checksum=sha256:41f6a60b13cf29eebdd06723223dc68ff1d47721d56e4fef93d2d450167d9dc0 https://registry.npmjs.org/@tokenizer/inflate/-/inflate-0.4.1.tgz /inflate-0.4.1.tgz
ADD --chmod=0444 --checksum=sha256:d94dbc6c1bb3c5ac0fb12a73ade187108fc60de273a1b754f55044eb5e24afaf https://registry.npmjs.org/inherits/-/inherits-2.0.4.tgz /inherits-2.0.4.tgz
ADD --chmod=0444 --checksum=sha256:35e23227dfeca9179f03f899a9e3a21faf542a8079821bce95d5620642d75873 https://registry.npmjs.org/ip-address/-/ip-address-10.5.0.tgz /ip-address-10.5.0.tgz
ADD --chmod=0444 --checksum=sha256:25a406ee4388fa3d47380ad57b816087fa82a681cc710cccbfe9162cffa8a57a https://registry.npmjs.org/ip-address/-/ip-address-10.7.0.tgz /ip-address-10.7.0.tgz
ADD --chmod=0444 --checksum=sha256:7441d9623f67fe4160eccfd82ae9a404dcd55e1e4f1b68e06e2374dade4e8fee https://registry.npmjs.org/ipaddr.js/-/ipaddr.js-1.9.1.tgz /ipaddr.js-1.9.1.tgz
ADD --chmod=0444 --checksum=sha256:1a230b0b25c81eff06bdee3856a742fd17260169b0bf958de9368c4b3ce2ddee https://registry.npmjs.org/is-docker/-/is-docker-3.0.0.tgz /is-docker-3.0.0.tgz
ADD --chmod=0444 --checksum=sha256:6f415dae5dc6070f1b42daee6165eab941a97101982305facc8bafdaf300bc4a https://registry.npmjs.org/is-fullwidth-code-point/-/is-fullwidth-code-point-3.0.0.tgz /is-fullwidth-code-point-3.0.0.tgz
ADD --chmod=0444 --checksum=sha256:dbde95b8434fc4757624974d4139c4f32391d08c4153565ae91a5f3fd772e07b https://registry.npmjs.org/is-inside-container/-/is-inside-container-1.0.0.tgz /is-inside-container-1.0.0.tgz
ADD --chmod=0444 --checksum=sha256:c71d874f7ab7cd560329b080ce790f9768dea503337fe2e2719a18e28be621f7 https://registry.npmjs.org/is-plain-obj/-/is-plain-obj-4.1.0.tgz /is-plain-obj-4.1.0.tgz
ADD --chmod=0444 --checksum=sha256:853891173876fa03b8762cf63e7f0c0d60e524947f4e4d5852d94c22acb445a7 https://registry.npmjs.org/is-promise/-/is-promise-4.0.0.tgz /is-promise-4.0.0.tgz
ADD --chmod=0444 --checksum=sha256:b8f4acd481d7324aa120b33a7a5c6784a986e3acdb670832976b9a2c5f298d19 https://registry.npmjs.org/is-stream/-/is-stream-4.0.1.tgz /is-stream-4.0.1.tgz
ADD --chmod=0444 --checksum=sha256:5926c0400ee62ff9cb7b4658e73217028aa6070799ddf5a14249e53e21fdd362 https://registry.npmjs.org/is-unicode-supported/-/is-unicode-supported-2.1.0.tgz /is-unicode-supported-2.1.0.tgz
ADD --chmod=0444 --checksum=sha256:f0f93f9796c2e768a487a35bbe8f96c0b703edeb01add088686ba91a72b92eb2 https://registry.npmjs.org/is-wsl/-/is-wsl-3.1.1.tgz /is-wsl-3.1.1.tgz
ADD --chmod=0444 --checksum=sha256:e23c76f14f5222e07e39d89858b61e8e33f96956de9e0df3659cbdf8db950c87 https://registry.npmjs.org/isarray/-/isarray-1.0.0.tgz /isarray-1.0.0.tgz
ADD --chmod=0444 --checksum=sha256:47cfe872e088e28c53b736fef305324b57cc1cfc9f72a9b0f769f92731cb8359 https://registry.npmjs.org/isexe/-/isexe-2.0.0.tgz /isexe-2.0.0.tgz
ADD --chmod=0444 --checksum=sha256:8dd0d365fb49c0e7cc42d6a00df6fb2da9056fc24492094346fc34ecdbcf28ca https://registry.npmjs.org/jiti/-/jiti-2.7.0.tgz /jiti-2.7.0.tgz
ADD --chmod=0444 --checksum=sha256:15d92c0711c570e8a900770ca4545fbf872fed252ce153c263e0e030f21ddaa0 https://registry.npmjs.org/jose/-/jose-4.15.9.tgz /jose-4.15.9.tgz

FROM scratch AS openclaw-managed-messaging-npm-common-archives-3

ADD --chmod=0444 --checksum=sha256:81685e7abf868ab5aa0ad917fefda5ab45c78ad0ba9272b977702686ffb646df https://registry.npmjs.org/jose/-/jose-6.2.11.tgz /jose-6.2.11.tgz
ADD --chmod=0444 --checksum=sha256:4c4f502953cfb36cfe1c6c4989676bf9b76899a253237fc0220814b88ff903b6 https://registry.npmjs.org/json-bigint/-/json-bigint-1.0.0.tgz /json-bigint-1.0.0.tgz
ADD --chmod=0444 --checksum=sha256:f6f34e4e453aca8753e9f644ad4fa297ae7011030bfff9e909bf34e31c4cc364 https://registry.npmjs.org/json-schema-to-ts/-/json-schema-to-ts-3.1.1.tgz /json-schema-to-ts-3.1.1.tgz
ADD --chmod=0444 --checksum=sha256:023222622df29fc274bde5d3590e47aa1d4a8e3c1d6e2aba029948ed79799b21 https://registry.npmjs.org/json-schema-traverse/-/json-schema-traverse-1.0.0.tgz /json-schema-traverse-1.0.0.tgz
ADD --chmod=0444 --checksum=sha256:e7dc4126e4fcf4c3073b3f7e99531eadc8633f7837b20ec97359a8d7add06bc9 https://registry.npmjs.org/json-schema-typed/-/json-schema-typed-8.0.2.tgz /json-schema-typed-8.0.2.tgz
ADD --chmod=0444 --checksum=sha256:08afb33db600d11fc89b98fac4054f19d5d3e0fe527063116150e1ecc2d2377b https://registry.npmjs.org/json5/-/json5-2.2.3.tgz /json5-2.2.3.tgz
ADD --chmod=0444 --checksum=sha256:ba70d14832394c094607e2cbb98d126cf51352e3d810caf1e52e7bcc15177aae https://registry.npmjs.org/@types/jsonwebtoken/-/jsonwebtoken-9.0.10.tgz /jsonwebtoken-9.0.10.tgz
ADD --chmod=0444 --checksum=sha256:d9af2628a7a4dda25acf1e19c7ecc2468e1e9e8d4619fe2cae829e89d96f6b82 https://registry.npmjs.org/jsonwebtoken/-/jsonwebtoken-9.0.3.tgz /jsonwebtoken-9.0.3.tgz
ADD --chmod=0444 --checksum=sha256:5117f4a2a645aeb307bf3b829c575ad58135cc97e75291e594532ab5b5b21b23 https://registry.npmjs.org/jszip/-/jszip-3.10.1.tgz /jszip-3.10.1.tgz
ADD --chmod=0444 --checksum=sha256:c8bc0cf9fbbdc9d2f1b6f3f97ab9c1f70130eec6b153f29fd69baa5a6aa8341d https://registry.npmjs.org/jwa/-/jwa-2.0.1.tgz /jwa-2.0.1.tgz
ADD --chmod=0444 --checksum=sha256:01c60583d8f3b098580792e5362447c2ffb6857dda4ff4ecc0c2a5a4514513f6 https://registry.npmjs.org/jwks-rsa/-/jwks-rsa-3.2.2.tgz /jwks-rsa-3.2.2.tgz
ADD --chmod=0444 --checksum=sha256:ed3a5fb027f8ce1006c8e30a37e88e7cd49824d4873efca8765304b20fe92e12 https://registry.npmjs.org/jws/-/jws-4.0.1.tgz /jws-4.0.1.tgz
ADD --chmod=0444 --checksum=sha256:d16dfbf80fa1f084be989d790e89c496cb71ec3f96c278fbbe4801a5ccb4e6eb https://registry.npmjs.org/jwt-decode/-/jwt-decode-4.0.0.tgz /jwt-decode-4.0.0.tgz
ADD --chmod=0444 --checksum=sha256:28fe3b6492836f8c9cfdabe87ab1d56121a016ce69437579e6bc2241e4efe9a8 https://registry.npmjs.org/koffi/-/koffi-3.1.6.tgz /koffi-3.1.6.tgz
ADD --chmod=0444 --checksum=sha256:e29b3276f8171d504ed3601c8100276b1f051e459ab1c24fc9d4ec18295638c8 https://registry.npmjs.org/kysely/-/kysely-0.29.5.tgz /kysely-0.29.5.tgz
ADD --chmod=0444 --checksum=sha256:2db8461cd4a10e2fc3588c8c55da34d33465ff81cc19c72416bbcaec7ee6a36e https://registry.npmjs.org/lie/-/lie-3.3.0.tgz /lie-3.3.0.tgz
ADD --chmod=0444 --checksum=sha256:84ff39cceb2eaef0800daa64a5ac16138c073308437a97ec6a8b4728c1f86ded https://registry.npmjs.org/limiter/-/limiter-1.1.5.tgz /limiter-1.1.5.tgz
ADD --chmod=0444 --checksum=sha256:816d4b548060b72cdc4a141079bf857a934bba8dd42d745a9e0c40c0fbbce8bb https://registry.npmjs.org/linkedom/-/linkedom-0.18.13.tgz /linkedom-0.18.13.tgz
ADD --chmod=0444 --checksum=sha256:ae3d1b9360a435840a81a8c7da29f59630dd793c3f39a08f15f73fd3894053b7 https://registry.npmjs.org/locate-path/-/locate-path-5.0.0.tgz /locate-path-5.0.0.tgz
ADD --chmod=0444 --checksum=sha256:cd3630dddc6fcb73e1bd27fce6972b2d20aa0ecadb001c523174648efbfe0312 https://registry.npmjs.org/lodash.clonedeep/-/lodash.clonedeep-4.5.0.tgz /lodash.clonedeep-4.5.0.tgz
ADD --chmod=0444 --checksum=sha256:ad1fb3f7aa3c53d2aa7b5fd006507404d71fcccb341162b6423645d997c808d7 https://registry.npmjs.org/lodash.includes/-/lodash.includes-4.3.0.tgz /lodash.includes-4.3.0.tgz
ADD --chmod=0444 --checksum=sha256:11a52014f5d33bdc0b58a79fd10355b8209aeb1b2c57f2c13b7395ca57dcee9d https://registry.npmjs.org/lodash.isboolean/-/lodash.isboolean-3.0.3.tgz /lodash.isboolean-3.0.3.tgz
ADD --chmod=0444 --checksum=sha256:7885443a78d4400274bf42a5929f6aaab23ca5d7e303deee76fe702ffe873b7d https://registry.npmjs.org/lodash.isinteger/-/lodash.isinteger-4.0.4.tgz /lodash.isinteger-4.0.4.tgz
ADD --chmod=0444 --checksum=sha256:73e5167e1e06f496cbad0f96afda0590302c0867f9840730e2600edf03c29b63 https://registry.npmjs.org/lodash.isnumber/-/lodash.isnumber-3.0.3.tgz /lodash.isnumber-3.0.3.tgz
ADD --chmod=0444 --checksum=sha256:986420e1ce139727af84069d7b88912facac64e5ca1281efd9f55b228fad72d0 https://registry.npmjs.org/lodash.isplainobject/-/lodash.isplainobject-4.0.6.tgz /lodash.isplainobject-4.0.6.tgz
ADD --chmod=0444 --checksum=sha256:45fd48aeca41f05f44fd413471f254c472e1e7a811ab84ea41448d2e7155cd5f https://registry.npmjs.org/lodash.isstring/-/lodash.isstring-4.0.1.tgz /lodash.isstring-4.0.1.tgz
ADD --chmod=0444 --checksum=sha256:0d67808f6f1d4c35c65e0e34c19e0a2de02727616cc8e276535f3eae98ce23b5 https://registry.npmjs.org/lodash.once/-/lodash.once-4.1.1.tgz /lodash.once-4.1.1.tgz
ADD --chmod=0444 --checksum=sha256:68cfebebfd98437a99350b8fd527fe3f420daae392d21184e985c09f0b20a449 https://registry.npmjs.org/@azure/logger/-/logger-1.4.0.tgz /logger-1.4.0.tgz
ADD --chmod=0444 --checksum=sha256:68033e466773df7d52c9e59341bb729d83716cd920c56460395724456d646b26 https://registry.npmjs.org/long/-/long-5.3.2.tgz /long-5.3.2.tgz
ADD --chmod=0444 --checksum=sha256:e46c8eaafc64f168603aebd39cfd0e987bec39a93ade280653e2331fd2516a22 https://registry.npmjs.org/lru-cache/-/lru-cache-11.5.2.tgz /lru-cache-11.5.2.tgz
ADD --chmod=0444 --checksum=sha256:5ce40deb031cf6968f3832502a68f8d26be09764dc4f8fc07957a2fd7e8cdf5e https://registry.npmjs.org/lru-cache/-/lru-cache-6.0.0.tgz /lru-cache-6.0.0.tgz
ADD --chmod=0444 --checksum=sha256:4fe2dc759c1113c1df731891b02601e9af9670ce2a344ce36b07285294496445 https://registry.npmjs.org/lru-memoizer/-/lru-memoizer-2.3.0.tgz /lru-memoizer-2.3.0.tgz
ADD --chmod=0444 --checksum=sha256:7d0ea56f8c29c0e6dec5665e62ad8089136819ca7028612e52301c2ba279dac2 https://registry.npmjs.org/marked/-/marked-18.0.5.tgz /marked-18.0.5.tgz
ADD --chmod=0444 --checksum=sha256:b8c2c35575493dc086df88cfc468a9e2651b6617336480ab3f00fcf853f443a7 https://registry.npmjs.org/math-intrinsics/-/math-intrinsics-1.1.0.tgz /math-intrinsics-1.1.0.tgz
ADD --chmod=0444 --checksum=sha256:412fefe4130ee5ab4b38f014d143397074f9541b55430c0280cfb1a74d1cb368 https://registry.npmjs.org/media-typer/-/media-typer-1.1.1.tgz /media-typer-1.1.1.tgz
ADD --chmod=0444 --checksum=sha256:ae88322a5fc71952d3990ae999a7afc7a4bf7cba086b9ccc1c9482432b101dce https://registry.npmjs.org/merge-descriptors/-/merge-descriptors-2.0.0.tgz /merge-descriptors-2.0.0.tgz
ADD --chmod=0444 --checksum=sha256:56e3bbea7f98de8a58eb38b23fed68d5d4bcc29b0dd8d733d79be7622f2afebd https://registry.npmjs.org/@sindresorhus/merge-streams/-/merge-streams-4.0.0.tgz /merge-streams-4.0.0.tgz
ADD --chmod=0444 --checksum=sha256:b8e70bb4d52acd5d0d1ed848c0e6e3c903a533aa500acffbe003f011b18f9e3b https://registry.npmjs.org/mime-db/-/mime-db-1.52.0.tgz /mime-db-1.52.0.tgz
ADD --chmod=0444 --checksum=sha256:2b21054e65d0eabd58c5002d2713e968dd47b15700bfed4b7281a344ded1c420 https://registry.npmjs.org/mime-db/-/mime-db-1.54.0.tgz /mime-db-1.54.0.tgz
ADD --chmod=0444 --checksum=sha256:49734fc98906e9baaacf8034923470a4c84de72943a7c005face63360701d1c3 https://registry.npmjs.org/mime-types/-/mime-types-2.1.35.tgz /mime-types-2.1.35.tgz
ADD --chmod=0444 --checksum=sha256:2f9dd28353c303ff8750fbf68e474755b01c54a989883d227d605f7bfa3dd2ac https://registry.npmjs.org/mime-types/-/mime-types-3.0.2.tgz /mime-types-3.0.2.tgz
ADD --chmod=0444 --checksum=sha256:f16522c947d6dbe3a99f5ff4296ccc253090b838959abdddc45fe81edb03f3a0 https://registry.npmjs.org/minimalistic-assert/-/minimalistic-assert-1.0.1.tgz /minimalistic-assert-1.0.1.tgz
ADD --chmod=0444 --checksum=sha256:5a3d2c8074a28229665727e47b8a1090941856a7962905efe05d20d3760355f8 https://registry.npmjs.org/minimatch/-/minimatch-10.2.6.tgz /minimatch-10.2.6.tgz
ADD --chmod=0444 --checksum=sha256:350a76c115b393c19d24654834261e5dc9f0e8cc5e08f3937fa80140f3e4ce83 https://registry.npmjs.org/minimist/-/minimist-1.2.8.tgz /minimist-1.2.8.tgz
ADD --chmod=0444 --checksum=sha256:52ac61be743755e3fdc98e560086d0d4a1e2c7fd3643387792db38e322d27d12 https://registry.npmjs.org/minipass/-/minipass-7.1.3.tgz /minipass-7.1.3.tgz
ADD --chmod=0444 --checksum=sha256:99bf2e29618172dd71f0654737490c68f71bc7e2379d473e38f9fef2dbece2e3 https://registry.npmjs.org/minizlib/-/minizlib-3.1.0.tgz /minizlib-3.1.0.tgz
ADD --chmod=0444 --checksum=sha256:ad7a285194b0452da022af7d14cbc96e0ad84829156cb12b36723442b47cf08a https://registry.npmjs.org/@mistralai/mistralai/-/mistralai-2.6.4.tgz /mistralai-2.6.4.tgz
ADD --chmod=0444 --checksum=sha256:a07f7b4d84e44bd8c55e44ee084f3529d5b3bbb2f212ef1749aced718bcb6c09 https://registry.npmjs.org/@types/ms/-/ms-2.1.0.tgz /ms-2.1.0.tgz
ADD --chmod=0444 --checksum=sha256:f6616e15e530ed552f9daa2d3ce71963947c6bc7c98c9b64fd3e673fd02622c6 https://registry.npmjs.org/ms/-/ms-2.1.3.tgz /ms-2.1.3.tgz
ADD --chmod=0444 --checksum=sha256:5546b0cf78281cac72871dcf90bfe13a9a88eb21afa876d0862a55c79e5041cb https://registry.npmjs.org/@azure/msal-browser/-/msal-browser-5.21.0.tgz /msal-browser-5.21.0.tgz
ADD --chmod=0444 --checksum=sha256:11da04f8879df73e8af2cab3a92403e58207980505c876384bdd024b8e688bc5 https://registry.npmjs.org/@azure/msal-common/-/msal-common-16.13.0.tgz /msal-common-16.13.0.tgz
ADD --chmod=0444 --checksum=sha256:fb1bf35e12a5f8c8b5d795bd9d89e90c278e4929ea9d99c21e452753b84d51f5 https://registry.npmjs.org/@azure/msal-common/-/msal-common-16.14.0.tgz /msal-common-16.14.0.tgz
ADD --chmod=0444 --checksum=sha256:a2a7d8872dda8f65fd89bef21576315b1cd472f4478e0ba8c068d3a41848c32e https://registry.npmjs.org/@azure/msal-node/-/msal-node-5.6.0.tgz /msal-node-5.6.0.tgz
ADD --chmod=0444 --checksum=sha256:ed05a10788e4bec3cc2d6926b8ac4be817c601e16992019ebfa408e3d665c834 https://registry.npmjs.org/@openclaw/msteams/-/msteams-2026.9.1.tgz /msteams-2026.9.1.tgz
ADD --chmod=0444 --checksum=sha256:04ada283b29ea69189a5eac97fa3815f20480255fa4667258366c31e1d92ced4 https://registry.npmjs.org/negotiator/-/negotiator-1.1.0.tgz /negotiator-1.1.0.tgz
ADD --chmod=0444 --checksum=sha256:e5c18f3cfc46d072f9aa23439644c9c18fac62729e6385aadcc937e458507a09 https://registry.npmjs.org/@ubjs/node/-/node-0.31.0-3.tgz /node-0.31.0-3.tgz
ADD --chmod=0444 --checksum=sha256:869f053ddf77958e8581e104179f7604a0b058fda70c4aaf338aecec9c6c1289 https://registry.npmjs.org/@types/node/-/node-26.4.1.tgz /node-26.4.1.tgz
ADD --chmod=0444 --checksum=sha256:4cd65698541b19a33f798f1dc25c02c6ed1c9d7749b8824b1a1ccecdd197c8ea https://registry.npmjs.org/node-addon-api/-/node-addon-api-8.9.2.tgz /node-addon-api-8.9.2.tgz
ADD --chmod=0444 --checksum=sha256:eba234134890897807b85c2bc67cd32d0242eb9be1d1c62513797fdaab60c971 https://registry.npmjs.org/node-domexception/-/node-domexception-1.0.0.tgz /node-domexception-1.0.0.tgz
ADD --chmod=0444 --checksum=sha256:e44ada346c96f9f2525f8d1d02b7479558141f2d07cc59072d8d6569194abe01 https://registry.npmjs.org/node-edge-tts/-/node-edge-tts-1.2.10.tgz /node-edge-tts-1.2.10.tgz
ADD --chmod=0444 --checksum=sha256:a70348669b01db602faf140e984e61b01c4380f9b4bf5e460b7960902412832b https://registry.npmjs.org/node-fetch/-/node-fetch-2.7.0.tgz /node-fetch-2.7.0.tgz
ADD --chmod=0444 --checksum=sha256:615af90e363f8f276b4b54f8e6c163cf3686dce1d8867dd7e52cbed4d38d2dab https://registry.npmjs.org/node-fetch/-/node-fetch-3.3.2.tgz /node-fetch-3.3.2.tgz
ADD --chmod=0444 --checksum=sha256:940450fb4158bddc23ae156432a67338a4d7ab6a585b639c61b3b0a14d2bac24 https://registry.npmjs.org/node-gyp-build/-/node-gyp-build-4.8.4.tgz /node-gyp-build-4.8.4.tgz
ADD --chmod=0444 --checksum=sha256:c28df2b8de694493420c9f090c53f1cc9d087b64ba7b6b59e262588198688ef5 https://registry.npmjs.org/@lydell/node-pty/-/node-pty-1.2.0-beta.15.tgz /node-pty-1.2.0-beta.15.tgz
ADD --chmod=0444 --checksum=sha256:f65675c6fc745a4f15a2abd316883e715ab53afbc4b4fbb2ff57ed280360b9b6 https://registry.npmjs.org/@hono/node-server/-/node-server-2.1.1.tgz /node-server-2.1.1.tgz
ADD --chmod=0444 --checksum=sha256:82163aa3e3a46ef2a49f8d20f21b67af52724b5be35246d685c1180b9f918ddf https://registry.npmjs.org/npm-run-path/-/npm-run-path-6.0.0.tgz /npm-run-path-6.0.0.tgz
ADD --chmod=0444 --checksum=sha256:db23d012df85d2c0308c7b3fd3bd538664d9e0e1dca1aa96e659641b76457a8f https://registry.npmjs.org/nth-check/-/nth-check-3.0.1.tgz /nth-check-3.0.1.tgz
ADD --chmod=0444 --checksum=sha256:782d726a263ba7b26cced612af97b80035516df4b0cd788524e7b2cebc4e29ed https://registry.npmjs.org/object-assign/-/object-assign-4.1.1.tgz /object-assign-4.1.1.tgz
ADD --chmod=0444 --checksum=sha256:8324967a3afd8a45b0401e3554aebc1843f493bec46a89a7ce8cf072e62e90bf https://registry.npmjs.org/object-inspect/-/object-inspect-1.13.4.tgz /object-inspect-1.13.4.tgz
ADD --chmod=0444 --checksum=sha256:f64d42f1049c386cdac5204737e09564271639b2b7d203a3ea07ec07d5ddbd0a https://registry.npmjs.org/on-finished/-/on-finished-2.4.1.tgz /on-finished-2.4.1.tgz
ADD --chmod=0444 --checksum=sha256:cf51460ba370c698f68b976e514d113497339ba018b6003e8e8eb569c6fccfcf https://registry.npmjs.org/once/-/once-1.4.0.tgz /once-1.4.0.tgz
ADD --chmod=0444 --checksum=sha256:b5b60d1271802682a5c8e0ed1cc8e825d3be7fd610afaaf3d4d8ce799e825be9 https://registry.npmjs.org/open/-/open-10.2.0.tgz /open-10.2.0.tgz
ADD --chmod=0444 --checksum=sha256:8d1b89c7bdb749d834c502e94d0ece4909aaac213dab2bc53bbd16119f23f6dd https://registry.npmjs.org/openai/-/openai-7.5.0.tgz /openai-7.5.0.tgz
ADD --chmod=0444 --checksum=sha256:1bfcac877d53f1e41b69d15c24e081895b2f07d6ff2ffdfe0bf8a7336ab00e59 https://registry.npmjs.org/openclaw/-/openclaw-2026.9.1.tgz /openclaw-2026.9.1.tgz
ADD --chmod=0444 --checksum=sha256:467e8047f7114e45944961fcd3eda9421843c9c65db61ea24176e252ab800ee4 https://registry.npmjs.org/@tencent-weixin/openclaw-weixin/-/openclaw-weixin-2.4.9.tgz /openclaw-weixin-2.4.9.tgz
ADD --chmod=0444 --checksum=sha256:384b452409cfeb5c6fa82dc68ebfa498b24717b74fb8d3fe6eb2bb89908db295 https://registry.npmjs.org/p-limit/-/p-limit-2.3.0.tgz /p-limit-2.3.0.tgz
ADD --chmod=0444 --checksum=sha256:284dcc4cc5b485b5793be28d0716f0a1270fb0eeb9f1f4c7cff7f320cfe8e21e https://registry.npmjs.org/p-limit/-/p-limit-7.3.1.tgz /p-limit-7.3.1.tgz
ADD --chmod=0444 --checksum=sha256:d95a6ae462e3d967deb0c250bda1c3bbebfe86a58832d27b204c7b74a76fa5f0 https://registry.npmjs.org/p-locate/-/p-locate-4.1.0.tgz /p-locate-4.1.0.tgz
ADD --chmod=0444 --checksum=sha256:b52ce5684950a7e5792d67c2bec28125695c55c1d689a778ee6c64efdb15b5f0 https://registry.npmjs.org/p-map/-/p-map-7.0.6.tgz /p-map-7.0.6.tgz
ADD --chmod=0444 --checksum=sha256:21112bb484de3120e9e85f1ebe6a66125ecfda48072ae48b0d202693337fb558 https://registry.npmjs.org/p-retry/-/p-retry-4.6.2.tgz /p-retry-4.6.2.tgz
ADD --chmod=0444 --checksum=sha256:a390b2b89899df950afc0304eaba7cd1f5e3746b2e370758a9b50f177e713790 https://registry.npmjs.org/p-try/-/p-try-2.2.0.tgz /p-try-2.2.0.tgz
ADD --chmod=0444 --checksum=sha256:0d4028dc0352a740c30cbfd772917f2744986d42bfa0b06ec7642bffe7ad3941 https://registry.npmjs.org/pako/-/pako-1.0.11.tgz /pako-1.0.11.tgz
ADD --chmod=0444 --checksum=sha256:abbc7e193f7bcd9d26f9fe994f846ee3fb442b0ec215e7f61fa1080a29b7fb68 https://registry.npmjs.org/parse-ms/-/parse-ms-4.0.0.tgz /parse-ms-4.0.0.tgz
ADD --chmod=0444 --checksum=sha256:56ef4bfa11e097ce8196b26fa04b42d6091c32498fcab4478e6dd298435f021a https://registry.npmjs.org/parseurl/-/parseurl-1.3.3.tgz /parseurl-1.3.3.tgz
ADD --chmod=0444 --checksum=sha256:30eafeed6fdc25fb2ca24f34c37796d9f98f0bf5e156452b98a2c356762f6322 https://registry.npmjs.org/partial-json/-/partial-json-0.1.7.tgz /partial-json-0.1.7.tgz
ADD --chmod=0444 --checksum=sha256:cc364ee910173c36d5734535a2bb53b8e7e86d2d219f27218158ab3f3dca328c https://registry.npmjs.org/@protobufjs/path/-/path-1.1.2.tgz /path-1.1.2.tgz
ADD --chmod=0444 --checksum=sha256:dbb535c9302ce9b3f777ece3ff055cc8d88890a1e1deddc045340aef76fb775c https://registry.npmjs.org/path-exists/-/path-exists-4.0.0.tgz /path-exists-4.0.0.tgz
ADD --chmod=0444 --checksum=sha256:4b8999acb914830edcd3c5b8fec632b32c6bc759ac3edc86336f5a9e08ba7b92 https://registry.npmjs.org/path-key/-/path-key-3.1.1.tgz /path-key-3.1.1.tgz
ADD --chmod=0444 --checksum=sha256:aea29a2c9a0986a2eadb6d872c4e5537995612ea9babcbd8da3c2d74b3f049a7 https://registry.npmjs.org/path-key/-/path-key-4.0.0.tgz /path-key-4.0.0.tgz
ADD --chmod=0444 --checksum=sha256:e8712a9c53b0a2a27cfecc7b80c54df92afb4643c01351e2b2ebb7784bcabd78 https://registry.npmjs.org/path-to-regexp/-/path-to-regexp-8.4.2.tgz /path-to-regexp-8.4.2.tgz

FROM scratch AS openclaw-managed-messaging-npm-common-archives-4

ADD --chmod=0444 --checksum=sha256:5a23015c1cd2c38e3c492dd96929985247b92f52d2ff0fb948d29edca52bc50a https://registry.npmjs.org/@silvia-odwyer/photon-node/-/photon-node-0.3.4.tgz /photon-node-0.3.4.tgz
ADD --chmod=0444 --checksum=sha256:3abec26d852a9574fd341b8b4984277fc76dabb57a0360df4c19cc1fc0df993e https://registry.npmjs.org/@earendil-works/pi-tui/-/pi-tui-0.84.2.tgz /pi-tui-0.84.2.tgz
ADD --chmod=0444 --checksum=sha256:d1fcbbae5bc05562d13de7c520c2951699e8262a8317fa6c8bbcd8dcff3bea70 https://registry.npmjs.org/pkce-challenge/-/pkce-challenge-5.0.1.tgz /pkce-challenge-5.0.1.tgz
ADD --chmod=0444 --checksum=sha256:954be1e183d0ddb9748fe0d2d08b0b66a9210c74dd75c397aeb70303b9f08a00 https://registry.npmjs.org/playwright-core/-/playwright-core-1.62.1.tgz /playwright-core-1.62.1.tgz
ADD --chmod=0444 --checksum=sha256:4d960bbbe078022d7a36822e2874f884c7410ead111f3603d69d70fc7af36f20 https://registry.npmjs.org/pngjs/-/pngjs-5.0.0.tgz /pngjs-5.0.0.tgz
ADD --chmod=0444 --checksum=sha256:f721dbd27282d2c7d1c2bf1ae9f7a03cc3ef9cf882fe469a32c14d1dae732703 https://registry.npmjs.org/@protobufjs/pool/-/pool-1.1.0.tgz /pool-1.1.0.tgz
ADD --chmod=0444 --checksum=sha256:0688f2dc20fc53ff8d4a5e9ddac4b518001255c56ce58d427afa8e933f7fe508 https://registry.npmjs.org/pretty-ms/-/pretty-ms-9.3.0.tgz /pretty-ms-9.3.0.tgz
ADD --chmod=0444 --checksum=sha256:425bf8c725d23bc5ac76bcedd10d9cdbbd6354c7273dd7def44417cfbca8889b https://registry.npmjs.org/process-nextick-args/-/process-nextick-args-2.0.1.tgz /process-nextick-args-2.0.1.tgz
ADD --chmod=0444 --checksum=sha256:9fe46ed2a75148c5a1a720b446f1a95ff7c67e984144a24a83e004a892258cd8 https://registry.npmjs.org/@clack/prompts/-/prompts-1.7.0.tgz /prompts-1.7.0.tgz
ADD --chmod=0444 --checksum=sha256:df0241b3046b505d27396da6eef107f14dffb108f77aa89cfd9611a928eb6dfe https://registry.npmjs.org/protobufjs/-/protobufjs-7.6.6.tgz /protobufjs-7.6.6.tgz
ADD --chmod=0444 --checksum=sha256:205de58fb0e9e9ce2e1d2903f634f9be1852f024883fa037eb6ab1cd0c0e6c6b https://registry.npmjs.org/protobufjs/-/protobufjs-8.7.2.tgz /protobufjs-8.7.2.tgz
ADD --chmod=0444 --checksum=sha256:a0d1b6f34f6d4e733429ba95f7adb7833c8ceab916ba574a93f8a8476bee46d9 https://registry.npmjs.org/proxy-addr/-/proxy-addr-2.0.7.tgz /proxy-addr-2.0.7.tgz
ADD --chmod=0444 --checksum=sha256:e9c52dbf1e382319d5da00b8d964805859b7eb1424450e049d12743d7e19fc9a https://registry.npmjs.org/proxy-from-env/-/proxy-from-env-2.1.0.tgz /proxy-from-env-2.1.0.tgz
ADD --chmod=0444 --checksum=sha256:cf7d916cade644852293de603369f2f3ef13171e3f78cc3baf9a1bd6854190bd https://registry.npmjs.org/@openclaw/proxyline/-/proxyline-0.3.7.tgz /proxyline-0.3.7.tgz
ADD --chmod=0444 --checksum=sha256:0c7274f0c299f39c2fddf54a2e0039b785977b0173c02d0b3f65fad68923e2b0 https://registry.npmjs.org/qrcode/-/qrcode-1.5.4.tgz /qrcode-1.5.4.tgz
ADD --chmod=0444 --checksum=sha256:3a6260c4e0d80bd527a3f930e90ea2348c03646621f25aa0bd960ee205a0a706 https://registry.npmjs.org/qrcode-terminal/-/qrcode-terminal-0.12.0.tgz /qrcode-terminal-0.12.0.tgz
ADD --chmod=0444 --checksum=sha256:c0278b636e7a016d6e835cd8f194a63c276dff430620e4a04344a4ba8892c0f9 https://registry.npmjs.org/qs/-/qs-6.15.3.tgz /qs-6.15.3.tgz
ADD --chmod=0444 --checksum=sha256:f7a1bfc96c3a0c1172f1f3ef3c280f5ce8054841922e715f0d686da62d7beba4 https://registry.npmjs.org/qs/-/qs-6.16.0.tgz /qs-6.16.0.tgz
ADD --chmod=0444 --checksum=sha256:67f300077af91aa29497cfffbcf7f83d8cda7de39c4010b94372da2ab1ea796f https://registry.npmjs.org/quickjs-wasi/-/quickjs-wasi-3.5.0.tgz /quickjs-wasi-3.5.0.tgz
ADD --chmod=0444 --checksum=sha256:51b79ec072db6788b132680256e9e733af8bb091df4f8ce8562ca631118f0fae https://registry.npmjs.org/range-parser/-/range-parser-1.3.0.tgz /range-parser-1.3.0.tgz
ADD --chmod=0444 --checksum=sha256:35256483616db7537a37c689b7d377b38dd0b152b59e88442cefeb2c730d74b9 https://registry.npmjs.org/rastermill/-/rastermill-0.3.2.tgz /rastermill-0.3.2.tgz
ADD --chmod=0444 --checksum=sha256:66de2a025036de58bbe50ab1d42a24ec6d33eda338b8115a3ebf942dae8419db https://registry.npmjs.org/raw-body/-/raw-body-3.0.2.tgz /raw-body-3.0.2.tgz
ADD --chmod=0444 --checksum=sha256:6d3c3cc50dad51b543925deadc66d5b58cd2262d1d585f2ae0a44975627ad919 https://registry.npmjs.org/@mozilla/readability/-/readability-0.6.0.tgz /readability-0.6.0.tgz
ADD --chmod=0444 --checksum=sha256:fc54d8496938e7fdf01b09719253ff3643b31a4793c5bbfd3743baca53535da6 https://registry.npmjs.org/@sec-ant/readable-stream/-/readable-stream-0.4.1.tgz /readable-stream-0.4.1.tgz
ADD --chmod=0444 --checksum=sha256:1648613948f68ac9cbbe8f72a3f93a67ecdb862ffb57946a2c0bbb5a1479a532 https://registry.npmjs.org/readable-stream/-/readable-stream-2.3.8.tgz /readable-stream-2.3.8.tgz
ADD --chmod=0444 --checksum=sha256:935a688197715ea14c184e4a56542d6abe99a75b2c6d805d24a4cdf36514d5a5 https://registry.npmjs.org/readdirp/-/readdirp-5.1.1.tgz /readdirp-5.1.1.tgz
ADD --chmod=0444 --checksum=sha256:cad52ea77001223648829bfa3c4e677d30939928b12ed3566148bf2b7e1df18f https://registry.npmjs.org/reflect-metadata/-/reflect-metadata-0.2.2.tgz /reflect-metadata-0.2.2.tgz
ADD --chmod=0444 --checksum=sha256:703bee0844360383fe4a8792d4a5a562647426a053e7597a1d272ac554f386c8 https://registry.npmjs.org/require-directory/-/require-directory-2.1.1.tgz /require-directory-2.1.1.tgz
ADD --chmod=0444 --checksum=sha256:cb694a4965908f7775a0c757f00cf4e624d193cd71d77988fbcca0f597b88d82 https://registry.npmjs.org/require-from-string/-/require-from-string-2.0.2.tgz /require-from-string-2.0.2.tgz
ADD --chmod=0444 --checksum=sha256:c5bb566318fb6091c7c2ac7c0aba6eeb7b332ffcfafad2268a2dc12a4d428e00 https://registry.npmjs.org/require-main-filename/-/require-main-filename-2.0.0.tgz /require-main-filename-2.0.0.tgz
ADD --chmod=0444 --checksum=sha256:7c97db75aba1e8cb911b9ff349ddeae6153fd3b11fa3f3b772c1dd474ea9f8c8 https://registry.npmjs.org/@types/retry/-/retry-0.12.0.tgz /retry-0.12.0.tgz
ADD --chmod=0444 --checksum=sha256:7521d8445e845475e888ccb7af473c4afb17aabafefe35a23371a8a8c79b8084 https://registry.npmjs.org/retry/-/retry-0.13.1.tgz /retry-0.13.1.tgz
ADD --chmod=0444 --checksum=sha256:b144af37b39a9517f7a89f1d867e9c2cf29f13f4147d3e80c499fe6ffab69461 https://registry.npmjs.org/router/-/router-2.2.0.tgz /router-2.2.0.tgz
ADD --chmod=0444 --checksum=sha256:d29ace7117aaa0d6b119027e9a157c238e6899bbb35d03f508ae8d4fa9ca8c9d https://registry.npmjs.org/run-applescript/-/run-applescript-7.1.0.tgz /run-applescript-7.1.0.tgz
ADD --chmod=0444 --checksum=sha256:65b1049d7858c8d00adefe07a03671a218b439d9b7ee55a8a1af9fca1a19e759 https://registry.npmjs.org/@grammyjs/runner/-/runner-2.0.3.tgz /runner-2.0.3.tgz
ADD --chmod=0444 --checksum=sha256:0acb45d7992e5fba729bb1d8f2586af7e522518aebd9b2859441b387ef890ad8 https://registry.npmjs.org/@emnapi/runtime/-/runtime-1.11.1.tgz /runtime-1.11.1.tgz
ADD --chmod=0444 --checksum=sha256:4d7f1bd502a1a64d47625cc738d13284865f0666d2ed01f244de0adf05b69aa5 https://registry.npmjs.org/@babel/runtime/-/runtime-7.29.7.tgz /runtime-7.29.7.tgz
ADD --chmod=0444 --checksum=sha256:e09206c60fccafb952c854af7629cbb031a98d6da2e143fb3aa3c8a48402aa22 https://registry.npmjs.org/safe-buffer/-/safe-buffer-5.1.2.tgz /safe-buffer-5.1.2.tgz
ADD --chmod=0444 --checksum=sha256:5d181804516c4a693a384272a7bd0e42d17e0d4b301ccfbe408669ccafdcb3e8 https://registry.npmjs.org/safe-buffer/-/safe-buffer-5.2.1.tgz /safe-buffer-5.2.1.tgz
ADD --chmod=0444 --checksum=sha256:78812f65ae3b98071ce1c9bacbe0666f4220d0b2753c2a11530eb27df440a3b3 https://registry.npmjs.org/safer-buffer/-/safer-buffer-2.1.2.tgz /safer-buffer-2.1.2.tgz
ADD --chmod=0444 --checksum=sha256:22fb96ba4ca943c41560f8dd21b405f388a8e4c010ebc8b88c5e3f8f8da73c6c https://registry.npmjs.org/@anthropic-ai/sdk/-/sdk-0.120.0.tgz /sdk-0.120.0.tgz
ADD --chmod=0444 --checksum=sha256:2cac3f3e38fec2815ed9efafa2947faf8c6957310684f99703f3d180f3e9af1a https://registry.npmjs.org/@modelcontextprotocol/sdk/-/sdk-1.30.0.tgz /sdk-1.30.0.tgz
ADD --chmod=0444 --checksum=sha256:57beb0f7705b09406e5bcc984d1f6a141940680b4c42755be026f77f64365a37 https://registry.npmjs.org/@agentclientprotocol/sdk/-/sdk-1.4.0.tgz /sdk-1.4.0.tgz
ADD --chmod=0444 --checksum=sha256:4465839df9cf25046eacb64e37a38e7a2d033546356335190234bad60bd85d42 https://registry.npmjs.org/@opentelemetry/semantic-conventions/-/semantic-conventions-1.43.0.tgz /semantic-conventions-1.43.0.tgz
ADD --chmod=0444 --checksum=sha256:d85045d4300d7d57c891336b95df532e73f34c22ffcd222452b6d08b9d127d5d https://registry.npmjs.org/semver/-/semver-7.8.5.tgz /semver-7.8.5.tgz
ADD --chmod=0444 --checksum=sha256:fa254fb316dd23ddcb2beebd533b23788aec4cf6a3dba58af34150170435c472 https://registry.npmjs.org/send/-/send-1.2.1.tgz /send-1.2.1.tgz
ADD --chmod=0444 --checksum=sha256:36d4f72bb59372eb18202fee25ff3d8bf46655f0121830fbe32e32cbdc625f43 https://registry.npmjs.org/serve-static/-/serve-static-2.2.1.tgz /serve-static-2.2.1.tgz
ADD --chmod=0444 --checksum=sha256:d934aee7db9e09da09e87724743315ffe888130aa6e04fbbdecac985f6ae693d https://registry.npmjs.org/set-blocking/-/set-blocking-2.0.0.tgz /set-blocking-2.0.0.tgz
ADD --chmod=0444 --checksum=sha256:5cb9fc22698364ed42c02d6aa3dc50ffeafa68452ae84699672e3dfd74922c9e https://registry.npmjs.org/setimmediate/-/setimmediate-1.0.5.tgz /setimmediate-1.0.5.tgz
ADD --chmod=0444 --checksum=sha256:c83bcc6ea632567e3f6928a83a1c0c7073519aaca9b88b847a3b404417eadfe2 https://registry.npmjs.org/setprototypeof/-/setprototypeof-1.2.0.tgz /setprototypeof-1.2.0.tgz
ADD --chmod=0444 --checksum=sha256:9acba5bd18a51e9cdf5898380e4df63f803e1844def64ae1a46f88cff86d556e https://registry.npmjs.org/shebang-command/-/shebang-command-2.0.0.tgz /shebang-command-2.0.0.tgz
ADD --chmod=0444 --checksum=sha256:fedbabaa6db26c6be0183f82777dfa852d59a62f8885de93bd32ebc28758958f https://registry.npmjs.org/shebang-regex/-/shebang-regex-3.0.0.tgz /shebang-regex-3.0.0.tgz
ADD --chmod=0444 --checksum=sha256:e6edbc8f203901612a3cd938f940ed520333923986d5427b95c87aa1882e7bd5 https://registry.npmjs.org/side-channel/-/side-channel-1.1.1.tgz /side-channel-1.1.1.tgz
ADD --chmod=0444 --checksum=sha256:793c94ac215be772757045f8804406578b8cbc1bda7e1cde23011f9145af74f7 https://registry.npmjs.org/side-channel-list/-/side-channel-list-1.0.1.tgz /side-channel-list-1.0.1.tgz
ADD --chmod=0444 --checksum=sha256:3b256b6421300bcc962d891b1588fd4b64e84e339b9c29f78c61b72f2a7116d6 https://registry.npmjs.org/side-channel-map/-/side-channel-map-1.0.1.tgz /side-channel-map-1.0.1.tgz
ADD --chmod=0444 --checksum=sha256:3b2a54f0c5e7ad898c8f0ffda2a6805fb2cc5d68f53addf0b4a9ec0db9d0d06e https://registry.npmjs.org/side-channel-weakmap/-/side-channel-weakmap-1.0.2.tgz /side-channel-weakmap-1.0.2.tgz
ADD --chmod=0444 --checksum=sha256:9d3b58a811ecf6a641537387289274cd14f5bb912a27e4f1f2a74182bca8b795 https://registry.npmjs.org/signal-exit/-/signal-exit-4.1.0.tgz /signal-exit-4.1.0.tgz
ADD --chmod=0444 --checksum=sha256:9e4d29b24315611de5a1767ca1b09716f40bb04534836295fe36d80c643974b3 https://registry.npmjs.org/sisteransi/-/sisteransi-1.0.5.tgz /sisteransi-1.0.5.tgz
ADD --chmod=0444 --checksum=sha256:34d729873e80c4ba023ca475f174fa504eca3746202c31fc290d72d00abd36f5 https://registry.npmjs.org/@openclaw/slack/-/slack-2026.9.1.tgz /slack-2026.9.1.tgz
ADD --chmod=0444 --checksum=sha256:bdbca10d17ff5a5802d5acfc7b2f22f9f9bf587632a95650d3c5f513c7092b86 https://registry.npmjs.org/source-map/-/source-map-0.6.1.tgz /source-map-0.6.1.tgz
ADD --chmod=0444 --checksum=sha256:5d9b04ef3e6824fdcf91cfcc03ab427fae486bc6859735805593f51b3554f636 https://registry.npmjs.org/source-map-support/-/source-map-support-0.5.21.tgz /source-map-support-0.5.21.tgz
ADD --chmod=0444 --checksum=sha256:99ae8b2159aa2d25a0186b7b07d8ef21478370af2f9755d905f8055f8b67307b https://registry.npmjs.org/sqlite-vec/-/sqlite-vec-0.1.9.tgz /sqlite-vec-0.1.9.tgz
ADD --chmod=0444 --checksum=sha256:d0bc8fec280c9e30ea3cbc876f44fe71d56f443aeca2bd2bdf745718308d4aed https://registry.npmjs.org/standardwebhooks/-/standardwebhooks-1.1.1.tgz /standardwebhooks-1.1.1.tgz
ADD --chmod=0444 --checksum=sha256:ca800a24710488b568f4e73e8f570dd6b911c122cbf42b06930dee7c25949fe0 https://registry.npmjs.org/statuses/-/statuses-2.0.2.tgz /statuses-2.0.2.tgz
ADD --chmod=0444 --checksum=sha256:af8262434508fa8292407f7fef4690d19eabb73387ca230b41f2a1155216963a https://registry.npmjs.org/string_decoder/-/string_decoder-1.1.1.tgz /string_decoder-1.1.1.tgz
ADD --chmod=0444 --checksum=sha256:adbb4fb1b26e8069af99adff0079369c93f17cf887b91086691d671ddbd52934 https://registry.npmjs.org/string-width/-/string-width-4.2.3.tgz /string-width-4.2.3.tgz
ADD --chmod=0444 --checksum=sha256:9bdb75d0bff49f156dd8c3bcb0e06b3fa96c3d88ddd4c342a4345866a40c08ca https://registry.npmjs.org/strip-ansi/-/strip-ansi-6.0.1.tgz /strip-ansi-6.0.1.tgz
ADD --chmod=0444 --checksum=sha256:5d49f6c719f4558db329b8e3a6ba5109e8fb0d52c2d2f244edf6f1e06fc39a9e https://registry.npmjs.org/strip-final-newline/-/strip-final-newline-4.0.0.tgz /strip-final-newline-4.0.0.tgz
ADD --chmod=0444 --checksum=sha256:58595fe65b2340514ea1c74dbae2bc4d8e5049c4d060cc38eed745da48fa7c96 https://registry.npmjs.org/strtok3/-/strtok3-10.3.5.tgz /strtok3-10.3.5.tgz
ADD --chmod=0444 --checksum=sha256:b792c2d1c7fc770910522ca1ffc29eee02ee38de4fa3a01e7832eb705879c6c6 https://registry.npmjs.org/tar/-/tar-7.5.22.tgz /tar-7.5.22.tgz
ADD --chmod=0444 --checksum=sha256:8c5f3b72177e4f2cd78aa93354a025d70ab3fad996431ff043acf498c85a9bba https://registry.npmjs.org/@microsoft/teams.api/-/teams.api-2.0.15.tgz /teams.api-2.0.15.tgz
ADD --chmod=0444 --checksum=sha256:7bbc9e36bf1a8db09b69914b27796562d01d930345e29e5ee3b6014c0fbccbe9 https://registry.npmjs.org/@microsoft/teams.apps/-/teams.apps-2.0.15.tgz /teams.apps-2.0.15.tgz
ADD --chmod=0444 --checksum=sha256:065c908085f43f0de4d144c4bf504c6d4bbe410a8ad118ee6c0fb1ba7c79a194 https://registry.npmjs.org/@microsoft/teams.cards/-/teams.cards-2.0.15.tgz /teams.cards-2.0.15.tgz
ADD --chmod=0444 --checksum=sha256:0fa46b9f499211334d093015322901649c53d94908a0ff68b280a7a8e08fd78c https://registry.npmjs.org/@microsoft/teams.common/-/teams.common-2.0.15.tgz /teams.common-2.0.15.tgz
ADD --chmod=0444 --checksum=sha256:452f2544ddfaf8db6034a108066009f588d6e8db9d8cde52aceb3fa5e9fef782 https://registry.npmjs.org/@microsoft/teams.graph/-/teams.graph-2.0.15.tgz /teams.graph-2.0.15.tgz
ADD --chmod=0444 --checksum=sha256:991d87763add805a12d5b3e67b201476681a5b738d8dcb9229bed1df755acba0 https://registry.npmjs.org/@borewit/text-codec/-/text-codec-0.2.2.tgz /text-codec-0.2.2.tgz
ADD --chmod=0444 --checksum=sha256:186fcc77488de327daf911d362d4e773bab9909f1df2a5f0c20b875205b92e08 https://registry.npmjs.org/toidentifier/-/toidentifier-1.0.1.tgz /toidentifier-1.0.1.tgz
ADD --chmod=0444 --checksum=sha256:911758ceca239c8e5372700eedfbbd514f16d3c117b5af0a648f6e720487c209 https://registry.npmjs.org/@tokenizer/token/-/token-0.3.0.tgz /token-0.3.0.tgz
ADD --chmod=0444 --checksum=sha256:eb4820714d28f6dad949d392e7b74ec919ae3b120421240a032027bf2bd25f41 https://registry.npmjs.org/token-types/-/token-types-6.1.2.tgz /token-types-6.1.2.tgz
ADD --chmod=0444 --checksum=sha256:164ae1eb32cea353551bbc7f9358dcaae4ffabbe65ec37a92ca464a9570a2a0a https://registry.npmjs.org/tr46/-/tr46-0.0.3.tgz /tr46-0.0.3.tgz
ADD --chmod=0444 --checksum=sha256:43e0a1403a5aa8bebf13fd1ed7f25cd1ac6e8809a4774d7931647f10deeaeaec https://registry.npmjs.org/@grammyjs/transformer-throttler/-/transformer-throttler-1.2.1.tgz /transformer-throttler-1.2.1.tgz
ADD --chmod=0444 --checksum=sha256:d4b2819508ea97cb8953fff7e304a610d443007bd395c8f03a15de9a8ae4a6f9 https://registry.npmjs.org/tree-sitter-bash/-/tree-sitter-bash-0.25.1.tgz /tree-sitter-bash-0.25.1.tgz
ADD --chmod=0444 --checksum=sha256:f4c3968fd81eb7952e94860eb233558c820397d999149b6e2c689abaa34bc65c https://registry.npmjs.org/ts-algebra/-/ts-algebra-2.0.0.tgz /ts-algebra-2.0.0.tgz
ADD --chmod=0444 --checksum=sha256:af0bef7c0eb54ba5fbb71040149b91decfa2d7b5099ebfca2510eda34fe018ea https://registry.npmjs.org/@typespec/ts-http-runtime/-/ts-http-runtime-0.3.9.tgz /ts-http-runtime-0.3.9.tgz
ADD --chmod=0444 --checksum=sha256:66f635d5eeabae44807534976913a102cf615b9a045368359c9f79ae6ee2119e https://registry.npmjs.org/tslib/-/tslib-2.8.1.tgz /tslib-2.8.1.tgz
ADD --chmod=0444 --checksum=sha256:9ce5696fad6f29d8cc1ac86b4c2701e97121286645cd98b35fbbaafe160215ed https://registry.npmjs.org/tslog/-/tslog-4.11.0.tgz /tslog-4.11.0.tgz
ADD --chmod=0444 --checksum=sha256:9a53088d69cd488e0c2cb4fcee5a983089c0d492404cf212161c77501fb302fc https://registry.npmjs.org/type-is/-/type-is-2.1.0.tgz /type-is-2.1.0.tgz
ADD --chmod=0444 --checksum=sha256:2ea093eb4d893c30633d3b8405b767e7857bf64cb7d29ac33a6861abe779087d https://registry.npmjs.org/typebox/-/typebox-1.3.17.tgz /typebox-1.3.17.tgz
ADD --chmod=0444 --checksum=sha256:bd128caf48915fc9be919de1b05e37debd43258aca266140dde80fca0a9db928 https://registry.npmjs.org/@grammyjs/types/-/types-5.0.0.tgz /types-5.0.0.tgz
ADD --chmod=0444 --checksum=sha256:33cd0ee1beaa8c9e9d15a9da836c62ddea4c34a42d7c2d349dbc80d94165d22a https://registry.npmjs.org/typescript/-/typescript-6.0.3.tgz /typescript-6.0.3.tgz
ADD --chmod=0444 --checksum=sha256:f3fb42099ea7a0efa2753b3e770fa0d505714e1c7d75fc1fa6c5aac9ba1baad1 https://registry.npmjs.org/uhyphen/-/uhyphen-0.2.0.tgz /uhyphen-0.2.0.tgz

FROM scratch AS openclaw-managed-messaging-npm-common-archives-5

ADD --chmod=0444 --checksum=sha256:65834dc9ce7ecceff4334a14796c85960cbf665d09364698bf3196ceed04d677 https://registry.npmjs.org/uint8array-extras/-/uint8array-extras-1.5.0.tgz /uint8array-extras-1.5.0.tgz
ADD --chmod=0444 --checksum=sha256:9d72c56c17ad2b3d66f006d53945374cc0d2bc68f322439495b972269f4de6bc https://registry.npmjs.org/undici/-/undici-8.10.0.tgz /undici-8.10.0.tgz
ADD --chmod=0444 --checksum=sha256:07a721cb2cd0dd798c24757de34d14e8b640ff8fddef85d662e00b392562a1f2 https://registry.npmjs.org/undici-types/-/undici-types-8.3.0.tgz /undici-types-8.3.0.tgz
ADD --chmod=0444 --checksum=sha256:e4bfbbe867144ff24f73198367479378c8b6cffc798a2ec0756a81097606908e https://registry.npmjs.org/unicorn-magic/-/unicorn-magic-0.3.0.tgz /unicorn-magic-0.3.0.tgz
ADD --chmod=0444 --checksum=sha256:2dfb5e06d1d4bf1fe9f0fa7f633c4a2fde04d8b41cf0b9bd249a42561d5edfb6 https://registry.npmjs.org/unpipe/-/unpipe-1.0.0.tgz /unpipe-1.0.0.tgz
ADD --chmod=0444 --checksum=sha256:512bce48e5bb53d4351a415be21c6430e33103ecca831439e7e6cfb7aa3fca7d https://registry.npmjs.org/@protobufjs/utf8/-/utf8-1.1.2.tgz /utf8-1.1.2.tgz
ADD --chmod=0444 --checksum=sha256:79a1de983c1b393180c47456d6b73caab278a00ea6e37d5c6675f2dcdec2a3e5 https://registry.npmjs.org/util-deprecate/-/util-deprecate-1.0.2.tgz /util-deprecate-1.0.2.tgz
ADD --chmod=0444 --checksum=sha256:30e122d0715991b19b98043ea8eb275e9083315c8b9cb9e9ba66c249ef936c6b https://registry.npmjs.org/uuid/-/uuid-14.0.2.tgz /uuid-14.0.2.tgz
ADD --chmod=0444 --checksum=sha256:7378860671377a35e7a443ecfdca0745cfd066f595c90d581b827defea246e71 https://registry.npmjs.org/vary/-/vary-1.1.2.tgz /vary-1.1.2.tgz
ADD --chmod=0444 --checksum=sha256:bc2f73bba7ec3f0bf52da313ed1e32b73e0ba36a300c9226cdc1d21383abcba6 https://registry.npmjs.org/@emnapi/wasi-threads/-/wasi-threads-1.2.2.tgz /wasi-threads-1.2.2.tgz
ADD --chmod=0444 --checksum=sha256:85774fffee09f70bde084cebcebae20b3cf6f48239f61659e45aed9fd513463e https://registry.npmjs.org/web-push/-/web-push-3.6.7.tgz /web-push-3.6.7.tgz
ADD --chmod=0444 --checksum=sha256:1ee138d3dc0263ead35c40604da75d7d56c4fa0ef32dc2e3a7fbac10480ebb54 https://registry.npmjs.org/web-streams-polyfill/-/web-streams-polyfill-3.3.3.tgz /web-streams-polyfill-3.3.3.tgz
ADD --chmod=0444 --checksum=sha256:adf5677e04711c597200058971a299fc9fd4133891ee72ec02acf4932e659fdf https://registry.npmjs.org/web-tree-sitter/-/web-tree-sitter-0.26.13.tgz /web-tree-sitter-0.26.13.tgz
ADD --chmod=0444 --checksum=sha256:e4dfc34b40947c2cf0038cd95fa6de21f4dac93224a7ad8e169205f5c2e22da8 https://registry.npmjs.org/webidl-conversions/-/webidl-conversions-3.0.1.tgz /webidl-conversions-3.0.1.tgz
ADD --chmod=0444 --checksum=sha256:ff945ddd5edc39d26e6000d15fdb329b94e8a227515338f80c98d474557f2aa4 https://registry.npmjs.org/@openclaw/whatsapp/-/whatsapp-2026.9.1.tgz /whatsapp-2026.9.1.tgz
ADD --chmod=0444 --checksum=sha256:b09dc471f573a876eeac3902b8c1da62af5cdbbca2c6fba4a06f119f89cb7ed3 https://registry.npmjs.org/whatwg-url/-/whatwg-url-5.0.0.tgz /whatwg-url-5.0.0.tgz
ADD --chmod=0444 --checksum=sha256:a13adf5fddeb769655edce551e81fbb11904b9c9be76d95e41da8c4c499d4edc https://registry.npmjs.org/which/-/which-2.0.2.tgz /which-2.0.2.tgz
ADD --chmod=0444 --checksum=sha256:9ece3c301c82005618410fc338bde9f0e2e38f226dbeebdc3a1c79e1e55636dd https://registry.npmjs.org/which-command/-/which-command-0.1.0.tgz /which-command-0.1.0.tgz
ADD --chmod=0444 --checksum=sha256:ff8eef22f989286c4a33d6c53acf11027a4c2634eb042c63d7bf3700b3424973 https://registry.npmjs.org/which-module/-/which-module-2.0.1.tgz /which-module-2.0.1.tgz
ADD --chmod=0444 --checksum=sha256:d46fc412f04d873700a557bc9686d42c0d6c7979e1825cefebf4279ca9d678f8 https://registry.npmjs.org/wrap-ansi/-/wrap-ansi-6.2.0.tgz /wrap-ansi-6.2.0.tgz
ADD --chmod=0444 --checksum=sha256:0795b3510bd2e938f6a415396de3d4f58fd76ef1f8249a07196444eaf85ca42f https://registry.npmjs.org/wrap-ansi/-/wrap-ansi-7.0.0.tgz /wrap-ansi-7.0.0.tgz
ADD --chmod=0444 --checksum=sha256:aff3730d91b7b1e143822956d14608f563163cf11b9d0ae602df1fe1e430fdfb https://registry.npmjs.org/wrappy/-/wrappy-1.0.2.tgz /wrappy-1.0.2.tgz
ADD --chmod=0444 --checksum=sha256:df3454ef205791ce50b5b9241762dcf9bfe1aa9f7f01d3057229be7dac0c2dc3 https://registry.npmjs.org/ws/-/ws-8.21.3.tgz /ws-8.21.3.tgz
ADD --chmod=0444 --checksum=sha256:d2cbb69eb9d502a5248d79232b18d7fcbf23c9d33b8045f9bc01250650d98dd4 https://registry.npmjs.org/wsl-utils/-/wsl-utils-0.1.0.tgz /wsl-utils-0.1.0.tgz
ADD --chmod=0444 --checksum=sha256:bc4970449801429ba77228a26f03e05ba7e9a5e98111edb44d6a0fc7b6660ecf https://registry.npmjs.org/y18n/-/y18n-4.0.3.tgz /y18n-4.0.3.tgz
ADD --chmod=0444 --checksum=sha256:d43743bad3a7cb3af5d3b6bf70fd32fe3923ea86e4148109c6dd0126deada769 https://registry.npmjs.org/y18n/-/y18n-5.0.8.tgz /y18n-5.0.8.tgz
ADD --chmod=0444 --checksum=sha256:a80c78aa276536615891ef66efbc17d3bd07c8cb14e3bd5298eed3006bfa4d49 https://registry.npmjs.org/yallist/-/yallist-4.0.0.tgz /yallist-4.0.0.tgz
ADD --chmod=0444 --checksum=sha256:7c9d43dbab7cab3b3133b0e6a5af14014482285316b39ec9f508efadd9ebce95 https://registry.npmjs.org/yallist/-/yallist-5.0.0.tgz /yallist-5.0.0.tgz
ADD --chmod=0444 --checksum=sha256:008fa204cb1ba700e0272ba045abbf09a6ffe63456e8146ba97cac6c2ad1ef91 https://registry.npmjs.org/yaml/-/yaml-2.9.0.tgz /yaml-2.9.0.tgz
ADD --chmod=0444 --checksum=sha256:41abfec6a74cfb4fa330af2a33b867dfa06a9b2b439bb01244c4f47c585de535 https://registry.npmjs.org/yargs/-/yargs-15.4.1.tgz /yargs-15.4.1.tgz
ADD --chmod=0444 --checksum=sha256:76ac30834674f0d8da9c7bfedb175f6ada260420e6475edfdcc551c601f8717e https://registry.npmjs.org/yargs/-/yargs-17.7.3.tgz /yargs-17.7.3.tgz
ADD --chmod=0444 --checksum=sha256:0c9135ee2330fd9cdc19fed11b8d9a7b292f5dd8ddf40c13b051340693ebbe58 https://registry.npmjs.org/yargs-parser/-/yargs-parser-18.1.3.tgz /yargs-parser-18.1.3.tgz
ADD --chmod=0444 --checksum=sha256:342b7d527d4a72265b64f27711517349c3c05ee302ab3b8c7452f0bfbe709151 https://registry.npmjs.org/yargs-parser/-/yargs-parser-21.1.1.tgz /yargs-parser-21.1.1.tgz
ADD --chmod=0444 --checksum=sha256:69e7b1153fcfbc16b2cefb12c7a31b79fa4f0fa2915f77ab8ca8afccac680bae https://registry.npmjs.org/yocto-queue/-/yocto-queue-1.2.2.tgz /yocto-queue-1.2.2.tgz
ADD --chmod=0444 --checksum=sha256:abb3214409bcd4a48b1c49384f7441563368c54fa6251c6fb5ab8081907f7f5c https://registry.npmjs.org/yoctocolors/-/yoctocolors-2.2.0.tgz /yoctocolors-2.2.0.tgz
ADD --chmod=0444 --checksum=sha256:ee38f17f533fd500610685a483ae2f413c26f4eb33a51684314563c8d60f279c https://registry.npmjs.org/zod/-/zod-4.4.3.tgz /zod-4.4.3.tgz
ADD --chmod=0444 --checksum=sha256:a4919ab5a32aff4fd6c119c9f187f0dd4b4c490d30c4c4fdaf7c5ff6f38d93f4 https://registry.npmjs.org/zod-to-json-schema/-/zod-to-json-schema-3.25.2.tgz /zod-to-json-schema-3.25.2.tgz

FROM scratch AS openclaw-managed-messaging-npm-common-archives
COPY --from=openclaw-managed-messaging-npm-common-archives-1 / /
COPY --from=openclaw-managed-messaging-npm-common-archives-2 / /
COPY --from=openclaw-managed-messaging-npm-common-archives-3 / /
COPY --from=openclaw-managed-messaging-npm-common-archives-4 / /
COPY --from=openclaw-managed-messaging-npm-common-archives-5 / /

# hadolint ignore=DL3006
FROM openclaw-managed-messaging-npm-common-archives AS openclaw-managed-messaging-npm-amd64-archives

ADD --chmod=0444 --checksum=sha256:d58787dcf1d9d64c852ee448cd0e6228047eded78e7c5837fbcbecf9a93385a5 https://registry.npmjs.org/@trycua/cua-driver-linux-x64-gnu/-/cua-driver-linux-x64-gnu-0.22.0.tgz /cua-driver-linux-x64-gnu-0.22.0.tgz
ADD --chmod=0444 --checksum=sha256:cb31bdaecad5fb5eeac085cf215b0981b9f00c74bd0e0680dc459af8724e88fa https://registry.npmjs.org/@openclaw/fs-safe-linux-x64-gnu/-/fs-safe-linux-x64-gnu-0.7.0.tgz /fs-safe-linux-x64-gnu-0.7.0.tgz
ADD --chmod=0444 --checksum=sha256:82f38580fe47fdf9f06f854920329eca54b5514997bf202397ef89a27ec82cab https://registry.npmjs.org/@koromix/koffi-linux-x64/-/koffi-linux-x64-3.1.6.tgz /koffi-linux-x64-3.1.6.tgz
ADD --chmod=0444 --checksum=sha256:08e05d837c6b3faefdd3e77ac3155c2654392a62d241961bcccc221f3783170a https://registry.npmjs.org/@ubjs/node-linux-x64-gnu/-/node-linux-x64-gnu-0.31.0-3.tgz /node-linux-x64-gnu-0.31.0-3.tgz
ADD --chmod=0444 --checksum=sha256:754dae77f06207acbb65423fd45d4482d20a563200c520196c8222f2a6f5ba3c https://registry.npmjs.org/@lydell/node-pty-linux-x64/-/node-pty-linux-x64-1.2.0-beta.15.tgz /node-pty-linux-x64-1.2.0-beta.15.tgz
ADD --chmod=0444 --checksum=sha256:d75c33662b3ce690d122a5f4285a3acf2f6ba288c46331a7b1fad593b6da2908 https://registry.npmjs.org/sqlite-vec-linux-x64/-/sqlite-vec-linux-x64-0.1.9.tgz /sqlite-vec-linux-x64-0.1.9.tgz

# hadolint ignore=DL3006
FROM openclaw-managed-messaging-npm-common-archives AS openclaw-managed-messaging-npm-arm64-archives

ADD --chmod=0444 --checksum=sha256:675c48bfbe39b1e49e975f0537b4d3b751ad372368e3a696c92b8f8e91c9133a https://registry.npmjs.org/@trycua/cua-driver-linux-arm64-gnu/-/cua-driver-linux-arm64-gnu-0.22.0.tgz /cua-driver-linux-arm64-gnu-0.22.0.tgz
ADD --chmod=0444 --checksum=sha256:87092f5333da5e349b7c73f7079a169e14c5147266e6daa4d28e42502d4c9211 https://registry.npmjs.org/@openclaw/fs-safe-linux-arm64-gnu/-/fs-safe-linux-arm64-gnu-0.7.0.tgz /fs-safe-linux-arm64-gnu-0.7.0.tgz
ADD --chmod=0444 --checksum=sha256:17c3bfb024cf04595786c10578dce21d69eda8e35ecaff7d8a2805b0619dd836 https://registry.npmjs.org/@koromix/koffi-linux-arm64/-/koffi-linux-arm64-3.1.6.tgz /koffi-linux-arm64-3.1.6.tgz
ADD --chmod=0444 --checksum=sha256:31c4c8ecbd26484f660c03576fb1c0de7883f45b0018df4b76fd316845b96a52 https://registry.npmjs.org/@ubjs/node-linux-arm64-gnu/-/node-linux-arm64-gnu-0.31.0-3.tgz /node-linux-arm64-gnu-0.31.0-3.tgz
ADD --chmod=0444 --checksum=sha256:f9da59f77496d1f3065d368b61c3af0b9c6785f0b22c5a70144283fcdf6b3036 https://registry.npmjs.org/@lydell/node-pty-linux-arm64/-/node-pty-linux-arm64-1.2.0-beta.15.tgz /node-pty-linux-arm64-1.2.0-beta.15.tgz
ADD --chmod=0444 --checksum=sha256:96a03e2ac0906b035085ec4e2307dd8076fb02673b8f5bb6659a5f4feeacd892 https://registry.npmjs.org/sqlite-vec-linux-arm64/-/sqlite-vec-linux-arm64-0.1.9.tgz /sqlite-vec-linux-arm64-0.1.9.tgz

# hadolint ignore=DL3006
FROM openclaw-managed-messaging-npm-${TARGETARCH}-archives AS openclaw-managed-messaging-npm-archives

# Keep the messaging graph inert unless release builds select its lock cache.
FROM node:24.18.1-trixie-slim@sha256:ac39e4b5fcb2b1b34b20364fd58b2e898f3bb80731ee6f62a7536f9df3d6aadc AS openclaw-managed-messaging-npm-cache-0
RUN install -d -o root -g root -m 0755 /out/npm-cache

FROM npm12 AS openclaw-managed-messaging-npm-cache-1
ARG TARGETARCH
ENV NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false
COPY agents/openclaw/managed-image-messaging-runtime/package.json agents/openclaw/managed-image-messaging-runtime/package-lock.json /opt/managed-image-messaging-runtime/
COPY scripts/checks/materialize-locked-npm-cache-seed.mts scripts/checks/verify-managed-messaging-offline-install.mts /scripts/checks/
COPY scripts/lib/seed-reviewed-npm-cache.mts /scripts/lib/seed-reviewed-npm-cache.mts
COPY --from=openclaw-managed-messaging-npm-archives / /opt/nemoclaw-build-tools/npm-cache-seed/
RUN --network=none set -eu; \
    case "$TARGETARCH" in \
        amd64) npm_target_cpu=x64 ;; \
        arm64) npm_target_cpu=arm64 ;; \
        *) echo "ERROR: unsupported managed messaging npm target: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    install -d -o root -g root -m 0755 /out/npm-cache; \
    node /scripts/lib/seed-reviewed-npm-cache.mts \
        --lockfile /opt/managed-image-messaging-runtime/package-lock.json \
        --cache /out/npm-cache \
        --registry-origin https://registry.npmjs.org/ \
        --archive-directory /opt/nemoclaw-build-tools/npm-cache-seed \
        --os linux --cpu "$npm_target_cpu" --libc glibc; \
    NPM_CONFIG_OFFLINE=true npm ci --prefix /opt/managed-image-messaging-runtime \
        --ignore-scripts --omit=dev --legacy-peer-deps \
        --userconfig /dev/null --registry https://registry.npmjs.org/ \
        --cache /out/npm-cache; \
    node /scripts/checks/verify-managed-messaging-offline-install.mts --lockfile /opt/managed-image-messaging-runtime/package-lock.json --prefix /opt/managed-image-messaging-runtime; npm cache verify --cache /out/npm-cache; \
    node /scripts/lib/seed-reviewed-npm-cache.mts \
        --packuments-only \
        --lockfile /opt/managed-image-messaging-runtime/package-lock.json \
        --cache /out/npm-cache \
        --registry-origin https://registry.npmjs.org/; \
    rm -rf /opt/managed-image-messaging-runtime/node_modules \
        /opt/nemoclaw-build-tools/npm-cache-seed; \
    chown -R root:root /out/npm-cache; \
    chmod -R a+rX,go-w /out/npm-cache

# hadolint ignore=DL3006
FROM openclaw-managed-messaging-npm-cache-${NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION} AS openclaw-managed-messaging-npm-cache

FROM scratch AS openclaw-dependency-payload

COPY agents/openclaw/openclaw-runtime/package.json /usr/local/lib/nemoclaw/openclaw-runtime/package.json
COPY agents/openclaw/openclaw-runtime/package-lock.json /usr/local/lib/nemoclaw/openclaw-runtime/package-lock.json
COPY agents/openclaw/mcporter-runtime/package.json /usr/local/lib/nemoclaw/mcporter-runtime/package.json
COPY agents/openclaw/mcporter-runtime/package-lock.json /usr/local/lib/nemoclaw/mcporter-runtime/package-lock.json
COPY agents/openclaw/wechat-runtime/package.json /usr/local/lib/nemoclaw/wechat-runtime/package.json
COPY agents/openclaw/wechat-runtime/package-lock.json /usr/local/lib/nemoclaw/wechat-runtime/package-lock.json
COPY ci/npm-audit-exceptions.json ci/reviewed-npm-audit.json /scripts/
COPY scripts/lib/reviewed-npm-archive.mts scripts/lib/bundled-npm-package.mts scripts/lib/reviewed-npm-audit.mts scripts/lib/openclaw-npm-remediation.mts scripts/lib/patch-bundled-npm-ip-address.mts scripts/lib/reviewed-npm-identity.mts /scripts/lib/
COPY scripts/lib/verify-mcporter-audit.sh /scripts/lib/verify-mcporter-audit.sh
COPY scripts/patch-bundled-npm-brace-expansion.mts scripts/patch-bundled-npm-tar.mts scripts/upgrade-bundled-npm.mts /scripts/
COPY ci/reviewed-npm-audit.json /ci/reviewed-npm-audit.json

FROM scratch AS openclaw-plugin-payload

COPY --from=builder /opt/nemoclaw/dist/ /opt/nemoclaw/dist/
COPY nemoclaw/openclaw.plugin.json /opt/nemoclaw/
COPY nemoclaw-blueprint/ /opt/nemoclaw-blueprint/

FROM scratch AS openclaw-patch-payload

COPY scripts/patch-openclaw-tool-catalog.mts /usr/local/lib/nemoclaw/patch-openclaw-tool-catalog.mts
COPY scripts/lib/patch-openclaw-npm12-pack-json.mts /usr/local/lib/nemoclaw/npm12.mts
COPY scripts/patch-openclaw-chat-send.mts /usr/local/lib/nemoclaw/patch-openclaw-chat-send.mts
COPY scripts/lib/patch-openclaw-container-restart.mts /usr/local/lib/nemoclaw/patch-openclaw-container-restart.mts
COPY scripts/patch-openclaw-mcp-npx.mts /usr/local/lib/nemoclaw/patch-openclaw-mcp-npx.mts
COPY scripts/patch-openclaw-mcp-reliability.mts /usr/local/lib/nemoclaw/patch-openclaw-mcp-reliability.mts
COPY scripts/patch-openclaw-mcp-tools-list-timeout.mts /usr/local/lib/nemoclaw/patch-openclaw-mcp-tools-list-timeout.mts
COPY scripts/patch-openclaw-issue-4434-diagnostics.mts /usr/local/lib/nemoclaw/patch-openclaw-issue-4434-diagnostics.mts
COPY scripts/patch-openclaw-managed-transport-diagnostics.mts /usr/local/lib/nemoclaw/patch-openclaw-managed-transport-diagnostics.mts
COPY scripts/patch-openclaw-device-self-approval.mts /usr/local/lib/nemoclaw/patch-openclaw-device-self-approval.mts
COPY scripts/lib/patch-openclaw-secondary-main-session-delete.mts /usr/local/lib/nemoclaw/patch-openclaw-secondary-main-session-delete.mts
COPY scripts/extract-semver.sh /usr/local/lib/nemoclaw/extract-semver
COPY scripts/patch-openclaw-shared-state-permissions.mts /usr/local/lib/nemoclaw/patch-openclaw-shared-state-permissions.mts
COPY scripts/verify-wechat-runtime-lock.mts /usr/local/lib/nemoclaw/verify-wechat-runtime-lock.mts

FROM scratch AS openclaw-runtime-payload

COPY scripts/lib/sandbox-init.sh /usr/local/lib/nemoclaw/sandbox-init.sh
COPY --chmod=0444 scripts/lib/corporate-ca-runtime.sh /usr/local/lib/nemoclaw/corporate-ca-runtime.sh
COPY scripts/lib/entrypoint-env-wrapper.sh /usr/local/lib/nemoclaw/entrypoint-env-wrapper.sh
COPY scripts/lib/sandbox-rlimits.sh /usr/local/lib/nemoclaw/sandbox-rlimits.sh
COPY scripts/lib/openclaw_device_approval_policy.py /usr/local/lib/nemoclaw/openclaw_device_approval_policy.py
COPY scripts/lib/openclaw_pairing_state.py /usr/local/lib/nemoclaw/openclaw_pairing_state.py
COPY scripts/lib/normalize_mutable_config_perms.py /usr/local/lib/nemoclaw/normalize_mutable_config_perms.py
COPY scripts/lib/refresh-openclaw-wechat-placeholder.py /usr/local/lib/nemoclaw/refresh-openclaw-wechat-placeholder.py
COPY scripts/openclaw-config-guard.py /usr/local/lib/nemoclaw/openclaw-config-guard.py
COPY scripts/nemoclaw-start.sh /usr/local/bin/nemoclaw-start
COPY scripts/managed-startup-hold.sh /usr/local/bin/nemoclaw-managed-startup-hold
COPY nemoclaw-blueprint/scripts/*.js /usr/local/lib/nemoclaw/preloads/
COPY --from=runtime-preload-builder /opt/nemoclaw-root/dist/lib/messaging/channels/ /usr/local/lib/nemoclaw/preloads-compiled-channels/
COPY scripts/codex-acp-wrapper.sh /usr/local/bin/nemoclaw-codex-acp
COPY scripts/generate-openclaw-config.mts /scripts/
COPY scripts/validate-openclaw-tool-search.mts /scripts/
COPY --from=managed-startup-runtime-builder /out/managed-startup-image-runtime.cjs /usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs
COPY src/lib/extra-agents-validation.ts src/lib/tool-disclosure.ts src/lib/providerless-inference.ts /src/lib/
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
# published sandbox base with Node 22.22.2. OpenClaw 2026.9.1 requires the
# SQLite WAL fix in Node 22.22.3 or newer. The trusted managed-image staging
# path removes this one instruction when it has just built Dockerfile.base from
# the same Node image, avoiding a redundant 125 MB layer in that local-only case.
COPY --from=builder /usr/local/bin/node /usr/local/bin/node

ARG OPENCLAW_VERSION=2026.9.1
ARG OPENCLAW_2026_9_1_INTEGRITY=sha512-0Ve0631CdgkJDwd4NNG1BawIdF5yCL2sO+Tts8amStw+H6vKURTj0K4rOa4+hFpJk1Dnw5LyKl5twzwX1VtA2w==
ARG OPENCLAW_2026_9_1_TARBALL=https://registry.npmjs.org/openclaw/-/openclaw-2026.9.1.tgz
ARG OPENCLAW_DIAGNOSTICS_OTEL_2026_9_1_INTEGRITY=sha512-3MWLli9L6HTVdrjqHmwOvNvIr6emsnuNQe4iE2sDqb8E5wn4Vq1rcsz+InL1YFudbStr089ZtS0tNAQ6qU+tnA==
ARG OPENCLAW_BRAVE_PLUGIN_2026_9_1_INTEGRITY=sha512-4+j+eQTToV3k7Cb25MUL6h2uL8cJYyuLytfpd/sJK/HjR43dgKBqKpBsb1+I3w1Jr6PLpnjSf6/I3//3K0cdnA==
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
ARG NEMOCLAW_MCPORTER_AUDIT_RECEIPT_SHA256=
ARG NEMOCLAW_MCPORTER_AUDIT_POLICY_RESULT_SHA256=

# Preserve existing parent metadata while creating one final-image layer.
COPY --from=openclaw-dependency-payload / /
COPY --from=reviewed-npm-archive /npm-12.0.2.tgz /tmp/npm-12.0.2.tgz
# Standardize a lagging published base from immutable SHA-256- and SRI-bound bytes.
RUN node /scripts/upgrade-bundled-npm.mts --npm-root /usr/local/lib/node_modules/npm --archive /tmp/npm-12.0.2.tgz
# hadolint ignore=DL3059
RUN rm /tmp/npm-12.0.2.tgz

# OpenClaw 2026.9.1 loads some generated source through jiti. Disable its
# filesystem transform cache so source fragments that mention provider marker
# names do not persist under /tmp/jiti inside the sandbox.
ENV JITI_FS_CACHE=false

# Onboard can bake this public corporate CA into the OpenShell trust bundle (#6210).
# It is empty by default and is not a secret.
ARG NEMOCLAW_CORPORATE_CA_B64

# Decode a supplied, host-sanitized CA to a root-owned, read-only file.
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

# The runtime entrypoint builds its own merged OpenShell and corporate CA bundle.

# The final image owns the shipped dependency boundary independently of base
# freshness. Reassert the idempotent npm-private fixes after corporate CA setup
# so cold registry-backed remediation can use the operator-supplied trust root.
RUN if [ -f /usr/local/share/nemoclaw/corporate-ca.pem ]; then \
      export CURL_CA_BUNDLE=/usr/local/share/nemoclaw/corporate-ca.pem; \
      export NODE_EXTRA_CA_CERTS=/usr/local/share/nemoclaw/corporate-ca.pem; \
    fi; \
    node /scripts/patch-bundled-npm-tar.mts \
      --npm-root /usr/local/lib/node_modules/npm

# Reassert the npm-private brace-expansion fix for the final filesystem.
# hadolint ignore=DL3059
RUN if [ -f /usr/local/share/nemoclaw/corporate-ca.pem ]; then \
      export CURL_CA_BUNDLE=/usr/local/share/nemoclaw/corporate-ca.pem; \
      export NODE_EXTRA_CA_CERTS=/usr/local/share/nemoclaw/corporate-ca.pem; \
    fi; \
    node /scripts/patch-bundled-npm-brace-expansion.mts \
      --npm-root /usr/local/lib/node_modules/npm

# Reassert the npm-private ip-address fix for the final filesystem. When
# onboarding supplied a corporate CA, use it for the registry-backed download.
# hadolint ignore=DL3059
RUN if [ -f /usr/local/share/nemoclaw/corporate-ca.pem ]; then \
      export CURL_CA_BUNDLE=/usr/local/share/nemoclaw/corporate-ca.pem; \
      export NODE_EXTRA_CA_CERTS=/usr/local/share/nemoclaw/corporate-ca.pem; \
    fi; \
    node /scripts/lib/patch-bundled-npm-ip-address.mts \
      --npm-root /usr/local/lib/node_modules/npm

# Harden: remove unnecessary build tools and network probes from base image (#830)
# Protect runtime tools before autoremove — the GHCR base may predate the
# procps/e2fsprogs/lsof/tmux additions, leaving ps/chattr/lsof/tmux absent or auto-marked.
# The conditional install keeps stale bases usable while fresh bases skip apt.
# tmux is required by OpenClaw's bundled tmux-session flow (#4513); a stale base
# without it makes that flow fail with `tmux: command not found`.
# Refs: #2343, #4513, config transaction hardening
# hadolint ignore=DL3001
RUN set -eu; \
    apt-mark manual procps e2fsprogs lsof tmux 2>/dev/null || true; \
    (apt-get remove --purge -y gcc gcc-12 g++ g++-12 cpp cpp-12 make \
        netcat-openbsd netcat-traditional ncat 2>/dev/null || true); \
    apt-get autoremove --purge -y; \
    needs_ps=0; \
    needs_chattr=0; \
    needs_lsof=0; \
    needs_tmux=0; \
    if ! command -v ps >/dev/null 2>&1; then needs_ps=1; fi; \
    if ! command -v chattr >/dev/null 2>&1; then needs_chattr=1; fi; \
    if ! command -v lsof >/dev/null 2>&1; then needs_lsof=1; fi; \
    if ! command -v tmux >/dev/null 2>&1; then needs_tmux=1; fi; \
    if [ "$needs_ps" = "1" ] || [ "$needs_chattr" = "1" ] || [ "$needs_lsof" = "1" ] || [ "$needs_tmux" = "1" ]; then \
        apt-get update; \
        if [ "$needs_ps" = "1" ]; then \
            apt-get install -y --no-install-recommends procps=2:4.0.4-9; \
        fi; \
        if [ "$needs_chattr" = "1" ]; then \
            apt-get install -y --no-install-recommends e2fsprogs=1.47.2-3+b12; \
        fi; \
        if [ "$needs_lsof" = "1" ]; then \
            apt-get install -y --no-install-recommends lsof=4.99.4+dfsg-2; \
        fi; \
        if [ "$needs_tmux" = "1" ]; then \
            apt-get install -y --no-install-recommends tmux=3.5a-3; \
        fi; \
    fi; \
    rm -rf /var/lib/apt/lists/*; \
    ps --version; \
    command -v chattr >/dev/null; \
    command -v lsof >/dev/null; \
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
# the committed lock, seeds resolver metadata, and re-packs every archive offline
# before this root-owned immutable cache enters the final image.
COPY --from=wechat-npm-cache /out/wechat-npm-cache/ /usr/local/share/nemoclaw/wechat-npm-cache/
COPY --from=openclaw-patch-payload / /

RUN chmod 755 /usr/local/lib/nemoclaw/patch-openclaw-tool-catalog.mts \
        /usr/local/lib/nemoclaw/npm12.mts \
        /usr/local/lib/nemoclaw/patch-openclaw-chat-send.mts \
        /usr/local/lib/nemoclaw/patch-openclaw-container-restart.mts \
        /usr/local/lib/nemoclaw/patch-openclaw-mcp-npx.mts \
        /usr/local/lib/nemoclaw/patch-openclaw-mcp-reliability.mts \
        /usr/local/lib/nemoclaw/patch-openclaw-mcp-tools-list-timeout.mts \
        /usr/local/lib/nemoclaw/patch-openclaw-issue-4434-diagnostics.mts \
        /usr/local/lib/nemoclaw/patch-openclaw-managed-transport-diagnostics.mts \
        /usr/local/lib/nemoclaw/patch-openclaw-device-self-approval.mts \
        /usr/local/lib/nemoclaw/patch-openclaw-secondary-main-session-delete.mts \
        /usr/local/lib/nemoclaw/extract-semver \
        /usr/local/lib/nemoclaw/patch-openclaw-shared-state-permissions.mts \
        /usr/local/lib/nemoclaw/verify-wechat-runtime-lock.mts

# Install SRI-verified ACP offline; runtime registry access is blocked.
# hadolint ignore=DL3059,DL4006,DL3016
COPY --from=codex-acp-runtime /usr/local/lib/node_modules/@zed-industries/ /usr/local/lib/node_modules/@zed-industries/
COPY --from=codex-acp-runtime /usr/local/bin/codex-acp /usr/local/bin/codex-acp
RUN command -v codex-acp >/dev/null

# Upgrade stale bases. Reuse is restricted to matching provenance from an
# official digest-pinned base; mutable/custom bases reinstall the locked graphs.
# OPENCLAW_VERSION is the NemoClaw runtime build target and must meet the blueprint minimum.
# Reviewed archives retain registry and packed-byte SRI, basename, local-only install, and cleanup gates.
# hadolint ignore=DL3059,DL4006,DL3016,SC2015
RUN --mount=type=secret,id=nemoclaw-mcporter-audit-receipt,required=false \
    --mount=type=secret,id=nemoclaw-mcporter-audit-raw-report,required=false \
    --mount=type=secret,id=nemoclaw-mcporter-audit-policy-result,required=false \
    set -eu; \
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
    if [ "$OPENCLAW_VERSION" = "2026.9.1" ]; then EXPECTED_INTEGRITY="$OPENCLAW_2026_9_1_INTEGRITY"; EXPECTED_TARBALL="$OPENCLAW_2026_9_1_TARBALL"; fi; \
    if [ "$OPENCLAW_VERSION" = "2026.3.11" ]; then EXPECTED_INTEGRITY="$OPENCLAW_2026_3_11_INTEGRITY"; EXPECTED_TARBALL="$OPENCLAW_2026_3_11_TARBALL"; fi; \
    if [ "$OPENCLAW_VERSION" = "2026.4.24" ]; then EXPECTED_INTEGRITY="$OPENCLAW_2026_4_24_INTEGRITY"; EXPECTED_TARBALL="$OPENCLAW_2026_4_24_TARBALL"; fi; \
    if [ -z "$EXPECTED_INTEGRITY" ]; then \
        echo "ERROR: OpenClaw ${OPENCLAW_VERSION} has no committed npm integrity pin" >&2; exit 1; \
    fi; \
    OPENCLAW_LOCK_SHA256=none-legacy-fixture; \
    OPENCLAW_RECIPE='ignore-scripts+reviewed-lifecycle-v1'; \
    if [ "$OPENCLAW_VERSION" = "2026.9.1" ]; then \
        OPENCLAW_LOCK_SHA256=9f99aa4f5d10280b4d809e0d54f20bcbe786d4140d30fc10ed502b1305ff9a8d; \
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
    MCPORTER_AUDIT_EVIDENCE=0; \
    if [ -n "${NEMOCLAW_MCPORTER_AUDIT_RECEIPT_SHA256:-}${NEMOCLAW_MCPORTER_AUDIT_POLICY_RESULT_SHA256:-}" ]; then \
        NEMOCLAW_MCPORTER_AUDIT_REPORT_PATH=/tmp/mcporter-npm-audit.json \
            NEMOCLAW_MCPORTER_AUDIT_RESULT_PATH=/tmp/mcporter-npm-audit-policy.json \
            bash /scripts/lib/verify-mcporter-audit.sh; \
        MCPORTER_AUDIT_EVIDENCE=1; \
        MCPORTER_AUDIT_POLICY_SHA256="$(node -p "require('/tmp/mcporter-npm-audit-policy.json').exceptionPolicySha256")"; \
        MCPORTER_EXPECTED_AUDIT_EXCEPTIONS="$(node -p "require('/tmp/mcporter-npm-audit-policy.json').acceptedAdvisories.join(',') || 'none'")"; \
        MCPORTER_EXPECTED_AUDIT_STATUS="$(node -p "require('/tmp/mcporter-npm-audit-policy.json').status")"; \
    else \
        MCPORTER_AUDIT_POLICY_SHA256="$(sha256sum /scripts/npm-audit-exceptions.json | awk '{print $1}')"; \
        MCPORTER_EXPECTED_AUDIT_EXCEPTIONS="$(node --input-type=module -e \
            'import fs from "node:fs"; import { parseAuditExceptionRegistry } from "/scripts/lib/reviewed-npm-audit.mts"; const policy=parseAuditExceptionRegistry(fs.readFileSync("/scripts/npm-audit-exceptions.json", "utf-8")); const ids=policy.exceptions.filter((entry)=>entry.graph==="mcporter-runtime").map((entry)=>entry.advisory).sort(); process.stdout.write(ids.join(",") || "none");')"; \
        MCPORTER_EXPECTED_AUDIT_STATUS=clean; \
        if [ "$MCPORTER_EXPECTED_AUDIT_EXCEPTIONS" != "none" ]; then MCPORTER_EXPECTED_AUDIT_STATUS=accepted-exceptions; fi; \
    fi; \
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
        echo "INFO: Reusing reviewed base OpenClaw $CUR_VER with matching reviewed provenance"; \
    elif [ "$(printf '%s\n%s' "$OPENCLAW_VERSION" "$CUR_VER" | sort -V | head -n1)" = "$OPENCLAW_VERSION" ] \
        && [ "$CUR_VER" != "$OPENCLAW_VERSION" ]; then \
        echo "ERROR: Base image has OpenClaw $CUR_VER, which is newer than reviewed target $OPENCLAW_VERSION" >&2; exit 1; \
    else \
        echo "INFO: Base image OpenClaw $CUR_VER lacks matching reviewed provenance; installing $OPENCLAW_VERSION"; \
        # npm's atomic-move install can hit EROFS on overlayfs when the prior
        # install spans image layers. Removing it first also prevents unreviewed
        # files from surviving a same-version reinstall.
        rm -rf /usr/local/lib/node_modules/openclaw /usr/local/bin/openclaw; \
        if [ "$OPENCLAW_VERSION" = "2026.9.1" ]; then \
            node /scripts/lib/reviewed-npm-archive.mts --verify-lock \
                --lock-sha256 "$OPENCLAW_LOCK_SHA256" \
                --lockfile /usr/local/lib/nemoclaw/openclaw-runtime/package-lock.json \
                --registry-origin https://registry.npmjs.org/ \
                --package-spec "openclaw@${OPENCLAW_VERSION}" --integrity "$EXPECTED_INTEGRITY" \
                --tarball-url "$EXPECTED_TARBALL" --label "OpenClaw ${OPENCLAW_VERSION}"; \
            npm --prefix /usr/local/lib/nemoclaw/openclaw-runtime ci \
                --ignore-scripts --omit=dev --no-audit --no-fund --no-progress \
                --userconfig /dev/null --registry https://registry.npmjs.org/; \
            node /scripts/lib/reviewed-npm-archive.mts \
                --verify-installed-lock --lock-sha256 "$OPENCLAW_LOCK_SHA256" \
                --lockfile /usr/local/lib/nemoclaw/openclaw-runtime/package-lock.json \
                --install-root /usr/local/lib/nemoclaw/openclaw-runtime \
                --label "OpenClaw ${OPENCLAW_VERSION}"; \
            node /usr/local/lib/nemoclaw/openclaw-runtime/node_modules/openclaw/scripts/postinstall-bundled-plugins.mjs; \
            mkdir -p /usr/local/lib/node_modules; \
            ln -s /usr/local/lib/nemoclaw/openclaw-runtime/node_modules/openclaw /usr/local/lib/node_modules/openclaw; \
            ln -s /usr/local/lib/nemoclaw/openclaw-runtime/node_modules/.bin/openclaw /usr/local/bin/openclaw; \
        else \
            OPENCLAW_SOURCE_PACK_PATH="$(node /scripts/lib/reviewed-npm-archive.mts \
                --package-spec "openclaw@${OPENCLAW_VERSION}" --integrity "$EXPECTED_INTEGRITY" \
                --tarball-url "$EXPECTED_TARBALL" --label "OpenClaw ${OPENCLAW_VERSION}")"; \
            OPENCLAW_PACK_PATH="$OPENCLAW_SOURCE_PACK_PATH"; \
            OPENCLAW_PACK_DIR="$(dirname "$OPENCLAW_PACK_PATH")"; \
            if [ "$OPENCLAW_VERSION" = "2026.3.11" ]; then \
                OPENCLAW_REMEDIATION_JSON="$(node /scripts/lib/openclaw-npm-remediation.mts \
                    --archive "$OPENCLAW_SOURCE_PACK_PATH" --package-spec "openclaw@${OPENCLAW_VERSION}" \
                    --working-directory "$OPENCLAW_PACK_DIR")"; \
                OPENCLAW_PACK_PATH="$(node -e 'const value = JSON.parse(process.argv[1]); if (!value.remediated || typeof value.archivePath !== "string") process.exit(1); process.stdout.write(value.archivePath)' "$OPENCLAW_REMEDIATION_JSON")"; \
            fi; \
            npm install -g --no-audit --no-fund --no-progress --ignore-scripts --allow-git=root "$OPENCLAW_PACK_PATH"; \
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
        echo "INFO: Reusing reviewed base mcporter $CUR_MCPORTER_VER with matching lock provenance"; \
    else \
        node /scripts/lib/reviewed-npm-archive.mts --verify-only \
            --package-spec "mcporter@${MCPORTER_VERSION}" --integrity "$MCPORTER_EXPECTED_INTEGRITY" \
            --tarball-url "$MCPORTER_EXPECTED_TARBALL" --label "mcporter ${MCPORTER_VERSION}"; \
        # Reinstall from the committed lock when matching protected base provenance
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
    fi; \
    if [ "$MCPORTER_AUDIT_EVIDENCE" = 0 ]; then \
        bash /scripts/lib/verify-mcporter-audit.sh; \
    fi; \
    rm -f /tmp/mcporter-npm-audit.json /tmp/mcporter-npm-audit-policy.json

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
# OpenShell policy explicitly allows that host:port. Add this hostname
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
    # Reviewed against openclaw@2026.9.1 dist: fetchWithWebToolsNetworkGuard \
    # passes useEnvProxy into withTrustedEnvProxyGuardedFetchMode(resolved), and \
    # the SSRF guard consumes policy.allowedHostnames to skip private-network \
    # checks for a normalized hostname. hostnameAllowlist only gates \
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
    # Reviewed against openclaw@2026.9.1 dist fetch-guard: the STRICT-mode \
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
    # Reviewed against openclaw@2026.9.1 dist: the cron isolated-agent preflight \
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
    # Legacy OpenClaw install-safe-path and install-package-dir layouts reject \
    # symlinked directories via lstat. Change those exact shapes to stat while \
    # retaining realpath containment. OpenClaw 2026.9.1 delegates safe-path \
    # enforcement to @openclaw/fs-safe and already uses stat plus realpath in \
    # install-package-dir; accept only those reviewed replacement shapes. \
    isp_file="$(grep -RIlE --include='*.js' 'const baseLstat = await fs\.(lstat|stat)\(baseDir\)' "$OC_DIST/install-safe-path-"*.js || true)"; \
    if [ -n "$isp_file" ]; then \
        sed -i 's/const baseLstat = await fs\.lstat(baseDir)/const baseLstat = await fs.stat(baseDir)/' "$isp_file"; \
        if grep -q 'const baseLstat = await fs\.lstat(baseDir)' "$isp_file"; then echo "ERROR: Patch 3a (install-safe-path) left baseLstat lstat call" >&2; exit 1; fi; \
        if ! grep -q 'const baseLstat = await fs\.stat(baseDir)' "$isp_file"; then echo "ERROR: Patch 3a (install-safe-path) did not find patched baseLstat stat call" >&2; exit 1; fi; \
    else \
        isp_delegate_file="$(grep -RIlF --include='*.js' 'from "@openclaw/fs-safe/advanced"' "$OC_DIST/install-safe-path-"*.js || true)"; \
        isp_delegate_count="$(printf '%s\n' "$isp_delegate_file" | awk 'NF { count++ } END { print count + 0 }')"; \
        if [ "$OC_VERSION" != "2026.9.1" ] || [ "$isp_delegate_count" -ne 1 ]; then \
            patch_fail "Patch 3a target missing without the single reviewed 2026.9.1 @openclaw/fs-safe delegation"; \
        fi; \
        if ! grep -Fq 'assertCanonicalPathWithinBase' "$isp_delegate_file" \
            || ! grep -Fq 'resolveSafeInstallDir' "$isp_delegate_file"; then \
            patch_fail "Patch 3a reviewed @openclaw/fs-safe delegation is incomplete"; \
        fi; \
        if grep -Fq 'lstat(' "$isp_delegate_file"; then \
            patch_fail "Patch 3a reviewed @openclaw/fs-safe delegation still performs a local lstat"; \
        fi; \
        echo "INFO: OpenClaw ${OC_VERSION} delegates install-safe-path to @openclaw/fs-safe/advanced; Patch 3a not needed"; \
    fi; \
    ipd_file="$(grep -RIlE --include='*.js' 'assertInstallBaseStable' "$OC_DIST/install-package-dir-"*.js || true)"; \
    test -n "$ipd_file" || { echo "ERROR: install-package-dir assertInstallBaseStable not found" >&2; exit 1; }; \
    if grep -q 'const baseLstat = await fs\.lstat(params\.installBaseDir)' "$ipd_file"; then \
        sed -i 's/const baseLstat = await fs\.lstat(params\.installBaseDir)/const baseLstat = await fs.stat(params.installBaseDir)/' "$ipd_file"; \
        sed -i 's/baseLstat\.isSymbolicLink()/false \/* nemoclaw: symlink check disabled, realpath guards containment *\//' "$ipd_file"; \
        if grep -q 'fs\.lstat(params\.installBaseDir)' "$ipd_file"; then echo "ERROR: Patch 3b (install-package-dir) left lstat in assertInstallBaseStable" >&2; exit 1; fi; \
        if ! grep -q 'const baseLstat = await fs\.stat(params\.installBaseDir)' "$ipd_file" && ! grep -q 'await fs\.stat(params\.installBaseDir)).isDirectory()' "$ipd_file"; then echo "ERROR: Patch 3b (install-package-dir) did not find patched/safe installBaseDir stat call" >&2; exit 1; fi; \
        if grep -q 'baseLstat\.isSymbolicLink()' "$ipd_file"; then echo "ERROR: Patch 3b (install-package-dir) left baseLstat symlink check" >&2; exit 1; fi; \
    else \
        grep -Fq 'if (!(await fs.stat(params.installBaseDir)).isDirectory())' "$ipd_file" \
            || patch_fail "Patch 3b current install-package-dir lacks the reviewed directory stat guard"; \
        grep -Fq 'await fs.realpath(params.installBaseDir) !== params.expectedRealPath' "$ipd_file" \
            || patch_fail "Patch 3b current install-package-dir lacks the reviewed realpath stability guard"; \
        echo "INFO: OpenClaw ${OC_VERSION} install-package-dir already uses stat plus realpath stability; Patch 3b not needed"; \
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

# Patch OpenClaw chat.send gateway behavior: preserve lineage and suppress empty finals.
# Remove when upstream openclaw/openclaw#70164 and #50298 are fixed,
# or when NemoClaw no longer ships an affected OpenClaw version.
# hadolint ignore=DL3059
RUN node /usr/local/lib/nemoclaw/patch-openclaw-chat-send.mts \
    /usr/local/lib/node_modules/openclaw/dist

# Native OpenClaw restart must reload updated ESM plugins in OpenShell sandboxes.
# Remove this bridge when upstream container restart refreshes the module graph.
# hadolint ignore=DL3059
RUN node /usr/local/lib/nemoclaw/patch-openclaw-container-restart.mts \
    /usr/local/lib/node_modules/openclaw/dist

# Keep OpenClaw 2026.9.1 scope-upgrade approvals inside the gateway's
# canonical locked pairing writer (#4462). The upstream devices CLI otherwise
# asks for the very scopes it is trying to approve, so the handshake fails
# before device.pair.approve runs and its operator.admin retry fails likewise.
# This dist patch allows only a signed, device-token-authenticated CLI to
# approve its own complete operator-only request while it already holds
# operator.pairing; the canonical pairing function repeats identity, role, and
# bounded-scope validation after acquiring its state lock.
#
# Removal criteria: drop when upstream OpenClaw supports pairing-only
# self-upgrade and `devices approve` exits after Approved.
# hadolint ignore=DL3059
RUN node /usr/local/lib/nemoclaw/patch-openclaw-device-self-approval.mts \
    /usr/local/lib/node_modules/openclaw/dist \
    && node /usr/local/lib/nemoclaw/patch-openclaw-secondary-main-session-delete.mts \
        /usr/local/lib/node_modules/openclaw/dist

# Patch OpenClaw TUI unreachable-inference diagnostics for #4434.
#
# OpenClaw 2026.9.1 formats sandbox inference egress failures as either generic
# `TypeError: fetch failed` or `LLM request timed out.` messages, which leave the
# TUI without the required HTTP/cause, gateway/upstream reporting layer, and
# recovery hint fields. This version-scoped shim enriches only those reviewed
# formatter paths, and only inside OpenShell sandboxes where
# OPENSHELL_SANDBOX=1 is supplied at runtime.
#
# Removal criteria: drop when upstream OpenClaw emits these structured fields
# from its assistant error formatter for unreachable inference failures.
# hadolint ignore=DL3059
RUN node /usr/local/lib/nemoclaw/patch-openclaw-issue-4434-diagnostics.mts \
    /usr/local/lib/node_modules/openclaw/dist

# Patch OpenClaw's MCP stdio launcher so npx-backed MCP servers run with -y.
# Without this, npx can prompt on cold package resolution and consume the MCP
# JSON-RPC stdin pipe, causing the initialize handshake to time out.
#
# Removal criteria: drop when upstream OpenClaw normalizes npx MCP server args
# and emits actionable MCP startup timeout diagnostics.
# hadolint ignore=DL3059
RUN node /usr/local/lib/nemoclaw/patch-openclaw-mcp-npx.mts \
    /usr/local/lib/node_modules/openclaw/dist

# Recover from a transient remote Streamable HTTP MCP startup failure. OpenClaw
# 2026.9.1 turns one reset or request timeout into an empty tool set plus
# catalog diagnostics, and keeps that degraded catalog for the whole session, so
# the agent reports the integration as unavailable until a new session starts.
# The patch retries a classified transient startup once with a fresh transport
# and drops a diagnostics-carrying catalog at the next agent run. Authentication,
# authorization, TLS, policy, and configuration failures are never retried.
#
# Removal criterion: drop when upstream OpenClaw provides bounded startup retry,
# negative-catalog invalidation, and temporary-transport failure attribution.
# hadolint ignore=DL3059
RUN node /usr/local/lib/nemoclaw/patch-openclaw-mcp-reliability.mts \
    /usr/local/lib/node_modules/openclaw/dist

# Keep OpenClaw's 1,500 ms tools/list catalog timeout by default. A validated
# OpenClaw sandbox runtime setting can override only this discovery budget from
# 1,500 ms through 10,000 ms. Invalid direct runtime values stop OpenClaw before
# it connects to an MCP server.
#
# Removal criterion: drop when upstream OpenClaw exposes an equivalent bounded
# tools/list-only runtime setting.
# hadolint ignore=DL3059
RUN node /usr/local/lib/nemoclaw/patch-openclaw-mcp-tools-list-timeout.mts \
    /usr/local/lib/node_modules/openclaw/dist

# Emit a redacted managed-transport diagnostic when a remote Streamable HTTP MCP
# request fails. OpenClaw 2026.9.1 surfaces only the transport error text, which
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
RUN node /usr/local/lib/nemoclaw/patch-openclaw-managed-transport-diagnostics.mts \
    /usr/local/lib/node_modules/openclaw/dist

# Patch legacy catalogs, and keep OpenClaw 2026.9.1's native catalog compact
# only for managed llama.cpp. Other providers retain upstream behavior.
# hadolint ignore=DL3059
RUN node /usr/local/lib/nemoclaw/patch-openclaw-tool-catalog.mts \
    /usr/local/lib/node_modules/openclaw/dist \
    && node /usr/local/lib/nemoclaw/npm12.mts \
    /usr/local/lib/node_modules/openclaw/dist "$OPENCLAW_VERSION"

# OpenClaw 2026.9.1 moved gateway startup work into shared and per-agent SQLite
# databases, but hardens them to owner-only modes on every open. NemoClaw's
# native lifecycle runs the CLI and gateway as the sandbox identity, so keep
# the retired split-user marker unset and preserve OpenClaw's owner-only modes.
# The patch leaves generic credential and identity store enforcement unchanged,
# avoids redundant chmod calls when a reviewed private database mode already
# matches, keeps generated models files private, and ignores the obsolete
# update-check cache migration that cannot archive through a root-owned parent.
#
# Removal criteria: drop when upstream OpenClaw no longer needs the managed
# runtime permission and legacy-cache compatibility changes.
# hadolint ignore=DL3059
RUN node /usr/local/lib/nemoclaw/patch-openclaw-shared-state-permissions.mts \
    /usr/local/lib/node_modules/openclaw/dist

# Set up blueprint for local resolution.
# Blueprints are immutable at runtime; DAC protection (root ownership) is applied
# later since /sandbox/.nemoclaw is Landlock read_write for plugin state (#804).
RUN mkdir -p /sandbox/.nemoclaw/blueprints/0.1.0 \
    && cp -r /opt/nemoclaw-blueprint/* /sandbox/.nemoclaw/blueprints/0.1.0/

# Copy configuration inputs before the cached non-messaging plugin install.
COPY scripts/generate-openclaw-config.mts /scripts/
COPY scripts/validate-openclaw-tool-search.mts /scripts/
COPY src/lib/extra-agents-validation.ts src/lib/tool-disclosure.ts src/lib/providerless-inference.ts /src/lib/
COPY nemoclaw-blueprint/openclaw-plugins/ /usr/local/share/nemoclaw/openclaw-plugins/

RUN chmod 755 /scripts/generate-openclaw-config.mts \
        /scripts/validate-openclaw-tool-search.mts /src /src/lib \
    && chmod 444 /src/lib/*.ts \
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
# Increase for slow local inference (e.g., CPU Ollama). The host CLI manages
# runtime changes to the mutable OpenClaw config. Ref: issue #2281
ARG NEMOCLAW_AGENT_TIMEOUT=600
# Cadence for OpenClaw's periodic heartbeat
# (agents.defaults.heartbeat.every). Accepts Go-style durations like "30m",
# "5m", "1h"; "0m" disables heartbeat. Empty default preserves the OpenClaw
# built-in cadence. The image value is the initial default; the mutable runtime
# config can be changed through the host CLI. Ref: issue #2880
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
# OpenShell 0.0.116 requires a non-root OCI image user. The entrypoint retains
# its supported same-UID topology when the managed image starts as sandbox.
ARG NEMOCLAW_MANAGED_IMAGE_RUNTIME_USER=sandbox
# Base64-encoded JSON array of secondary OpenClaw agent config entries
# (e.g. [{"id":"research","workspace":"/sandbox/.openclaw/workspace-research",
# "agentDir":"/sandbox/.openclaw/agents/research", ...}]).
# Each entry is written under agents.entries by id alongside the canonical
# "main" entry, so the primary agent always remains the default. See generate-openclaw-config.mts
# for the validator. Default: empty array (W10= == base64("[]")).
ARG NEMOCLAW_EXTRA_AGENTS_JSON_B64=W10=
# Legacy compatibility inputs retained for managed build and rebuild callers.
# OpenClaw 2026.9.1 retired the device-auth bypass, so NemoClaw validates the
# provenance value but does not emit an upstream configuration key for either
# input. Remove these arguments after all external callers have transitioned.
ARG NEMOCLAW_DISABLE_DEVICE_AUTH=0
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
# @openclaw/diagnostics-otel@2026.9.1 exports through OpenTelemetry's OTLP
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

# Preserve the CLI's package-resolution symlink while its .bin wrapper selects
# /usr/local only for 2026.9.1 self-update owner detection. Install this before
# config generation so the late runtime payload copy remains within the reviewed
# post-generator instruction sequence.
COPY scripts/openclaw-cli-wrapper.sh /usr/local/lib/nemoclaw/openclaw-cli-wrapper.sh
RUN rm -f /usr/local/lib/nemoclaw/openclaw-runtime/node_modules/.bin/openclaw \
    && install -o root -g root -m 0755 \
        /usr/local/lib/nemoclaw/openclaw-cli-wrapper.sh \
        /usr/local/lib/nemoclaw/openclaw-runtime/node_modules/.bin/openclaw

WORKDIR /sandbox
RUN test "$(id -u sandbox):$(id -g sandbox):$(pwd)" = "998:998:/sandbox" \
    && chown sandbox:sandbox /sandbox/.bashrc /sandbox/.profile \
    && chmod 644 /sandbox/.bashrc /sandbox/.profile
USER sandbox

# Write openclaw.json with gateway config but WITHOUT the real auth token.
# The gateway auth token is generated at container startup by the entrypoint
# and passed via OPENCLAW_GATEWAY_TOKEN env var only to the gateway process
# (running as 'gateway' user). The token file location depends on startup mode:
#   Root mode:     /run/nemoclaw/gateway-token (gateway:gateway 0400)
#   Non-root mode: $XDG_RUNTIME_DIR/nemoclaw/gateway-token (sandbox:sandbox 0400)
# See: scripts/nemoclaw-start.sh generate_gateway_token()
#
# Config remains mutable at runtime (group-writable sandbox:sandbox).
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
    node /scripts/generate-openclaw-config.mts

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
            node /scripts/generate-openclaw-config.mts; \
        node /scripts/validate-openclaw-tool-search.mts \
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
            "@openclaw/diagnostics-otel@2026.9.1") expected_integrity="$OPENCLAW_DIAGNOSTICS_OTEL_2026_9_1_INTEGRITY"; expected_tarball="https://registry.npmjs.org/@openclaw/diagnostics-otel/-/diagnostics-otel-2026.9.1.tgz"; archive_name="diagnostics-otel-2026.9.1.tgz" ;; \
            "@openclaw/brave-plugin@2026.9.1") expected_integrity="$OPENCLAW_BRAVE_PLUGIN_2026_9_1_INTEGRITY"; expected_tarball="https://registry.npmjs.org/@openclaw/brave-plugin/-/brave-plugin-2026.9.1.tgz"; archive_name="brave-plugin-2026.9.1.tgz" ;; \
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
            node /scripts/lib/reviewed-npm-archive.mts \
                --package-spec "$plugin_spec" --integrity "$expected_integrity" \
                --tarball-url "$expected_tarball" --label "OpenClaw plugin ${plugin_spec}"; \
        fi; \
    }; \
    install_reviewed_openclaw_plugin() { \
        plugin_spec="${1}@${OPENCLAW_VERSION}"; \
        plugin_archive="$(verify_openclaw_plugin_integrity "$plugin_spec")"; \
        plugin_source_root="$(dirname "$plugin_archive")"; \
        plugin_install_archive="$plugin_archive"; \
        NPM_CONFIG_OFFLINE=true NPM_CONFIG_IGNORE_SCRIPTS=true npm_config_ignore_scripts=true \
            openclaw plugins install --force --accept-capabilities "npm-pack:${plugin_install_archive}"; \
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

# Keep the reviewed cache root-owned and immutable. Add messaging source after
# the core install so channel-only changes invalidate only this plugin layer;
# messaging intentionally stays out of openclaw-runtime-payload.
USER root
COPY src/lib/messaging/ /src/lib/messaging/
RUN chmod 755 /src/lib/messaging/applier/build/messaging-build-applier.mts \
    && chmod -R a+rX /src/lib/messaging

# Bake reduced messaging runtime metadata for the entrypoint. The full
# NEMOCLAW_MESSAGING_PLAN_B64 is a build input; OpenShell sandbox create only
# forwards explicit runtime env, so nemoclaw-start reads this generic artifact
# when the env plan is absent.
# hadolint ignore=DL3059
RUN OPENCLAW_VERSION="${OPENCLAW_VERSION}" node /src/lib/messaging/applier/build/messaging-build-applier.mts --agent openclaw --phase runtime-setup
USER sandbox

# Copy the immutable reviewed cache into sandbox-owned temporary storage because
# npm needs writable cache tmp space. Remove it before committing the layer.
# The selected phase keeps exactly one messaging-applier invocation per build.
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
        node /src/lib/messaging/applier/build/messaging-build-applier.mts \
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
    node -e 'const expected={protocol:2,ok:false,count:0,tools:[],truncated:false,detail:"tool discovery received invalid runtime arguments",failedStage:"preflight",failureClass:"precondition"}; const secretPatterns = [/(?:nvapi-|nvcf-|gh[pousr]_|sk-proj-|sk-ant-|hf_|glpat-|gsk_|pypi-|tvly-)[A-Za-z0-9_-]{10,}/gu, /github_pat_[A-Za-z0-9_]{30,}/gu, /sk-[A-Za-z0-9_-]{20,}/gu, /(?:xox[bpas]|xapp)-[A-Za-z0-9-]{10,}/gu, /A(?:K|S)IA[A-Z0-9]{16}/gu, /\bbot\d{8,10}:[A-Za-z0-9_-]{35}\b/gu, /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/gu, /\b[A-Za-z0-9]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b/gu, /lsv2_(?:pt|sk)_[A-Za-z0-9]{10,}(?:_[A-Za-z0-9]+)*/gu, /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{10,}\b/gu, /\b[A-Za-z0-9_=-]{32,}\b/gu]; const redact = (value) => value.replace(/\b(?:Bearer|Basic)\s+\S+/giu, "<REDACTED>").replace(/((?:^|[^A-Za-z0-9])(?:[A-Za-z0-9]{1,128}_(?:KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD|PASSWD|PASS)|(?:X[-_])?API[-_]KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD|PASSWD|PASS)["\x27]?(?:[ \t]{0,32}[=:][ \t]{0,32}|[ \t]{1,32})["\x27]?)[^\s"\x27]+/giu, (_match, prefix) => prefix + "<REDACTED>").replace(/((?:^|[^A-Za-z0-9])(?:[A-Za-z0-9]{1,128}(?:Token|Secret|Credential)|[A-Za-z0-9]{0,128}(?:[Aa]ccess|[Rr]efresh|[Cc]lient|[Bb]earer|[Aa]uth|[Aa][Pp][Ii]|[Pp]rivate|[Ss]igning|[Ss]ession|[Bb]ot|[Aa]pp|[Rr]esolved)Key|[A-Za-z0-9]{1,128}(?:Password|Passwd|Pass))["\x27]?(?:[ \t]{0,32}[=:][ \t]{0,32}|[ \t]{1,32})["\x27]?)[^\s"\x27]+/gu, (_match, prefix) => prefix + "<REDACTED>").replace(/((?:^|[^A-Za-z0-9])KEY["\x27]?(?:[ \t]{0,32}[=:][ \t]{0,32}|[ \t]{1,32})["\x27]?)[^\s"\x27]+/gu, (_match, prefix) => prefix + "<REDACTED>"); const sanitize = (value) => { if (value === undefined) return "<missing>"; if (value === null || typeof value === "boolean" || typeof value === "number") return value; if (typeof value !== "string") return "<" + (Array.isArray(value) ? "array" : typeof value) + ">"; let text = value.replace(/-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*/gu, "<REDACTED>").replace(/[^\x20-\x7e]/gu, "?"); for (const pattern of secretPatterns) text = text.replace(pattern, "<REDACTED>"); text = redact(text); return text.length <= 240 ? text : text.slice(0, 237) + "..."; }; let result; let parsed = true; try { result = JSON.parse(process.argv[1]); } catch { parsed = false; } const record = parsed && result !== null && typeof result === "object" && !Array.isArray(result) ? result : undefined; if(record&&Object.keys(record).length===8&&Object.keys(expected).every(k=>k==="tools"?Array.isArray(record[k])&&!record[k].length:record[k]===expected[k]))process.exit(0); const actual = record ? Object.fromEntries(Object.keys(expected).map(k=>[k,sanitize(record[k])])) : parsed ? { type: result === null ? "null" : Array.isArray(result) ? "array" : typeof result, value: sanitize(result) } : { type: "invalid-json", preview: sanitize(process.argv[1]) }; console.error("ERROR: managed image assertion failed: mcp-tool-discovery-json-contract actual=%s expected=%s", JSON.stringify(actual), JSON.stringify(expected)); process.exit(1);' "$discovery_contract" \
      || exit 1; \
    discovery_unsafe="$(find -L /usr/local/lib/nemoclaw/mcp-tool-discovery-runtime \( ! -user root -o -perm /022 \) -print -quit)" \
      || managed_image_command_failed mcp-tool-discovery-tree-find-execution "$?"; \
    { test -z "$discovery_unsafe" || managed_runtime_assertion_failed mcp-tool-discovery-tree-safety "$discovery_unsafe" dereference; } \
    && { test -f /usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs || managed_runtime_assertion_failed regular-file /usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs; } \
    && { test ! -L /usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs || managed_runtime_assertion_failed non-symlink /usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs; } \
    && { chown root:root /usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs 2>/dev/null || managed_runtime_assertion_failed owner-root-root /usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs; } \
    && { chmod 0444 /usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs 2>/dev/null || managed_runtime_assertion_failed mode-0444 /usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs; } \
    && { test "$(stat -c '%u:%g:%a' /usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs 2>/dev/null)" = '0:0:444' || managed_runtime_assertion_failed metadata-0:0:444 /usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs; } \
    && install -d -o root -g root -m 0755 /run/nemoclaw

# Copy startup script and shared sandbox initialisation library.
RUN chmod 755 /usr/local/bin/nemoclaw-start /usr/local/bin/nemoclaw-codex-acp \
        /usr/local/bin/nemoclaw-managed-startup-hold \
        /usr/local/lib/nemoclaw/sandbox-init.sh \
        /scripts/generate-openclaw-config.mts \
        /scripts/validate-openclaw-tool-search.mts /src /src/lib \
    && chmod 444 /src/lib/*.ts \
        /usr/local/lib/nemoclaw/entrypoint-env-wrapper.sh \
    && chown root:root /usr/local/lib/nemoclaw/openclaw-config-guard.py \
    && chmod 444 /usr/local/lib/nemoclaw/entrypoint-env-wrapper.sh \
        /usr/local/lib/nemoclaw/sandbox-rlimits.sh \
    && chmod 644 /usr/local/lib/nemoclaw/openclaw_device_approval_policy.py \
        /usr/local/lib/nemoclaw/openclaw_pairing_state.py \
    && chmod 555 /usr/local/lib/nemoclaw/openclaw-config-guard.py \
        /usr/local/lib/nemoclaw/normalize_mutable_config_perms.py \
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
    openclaw plugins install --force --accept-capabilities /opt/nemoclaw \
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
RUN OPENCLAW_VERSION="${OPENCLAW_VERSION}" node /src/lib/messaging/applier/build/messaging-build-applier.mts --agent openclaw --phase post-agent-install

# A managed image is a neutral capability carrier, not an all-channels-enabled
# deployment. Regenerate after every optional plugin is installed so OpenClaw's
# install registry survives while every optional plugin/channel remains inert.
# Validate the generated file through the pinned OpenClaw CLI.
# hadolint ignore=DL3059,DL4006,SC2016
RUN if [ "$NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION" = "1" ]; then \
        node /scripts/generate-openclaw-config.mts; \
        validation="$(openclaw config validate --json)"; \
        node -e 'const result=JSON.parse(process.argv[1]); if (result.valid !== true) process.exit(1)' "$validation"; \
        node -e 'const fs=require("node:fs"), path=require("node:path"); const config=JSON.parse(fs.readFileSync("/sandbox/.openclaw/openclaw.json", "utf8")); const root="/usr/local/lib/node_modules/openclaw/dist/extensions"; const bundled=fs.readdirSync(root, {withFileTypes:true}).filter((entry)=>entry.isDirectory()).map((entry)=>entry.name).flatMap((id)=>{ const packagePath=path.join(root, id, "package.json"); if (!fs.existsSync(packagePath)) return []; const packageManifest=JSON.parse(fs.readFileSync(packagePath, "utf8")); if (!packageManifest.openclaw?.channel?.id) return []; const pluginManifest=JSON.parse(fs.readFileSync(path.join(root, id, "openclaw.plugin.json"), "utf8")); return [{channelId:packageManifest.openclaw.channel.id, pluginId:pluginManifest.id}]; }); const expected=["a2a","reef","telegram"]; if (bundled.length !== expected.length || expected.some((channelId)=>!bundled.some((entry)=>entry.channelId === channelId))) throw new Error(`unexpected bundled OpenClaw channel inventory: ${bundled.map(({channelId})=>channelId).join(",")}`); for (const {channelId, pluginId} of bundled) { if (config.plugins?.entries?.[pluginId]?.enabled !== false || config.channels?.[channelId]?.enabled !== false) throw new Error(`bundled OpenClaw channel is not neutral: ${channelId}`); }'; \
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
        for entry in "$data_dir"/* "$data_dir"/.[!.]* "$data_dir"/..?*; do \
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
                nested_link="$(find -P "$entry" -type l -print -quit)"; \
                if [ -n "$nested_link" ]; then \
                    echo "ERROR: refusing legacy layout cleanup because $nested_link is a symlink" >&2; \
                    exit 1; \
                fi; \
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
    [ ! -e "$exec_approvals" ] || [ ! -s "$exec_approvals" ] \
        || { echo "ERROR: refusing populated legacy OpenClaw exec approvals: $exec_approvals" >&2; exit 1; }; \
    rm -f "$exec_approvals"; \
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
# replacing root-owned entries. Only state/, migration/, snapshots/, staging/,
# and config.json are sandbox-owned for runtime writes.
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
    && check_metadata /usr/local/lib/nemoclaw/npm12.mts 'root:root:755' \
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
# nemoclaw-start records `pid starttime` for the gateway process in
# /tmp/nemoclaw-gateway.pid on every launch.  When curl sees connection
# refused, validate both values against `/proc/<pid>/stat` field 22 before
# accepting the OpenClaw gateway cmdline fallback.  A numeric PID or
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
        "nemoclaw-python3.13-htmlparser-fix=3.13.5-2+deb13u5+nemoclaw1" \
        "perl-base=5.44.0-1nemoclaw1" \
        "perl=5.44.0-1nemoclaw1" \
        "libevent-core-2.1-7t64=2.1.13-stable-1" \
        | cmp -s - "$security_inventory"; \
    test "$(dpkg-query -W -f='${Version}' libexpat1)" = "2.8.3-1"; \
    test "$(dpkg-query -W -f='${Version}' libonig5)" = "6.9.9-1+b1"; \
    test "$(dpkg-query -W -f='${Version}' libjq1)" = "1.8.2-1"; \
    test "$(dpkg-query -W -f='${Version}' jq)" = "1.8.2-1"; \
    test "$(dpkg-query -W -f='${Version}' vim-common)" = "2:9.2.0858-1"; \
    test "$(dpkg-query -W -f='${Version}' vim-tiny)" = "2:9.2.0858-1"; \
    test "$(dpkg-query -W -f='${Version}' libssh2-1t64)" = "1.11.1-1+deb13u1+nemoclaw2"; \
    test "$(dpkg-query -W -f='${Version}' libssl3t64)" = "3.5.7-1~deb13u2"; \
    test "$(dpkg-query -W -f='${Version}' nemoclaw-python3.13-htmlparser-fix)" = "3.13.5-2+deb13u5+nemoclaw1"; \
    test "$(dpkg-query -W -f='${Version}' perl-base)" = "5.44.0-1nemoclaw1"; \
    test "$(dpkg-query -W -f='${Version}' perl)" = "5.44.0-1nemoclaw1"; \
    test "$(dpkg-query -W -f='${Version}' libevent-core-2.1-7t64)" = "2.1.13-stable-1"; \
    test "$(perl -e 'print $^V')" = "v5.44.0"; \
    ldd /usr/bin/jq | grep -Eq 'libonig[.]so[.]5'; \
    test "$(tmux -V)" = "tmux 3.5a"; \
    ldd /usr/bin/tmux | grep -Eq 'libevent_core-2[.]1[.]so[.]7'; \
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

# OpenShell 0.0.116 rejects managed images whose OCI default selects root.
USER ${NEMOCLAW_MANAGED_IMAGE_RUNTIME_USER}
ENTRYPOINT ["/usr/local/bin/nemoclaw-start"]
CMD ["/bin/bash"]
