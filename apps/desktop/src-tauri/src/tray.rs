//! The tray app: tray icon, the popover window, and the commands the UI calls.
//! Contract with the UI: docs/ui-contract.md.

use crate::app::{self, App, Costs, MachineState, MachineView, Setup};
use crate::boat::Boat;
use crate::machine::provision::{SizeInfo, SIZES};
use crate::machine::Event;
use crate::mcp;
use crate::store::Settings;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, State, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_notification::NotificationExt;

const PANEL: &str = "panel";
const ACCOUNT_EVERY: Duration = Duration::from_secs(300);
/// macOS tints the black template icon to its menu bar; other trays show it as is, and their
/// panels are often dark, so they get the app icon.
const TRAY_ICON: &[u8] = if cfg!(target_os = "macos") {
    include_bytes!("../icons/tray@2x.png")
} else {
    include_bytes!("../icons/64x64.png")
};

#[derive(Default)]
struct Ui {
    app: Mutex<Option<Arc<App>>>,
    setup: Mutex<SetupState>,
    account: Mutex<Option<Account>>,
    mcp: Mutex<McpStatus>,
    /// No tray to open the panel from, so it is an ordinary window: see `follow_tray_host`.
    windowed: AtomicBool,
    /// One `init` at a time: the startup check and "Check again" must not both build an App.
    init_lock: tokio::sync::Mutex<()>,
    /// The state the panel was last sent.
    sent: Mutex<Option<UiState>>,
}

/// Whether each coding agent CLI has t3boat's MCP server; `None`: that CLI is not installed.
#[derive(Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct McpStatus {
    claude_code: Option<bool>,
    codex: Option<bool>,
}

async fn mcp_status() -> McpStatus {
    let status = |client| async move {
        if mcp::installed(client).await { Some(mcp::registered(client).await) } else { None }
    };
    let (claude_code, codex) = tokio::join!(status(mcp::Client::ClaudeCode), status(mcp::Client::Codex));
    McpStatus { claude_code, codex }
}

async fn refresh_mcp(handle: &AppHandle) {
    let status = mcp_status().await;
    *handle.state::<Ui>().mcp.lock().unwrap() = status;
    emit_state(handle);
}

#[derive(Clone, Default)]
struct SetupState {
    setup: Setup,
    busy: bool,
    /// The code Boat's sign-in page may ask for, while a sign-in is pending.
    sign_in_code: Option<String>,
}

#[derive(Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Account {
    identifier: Option<String>,
    plan: Option<String>,
}


#[derive(Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct UiState {
    setup: Setup,
    setup_busy: bool,
    sign_in_code: Option<String>,
    account: Option<Account>,
    machines: Vec<MachineView>,
    costs: Costs,
    settings: Settings,
    sizes: &'static [SizeInfo],
    mcp: McpStatus,
}

impl Ui {
    fn app(&self) -> Result<Arc<App>, String> {
        self.app.lock().unwrap().clone().ok_or_else(|| "t3boat is not set up yet".to_owned())
    }

    fn state(&self) -> UiState {
        let setup = self.setup.lock().unwrap().clone();
        let app = self.app.lock().unwrap().clone();
        UiState {
            setup: setup.setup,
            setup_busy: setup.busy,
            sign_in_code: setup.sign_in_code,
            account: self.account.lock().unwrap().clone(),
            machines: app.as_ref().map(|a| a.views()).unwrap_or_default(),
            costs: app.as_ref().map(|a| a.costs()).unwrap_or_default(),
            settings: app.as_ref().map(|a| a.settings()).unwrap_or_default(),
            sizes: SIZES,
            mcp: self.mcp.lock().unwrap().clone(),
        }
    }
}

/// Sends the panel the state if it changed. A hidden panel gets it as it opens.
fn emit_state(handle: &AppHandle) {
    let shown = handle.get_webview_window(PANEL).is_some_and(|p| p.is_visible().unwrap_or(false));
    send_state(handle, shown);
}

fn send_state(handle: &AppHandle, to_panel: bool) {
    let ui = handle.state::<Ui>();
    let state = {
        // Built under the lock: a concurrent call can't send an older state last.
        let mut sent = ui.sent.lock().unwrap();
        let state = ui.state();
        if to_panel && sent.as_ref() != Some(&state) {
            let _ = handle.emit("state", &state);
            *sent = Some(state.clone());
        }
        state
    };
    update_tray(handle, &state);
}

