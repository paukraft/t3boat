//! Headless driver for development: runs the app model and proxies without the tray.
//! Reads commands from stdin: list | create <name> [size] | pair <id> | wake <id> | sleep <id> |
//! keep <id> [minutes] (keep awake; none: until stopped, 0 ends it) | connect <id> | delete <id> | costs

use std::sync::Arc;
use t3boat_lib::app::{self, App, Setup};
use t3boat_lib::machine::Event;
use tokio::io::{AsyncBufReadExt, BufReader};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(std::env::var("RUST_LOG").unwrap_or_else(|_| "info,t3boat_lib=debug".into()))
        .init();
    let (setup, boat, t3) = app::check_setup().await;
    if setup != Setup::Ready {
        anyhow::bail!("setup incomplete: {setup:?}");
    }
    let dir = std::env::var("T3BOAT_DATA_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| dirs::data_dir().unwrap().join("t3boat-dev"));
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let app = App::new(boat.unwrap(), t3.unwrap(), dir, tx)?;
    let saver = app.clone();
    tokio::spawn(async move {
        while let Some(ev) = rx.recv().await {
            match ev {
                Event::Persist => saver.save(),
                Event::Changed => {}
                Event::Notify { title, body } => println!("NOTIFY {title}: {body}"),
            }
        }
    });
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Some(line) = lines.next_line().await? {
        let words: Vec<String> = line.split_whitespace().map(str::to_owned).collect();
        let app = app.clone();
        tokio::spawn(async move {
            if let Err(e) = command(&app, &words).await {
                println!("ERROR {e:#}");
            }
        });
    }
    std::future::pending::<()>().await;
    Ok(())
}

async fn command(app: &Arc<App>, words: &[String]) -> anyhow::Result<()> {
    let arg = |i: usize| words.get(i).cloned().unwrap_or_default();
    match words.first().map(String::as_str) {
        Some("list") => {
            for v in app.views() {
                println!("{} {} [{:?}] {} paired={}", v.id, v.name, v.state, v.detail, v.paired);
            }
        }
        Some("create") => {
            let size = words.get(2).cloned().unwrap_or_else(|| "small".into());
            let m = app.create_machine(&arg(1), &size, Vec::new()).await?;
            println!("CREATED {} on port {}", m.id(), m.record().local_port);
        }
        Some("pair") => app.pair(&*app.machine(&arg(1))?)?,
        Some("upgrade") => app.machine(&arg(1))?.upgrade_if_needed().await?,
        Some("wake") => app.machine(&arg(1))?.ensure_awake("t3boat-dev").await?,
        Some("sleep") => app.machine(&arg(1))?.sleep_now().await?,
        Some("connect") => app.machine(&arg(1))?.turn_on_connect().await?,
        Some("keep") => app.machine(&arg(1))?.keep_awake(words.get(2).map(|m| m.parse()).transpose()?).await?,
        Some("delete") => app.delete_machine(&*app.machine(&arg(1))?, arg(2) == "discard").await?,
        Some("costs") => {
            app.refresh_costs().await;
            println!("{:?}", app.costs());
        }
        _ => println!("?"),
    }
    Ok(())
}
