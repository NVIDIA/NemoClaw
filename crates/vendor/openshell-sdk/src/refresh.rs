// SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! OIDC bearer-token refresh contract.
//!
//! The SDK never talks to a browser or any specific `IdP`. Callers that need
//! the SDK to rotate an OIDC bearer mid-session implement [`Refresh`] and
//! construct a [`TokenSource`] around it. Implementations live where the
//! browser flow / token store / FFI callback belongs — in `openshell-cli`
//! for the desktop browser flow, in `openshell-sdk-node` for a JS callback.
//!
//! The trait is intentionally minimal. Single-flight coalescing (one refresh
//! in flight at a time, with all waiters sharing the result — success or
//! failure) is the SDK's responsibility, not the implementer's; see
//! [`TokenSource`].
//!
//! [`crate::OpenShellClient`] drives the source automatically: proactively
//! before a unary request when the token is near expiry
//! ([`TokenSource::current`]) and reactively on an `Unauthenticated` response
//! ([`TokenSource::refresh_now`]), writing the new token into the
//! interceptor's live bearer slot so rotation reaches an already-connected
//! client. Language bindings can also drive the source directly.

use crate::error::{Result, SdkError};
use futures::future::{FutureExt, Shared};
use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::{Mutex, RwLock};

/// Errors a refresher can return.
///
/// Domain-specific, deliberately not coupled to `tonic`, `napi`, or any
/// FFI-facing error type. The SDK maps these into [`SdkError::Auth`] before
/// surfacing to callers.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub enum RefreshError {
    /// Refresh failed but a retry might succeed (network blip, transient
    /// `IdP` error).
    Transient(String),
    /// Refresh cannot succeed without user interaction (refresh token
    /// expired, `IdP` revoked the session). Callers should not retry; they
    /// should re-authenticate.
    Terminal(String),
}

impl fmt::Display for RefreshError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Transient(msg) => write!(f, "transient refresh error: {msg}"),
            Self::Terminal(msg) => write!(f, "terminal refresh error: {msg}"),
        }
    }
}

impl std::error::Error for RefreshError {}

impl From<RefreshError> for SdkError {
    fn from(value: RefreshError) -> Self {
        let retryable = matches!(value, RefreshError::Transient(_));
        Self::auth_retryable(value.to_string(), retryable)
    }
}

/// A freshly minted access token + its absolute expiry.
///
/// `expires_at` is seconds since the Unix epoch. `None` means the token's
/// expiry was not advertised — the SDK will not refresh it proactively but
/// may refresh on demand if [`Refresh::refresh`] is called.
#[derive(Clone)]
#[non_exhaustive]
pub struct RefreshedToken {
    pub access_token: String,
    pub expires_at: Option<u64>,
}

impl fmt::Debug for RefreshedToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // `access_token` is a bearer secret; omit it so a stray `{:?}` or a
        // containing struct's derived `Debug` cannot write it to logs.
        f.debug_struct("RefreshedToken")
            .field("expires_at", &self.expires_at)
            .finish_non_exhaustive()
    }
}

impl RefreshedToken {
    pub fn new(access_token: impl Into<String>) -> Self {
        Self {
            access_token: access_token.into(),
            expires_at: None,
        }
    }

    #[must_use]
    pub fn with_expires_at(mut self, expires_at: u64) -> Self {
        self.expires_at = Some(expires_at);
        self
    }
}

/// Pluggable OIDC refresher.
///
/// Implementations should be cheap to clone and safe to call from any tokio
/// task. They MUST NOT do their own single-flight coalescing — that's the
/// SDK's job (see [`TokenSource`]).
#[async_trait::async_trait]
pub trait Refresh: Send + Sync + 'static {
    /// Mint a fresh access token. Called by the SDK when it determines the
    /// current token is near expiry (or has been explicitly invalidated).
    async fn refresh(&self) -> std::result::Result<RefreshedToken, RefreshError>;
}

/// Mutable token state shared between the auth interceptor and the
/// background refresh task.
///
/// `generation` increments on every successful refresh. Coalescing waiters
/// compare the generation they observed before queueing against the current
/// value to decide whether another caller already refreshed for them.
#[derive(Debug)]
struct TokenState {
    token: String,
    expires_at: Option<u64>,
    generation: u64,
}

