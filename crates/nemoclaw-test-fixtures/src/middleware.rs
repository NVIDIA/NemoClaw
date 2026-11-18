// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The `docker-dummy` live case's external middleware and HTTP destination.
//! Each counts the requests it sees by path and rewrites the counts to a file
//! that the case's assertions read. Dropping the fixture stops both listeners.
//! The middleware uses OpenShell's HTTP hooks, which replace the legacy
//! `EvaluateHttpRequest` that OpenShell 0.2.0 removes.
use openshell_core::{
    extension_protocol::http_hooks_middleware_metadata,
    middleware::{
        HttpRequestHookResultStream, HttpResponseHookResultStream, WebSocketResponseStream,
    },
    proto::{
        HttpContinue, HttpDenial, HttpPreflightResult, HttpRequestHookEvent, HttpRequestHookResult,
        HttpResponseHookEvent, MiddlewareBinding, MiddlewareDescribeRequest, MiddlewareDiagnostics,
        MiddlewareManifest, SupervisorMiddlewareOperation, SupervisorMiddlewarePhase,
        ValidateConfigRequest, ValidateConfigResponse, WebSocketSessionEvent,
        http_preflight_result, http_request_hook_event, http_request_hook_result,
        middleware::v1::{
            http_hooks_server::{HttpHooks, HttpHooksServer},
            supervisor_middleware_server::{SupervisorMiddleware, SupervisorMiddlewareServer},
        },
    },
};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tokio_stream::wrappers::TcpListenerStream;
use tonic::{Request, Response, Status};

/// Requests seen by path: `{"middleware": {PATH: N}, "destination": {PATH: N}}`.
#[derive(Clone)]
struct Effects {
    file: PathBuf,
    counts: Arc<Mutex<Value>>,
}

impl Effects {
    fn record(&self, side: &str, path: &str) {
        let mut counts = self.counts.lock().unwrap();
        let count = &mut counts[side][path];
        *count = json!(count.as_u64().unwrap_or(0) + 1);
        std::fs::write(&self.file, counts.to_string()).unwrap();
    }
}

/// Allows every request except one to `/deny`, which it denies, and one to
/// `/fail`, which it answers with a service error, as a middleware that can't
/// complete its check does.
#[derive(Clone)]
struct Guard(Effects);

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
            extension: Some(http_hooks_middleware_metadata(
                "nemoclaw-live-guard",
                openshell_core::VERSION,
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
        _: Request<openshell_core::proto::HttpRequestEvaluation>,
    ) -> Result<Response<openshell_core::proto::HttpRequestResult>, Status> {
        Err(Status::unimplemented("the live guard uses HTTP hooks"))
    }

    async fn evaluate_web_socket_session(
        &self,
        _: Request<tonic::Streaming<WebSocketSessionEvent>>,
    ) -> Result<Response<Self::EvaluateWebSocketSessionStream>, Status> {
        Err(Status::unimplemented("the live case uses HTTP requests"))
    }
}

#[tonic::async_trait]
impl HttpHooks for Guard {
    type EvaluateHttpRequestHookStream = HttpRequestHookResultStream;
    type EvaluateHttpResponseHookStream = HttpResponseHookResultStream;

    /// Decides at preflight from the request path, without the body.
    async fn evaluate_http_request_hook(
        &self,
        request: Request<tonic::Streaming<HttpRequestHookEvent>>,
    ) -> Result<Response<Self::EvaluateHttpRequestHookStream>, Status> {
        let Some(http_request_hook_event::Event::Preflight(preflight)) = request
            .into_inner()
            .message()
            .await?
            .and_then(|event| event.event)
        else {
            return Err(Status::invalid_argument(
                "the first event must be a preflight",
            ));
        };
        let target = preflight
            .request
            .and_then(|head| head.target)
            .ok_or_else(|| Status::invalid_argument("missing target"))?;
        self.0.record("middleware", &target.path);
        let result = match target.path.as_str() {
            "/fail" => return Err(Status::internal("the live guard fails this request")),
            "/deny" => http_request_hook_result::Result::Deny(HttpDenial {
                diagnostics: Some(MiddlewareDiagnostics {
                    reason_code: "live_guard_denied".into(),
                    ..Default::default()
                }),
            }),
            _ => http_request_hook_result::Result::PreflightResult(HttpPreflightResult {
                decision: Some(http_preflight_result::Decision::ContinueWithoutBody(
                    HttpContinue {},
                )),
                ..Default::default()
            }),
        };
        let result = HttpRequestHookResult {
            result: Some(result),
        };
        Ok(Response::new(Box::pin(tokio_stream::once(Ok(result)))))
    }

    async fn evaluate_http_response_hook(
        &self,
        _: Request<tonic::Streaming<HttpResponseHookEvent>>,
    ) -> Result<Response<Self::EvaluateHttpResponseHookStream>, Status> {
        Err(Status::unimplemented("the live guard binds only requests"))
    }
}

pub struct Fixture {
    _http: crate::http::Fixture,
    grpc: tokio::task::JoinHandle<()>,
}

impl Fixture {
    /// Listen on every address of the test host, which the gateway and sandbox
    /// reach through their bridges, and record effects in `file`.
    pub async fn start(grpc_port: u16, http_port: u16, file: PathBuf) -> Self {
        let effects = Effects {
            file,
            counts: Arc::new(Mutex::new(json!({"middleware": {}, "destination": {}}))),
        };
        std::fs::write(&effects.file, effects.counts.lock().unwrap().to_string()).unwrap();
        let guard = Guard(effects.clone());
        let hooks = guard.clone();
        let listener = tokio::net::TcpListener::bind(("0.0.0.0", grpc_port))
            .await
            .unwrap();
        let grpc = tokio::spawn(async move {
            tonic::transport::Server::builder()
                .add_service(SupervisorMiddlewareServer::new(guard))
                .add_service(HttpHooksServer::new(hooks))
                .serve_with_incoming(TcpListenerStream::new(listener))
                .await
                .unwrap();
        });
        let http =
            crate::http::Fixture::start_tcp_at(&format!("0.0.0.0:{http_port}"), move |request| {
                effects.record("destination", &request.path);
                Some((200, Vec::new()))
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