fn update_tray(handle: &AppHandle, state: &UiState) {
    let Some(tray) = handle.tray_by_id("main") else { return };
    let working = state.machines.iter().filter(|m| m.state == MachineState::Working).count();
    let awake = state
        .machines
        .iter()
        .filter(|m| matches!(m.state, MachineState::Idle | MachineState::Working | MachineState::Waking))
        .count();
    let tip = match (working, awake) {
        (0, 0) => "t3boat · all machines asleep".to_owned(),
        (0, n) => format!("t3boat · {n} awake"),
        (w, _) => format!("t3boat · {w} working"),
    };
    let _ = tray.set_tooltip(Some(tip));
}

/// Checks the user's Boat and T3 Code installs; starts the app model once both are there.
async fn init(handle: AppHandle) {
    let ui = handle.state::<Ui>();
    let _init = ui.init_lock.lock().await;
    if ui.app.lock().unwrap().is_some() {
        return;
    }
    let (setup, boat, t3) = app::check_setup().await;
    ui.setup.lock().unwrap().setup = setup;
    if let Some(boat) = &boat {
        refresh_account(&handle, boat).await;
    }
    if let (Setup::Ready, Some(boat), Some(t3)) = (setup, boat, t3) {
        let data_dir = handle.path().app_data_dir().expect("app data dir");
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        match App::new(boat, t3, data_dir, tx) {
            Ok(app) => {
                *ui.app.lock().unwrap() = Some(app.clone());
                if let Err(e) = apply_autostart(&handle, app.settings().start_at_login) {
                    tracing::warn!("start at login: {e}");
                }
                tauri::async_runtime::spawn(events(handle.clone(), app.clone(), rx));
                tauri::async_runtime::spawn(background(handle.clone(), app.clone()));
                let mcp_handle = handle.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = mcp::serve(app).await {
                        notify(&mcp_handle, "t3boat", &format!("Coding agents cannot reach t3boat: {e:#}"));
                    }
                });
                tauri::async_runtime::spawn({
                    let handle = handle.clone();
                    async move { refresh_mcp(&handle).await }
                });
            }
            Err(e) => notify(&handle, "t3boat could not start", &format!("{e:#}")),
        }
    }
    emit_state(&handle);
}

async fn refresh_account(handle: &AppHandle, boat: &Boat) {
    let ui = handle.state::<Ui>();
    if let Ok(a) = boat.account().await {
        *ui.account.lock().unwrap() = Some(Account { identifier: a.identifier, plan: a.plan });
    }
}

async fn events(handle: AppHandle, app: Arc<App>, mut rx: tokio::sync::mpsc::UnboundedReceiver<Event>) {
    while let Some(ev) = rx.recv().await {
        match ev {
            Event::Persist => app.save(),
            Event::Changed => emit_state(&handle),
            Event::Notify { title, body } => notify(&handle, &title, &body),
        }
    }
}

/// The account changes slowly; refreshed on a timer.
async fn background(handle: AppHandle, app: Arc<App>) {
    loop {
        refresh_account(&handle, &app.shared.boat).await;
        emit_state(&handle);
        tokio::time::sleep(ACCOUNT_EVERY).await;
    }
}

fn notify(handle: &AppHandle, title: &str, body: &str) {
    let _ = handle.notification().builder().title(title).body(body).show();
}

fn apply_autostart(handle: &AppHandle, on: bool) -> Result<(), tauri_plugin_autostart::Error> {
    let autolaunch = handle.autolaunch();
    if on { autolaunch.enable() } else { autolaunch.disable() }
}

/// The clicked tray icon: its rect, and the cursor that says which screen it is on (each screen
/// has its own menu bar).
struct Anchor {
    icon: tauri::Rect,
    cursor: PhysicalPosition<f64>,
}

fn toggle_panel(handle: &AppHandle, anchor: Option<Anchor>) {
    let Some(panel) = handle.get_webview_window(PANEL) else { return };
    if panel.is_visible().unwrap_or(false) {
        let _ = panel.hide();
    } else {
        open_panel(handle, anchor);
    }
}

