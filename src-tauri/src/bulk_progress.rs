//! Counts committed/attempted items, never elapsed-time estimates or private paths.
use std::sync::{Mutex, MutexGuard};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::dictionary::store::CompactionResult;

/// Both stores' automatic and manual rewrites share this lock: only one temporary copy at a time.
pub(crate) static MAINTENANCE: Mutex<()> = Mutex::new(());

/// The running rewrite's interrupt handle, so that quitting can stop it.
static REWRITE: Mutex<Option<rusqlite::InterruptHandle>> = Mutex::new(None);

/// Runs a store rewrite that `finish_maintenance` can interrupt; SQLite then rolls it back. A
/// `VACUUM` already writing the store back cannot be interrupted and runs to its end.
pub(crate) fn interruptible<T>(
    connection: &rusqlite::Connection,
    rewrite: impl FnOnce() -> T,
) -> T {
    *REWRITE.lock().unwrap_or_else(|p| p.into_inner()) = Some(connection.get_interrupt_handle());
    let result = rewrite();
    *REWRITE.lock().unwrap_or_else(|p| p.into_inner()) = None;
    result
}

/// Before quitting: interrupts a running rewrite and waits until it has rolled back or ended, so no
/// store is left with a half-written journal. Holding the guard keeps later rewrites from starting.
pub(crate) fn finish_maintenance() -> MutexGuard<'static, ()> {
    if let Some(rewrite) = REWRITE.lock().unwrap_or_else(|p| p.into_inner()).as_ref() {
        rewrite.interrupt();
    }
    MAINTENANCE.lock().unwrap_or_else(|p| p.into_inner())
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Progress {
    pub(crate) operation_id: String,
    pub(crate) completed: usize,
    pub(crate) total: Option<usize>,
    pub(crate) phase: &'static str,
}

pub(crate) struct BatchProgress {
    value: Progress,
    emit: Box<dyn Fn(Progress) + Send>,
}

impl BatchProgress {
    pub(crate) fn for_app(app: AppHandle, operation_id: Option<String>) -> Result<Self, String> {
        let id = operation_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        if uuid::Uuid::parse_str(&id).is_err() || id.len() != 36 {
            return Err("Invalid operation ID.".into());
        }
        Ok(Self::new(id, move |progress| {
            let _ = app.emit_to("main", "bulk-progress", progress);
        }))
    }

    pub(crate) fn new(id: String, emit: impl Fn(Progress) + Send + 'static) -> Self {
        Self {
            value: Progress {
                operation_id: id,
                completed: 0,
                total: None,
                phase: "waiting",
            },
            emit: Box::new(emit),
        }
    }

    pub(crate) fn silent() -> Self {
        Self::new(String::new(), |_| {})
    }

    pub(crate) fn phase(&mut self, phase: &'static str) {
        self.value.phase = phase;
        (self.emit)(self.value.clone());
    }

    pub(crate) fn start(&mut self, total: usize) {
        self.value.total = Some(total);
        self.phase("processing");
    }

    pub(crate) fn completed_one(&mut self) {
        self.value.completed += 1;
        (self.emit)(self.value.clone());
    }
}

/// Deletion success and space-reclamation success are independent outcomes.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemovalBatch<T> {
    pub(crate) results: T,
    pub(crate) maintenance: Option<CompactionResult>,
}

/// A store is rewritten only once its free pages reach this much, or a tenth of its size if more.
pub(crate) const COMPACTION_MINIMUM_FREE: u64 = 256 * 1024 * 1024;

/// Whether a store's free pages are worth a rewrite: at least `minimum` bytes and a tenth of
/// `size`. A store whose free space cannot be read is rewritten, as before.
pub(crate) fn compaction_needed(
    connection: &rusqlite::Connection,
    size: u64,
    minimum: u64,
) -> bool {
    let free = connection
        .query_row("PRAGMA freelist_count", [], |row| row.get::<_, i64>(0))
        .and_then(|pages| {
            let page: i64 = connection.query_row("PRAGMA page_size", [], |row| row.get(0))?;
            Ok(pages.max(0) as u64 * page.max(0) as u64)
        });
    free.map_or(true, |free| free >= minimum.max(size / 10))
}

