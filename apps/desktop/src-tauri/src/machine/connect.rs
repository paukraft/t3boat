//! T3 Connect: T3's own way for other devices (a phone, a browser) to reach a machine with the
//! user's T3 account, through a tunnel the machine dials out. It is set up on the machine itself
//! with T3's `t3 connect login` and `t3 up --connect`, which t3boat runs there: the sign-in page
//! opens here, and once it is on, t3boat turns on the one setting a sleeping machine needs.

use super::login::LoginStep;
use super::MachineRuntime;
use crate::boat::Attached;
use anyhow::{anyhow, bail, Context, Result};
use reqwest::Method;
use serde_json::{json, Value};
use std::time::Duration;

/// What the user sees its sign-in as.
const CONNECT: &str = "T3 Connect";
/// For `t3 connect login` to reach its sign-in.
const URL_TIMEOUT: Duration = Duration::from_secs(120);
/// T3's device sign-in lasts 10 minutes, then `t3 connect login` fails by itself.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(11 * 60);
/// `t3 up`: the restart, and T3 checking the first tunnel connection for up to a minute.
const UP_TIMEOUT_SECS: u64 = 5 * 60;

impl MachineRuntime {
    /// Resolves once other devices can reach the machine through T3 Connect, after the user
    /// signed in to their T3 account in the browser.
    pub async fn turn_on_connect(&self) -> Result<()> {
        self.run_login(None, CONNECT, self.connect_setup()).await
    }

    /// Reads whether T3 Connect is on, for a machine that just woke: it can be turned on or off
    /// on the machine too.
    pub(super) async fn refresh_connect(&self) {
        match self.connect_api(Method::GET, "link-state", None).await {
            Ok(state) => {
                let on = state["linked"] == true && state["managedTunnelActive"] == true;
                if self.record().connect != on {
                    self.update_record(|r| r.connect = on);
                }
            }
            Err(e) => tracing::warn!("reading T3 Connect state of {}: {e:#}", self.id()),
        }
    }

    async fn connect_setup(&self) -> Result<()> {
        // Signed in first, cancellable: `t3 up` then finds the sign-in and asks nothing, and is
        // never stopped between saving the link and restarting T3 with it.
        self.run_login_job(self.connect_login_script(), |job| self.follow_connect_login(job)).await?;
        self.set_login_step(LoginStep::Finishing);
        // A turn may have started while the user was in the browser; a retry then needs no
        // browser, the sign-in is saved.
        self.ensure_no_turn().await?;
        let up = "\"$HOME/.local/bin/t3\" up --connect --headless --yes </dev/null 2>&1";
        let up = self.shared.boat.exec(&self.sandbox_id(), up, UP_TIMEOUT_SECS).await?;
        if up.exit_code != Some(0) {
            let said = up.stdout.lines().rev().map(str::trim).find(|l| !l.is_empty()).unwrap_or("no output");
            bail!("T3 Connect setup failed: {said}");
        }
        // A webhook sent while the machine sleeps is then held by T3 Connect's relay and run as
        // it wakes, instead of failing.
        let state = self.connect_api(Method::GET, "link-state", None).await?;
        let preferences = json!({
            "publishAgentActivity": state["publishAgentActivity"].as_bool().unwrap_or(false),
            "holdWebhooksWhileOffline": true,
        });
        self.connect_api(Method::POST, "preferences", Some(preferences)).await?;
        self.update_record(|r| r.connect = true);
        Ok(())
    }

    async fn connect_login_script(&self) -> Result<String> {
        self.ensure_no_turn().await?;
        Ok("\"$HOME/.local/bin/t3\" connect login --headless </dev/null 2>&1".to_owned())
    }

    /// `t3 up` restarts T3 to start the tunnel, which stops running agent turns and expires the
    /// approvals they wait on.
    async fn ensure_no_turn(&self) -> Result<()> {
        let s = self.watchdog_get("/status?fresh").await?;
        if s.busy {
            bail!("an agent is working; turn T3 Connect on once it finishes");
        }
        if s.waiting_threads > 0 {
            bail!("an agent is waiting on you there; answer it, then turn T3 Connect on");
        }
        Ok(())
    }

    async fn follow_connect_login(&self, mut job: Attached) -> Result<()> {
        // None when it needs no sign-in: still signed in from before.
        let url = tokio::time::timeout(URL_TIMEOUT, job.next_url())
            .await
            .map_err(|_| anyhow!("T3 Connect did not reach its sign-in"))??;
        if let Some(url) = url {
            self.open_login_page(&url)?;
        }
        tokio::time::timeout(SIGN_IN_TIMEOUT, job.wait())
            .await
            .map_err(|_| anyhow!("the T3 Connect sign-in was not finished in the browser"))?
            .context("the T3 Connect sign-in failed")
    }

    /// T3's `/api/connect/*` routes on the machine.
    async fn connect_api(&self, method: Method, route: &str, body: Option<Value>) -> Result<Value> {
        let url = format!("{}/api/connect/{route}", self.upstream_url());
        let mut req = self
            .shared
            .http
            .request(method, url)
            .bearer_auth(self.upstream_token())
            .timeout(Duration::from_secs(15));
        if let Some(body) = body {
            req = req.json(&body);
        }
        let res = req.send().await?;
        if !res.status().is_success() {
            bail!("T3 Connect {route}: HTTP {}", res.status());
        }
        Ok(res.json().await?)
    }
}