fn windowed(handle: &AppHandle) -> bool {
    handle.state::<Ui>().windowed.load(Ordering::Relaxed)
}

/// Shows the panel: under the tray icon, or as it was left when it is a window.
fn open_panel(handle: &AppHandle, anchor: Option<Anchor>) {
    let Some(panel) = handle.get_webview_window(PANEL) else { return };
    if !windowed(handle) {
        place_under_tray(handle, &panel, anchor);
    }
    show_focused(&panel);
    send_state(handle, true);
    if let Ok(app) = handle.state::<Ui>().app() {
        app.want_fresh_costs();
    }
    let handle = handle.clone();
    tauri::async_runtime::spawn(async move { refresh_mcp(&handle).await });
}

fn place_under_tray(handle: &AppHandle, panel: &tauri::WebviewWindow, anchor: Option<Anchor>) {
    let anchor = anchor.or_else(|| {
        let cursor = handle.cursor_position().ok()?;
        // Linux trays don't say where their icon is; there the panel opens from the tray
        // menu, so the cursor that just picked "Open t3boat" stands in for the icon.
        let icon = handle.tray_by_id("main")?.rect().ok().flatten().unwrap_or(tauri::Rect {
            position: cursor.into(),
            size: tauri::PhysicalSize::new(0, 0).into(),
        });
        Some(Anchor { icon, cursor })
    });
    if let Some(at) = anchor.and_then(|a| panel_position(handle, panel, &a)) {
        let _ = panel.set_position(at);
    }
}

/// Follows whether a tray can show t3boat's icon. Linux desktops may have none (GNOME without
/// the AppIndicator extension): there the panel becomes an ordinary window, shown at once and
/// reopened by launching t3boat again. Trays find icons through the StatusNotifierWatcher on
/// the session bus, so its owner coming and going switches modes, also when the tray starts
/// after t3boat at login.
#[cfg(target_os = "linux")]
fn follow_tray_host(handle: &AppHandle) {
    use gtk::gio;
    let (appeared, vanished) = (handle.clone(), handle.clone());
    gio::bus_watch_name(
        gio::BusType::Session,
        "org.kde.StatusNotifierWatcher",
        gio::BusNameWatcherFlags::NONE,
        move |_, _, _| set_windowed(&appeared, false),
        move |_, _| set_windowed(&vanished, true),
    );
}

#[cfg(target_os = "linux")]
fn set_windowed(handle: &AppHandle, windowed: bool) {
    if handle.state::<Ui>().windowed.swap(windowed, Ordering::Relaxed) == windowed {
        return;
    }
    let Some(panel) = handle.get_webview_window(PANEL) else { return };
    let _ = panel.set_decorations(windowed);
    let _ = panel.set_skip_taskbar(!windowed);
    let _ = panel.set_always_on_top(!windowed);
    if windowed {
        // GTK centers it as it maps; the window is not mapped yet, so its size reads zero here.
        if let Ok(window) = panel.gtk_window() {
            gtk::prelude::GtkWindowExt::set_position(&window, gtk::WindowPosition::Center);
        }
        open_panel(handle, None);
    } else {
        let _ = panel.hide();
    }
}

/// Shows the panel with focus, so clicking elsewhere hides it.
fn show_focused(panel: &tauri::WebviewWindow) {
    let _ = panel.show();
    #[cfg(target_os = "linux")]
    {
        // `set_focus` is dropped while the queued show is pending, so GTK presents it here.
        let panel = panel.clone();
        let _ = panel.clone().run_on_main_thread(move || {
            if let Ok(window) = panel.gtk_window() {
                present(&window);
            }
        });
    }
    #[cfg(not(target_os = "linux"))]
    let _ = panel.set_focus();
}

/// Shows and focuses a window as of now. The click reached us through the tray host, so GTK has
/// no event time of ours: stamped "current time", window managers take it for focus stealing
/// and refuse. On X11 the server's clock gives a real time; Wayland has no such check here.
#[cfg(target_os = "linux")]
fn present(window: &gtk::ApplicationWindow) {
    use gtk::prelude::*;
    window.realize();
    match window.window().and_then(|w| w.downcast::<gdkx11::X11Window>().ok()) {
        Some(w) => window.present_with_time(gdkx11::functions::x11_get_server_time(&w)),
        None => window.present(),
    }
}

