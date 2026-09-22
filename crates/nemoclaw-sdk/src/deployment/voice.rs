// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::{
    Binding,
    openshell::OpenShell,
    voice::{
        AccessGrant, Bootstrap, CloseReason, ConnectionState, ServerConfig, SystemClock,
        TargetProbe, VoiceServer,
    },
};
use async_trait::async_trait;
use time::OffsetDateTime;
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationResult {
    pub name: String,
    pub status: String,
    pub process_lifecycle: String,
    pub reason: String,
}
impl Deployment {
    pub fn with_voiceclaw(mut self, bootstrap: Bootstrap) -> Self {
        self.voiceclaw = Some(bootstrap);
        self
    }
    pub(super) async fn connect_voiceclaw(
        &self,
        bundle: &Bundle,
        store: &Store,
        record: &Record,
        result: &mut OperationResult,
        cancel: &CancellationToken,
    ) -> Result<(), Error> {
        let document = &record.document;
        if let Some((integration_name, sandbox)) = document.voiceclaw_r0_binding()? {
            let bootstrap = self.voiceclaw.as_ref().ok_or(Error::Conflict(
                "VoiceClaw integration requires an operator-approved bootstrap path; agent retained",
            ))?;
            bootstrap.prepare(&store.directory, cancel).await?;

            let bindings = self
                .state_bindings(bundle, store, document, &record.generations, false, cancel)
                .await?;
            let targets = compile::targets(document, &record.generations)?;
            let address = format!("nemoclaw_sandbox.{}", sandbox.name);
            let target = targets
                .iter()
                .find(|target| target.address == address)
                .ok_or(Error::State("VoiceClaw sandbox target is absent"))?;
            let mut current = target.values.clone();
            let established = bindings
                .get(&target.address)
                .ok_or(Error::State("sandbox has no established identity"))?;
            current.insert("id".into(), established.id.clone());
            let client =
                crate::openshell::OpenShell::connect(&document.spec.gateway, self.secrets.clone())?;
            if client.voice_ready(&current).await != crate::voice::ProbeResult::Ready {
                return Err(Error::Conflict(
                    "VoiceClaw target revalidation failed; agent retained",
                ));
            }
            let owner = format!("{}/{}", document.metadata.uid, integration_name);
            let generation = current
                .get("generation")
                .ok_or(Error::State("sandbox generation is unavailable"))?;
            let native_id = current
                .get("id")
                .ok_or(Error::State("sandbox identity is unavailable"))?;
            let authority = Binding::new(&owner, generation, native_id)?;
            let target_ref = voice_target_ref(&owner, generation, native_id);
            let grant =
                AccessGrant::issue(&target_ref, authority.clone(), OffsetDateTime::now_utc())
                    .map_err(|_| Error::State("cannot issue VoiceClaw access"))?;
            let probe = Arc::new(DeploymentVoiceProbe {
                client: client.clone(),
                sandbox: current,
                authority,
            });
            let server = VoiceServer::bind(
                "127.0.0.1:0".parse().expect("fixed loopback address"),
                &grant,
                probe,
                Arc::new(SystemClock),
                ServerConfig::default(),
            )
            .await
            .map_err(|_| Error::State("cannot start private VoiceClaw semantic server"))?;
            let ready = bootstrap
                .connect(&store.directory, server.endpoint(), &grant, cancel)
                .await?;
            if !matches!(
                server.connection_state(),
                ConnectionState::Connected | ConnectionState::Closed(_)
            ) {
                return Err(Error::Conflict(
                    "VoiceClaw reported ready without a semantic connection; agent retained",
                ));
            }
            drop(ready);
            drop(grant);
            let run_cancel = CancellationToken::new();
            let reason = tokio::select! {
                result = server.wait_for_run(&run_cancel) => result?,
                () = cancel.cancelled() => {
                    server.stop();
                    let _ = tokio::time::timeout(
                        std::time::Duration::from_secs(5),
                        server.wait_for_run(&run_cancel),
                    ).await;
                    return Err(Error::Cancelled);
                }
            };
            result.integrations.push(IntegrationResult {
                name: integration_name.into(),
                status: "disconnected".into(),
                process_lifecycle: "not-managed".into(),
                reason: close_reason(reason).into(),
            });
        }
        Ok(())
    }
}
struct DeploymentVoiceProbe {
    client: OpenShell,
    sandbox: Row,
    authority: Binding,
}

#[async_trait]
impl TargetProbe for DeploymentVoiceProbe {
    async fn probe(&self, authority: &Binding) -> crate::voice::ProbeResult {
        if authority != &self.authority {
            return crate::voice::ProbeResult::Replaced;
        }
        self.client.voice_ready(&self.sandbox).await
    }

    async fn dispatch(&self, authority: &Binding) -> crate::voice::DispatchResult {
        if authority != &self.authority {
            return crate::voice::DispatchResult::TargetReplaced;
        }
        self.client.voice_response(&self.sandbox).await
    }
}

fn voice_target_ref(owner: &str, generation: &str, native_id: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut digest = Sha256::new();
    for value in [owner, generation, native_id] {
        digest.update((value.len() as u64).to_be_bytes());
        digest.update(value.as_bytes());
    }
    format!(
        "nvr0-{}",
        digest
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}

fn close_reason(reason: CloseReason) -> &'static str {
    match reason {
        CloseReason::ClientDisconnected => "client_disconnected",
        CloseReason::CredentialExpired => "credential_expired",
        CloseReason::AgentUnavailable => "agent_unavailable",
        CloseReason::TargetReplaced => "target_replaced",
        CloseReason::ServerStopping => "server_stopping",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn voice_target_reference_is_opaque_stable_and_bound_to_actual_identity() {
        let target = voice_target_ref("deployment/voice", "generation-a", "native-id-a");
        assert!(target.starts_with("nvr0-") && target.len() == 69);
        for private in ["deployment", "voice", "generation-a", "native-id-a"] {
            assert!(!target.contains(private));
        }
        assert_eq!(
            target,
            voice_target_ref("deployment/voice", "generation-a", "native-id-a")
        );
        assert_ne!(
            target,
            voice_target_ref("deployment/voice", "generation-b", "native-id-a")
        );
        assert_ne!(
            target,
            voice_target_ref("deployment/voice", "generation-a", "native-id-b")
        );
    }
}
