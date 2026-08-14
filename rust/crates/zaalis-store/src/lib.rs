//! Durable zaalis state.
//!
//! SQLite stores structure and opaque credential references; provider keys and
//! MCP tokens live in the operating system credential vault. The importer can
//! read the legacy JSON/AES-GCM layout repeatedly without duplicating rows.

mod import;
mod secret;

pub use import::{ImportReport, ImportWarning, LegacyImporter};
pub use secret::{MemorySecretStore, OsSecretStore, SecretRef, SecretStore, SecretValue};

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::Value;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;
use zaalis_core::{now_ms, Result, SessionId, ZaalisError};
use zaalis_protocol::EventFrame;

const SCHEMA_VERSION: i64 = 1;

#[derive(Debug)]
pub struct Store {
    connection: Mutex<Connection>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct StoredSession {
    pub payload: Value,
    pub status: String,
}

impl Store {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let connection = Connection::open(path).map_err(sql_error)?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(sql_error)?;
        connection
            .execute_batch(
                "PRAGMA foreign_keys=ON;
                 PRAGMA journal_mode=WAL;
                 PRAGMA synchronous=FULL;
                 PRAGMA temp_store=MEMORY;",
            )
            .map_err(sql_error)?;
        migrate(&connection)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    pub fn journal_mode(&self) -> Result<String> {
        self.connection
            .lock()
            .expect("store lock poisoned")
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .map_err(sql_error)
    }

    pub fn schema_version(&self) -> Result<i64> {
        self.connection
            .lock()
            .expect("store lock poisoned")
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(sql_error)
    }

    pub fn upsert_user(&self, id: &str, profile: &Value) -> Result<()> {
        if id.trim().is_empty() {
            return Err(ZaalisError::invalid("identifiant utilisateur vide"));
        }
        let now = now_ms() as i64;
        self.connection
            .lock()
            .expect("store lock poisoned")
            .execute(
                "INSERT INTO users(id, profile_json, created_at_ms, updated_at_ms)
                 VALUES(?1, ?2, ?3, ?3)
                 ON CONFLICT(id) DO UPDATE SET profile_json=excluded.profile_json,
                    updated_at_ms=excluded.updated_at_ms",
                params![id, serde_json::to_string(profile)?, now],
            )
            .map_err(sql_error)?;
        Ok(())
    }

    pub fn user(&self, id: &str) -> Result<Option<Value>> {
        let json: Option<String> = self
            .connection
            .lock()
            .expect("store lock poisoned")
            .query_row("SELECT profile_json FROM users WHERE id=?1", [id], |row| {
                row.get(0)
            })
            .optional()
            .map_err(sql_error)?;
        json.map(|json| serde_json::from_str(&json).map_err(Into::into))
            .transpose()
    }

    pub fn upsert_conversation(
        &self,
        id: &str,
        user_id: &str,
        kind: &str,
        payload: &Value,
    ) -> Result<()> {
        if !matches!(kind, "chat" | "agents") {
            return Err(ZaalisError::invalid("type de conversation invalide"));
        }
        let project = payload
            .get("project")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let title = payload
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or_default();
        self.connection
            .lock()
            .expect("store lock poisoned")
            .execute(
                "INSERT INTO conversations(id,user_id,kind,project,title,payload_json,updated_at_ms)
                 VALUES(?1,?2,?3,?4,?5,?6,?7)
                 ON CONFLICT(id,user_id,kind) DO UPDATE SET project=excluded.project,
                    title=excluded.title,payload_json=excluded.payload_json,
                    updated_at_ms=excluded.updated_at_ms",
                params![
                    id,
                    user_id,
                    kind,
                    project,
                    title,
                    serde_json::to_string(payload)?,
                    now_ms() as i64
                ],
            )
            .map_err(sql_error)?;
        Ok(())
    }

    pub fn conversations(&self, user_id: &str, kind: &str) -> Result<Vec<Value>> {
        let connection = self.connection.lock().expect("store lock poisoned");
        let mut statement = connection
            .prepare(
                "SELECT payload_json FROM conversations WHERE user_id=?1 AND kind=?2
                 ORDER BY updated_at_ms,id",
            )
            .map_err(sql_error)?;
        let rows = statement
            .query_map(params![user_id, kind], |row| row.get::<_, String>(0))
            .map_err(sql_error)?;
        let mut values = Vec::new();
        for row in rows {
            values.push(serde_json::from_str(&row.map_err(sql_error)?)?);
        }
        Ok(values)
    }

