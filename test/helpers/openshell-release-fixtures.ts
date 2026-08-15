// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const V00101_SANDBOX_BUILD_DIGESTS = [
  "a2704babbb468fd0a359bfdd9844de71095b730758541b4ca8cbab77d4018920",
  "88300e35f153123e4dc3021c537834dd6c0a09665a4a6d3974cd285d512345c4",
] as const;
export const V00103_SANDBOX_BUILD_DIGESTS = [
  "412dc28fa288938373aca0a95c6be3f890066c377992bb75b3ca078d92dbef00",
  "fc1454705fad9cc0890297a84d2b7869670a364d01d5398685e3c987d2b6c123",
] as const;
export const V00103_SUPERVISOR_MANIFEST_DIGEST =
  "sha256:96228f110362ffd415bb12d3b7f584063c3c52c0c93f3ccf59faada1dc2dd5d3";

export const V0099_CHECKSUM_MANIFESTS = new Map([
  [
    "openshell-checksums-sha256.txt",
    `35725a358e42ef7f0f0393035536da317706b0febcc459a2011e0555f6c2b71c  openshell-x86_64-unknown-linux-musl.tar.gz
d00cbf0d8779c01ddea6453ead2ad4db3d89a1f14eb6f0785f7919f42813a279  openshell-aarch64-unknown-linux-musl.tar.gz
e31cac5360e2adf3c971d5742a516626c58acf2fd3db4dcb0e45804def3dc844  openshell-aarch64-apple-darwin.tar.gz
6f1f0a7a524850edddba52aa233eb53233ad77b9b85a8eee1bdd004e2ace8b6e  openshell-driver-vm-x86_64-unknown-linux-gnu.tar.gz
4cb1dba9f29fec3111a7858f1bb4f9344d321ce7aa080c6e4ab0e69e8f2761fa  openshell-driver-vm-aarch64-unknown-linux-gnu.tar.gz
195f865d304518cbf2270bf7d54326390fd0755692a2856ae7c5e7a9f6e38a99  openshell-driver-vm-aarch64-apple-darwin.tar.gz
0d22a9cac0ca7d080c95ea032df81af382d8889149d959f5c547cf00c05a5918  openshell_0.0.99-1_amd64.deb
33a9031a57f006e1ed4c0b409aa07a0b4246ee655eec51e74dc872b5f2ec7cc6  openshell_0.0.99-1_arm64.deb
91e2fc11e09eb4bc4c52e2d512b10224f5e025bda7366c313739bc8301108125  openshell-0.0.99-1.fc44.aarch64.rpm
5625914d36939bb02a0e1b6564067c1fc4efd429145ffc4691edbe1ca13dc490  openshell-0.0.99-1.fc44.x86_64.rpm
68aa1f07b36ff10cdce89b3d6b75f0ebaeac1d063e382d7d234488ec4533ab06  openshell-gateway-0.0.99-1.fc44.aarch64.rpm
f91ed9de71e51c6365e5c934225833b9d8a4cd3b62da8060919fc7993fe7d6b9  openshell-gateway-0.0.99-1.fc44.x86_64.rpm
f7db8eb284fa0815c0ab375016def8524873ee033049940f071ffef4d0c1a61e  openshell-0.0.99-py3-none-macosx_13_0_arm64.whl
b06e062563201d4f98a87e8de23e10e40733b548e12891623982ca5b120bccf2  openshell-0.0.99-py3-none-manylinux_2_39_aarch64.whl
72f8f14c304f5da233755ae285ee8c4c19aaf7fb7b40b14f6c6b17ef9752141f  openshell-0.0.99-py3-none-manylinux_2_39_x86_64.whl
`,
  ],
  [
    "openshell-gateway-checksums-sha256.txt",
    `640d204dc3c6bc28bffa1f3d870897fc23bbc5ec0151a6c642083e958455cb49  openshell-gateway-x86_64-unknown-linux-gnu.tar.gz
3a5d3092ae34356beb0ff2a920f9a87af4233c7a1086a53cd9429d48358f5c09  openshell-gateway-aarch64-unknown-linux-gnu.tar.gz
4340619292ecb565f90eb2250db504baa37dd410361b366b42e174d34512cb6c  openshell-gateway-aarch64-apple-darwin.tar.gz
`,
  ],
  [
    "openshell-sandbox-checksums-sha256.txt",
    `84caed3dec4390e0938e89b38b1256d31e8970b4bfd85437bf92ed79f5b1ff05  openshell-sandbox-x86_64-unknown-linux-gnu.tar.gz
c758e7dc2b8c904baa01e2ccce0f08daf96ede0c648478b23346d8c4dd16f432  openshell-sandbox-aarch64-unknown-linux-gnu.tar.gz
`,
  ],
]);
export const V0099_ASSET_DIGESTS = new Map([
  ...[...V0099_CHECKSUM_MANIFESTS.values()].flatMap((contents) =>
    contents
      .trim()
      .split("\n")
      .map((line) => {
        const [digest, asset] = line.split(/\s+/);
        return [asset, digest] as const;
      }),
  ),
  ["openshell.rb", "8dd34fc17ee9a30327664a18c9509c8a765cb010de38cda8e22841bddbe92713"],
]);

