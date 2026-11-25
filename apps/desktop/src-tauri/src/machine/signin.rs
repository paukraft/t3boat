//! Signing an agent in on a machine with the vendor's own CLI login. The login runs on the
//! machine and its localhost callback port is forwarded to this computer, so the browser's
//! redirect after "Authorize" lands on the machine: no code to paste, and the credential is
//! created on the machine and stays there. This computer's own logins are never touched.

use super::login::LoginStep;
use super::MachineRuntime;
use crate::boat::Attached;
use crate::proxy::cache::AgentProvider;
use crate::proxy::upstream;
use anyhow::{anyhow, bail, Context, Result};
use std::time::Duration;

/// For the CLI to start its login and hand over the page.
const URL_TIMEOUT: Duration = Duration::from_secs(30);
/// Authorizing is a click, or a sign-in with a second factor. A tab left open keeps the machine
/// awake, and billing, no longer than this.
const AUTHORIZE_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// On the machine: the page's address passes through a pipe here, and the CLI's output to a log.
const LOGIN_DIR: &str = "/tmp/t3boat-login";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Agent {
    Claude,
    Codex,
}

impl Agent {
    /// By T3's provider instance id. The CLI login signs in only its default home, which is the
    /// default instance's: the one whose id is the driver kind.
    pub fn from_instance(instance_id: &str) -> Option<Self> {
        [Self::Claude, Self::Codex].into_iter().find(|a| a.instance_id() == instance_id)
    }

    /// Its default instance's id: the driver kind.
    fn instance_id(self) -> &'static str {
        match self {
            Self::Claude => "claudeAgent",
            Self::Codex => "codex",
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Claude => "Claude",
            Self::Codex => "Codex",
        }
    }

    fn login(self) -> &'static str {
        match self {
            Self::Claude => "claude auth login",
            Self::Codex => "codex login",
        }
    }
}

/// No agent there is signed in, and t3boat can sign one in: one is enough to work there, and one
/// whose status T3 can't tell may well be.
pub fn needs_sign_in(agents: &[AgentProvider]) -> bool {
    agents.iter().all(|a| a.status == "unauthenticated")
        && agents.iter().any(|a| Agent::from_instance(&a.instance_id).is_some())
}

impl MachineRuntime {
    pub async fn sign_in(&self, agent: Agent) -> Result<()> {
        // Shown by T3's name for it, as its row in details is.
        let name = self
            .cache
            .lock()
            .unwrap()
            .agents()
            .into_iter()
            .find(|a| a.instance_id == agent.instance_id())
            .map_or_else(|| agent.name().to_owned(), |a| a.name);
        self.run_login(Some(agent.instance_id()), &name, self.agent_login(agent)).await
    }

    async fn agent_login(&self, agent: Agent) -> Result<()> {
        self.run_login_job(std::future::ready(Ok(login_script(agent))), |job| self.authorize(agent, job))
            .await?;
        self.set_login_step(LoginStep::Finishing);
        // T3 re-checks the provider and tells T3 Code; the sign-in nudge goes away with it, and
        // the recorded config learns it too.
        let refreshed = upstream::call(
            &self.upstream_url(),
            &self.upstream_token(),
            "server.refreshProviders",
            serde_json::json!({}),
        )
        .await;
        if let Ok(result) = refreshed {
            self.cache.lock().unwrap().fold_providers(&result["providers"]);
            self.save_cache();
        }
        Ok(())
    }

    /// Opens the login's page, with its callback forwarded here, and waits for the approval.
    async fn authorize(&self, agent: Agent, mut job: Attached) -> Result<()> {
        let name = agent.name();
        let failed = || format!("the {name} login failed");
        let url = tokio::time::timeout(URL_TIMEOUT, job.next_url())
            .await
            .map_err(|_| anyhow!("the {name} login did not start on the machine"))??;
        let Some(url) = url else {
            job.wait().await.with_context(failed)?;
            bail!("the {name} login ended without a sign-in page");
        };
        let port = callback_port(&url).ok_or_else(|| anyhow!("the {name} login has no local callback"))?;
        let _forward = self
            .shared
            .boat
            .forward(&self.sandbox_id(), port)
            .await
            .with_context(|| format!("forwarding port {port} for the {name} login"))?;
        self.open_login_page(&url)?;
        tokio::time::timeout(AUTHORIZE_TIMEOUT, job.wait())
            .await
            .map_err(|_| anyhow!("the {name} sign-in was not finished in the browser"))?
            .with_context(failed)
    }
}