pub(crate) fn reclaim(
    progress: &mut BatchProgress,
    removed: bool,
    needed: impl FnOnce() -> bool,
    compact: impl FnOnce() -> Result<CompactionResult, String>,
) -> Option<CompactionResult> {
    if !removed {
        return None;
    }
    if !needed() {
        return Some(CompactionResult::NotNeeded);
    }
    progress.phase("reclaiming");
    let _maintenance = MAINTENANCE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    Some(compact().unwrap_or(CompactionResult::Failed))
}

#[cfg(test)]
pub(crate) fn recording() -> (BatchProgress, std::sync::Arc<Mutex<Vec<Progress>>>) {
    let events = std::sync::Arc::new(Mutex::new(Vec::new()));
    let captured = std::sync::Arc::clone(&events);
    (
        BatchProgress::new(uuid::Uuid::new_v4().to_string(), move |value| {
            captured.lock().unwrap().push(value)
        }),
        events,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Barrier,
    };

    #[test]
    fn quitting_interrupts_a_running_rewrite_and_waits_for_it() {
        let started = Arc::new(Barrier::new(2));
        let signal = Arc::clone(&started);
        let ended = Arc::new(AtomicUsize::new(0));
        let end = Arc::clone(&ended);
        let rewrite = std::thread::spawn(move || {
            let connection = rusqlite::Connection::open_in_memory().unwrap();
            let mut progress = BatchProgress::silent();
            reclaim(
                &mut progress,
                true,
                || true,
                || {
                    let result = interruptible(&connection, || {
                        signal.wait();
                        // Long work, as a large VACUUM is, that an interrupt cuts short.
                        connection.query_row(
                            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n
                         WHERE i < 1000000000) SELECT count(*) FROM n",
                            [],
                            |row| row.get::<_, i64>(0),
                        )
                    });
                    end.store(1, Ordering::SeqCst);
                    result
                        .map(|_| CompactionResult::Compacted {
                            size_before: 1,
                            size_after: 1,
                        })
                        .map_err(|error| error.to_string())
                },
            )
        });
        started.wait();
        std::thread::sleep(std::time::Duration::from_millis(50));
        let guard = finish_maintenance();
        assert_eq!(ended.load(Ordering::SeqCst), 1);
        assert!(matches!(
            rewrite.join().unwrap(),
            Some(CompactionResult::Failed)
        ));
        assert!(REWRITE.lock().unwrap().is_none());
        drop(guard);
    }

    #[test]
    fn concurrent_reclamation_is_serialized_and_failures_are_independent() {
        let barrier = Arc::new(Barrier::new(3));
        let active = Arc::new(AtomicUsize::new(0));
        let maximum = Arc::new(AtomicUsize::new(0));
        let mut threads = Vec::new();
        for index in 0..2 {
            let (barrier, active, maximum) = (
                Arc::clone(&barrier),
                Arc::clone(&active),
                Arc::clone(&maximum),
            );
            threads.push(std::thread::spawn(move || {
                let mut progress = BatchProgress::silent();
                progress.start(1);
                progress.completed_one();
                barrier.wait();
                reclaim(
                    &mut progress,
                    true,
                    || true,
                    || {
                        maximum
                            .fetch_max(active.fetch_add(1, Ordering::SeqCst) + 1, Ordering::SeqCst);
                        std::thread::sleep(std::time::Duration::from_millis(10));
                        active.fetch_sub(1, Ordering::SeqCst);
                        if index == 0 {
                            Err("refused".into())
                        } else {
                            Ok(CompactionResult::Compacted {
                                size_before: 2,
                                size_after: 1,
                            })
                        }
                    },
                )
            }));
        }
        barrier.wait();
        assert_eq!(
            threads.remove(0).join().unwrap(),
            Some(CompactionResult::Failed)
        );
        assert!(matches!(
            threads.remove(0).join().unwrap(),
            Some(CompactionResult::Compacted { .. })
        ));
        assert_eq!(maximum.load(Ordering::SeqCst), 1);
        assert_eq!(
            reclaim(
                &mut BatchProgress::silent(),
                false,
                || true,
                || panic!("no successful deletions")
            ),
            None
        );
    }
}
