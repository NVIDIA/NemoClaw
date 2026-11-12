// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! A live case's external middleware and HTTP destination, recording independent
//! request effects. Dropping the fixture stops both listeners.
use openshell_core::{
    extension_protocol::{ExtensionFamily, extension_metadata},
    middleware::WebSocketResponseStream,
    proto::{
        Decision, HttpRequestEvaluation, HttpRequestResult, MiddlewareBinding,
        MiddlewareDescribeRequest, MiddlewareManifest, SupervisorMiddlewareOperation,
        SupervisorMiddlewarePhase, ValidateConfigRequest, ValidateConfigResponse,
        WebSocketSessionEvent,
        middleware::v1::supervisor_middleware_server::{
            SupervisorMiddleware, SupervisorMiddlewareServer,
        },
    },
};
use serde_json::json;
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};
use tokio_stream::wrappers::TcpListenerStream;
use tonic::{Request, Response, Status};

#[derive(Default)]
struct Effects {
    middleware: BTreeMap<String, usize>,
    destination: BTreeMap<String, usize>,
}

#[derive(Clone)]
struct Guard(Arc<Mutex<Effects>>);

#[tonic::async_trait]
impl SupervisorMiddleware for Guard {
    type EvaluateWebSocketSessionStream = WebSocketResponseStream;

    async fn describe(
        &self,
        _: Request<MiddlewareDescribeRequest>,
    ) -> Result<Response<MiddlewareManifest>, Status> {
        Ok(Response::new(MiddlewareManifest {
            name: "nemoclaw-live-guard".into(),
            bindings: vec![MiddlewareBinding {
                operation: SupervisorMiddlewareOperation::HttpRequest as i32,
                phase: SupervisorMiddlewarePhase::PreCredentials as i32,
                max_payload_bytes: 4096,
                ..Default::default()
            }],
            extension: Some(extension_metadata(
                ExtensionFamily::SupervisorMiddleware,
                "nemoclaw-live-guard",
                openshell_core::VERSION,
                [],
            )),
            ..Default::default()
        }))
    }

    async fn validate_config(
        &self,
        _: Request<ValidateConfigRequest>,
    ) -> Result<Response<ValidateConfigResponse>, Status> {
        Ok(Response::new(ValidateConfigResponse {
            valid: true,
            reason: String::new(),
        }))
    }

    async fn evaluate_http_request(
        &self,
        request: Request<HttpRequestEvaluation>,
    ) -> Result<Response<HttpRequestResult>, Status> {
        let target = request
            .into_inner()
            .target
            .ok_or_else(|| Status::invalid_argument("missing target"))?;
        *self
            .0
            .lock()
            .unwrap()
            .middleware
            .entry(target.path.clone())
            .or_default() += 1;
        Ok(Response::new(HttpRequestResult {
            decision: if target.path == "/deny" {
                Decision::Deny
            } else {
                Decision::Allow
            } as i32,
            ..Default::default()
        }))
    }

    async fn evaluate_web_socket_session(
        &self,
        _: Request<tonic::Streaming<WebSocketSessionEvent>>,
    ) -> Result<Response<Self::EvaluateWebSocketSessionStream>, Status> {
        Err(Status::unimplemented("the live case uses HTTP requests"))
    }
}

pub struct Fixture {
    _http: crate::http::Fixture,
    grpc: tokio::task::JoinHandle<()>,
}

impl Fixture {
    /// Listen on the test host; the gateway and sandbox reach its bridge addresses.
    pub async fn start(grpc_port: u16, http_port: u16) -> Self {
        let effects = Arc::new(Mutex::new(Effects::default()));
        let guard = Guard(effects.clone());
        let listener = tokio::net::TcpListener::bind(("0.0.0.0", grpc_port))
            .await
            .unwrap();
        let grpc = tokio::spawn(async move {
            tonic::transport::Server::builder()
                .add_service(SupervisorMiddlewareServer::new(guard))
                .serve_with_incoming(TcpListenerStream::new(listener))
                .await
                .unwrap();
        });
        let http =
            crate::http::Fixture::start_tcp_at(&format!("0.0.0.0:{http_port}"), move |request| {
                let mut effects = effects.lock().unwrap();
                let body = if request.path == "/effects" {
                    json!({"middleware": effects.middleware, "destination": effects.destination})
                } else {
                    *effects.destination.entry(request.path).or_default() += 1;
                    json!({"reached": true})
                };
                Some((200, serde_json::to_vec(&body).unwrap()))
            })
            .await;
        Self { _http: http, grpc }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.grpc.abort();
    }
}
