use crate::runtime::{Tool, ToolContext, ToolDefinition, ToolResult, ToolRuntime};
use async_trait::async_trait;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;
use zaalis_core::{AccessKind, Result, ZaalisError};
use zaalis_fs::{
    glob, grep, list, read_file, tree, GlobOptions, GrepOptions, Hunk, ReadOptions, Transaction,
};
use zaalis_guard::AccessRequest;

/// Image files `read` hands to the model as pictures instead of refusing them
/// as binary: the formats every vision API accepts.
const IMAGE_TYPES: [(&str, &str); 5] = [
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
];
const MAX_IMAGE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_IMAGES_READ: usize = 4;

fn image_type(path: &std::path::Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    IMAGE_TYPES
        .iter()
        .find(|(known, _)| *known == extension)
        .map(|(_, mime)| *mime)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FilesystemKind {
    Read,
    List,
    Tree,
    Glob,
    Grep,
    CodeSearch,
    Write,
    Edit,
    ApplyPatch,
}

#[derive(Debug, Clone)]
pub struct FilesystemTool {
    kind: FilesystemKind,
}

impl FilesystemTool {
    fn new(kind: FilesystemKind) -> Self {
        Self { kind }
    }

    fn name(&self) -> &'static str {
        match self.kind {
            FilesystemKind::Read => "read",
            FilesystemKind::List => "list",
            FilesystemKind::Tree => "tree",
            FilesystemKind::Glob => "glob",
            FilesystemKind::Grep => "grep",
            FilesystemKind::CodeSearch => "code_search",
            FilesystemKind::Write => "write",
            FilesystemKind::Edit => "edit",
            FilesystemKind::ApplyPatch => "apply_patch",
        }
    }
}

