// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::NimService;
use crate::{Error, execution::output::Output};
use process_wrap::tokio::CommandWrap;
use std::path::Path;

pub(super) fn launch(
    service: &NimService,
    root: &Path,
    ngc_file: &Path,
    total_memory: u64,
    credential: Option<String>,
) -> Result<(CommandWrap, Output), Error> {
    launch_at(
        service,
        root,
        ngc_file,
        total_memory,
        credential,
        Path::new("/opt/nim/start_server.sh"),
    )
}

fn ngc_key(path: &Path) -> Result<String, Error> {
    use std::io::Read;
    let file = rustix::fs::open(
        path,
        rustix::fs::OFlags::RDONLY
            | rustix::fs::OFlags::CLOEXEC
            | rustix::fs::OFlags::NONBLOCK
            | rustix::fs::OFlags::NOFOLLOW,
        rustix::fs::Mode::empty(),
    )
    .map_err(|_| Error::State("cannot open the NGC credential file"))?;
    let file = std::fs::File::from(file);
    if !file
        .metadata()
        .map_err(|_| Error::State("cannot inspect the NGC credential file"))?
        .is_file()
    {
        return Err(Error::State("NGC credential input must be a regular file"));
    }
    let mut bytes = Vec::new();
    file.take(4097)
        .read_to_end(&mut bytes)
        .map_err(|_| Error::State("cannot read the NGC credential file"))?;
    if bytes.len() > 4096 {
        return Err(Error::State("NGC credential file is too large"));
    }
    let text = String::from_utf8(bytes).map_err(|_| Error::State("invalid NGC credential file"))?;
    let key = text
        .strip_suffix("\r\n")
        .or_else(|| text.strip_suffix('\n'))
        .unwrap_or(&text);
    if key.is_empty() || !key.bytes().all(|b| (33..=126).contains(&b)) {
        return Err(Error::State("invalid NGC credential file"));
    }
    Ok(key.into())
}

