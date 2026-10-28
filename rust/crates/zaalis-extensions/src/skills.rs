use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use zaalis_core::{AccessKind, Result, ZaalisError};
use zaalis_guard::AccessRequest;
use zaalis_tools::{Tool, ToolContext, ToolDefinition, ToolResult};

const MAX_SKILLS: usize = 128;
const MAX_SKILL_BYTES: u64 = 256 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub source: PathBuf,
    pub instructions: String,
}

#[derive(Debug, Default)]
pub struct SkillRegistry {
    skills: BTreeMap<String, Skill>,
}

impl SkillRegistry {
    pub fn load(workspace: &zaalis_fs::Workspace, user_root: Option<&Path>) -> Result<Self> {
        let mut registry = Self::default();
        if let Some(root) = user_root {
            registry.load_root(&root.join("skills"))?;
        }
        let builtin = registry.skills.get("revers").cloned();
        let project = workspace.root().join(".zaalis").join("skills");
        registry.load_root(&project)?;
        if let Some(skill) = builtin { registry.skills.insert("revers".into(), skill); }
        if let Some(root) = user_root {
            let file = root.join("disabled-skills.json");
            if file.exists() {
                if fs::symlink_metadata(&file)?.file_type().is_symlink() || fs::metadata(&file)?.len() > MAX_SKILL_BYTES {
                    return Err(ZaalisError::invalid("configuration de Skills invalide"));
                }
                let disabled: BTreeSet<String> = serde_json::from_str(&fs::read_to_string(file)?)?;
                registry.skills.retain(|name, _| !disabled.contains(name));
            }
        }
        Ok(registry)
    }

    fn load_root(&mut self, root: &Path) -> Result<()> {
        if !root.exists() {
            return Ok(());
        }
        let mut ancestor = Some(root);
        while let Some(path) = ancestor {
            if fs::symlink_metadata(path)?.file_type().is_symlink() {
                return Err(ZaalisError::invalid("dossier de Skills symbolique refusé"));
            }
            ancestor = path.parent().filter(|p| !p.as_os_str().is_empty());
        }
        let root = dunce::canonicalize(root)?;
        for entry in fs::read_dir(&root)? {
            if self.skills.len() >= MAX_SKILLS {
                return Err(ZaalisError::invalid("trop de Skills"));
            }
            let entry = entry?;
            if entry.file_type()?.is_symlink() || !entry.file_type()?.is_dir() {
                continue;
            }
            let file = entry.path().join("SKILL.md");
            if !file.is_file() || fs::symlink_metadata(&file)?.file_type().is_symlink() {
                continue;
            }
            let file = dunce::canonicalize(file)?;
            if !file.starts_with(&root) {
                continue;
            }
            if fs::metadata(&file)?.len() > MAX_SKILL_BYTES {
                return Err(ZaalisError::invalid("Skill trop volumineuse"));
            }
            let instructions = fs::read_to_string(&file)?.trim_start_matches('\u{feff}').replace("\r\n", "\n").replace('\r', "\n");
            let (name, description) =
                metadata(&instructions, entry.file_name().to_string_lossy().as_ref());
            if !valid_name(&name) {
                return Err(ZaalisError::invalid(format!(
                    "nom de Skill invalide : {name}"
                )));
            }
            self.skills.insert(
                name.clone(),
                Skill {
                    name,
                    description,
                    source: file,
                    instructions,
                },
            );
        }
        Ok(())
    }

    pub fn list(&self) -> Vec<&Skill> {
        self.skills.values().collect()
    }
    pub fn get(&self, name: &str) -> Option<&Skill> {
        self.skills.get(name)
    }
    pub fn prompt_catalog(&self) -> String {
        if self.skills.is_empty() {
            return String::new();
        }
        let rows = self
            .skills
            .values()
            .map(|skill| format!("- {}: {}", skill.name, skill.description))
            .collect::<Vec<_>>()
            .join("\n");
        format!("\n\nSKILLS DISPONIBLES (appelle l'outil skill avant d'en suivre une) :\n{rows}")
    }
}

