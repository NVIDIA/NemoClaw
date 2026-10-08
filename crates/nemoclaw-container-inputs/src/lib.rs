// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Fixed setup protocol. Secret-bearing requests deliberately implement no Debug.
use serde::{Deserialize, Serialize};
pub const CONTRACT_LABEL: &str = "io.nemoclaw.container-inputs";
pub const CONTRACT_VERSION: &str = "1";
pub const ROOT: &str = "/input-data";
pub const MARKER: &str = ".nemoclaw-inputs";
pub const ENTRYPOINT: &str = "/usr/local/bin/nemoclaw-container-inputs";
pub const MAX_REQUEST_BYTES: usize = 1 << 20;
pub const MAX_CREDENTIAL_BYTES: usize = 4096;
pub const MAX_DESCRIPTOR_BYTES: usize = 64 << 10;
pub type Result<T> = std::result::Result<T, &'static str>;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub uid: u32,
    pub gid: u32,
    pub completion: Completion,
    pub files: Vec<InputFile>,
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Completion {
    pub revision: String,
    pub sandbox_id: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InputFile {
    pub path: String,
    pub role: Role,
    pub content: String,
}
#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Role {
    Credential,
    Descriptor,
}

pub fn credential(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_CREDENTIAL_BYTES
        && value.bytes().all(|b| (0x21..=0x7e).contains(&b))
}
pub fn relative_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 512
        && path.split('/').all(|part| {
            !part.is_empty()
                && part.len() <= 128
                && part.as_bytes()[0].is_ascii_alphanumeric()
                && part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        })
}
impl Request {
    pub fn validate(&self) -> Result<()> {
        let invalid = "protected input request is invalid";
        if self.uid == 0
            || self.gid == 0
            || self.uid > 999_999_999
            || self.gid > 999_999_999
            || self.files.is_empty()
            || self.files.len() > 17
            || self.completion.revision.len() != 64
            || !self
                .completion
                .revision
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
            || !(self.completion.sandbox_id == "none"
                || (self.completion.sandbox_id.len() == 36
                    && self
                        .completion
                        .sandbox_id
                        .bytes()
                        .enumerate()
                        .all(|(i, b)| {
                            if [8, 13, 18, 23].contains(&i) {
                                b == b'-'
                            } else {
                                b.is_ascii_hexdigit() && !b.is_ascii_uppercase()
                            }
                        })))
        {
            return Err(invalid);
        }
        let mut paths = std::collections::BTreeSet::new();
        let mut credentials = 0;
        let mut descriptors = 0;
        for file in &self.files {
            if !relative_path(&file.path) || !paths.insert(file.path.as_str()) {
                return Err(invalid);
            }
            match file.role {
                Role::Credential => {
                    credentials += 1;
                    if !credential(&file.content) {
                        return Err(invalid);
                    }
                }
                Role::Descriptor => {
                    descriptors += 1;
                    if file.content.len() > MAX_DESCRIPTOR_BYTES
                        || !serde_json::from_str::<serde_json::Value>(&file.content)
                            .is_ok_and(|v| v.is_object())
                    {
                        return Err(invalid);
                    }
                }
            }
        }
        if credentials > 16
            || descriptors > 1
            || paths.iter().any(|path| {
                paths
                    .iter()
                    .any(|other| other != path && other.starts_with(&format!("{path}/")))
            })
        {
            return Err(invalid);
        }
        Ok(())
    }
    pub fn completion_bytes(&self) -> Vec<u8> {
        serde_json::to_vec(&self.completion).expect("nonsecret completion metadata")
    }
}
pub fn parse(bytes: &[u8]) -> Result<Request> {
    if bytes.len() > MAX_REQUEST_BYTES {
        return Err("protected input request is invalid");
    }
    let request: Request =
        serde_json::from_slice(bytes).map_err(|_| "protected input request is invalid")?;
    request.validate()?;
    Ok(request)
}

#[cfg(unix)]
mod filesystem;
#[cfg(target_os = "linux")]
pub fn run(uid: u32, gid: u32) -> Result<()> {
    filesystem::run(std::path::Path::new(ROOT), uid, gid)
}
#[cfg(not(target_os = "linux"))]
pub fn run(_: u32, _: u32) -> Result<()> {
    Err("protected input setup requires Linux")
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> Request {
        Request {
            uid: 65532,
            gid: 65532,
            completion: Completion {
                revision: "a".repeat(64),
                sandbox_id: "none".into(),
            },
            files: vec![InputFile {
                path: "credentials/key".into(),
                role: Role::Credential,
                content: "test-only-token".into(),
            }],
        }
    }
    #[test]
    fn canonical_request_accepts_nonroot_identity_and_bounded_token() {
        let bytes = serde_json::to_vec(&request()).unwrap();
        let parsed = parse(&bytes).unwrap();
        assert_eq!(parsed.uid, 65532);
        assert_eq!(parsed.files[0].path, "credentials/key");
    }
    #[test]
    fn request_errors_never_include_protected_content() {
        let mut value = request();
        value.files[0].path = "../escaped".into();
        let bytes = serde_json::to_vec(&value).unwrap();
        assert_eq!(
            parse(&bytes).err(),
            Some("protected input request is invalid")
        );
    }

    #[test]
    fn malformed_paths_tokens_roles_counts_and_duplicate_fields_are_rejected() {
        for path in [
            "../escape",
            "/absolute",
            "x//key",
            "x/./key",
            "x/../key",
            ".nemoclaw-inputs",
            "x/.hidden",
            "x/key/",
        ] {
            let mut value = request();
            value.files[0].path = path.into();
            assert!(parse(&serde_json::to_vec(&value).unwrap()).is_err());
        }
        for token in ["", "header\r\nbreak", "spaces are not tokens", "unicode-雪"] {
            let mut value = request();
            value.files[0].content = token.into();
            assert!(parse(&serde_json::to_vec(&value).unwrap()).is_err());
        }
        let mut value = request();
        value.uid = 0;
        assert!(parse(&serde_json::to_vec(&value).unwrap()).is_err());
        let mut value = request();
        value.files.push(InputFile {
            path: "credentials".into(),
            role: Role::Credential,
            content: "test".into(),
        });
        assert!(parse(&serde_json::to_vec(&value).unwrap()).is_err());
        let mut value = serde_json::to_value(request()).unwrap();
        value["files"][0]["role"] = serde_json::json!("command");
        assert!(parse(&serde_json::to_vec(&value).unwrap()).is_err());
        let text = String::from_utf8(serde_json::to_vec(&request()).unwrap()).unwrap();
        let duplicate = text.replacen("\"uid\":65532", "\"uid\":65532,\"uid\":1", 1);
        assert!(parse(duplicate.as_bytes()).is_err());
        assert!(parse(&vec![b' '; MAX_REQUEST_BYTES + 1]).is_err());
    }
}
