//! Thin wrapper over the user's own Boat CLI. Uses its existing login; never stores Boat credentials.

use anyhow::{anyhow, bail, Context, Result};
use serde::Deserialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::Duration;
use crate::process::command;

/// Boat's longest lifetime on a free trial, which refuses `--no-auto-stop`.
const TRIAL_TTL_SECS: u64 = 7200;

#[derive(Clone, Debug)]
pub struct Boat {
    bin: PathBuf,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Sandbox {
    pub id: String,
    pub state: String,
    pub stopped_at: Option<chrono::DateTime<chrono::Utc>>,
    /// When Boat stops it on its own; none without a lifetime or while stopped.
    pub archive_after: Option<chrono::DateTime<chrono::Utc>>,
    pub ttl_seconds: Option<u64>,
}

impl Sandbox {
    /// When Boat stops it on its own, for a trial lifetime this app set. One the user set
    /// themselves is theirs to keep.
    pub fn trial_deadline(&self) -> Option<chrono::DateTime<chrono::Utc>> {
        self.archive_after.filter(|_| self.ttl_seconds == Some(TRIAL_TTL_SECS))
    }
}

#[derive(Clone, Debug)]
pub struct Listing {
    pub sandboxes: Vec<Sandbox>,
    /// Every sandbox is in it, so one left out is gone. Boat cuts a long list short.
    pub complete: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub identifier: Option<String>,
    pub signed_in: bool,
    pub plan: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub stdout: String,
    #[serde(default)]
    pub stderr: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub dollars: f64,
    pub seconds: u64,
}

/// A pending browser sign-in: the page that completes it, and the code that page may ask for.
#[derive(Clone, Debug)]
pub struct SignIn {
    pub url: String,
    pub code: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Resume {
    Resumed,
    /// Boat deleted the stopped sandbox's disk: it keeps one 14 days.
    DataExpired,
}

#[derive(Clone, Debug, Default)]
pub struct Starts {
    pub used_today: u64,
    /// None: Boat sets no limit.
    pub limit_today: Option<u64>,
}

impl Boat {
    /// Finds the CLI the Boat installer puts in `~/.ascii/bin`, else on PATH.
    pub fn locate() -> Option<Self> {
        let exe = if cfg!(windows) { "boat.exe" } else { "boat" };
        let installed = dirs::home_dir().map(|h| h.join(".ascii").join("bin").join(exe));
        installed
            .filter(|p| p.is_file())
            .or_else(|| which::which("boat").ok())
            .map(|bin| Self { bin })
    }

    #[cfg(test)]
    pub fn at(bin: PathBuf) -> Self {
        Self { bin }
    }

    /// Runs the CLI; returns whether it succeeded, stdout and stderr.
    async fn output(&self, args: &[&str], timeout: Duration) -> Result<(bool, String, String)> {
        let mut cmd = command(&self.bin);
        // `--json` first: anything after `--` belongs to the remote command, and a nested
        // subcommand (`snapshot rm`) is only read as one with no option before it.
        cmd.arg("--json")
            .args(args)
            .env("BOAT_NO_UPDATE", "1")
            .kill_on_drop(true);
        // Only the subcommand goes into errors: arguments can hold scripts.
        let sub = args.first().copied().unwrap_or_default();
        let out = tokio::time::timeout(timeout, cmd.output())
            .await
            .map_err(|_| anyhow!("boat {sub} timed out"))?
            .with_context(|| format!("running boat {sub}"))?;
        Ok((
            out.status.success(),
            String::from_utf8_lossy(&out.stdout).into_owned(),
            String::from_utf8_lossy(&out.stderr).into_owned(),
        ))
    }

    /// Fails with Boat's `Refusal` when the command does.
    async fn run(&self, args: &[&str], timeout: Duration) -> Result<String> {
        let (ok, stdout, stderr) = self.output(args, timeout).await?;
        if !ok {
            return Err(Refusal::new(args.first().copied().unwrap_or_default(), &stdout, &stderr).into());
        }
        Ok(stdout)
    }

