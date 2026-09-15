// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::Error;

pub(super) fn select(
    explicit: Option<String>,
    detect: impl FnOnce() -> Result<String, Error>,
) -> Result<String, Error> {
    explicit.map_or_else(detect, Ok)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_platform_skips_fallible_host_detection() {
        assert_eq!(
            select(Some("linux_arm64".into()), || {
                panic!("explicit platform must skip detection")
            })
            .unwrap(),
            "linux_arm64"
        );
    }

    #[test]
    fn missing_platform_preserves_host_detection_success_and_failure() {
        assert_eq!(
            select(None, || Ok("linux_arm64".into())).unwrap(),
            "linux_arm64"
        );
        assert!(matches!(
            select(None, || Err(Error::Bundle("unsupported host"))),
            Err(Error::Bundle("unsupported host"))
        ));
    }
}
