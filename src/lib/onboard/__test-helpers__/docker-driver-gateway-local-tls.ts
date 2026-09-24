// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { getDockerDriverGatewayLocalTlsBundle } from "../docker-driver-gateway-local-tls";

const TEST_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDSDCCAjCgAwIBAgIUBpjeCY46iq7RCJIJJRARHcI2jUkwDQYJKoZIhvcNAQEL
BQAwGDEWMBQGA1UEAwwNbmVtb2NsYXctdGVzdDAeFw0yNjA2MjYyMDQzNDdaFw0z
NjA2MjMyMDQzNDdaMBgxFjAUBgNVBAMMDW5lbW9jbGF3LXRlc3QwggEiMA0GCSqG
SIb3DQEBAQUAA4IBDwAwggEKAoIBAQCNNYxZ+eNXrah+l9KkvH+frUAZFA+WY5Mp
EM2ghtxP5r9CE4izEdKRdk+bq85mVW17M9u+vLA0F0FmFRzAGV74qW+DJgbbefxR
J6tcowGACoAbNBvELpkQpDBqeLtQdtcSK92RLiRCmP94m21xTkF77Kvg2HeddvUn
SZJ+SgBscgNVo1Hdf85YMVwxg51n0bhtZmk2WXnAbqCj/Zmka6lKbhomcMaPKuDV
bz+VKy+9xPK+/sio9wsdFQ9X6Z6liUwID9Z2hjneZXfYycUGTSddcBuqe2s61MZA
ntQCzsnwzJxgl1BBZ/FbE4eCO0QL1mPc9wDkD2299nrtZ9gsQYLXAgMBAAGjgYkw
gYYwHQYDVR0OBBYEFPIKiGBTsTkY0/DkeDxK9zcBbctYMB8GA1UdIwQYMBaAFPIK
iGBTsTkY0/DkeDxK9zcBbctYMA8GA1UdEwEB/wQFMAMBAf8wMwYDVR0RBCwwKoIX
aG9zdC5vcGVuc2hlbGwuaW50ZXJuYWyCCWxvY2FsaG9zdIcEfwAAATANBgkqhkiG
9w0BAQsFAAOCAQEAfoS+BKlCJNVovT3TMrhiBUhIAtYbBBESp3a2W/vgiV2hZO8o
UDY8lt8Pa2BuU3bwLBnMpr3iChdKLJ70KofqJAgRS6lEgkTXejfoRETuHngqIB5F
Kwz7iSdNmbMNaSaG0JsBpsmTLdkoXVbCoburV534yG0VLDSdGy0dEklxRP2OEQ1s
eyP7541jrt1kFMyPWQ/SaLmFYYCKtYGe1PtKYw0HJf4UQGbNJC8TRZ9KyqfcSdMr
8gMJ6LlArc4hplBJV19dbQJmMpWfQZFpzOzV1lK46YAJSlaUGKzoreaGs4GzHYHD
vTUDCPebEbi9VRlMpX9j7ti+yqqFitz/42+JeA==
-----END CERTIFICATE-----
`;

const TEST_KEY_LABEL = "PRIVATE " + "KEY";
const TEST_KEY_PEM = [
  `-----BEGIN ${TEST_KEY_LABEL}-----`,
  "MIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQCNNYxZ+eNXrah+",
  "l9KkvH+frUAZFA+WY5MpEM2ghtxP5r9CE4izEdKRdk+bq85mVW17M9u+vLA0F0Fm",
  "FRzAGV74qW+DJgbbefxRJ6tcowGACoAbNBvELpkQpDBqeLtQdtcSK92RLiRCmP94",
  "m21xTkF77Kvg2HeddvUnSZJ+SgBscgNVo1Hdf85YMVwxg51n0bhtZmk2WXnAbqCj",
  "/Zmka6lKbhomcMaPKuDVbz+VKy+9xPK+/sio9wsdFQ9X6Z6liUwID9Z2hjneZXfY",
  "ycUGTSddcBuqe2s61MZAntQCzsnwzJxgl1BBZ/FbE4eCO0QL1mPc9wDkD2299nrt",
  "Z9gsQYLXAgMBAAECggEAQzZLucABgAg+fRMSxiqarIwwSD+OM8ztjMxcs529W6K/",
  "Qlo95M4E5gvkVHpwYbEjzVKfs6foTsMK8+X0q1LoK3+qfkgpV2o2uQIixJMp8aIN",
  "2+Tvmm97l7ou+V7B+ci3EgUjDylhRPnCD8wbSaUv8iZyoTEnriGjCrIwMkBS90qQ",
  "VbNd3oIyl/CgK5KSgHdyx8Zg8HXs/49pd4J77TgEqP5EBM4y8NI60iEzEWqgocY/",
  "KnotfPcBBSwfFJ7R0hqYGdy+x7mjxlW8IRDL86R+/EfFgi1+DkhF6xjtvhcw9Hqf",
  "dRrMnEDTQrQF0K53X5UIHXNSDeZsl11mAPZS4GryIQKBgQDCQlkbpBITTPrKqqaQ",
  "j4QEVRLbK/H4Fc52L9Upag4dNrmpGDPL0pHQIhUDVpgBh0oMt+7xTGuspYu+/UMW",
  "DX85V+YcoGn2394lcTsaXrLOtsm8c2EEjrqv/wjbITxyVxIpUj+OpEhzfnEG8Squ",
  "z7NFP9wmL43iOOZNtN+FSr7FmQKBgQC6FtqjEAzEfy4p9OBhqTKLpHAsib+3dR1T",
  "es5IvWCzFVauDjQeR6BW3W+xugGcDE6KsonG200YvcbDfPSTYufdouCqH/ehjViB",
  "zMVuCU7r597eXtC8WiWj7O9WGdh31tKPrunBhecVLlSIxICJ08LO48ki0MyAQwxs",
  "U9NI/nLx7wKBgQC29P4vxksv2mSp1CekJ0bTPbzQp4bxfLhDH7HHm5dHdG9QDvdZ",
  "lCy4tiDMUBZB+kWHzQRCRxNyO0huzOEOOBAG1f5oH70tQpNa+FYN8/q8LfO6hYBu",
  "Zm71q2GP4LGpjtAQEuLBWYDTJdcWDrWAhyX0pryVSlx7H9Pog92xEEC0oQKBgQCE",
  "hpwkftyo3+4vgS5/PrE5k90zStKXQ7ej6RSZ5wzD3RGDGahyXA5Lbp4KE27sBDO3",
  "QRkv3qRUV2sDc6z2ffyk8kdPwT5o9jGvFvcPu19SUCp/cUT0rrqZuLZmOjfYeMwx",
  "+Z6N7N+6TOl1EYR9I6tcDgsDWXIaciWZzETveg7ATwKBgQCpeLMdb0ChKj4NaZmp",
  "x+WjgREJCp6/RapH3l4HIpADjByZIBlOZRBfJjhEm19HbvLIRep42F9+Qh0HCHbU",
  "5Sh6Odw+MzFyF27Kqatrt5jZKFQqAeT0wLDE/+MhG3XoEJKOqfDMJNKNRsIQa50c",
  "NKQ/hhZnPYQ4uv8naNDfKfk8bw==",
  `-----END ${TEST_KEY_LABEL}-----`,
  "",
].join("\n");

export function writeCompleteDockerDriverGatewayLocalTlsBundle(stateDir: string): void {
  const bundle = getDockerDriverGatewayLocalTlsBundle(stateDir);
  const contents = {
    [bundle.caPath]: TEST_CERT_PEM,
    [bundle.serverCertPath]: TEST_CERT_PEM,
    [bundle.serverKeyPath]: TEST_KEY_PEM,
    [bundle.clientCertPath]: TEST_CERT_PEM,
    [bundle.clientKeyPath]: TEST_KEY_PEM,
  };
  for (const [filePath, content] of Object.entries(contents)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
}