    /// Free-trial accounts refuse `--no-auto-stop`; they get Boat's longest trial lifetime instead.
    async fn run_without_auto_stop(&self, args: &[&str], timeout: Duration) -> Result<String> {
        match self.run(&[args, &["--no-auto-stop"]].concat(), timeout).await {
            Err(e) if refused(&e, "trial_auto_stop_required") => {
                let ttl = TRIAL_TTL_SECS.to_string();
                self.run(&[args, &["--ttl", &ttl]].concat(), timeout).await
            }
            result => result,
        }
    }

    /// The CLI prints JSON lines for long operations; the last line is the result.
    fn last_json(out: &str) -> Result<Value> {
        let line = out
            .lines()
            .rev()
            .find(|l| l.trim_start().starts_with('{'))
            .ok_or_else(|| anyhow!("boat printed no JSON: {out}"))?;
        Ok(serde_json::from_str(line)?)
    }

    pub async fn account(&self) -> Result<Account> {
        let v = Self::last_json(&self.run(&["status"], Duration::from_secs(20)).await?)?;
        Ok(serde_json::from_value(v["account"].clone())?)
    }

    /// Returns the new sandbox's id. `snapshot`: the saved snapshot its disk starts from.
    pub async fn create(&self, name: &str, size: &str, snapshot: Option<&str>) -> Result<String> {
        let mut args = vec!["new", "--name", name, "--type", size];
        args.extend(snapshot.into_iter().flat_map(|s| ["--from", s]));
        let v = Self::last_json(&self.run_without_auto_stop(&args, Duration::from_secs(300)).await?)?;
        let id = v["id"].as_str().ok_or_else(|| anyhow!("boat new returned no id"))?;
        Ok(id.to_owned())
    }

    pub async fn info(&self, id: &str) -> Result<Sandbox> {
        let v = Self::last_json(&self.run(&["info", id], Duration::from_secs(20)).await?)?;
        Ok(serde_json::from_value(v["sandbox"].clone())?)
    }

