// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Lazy pagination primitives for curated SDK list methods.

use crate::error::Result;
use std::future::Future;
use std::pin::Pin;

type PageFuture<T> = Pin<Box<dyn Future<Output = Result<Page<T>>> + Send>>;
type PageFetcher<T> = Box<dyn Fn(String) -> PageFuture<T> + Send + Sync>;

/// One response page from a list operation.
#[derive(Clone, Debug)]
pub struct Page<T> {
    /// Resources returned by this request.
    pub items: Vec<T>,
    /// Opaque token that resumes after this page, or an empty string at the end.
    pub next_page_token: String,
}

/// A lazy, single-pass iterator over response pages.
///
/// Constructed by curated `list_*` methods. No RPC is issued until
/// [`Pager::next_page`] is called, and each call fetches one logical page.
/// A refreshed OIDC credential may retry that page once after an
/// `Unauthenticated` response.
pub struct Pager<T> {
    fetch: PageFetcher<T>,
    next_page_token: Option<String>,
}

impl<T> Pager<T> {
    pub(crate) fn new<F, Fut>(page_token: String, fetch: F) -> Self
    where
        F: Fn(String) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Page<T>>> + Send + 'static,
    {
        Self {
            fetch: Box::new(move |token| Box::pin(fetch(token))),
            next_page_token: Some(page_token),
        }
    }

    /// Fetch the next page, or return `None` after the final page.
    pub async fn next_page(&mut self) -> Result<Option<Page<T>>> {
        let Some(page_token) = self.next_page_token.clone() else {
            return Ok(None);
        };
        let page = (self.fetch)(page_token).await?;
        self.next_page_token =
            (!page.next_page_token.is_empty()).then(|| page.next_page_token.clone());
        Ok(Some(page))
    }

    /// Consume the pager and collect every remaining item.
    pub async fn collect_all(mut self) -> Result<Vec<T>> {
        let mut items = Vec::new();
        while let Some(page) = self.next_page().await? {
            items.extend(page.items);
        }
        Ok(items)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn pager_is_lazy_and_fetches_one_page_at_a_time() {
        let calls = Arc::new(AtomicUsize::new(0));
        let observed = calls.clone();
        let mut pager = Pager::new("resume".to_string(), move |token| {
            let calls = observed.clone();
            async move {
                let call = calls.fetch_add(1, Ordering::SeqCst);
                if call == 0 {
                    assert_eq!(token, "resume");
                    Ok(Page {
                        items: vec![1],
                        next_page_token: "next".to_string(),
                    })
                } else {
                    assert_eq!(token, "next");
                    Ok(Page {
                        items: vec![2],
                        next_page_token: String::new(),
                    })
                }
            }
        });

        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(pager.next_page().await.unwrap().unwrap().items, vec![1]);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(pager.next_page().await.unwrap().unwrap().items, vec![2]);
        assert!(pager.next_page().await.unwrap().is_none());
    }

    #[tokio::test]
    async fn collect_all_consumes_remaining_pages() {
        let pager = Pager::new(String::new(), |token| async move {
            if token.is_empty() {
                Ok(Page {
                    items: vec![1, 2],
                    next_page_token: "next".to_string(),
                })
            } else {
                Ok(Page {
                    items: vec![3],
                    next_page_token: String::new(),
                })
            }
        });

        assert_eq!(pager.collect_all().await.unwrap(), vec![1, 2, 3]);
    }

    #[tokio::test]
    async fn failed_fetch_retries_the_same_token() {
        let calls = Arc::new(AtomicUsize::new(0));
        let observed = calls.clone();
        let mut pager = Pager::new("resume".to_string(), move |token| {
            let calls = observed.clone();
            async move {
                assert_eq!(token, "resume");
                if calls.fetch_add(1, Ordering::SeqCst) == 0 {
                    Err(crate::error::SdkError::connect("temporary failure"))
                } else {
                    Ok(Page {
                        items: vec![1],
                        next_page_token: String::new(),
                    })
                }
            }
        });

        assert!(pager.next_page().await.is_err());
        assert_eq!(pager.next_page().await.unwrap().unwrap().items, vec![1]);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }
}
