// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::{Document, Error, Plan};
use crate::SandboxHealth;
use serde_json::Value;

/// Whether OpenTofu proved durable mutations complete, independently of health.
pub(super) enum ApplyOutcome {
    Unsettled(Error),
    Settled(Result<Vec<SandboxHealth>, Error>),
}

pub(super) fn readiness_failures(error: &Error) -> Option<&[String]> {
    match error {
        Error::Execution {
            postcondition_failures: Some(addresses),
            ..
        } if !addresses.is_empty() => Some(addresses),
        _ => None,
    }
}

impl ApplyOutcome {
    pub(super) fn classify(
        applied: Result<Vec<u8>, Error>,
        observations: Result<Readiness, Error>,
    ) -> Self {
        let error = match applied {
            Ok(_) => return Self::Settled(observations.and_then(Readiness::health)),
            Err(error) => error,
        };
        // Only the complete UI stream plus fresh, matching failed observations
        // can settle a failed apply. Preserve its original error otherwise.
        if let Some(addresses) = readiness_failures(&error)
            && let Ok(observations) = observations
            && addresses.iter().all(|address| {
                observations.0.iter().any(|observed| {
                    *address == format!("data.nemoclaw_sandbox_readiness.{}", observed.sandbox)
                        && observed.failed
                })
            })
        {
            let health = observations
                .0
                .into_iter()
                .filter_map(|observed| observed.health().ok())
                .find(|health| !health.health.allows_apply_completion());
            return Self::Settled(Err(match health {
                Some(health) => Error::Health {
                    health: Box::new(health),
                },
                None => error,
            }));
        }
        Self::Unsettled(error)
    }
}

pub(super) struct Readiness(Vec<SandboxObservation>);

struct SandboxObservation {
    sandbox: String,
    agent: String,
    failed: bool,
    health_json: Option<String>,
}

impl SandboxObservation {
    fn health(self) -> Result<SandboxHealth, Error> {
        Ok(SandboxHealth {
            sandbox: self.sandbox,
            agents: vec![self.agent],
            health: crate::RuntimeHealth::decode(
                self.health_json
                    .ok_or(Error::State("sandbox health observation is absent"))?
                    .as_bytes(),
            )?,
        })
    }
}

impl Readiness {
    pub(super) fn decode(document: &Document, plan: &Plan, bytes: &[u8]) -> Result<Self, Error> {
        let state: Value = serde_json::from_slice(bytes)
            .map_err(|_| Error::State("invalid OpenTofu health observations"))?;
        if state["format_version"]
            .as_str()
            .is_none_or(|version| version.split('.').next() != Some("1"))
        {
            return Err(Error::State("unsupported OpenTofu state JSON version"));
        }
        let observations = crate::state::parse_resources(&state["values"])?;
        document
            .spec
            .sandboxes
            .iter()
            .map(|sandbox| {
                let address = format!("data.nemoclaw_sandbox_readiness.{}", sandbox.name);
                let observed = observations
                    .get(&address)
                    .ok_or(Error::State("sandbox readiness observation is absent"))?;
                let previous = plan
                    .resource_changes
                    .iter()
                    .find(|change| change.address == address)
                    .ok_or(Error::State("sandbox readiness was not scheduled"))?;
                let token = observed["read_trigger"]
                    .as_str()
                    .filter(|value| !value.is_empty())
                    .ok_or(Error::State(
                        "sandbox readiness observation has no operation identity",
                    ))?;
                if previous.change.before["read_trigger"].as_str() == Some(token) {
                    return Err(Error::State(
                        "sandbox readiness observation predates this apply",
                    ));
                }
                Ok(SandboxObservation {
                    sandbox: sandbox.name.clone(),
                    agent: sandbox.agent.name.clone(),
                    failed: observed["ready"] == false,
                    health_json: observed["health_json"].as_str().map(String::from),
                })
            })
            .collect::<Result<Vec<_>, Error>>()
            .map(Self)
    }

