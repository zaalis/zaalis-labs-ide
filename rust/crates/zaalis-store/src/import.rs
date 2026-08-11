use crate::{SecretStore, SecretValue, Store};
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use scrypt::{scrypt, Params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;
use std::sync::Arc;
use zaalis_core::{Result, ZaalisError};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImportReport {
    pub files_imported: usize,
    pub files_unchanged: usize,
    pub users_imported: usize,
    pub conversations_imported: usize,
    pub secrets_imported: usize,
    pub secrets_failed: usize,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<ImportWarning>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImportWarning {
    pub user_id: String,
    pub secret_name: String,
    pub code: String,
}

#[derive(Debug)]
pub struct LegacyImporter<'a> {
    store: &'a Store,
    secrets: Arc<dyn SecretStore>,
}

impl<'a> LegacyImporter<'a> {
    pub fn new(store: &'a Store, secrets: Arc<dyn SecretStore>) -> Self {
        Self { store, secrets }
    }

    pub fn import_data_dir(&self, directory: impl AsRef<Path>) -> Result<ImportReport> {
        let directory = directory.as_ref();
        let mut report = ImportReport::default();
        let users_path = directory.join("users.json");
        if users_path.is_file() {
            self.import_users(&users_path, &directory.join("secret"), &mut report)?;
        }
        let chats = directory.join("chats");
        if chats.is_dir() {
            for entry in fs::read_dir(chats)? {
                let Ok(entry) = entry else { continue };
                if entry.path().extension().and_then(|value| value.to_str()) == Some("json") {
                    self.import_chat_file(&entry.path(), &mut report)?;
                }
            }
        }
        Ok(report)
    }

    fn import_users(
        &self,
        path: &Path,
        secret_path: &Path,
        report: &mut ImportReport,
    ) -> Result<()> {
        let bytes = fs::read(path)?;
        let hash = digest(&bytes);
        let key = canonical_key(path)?;
        if self.store.file_imported(&key, &hash)? {
            report.files_unchanged += 1;
            return Ok(());
        }
        let root: Value = serde_json::from_slice(strip_bom(&bytes))?;
        let users: Vec<Value> = match root {
            Value::Array(users) => users,
            Value::Object(_) => vec![root],
            _ => return Err(ZaalisError::invalid("users.json invalide")),
        };
        let install_secret = fs::read_to_string(secret_path).ok();
        for user in users {
            let Some(id) = user.get("id").and_then(Value::as_str) else {
                continue;
            };
            let mut profile = user.clone();
            if let Some(secret) = install_secret.as_deref() {
                self.import_user_secrets(id, &user, secret.trim(), report);
            } else {
                report.secrets_failed += count_encrypted_secrets(&user);
            }
            sanitize_user(&mut profile);
            self.store.upsert_user(id, &profile)?;
            report.users_imported += 1;
        }
        self.store.mark_file_imported(&key, &hash)?;
        report.files_imported += 1;
        Ok(())
    }

    fn import_user_secrets(
        &self,
        user_id: &str,
        user: &Value,
        install_secret: &str,
        report: &mut ImportReport,
    ) {
        if let Some(keys) = user.get("apiKeys").and_then(Value::as_object) {
            for (provider, blob) in keys {
                if let Some(blob) = blob.as_str().filter(|value| !value.is_empty()) {
                    self.import_secret(
                        user_id,
                        &format!("provider/{provider}"),
                        blob,
                        install_secret,
                        report,
                    );
                }
            }
        }
        if let Some(blob) = user
            .pointer("/brainMcp/token")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            self.import_secret(user_id, "mcp/zaalis-brain", blob, install_secret, report);
        }
        if let Some(servers) = user.get("mcpServers").and_then(Value::as_array) {
            for server in servers {
                if let (Some(id), Some(blob)) = (
                    server.get("id").and_then(Value::as_str),
                    server.get("token").and_then(Value::as_str),
                ) {
                    if blob.is_empty() {
                        continue;
                    }
                    self.import_secret(user_id, &format!("mcp/{id}"), blob, install_secret, report);
                }
            }
        }
    }

    fn import_secret(
        &self,
        user_id: &str,
        name: &str,
        blob: &str,
        install_secret: &str,
        report: &mut ImportReport,
    ) {
        let result = decode_legacy_secret(blob, install_secret).and_then(|value| {
            let secret = SecretValue::new(value);
            let account = format!("{user_id}/{name}");
            let reference = self.secrets.put(&account, &secret)?;
            self.store
                .set_credential_ref(user_id, name, &reference, &secret.last4())
        });
        match result {
            Ok(()) => report.secrets_imported += 1,
            Err(error) => {
                report.secrets_failed += 1;
                report.warnings.push(ImportWarning {
                    user_id: user_id.into(),
                    secret_name: name.into(),
                    code: error.code.as_str().into(),
                });
            }
        }
    }

    fn import_chat_file(&self, path: &Path, report: &mut ImportReport) -> Result<()> {
        let bytes = fs::read(path)?;
        let hash = digest(&bytes);
        let key = canonical_key(path)?;
        if self.store.file_imported(&key, &hash)? {
            report.files_unchanged += 1;
            return Ok(());
        }
        let conversations: Value = serde_json::from_slice(strip_bom(&bytes))?;
        let conversations = conversations
            .as_array()
            .ok_or_else(|| ZaalisError::invalid("fichier de conversations invalide"))?;
        let filename = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("legacy");
        let (user_id, kind) = filename
            .rsplit_once("__")
            .filter(|(_, kind)| matches!(*kind, "chat" | "agents"))
            .unwrap_or((filename, "chat"));
        for (index, conversation) in conversations.iter().enumerate() {
            let id = conversation
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| {
                    format!(
                        "legacy_{}",
                        &digest(format!("{key}:{index}").as_bytes())[..24]
                    )
                });
            self.store
                .upsert_conversation(&id, user_id, kind, conversation)?;
            report.conversations_imported += 1;
        }
        self.store.mark_file_imported(&key, &hash)?;
        report.files_imported += 1;
        Ok(())
    }
}