pub fn register_filesystem_tools(runtime: &mut ToolRuntime) -> Result<()> {
    for kind in [
        FilesystemKind::Read,
        FilesystemKind::List,
        FilesystemKind::Tree,
        FilesystemKind::Glob,
        FilesystemKind::Grep,
        FilesystemKind::CodeSearch,
        FilesystemKind::Write,
        FilesystemKind::Edit,
        FilesystemKind::ApplyPatch,
    ] {
        runtime.register(FilesystemTool::new(kind))?;
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadInput {
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    paths: Vec<String>,
    #[serde(default)]
    offset: usize,
    #[serde(default)]
    limit: Option<usize>,
}

impl ReadInput {
    fn paths(&self) -> Result<Vec<&str>> {
        if self.path.is_some() && !self.paths.is_empty() {
            return Err(ZaalisError::invalid("utilisez path ou paths, pas les deux"));
        }
        let paths: Vec<_> = self
            .path
            .iter()
            .map(String::as_str)
            .chain(self.paths.iter().map(String::as_str))
            .collect();
        if paths.is_empty() {
            return Err(ZaalisError::invalid("path ou paths est requis"));
        }
        Ok(paths)
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ListInput {
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    max: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct TreeInput {
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    depth: Option<usize>,
    #[serde(default)]
    max: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WriteInput {
    path: String,
    content: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct EditInput {
    path: String,
    hunks: Vec<Hunk>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PatchFile {
    path: String,
    hunks: Vec<Hunk>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PatchInput {
    files: Vec<PatchFile>,
}

fn parse<T: DeserializeOwned>(input: &Value) -> Result<T> {
    serde_json::from_value(input.clone()).map_err(Into::into)
}

fn schema(properties: Value, required: &[&str]) -> Value {
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false
    })
}

#[async_trait]
impl Tool for FilesystemTool {
    fn definition(&self) -> ToolDefinition {
        let (description, input_schema) = match self.kind {
            FilesystemKind::Read => (
                "Lire un ou plusieurs fichiers du workspace avec numéros de ligne. Une image (png, jpg, gif, webp ; 8 Mo au plus) est montrée au modèle comme image.",
                schema(
                    json!({
                        "path": {"type":"string"},
                        "paths": {"type":"array","items":{"type":"string"}},
                        "offset": {"type":"integer","minimum":0},
                        "limit": {"type":"integer","minimum":1}
                    }),
                    &[],
                ),
            ),
            FilesystemKind::List => (
                "Lister un dossier du workspace.",
                schema(
                    json!({"path":{"type":"string"},"max":{"type":"integer","minimum":1}}),
                    &[],
                ),
            ),
            FilesystemKind::Tree => (
                "Afficher l'arborescence bornée du workspace.",
                schema(
                    json!({"path":{"type":"string"},"depth":{"type":"integer","minimum":1},"max":{"type":"integer","minimum":1}}),
                    &[],
                ),
            ),
            FilesystemKind::Glob => (
                "Trouver des chemins par motif glob.",
                serde_json::to_value(schema_for::<GlobOptions>()).unwrap_or(Value::Null),
            ),
            FilesystemKind::Grep | FilesystemKind::CodeSearch => (
                "Rechercher du texte ou une expression régulière dans les fichiers.",
                serde_json::to_value(schema_for::<GrepOptions>()).unwrap_or(Value::Null),
            ),
            FilesystemKind::Write => (
                "Créer ou remplacer atomiquement un fichier.",
                schema(
                    json!({"path":{"type":"string"},"content":{"type":"string"}}),
                    &["path", "content"],
                ),
            ),
            FilesystemKind::Edit => (
                "Appliquer des remplacements structurés et atomiques à un fichier.",
                edit_schema(false),
            ),
            FilesystemKind::ApplyPatch => (
                "Appliquer atomiquement des hunks sur plusieurs fichiers.",
                edit_schema(true),
            ),
        };
        ToolDefinition {
            name: self.name().into(),
            description: description.into(),
            input_schema,
        }
    }

    fn access(&self, input: &Value, context: &ToolContext) -> Result<AccessRequest> {
        let (kind, target, sensitive) = match self.kind {
            FilesystemKind::Read => {
                let args: ReadInput = parse(input)?;
                let paths = args.paths()?;
                let mut sensitive = false;
                let mut resolved = Vec::with_capacity(paths.len());
                for path in paths {
                    let path = context.workspace.resolve(path)?;
                    sensitive |= path.is_sensitive();
                    resolved.push(path.relative().to_owned());
                }
                (AccessKind::Read, resolved.join(", "), sensitive)
            }
            FilesystemKind::List => {
                let args: ListInput = parse(input)?;
                let target = resolve_optional(context, args.path.as_deref())?;
                (AccessKind::Read, target, false)
            }
            FilesystemKind::Tree => {
                let args: TreeInput = parse(input)?;
                let target = resolve_optional(context, args.path.as_deref())?;
                (AccessKind::Read, target, false)
            }
            FilesystemKind::Glob => {
                let args: GlobOptions = parse(input)?;
                let target = resolve_optional(context, args.path.as_deref())?;
                (AccessKind::Search, target, false)
            }
            FilesystemKind::Grep | FilesystemKind::CodeSearch => {
                let args: GrepOptions = parse(input)?;
                let target = resolve_optional(context, args.path.as_deref())?;
                (AccessKind::Search, target, args.include_sensitive)
            }
            FilesystemKind::Write => {
                let args: WriteInput = parse(input)?;
                let target = context.workspace.resolve(&args.path)?;
                (
                    AccessKind::Write,
                    target.relative().into(),
                    target.is_sensitive(),
                )
            }
            FilesystemKind::Edit => {
                let args: EditInput = parse(input)?;
                if args.hunks.is_empty() {
                    return Err(ZaalisError::invalid("hunks ne peut pas être vide"));
                }
                let target = context.workspace.resolve(&args.path)?;
                (
                    AccessKind::Edit,
                    target.relative().into(),
                    target.is_sensitive(),
                )
            }
            FilesystemKind::ApplyPatch => {
                let args: PatchInput = parse(input)?;
                if args.files.is_empty() {
                    return Err(ZaalisError::invalid("files ne peut pas être vide"));
                }
                let mut paths = Vec::with_capacity(args.files.len());
                let mut sensitive = false;
                for file in args.files {
                    if file.hunks.is_empty() {
                        return Err(ZaalisError::invalid(format!(
                            "hunks vide pour {}",
                            file.path
                        )));
                    }
                    let path = context.workspace.resolve(&file.path)?;
                    sensitive |= path.is_sensitive();
                    paths.push(path.relative().to_owned());
                }
                (AccessKind::Edit, paths.join(", "), sensitive)
            }
        };
        Ok(
            AccessRequest::new(context.agent_id.clone(), self.name(), kind)
                .with_target(target)
                .sensitive(sensitive),
        )
    }

    async fn execute(
        &self,
        input: Value,
        context: ToolContext,
        cancel: CancellationToken,
    ) -> Result<ToolResult> {
        if cancel.is_cancelled() {
            return Err(ZaalisError::cancelled());
        }
        let (summary, value) = match self.kind {
            FilesystemKind::Read => {
                let args: ReadInput = parse(&input)?;
                let mut reads = Vec::new();
                let mut pictures = Vec::new();
                let mut images = Vec::new();
                for input_path in args.paths()? {
                    let path = context.workspace.resolve(input_path)?;
                    if let Some(mime) = image_type(path.absolute()) {
                        let size = std::fs::metadata(path.absolute())?.len();
                        if size > MAX_IMAGE_BYTES {
                            return Err(ZaalisError::invalid(format!(
                                "image trop lourde pour être montrée au modèle ({} Mo, 8 Mo au plus) : {}",
                                size / (1024 * 1024),
                                path.relative()
                            )));
                        }
                        if images.len() >= MAX_IMAGES_READ {
                            return Err(ZaalisError::invalid("4 images au plus par lecture"));
                        }
                        let data = base64::Engine::encode(
                            &base64::engine::general_purpose::STANDARD,
                            std::fs::read(path.absolute())?,
                        );
                        pictures
                            .push(json!({ "path": path.relative(), "mime": mime, "bytes": size }));
                        images.push(json!({ "mime": mime, "data": data }));
                        continue;
                    }
                    reads.push(read_file(
                        &path,
                        &ReadOptions {
                            offset: args.offset,
                            limit: args.limit,
                        },
                    )?);
                }
                if images.is_empty() {
                    (
                        format!("{} fichier(s) lu(s)", reads.len()),
                        serde_json::to_value(reads)?,
                    )
                } else {
                    // `images` is detached by the runtime and sent to the
                    // model as pictures; the rest stays the tool's text.
                    (
                        format!(
                            "{} fichier(s) lu(s), dont {} image(s)",
                            reads.len() + pictures.len(),
                            pictures.len()
                        ),
                        json!({ "files": reads, "image_files": pictures, "images": images }),
                    )
                }
            }
            FilesystemKind::List => {
                let args: ListInput = parse(&input)?;
                let result = list(&context.workspace, args.path.as_deref(), args.max)?;
                (
                    format!("{} entrée(s) listée(s)", result.entries.len()),
                    serde_json::to_value(result)?,
                )
            }
            FilesystemKind::Tree => {
                let args: TreeInput = parse(&input)?;
                let result = tree(
                    &context.workspace,
                    args.path.as_deref(),
                    args.depth.unwrap_or(4),
                    args.max,
                )?;
                (
                    format!("{} entrée(s) dans l'arborescence", result.entries),
                    serde_json::to_value(result)?,
                )
            }
            FilesystemKind::Glob => {
                let args: GlobOptions = parse(&input)?;
                let result = glob(&context.workspace, &args)?;
                (
                    format!("{} chemin(s) trouvé(s)", result.entries.len()),
                    serde_json::to_value(result)?,
                )
            }
            FilesystemKind::Grep | FilesystemKind::CodeSearch => {
                let args: GrepOptions = parse(&input)?;
                let result = grep(&context.workspace, &args)?;
                (
                    format!("{} correspondance(s)", result.total_matches),
                    serde_json::to_value(result)?,
                )
            }
            FilesystemKind::Write => {
                let args: WriteInput = parse(&input)?;
                let path = context.workspace.resolve(&args.path)?;
                let mut transaction = Transaction::new();
                transaction.write(&path, &args.content)?;
                let edits = transaction.commit()?;
                (
                    format!("{} écrit", path.relative()),
                    serde_json::to_value(edits)?,
                )
            }
            FilesystemKind::Edit => {
                let args: EditInput = parse(&input)?;
                let path = context.workspace.resolve(&args.path)?;
                let mut transaction = Transaction::new();
                transaction.edit(&path, &args.hunks)?;
                let edits = transaction.commit()?;
                (
                    format!("{} modifié", path.relative()),
                    serde_json::to_value(edits)?,
                )
            }
            FilesystemKind::ApplyPatch => {
                let args: PatchInput = parse(&input)?;
                let mut transaction = Transaction::new();
                for file in &args.files {
                    let path = context.workspace.resolve(&file.path)?;
                    transaction.edit(&path, &file.hunks)?;
                }
                let edits = transaction.commit()?;
                (
                    format!("{} fichier(s) modifié(s)", edits.len()),
                    serde_json::to_value(edits)?,
                )
            }
        };
        Ok(ToolResult { summary, value })
    }
}

fn resolve_optional(context: &ToolContext, path: Option<&str>) -> Result<String> {
    match path {
        Some(path) if !path.is_empty() && path != "." => {
            Ok(context.workspace.resolve(path)?.relative().to_owned())
        }
        _ => Ok(".".into()),
    }
}

fn schema_for<T>() -> Value {
    let name = std::any::type_name::<T>();
    match name.rsplit("::").next().unwrap_or(name) {
        "GlobOptions" => schema(
            json!({
                "pattern":{"type":"string"}, "path":{"type":"string"},
                "kind":{"enum":["file","dir"]}, "max":{"type":"integer","minimum":1},
                "include_ignored":{"type":"boolean"}
            }),
            &["pattern"],
        ),
        "GrepOptions" => schema(
            json!({
                "pattern":{"type":"string"}, "path":{"type":"string"}, "include":{"type":"string"},
                "case_sensitive":{"type":"boolean"}, "context":{"type":"integer","minimum":0,"maximum":10},
                "max_matches":{"type":"integer","minimum":1}, "include_ignored":{"type":"boolean"},
                "include_sensitive":{"type":"boolean"}
            }),
            &["pattern"],
        ),
        _ => Value::Null,
    }
}

fn edit_schema(multiple: bool) -> Value {
    let hunks = json!({
        "type":"array", "minItems":1,
        "items":{"type":"object","properties":{
            "search":{"type":"string"}, "replace":{"type":"string"},
            "occurrence":{"type":"integer","minimum":1}
        },"required":["search","replace"],"additionalProperties":false}
    });
    if multiple {
        schema(
            json!({"files":{"type":"array","minItems":1,"items":{
                "type":"object","properties":{"path":{"type":"string"},"hunks":hunks},
                "required":["path","hunks"],"additionalProperties":false
            }}}),
            &["files"],
        )
    } else {
        schema(
            json!({"path":{"type":"string"},"hunks":hunks}),
            &["path", "hunks"],
        )
    }
}