/// A dropdown card under the tray icon (above it for a bottom taskbar), kept on its screen.
///
/// macOS reports the icon in points times its own screen's scale and each monitor in points
/// times its scale, so with mixed scales those "physical" ranges overlap: there everything is
/// worked out in points. Elsewhere physical coordinates are one consistent space.
fn panel_position(handle: &AppHandle, panel: &tauri::WebviewWindow, a: &Anchor) -> Option<tauri::Position> {
    const GAP: f64 = 6.0;
    let monitors = handle.available_monitors().ok()?;
    let unit = |m: &tauri::Monitor| if cfg!(target_os = "macos") { m.scale_factor() } else { 1.0 };
    let icon_in = |m: &tauri::Monitor| {
        let (at, size) = (a.icon.position.to_physical::<f64>(m.scale_factor()), a.icon.size.to_physical::<f64>(m.scale_factor()));
        let u = unit(m);
        (at.x / u, at.y / u, size.width / u, size.height / u)
    };
    let bounds = |m: &tauri::Monitor| {
        let u = unit(m);
        let (p, s) = (m.position(), m.size());
        (f64::from(p.x) / u, f64::from(p.y) / u, f64::from(s.width) / u, f64::from(s.height) / u)
    };
    let contains = |m: &tauri::Monitor| {
        let (x, y, ..) = icon_in(m);
        let (mx, my, mw, mh) = bounds(m);
        x >= mx && x < mx + mw && y >= my && y < my + mh
    };
    let monitor = if cfg!(target_os = "macos") {
        // Of the screens that could hold it, the one where the icon is menu-bar tall.
        const MENU_BAR_PT: f64 = 24.0;
        monitors.iter().filter(|m| contains(m)).min_by(|x, y| {
            let off = |m: &tauri::Monitor| (icon_in(m).3 / MENU_BAR_PT).ln().abs();
            off(x).total_cmp(&off(y))
        })
    } else {
        monitors.iter().find(|m| {
            let (mx, my, mw, mh) = bounds(m);
            a.cursor.x >= mx && a.cursor.x < mx + mw && a.cursor.y >= my && a.cursor.y < my + mh
        })
    }?;
    let (ix, iy, iw, ih) = icon_in(monitor);
    let (mx, my, mw, mh) = bounds(monitor);
    let logical = panel.outer_size().ok()?.to_logical::<f64>(panel.scale_factor().ok()?);
    let (w, h) = if cfg!(target_os = "macos") {
        (logical.width, logical.height)
    } else {
        (logical.width * monitor.scale_factor(), logical.height * monitor.scale_factor())
    };
    let gap = GAP * if cfg!(target_os = "macos") { 1.0 } else { monitor.scale_factor() };
    let x = (ix + iw / 2.0 - w / 2.0).clamp(mx + gap, (mx + mw - w - gap).max(mx + gap));
    let y = if iy < my + mh / 2.0 { iy + ih + gap } else { iy - h - gap };
    Some(if cfg!(target_os = "macos") {
        tauri::Position::Logical(tauri::LogicalPosition::new(x, y))
    } else {
        tauri::Position::Physical(tauri::PhysicalPosition::new(x.round() as i32, y.round() as i32))
    })
}

type Res<T = ()> = Result<T, String>;

fn err(e: anyhow::Error) -> String {
    tracing::info!("command failed: {e:#}");
    crate::boat::plain(&e)
}

#[tauri::command]
fn get_state(ui: State<'_, Ui>) -> UiState {
    ui.state()
}

#[tauri::command]
async fn create_machine(ui: State<'_, Ui>, name: String, size: String, projects: Option<Vec<String>>) -> Res {
    ui.app()?.create_machine(&name, &size, projects.unwrap_or_default()).await.map(drop).map_err(err)
}

/// This computer's T3 projects that can go to a machine.
#[tauri::command]
async fn local_projects(ui: State<'_, Ui>) -> Res<Vec<crate::projects::Project>> {
    ui.app()?.local_projects().await.map_err(err)
}

#[tauri::command]
async fn add_project(ui: State<'_, Ui>, id: String, project_id: String) -> Res {
    let app = ui.app()?;
    let machine = app.machine(&id).map_err(err)?;
    app.add_project(&machine, &project_id).await.map(drop).map_err(err)
}