fn decode_legacy_secret(blob: &str, install_secret: &str) -> Result<String> {
    if legacy_envelope(blob) {
        return decrypt_legacy(blob, install_secret);
    }
    // Early MCP builds wrote tokens directly in users.json. Accept that old
    // representation only when it is clearly not an AES-GCM envelope, then
    // immediately move it into the OS vault and remove it from stored JSON.
    if blob.is_empty() || blob.len() > 32_768 || blob.chars().any(char::is_control) {
        return Err(ZaalisError::invalid("secret legacy texte invalide"));
    }
    Ok(blob.to_owned())
}

fn legacy_envelope(blob: &str) -> bool {
    let parts: Vec<_> = blob.split('.').collect();
    if parts.len() != 3 {
        return false;
    }
    matches!(
        (
            BASE64.decode(parts[0]),
            BASE64.decode(parts[1]),
            BASE64.decode(parts[2])
        ),
        (Ok(iv), Ok(_), Ok(tag)) if iv.len() == 12 && tag.len() == 16
    )
}

fn decrypt_legacy(blob: &str, install_secret: &str) -> Result<String> {
    let mut parts = blob.split('.');
    let iv = BASE64
        .decode(parts.next().unwrap_or_default())
        .map_err(|_| ZaalisError::invalid("IV de secret legacy invalide"))?;
    let mut encrypted = BASE64
        .decode(parts.next().unwrap_or_default())
        .map_err(|_| ZaalisError::invalid("secret legacy invalide"))?;
    let tag = BASE64
        .decode(parts.next().unwrap_or_default())
        .map_err(|_| ZaalisError::invalid("tag de secret legacy invalide"))?;
    if parts.next().is_some() || iv.len() != 12 || tag.len() != 16 {
        return Err(ZaalisError::invalid("format de secret legacy invalide"));
    }
    encrypted.extend_from_slice(&tag);
    let mut key = [0_u8; 32];
    let parameters = Params::new(14, 8, 1, 32)
        .map_err(|error| ZaalisError::internal(format!("paramètres scrypt : {error}")))?;
    scrypt(
        install_secret.as_bytes(),
        b"zaalis-api-key-vault",
        &parameters,
        &mut key,
    )
    .map_err(|error| ZaalisError::internal(format!("scrypt : {error}")))?;
    let cipher =
        Aes256Gcm::new_from_slice(&key).map_err(|_| ZaalisError::internal("clé AES invalide"))?;
    let plain = cipher
        .decrypt(Nonce::from_slice(&iv), encrypted.as_ref())
        .map_err(|_| ZaalisError::denied("secret legacy impossible à déchiffrer"))?;
    String::from_utf8(plain).map_err(|_| ZaalisError::invalid("secret legacy non UTF-8"))
}

fn sanitize_user(user: &mut Value) {
    let Some(object) = user.as_object_mut() else {
        return;
    };
    object.remove("apiKeys");
    sanitize_token_object(object.get_mut("brainMcp"));
    if let Some(servers) = object.get_mut("mcpServers").and_then(Value::as_array_mut) {
        for server in servers {
            sanitize_token_object(Some(server));
        }
    }
}

fn sanitize_token_object(value: Option<&mut Value>) {
    let Some(object) = value.and_then(Value::as_object_mut) else {
        return;
    };
    let configured = object
        .get("token")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty());
    object.remove("token");
    object.insert("tokenConfigured".into(), Value::Bool(configured));
}