export const V00101_CHECKSUM_MANIFESTS = new Map([
  [
    "openshell-checksums-sha256.txt",
    `7d49ab2a5ff0b826bd2bdca5e0244010f832dfc6901c808ea8c8467004c26913  openshell-x86_64-unknown-linux-musl.tar.gz
b553d3bfc08e9354b990a10fb8abd976e039afeec2d3947f8a112018be40d296  openshell-aarch64-unknown-linux-musl.tar.gz
9daaccdb9e30e220d56dd6d6bf4bd00ccca8ae4ad2845f5f0d9b9da3eb8ee881  openshell-aarch64-apple-darwin.tar.gz
087c261d1594aace6f179710f07406bc03163aa37f1c87b8290eeb21ee81352f  openshell-driver-vm-x86_64-unknown-linux-gnu.tar.gz
670039e6f973e35f7eac98b1e34ffdcdfcda7f094019bdec02007b4c0eaa0a43  openshell-driver-vm-aarch64-unknown-linux-gnu.tar.gz
a7bf38218aa6c85ed73217b501f9fa44c32861fd48aa4a9141aa1fe478b7dc5b  openshell-driver-vm-aarch64-apple-darwin.tar.gz
4b8e3deb2d3a4ec7b6fd05fbeaee58dfafc670a629077c3d80e85882211abddd  openshell_0.0.101-1_amd64.deb
0087dab1206c8dbdec455ae65434b881033757b2a094ecf3a6f416c81057aeee  openshell_0.0.101-1_arm64.deb
49be637bf2792910ae6f551f770de44ed869d10f28363236de0a96e4d093213b  openshell-0.0.101-1.fc44.aarch64.rpm
e77a96379dce740b11bbec969cc4c9ba6959129af21673346978d5ed20fa3127  openshell-0.0.101-1.fc44.x86_64.rpm
5fa81231f790de65b61421c96b3bd8ebdc8dff5cb1915bfbfdd20b9f26f8d3f4  openshell-gateway-0.0.101-1.fc44.aarch64.rpm
45b7e3d1909e25db7324a9569e9fc3f372e43045a2fd2bc8df6d780e00b21161  openshell-gateway-0.0.101-1.fc44.x86_64.rpm
a05a7379d6d7f329c3e3fd109af85a9b61184173dd41589e48e2dfff9c02a3d0  openshell-0.0.101-py3-none-macosx_13_0_arm64.whl
8c86d18a23ade9650d1c616ada7c3f2df28ed839e9fdc29368d2573064a63a7d  openshell-0.0.101-py3-none-manylinux_2_39_aarch64.whl
ae36a8001bceb7366f184b7b69d0d9d7f7b3a6b95d952d616ece4ff229fc0dcd  openshell-0.0.101-py3-none-manylinux_2_39_x86_64.whl
`,
  ],
  [
    "openshell-gateway-checksums-sha256.txt",
    `eaeb094ccf7dcb1fe00c7e926e6aa9aaaefb89ecbef8343720628b0fd2d84654  openshell-gateway-x86_64-unknown-linux-gnu.tar.gz
ac842ccc2ab8b5682f7479d71532cc650839250a8a41dbfae2b871cbbdfd3279  openshell-gateway-aarch64-unknown-linux-gnu.tar.gz
0f9e195b7cde57f4c2080df95159c5e7e72b0248306abc242ae00a3bb6f07f14  openshell-gateway-aarch64-apple-darwin.tar.gz
`,
  ],
  [
    "openshell-sandbox-checksums-sha256.txt",
    `953b90eaa7d2fc1bb7bdf38eb0ada6fad7902b13f9f895ca20b89caeac483a9e  openshell-sandbox-x86_64-unknown-linux-gnu.tar.gz
c39b7ba3cf212b88712a00d2a0e3d28e2c1e0e9f47a9a6ca818a8f06ed2140aa  openshell-sandbox-aarch64-unknown-linux-gnu.tar.gz
`,
  ],
]);
export const V00101_ASSET_DIGESTS = new Map([
  ...[...V00101_CHECKSUM_MANIFESTS.values()].flatMap((contents) =>
    contents
      .trim()
      .split("\n")
      .map((line) => {
        const [digest, asset] = line.split(/\s+/);
        return [asset, digest] as const;
      }),
  ),
  ["openshell.rb", "87fadc7b0c854aa44f71d5b3a206865070117cd27825d59c61da252a99f402a2"],
]);