/// Cloneable outcome of a single refresh attempt, shared across all waiters
/// that joined it. `Err` carries the [`RefreshError`] itself (kept `Clone`
/// for [`Shared`]) so its Transient/Terminal kind survives to the await site,
/// where it maps to [`SdkError::Auth`] with `retryable` set accordingly.
type RefreshOutcome = std::result::Result<String, RefreshError>;
type RefreshFuture = Shared<Pin<Box<dyn Future<Output = RefreshOutcome> + Send>>>;

/// In-flight refresh attempt, if any. `epoch` lets the leader that started an
/// attempt clear it on completion without clobbering a newer attempt.
#[derive(Default)]
struct Flight {
    epoch: u64,
    future: Option<RefreshFuture>,
}

/// A bearer-token source with single-flight refresh coalescing.
///
/// Wraps a [`Refresh`] implementation and tracks the current token + its
/// advertised expiry. The high-level [`crate::OpenShellClient`] drives it
/// proactively (before requests, via [`TokenSource::current`]) and reactively
/// (on `Unauthenticated`, via [`TokenSource::refresh_now`]); language bindings
/// can also hand it out directly.
///
/// Single-flight: concurrent callers share one in-flight attempt and observe
/// the same outcome — success *or* failure — so a failing `IdP` is hit once
/// per attempt, not once per waiter.
#[derive(Clone)]
pub struct TokenSource {
    state: Arc<RwLock<TokenState>>,
    refresher: Arc<dyn Refresh>,
    flight: Arc<Mutex<Flight>>,
    /// Refresh `skew` before the advertised `expires_at`. Tokens without
    /// `expires_at` are not auto-refreshed by [`TokenSource::current`].
    skew: Duration,
}

impl TokenSource {
    /// Construct a token source backed by `refresher`. Use this when wiring
    /// an FFI callback or browser flow into the SDK.
    pub fn new(initial: RefreshedToken, refresher: Arc<dyn Refresh>) -> Self {
        Self {
            state: Arc::new(RwLock::new(TokenState {
                token: initial.access_token,
                expires_at: initial.expires_at,
                generation: 0,
            })),
            refresher,
            flight: Arc::new(Mutex::new(Flight::default())),
            skew: Duration::from_mins(1),
        }
    }

    /// Async-fetch the current token, refreshing if it's within `skew` of
    /// expiry. Single-flight: concurrent callers share one refresh.
    ///
    /// This is the *proactive* path. Tokens with no advertised `expires_at`
    /// are returned as-is (never proactively refreshed).
    pub async fn current(&self) -> Result<String> {
        let (generation, near_expiry) = {
            let state = self.state.read().await;
            (state.generation, is_near_expiry(&state, self.skew))
        };
        if !near_expiry {
            return Ok(self.state.read().await.token.clone());
        }
        self.coalesced_refresh(generation).await
    }

    /// Force a refresh regardless of expiry. Used on `Unauthenticated`
    /// responses from the gateway (token revoked / rejected even though it
    /// still looks valid).
    ///
    /// Unlike [`TokenSource::current`] this never short-circuits on expiry:
    /// it always performs a refresh unless a *concurrent* caller's refresh
    /// already advanced the generation while this call was queued.
    pub async fn refresh_now(&self) -> Result<String> {
        let generation = self.state.read().await.generation;
        self.coalesced_refresh(generation).await
    }