fn count_encrypted_secrets(user: &Value) -> usize {
    user.get("apiKeys")
        .and_then(Value::as_object)
        .map_or(0, |keys| {
            keys.values()
                .filter(|value| value.as_str().is_some_and(|value| !value.is_empty()))
                .count()
        })
        + usize::from(
            user.pointer("/brainMcp/token")
                .and_then(Value::as_str)
                .is_some_and(|value| !value.is_empty()),
        )
        + user
            .get("mcpServers")
            .and_then(Value::as_array)
            .map_or(0, |servers| {
                servers
                    .iter()
                    .filter(|server| {
                        server
                            .get("token")
                            .and_then(Value::as_str)
                            .is_some_and(|value| !value.is_empty())
                    })
                    .count()
            })
}

fn strip_bom(bytes: &[u8]) -> &[u8] {
    bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes)
}

fn canonical_key(path: &Path) -> Result<String> {
    Ok(dunce::canonicalize(path)?.to_string_lossy().into_owned())
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::MemorySecretStore;
    use aes_gcm::aead::Aead;
    use tempfile::TempDir;

    fn encrypt_legacy(plain: &str, install_secret: &str) -> String {
        let parameters = Params::new(14, 8, 1, 32).unwrap();
        let mut key = [0_u8; 32];
        scrypt(
            install_secret.as_bytes(),
            b"zaalis-api-key-vault",
            &parameters,
            &mut key,
        )
        .unwrap();
        let iv = [7_u8; 12];
        let encrypted = Aes256Gcm::new_from_slice(&key)
            .unwrap()
            .encrypt(Nonce::from_slice(&iv), plain.as_bytes())
            .unwrap();
        let split = encrypted.len() - 16;
        format!(
            "{}.{}.{}",
            BASE64.encode(iv),
            BASE64.encode(&encrypted[..split]),
            BASE64.encode(&encrypted[split..])
        )
    }

    #[test]
    fn node_aes_gcm_format_round_trips() {
        let blob = encrypt_legacy("mistral-secret", "install-secret");
        assert_eq!(
            decrypt_legacy(&blob, "install-secret").unwrap(),
            "mistral-secret"
        );
        assert!(decrypt_legacy(&blob, "wrong").is_err());
    }

    #[test]
    fn early_plaintext_mcp_tokens_are_moved_but_malformed_envelopes_are_not() {
        assert_eq!(
            decode_legacy_secret("old-mcp-token", "unused").unwrap(),
            "old-mcp-token"
        );
        assert!(decode_legacy_secret("", "unused").is_err());
        let blob = encrypt_legacy("secret", "right");
        assert!(decode_legacy_secret(&blob, "wrong").is_err());
    }

    #[test]
    fn import_is_idempotent_and_moves_secrets_out_of_json() {
        let legacy = TempDir::new().unwrap();
        let chats = legacy.path().join("chats");
        fs::create_dir(&chats).unwrap();
        fs::write(legacy.path().join("secret"), "install-secret").unwrap();
        let blob = encrypt_legacy("api-key-1234", "install-secret");
        fs::write(
            legacy.path().join("users.json"),
            serde_json::to_vec(&serde_json::json!([{
                "id":"u1","name":"Alice","apiKeys":{"mistral":blob},
                "brainMcp":{"enabled":true,"token":encrypt_legacy("brain-token", "install-secret")}
            }]))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            chats.join("u1__chat.json"),
            serde_json::to_vec(&serde_json::json!([
                {"id":"c1","title":"Test","messages":[]}
            ]))
            .unwrap(),
        )
        .unwrap();

        let db = TempDir::new().unwrap();
        let store = Store::open(db.path().join("zaalis.db")).unwrap();
        let secrets = Arc::new(MemorySecretStore::default());
        let importer = LegacyImporter::new(&store, secrets.clone());
        let first = importer.import_data_dir(legacy.path()).unwrap();
        assert_eq!(
            (
                first.users_imported,
                first.conversations_imported,
                first.secrets_imported
            ),
            (1, 1, 2)
        );
        let profile = store.user("u1").unwrap().unwrap();
        assert!(profile.get("apiKeys").is_none());
        assert!(profile.pointer("/brainMcp/token").is_none());
        assert_eq!(
            profile.pointer("/brainMcp/tokenConfigured"),
            Some(&Value::Bool(true))
        );
        assert_eq!(
            secrets
                .get(&crate::SecretRef {
                    account: "u1/provider/mistral".into()
                })
                .unwrap()
                .expose(),
            "api-key-1234"
        );

        let second = importer.import_data_dir(legacy.path()).unwrap();
        assert_eq!(second.files_imported, 0);
        assert_eq!(second.files_unchanged, 2);
        assert_eq!(store.conversations("u1", "chat").unwrap().len(), 1);
    }
}
