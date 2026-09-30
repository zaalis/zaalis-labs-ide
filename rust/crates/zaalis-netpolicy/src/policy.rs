//! Which hosts a command may reach.

use serde::{Deserialize, Serialize};

/// What the policy says about one host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "decision")]
pub enum NetDecision {
    Allow {
        /// The rule that allowed it, for the audit line.
        rule: String,
    },
    Deny {
        reason: String,
    },
}

impl NetDecision {
    pub fn is_allow(&self) -> bool {
        matches!(self, NetDecision::Allow { .. })
    }
}

/// An allow/deny list over hostnames.
///
/// Deny always wins, and the default posture is closed: a host nobody listed is
/// refused. An agent running unattended in `auto` mode is exactly the situation
/// where "everything not forbidden is permitted" is the wrong default — the
/// blast radius of one bad command is the whole internet.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DomainPolicy {
    /// Hosts and parent domains that may be reached.
    #[serde(default)]
    pub allow: Vec<String>,
    /// Hosts refused even when an allow rule would match.
    #[serde(default)]
    pub deny: Vec<String>,
    /// Let anything through that is not explicitly denied.
    ///
    /// Off by default. Exists for the workspace whose build genuinely talks to
    /// a long tail of hosts and whose owner has decided that is acceptable.
    #[serde(default)]
    pub allow_by_default: bool,
}

impl DomainPolicy {
    /// The registries and code hosts an ordinary build needs.
    ///
    /// Shipping a usable default matters: a policy that breaks `npm install` on
    /// the first run is a policy the user turns off, and a policy that is off
    /// protects nothing.
    pub fn development_default() -> Self {
        Self {
            allow: [
                "registry.npmjs.org",
                "registry.yarnpkg.com",
                "crates.io",
                "static.crates.io",
                "index.crates.io",
                "pypi.org",
                "files.pythonhosted.org",
                "proxy.golang.org",
                "sum.golang.org",
                "repo.maven.apache.org",
                "api.nuget.org",
                "github.com",
                "api.github.com",
                "codeload.github.com",
                "objects.githubusercontent.com",
                "raw.githubusercontent.com",
                "gitlab.com",
                "packagist.org",
                "rubygems.org",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
            deny: Vec::new(),
            allow_by_default: false,
        }
    }

    pub fn with_allow(mut self, hosts: impl IntoIterator<Item = String>) -> Self {
        self.allow.extend(hosts);
        self
    }

    pub fn with_deny(mut self, hosts: impl IntoIterator<Item = String>) -> Self {
        self.deny.extend(hosts);
        self
    }

    /// Decide for one hostname.
    pub fn decide(&self, host: &str) -> NetDecision {
        let host = normalise(host);
        if host.is_empty() {
            return NetDecision::Deny {
                reason: "hôte absent".into(),
            };
        }
        if let Some(rule) = self.deny.iter().find(|rule| matches(rule, &host)) {
            return NetDecision::Deny {
                reason: format!("refusé par la règle {rule}"),
            };
        }
        if let Some(rule) = self.allow.iter().find(|rule| matches(rule, &host)) {
            return NetDecision::Allow { rule: rule.clone() };
        }
        if self.allow_by_default {
            return NetDecision::Allow {
                rule: "défaut ouvert".into(),
            };
        }
        NetDecision::Deny {
            reason: format!("{host} absent de la liste autorisée"),
        }
    }
}

fn normalise(host: &str) -> String {
    host.trim()
        .trim_end_matches('.')
        .trim_matches(['[', ']'])
        .to_ascii_lowercase()
}

/// Whether a rule covers a host.
///
/// A rule matches the host itself and its subdomains, so `github.com` covers
/// `api.github.com` — and, critically, does *not* cover `github.com.evil.test`,
/// which a naive `ends_with` would wave straight through.
fn matches(rule: &str, host: &str) -> bool {
    let rule = normalise(rule);
    if rule == "*" {
        return true;
    }
    let rule = rule.trim_start_matches("*.");
    host == rule || host.ends_with(&format!(".{rule}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_is_reachable_by_default() {
        let policy = DomainPolicy::default();
        assert!(!policy.decide("example.test").is_allow());
    }

    #[test]
    fn a_rule_covers_the_host_and_its_subdomains() {
        let policy = DomainPolicy::default().with_allow(["github.com".into()]);
        assert!(policy.decide("github.com").is_allow());
        assert!(policy.decide("api.github.com").is_allow());
        assert!(policy.decide("GITHUB.COM").is_allow());
    }

    #[test]
    fn a_lookalike_domain_is_not_a_subdomain() {
        // The evasion an `ends_with` check waves through.
        let policy = DomainPolicy::default().with_allow(["github.com".into()]);
        for host in [
            "github.com.evil.test",
            "notgithub.com",
            "evil-github.com",
            "github.company.test",
        ] {
            assert!(
                !policy.decide(host).is_allow(),
                "« {host} » ne doit pas passer pour github.com"
            );
        }
    }

    #[test]
    fn deny_beats_allow() {
        let policy = DomainPolicy::default()
            .with_allow(["github.com".into()])
            .with_deny(["gist.github.com".into()]);
        assert!(policy.decide("api.github.com").is_allow());
        assert!(!policy.decide("gist.github.com").is_allow());
    }

    #[test]
    fn an_open_default_still_honours_denials() {
        let mut policy = DomainPolicy::default().with_deny(["evil.test".into()]);
        policy.allow_by_default = true;
        assert!(policy.decide("anything.test").is_allow());
        assert!(!policy.decide("evil.test").is_allow());
        assert!(!policy.decide("sub.evil.test").is_allow());
    }

    #[test]
    fn the_development_default_covers_the_usual_registries_and_nothing_else() {
        let policy = DomainPolicy::development_default();
        for host in ["registry.npmjs.org", "static.crates.io", "api.github.com"] {
            assert!(policy.decide(host).is_allow(), "{host} doit passer");
        }
        for host in ["evil.test", "pastebin.com", "attacker.example"] {
            assert!(!policy.decide(host).is_allow(), "{host} ne doit pas passer");
        }
    }

    #[test]
    fn a_trailing_dot_or_case_change_does_not_bypass_a_denial() {
        let policy = DomainPolicy {
            allow_by_default: true,
            deny: vec!["evil.test".into()],
            ..Default::default()
        };
        for host in ["EVIL.test", "evil.test.", "evil.TEST."] {
            assert!(!policy.decide(host).is_allow(), "« {host} » doit être refusé");
        }
    }
}