    /// Shared refresh primitive. `expected_generation` is the generation the
    /// caller observed before queueing; if the current generation already
    /// moved past it, another caller refreshed and we return that token
    /// without invoking [`Refresh::refresh`] again.
    // `map_or_else` (what `clippy::option_if_let_else` suggests) can't take
    // `&mut flight` in the None arm to publish the new attempt, so keep the
    // explicit `if let`/`else`.
    #[allow(clippy::option_if_let_else)]
    async fn coalesced_refresh(&self, expected_generation: u64) -> Result<String> {
        let shared = {
            let mut flight = self.flight.lock().await;
            // Re-check under the flight lock: a refresh may have completed
            // between our generation read and acquiring this lock.
            {
                let state = self.state.read().await;
                if state.generation != expected_generation {
                    return Ok(state.token.clone());
                }
            }
            if let Some(existing) = flight.future.as_ref() {
                // Join the attempt already in flight.
                existing.clone()
            } else {
                // Become the leader for a fresh attempt. The attempt clears its
                // own slot on completion (below) rather than relying on the
                // leader's post-await code, so cleanup is cancellation-safe: a
                // dropped leader can't strand a completed future in the slot and
                // pin later callers to a stale token.
                let refresher = Arc::clone(&self.refresher);
                let state = Arc::clone(&self.state);
                let flight_slot = Arc::clone(&self.flight);
                let epoch = flight.epoch.wrapping_add(1);
                // Generation this attempt refreshes *from*. If it advances
                // while the refresh is in flight, an external `replace()`
                // installed a newer token and this result must not clobber it.
                let start_generation = expected_generation;
                let future: RefreshFuture = async move {
                    let outcome = match refresher.refresh().await {
                        Ok(token) => {
                            let mut state = state.write().await;
                            if state.generation == start_generation {
                                state.token.clone_from(&token.access_token);
                                state.expires_at = token.expires_at;
                                state.generation = state.generation.wrapping_add(1);
                                Ok(token.access_token)
                            } else {
                                // A concurrent `replace()` (or newer token)
                                // landed mid-flight; honor it rather than
                                // regressing to this now-stale result.
                                Ok(state.token.clone())
                            }
                        }
                        // Carry the `RefreshError` itself so its
                        // Transient/Terminal kind survives; the single
                        // `SdkError` wrap happens at the await site below.
                        Err(err) => Err(err),
                    };
                    // Clear this attempt's slot so the next caller starts a
                    // fresh refresh. Epoch-guarded so a newer attempt is never
                    // clobbered. Runs inside the single shared computation, so
                    // it fires exactly once regardless of which waiter drives it
                    // to completion or whether the leader was dropped.
                    {
                        let mut flight = flight_slot.lock().await;
                        if flight.epoch == epoch {
                            flight.future = None;
                        }
                    }
                    outcome
                }
                .boxed()
                .shared();
                flight.epoch = epoch;
                flight.future = Some(future.clone());
                future
            }
        };

        shared.await.map_err(SdkError::from)
    }

    /// Replace the current token without invoking the refresher.
    ///
    /// Used by callers that manage refresh externally (e.g. the napi
    /// binding's JS-side timer) or for testing. Advances the generation so
    /// any queued coalescing waiters observe the new token.
    pub async fn replace(&self, token: RefreshedToken) {
        let mut state = self.state.write().await;
        state.token = token.access_token;
        state.expires_at = token.expires_at;
        state.generation = state.generation.wrapping_add(1);
    }
}