    fn health(self) -> Result<Vec<SandboxHealth>, Error> {
        self.0.into_iter().map(SandboxObservation::health).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture(token: &str, ready: bool) -> (Document, Plan, Vec<u8>) {
        let document =
            Document::parse(include_str!("../../tests/fixtures/config/local.yaml").as_bytes())
                .unwrap();
        let address = "data.nemoclaw_sandbox_readiness.assistant";
        let plan = serde_json::from_value(json!({"resource_changes": [{
            "address": address, "mode": "data", "change": {
                "actions": ["read"], "before": {"read_trigger": "previous"}
            }
        }]}))
        .unwrap();
        let health = if ready {
            json!({"supported": false, "report": null, "reason_code": "fabric_health_unsupported"})
        } else {
            json!({"supported": true, "report": null, "reason_code": "fabric_health_timeout"})
        };
        let state = serde_json::to_vec(&json!({"format_version": "1.0", "values": {
            "root_module": {"resources": [{"address": address, "mode": "data", "values": {
                "read_trigger": token, "ready": ready, "health_json": health.to_string()
            }}]}
        }}))
        .unwrap();
        (document, plan, state)
    }

    fn execution(addresses: Option<Vec<&str>>) -> Error {
        Error::Execution {
            operation: "apply".into(),
            diagnostic: "original failure".into(),
            postcondition_failures: addresses
                .map(|values| values.into_iter().map(String::from).collect()),
        }
    }

    #[test]
    fn successful_mutations_settle_even_when_health_cannot_be_read() {
        let outcome =
            ApplyOutcome::classify(Ok(Vec::new()), Err(Error::State("unreadable observations")));
        assert!(matches!(
            outcome,
            ApplyOutcome::Settled(Err(Error::State("unreadable observations")))
        ));
        let (document, plan, state) = fixture("current", true);
        let outcome =
            ApplyOutcome::classify(Ok(Vec::new()), Readiness::decode(&document, &plan, &state));
        let ApplyOutcome::Settled(Ok(health)) = outcome else {
            panic!("successful apply must settle")
        };
        assert_eq!(health[0].sandbox, "assistant");
        assert_eq!(health[0].agents, ["main"]);
        assert!(!health[0].health.supported);
    }

    #[test]
    fn only_fresh_matching_readiness_failures_settle_failed_mutations() {
        let address = "data.nemoclaw_sandbox_readiness.assistant";
        for (token, ready, addresses, settles) in [
            ("current", false, Some(vec![address]), true),
            ("previous", false, Some(vec![address]), false),
            ("", false, Some(vec![address]), false),
            ("current", true, Some(vec![address]), false),
            ("current", false, Some(vec![]), false),
            ("current", false, None, false),
            (
                "current",
                false,
                Some(vec![address, "data.foreign.other"]),
                false,
            ),
        ] {
            let (document, plan, state) = fixture(token, ready);
            let outcome = ApplyOutcome::classify(
                Err(execution(addresses)),
                Readiness::decode(&document, &plan, &state),
            );
            if settles {
                let ApplyOutcome::Settled(Err(Error::Health { health })) = outcome else {
                    panic!("fresh readiness failure must settle")
                };
                assert_eq!(health.sandbox, "assistant");
                assert_eq!(
                    health.health.reason_code.as_deref(),
                    Some("fabric_health_timeout")
                );
            } else {
                assert!(
                    matches!(outcome, ApplyOutcome::Unsettled(Error::Execution { diagnostic, .. }) if diagnostic == "original failure")
                );
            }
        }
    }

    #[test]
    fn malformed_health_does_not_erase_proven_mutation_completion_or_the_original_error() {
        let (document, plan, state) = fixture("current", false);
        let mut state: Value = serde_json::from_slice(&state).unwrap();
        state["values"]["root_module"]["resources"][0]["values"]["health_json"] = json!("invalid");
        let state = serde_json::to_vec(&state).unwrap();
        let outcome = ApplyOutcome::classify(
            Err(execution(Some(vec![
                "data.nemoclaw_sandbox_readiness.assistant",
            ]))),
            Readiness::decode(&document, &plan, &state),
        );
        assert!(
            matches!(outcome, ApplyOutcome::Settled(Err(Error::Execution { diagnostic, .. })) if diagnostic == "original failure")
        );
        assert!(matches!(
            ApplyOutcome::classify(Ok(Vec::new()), Readiness::decode(&document, &plan, &state)),
            ApplyOutcome::Settled(Err(Error::Conflict(_)))
        ));
    }

    #[test]
    fn missing_observations_never_replace_an_apply_error() {
        for observed in [
            Err(Error::Cancelled),
            Err(Error::State("absent observations")),
        ] {
            assert!(matches!(
                ApplyOutcome::classify(
                    Err(execution(Some(vec![
                        "data.nemoclaw_sandbox_readiness.assistant"
                    ]))),
                    observed
                ),
                ApplyOutcome::Unsettled(Error::Execution { .. })
            ));
        }
        let (document, plan, state) = fixture("current", false);
        assert!(matches!(
            ApplyOutcome::classify(
                Err(Error::Cancelled),
                Readiness::decode(&document, &plan, &state)
            ),
            ApplyOutcome::Unsettled(Error::Cancelled)
        ));
    }
}