fn metadata(content: &str, fallback: &str) -> (String, String) {
    let mut name = fallback.to_owned();
    let mut description = String::new();
    if let Some(front) = content
        .strip_prefix("---\n")
        .and_then(|rest| rest.split_once("\n---").map(|pair| pair.0))
    {
        for line in front.lines() {
            if let Some(value) = line.strip_prefix("name:") {
                name = value.trim().trim_matches(&['"', '\''][..]).to_owned();
            }
            if let Some(value) = line.strip_prefix("description:") {
                description = value.trim().trim_matches(&['"', '\''][..]).to_owned();
            }
        }
    }
    if description.is_empty() {
        description = content
            .lines()
            .find_map(|line| line.strip_prefix("# "))
            .unwrap_or("Instructions locales")
            .trim()
            .to_owned();
    }
    (name, description.chars().take(240).collect())
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 80
        && name.as_bytes()[0].is_ascii_alphanumeric()
        && !name.contains("..")
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

#[derive(Debug)]
pub struct SkillTool {
    registry: Arc<SkillRegistry>,
}
impl SkillTool {
    pub fn new(registry: Arc<SkillRegistry>) -> Self {
        Self { registry }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    name: String,
}

#[async_trait]
impl Tool for SkillTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "skill".into(),
            description: "Charger les instructions d'une Skill Zaalis explicitement configurée."
                .into(),
            input_schema: json!({"type":"object","properties":{"name":{"type":"string"}},"required":["name"],"additionalProperties":false}),
        }
    }
    fn access(&self, input: &Value, context: &ToolContext) -> Result<AccessRequest> {
        let input: Input = serde_json::from_value(input.clone())?;
        Ok(
            AccessRequest::new(context.agent_id.clone(), "skill", AccessKind::Read)
                .with_target(format!("skill:{}", input.name)),
        )
    }
    async fn execute(
        &self,
        input: Value,
        _context: ToolContext,
        cancel: CancellationToken,
    ) -> Result<ToolResult> {
        if cancel.is_cancelled() {
            return Err(ZaalisError::cancelled());
        }
        let input: Input = serde_json::from_value(input)?;
        let skill = self
            .registry
            .get(&input.name)
            .ok_or_else(|| ZaalisError::not_found("Skill introuvable"))?;
        Ok(ToolResult {
            summary: format!("Skill {} chargée", skill.name),
            value: json!({"name":skill.name,"description":skill.description,"instructions":skill.instructions}),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn windows_metadata_disabled_skills_and_project_precedence() {
        let dir = TempDir::new().unwrap();
        let project = dir.path().join("project");
        let user = dir.path().join("user");
        for (base, content) in [(&project.join(".zaalis"), "project"), (&user, "user")] {
            let root = base.join("skills/review");
            fs::create_dir_all(&root).unwrap();
            fs::write(root.join("SKILL.md"), format!("---\r\nname: 'review'\r\ndescription: {content}\r\n---\r\n# Instructions")).unwrap();
        }
        let workspace = zaalis_fs::Workspace::open(&project).unwrap();
        let registry = SkillRegistry::load(&workspace, Some(&user)).unwrap();
        assert_eq!(registry.get("review").unwrap().description, "project");
        fs::write(user.join("disabled-skills.json"), "[\"review\"]").unwrap();
        assert!(SkillRegistry::load(&workspace, Some(&user)).unwrap().get("review").is_none());
        assert!(!valid_name(".."));
        assert!(!valid_name("../outside"));
    }

    #[test]
    fn project_and_user_skills_load_without_following_symlinks() {
        let dir = TempDir::new().unwrap();
        let project = dir.path().join("project");
        let skill = project.join(".zaalis/skills/review");
        fs::create_dir_all(&skill).unwrap();
        fs::write(
            skill.join("SKILL.md"),
            "---\nname: review\ndescription: Review code\n---\n# Steps\nRead first.",
        )
        .unwrap();
        let registry =
            SkillRegistry::load(&zaalis_fs::Workspace::open(&project).unwrap(), None).unwrap();
        assert_eq!(registry.get("review").unwrap().description, "Review code");
        assert!(registry.prompt_catalog().contains("review"));
    }
}