export const V00103_CHECKSUM_MANIFESTS = new Map([
  [
    "openshell-checksums-sha256.txt",
    `e905c93c1b6fc84d69478df3859ebc3b765cef70c7567c19f4f9226c1eb94024  openshell-x86_64-unknown-linux-musl.tar.gz
d88309999601fd7e9fcd3cfc2bb6e18c109f0f373798e4b87bc65ab9818002d1  openshell-aarch64-unknown-linux-musl.tar.gz
1fe7b45f07fded02c6fa28906486fecb54241668203b05b2e79c061c67a73180  openshell-aarch64-apple-darwin.tar.gz
eb9cfd7c9df4ab1e29d25ca7d0dfee64cc478bd413437eaab129bfd080879ecb  openshell-driver-vm-x86_64-unknown-linux-gnu.tar.gz
b427067326f00fb717f40291e82cfc196c74100913e9cf5fc5c894ed589acc3a  openshell-driver-vm-aarch64-unknown-linux-gnu.tar.gz
8328d30e7dcdf83ca7a2996c5690a4ad08a7f0e712e1c8c262e904b0bf6f9cbf  openshell-driver-vm-aarch64-apple-darwin.tar.gz
4a585734a14c5e79faa95c8b59f2cc0170706249fac88f2d9c8c15ea1276e235  openshell_0.0.103-1_amd64.deb
5252f34fc743830fb5d9f7d8b2fec010a89be3f0f202b97e4299300c95e03ac7  openshell_0.0.103-1_arm64.deb
1d37f5e73de72cb133e68139f7e8db95a88dbe3ef7d0a04f55b55fecb4262987  openshell-0.0.103-1.fc44.aarch64.rpm
69347db1e25eacd897ea96370b539fbf4104417cc23e72d5bff87e524031db2b  openshell-0.0.103-1.fc44.x86_64.rpm
fcbede4202f98438b395c282144f696486a98545ba7256a74dcc31cff79a60bd  openshell-gateway-0.0.103-1.fc44.aarch64.rpm
ee61aabb17c9139adb019ab5b9d7dcd74e1efe72769c7db40c1feaae15307bbf  openshell-gateway-0.0.103-1.fc44.x86_64.rpm
d1c467a0c6925385c415fb8856a3c9ec627b7e51b711c6b33cfea51d718d965d  openshell-0.0.103-py3-none-macosx_13_0_arm64.whl
b623addf09fea656f66306201877c5259fd7a20aaa9a15a704ee97a669535cd6  openshell-0.0.103-py3-none-manylinux_2_39_aarch64.whl
b0e961425bcdfed930967efd89f806e24142436c34a30234d4dc888f92fec8d0  openshell-0.0.103-py3-none-manylinux_2_39_x86_64.whl
`,
  ],
  [
    "openshell-gateway-checksums-sha256.txt",
    `49c1f39c34874f2a4e30809019b0d59ab521071dcd2996159b25157ebd4ec7f8  openshell-gateway-x86_64-unknown-linux-gnu.tar.gz
86e2b399b61eeadebe008116a04dd57302a4f866c26aef394a1ac7de0b0aba67  openshell-gateway-aarch64-unknown-linux-gnu.tar.gz
4da140b1ba5f953c1df277f462d945c4bf3693cbd21b8a5e3c59d40e967118a2  openshell-gateway-aarch64-apple-darwin.tar.gz
`,
  ],
  [
    "openshell-sandbox-checksums-sha256.txt",
    `54743edb4396de208c93d27fda0c13b3bdc3566b9f48e80b8e0a55a318000491  openshell-sandbox-x86_64-unknown-linux-gnu.tar.gz
cada3390f88507184b875c574f7e9b2b1f99735e00bef82ddaaa76fcfd843e73  openshell-sandbox-aarch64-unknown-linux-gnu.tar.gz
`,
  ],
]);
export const V00103_ASSET_DIGESTS = new Map([
  ...[...V00103_CHECKSUM_MANIFESTS.values()].flatMap((contents) =>
    contents
      .trim()
      .split("\n")
      .map((line) => {
        const [digest, asset] = line.split(/\s+/);
        return [asset, digest] as const;
      }),
  ),
  ["openshell.rb", "95a290f0e0e2f57d7d46ba9171fca6e99e5226875cd12e12391b7338f6c219f9"],
]);