    pub fn save_session(&self, id: &SessionId, tree: &Value, status: &str) -> Result<()> {
        let now = now_ms() as i64;
        self.connection
            .lock()
            .expect("store lock poisoned")
            .execute(
                "INSERT INTO sessions(id,tree_json,status,created_at_ms,updated_at_ms)
                 VALUES(?1,?2,?3,?4,?4)
                 ON CONFLICT(id) DO UPDATE SET tree_json=excluded.tree_json,
                    status=excluded.status,updated_at_ms=excluded.updated_at_ms",
                params![id.as_str(), serde_json::to_string(tree)?, status, now],
            )
            .map_err(sql_error)?;
        Ok(())
    }

    pub fn session(&self, id: &SessionId) -> Result<Option<StoredSession>> {
        let record: Option<(String, String)> = self
            .connection
            .lock()
            .expect("store lock poisoned")
            .query_row(
                "SELECT tree_json,status FROM sessions WHERE id=?1",
                [id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(sql_error)?;
        record
            .map(|(payload, status)| {
                Ok(StoredSession {
                    payload: serde_json::from_str(&payload)?,
                    status,
                })
            })
            .transpose()
    }

    pub fn append_event(&self, frame: &EventFrame) -> Result<()> {
        self.connection
            .lock()
            .expect("store lock poisoned")
            .execute(
                "INSERT INTO events(session_id,seq,frame_json) VALUES(?1,?2,?3)
                 ON CONFLICT(session_id,seq) DO UPDATE SET frame_json=excluded.frame_json",
                params![
                    frame.session_id.as_str(),
                    frame.seq as i64,
                    serde_json::to_string(frame)?
                ],
            )
            .map_err(sql_error)?;
        Ok(())
    }

    pub fn events_after(&self, session: &SessionId, after_seq: u64) -> Result<Vec<EventFrame>> {
        let connection = self.connection.lock().expect("store lock poisoned");
        let mut statement = connection
            .prepare("SELECT frame_json FROM events WHERE session_id=?1 AND seq>?2 ORDER BY seq")
            .map_err(sql_error)?;
        let rows = statement
            .query_map(params![session.as_str(), after_seq as i64], |row| {
                row.get::<_, String>(0)
            })
            .map_err(sql_error)?;
        let mut events = Vec::new();
        for row in rows {
            events.push(serde_json::from_str(&row.map_err(sql_error)?)?);
        }
        Ok(events)
    }

    pub fn set_credential_ref(
        &self,
        user_id: &str,
        provider: &str,
        reference: &SecretRef,
        last4: &str,
    ) -> Result<()> {
        self.connection
            .lock()
            .expect("store lock poisoned")
            .execute(
                "INSERT INTO credential_refs(user_id,provider,secret_ref,last4,updated_at_ms)
                 VALUES(?1,?2,?3,?4,?5)
                 ON CONFLICT(user_id,provider) DO UPDATE SET secret_ref=excluded.secret_ref,
                    last4=excluded.last4,updated_at_ms=excluded.updated_at_ms",
                params![user_id, provider, reference.account, last4, now_ms() as i64],
            )
            .map_err(sql_error)?;
        Ok(())
    }

    pub(crate) fn file_imported(&self, path: &str, sha256: &str) -> Result<bool> {
        let found: Option<i64> = self
            .connection
            .lock()
            .expect("store lock poisoned")
            .query_row(
                "SELECT 1 FROM migration_files WHERE path=?1 AND sha256=?2",
                params![path, sha256],
                |row| row.get(0),
            )
            .optional()
            .map_err(sql_error)?;
        Ok(found.is_some())
    }

    pub(crate) fn mark_file_imported(&self, path: &str, sha256: &str) -> Result<()> {
        self.connection
            .lock()
            .expect("store lock poisoned")
            .execute(
                "INSERT INTO migration_files(path,sha256,imported_at_ms) VALUES(?1,?2,?3)
                 ON CONFLICT(path) DO UPDATE SET sha256=excluded.sha256,
                    imported_at_ms=excluded.imported_at_ms",
                params![path, sha256, now_ms() as i64],
            )
            .map_err(sql_error)?;
        Ok(())
    }

    pub fn immediate_transaction<T>(
        &self,
        operation: impl FnOnce(&Connection) -> Result<T>,
    ) -> Result<T> {
        let mut connection = self.connection.lock().expect("store lock poisoned");
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql_error)?;
        let result = operation(&transaction)?;
        transaction.commit().map_err(sql_error)?;
        Ok(result)
    }
}

fn migrate(connection: &Connection) -> Result<()> {
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(sql_error)?;
    if version > SCHEMA_VERSION {
        return Err(ZaalisError::config(format!(
            "base créée par une version plus récente ({version})"
        )));
    }
    if version == 0 {
        connection
            .execute_batch(
                "BEGIN IMMEDIATE;
                 CREATE TABLE users(
                   id TEXT PRIMARY KEY, profile_json TEXT NOT NULL,
                   created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
                 CREATE TABLE conversations(
                   id TEXT NOT NULL, user_id TEXT NOT NULL, kind TEXT NOT NULL,
                   project TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '',
                   payload_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL,
                   PRIMARY KEY(id,user_id,kind));
                 CREATE INDEX conversations_user_kind ON conversations(user_id,kind,updated_at_ms);
                 CREATE TABLE sessions(
                   id TEXT PRIMARY KEY, tree_json TEXT NOT NULL, status TEXT NOT NULL,
                   created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
                 CREATE TABLE events(
                   session_id TEXT NOT NULL, seq INTEGER NOT NULL, frame_json TEXT NOT NULL,
                   PRIMARY KEY(session_id,seq),
                   FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE);
                 CREATE TABLE credential_refs(
                   user_id TEXT NOT NULL, provider TEXT NOT NULL, secret_ref TEXT NOT NULL,
                   last4 TEXT NOT NULL DEFAULT '', updated_at_ms INTEGER NOT NULL,
                   PRIMARY KEY(user_id,provider));
                 CREATE TABLE permission_grants(
                   workspace TEXT NOT NULL, kind TEXT NOT NULL, pattern TEXT NOT NULL,
                   created_at_ms INTEGER NOT NULL, PRIMARY KEY(workspace,kind,pattern));
                 CREATE TABLE migration_files(
                   path TEXT PRIMARY KEY, sha256 TEXT NOT NULL, imported_at_ms INTEGER NOT NULL);
                 PRAGMA user_version=1;
                 COMMIT;",
            )
            .map_err(sql_error)?;
    }
    Ok(())
}

pub(crate) fn sql_error(error: rusqlite::Error) -> ZaalisError {
    ZaalisError::io(format!("SQLite : {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    use zaalis_core::{SegmentId, SessionId};
    use zaalis_protocol::Event;

    #[test]
    fn database_uses_wal_and_migrations_are_repeatable() {
        let dir = TempDir::new().expect("tempdir");
        let path = dir.path().join("zaalis.db");
        let store = Store::open(&path).expect("open");
        assert_eq!(store.journal_mode().expect("mode").to_lowercase(), "wal");
        assert_eq!(store.schema_version().expect("version"), SCHEMA_VERSION);
        drop(store);
        assert_eq!(
            Store::open(path).expect("reopen").schema_version().unwrap(),
            SCHEMA_VERSION
        );
    }

    #[test]
    fn users_and_conversations_upsert_without_duplicates() {
        let dir = TempDir::new().expect("tempdir");
        let store = Store::open(dir.path().join("db.sqlite")).expect("store");
        store
            .upsert_user("u1", &serde_json::json!({"name":"A"}))
            .unwrap();
        store
            .upsert_user("u1", &serde_json::json!({"name":"B"}))
            .unwrap();
        assert_eq!(store.user("u1").unwrap().unwrap()["name"], "B");
        store
            .upsert_conversation(
                "c1",
                "u1",
                "chat",
                &serde_json::json!({"id":"c1","title":"old"}),
            )
            .unwrap();
        store
            .upsert_conversation(
                "c1",
                "u1",
                "chat",
                &serde_json::json!({"id":"c1","title":"new"}),
            )
            .unwrap();
        let conversations = store.conversations("u1", "chat").unwrap();
        assert_eq!(conversations.len(), 1);
        assert_eq!(conversations[0]["title"], "new");
    }

    #[test]
    fn event_log_resumes_after_a_sequence_number() {
        let dir = TempDir::new().expect("tempdir");
        let store = Store::open(dir.path().join("db.sqlite")).expect("store");
        let session = SessionId::from_raw("ses_test");
        store
            .save_session(&session, &serde_json::json!({}), "running")
            .unwrap();
        for seq in 1..=3 {
            store
                .append_event(&EventFrame::new(
                    session.clone(),
                    seq,
                    seq,
                    Event::TextDelta {
                        segment_id: SegmentId::from_raw("seg_1"),
                        text: seq.to_string(),
                    },
                ))
                .unwrap();
        }
        let events = store.events_after(&session, 1).unwrap();
        assert_eq!(
            events.iter().map(|event| event.seq).collect::<Vec<_>>(),
            [2, 3]
        );
    }
}