fn launch_at(
    service: &NimService,
    root: &Path,
    ngc_file: &Path,
    total_memory: u64,
    credential: Option<String>,
    executable: &Path,
) -> Result<(CommandWrap, Output), Error> {
    use std::process::Stdio;
    service.validate()?;
    crate::hardware::at_least(
        "native NIM serving memory (bytes)",
        service.gpu_bytes(),
        total_memory,
    )?;
    if service.authentication.is_some() != credential.is_some() {
        return Err(Error::State(
            "NIM inference credential is missing or unexpected",
        ));
    }
    let credential = crate::execution::authentication::supplied(credential.map(Into::into))?;
    let ngc = ngc_key(ngc_file)?;
    let (reader, writer) =
        std::io::pipe().map_err(|_| Error::State("cannot create NIM output pipe"))?;
    let errors = writer
        .try_clone()
        .map_err(|_| Error::State("cannot clone NIM output pipe"))?;
    let output = super::output::start(
        reader,
        std::iter::once(ngc.clone()).chain(credential.iter().cloned()),
    );
    // Round down so conversion to the native fraction never exceeds the byte budget.
    let fraction = ((service.gpu_bytes() as f64 / total_memory as f64) * 1e9).floor() / 1e9;
    let command = CommandWrap::with_new(executable, |cmd| {
        cmd.args([
            "nim-serve",
            "--gpu-memory-utilization",
            &format!("{fraction:.9}"),
            "--max-num-seqs",
            "1",
        ])
        .env("NGC_API_KEY", ngc)
        .env_remove("NGC_CLI_API_KEY")
        .env_remove("NIM_NGC_API_KEY")
        .env_remove(crate::INFERENCE_KEY_ENV)
        .env_remove("VLLM_API_KEY")
        .env_remove("NIM_MODEL_PATH")
        .env("NIM_MODEL_PROFILE", &service.model.profile)
        .env("NIM_SERVED_MODEL_NAME", &service.model.name)
        .env("NIM_SERVER_PORT", service.serving.port.to_string())
        .env("NIM_HEALTH_PORT", service.serving.port.to_string())
        .env("NIM_BACKEND_PORT", (service.serving.port + 1).to_string())
        .env(
            "NIM_MAX_MODEL_LEN",
            service.serving.context_tokens.to_string(),
        )
        .env("NIM_CACHE_PATH", root.join("cache"))
        .env("NIM_WRITABLE_ROOT", root.join("native"))
        .env("NIM_DYNAMO_SINGLE", "0")
        .env("NIM_DYNAMO_WORKER", "0")
        .env("NIM_DYNAMO_FRONTEND", "0")
        .env("NIM_SSL_MODE", "DISABLED")
        .env("NIM_TELEMETRY_MODE", "0")
        .stdin(Stdio::null())
        .stdout(writer)
        .stderr(errors);
        if let Some(key) = credential {
            cmd.env("VLLM_API_KEY", key);
        }
        if !service.model.tool_parser.is_empty() {
            cmd.args([
                "--enable-auto-tool-choice",
                "--tool-call-parser",
                &service.model.tool_parser,
            ]);
        }
        if !service.model.chat_template_kwargs.is_empty() {
            cmd.args([
                "--default-chat-template-kwargs",
                &serde_json::to_string(&service.model.chat_template_kwargs)
                    .expect("JSON values serialize as native chat-template arguments"),
            ]);
        }
    });
    Ok((command, output))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn service() -> NimService {
        let value: serde_json::Value =
            serde_saphyr::from_str(include_str!("../../tests/fixtures/nim.yaml")).unwrap();
        let crate::RuntimeSpec::Nim(service) =
            crate::RuntimeSpec::decode(&value.to_string()).unwrap()
        else {
            panic!("NIM fixture")
        };
        *service
    }

    #[tokio::test]
    async fn native_child_receives_file_and_serving_credentials_without_argv_literals() {
        const CHILD: &str = "NEMOCLAW_TEST_NIM_PROCESS_CHILD";
        if std::env::var_os(CHILD).is_none() {
            let output=std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact","nim::process::tests::native_child_receives_file_and_serving_credentials_without_argv_literals","--nocapture"])
                .env(CHILD,"1").env("NGC_CLI_API_KEY","wrong-inherited-ngc")
                .env("VLLM_API_KEY","wrong-inherited-inference").env(crate::INFERENCE_KEY_ENV,"wrong-platform-key")
                .output().unwrap();
            assert!(
                output.status.success(),
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }
        let root = tempfile::tempdir().unwrap();
        let ngc = root.path().join("operator-ngc");
        std::fs::write(&ngc, "synthetic-ngc-download-key\n").unwrap();
        let executable = root.path().join("native-nim");
        let captured = root.path().join("received");
        crate::executable::write_executable(
            &executable,
            format!(
                "#!/bin/sh\nset -eu\nprintf '%s\\n' \"${{NGC_CLI_API_KEY:-$NGC_API_KEY}}\" \"${{VLLM_API_KEY-unset}}\" \"$NIM_MODEL_PROFILE\" \"$NIM_SERVER_PORT\" \"$NIM_BACKEND_PORT\" \"$@\" > '{}'\n",
                captured.display()
            ),
        );
        let (mut command, output) = launch_at(
            &service(),
            root.path(),
            &ngc,
            48 << 30,
            Some("synthetic-inference-key".into()),
            &executable,
        )
        .expect("native NIM launch");
        let mut child = command.spawn().unwrap();
        drop(command);
        assert!(child.wait().await.unwrap().success());
        output.explain(Ok(())).await.unwrap();
        let received = std::fs::read_to_string(captured).unwrap();
        let lines: Vec<_> = received.lines().collect();
        assert_eq!(
            &lines[..5],
            &[
                "synthetic-ngc-download-key",
                "synthetic-inference-key",
                service().model.profile.as_str(),
                "18888",
                "18889"
            ]
        );
        assert!(
            !lines[5..].iter().any(|arg| arg.contains("synthetic")),
            "credentials must not be arguments"
        );
        let fraction = lines
            .windows(2)
            .find(|a| a[0] == "--gpu-memory-utilization")
            .unwrap()[1]
            .parse::<f64>()
            .unwrap();
        assert!(
            (fraction - 40.0 / 48.0).abs() < 0.000001,
            "native allocation must use the declared byte budget"
        );
        let mut unauthenticated = service();
        unauthenticated.authentication = None;
        let (mut command, output) = launch_at(
            &unauthenticated,
            root.path(),
            &ngc,
            48 << 30,
            None,
            &executable,
        )
        .unwrap();
        let mut child = command.spawn().unwrap();
        drop(command);
        assert!(child.wait().await.unwrap().success());
        output.explain(Ok(())).await.unwrap();
        let received = std::fs::read_to_string(root.path().join("received")).unwrap();
        assert_eq!(
            received.lines().nth(1),
            Some("unset"),
            "an inherited key must not silently enable authentication"
        );
    }

    #[test]
    fn invalid_or_nonregular_ngc_inputs_fail_without_echoing_contents() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("credential");
        for bytes in [
            Vec::new(),
            b"synthetic secret with spaces".to_vec(),
            vec![b'x'; 4097],
            vec![0xff],
        ] {
            std::fs::write(&file, &bytes).unwrap();
            let error = ngc_key(&file).unwrap_err().to_string();
            assert!(!error.contains("synthetic secret"));
        }
        assert!(ngc_key(root.path()).is_err());
        assert!(ngc_key(&root.path().join("missing")).is_err());
        let link = root.path().join("symlink");
        std::os::unix::fs::symlink(&file, &link).unwrap();
        assert!(ngc_key(&link).is_err());
    }

    #[tokio::test]
    async fn authored_chat_template_arguments_reach_native_nim_and_omission_keeps_its_defaults() {
        let root = tempfile::tempdir().unwrap();
        let ngc = root.path().join("operator-ngc");
        std::fs::write(&ngc, "synthetic-download-key\n").unwrap();
        let executable = root.path().join("native-nim");
        // The external backend decides whether its first-turn tool template is
        // enabled. This substitute does not qualify model instruction following.
        crate::executable::write_executable(
            &executable,
            r#"#!/bin/sh
set -eu
while [ $# -gt 0 ]; do
 if [ "$1" = --default-chat-template-kwargs ]; then
  shift
  case "$1" in
   *'"tools_in_user_message":false'*) exit 0 ;;
   *) exit 43 ;;
  esac
 fi
 shift
done
exit 42
"#,
        );
        for selected in [true, false] {
            let mut input = serde_json::to_value(service()).unwrap();
            input["kind"] = "nim".into();
            if selected {
                input["model"]["chatTemplateKwargs"] =
                    serde_json::json!({"tools_in_user_message": false});
            }
            let crate::RuntimeSpec::Nim(service) = crate::RuntimeSpec::decode(&input.to_string())
                .expect("native NIM chat-template arguments must be configurable")
            else {
                panic!("NIM fixture")
            };
            let (mut command, output) = launch_at(
                &service,
                root.path(),
                &ngc,
                48 << 30,
                Some("synthetic-inference-key".into()),
                &executable,
            )
            .unwrap();
            let mut child = command.spawn().unwrap();
            drop(command);
            let status = child.wait().await.unwrap();
            output.explain(Ok(())).await.unwrap();
            assert_eq!(status.code(), Some(if selected { 0 } else { 42 }));
        }
    }

    #[tokio::test]
    async fn selected_tool_parser_enables_native_auto_tools_and_omission_keeps_native_defaults() {
        let root = tempfile::tempdir().unwrap();
        let ngc = root.path().join("operator-ngc");
        std::fs::write(&ngc, "synthetic-download-key\n").unwrap();
        let executable = root.path().join("native-nim");
        // Substitute the external process, observing whether the selected
        // native tool-serving capability is available to an auto-tool request.
        crate::executable::write_executable(
            &executable,
            r#"#!/bin/sh
set -eu
auto=false
parser=
while [ $# -gt 0 ]; do
 case "$1" in
 --enable-auto-tool-choice) auto=true ;;
 --tool-call-parser) shift; parser=$1 ;;
 esac
 shift
done
if [ "$auto" = true ] && [ "$parser" = llama3_json ]; then
 exit 0
fi
if [ "$auto" = false ] && [ -z "$parser" ]; then
 exit 42
fi
exit 43
"#,
        );
        for selected in [true, false] {
            let mut input = serde_json::to_value(service()).unwrap();
            input["kind"] = "nim".into();
            if selected {
                input["model"]["toolParser"] = "llama3_json".into();
            }
            let crate::RuntimeSpec::Nim(service) = crate::RuntimeSpec::decode(&input.to_string())
                .expect("an explicit native NIM tool parser is configurable")
            else {
                panic!("NIM fixture")
            };
            let (mut command, output) = launch_at(
                &service,
                root.path(),
                &ngc,
                48 << 30,
                Some("synthetic-inference-key".into()),
                &executable,
            )
            .unwrap();
            let mut child = command.spawn().unwrap();
            drop(command);
            let status = child.wait().await.unwrap();
            output.explain(Ok(())).await.unwrap();
            assert_eq!(status.code(), Some(if selected { 0 } else { 42 }));
        }
    }
}
