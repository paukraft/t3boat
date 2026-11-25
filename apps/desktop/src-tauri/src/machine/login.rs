//! A browser sign-in t3boat runs on a machine (an agent's, or T3 Connect's): one at a time, shown
//! on the machine while it runs, kept awake meanwhile, and cancellable. Its job on the machine is
//! stopped when it ends any other way than done.

use super::MachineRuntime;
use crate::boat::Attached;
use anyhow::{anyhow, bail, Result};
use serde::Serialize;
use std::sync::Arc;
use tokio::sync::Notify;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginView {
    /// The agent's T3 instance id, or none for T3 Connect.
    pub instance_id: Option<String>,
    /// The agent's name, or "T3 Connect".
    pub name: String,
    pub step: LoginStep,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LoginStep {
    Waking,
    /// Starting the login on the machine, until its page opens.
    Starting,
    /// The page is open: the user approves it there.
    Browser,
    /// Signed in: putting it to use, no longer cancellable.
    Finishing,
}

pub(super) struct Login {
    view: LoginView,
    /// Holds a cancel until a cancellable step takes it: one that came during a step that isn't
    /// fires as the next starts.
    cancel: Arc<Notify>,
}

/// The user cancelled the sign-in.
#[derive(Debug)]
pub struct Cancelled;

impl std::fmt::Display for Cancelled {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the sign-in was cancelled")
    }
}

impl std::error::Error for Cancelled {}

impl MachineRuntime {
    /// Wakes the machine and runs `login` on it as its sign-in for `instance_id` (an agent's, none
    /// for T3 Connect) named `name`, through to what puts the sign-in to use: it ends shown with
    /// its outcome.
    pub(super) async fn run_login(
        &self,
        instance_id: Option<&str>,
        name: &str,
        login: impl Future<Output = Result<()>>,
    ) -> Result<()> {
        {
            let mut current = self.login.lock().unwrap();
            if let Some(other) = &*current {
                bail!("the {} sign-in is still open there; finish or cancel it first", other.view.name);
            }
            *current = Some(Login {
                view: LoginView {
                    instance_id: instance_id.map(str::to_owned),
                    name: name.to_owned(),
                    step: LoginStep::Waking,
                },
                cancel: Arc::new(Notify::new()),
            });
        }
        self.shared.changed();
        let result = async {
            // A wake runs to the end even when cancelled meanwhile: halfway would leave it unsure.
            self.ensure_awake(&format!("the {name} sign-in")).await?;
            self.set_login_step(LoginStep::Starting);
            self.kept_awake(login).await
        }
        .await;
        self.login.lock().unwrap().take();
        self.shared.changed();
        result
    }

    /// Runs the sign-in's job on the machine: the bash script `prepare` returns, followed by
    /// `follow` until the sign-in is done. Preparing and following can be cancelled, starting
    /// can't: a started job is always known, and stopped unless it was followed to its end.
    pub(super) async fn run_login_job(
        &self,
        prepare: impl Future<Output = Result<String>>,
        follow: impl AsyncFnOnce(Attached) -> Result<()>,
    ) -> Result<()> {
        let script = self.cancellable(prepare).await?;
        let (boat, id) = (&self.shared.boat, self.sandbox_id());
        let pid = boat.exec_detached(&id, &script).await?;
        let followed = self.cancellable(async { follow(boat.attach(&id, pid)?).await }).await;
        if followed.is_err()
            && let Err(e) = boat.kill(&id, pid).await
        {
            tracing::warn!("stopping the sign-in on {}: {e:#}", self.id());
        }
        followed
    }

    /// Runs `f` until it ends or the running sign-in is cancelled.
    async fn cancellable<T>(&self, f: impl Future<Output = Result<T>>) -> Result<T> {
        let cancel = self.login.lock().unwrap().as_ref().map(|l| l.cancel.clone());
        let cancel = cancel.ok_or_else(|| anyhow!("no sign-in runs there"))?;
        tokio::select! {
            biased;
            _ = cancel.notified() => Err(Cancelled.into()),
            done = f => done,
        }
    }

    /// Opens the sign-in's page here: the user takes it from there.
    pub(super) fn open_login_page(&self, url: &str) -> Result<()> {
        crate::app::open_url(url)?;
        self.set_login_step(LoginStep::Browser);
        Ok(())
    }

    pub(super) fn set_login_step(&self, step: LoginStep) {
        if let Some(login) = self.login.lock().unwrap().as_mut() {
            login.view.step = step;
        }
        self.shared.changed();
    }

    /// Ends the running sign-in, if any: it fails with `Cancelled`.
    pub fn cancel_login(&self) {
        if let Some(login) = &*self.login.lock().unwrap() {
            login.cancel.notify_one();
        }
    }

    pub fn login_view(&self) -> Option<LoginView> {
        self.login.lock().unwrap().as_ref().map(|l| l.view.clone())
    }
}
