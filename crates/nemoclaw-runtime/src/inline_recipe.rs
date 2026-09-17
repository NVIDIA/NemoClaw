// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{
    CancellationToken, Error,
    recipes::{
        inline::InlineRecipe,
        preparation::{Action, Request, Runner},
    },
};
use process_wrap::tokio::{CommandWrap, KillOnDrop, ProcessGroup};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub(crate) struct PackagedRecipe<'a>(pub &'a InlineRecipe);
impl PackagedRecipe<'_> {
    pub fn validate_files(&self) -> Result<(), Error> {
        for tool in [&self.0.preparation, &self.0.verification] {
            let path = Path::new(&tool.executable);
            if !std::fs::symlink_metadata(path).is_ok_and(|m| m.is_file())
                || nemoclaw_sdk::bundle::hash_file(path)? != tool.sha256
            {
                return Err(Error::Conflict(
                    "recipe executable does not match its declared digest",
                ));
            }
        }
        for notice in self.0.licenses.iter().chain(&self.0.source_notices) {
            if !std::fs::symlink_metadata(notice).is_ok_and(|m| m.is_file() && m.len() > 0) {
                return Err(Error::Conflict(
                    "recipe license or source notice is missing",
                ));
            }
        }
        Ok(())
    }
}
#[async_trait::async_trait]
impl Runner for PackagedRecipe<'_> {
    async fn run(
        &self,
        action: Action,
        request: &Request<'_>,
        cancel: &CancellationToken,
    ) -> Result<Vec<u8>, Error> {
        self.validate_files()?;
        let tool = match action {
            Action::Prepare => &self.0.preparation,
            Action::Verify => &self.0.verification,
        };
        let input = serde_json::to_vec(request)
            .map_err(|_| Error::State("cannot encode recipe request"))?;
        let mut command = CommandWrap::with_new(&tool.executable, |cmd| {
            cmd.stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit());
        });
        command.wrap(KillOnDrop).wrap(ProcessGroup::leader());
        let mut child = command
            .spawn()
            .map_err(|_| Error::State("cannot start pinned recipe executable"))?;
        let mut stdin = child
            .stdin()
            .take()
            .ok_or(Error::State("recipe input unavailable"))?;
        let stdout = child
            .stdout()
            .take()
            .ok_or(Error::State("recipe output unavailable"))?;
        let work = async {
            let input = async {
                stdin
                    .write_all(&input)
                    .await
                    .map_err(|_| Error::State("cannot send recipe request"))?;
                drop(stdin);
                Ok::<_, Error>(())
            };
            let output = async {
                let mut bytes = Vec::new();
                stdout
                    .take((1 << 20) + 1)
                    .read_to_end(&mut bytes)
                    .await
                    .map_err(|_| Error::State("cannot read recipe evidence"))?;
                if bytes.len() > 1 << 20 {
                    return Err(Error::State("recipe evidence exceeds limit"));
                }
                Ok(bytes)
            };
            let status = async {
                child
                    .wait()
                    .await
                    .map_err(|_| Error::State("cannot wait for recipe executable"))
            };
            let (_, bytes, status) = tokio::try_join!(input, output, status)?;
            if !status.success() {
                return Err(Error::State(
                    "recipe executable failed; staged data retained",
                ));
            }
            Ok(bytes)
        };
        let result = tokio::select! {
            ()=cancel.cancelled()=>Err(Error::Cancelled),
            result=tokio::time::timeout(Duration::from_secs(8*3600),work)=>match result {Ok(result)=>result,Err(_)=>Err(Error::State("recipe execution exceeded budget; staged data retained"))},
        };
        crate::supervisor::terminate(child.as_mut()).await;
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    #[tokio::test]
    async fn pinned_executable_receives_structured_input_and_tampering_stops_execution() {
        let d = nemoclaw_sdk::config::Document::parse(
            include_bytes!("../../../examples/spark/spark-inline.yaml").as_slice(),
        )
        .unwrap();
        let mut recipe = d.spec.inference_providers[0]
            .service
            .as_ref()
            .unwrap()
            .recipe
            .clone()
            .unwrap();
        let root = tempfile::tempdir().unwrap();
        let executable = root.path().join("tool with spaces");
        std::fs::write(&executable, b"#!/bin/sh\ncat\n").unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        recipe.preparation.executable = executable.to_str().unwrap().into();
        recipe.preparation.sha256 = nemoclaw_sdk::bundle::hash_file(&executable).unwrap();
        recipe.verification = recipe.preparation.clone();
        recipe.licenses = vec![executable.to_str().unwrap().into()];
        recipe.source_notices = recipe.licenses.clone();
        let request = Request {
            api_version: "nemoclaw.nvidia.com/recipe-execution/v1",
            model_directory: root.path(),
            output_directory: root.path(),
            previous_directory: None,
        };
        let runner = PackagedRecipe(&recipe);
        let bytes = runner
            .run(Action::Prepare, &request, &CancellationToken::new())
            .await
            .unwrap();
        let output: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(output["modelDirectory"], root.path().to_str().unwrap());
        std::fs::write(&executable, b"#!/bin/sh\nexit 0\n").unwrap();
        assert!(
            runner
                .run(Action::Prepare, &request, &CancellationToken::new())
                .await
                .is_err()
        );
    }
}
