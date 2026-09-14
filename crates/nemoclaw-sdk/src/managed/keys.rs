// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#[cfg(all(test, unix))]
#[path = "keys_tests.rs"]
mod tests;

use crate::{Error, docker::Engine};
pub(crate) const CREDENTIAL_KEY_PATH: &str =
    "/state/openshell/gateway/credentials/key-encryption-key.bin";
impl Engine {
    /// Caller has verified the immutable container and its complete old spec.
    pub(crate) async fn preserve_legacy_key(&self, id: &str, data_path: &str) -> Result<(), Error> {
        let legacy = self
            .read_file(
                id,
                "/root/.local/state/openshell/gateway/credentials/key-encryption-key.bin",
                32,
            )
            .await?
            .filter(|key| key.len() == 32)
            .ok_or(Error::Conflict(
                "legacy gateway encryption key is unobservable; replacement forbidden",
            ))?;
        let key = match self
            .read_file(id, &format!("{data_path}{CREDENTIAL_KEY_PATH}"), 32)
            .await?
        {
            Some(key) => key,
            None => self.write_credential_key(id, data_path, &legacy).await?,
        };
        if key != legacy {
            return Err(Error::Conflict(
                "legacy encryption key was not preserved; replacement forbidden",
            ));
        }
        Ok(())
    }
    pub(crate) async fn write_credential_key(
        &self,
        id: &str,
        data_path: &str,
        key: &[u8],
    ) -> Result<Vec<u8>, Error> {
        if key.len() != 32 {
            return Err(Error::Conflict("invalid gateway credential encryption key"));
        }
        let mut archive = tar::Builder::new(Vec::new());
        for name in [
            "state",
            "state/openshell",
            "state/openshell/gateway",
            "state/openshell/gateway/credentials",
        ] {
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(tar::EntryType::Directory);
            header.set_size(0);
            header.set_mode(0o700);
            header.set_mtime(0);
            header.set_cksum();
            archive
                .append_data(&mut header, name, std::io::empty())
                .map_err(|_| Error::State("cannot prepare credential directory write"))?;
        }
        let mut header = tar::Header::new_gnu();
        header.set_size(32);
        header.set_mode(0o600);
        header.set_mtime(0);
        header.set_cksum();
        archive
            .append_data(&mut header, &CREDENTIAL_KEY_PATH[1..], key)
            .map_err(|_| Error::State("cannot prepare credential key write"))?;
        self.write_archive(
            id,
            data_path,
            archive
                .into_inner()
                .map_err(|_| Error::State("cannot finish credential key write"))?,
        )
        .await?;
        let observed = self
            .read_file(id, &format!("{data_path}{CREDENTIAL_KEY_PATH}"), 32)
            .await?
            .ok_or(Error::Conflict("persisted credential key is unobservable"))?;
        if observed != key {
            return Err(Error::Conflict(
                "persisted credential key could not be verified",
            ));
        }
        Ok(observed)
    }
}