/// Runs `agent`'s login on the machine: prints its page's address once the CLI hands it to
/// $BROWSER, then ends as the login does. Its terminal output goes to a log, whose end, less
/// `script`'s own start and done lines, is the job's stderr when it fails; the address is never printed after it.
fn login_script(agent: Agent) -> String {
    format!(
        "d={LOGIN_DIR}; rm -rf $d; mkdir -p $d; mkfifo $d/url; \
         printf '#!/bin/sh\\necho \"$1\" > {LOGIN_DIR}/url\\n' > $d/browser; chmod +x $d/browser; \
         BROWSER=$d/browser script -qfec '{}' $d/log >/dev/null 2>&1 & cli=$!; \
         exec 3<>$d/url; until read -r -t 1 -u 3 url; do kill -0 $cli 2>/dev/null || break; done; \
         [ -n \"$url\" ] && echo \"$url\"; \
         wait $cli || {{ tail -n 5 $d/log | sed 's/\\x1b\\[[0-9;?]*[A-Za-z]//g; s/\\r$//; s/.*\\r//; /^Script \\(started\\|done\\) on /d' >&2; exit 1; }}",
        agent.login()
    )
}

/// The port of a `redirect_uri=http://localhost:<port>/...` (or 127.0.0.1) parameter.
fn callback_port(url: &str) -> Option<u16> {
    let url = url::Url::parse(url).ok()?;
    let redirect = url.query_pairs().find(|(k, _)| k == "redirect_uri")?.1;
    let redirect = url::Url::parse(&redirect).ok()?;
    matches!(redirect.host_str()?, "localhost" | "127.0.0.1").then_some(())?;
    redirect.port()
}

#[cfg(test)]
mod tests {
    use super::{callback_port, needs_sign_in, Agent, AgentProvider};

    #[test]
    fn finds_the_local_callback_port() {
        let claude = "https://claude.com/cai/oauth/authorize?code=true&redirect_uri=http%3A%2F%2Flocalhost%3A43327%2Fcallback&state=x";
        let codex = "https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback";
        let manual = "https://claude.com/cai/oauth/authorize?redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback";
        assert_eq!(callback_port(claude), Some(43327));
        assert_eq!(callback_port(codex), Some(1455));
        assert_eq!(callback_port(manual), None);
    }

    #[test]
    fn needs_a_sign_in_only_while_no_agent_is_signed_in() {
        let agents = |list: &[(&str, &str)]| -> Vec<AgentProvider> {
            list.iter()
                .map(|(id, status)| AgentProvider {
                    instance_id: id.to_string(),
                    name: format!("{id} name"),
                    status: status.to_string(),
                })
                .collect()
        };
        let needs = |list: &[(&str, &str)]| needs_sign_in(&agents(list));
        // Claude alone is enough: Codex is no nag.
        assert!(!needs(&[("claudeAgent", "authenticated"), ("codex", "unauthenticated")]));
        // An agent t3boat can't sign in counts as signed in, and one T3 can't tell may be.
        assert!(!needs(&[("opencode", "authenticated"), ("codex", "unauthenticated")]));
        assert!(!needs(&[("claudeAgent", "unknown"), ("codex", "unauthenticated")]));
        // None signed in, and only an agent t3boat can't sign in: nothing to offer.
        assert!(!needs(&[("claude_work", "unauthenticated")]));
        assert!(needs(&[("claudeAgent", "unauthenticated"), ("claude_work", "unauthenticated"), ("codex", "unauthenticated")]));
        assert!(!needs(&[]));
        // Only the default instances t3boat signs in.
        assert_eq!(Agent::from_instance("claudeAgent"), Some(Agent::Claude));
        assert_eq!(Agent::from_instance("claude_work"), None);
    }
}
