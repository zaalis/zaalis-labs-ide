use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use zaalis_core::{Result, ZaalisError};
use zeroize::{Zeroize, ZeroizeOnDrop};

const SERVICE: &str = "zaalis-labs";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SecretRef {
    pub account: String,
}

#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct SecretValue(String);

impl SecretValue {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn expose(&self) -> &str {
        &self.0
    }

    pub fn last4(&self) -> String {
        let chars: Vec<_> = self.0.chars().collect();
        chars[chars.len().saturating_sub(4)..].iter().collect()
    }
}

impl std::fmt::Debug for SecretValue {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("SecretValue([REDACTED])")
    }
}

pub trait SecretStore: Send + Sync + std::fmt::Debug {
    fn put(&self, account: &str, value: &SecretValue) -> Result<SecretRef>;
    fn get(&self, reference: &SecretRef) -> Result<SecretValue>;
    fn delete(&self, reference: &SecretRef) -> Result<()>;
}

#[derive(Debug, Default, Clone, Copy)]
pub struct OsSecretStore;

impl SecretStore for OsSecretStore {
    fn put(&self, account: &str, value: &SecretValue) -> Result<SecretRef> {
        validate_account(account)?;
        keyring::Entry::new(SERVICE, account)
            .map_err(secret_error)?
            .set_password(value.expose())
            .map_err(secret_error)?;
        Ok(SecretRef {
            account: account.into(),
        })
    }

    fn get(&self, reference: &SecretRef) -> Result<SecretValue> {
        validate_account(&reference.account)?;
        let value = keyring::Entry::new(SERVICE, &reference.account)
            .map_err(secret_error)?
            .get_password()
            .map_err(secret_error)?;
        Ok(SecretValue::new(value))
    }

    fn delete(&self, reference: &SecretRef) -> Result<()> {
        validate_account(&reference.account)?;
        keyring::Entry::new(SERVICE, &reference.account)
            .map_err(secret_error)?
            .delete_credential()
            .map_err(secret_error)
    }
}

#[derive(Debug, Default)]
pub struct MemorySecretStore {
    values: Mutex<HashMap<String, String>>,
}

impl SecretStore for MemorySecretStore {
    fn put(&self, account: &str, value: &SecretValue) -> Result<SecretRef> {
        validate_account(account)?;
        self.values
            .lock()
            .expect("secret lock poisoned")
            .insert(account.into(), value.expose().into());
        Ok(SecretRef {
            account: account.into(),
        })
    }

    fn get(&self, reference: &SecretRef) -> Result<SecretValue> {
        self.values
            .lock()
            .expect("secret lock poisoned")
            .get(&reference.account)
            .cloned()
            .map(SecretValue::new)
            .ok_or_else(|| ZaalisError::not_found("secret introuvable"))
    }

    fn delete(&self, reference: &SecretRef) -> Result<()> {
        self.values
            .lock()
            .expect("secret lock poisoned")
            .remove(&reference.account);
        Ok(())
    }
}

fn validate_account(account: &str) -> Result<()> {
    if account.trim().is_empty() || account.len() > 512 || account.contains(['\0', '\n', '\r']) {
        return Err(ZaalisError::invalid("référence de secret invalide"));
    }
    Ok(())
}

fn secret_error(error: keyring::Error) -> ZaalisError {
    ZaalisError::io(format!("coffre de secrets OS : {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_values_are_redacted_and_last4_is_unicode_safe() {
        let secret = SecretValue::new("clé-secrète");
        assert_eq!(format!("{secret:?}"), "SecretValue([REDACTED])");
        assert_eq!(secret.last4(), "rète");
    }

    #[test]
    fn memory_store_exercises_the_same_reference_contract() {
        let store = MemorySecretStore::default();
        let reference = store
            .put("u1/mistral", &SecretValue::new("secret-value"))
            .unwrap();
        assert_eq!(store.get(&reference).unwrap().expose(), "secret-value");
        store.delete(&reference).unwrap();
        assert!(store.get(&reference).is_err());
    }

    #[test]
    #[ignore = "touches the operating system credential vault"]
    fn os_store_round_trips_a_transient_secret() {
        let store = OsSecretStore;
        let account = format!("self-test/{}", zaalis_core::now_ms());
        let reference = store
            .put(&account, &SecretValue::new("ZAALIS_OS_VAULT_OK"))
            .expect("put");
        let result = store.get(&reference).map(|value| value.expose().to_owned());
        let cleanup = store.delete(&reference);
        assert_eq!(result.expect("get"), "ZAALIS_OS_VAULT_OK");
        cleanup.expect("delete");
    }
}
