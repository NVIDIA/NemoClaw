// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Defensively filter NGC and inference credentials from native NIM output.
//! No native credential disclosure was observed in qualification. This limits
//! exposure if a native startup diagnostic echoes its configured environment.
#[cfg(test)]
use crate::Error;
use crate::execution::output::Output;

pub(super) fn start(
    reader: std::io::PipeReader,
    credentials: impl IntoIterator<Item = String>,
) -> Output {
    let credentials: Vec<_> = credentials
        .into_iter()
        .filter(|key| !key.is_empty())
        .collect();
    let keys = credentials.clone();
    let mut pending = Vec::new();
    Output::filtered(reader, credentials, move |bytes, finished| {
        redact(&mut pending, bytes, &keys, finished)
    })
}

/// Hold only a suffix that could become a key when the next pipe read arrives.
/// Other bytes can be logged immediately, including short progress lines.
fn redact(pending: &mut Vec<u8>, bytes: &[u8], keys: &[String], finished: bool) -> Vec<u8> {
    if keys.is_empty() {
        return bytes.to_vec();
    }
    pending.extend_from_slice(bytes);
    let mut output = Vec::new();
    let mut offset = 0;
    while offset < pending.len() {
        let tail = &pending[offset..];
        // A complete shorter key can still be the beginning of a longer key.
        // Wait for the next read before deciding which value to redact.
        if !finished
            && keys
                .iter()
                .any(|key| key.len() > tail.len() && key.as_bytes().starts_with(tail))
        {
            break;
        }
        if let Some(length) = keys
            .iter()
            .filter(|key| !key.is_empty() && tail.starts_with(key.as_bytes()))
            .map(String::len)
            .max()
        {
            output.extend_from_slice(b"[redacted]");
            offset += length;
        } else {
            output.push(pending[offset]);
            offset += 1;
        }
    }
    pending.drain(..offset);
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_is_forwarded_immediately_and_incomplete_key_prefixes_are_preserved() {
        let mut pending = Vec::new();
        let key = vec!["0123456789abcdef".into()];
        assert_eq!(
            redact(&mut pending, b"loading\n", &key, false),
            b"loading\n"
        );
        assert_eq!(redact(&mut pending, b"01", &key, false), b"");
        assert_eq!(redact(&mut pending, b" done\n", &key, false), b"01 done\n");
        assert_eq!(redact(&mut pending, b"012", &key, false), b"");
        assert_eq!(redact(&mut pending, b"", &key, true), b"012");
        assert_eq!(
            redact(&mut pending, b"unchanged\0bytes", &[], false),
            b"unchanged\0bytes"
        );
    }

    #[tokio::test]
    async fn container_output_redacts_the_key_across_reads_and_preserves_other_bytes() {
        const CHILD: &str = "NEMOCLAW_TEST_OUTPUT_CHILD";
        const KEY: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        // More than one reader buffer, with a credential crossing its boundary.
        let prefix = "x".repeat(8190);
        let text = format!("{prefix}{KEY} then {KEY}\nlast line\n");
        if std::env::var_os(CHILD).is_some() {
            use std::io::Write;
            let (reader, mut writer) = std::io::pipe().unwrap();
            let output = start(reader, Some(KEY.into()));
            writer.write_all(text.as_bytes()).unwrap();
            drop(writer);
            assert!(output.explain(Err(Error::Exited(None))).await.is_err());
            return;
        }
        // Capture the production reader's stderr in another process; replacing
        // a sink here would miss the container-log boundary this protects.
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "nim::output::tests::container_output_redacts_the_key_across_reads_and_preserves_other_bytes",
                "--nocapture",
            ])
            .env(CHILD, "1")
            .output()
            .unwrap();
        assert!(output.status.success());
        let logged = String::from_utf8(output.stderr).unwrap();
        assert!(
            !logged.contains(KEY),
            "container logs exposed the service key"
        );
        assert_eq!(logged, text.replace(KEY, "[redacted]"));
    }
    #[tokio::test]
    async fn container_output_redacts_download_and_inference_credentials() {
        const CHILD: &str = "NEMOCLAW_TEST_NIM_OUTPUT_CHILD";
        const KEY: &str = "synthetic-shared-credential";
        const NGC: &str = "synthetic-shared-credential-ngc-download";
        const OTHER: &str = "independent-synthetic-download-key";
        let prefix = "x".repeat(8190);
        let text = format!("{prefix}{NGC} then {KEY} and {OTHER}\nlast {NGC} {OTHER}\n");
        if std::env::var_os(CHILD).is_some() {
            use std::io::Write;
            let (reader, mut writer) = std::io::pipe().unwrap();
            let output = start(reader, [KEY.into(), NGC.into(), OTHER.into()]);
            writer.write_all(text.as_bytes()).unwrap();
            drop(writer);
            let diagnostic = output
                .explain(Err(Error::Exited(None)))
                .await
                .unwrap_err()
                .to_string();
            assert!(
                !diagnostic.contains(KEY)
                    && !diagnostic.contains(NGC)
                    && !diagnostic.contains(OTHER)
            );
            return;
        }
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "nim::output::tests::container_output_redacts_download_and_inference_credentials",
                "--nocapture",
            ])
            .env(CHILD, "1")
            .output()
            .unwrap();
        assert!(output.status.success());
        let logged = String::from_utf8(output.stderr).unwrap();
        assert_eq!(
            &logged[prefix.len()..],
            text[prefix.len()..]
                .replace(NGC, "[redacted]")
                .replace(KEY, "[redacted]")
                .replace(OTHER, "[redacted]"),
            "both credentials must be fully redacted, including the longer shared-prefix key"
        );
    }

    #[test]
    fn every_split_redacts_independent_and_prefix_related_keys_in_either_order() {
        let text = b"loading\nshort-long / independent / short / short-long\n";
        let expected = b"loading\n[redacted] / [redacted] / [redacted] / [redacted]\n";
        for keys in [
            vec!["short".into(), "short-long".into(), "independent".into()],
            vec!["independent".into(), "short-long".into(), "short".into()],
        ] {
            for split in 0..=text.len() {
                let mut pending = Vec::new();
                let mut output = redact(&mut pending, &text[..split], &keys, false);
                output.extend(redact(&mut pending, &text[split..], &keys, false));
                output.extend(redact(&mut pending, &[], &keys, true));
                assert_eq!(output, expected, "split at byte {split}");
                assert!(pending.is_empty());
            }
        }
        let mut pending = Vec::new();
        let keys = vec!["short".into(), "short-long".into()];
        assert!(redact(&mut pending, b"short", &keys, false).is_empty());
        assert_eq!(redact(&mut pending, &[], &keys, true), b"[redacted]");
    }
}
