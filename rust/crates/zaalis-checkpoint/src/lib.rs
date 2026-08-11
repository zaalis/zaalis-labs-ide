//! External workspace checkpoints.
//!
//! Snapshot bytes live outside the repository and are verified with SHA-256
//! both before and after a restore. A manifest contains only workspace-relative
//! paths. Restore resolves every path through `zaalis-fs` again, so a symlink
//! introduced after checkpoint creation cannot redirect writes outside.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use zaalis_core::{now_ms, CheckpointId, Result, ZaalisError};
use zaalis_fs::Workspace;

const MANIFEST_NAME: &str = "manifest.json";
const MAX_CHECKPOINT_FILES: usize = 10_000;
const MAX_CHECKPOINT_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckpointManifest {
    pub id: CheckpointId,
    pub created_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub files: Vec<CheckpointFile>,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckpointFile {
    pub path: String,
    pub existed: bool,
    pub size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RestoreReport {
    pub checkpoint_id: CheckpointId,
    pub restored: Vec<String>,
    pub removed: Vec<String>,
    pub verified_bytes: u64,
}

#[derive(Debug, Clone)]
pub struct CheckpointStore {
    workspace: Workspace,
    root: PathBuf,
}

impl CheckpointStore {
    pub fn open(storage_root: impl AsRef<Path>, workspace: Workspace) -> Result<Self> {
        fs::create_dir_all(storage_root.as_ref())?;
        let storage_root = dunce::canonicalize(storage_root)?;
        if storage_root.starts_with(workspace.root()) {
            return Err(ZaalisError::outside_workspace(
                "les checkpoints doivent être stockés hors du workspace",
            ));
        }
        let workspace_key = sha256(workspace.root().to_string_lossy().as_bytes());
        let root = storage_root.join(&workspace_key[..24]);
        fs::create_dir_all(&root)?;
        Ok(Self { workspace, root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn workspace_root(&self) -> &Path {
        self.workspace.root()
    }

    pub fn create(&self, paths: &[String], label: Option<String>) -> Result<CheckpointManifest> {
        if paths.is_empty() {
            return Err(ZaalisError::invalid(
                "un checkpoint doit nommer au moins un chemin",
            ));
        }
        if paths.len() > MAX_CHECKPOINT_FILES {
            return Err(ZaalisError::invalid("trop de fichiers dans le checkpoint"));
        }
        let id = CheckpointId::new();
        let directory = self.checkpoint_dir(&id);
        let files_directory = directory.join("files");
        fs::create_dir_all(&files_directory)?;

        let result = self.capture_files(&id, &directory, paths, label);
        if result.is_err() {
            let _ = fs::remove_dir_all(&directory);
        }
        result
    }

    pub fn list(&self) -> Result<Vec<CheckpointManifest>> {
        let mut manifests = Vec::new();
        for entry in fs::read_dir(&self.root)? {
            let Ok(entry) = entry else { continue };
            if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                continue;
            }
            let manifest_path = entry.path().join(MANIFEST_NAME);
            if !manifest_path.is_file() {
                continue;
            }
            manifests.push(read_manifest(&manifest_path)?);
        }
        manifests.sort_by_key(|manifest| manifest.created_at_ms);
        Ok(manifests)
    }

    pub fn inspect(&self, id: &CheckpointId) -> Result<CheckpointManifest> {
        read_manifest(&self.checked_dir(id)?.join(MANIFEST_NAME))
    }

    pub fn restore(&self, id: &CheckpointId) -> Result<RestoreReport> {
        let directory = self.checked_dir(id)?;
        let manifest = read_manifest(&directory.join(MANIFEST_NAME))?;
        if &manifest.id != id {
            return Err(ZaalisError::tool("identifiant de manifest incohérent"));
        }

        // Verify the complete snapshot before touching the workspace.
        let mut verified = Vec::with_capacity(manifest.files.len());
        let mut verified_bytes = 0_u64;
        for file in &manifest.files {
            let target = self.workspace.resolve(&file.path)?;
            if file.existed {
                let snapshot_path = directory.join("files").join(relative_path(&file.path)?);
                let bytes = fs::read(&snapshot_path)?;
                let expected = file
                    .sha256
                    .as_deref()
                    .ok_or_else(|| ZaalisError::tool("hash absent du manifest"))?;
                if bytes.len() as u64 != file.size || sha256(&bytes) != expected {
                    return Err(ZaalisError::tool(format!(
                        "checkpoint corrompu pour {}",
                        file.path
                    )));
                }
                verified_bytes = verified_bytes.saturating_add(bytes.len() as u64);
                verified.push((target, Some(bytes)));
            } else {
                verified.push((target, None));
            }
        }

        let rollback = capture_current(&verified)?;
        let mut restored = Vec::new();
        let mut removed = Vec::new();
        for (target, bytes) in &verified {
            let operation = match bytes {
                Some(bytes) => atomic_write(target.absolute(), bytes),
                None if target.exists() => fs::remove_file(target.absolute()).map_err(Into::into),
                None => Ok(()),
            };
            if let Err(error) = operation {
                rollback_files(&rollback);
                return Err(error);
            }
            if bytes.is_some() {
                restored.push(target.relative().to_owned());
            } else if target.exists() || rollback.iter().any(|item| item.path == target.absolute())
            {
                removed.push(target.relative().to_owned());
            }
        }

        // Prove the bytes on disk match what was verified.
        for (target, bytes) in &verified {
            if let Some(bytes) = bytes {
                let current = fs::read(target.absolute())?;
                if sha256(&current) != sha256(bytes) {
                    rollback_files(&rollback);
                    return Err(ZaalisError::io(format!(
                        "vérification après restauration échouée : {}",
                        target.relative()
                    )));
                }
            }
        }

        Ok(RestoreReport {
            checkpoint_id: id.clone(),
            restored,
            removed,
            verified_bytes,
        })
    }

    pub fn delete(&self, id: &CheckpointId) -> Result<()> {
        let directory = self.checked_dir(id)?;
        fs::remove_dir_all(directory)?;
        Ok(())
    }

    fn capture_files(
        &self,
        id: &CheckpointId,
        directory: &Path,
        paths: &[String],
        label: Option<String>,
    ) -> Result<CheckpointManifest> {
        let mut files = Vec::with_capacity(paths.len());
        let mut total_bytes = 0_u64;
        let mut seen = std::collections::HashSet::new();
        for input in paths {
            let target = self.workspace.resolve(input)?;
            if !seen.insert(target.relative().to_owned()) {
                continue;
            }
            if target.exists() && !target.is_file() {
                return Err(ZaalisError::invalid(format!(
                    "checkpoint de dossier non pris en charge : {}",
                    target.relative()
                )));
            }
            if target.exists() {
                let bytes = fs::read(target.absolute())?;
                total_bytes = total_bytes.saturating_add(bytes.len() as u64);
                if total_bytes > MAX_CHECKPOINT_BYTES {
                    return Err(ZaalisError::invalid("checkpoint supérieur à 256 Mio"));
                }
                let snapshot_path = directory
                    .join("files")
                    .join(relative_path(target.relative())?);
                atomic_write(&snapshot_path, &bytes)?;
                files.push(CheckpointFile {
                    path: target.relative().to_owned(),
                    existed: true,
                    size: bytes.len() as u64,
                    sha256: Some(sha256(&bytes)),
                });
            } else {
                files.push(CheckpointFile {
                    path: target.relative().to_owned(),
                    existed: false,
                    size: 0,
                    sha256: None,
                });
            }
        }
        let manifest = CheckpointManifest {
            id: id.clone(),
            created_at_ms: now_ms(),
            label,
            files,
            total_bytes,
        };
        let json = serde_json::to_vec_pretty(&manifest)?;
        atomic_write(&directory.join(MANIFEST_NAME), &json)?;
        Ok(manifest)
    }

    fn checkpoint_dir(&self, id: &CheckpointId) -> PathBuf {
        self.root.join(id.as_str())
    }

    fn checked_dir(&self, id: &CheckpointId) -> Result<PathBuf> {
        if !id.as_str().starts_with("ckpt_") || id.as_str().contains(['/', '\\', '\0', '\n', '\r'])
        {
            return Err(ZaalisError::invalid("identifiant de checkpoint invalide"));
        }
        let directory = self.checkpoint_dir(id);
        if !directory.is_dir() {
            return Err(ZaalisError::not_found(format!(
                "checkpoint introuvable : {id}"
            )));
        }
        let canonical = dunce::canonicalize(&directory)?;
        if canonical.parent() != Some(self.root.as_path()) {
            return Err(ZaalisError::outside_workspace("checkpoint hors stockage"));
        }
        Ok(canonical)
    }
}

#[derive(Debug)]
struct RollbackFile {
    path: PathBuf,
    bytes: Option<Vec<u8>>,
}

fn capture_current(
    targets: &[(zaalis_fs::ResolvedPath, Option<Vec<u8>>)],
) -> Result<Vec<RollbackFile>> {
    targets
        .iter()
        .map(|(target, _)| {
            Ok(RollbackFile {
                path: target.absolute().to_owned(),
                bytes: target
                    .exists()
                    .then(|| fs::read(target.absolute()))
                    .transpose()?,
            })
        })
        .collect()
}

fn rollback_files(files: &[RollbackFile]) {
    for file in files {
        match &file.bytes {
            Some(bytes) => {
                let _ = atomic_write(&file.path, bytes);
            }
            None => {
                let _ = fs::remove_file(&file.path);
            }
        }
    }
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| ZaalisError::invalid("chemin sans dossier parent"))?;
    fs::create_dir_all(parent)?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("checkpoint");
    let temporary = parent.join(format!(".{name}.zaalis-{}.tmp", std::process::id()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
        let _ = fs::remove_file(&temporary);
        return Err(error.into());
    }
    drop(file);
    if path.exists() {
        fs::remove_file(path)?;
    }
    if let Err(error) = fs::rename(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(error.into());
    }
    Ok(())
}

fn relative_path(path: &str) -> Result<PathBuf> {
    if path.is_empty()
        || path.starts_with('/')
        || path.contains("..")
        || path.contains(':')
        || path.contains('\0')
    {
        return Err(ZaalisError::invalid("chemin de manifest invalide"));
    }
    Ok(PathBuf::from(
        path.replace('/', std::path::MAIN_SEPARATOR_STR),
    ))
}

fn read_manifest(path: &Path) -> Result<CheckpointManifest> {
    serde_json::from_slice(&fs::read(path)?).map_err(Into::into)
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn setup() -> (TempDir, TempDir, CheckpointStore) {
        let workspace_dir = TempDir::new().expect("workspace");
        let storage = TempDir::new().expect("storage");
        fs::write(workspace_dir.path().join("existing.bin"), [0, 1, 2, 3]).expect("fixture");
        let workspace = Workspace::open(workspace_dir.path()).expect("open workspace");
        let store = CheckpointStore::open(storage.path(), workspace).expect("store");
        (workspace_dir, storage, store)
    }

    #[test]
    fn existing_and_missing_files_restore_as_one_checkpoint() {
        let (workspace, _storage, store) = setup();
        let manifest = store
            .create(
                &["existing.bin".into(), "created-later.txt".into()],
                Some("before edit".into()),
            )
            .expect("create");
        fs::write(workspace.path().join("existing.bin"), b"changed").expect("change");
        fs::write(workspace.path().join("created-later.txt"), b"new").expect("create later");

        let report = store.restore(&manifest.id).expect("restore");
        assert_eq!(
            fs::read(workspace.path().join("existing.bin")).unwrap(),
            [0, 1, 2, 3]
        );
        assert!(!workspace.path().join("created-later.txt").exists());
        assert_eq!(report.restored, ["existing.bin"]);
        assert_eq!(report.removed, ["created-later.txt"]);
    }

    #[test]
    fn corrupted_snapshot_is_detected_before_workspace_mutation() {
        let (workspace, _storage, store) = setup();
        let manifest = store
            .create(&["existing.bin".into()], None)
            .expect("create");
        fs::write(workspace.path().join("existing.bin"), b"current").expect("change");
        let snapshot = store
            .checkpoint_dir(&manifest.id)
            .join("files/existing.bin");
        fs::write(snapshot, b"tampered").expect("tamper");
        assert!(store.restore(&manifest.id).is_err());
        assert_eq!(
            fs::read(workspace.path().join("existing.bin")).unwrap(),
            b"current"
        );
    }

    #[test]
    fn list_inspect_and_delete_use_typed_ids() {
        let (_workspace, _storage, store) = setup();
        let manifest = store
            .create(&["existing.bin".into()], Some("named".into()))
            .expect("create");
        assert_eq!(
            store.list().expect("list").as_slice(),
            std::slice::from_ref(&manifest)
        );
        assert_eq!(store.inspect(&manifest.id).expect("inspect"), manifest);
        store.delete(&manifest.id).expect("delete");
        assert!(store.list().expect("list").is_empty());
    }

    #[test]
    fn storage_inside_workspace_is_refused() {
        let workspace_dir = TempDir::new().expect("workspace");
        let workspace = Workspace::open(workspace_dir.path()).expect("open");
        let error = CheckpointStore::open(workspace_dir.path().join(".bad"), workspace)
            .expect_err("inside workspace");
        assert_eq!(error.code, zaalis_core::ErrorCode::OutsideWorkspace);
    }
}