#[tauri::command]
async fn wake_machine(ui: State<'_, Ui>, id: String) -> Res {
    ui.app()?.machine(&id).map_err(err)?.ensure_awake("the Wake now button").await.map_err(err)
}

#[tauri::command]
async fn sleep_machine(ui: State<'_, Ui>, id: String) -> Res {
    ui.app()?.machine(&id).map_err(err)?.sleep_now().await.map_err(err)
}

#[tauri::command]
async fn open_machine(ui: State<'_, Ui>, id: String, thread: Option<String>) -> Res {
    let app = ui.app()?;
    let machine = app.machine(&id).map_err(err)?;
    app.open_in_t3(&machine, thread.as_deref()).map_err(err)
}

#[tauri::command]
async fn pair_machine(ui: State<'_, Ui>, id: String) -> Res {
    let app = ui.app()?;
    let machine = app.machine(&id).map_err(err)?;
    app.pair(&machine).map_err(err)
}

/// The id of the thread "Open" goes to; never wakes the machine.
#[tauri::command]
async fn latest_thread(ui: State<'_, Ui>, id: String) -> Res<Option<String>> {
    Ok(ui.app()?.machine(&id).map_err(err)?.latest_thread().await)
}

/// For the details view; never wakes the machine.
#[tauri::command]
fn get_machine_details(ui: State<'_, Ui>, id: String) -> Res<app::MachineDetails> {
    ui.app()?.details(&id).map_err(err)
}

/// Signs an agent in on the machine through the vendor's own login in the browser.
#[tauri::command]
async fn sign_in_agent(ui: State<'_, Ui>, id: String, agent: String) -> Res {
    let agent = crate::machine::signin::Agent::from_name(&agent)
        .ok_or_else(|| format!("{agent} has to be signed in from T3 Code's settings"))?;
    ui.app()?.machine(&id).map_err(err)?.sign_in(agent).await.map_err(err)
}

/// Turns on T3 Connect there; resolves once other devices can reach it, after the user signed in
/// to their T3 account in the browser.
#[tauri::command]
async fn turn_on_connect(ui: State<'_, Ui>, id: String) -> Res {
    ui.app()?.machine(&id).map_err(err)?.turn_on_connect().await.map_err(err)
}

/// "Keep awake" for `minutes`; null: until stopped; 0 ends it.
#[tauri::command]
async fn keep_awake(ui: State<'_, Ui>, id: String, minutes: Option<u32>) -> Res {
    ui.app()?.machine(&id).map_err(err)?.keep_awake(minutes).await.map_err(err)
}

#[tauri::command]
async fn resize_machine(ui: State<'_, Ui>, id: String, size: String) -> Res {
    ui.app()?.machine(&id).map_err(err)?.resize(&size).await.map_err(err)
}

#[tauri::command]
async fn delete_machine(ui: State<'_, Ui>, id: String, discard: Option<bool>) -> Res {
    let app = ui.app()?;
    let machine = app.machine(&id).map_err(err)?;
    app.delete_machine(&machine, discard.unwrap_or(false)).await.map_err(err)
}

#[tauri::command]
async fn update_settings(handle: AppHandle, ui: State<'_, Ui>, settings: Settings) -> Res {
    let app = ui.app()?;
    if app.settings().start_at_login != settings.start_at_login {
        apply_autostart(&handle, settings.start_at_login).map_err(|e| format!("Couldn't change start at login: {e}"))?;
    }
    app.update_settings(settings);
    emit_state(&handle);
    Ok(())
}

#[tauri::command]
async fn setup_action(handle: AppHandle, ui: State<'_, Ui>, action: String) -> Res {
    let set_busy = |busy: bool| {
        handle.state::<Ui>().setup.lock().unwrap().busy = busy;
        emit_state(&handle);
    };
    match action.as_str() {
        "installBoat" => {
            set_busy(true);
            let result = install_boat().await;
            set_busy(false);
            result.map_err(err)?;
        }
        "signInBoat" => {
            let boat = Boat::locate().ok_or("Boat CLI not found")?;
            set_busy(true);
            let result = sign_in_boat(&handle, &boat).await;
            handle.state::<Ui>().setup.lock().unwrap().sign_in_code = None;
            set_busy(false);
            result.map_err(err)?;
        }
        "installT3" => app::open_url("https://t3.codes").map_err(err)?,
        "recheck" => {}
        other => return Err(format!("unknown setup action {other}")),
    }
    if ui.app.lock().unwrap().is_none() {
        init(handle.clone()).await;
    } else if let Ok(app) = ui.app() {
        refresh_account(&handle, &app.shared.boat).await;
        emit_state(&handle);
    }
    Ok(())
}