/// Whether `state`'s token is within `skew` of its advertised expiry. Tokens
/// without an advertised expiry are never near expiry.
fn is_near_expiry(state: &TokenState, skew: Duration) -> bool {
    let Some(expires_at) = state.expires_at else {
        return false;
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    now + skew.as_secs() >= expires_at
}

impl fmt::Debug for TokenSource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TokenSource")
            .field("skew", &self.skew)
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct CountingRefresher {
        calls: Arc<AtomicUsize>,
        delay: Duration,
    }

    #[async_trait::async_trait]
    impl Refresh for CountingRefresher {
        async fn refresh(&self) -> std::result::Result<RefreshedToken, RefreshError> {
            tokio::time::sleep(self.delay).await;
            let n = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
            Ok(RefreshedToken::new(format!("token-{n}")).with_expires_at(
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_secs()
                    + 3600,
            ))
        }
    }

    /// Refresher that blocks inside [`Refresh::refresh`] until the test
    /// releases it, so we can deterministically force multiple callers to be
    /// in flight simultaneously. Signals `entered` once the leader is inside.
    struct GatedRefresher {
        calls: Arc<AtomicUsize>,
        entered: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
        fail: bool,
    }

    #[async_trait::async_trait]
    impl Refresh for GatedRefresher {
        async fn refresh(&self) -> std::result::Result<RefreshedToken, RefreshError> {
            let n = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
            self.entered.notify_one();
            self.release.notified().await;
            if self.fail {
                Err(RefreshError::Transient("idp unavailable".to_string()))
            } else {
                Ok(RefreshedToken::new(format!("token-{n}")).with_expires_at(
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap()
                        .as_secs()
                        + 3600,
                ))
            }
        }
    }

    /// Drive one leader into the refresher, then queue `followers` more
    /// callers that must join the in-flight attempt rather than start their
    /// own. Returns the refresher call count and per-caller outcomes.
    /// Read the committed token straight from state, bypassing any refresh
    /// logic. Test-only inspection helper.
    async fn state_token(source: &TokenSource) -> String {
        source.state.read().await.token.clone()
    }

    async fn run_coalesced(fail: bool) -> (usize, Vec<Result<String>>) {
        let calls = Arc::new(AtomicUsize::new(0));
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let refresher = Arc::new(GatedRefresher {
            calls: Arc::clone(&calls),
            entered: Arc::clone(&entered),
            release: Arc::clone(&release),
            fail,
        });
        let source = TokenSource::new(RefreshedToken::new("initial").with_expires_at(0), refresher);

        let leader = {
            let src = source.clone();
            tokio::spawn(async move { src.refresh_now().await })
        };
        // Wait until the leader is blocked inside the refresher.
        entered.notified().await;

        let followers: Vec<_> = (0..4)
            .map(|_| {
                let src = source.clone();
                tokio::spawn(async move { src.refresh_now().await })
            })
            .collect();
        // Let the followers reach the shared in-flight future before release.
        for _ in 0..16 {
            tokio::task::yield_now().await;
        }
        release.notify_waiters();

        let mut outcomes = vec![leader.await.unwrap()];
        for f in followers {
            outcomes.push(f.await.unwrap());
        }
        (calls.load(Ordering::SeqCst), outcomes)
    }

    #[tokio::test]
    async fn refresh_clears_slot_when_leader_is_cancelled() {
        // Regression: the in-flight slot must be cleared by the shared refresh
        // computation, not by the leader's post-await code. If only the leader
        // cleared it, cancelling the leader would strand a completed future in
        // the slot and pin every later `refresh_now()` to that stale token.
        let calls = Arc::new(AtomicUsize::new(0));
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let refresher = Arc::new(GatedRefresher {
            calls: Arc::clone(&calls),
            entered: Arc::clone(&entered),
            release: Arc::clone(&release),
            fail: false,
        });
        let source = TokenSource::new(RefreshedToken::new("initial").with_expires_at(0), refresher);

        // Leader enters the refresher, then is cancelled before it completes.
        let leader = {
            let src = source.clone();
            tokio::spawn(async move { src.refresh_now().await })
        };
        entered.notified().await;
        leader.abort();
        let _ = leader.await;

        // A follower joins and drives the in-flight attempt to completion.
        let follower = {
            let src = source.clone();
            tokio::spawn(async move { src.refresh_now().await })
        };
        for _ in 0..16 {
            tokio::task::yield_now().await;
        }
        release.notify_waiters();
        assert_eq!(follower.await.unwrap().unwrap(), "token-1");
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        // The completed attempt must have cleared the slot, so the next refresh
        // starts a new attempt instead of re-joining the stale completed one.
        let next = {
            let src = source.clone();
            tokio::spawn(async move { src.refresh_now().await })
        };
        entered.notified().await;
        for _ in 0..16 {
            tokio::task::yield_now().await;
        }
        release.notify_waiters();
        assert_eq!(next.await.unwrap().unwrap(), "token-2");
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn debug_omits_access_token() {
        let token = RefreshedToken::new("super-secret-value").with_expires_at(123);
        let rendered = format!("{token:?}");
        assert!(!rendered.contains("super-secret-value"));
        assert!(rendered.contains("expires_at"));
    }

    #[tokio::test]
    async fn concurrent_callers_share_one_refresh() {
        let (calls, outcomes) = run_coalesced(false).await;
        assert_eq!(
            calls, 1,
            "single-flight should collapse 5 concurrent calls into 1 refresh"
        );
        for outcome in &outcomes {
            assert_eq!(outcome.as_ref().unwrap(), "token-1");
        }
    }

    #[tokio::test]
    async fn current_returns_cached_when_not_near_expiry() {
        let calls = Arc::new(AtomicUsize::new(0));
        let refresher = Arc::new(CountingRefresher {
            calls: Arc::clone(&calls),
            delay: Duration::from_millis(0),
        });
        let future = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 3600;
        let source = TokenSource::new(
            RefreshedToken::new("fresh").with_expires_at(future),
            refresher,
        );

        let token = source.current().await.unwrap();
        assert_eq!(token, "fresh");
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn current_refreshes_when_within_skew() {
        let calls = Arc::new(AtomicUsize::new(0));
        let refresher = Arc::new(CountingRefresher {
            calls: Arc::clone(&calls),
            delay: Duration::from_millis(0),
        });
        let near = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 5;
        let source = TokenSource::new(
            RefreshedToken::new("stale").with_expires_at(near),
            refresher,
        );

        let token = source.current().await.unwrap();
        assert_eq!(token, "token-1");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn refresh_now_forces_even_for_unexpired_token() {
        // A token whose advertised expiry is far in the future. `current()`
        // would short-circuit, but `refresh_now()` must still refresh — this
        // is the revoked-but-unexpired recovery path.
        let calls = Arc::new(AtomicUsize::new(0));
        let refresher = Arc::new(CountingRefresher {
            calls: Arc::clone(&calls),
            delay: Duration::from_millis(0),
        });
        let far_future = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 3600;
        let source = TokenSource::new(
            RefreshedToken::new("revoked").with_expires_at(far_future),
            refresher,
        );

        let token = source.refresh_now().await.unwrap();
        assert_eq!(token, "token-1", "forced refresh must mint a new token");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            state_token(&source).await,
            "token-1",
            "state must observe new token"
        );
    }

    #[tokio::test]
    async fn in_flight_refresh_preserves_external_replace() {
        // Regression (P2b): a `replace()` that lands while a refresh is in
        // flight must survive. The in-flight refresh started from an older
        // generation, so its result is discarded in favor of the externally
        // installed token instead of clobbering it.
        let calls = Arc::new(AtomicUsize::new(0));
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let refresher = Arc::new(GatedRefresher {
            calls: Arc::clone(&calls),
            entered: Arc::clone(&entered),
            release: Arc::clone(&release),
            fail: false,
        });
        let source = TokenSource::new(RefreshedToken::new("initial").with_expires_at(0), refresher);

        // Leader starts a refresh and blocks inside refresher.refresh().
        let leader = {
            let src = source.clone();
            tokio::spawn(async move { src.refresh_now().await })
        };
        entered.notified().await;

        // External rotation installs an authoritative token mid-flight.
        source
            .replace(
                RefreshedToken::new("external-rotation").with_expires_at(
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap()
                        .as_secs()
                        + 3600,
                ),
            )
            .await;

        // Release the in-flight refresh; it must yield to the replacement.
        release.notify_waiters();
        let leader_token = leader.await.unwrap().unwrap();

        assert_eq!(
            leader_token, "external-rotation",
            "leader must observe the external replacement, not its own result"
        );
        assert_eq!(
            state_token(&source).await,
            "external-rotation",
            "replace() must survive the in-flight refresh"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn concurrent_forced_refresh_shares_one_failure() {
        // A failing IdP must be hit once per attempt, not once per waiter.
        let (calls, outcomes) = run_coalesced(true).await;
        assert_eq!(
            calls, 1,
            "single-flight should collapse 5 concurrent failed calls into 1 refresh"
        );
        assert_eq!(outcomes.len(), 5);
        for outcome in &outcomes {
            assert!(outcome.is_err(), "every waiter should observe the failure");
        }
    }

    #[test]
    fn refresh_error_maps_to_classified_auth() {
        // The Transient/Terminal split must survive conversion into `SdkError`
        // so consumers can tell a retryable blip from a dead session, and the
        // message must be wrapped exactly once.
        let transient = SdkError::from(RefreshError::Transient("blip".into()));
        assert!(transient.retryable(), "transient refresh is retryable");
        assert_eq!(
            transient.to_string(),
            "auth error: transient refresh error: blip",
            "single wrap, no doubled `auth error:` prefix"
        );

        let terminal = SdkError::from(RefreshError::Terminal("revoked".into()));
        assert!(!terminal.retryable(), "terminal refresh needs re-auth");
        assert_eq!(terminal.code(), "auth");
    }

    #[tokio::test]
    async fn terminal_refresh_surfaces_non_retryable() {
        // End-to-end: a Terminal error from the refresher reaches the caller as
        // a non-retryable auth error through the shared single-flight path.
        struct TerminalRefresher;
        #[async_trait::async_trait]
        impl Refresh for TerminalRefresher {
            async fn refresh(&self) -> std::result::Result<RefreshedToken, RefreshError> {
                Err(RefreshError::Terminal("session revoked".into()))
            }
        }
        let source = TokenSource::new(
            RefreshedToken::new("initial").with_expires_at(0),
            Arc::new(TerminalRefresher),
        );
        let err = source.refresh_now().await.expect_err("refresh must fail");
        assert!(!err.retryable(), "terminal failure is not retryable");
        assert!(
            err.to_string()
                .contains("terminal refresh error: session revoked")
        );
    }
}