    /// `info`, `None` when Boat says it has no such sandbox: one bad answer must not pass for gone.
    pub async fn find(&self, id: &str) -> Result<Option<Sandbox>> {
        match self.info(id).await {
            Ok(sandbox) => Ok(Some(sandbox)),
            Err(e) if refused(&e, "not_found") => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Boat's sandboxes, as many as it lists at once.
    pub async fn list(&self) -> Result<Listing> {
        let v = Self::last_json(&self.run(&["list", "--all"], Duration::from_secs(20)).await?)?;
        Ok(Listing {
            sandboxes: serde_json::from_value(v["sandboxes"].clone())?,
            // Only Boat saying so: a list it may have cut short never counts a sandbox gone.
            complete: v["pageInfo"]["hasMore"] == false,
        })
    }

    /// Resumes onto `size`, which is how a machine changes size.
    pub async fn resume(&self, id: &str, size: &str) -> Result<Resume> {
        match self.run_without_auto_stop(&["resume", id, "--type", size], Duration::from_secs(300)).await {
            Ok(_) => Ok(Resume::Resumed),
            Err(e) if refused(&e, "snapshot_data_expired") => Ok(Resume::DataExpired),
            Err(e) => Err(e),
        }
    }

    /// Saves the sandbox's disk as `name`, replacing one of that name. A stopped sandbox stays
    /// stopped and bills nothing for it.
    pub async fn save_snapshot(&self, id: &str, name: &str) -> Result<()> {
        self.run(&["snapshot", id, name], Duration::from_secs(10 * 60)).await.map(drop)
    }

    pub async fn delete_snapshot(&self, name: &str) -> Result<()> {
        self.run(&["snapshot", "rm", name], Duration::from_secs(60)).await.map(drop)
    }

    /// The saved snapshots' names. A row without one fails: it must never pass as proof of absence.
    pub async fn named_snapshots(&self) -> Result<Vec<String>> {
        #[derive(Deserialize)]
        struct Named {
            name: String,
        }
        let v = Self::last_json(&self.run(&["snapshots"], Duration::from_secs(20)).await?)?;
        let named: Vec<Named> = serde_json::from_value(v["named"].clone())?;
        Ok(named.into_iter().map(|n| n.name).collect())
    }

    /// Stops and snapshots it for resume; returns once Boat took the stop.
    pub async fn stop(&self, id: &str) -> Result<()> {
        self.run(&["stop", id], Duration::from_secs(60)).await.map(drop)
    }

    /// Resets a trial sandbox's lifetime to the longest. Only from here: the sandbox's own key
    /// can't extend it.
    pub async fn extend_trial(&self, id: &str) -> Result<()> {
        let ttl = TRIAL_TTL_SECS.to_string();
        self.run(&["extend", id, "--ttl", &ttl], Duration::from_secs(20)).await.map(drop)
    }

    pub async fn delete(&self, id: &str) -> Result<()> {
        self.run(&["delete", id, "--yes"], Duration::from_secs(120))
            .await
            .map(drop)
    }

    /// Exposes `port` (bound to loopback on the sandbox) on a stable public HTTPS URL.
    pub async fn host_public(&self, id: &str, port: u16) -> Result<String> {
        let port = port.to_string();
        let v = Self::last_json(
            &self
                .run(&["host", id, &port, "--public", "--localhost"], Duration::from_secs(60))
                .await?,
        )?;
        v["url"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| anyhow!("boat host returned no url"))
    }

    pub async fn exec(&self, id: &str, script: &str, timeout_secs: u64) -> Result<ExecResult> {
        let t = timeout_secs.to_string();
        // The CLI exits with the command's code; its JSON result is what matters.
        let (_, stdout, stderr) = self
            .output(
                &["exec", id, "--timeout", &t, "--", "bash", "-lc", script],
                Duration::from_secs(timeout_secs + 60),
            )
            .await?;
        match Self::last_json(&stdout) {
            Ok(v) => Ok(serde_json::from_value(v)?),
            Err(_) => bail!("boat exec failed: {}", stderr.trim()),
        }
    }

    /// Runs `script` and fails unless it exits 0. Returns stdout.
    pub async fn exec_ok(&self, id: &str, script: &str, timeout_secs: u64) -> Result<String> {
        let r = self.exec(id, script, timeout_secs).await?;
        if r.exit_code != Some(0) {
            let detail = if r.stderr.trim().is_empty() { r.stdout.trim() } else { r.stderr.trim() };
            bail!("command on the machine failed ({:?}): {detail}", r.exit_code);
        }
        Ok(r.stdout)
    }

    pub async fn usage_since(&self, id: &str, since_unix: i64) -> Result<Usage> {
        let since = since_unix.to_string();
        let v = Self::last_json(
            &self.run(&["usage", id, "--since", &since], Duration::from_secs(20)).await?,
        )?;
        Ok(serde_json::from_value(v)?)
    }

    pub async fn starts(&self) -> Result<Starts> {
        let v = Self::last_json(&self.run(&["limits", "--all"], Duration::from_secs(20)).await?)?;
        let starts = &v["starts"];
        Ok(Starts {
            used_today: starts["day"]["used"].as_u64().unwrap_or(0),
            limit_today: starts["day"]["limit"].as_u64().filter(|_| starts["unlimited"] != true),
        })
    }

    /// Starts a browser sign-in, or picks up the one already pending. Without a terminal the
    /// CLI opens no browser, so the caller opens the page.
    pub async fn start_sign_in(&self) -> Result<SignIn> {
        let v = Self::last_json(&self.run(&["onboard"], Duration::from_secs(60)).await?)?;
        let url = v["url"].as_str().ok_or_else(|| anyhow!("boat onboard gave no sign-in page: {v}"))?;
        Ok(SignIn { url: url.to_owned(), code: v["userCode"].as_str().map(str::to_owned) })
    }

    /// Waits until the started sign-in completes or expires.
    pub async fn finish_sign_in(&self) -> Result<()> {
        self.run(&["onboard", "--wait"], Duration::from_secs(900)).await.map(drop)
    }

    /// Copies a local file to `remote_path` on the sandbox.
    pub async fn upload(&self, id: &str, local: &Path, remote_path: &str) -> Result<()> {
        let to = format!("{id}:{remote_path}");
        self.run(&["scp", path_str(local)?, &to], Duration::from_secs(1800)).await.map(drop)
    }

    /// Forwards `port` on this computer to the same port in the sandbox, for as long as the
    /// returned process lives.
    pub async fn forward(&self, id: &str, port: u16) -> Result<tokio::process::Child> {
        // Else another listener on the port would pass the readiness check below.
        if std::net::TcpListener::bind(("127.0.0.1", port)).is_err() {
            bail!("port {port} is in use on this computer; finish or close the other sign-in first");
        }
        let p = port.to_string();
        let mut child = command(&self.bin)
            .args(["forward", id, "--remote", &p, "--local", &p])
            .env("BOAT_NO_UPDATE", "1")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .context("running boat forward")?;
        for _ in 0..100 {
            if let Some(status) = child.try_wait()? {
                bail!("boat forward exited ({status}); is port {port} free on this computer?");
            }
            if tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
                return Ok(child);
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        bail!("boat forward did not open port {port}")
    }
}

/// What a failed command said: its stderr, else its stdout.
fn said<'a>(stdout: &'a str, stderr: &'a str) -> &'a str {
    if stderr.trim().is_empty() { stdout.trim() } else { stderr.trim() }
}

/// Boat refused a command. Its own words, for the logs, are what it displays; the user reads
/// `plain`.
#[derive(Debug)]
pub struct Refusal {
    sub: String,
    /// From the error line `--json` prints: `{"code":…,"error":…,"status":…}`.
    code: Option<String>,
    said: String,
}

impl Refusal {
    fn new(sub: &str, stdout: &str, stderr: &str) -> Self {
        let said = said(stdout, stderr).to_owned();
        let code = Boat::last_json(&said).ok().and_then(|v| v["code"].as_str().map(str::to_owned));
        Self { sub: sub.to_owned(), code, said }
    }

    /// What it means for the user. Codes from docs.boat.dev (API errors, free trial, troubleshooting).
    fn plain(&self) -> &'static str {
        match self.code.as_deref() {
            Some("rate_limited") => "Boat's limit on machine starts is reached for now. Try again later.",
            Some("limit_reached") => "Your Boat plan has as many machines awake as it allows. Put one to sleep first.",
            Some("member_limit_reached") => {
                "Your Boat organization caps how many machines you have awake. Put one to sleep, or ask the owner to raise your cap."
            }
            Some("trial_compute_limit_reached") => "Your Boat free trial's hours are used up. Start a plan on Boat to go on.",
            Some("trial_machine_class_not_allowed") => "This size needs a paid Boat plan.",
            Some("trial_saved_snapshots_not_allowed") => "Saving a backup needs a paid Boat plan.",
            Some("billing_required") => "Boat needs a payment first. Check billing on boat.dev.",
            Some("credit_required") => "Your Boat wallet is empty. Add money on boat.dev.",
            Some("team_member_cap_reached") => "You reached the spending cap your Boat organization set. An owner can raise it.",
            Some("org_suspended") => "Your Boat organization's wallet is suspended.",
            Some("unauthorized") => "You're signed out of Boat.",
            Some("not_found") => "Boat no longer has this machine.",
            Some("snapshot_not_found") => "Boat has no saved backup of this machine.",
            Some("no_ready_machine" | "service_unavailable") => "Boat has no machine free right now. Try again in a moment.",
            _ => "Boat couldn't do that just now. Try again in a moment.",
        }
    }
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "boat {} failed: {}", self.sub, self.said)
    }
}

impl std::error::Error for Refusal {}

/// Boat refused with this code.
fn refused(e: &anyhow::Error, code: &str) -> bool {
    e.downcast_ref::<Refusal>().is_some_and(|r| r.code.as_deref() == Some(code))
}

/// An error as the user reads it: Boat's refusals in plain words, the rest as is.
pub fn plain(e: &anyhow::Error) -> String {
    let part = |c: &(dyn std::error::Error + 'static)| c.downcast_ref::<Refusal>().map_or_else(|| c.to_string(), |r| r.plain().into());
    e.chain().map(part).collect::<Vec<_>>().join(": ")
}

/// Command-line form of a path; the Boat CLI and git only take UTF-8 here.
pub(crate) fn path_str(path: &Path) -> Result<&str> {
    path.to_str().ok_or_else(|| anyhow!("path is not UTF-8: {}", path.display()))
}

#[cfg(all(test, unix))]
mod tests {
    use super::{plain, Boat, Refusal, Resume, Sandbox};
    use std::os::unix::fs::PermissionsExt;

    const TRIAL_BOAT: &str = r#"#!/bin/sh
d=$(dirname "$0"); shift
echo "$*" >> "$d/log"
case " $* " in
  *" --no-auto-stop "*) [ -f "$d/trial" ] || [ -f "$d/down" ] || { echo '{"id":"bx_new"}'; exit 0; }
    [ -f "$d/down" ] && { echo 'Boat is down' >&2; exit 1; }
    echo '{"code":"trial_auto_stop_required","error":"Set a TTL of 2 hours or less"}' >&2; exit 1 ;;
  *" --ttl 7200 "*) echo '{"id":"bx_new"}' ;;
  *) exit 1 ;;
esac
"#;