/// Boat's browser sign-in: opens its page, shows the code the page may ask for, and waits.
async fn sign_in_boat(handle: &AppHandle, boat: &Boat) -> anyhow::Result<()> {
    let sign_in = boat.start_sign_in().await?;
    handle.state::<Ui>().setup.lock().unwrap().sign_in_code = sign_in.code;
    emit_state(handle);
    app::open_url(&sign_in.url)?;
    boat.finish_sign_in().await
}

/// Boat's own installer, as its docs give it.
async fn install_boat() -> anyhow::Result<()> {
    let status = if cfg!(windows) {
        crate::process::command("powershell")
            .args(["-NoProfile", "-Command", "irm https://boat.dev/install.ps1 | iex"])
            .status()
            .await?
    } else {
        crate::process::command("sh")
            .args(["-c", "curl -fsSL https://boat.dev/install | sh"])
            .status()
            .await?
    };
    anyhow::ensure!(status.success(), "the Boat installer failed");
    Ok(())
}

/// Lets a coding agent CLI control t3boat (registers the MCP server in its user config).
#[tauri::command]
async fn add_mcp(handle: AppHandle, client: mcp::Client) -> Res {
    let result = mcp::register(client).await.map_err(err);
    refresh_mcp(&handle).await;
    result
}

#[tauri::command]
fn quit_app(handle: AppHandle) {
    handle.exit(0);
}

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(std::env::var("RUST_LOG").unwrap_or_else(|_| "info".into()))
        .init();
    tauri::Builder::default()
        // Launching t3boat again, from an app launcher say, shows it.
        .plugin(tauri_plugin_single_instance::init(|handle, _, _| open_panel(handle, None)))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_notification::init())
        .manage(Ui::default())
        .invoke_handler(tauri::generate_handler![
            get_state,
            create_machine,
            local_projects,
            add_project,
            wake_machine,
            sleep_machine,
            open_machine,
            pair_machine,
            delete_machine,
            resize_machine,
            keep_awake,
            sign_in_agent,
            turn_on_connect,
            get_machine_details,
            latest_thread,
            update_settings,
            setup_action,
            add_mcp,
            quit_app
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let open = MenuItem::with_id(app, "open", "Open t3boat", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit t3boat", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            TrayIconBuilder::with_id("main")
                .icon(tauri::image::Image::from_bytes(TRAY_ICON)?)
                .icon_as_template(true)
                .tooltip("t3boat")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => toggle_panel(app, None),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        rect,
                        position,
                        ..
                    } = event
                    {
                        toggle_panel(tray.app_handle(), Some(Anchor { icon: rect, cursor: position }));
                    }
                })
                .build(app)?;

            if let Some(panel) = app.get_webview_window(PANEL) {
                let hide = panel.clone();
                let handle = app.handle().clone();
                // For screen recordings: keep the card up while clicking around other apps.
                let keep_open = std::env::var_os("T3BOAT_KEEP_PANEL_OPEN").is_some();
                panel.on_window_event(move |e| match e {
                    WindowEvent::Focused(false) if !keep_open && !windowed(&handle) => {
                        let _ = hide.hide();
                    }
                    // The panel lives as long as the app: a close (Alt+F4, Cmd+W) only hides it.
                    WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        let _ = hide.hide();
                    }
                    _ => {}
                });
            }
            #[cfg(target_os = "linux")]
            follow_tray_host(app.handle());
            tauri::async_runtime::spawn(init(app.handle().clone()));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building t3boat")
        .run(|_, event| {
            // A tray app keeps running with its window closed.
            if let tauri::RunEvent::ExitRequested { api, code: None, .. } = event {
                api.prevent_exit();
            }
        });
}
