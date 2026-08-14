//! Shared provider scheduling, retry and failure isolation.

use crate::{
    ModelProvider, ProviderError, ProviderErrorKind, ProviderStream, StopReason, TurnEvent,
    TurnRequest,
};
use async_stream::stream;
use futures_util::StreamExt;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;
use zaalis_core::ProviderId;

#[derive(Debug, Clone)]
pub struct PoolConfig {
    pub global_concurrency: usize,
    pub max_retries: u8,
    pub base_backoff: Duration,
    pub max_backoff: Duration,
    pub circuit_failure_threshold: u32,
    pub circuit_cooldown: Duration,
}

impl Default for PoolConfig {
    fn default() -> Self {
        Self {
            global_concurrency: 16,
            max_retries: 3,
            base_backoff: Duration::from_millis(250),
            max_backoff: Duration::from_secs(10),
            circuit_failure_threshold: 5,
            circuit_cooldown: Duration::from_secs(30),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ProviderStats {
    pub turns_started: u64,
    pub turns_completed: u64,
    pub turns_failed: u64,
    pub turns_cancelled: u64,
    pub retries: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

#[derive(Debug, Default)]
struct AtomicStats {
    turns_started: AtomicU64,
    turns_completed: AtomicU64,
    turns_failed: AtomicU64,
    turns_cancelled: AtomicU64,
    retries: AtomicU64,
    input_tokens: AtomicU64,
    output_tokens: AtomicU64,
}

impl AtomicStats {
    fn snapshot(&self) -> ProviderStats {
        let read = |value: &AtomicU64| value.load(Ordering::Relaxed);
        ProviderStats {
            turns_started: read(&self.turns_started),
            turns_completed: read(&self.turns_completed),
            turns_failed: read(&self.turns_failed),
            turns_cancelled: read(&self.turns_cancelled),
            retries: read(&self.retries),
            input_tokens: read(&self.input_tokens),
            output_tokens: read(&self.output_tokens),
        }
    }
}

#[derive(Debug, Default)]
struct CircuitState {
    consecutive_failures: u32,
    open_until: Option<Instant>,
}

#[derive(Debug)]
struct Entry {
    provider: Arc<dyn ModelProvider>,
    semaphore: Arc<Semaphore>,
    stats: Arc<AtomicStats>,
    circuit: Arc<Mutex<CircuitState>>,
}

impl Clone for Entry {
    fn clone(&self) -> Self {
        Self {
            provider: Arc::clone(&self.provider),
            semaphore: Arc::clone(&self.semaphore),
            stats: Arc::clone(&self.stats),
            circuit: Arc::clone(&self.circuit),
        }
    }
}

/// One pool is shared by every session and agent tree.
#[derive(Debug)]
pub struct ProviderPool {
    config: PoolConfig,
    global: Arc<Semaphore>,
    providers: RwLock<HashMap<ProviderId, Entry>>,
}

impl ProviderPool {
    pub fn new(config: PoolConfig) -> Self {
        let global_concurrency = config.global_concurrency.max(1);
        Self {
            config,
            global: Arc::new(Semaphore::new(global_concurrency)),
            providers: RwLock::new(HashMap::new()),
        }
    }

    /// Register or replace one adapter. The semaphore follows its declared
    /// capacity, so local engines naturally serialize requests.
    pub fn register(&self, provider: Arc<dyn ModelProvider>) {
        let capacity = usize::from(provider.capabilities().max_concurrency.max(1));
        self.providers
            .write()
            .expect("provider registry poisoned")
            .insert(
                provider.id(),
                Entry {
                    provider,
                    semaphore: Arc::new(Semaphore::new(capacity)),
                    stats: Arc::new(AtomicStats::default()),
                    circuit: Arc::new(Mutex::new(CircuitState::default())),
                },
            );
    }

    pub fn contains(&self, provider: ProviderId) -> bool {
        self.providers
            .read()
            .expect("provider registry poisoned")
            .contains_key(&provider)
    }

    pub fn metadata(&self, provider: ProviderId) -> Option<(String, crate::Capabilities)> {
        self.providers
            .read()
            .expect("provider registry poisoned")
            .get(&provider)
            .map(|entry| {
                (
                    entry.provider.default_model().to_owned(),
                    entry.provider.capabilities(),
                )
            })
    }

    pub fn stats(&self, provider: ProviderId) -> Option<ProviderStats> {
        self.providers
            .read()
            .expect("provider registry poisoned")
            .get(&provider)
            .map(|entry| entry.stats.snapshot())
    }

    pub async fn stream_turn(
        &self,
        request: TurnRequest,
        cancel: CancellationToken,
    ) -> Result<ProviderStream, ProviderError> {
        let provider_id = request.binding.provider;
        let entry = self
            .providers
            .read()
            .expect("provider registry poisoned")
            .get(&provider_id)
            .cloned()
            .ok_or_else(|| {
                ProviderError::new(
                    ProviderErrorKind::Unavailable,
                    format!("provider {provider_id} non configuré"),
                )
            })?;
        self.ensure_circuit_closed(&entry, provider_id)?;

        let global_permit = acquire(Arc::clone(&self.global), &cancel).await?;
        let provider_permit = acquire(Arc::clone(&entry.semaphore), &cancel).await?;
        entry.stats.turns_started.fetch_add(1, Ordering::Relaxed);

        let mut attempt = 0_u8;
        let source = loop {
            match entry
                .provider
                .stream_turn(request.clone(), cancel.clone())
                .await
            {
                Ok(stream) => {
                    self.record_setup_success(&entry);
                    break stream;
                }
                Err(error) if error.is_retryable() && attempt < self.config.max_retries => {
                    attempt += 1;
                    entry.stats.retries.fetch_add(1, Ordering::Relaxed);
                    let delay = retry_delay(&self.config, attempt, error.retry_after_ms);
                    tokio::select! {
                        _ = cancel.cancelled() => {
                            entry.stats.turns_cancelled.fetch_add(1, Ordering::Relaxed);
                            return Err(ProviderError::new(ProviderErrorKind::Cancelled, "requête annulée"));
                        }
                        _ = tokio::time::sleep(delay) => {}
                    }
                }
                Err(error) => {
                    self.record_setup_failure(&entry);
                    entry.stats.turns_failed.fetch_add(1, Ordering::Relaxed);
                    return Err(error);
                }
            }
        };

        Ok(instrument_stream(
            source,
            entry.stats,
            global_permit,
            provider_permit,
        ))
    }

    fn ensure_circuit_closed(
        &self,
        entry: &Entry,
        provider: ProviderId,
    ) -> Result<(), ProviderError> {
        let mut circuit = entry.circuit.lock().expect("provider circuit poisoned");
        if let Some(until) = circuit.open_until {
            if Instant::now() < until {
                return Err(ProviderError::new(
                    ProviderErrorKind::Unavailable,
                    format!("circuit du provider {provider} temporairement ouvert"),
                ));
            }
            circuit.open_until = None;
            circuit.consecutive_failures = 0;
        }
        Ok(())
    }

    fn record_setup_success(&self, entry: &Entry) {
        let mut circuit = entry.circuit.lock().expect("provider circuit poisoned");
        circuit.consecutive_failures = 0;
        circuit.open_until = None;
    }

    fn record_setup_failure(&self, entry: &Entry) {
        let mut circuit = entry.circuit.lock().expect("provider circuit poisoned");
        circuit.consecutive_failures = circuit.consecutive_failures.saturating_add(1);
        if circuit.consecutive_failures >= self.config.circuit_failure_threshold.max(1) {
            circuit.open_until = Instant::now().checked_add(self.config.circuit_cooldown);
        }
    }
}

async fn acquire(
    semaphore: Arc<Semaphore>,
    cancel: &CancellationToken,
) -> Result<OwnedSemaphorePermit, ProviderError> {
    tokio::select! {
        _ = cancel.cancelled() => Err(ProviderError::new(ProviderErrorKind::Cancelled, "requête annulée")),
        permit = semaphore.acquire_owned() => permit.map_err(|_| {
            ProviderError::new(ProviderErrorKind::Unavailable, "ordonnanceur provider fermé")
        }),
    }
}

fn retry_delay(config: &PoolConfig, attempt: u8, retry_after_ms: Option<u64>) -> Duration {
    if let Some(milliseconds) = retry_after_ms {
        return Duration::from_millis(milliseconds).min(config.max_backoff);
    }
    let multiplier = 1_u32
        .checked_shl(u32::from(attempt.saturating_sub(1)))
        .unwrap_or(u32::MAX);
    config
        .base_backoff
        .saturating_mul(multiplier)
        .min(config.max_backoff)
}

fn instrument_stream(
    mut source: ProviderStream,
    stats: Arc<AtomicStats>,
    global_permit: OwnedSemaphorePermit,
    provider_permit: OwnedSemaphorePermit,
) -> ProviderStream {
    let output = stream! {
        let _permits = (global_permit, provider_permit);
        let mut terminal = false;
        while let Some(event) = source.next().await {
            match &event {
                TurnEvent::Usage { usage } => {
                    stats.input_tokens.fetch_add(usage.input_tokens, Ordering::Relaxed);
                    stats.output_tokens.fetch_add(usage.output_tokens, Ordering::Relaxed);
                }
                TurnEvent::Completed { reason: StopReason::Cancelled } => {
                    stats.turns_cancelled.fetch_add(1, Ordering::Relaxed);
                    terminal = true;
                }
                TurnEvent::Completed { .. } => {
                    stats.turns_completed.fetch_add(1, Ordering::Relaxed);
                    terminal = true;
                }
                TurnEvent::Failed { .. } => {
                    stats.turns_failed.fetch_add(1, Ordering::Relaxed);
                    terminal = true;
                }
                _ => {}
            }
            yield event;
            if terminal {
                break;
            }
        }
    };
    Box::pin(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Capabilities, Message};
    use async_trait::async_trait;
    use futures_util::stream;
    use std::sync::atomic::AtomicUsize;
    use tokio::time::timeout;
    use zaalis_core::ModelBinding;

    #[derive(Debug)]
    struct FakeProvider {
        id: ProviderId,
        concurrency: u8,
        failures_left: AtomicUsize,
    }

    #[async_trait]
    impl ModelProvider for FakeProvider {
        fn id(&self) -> ProviderId {
            self.id
        }

        fn capabilities(&self) -> crate::Capabilities {
            Capabilities {
                max_concurrency: self.concurrency,
                ..Capabilities::default()
            }
        }

        async fn stream_turn(
            &self,
            _request: TurnRequest,
            _cancel: CancellationToken,
        ) -> Result<ProviderStream, ProviderError> {
            if self
                .failures_left
                .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |left| {
                    left.checked_sub(1)
                })
                .is_ok()
            {
                return Err(ProviderError::rate_limited("429", Some(0)));
            }
            Ok(stream::iter(vec![
                TurnEvent::TextDelta { text: "ok".into() },
                TurnEvent::Completed {
                    reason: StopReason::EndTurn,
                },
            ])
            .boxed())
        }
    }

    fn request(id: ProviderId) -> TurnRequest {
        TurnRequest::new(ModelBinding::new(id, None), "", vec![Message::user("go")])
    }

    #[tokio::test]
    async fn transient_setup_errors_are_retried_then_succeed() {
        let pool = ProviderPool::new(PoolConfig {
            base_backoff: Duration::ZERO,
            max_backoff: Duration::ZERO,
            ..PoolConfig::default()
        });
        pool.register(Arc::new(FakeProvider {
            id: ProviderId::Mistral,
            concurrency: 4,
            failures_left: AtomicUsize::new(2),
        }));

        let mut events = pool
            .stream_turn(request(ProviderId::Mistral), CancellationToken::new())
            .await
            .expect("retry succeeds");
        while events.next().await.is_some() {}
        let stats = pool.stats(ProviderId::Mistral).expect("stats");
        assert_eq!(stats.retries, 2);
        assert_eq!(stats.turns_completed, 1);
    }

    #[tokio::test]
    async fn provider_capacity_is_held_until_the_stream_is_dropped() {
        let pool = Arc::new(ProviderPool::new(PoolConfig::default()));
        pool.register(Arc::new(FakeProvider {
            id: ProviderId::Local,
            concurrency: 1,
            failures_left: AtomicUsize::new(0),
        }));
        let first = pool
            .stream_turn(request(ProviderId::Local), CancellationToken::new())
            .await
            .expect("first");

        let waiting_pool = Arc::clone(&pool);
        let mut waiting = tokio::spawn(async move {
            waiting_pool
                .stream_turn(request(ProviderId::Local), CancellationToken::new())
                .await
        });
        tokio::task::yield_now().await;
        assert!(timeout(Duration::from_millis(20), &mut waiting)
            .await
            .is_err());
        drop(first);
        let resumed = timeout(Duration::from_secs(1), waiting)
            .await
            .expect("second request resumes")
            .expect("task");
        assert!(resumed.is_ok());
    }

    #[tokio::test]
    async fn one_open_circuit_does_not_block_another_provider() {
        let pool = ProviderPool::new(PoolConfig {
            max_retries: 0,
            circuit_failure_threshold: 1,
            ..PoolConfig::default()
        });
        pool.register(Arc::new(FakeProvider {
            id: ProviderId::Mistral,
            concurrency: 1,
            failures_left: AtomicUsize::new(1),
        }));
        pool.register(Arc::new(FakeProvider {
            id: ProviderId::Local,
            concurrency: 1,
            failures_left: AtomicUsize::new(0),
        }));
        assert!(pool
            .stream_turn(request(ProviderId::Mistral), CancellationToken::new())
            .await
            .is_err());
        let second = pool
            .stream_turn(request(ProviderId::Mistral), CancellationToken::new())
            .await;
        let second = match second {
            Ok(_) => panic!("circuit should be open"),
            Err(error) => error,
        };
        assert_eq!(second.kind, ProviderErrorKind::Unavailable);
        assert!(pool
            .stream_turn(request(ProviderId::Local), CancellationToken::new())
            .await
            .is_ok());
    }
}