    fn fake_boat(name: &str, flag: Option<&str>) -> (Boat, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("t3boat-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("boat");
        std::fs::write(&bin, TRIAL_BOAT).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        if let Some(flag) = flag {
            std::fs::write(dir.join(flag), "").unwrap();
        }
        (Boat::at(bin), dir)
    }

    fn calls(dir: &std::path::Path) -> Vec<String> {
        std::fs::read_to_string(dir.join("log")).unwrap_or_default().lines().map(str::to_owned).collect()
    }

    #[tokio::test]
    async fn trial_accounts_get_the_longest_ttl_instead_of_no_auto_stop() {
        let (boat, dir) = fake_boat("trial", Some("trial"));
        assert_eq!(boat.create("m", "default", None).await.unwrap(), "bx_new");
        assert_eq!(boat.resume("bx_new", "small").await.unwrap(), Resume::Resumed);
        assert_eq!(
            calls(&dir),
            [
                "new --name m --type default --no-auto-stop",
                "new --name m --type default --ttl 7200",
                "resume bx_new --type small --no-auto-stop",
                "resume bx_new --type small --ttl 7200",
            ]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn paid_accounts_and_other_failures_never_fall_back_to_a_ttl() {
        let (paid, dir) = fake_boat("paid", None);
        assert_eq!(paid.create("m", "large", None).await.unwrap(), "bx_new");
        assert_eq!(calls(&dir), ["new --name m --type large --no-auto-stop"]);
        let _ = std::fs::remove_dir_all(&dir);

        let (down, dir) = fake_boat("down", Some("down"));
        let err = down.create("m", "default", None).await.unwrap_err().to_string();
        assert!(err.contains("Boat is down"), "{err}");
        assert_eq!(calls(&dir), ["new --name m --type default --no-auto-stop"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn refusals_read_plainly() {
        let refusal = |said: &str| anyhow::Error::from(Refusal::new("resume", said, said));
        let limit = refusal(
            r#"{"code":"rate_limited","error":"You used all 200 sandbox starts included in the last 24 hours.","event":"error","status":429}"#,
        );
        assert_eq!(plain(&limit), "Boat's limit on machine starts is reached for now. Try again later.");
        assert!(format!("{limit:#}").contains("You used all 200"), "Boat's own words stay in the logs");
        assert_eq!(plain(&refusal("Boat is down")), "Boat couldn't do that just now. Try again in a moment.");
        let restore = refusal(r#"{"code":"snapshot_not_found","error":"not found","status":404}"#).context("restoring failed");
        assert_eq!(plain(&restore), "restoring failed: Boat has no saved backup of this machine.");
        assert_eq!(plain(&anyhow::anyhow!("T3 did not answer")), "T3 did not answer");
    }

    #[test]
    fn only_the_trial_lifetime_this_app_sets_is_renewed() {
        let ends = "2026-11-24T12:00:00Z".parse().unwrap();
        let sandbox = |ttl_seconds| Sandbox {
            id: "bx_1".into(),
            state: "running".into(),
            stopped_at: None,
            archive_after: Some(ends),
            ttl_seconds,
        };
        assert_eq!(sandbox(Some(7200)).trial_deadline(), Some(ends));
        assert_eq!(sandbox(None).trial_deadline(), None);
        assert_eq!(sandbox(Some(3600)).trial_deadline(), None);
    }
}
