# UI ↔ backend contract

The UI is one frameless popover window (label `panel`, 380×560, fixed size) opened from the tray icon. It hides when it loses focus. Backend: `src-tauri/src/tray.rs`.

## State

`invoke("get_state")` returns `UiState`; the backend also emits event `"state"` with the same payload whenever it differs from what the panel was last sent: as it changes while the panel is shown, and as the panel opens if it changed while hidden. An unchanged state is not sent again.

```ts
type Setup = "starting" | "ready" | "installBoat" | "signInBoat" | "installT3";

type MachineState =
  | "working"   // agent running on it (boat sailing)
  | "idle"      // up, nobody working; detail says when it sleeps
  | "sleeping"  // going to sleep right now
  | "asleep"    // stopped, free; T3 still shows it
  | "waking"    // resuming (a few seconds)
  | "creating"  // being created (~1 min); detail = current step; id is ""
  | "missing"   // deleted on Boat outside the app
  | "unknown";  // checking

interface MachineView {
  id: string;          // never changes (the Boat sandbox it was created on), "" while creating
  name: string;
  size: string;        // "small" | "default" | "large"
  state: MachineState;
  detail: string;      // human line, e.g. "Idle · sleeps in 2m"
  wakeError: string | null; // why the last wake failed, in plain words, until one succeeds or T3
                       // answers anyway (not while it wakes again); the row and details show it as a note with
                       // "Try again" (wake_machine). `state` follows Boat meanwhile
  countdown: { template: string; endsAt: number } | null;
                       // set while detail counts down: template ("Idle · sleeps in {left}") with
                       // {left} = time until endsAt (unix ms); the UI ticks it between state events
  paired: boolean;     // false: T3 Code has not accepted it yet → show "Add to T3 Code"
  agents: { instanceId: string; name: string; signedIn: boolean; canSignIn: boolean }[];
                       // its agents whose sign-in is known. instanceId: T3's provider instance id,
                       // what sign_in_agent takes; name: T3's display name, the user's to edit: only
                       // for showing; canSignIn: t3boat can sign it in, i.e. T3's default Claude and
                       // Codex instances (instanceId "claudeAgent", "codex") → Sign in, else "signed out".
                       // Sign in → sign_in_agent: the vendor's own login runs on the machine, the
                       // browser opens, the user authorizes, done.
  needsSignIn: boolean; // no agent there is signed in (one T3 can't tell counts as maybe signed in), and
                       // t3boat can sign one in: the row offers those with canSignIn
  login: { instanceId: string | null; name: string; step: "waking" | "starting" | "browser" | "finishing" } | null;
                       // a sign-in t3boat runs there (sign_in_agent, turn_on_connect): instanceId =
                       // the agent's (match rows by it), null for T3 Connect; name = the agent's
                       // display name or "T3 Connect", only for showing; step: "Waking…", "Opening sign-in…", then
                       // "Approve in browser…" once its page is open, then "Finishing…" once
                       // signed in. Shown with Cancel → cancel_login, except while finishing.
                       // One at a time per machine; it does not lock the machine's other controls
  t3Version: string;   // T3 server version on the machine, e.g. "0.0.21"; "" while unknown
  projects: { title: string; repoKey: string | null; status: string | null }[];
                       // its T3 projects as last seen (never wakes it), then those t3boat is adding:
                       // status = clone progress in T3's words ("Receiving objects · 42%"), null once
                       // there. repoKey = T3's repository key. Paired with none → "No projects yet · Add one"
  keepAwakeUntil: number | null; // when a "keep awake" runs out (unix ms); null when off or until stopped
  keepAwakeForever: boolean; // kept awake until stopped: no auto sleep
  waiting: boolean; // an agent there waits on the user: resize applies after it next sleeps
  connect: boolean; // T3 Connect is on: the user's phone or a browser reach it with their T3 account
}

interface UiState {
  setup: Setup;
  setupBusy: boolean;              // an install / sign-in started from the UI is running
  signInCode: string | null;       // while a Boat sign-in waits: the code its page may ask for
  account: { identifier: string | null; plan: string | null } | null;
  machines: MachineView[];
  costs: { today: number; month: number; startsToday: number; startsLimit: number | null }; // dollars; today/month
                                   // include machines deleted and sandboxes replaced by a restore in that period;
                                   // startsLimit null: Boat sets none. Looked up every 5 min, when a machine
                                   // starts or stops, and as the panel opens (at most every 30 s)
  settings: { startAtLogin: boolean };
  sizes: { id: string; spec: string; hourly: number }[]; // e.g. {id:"small", spec:"2 vCPU · 4 GB", hourly:0.018}
  mcp: { claudeCode: boolean | null; codex: boolean | null };
                                   // t3boat registered as an MCP server in that CLI; null = CLI not installed
                                   // (Settings → "Coding agents" disables its button with a hint)
}
```

### Machine details

Clicking a machine row or its boat opens a details view. On open, and again on every `"state"` event while it's open, the UI calls `get_machine_details({ id })`; everything else on that view comes from `MachineView` + `UiState.sizes`.

```ts
interface MachineDetails {
  id: string;
  costToday: number;          // dollars, this machine only
  costMonth: number;
  awakeSecsToday: number;
  createdAt: number;          // unix secs
}
```

## Commands (`invoke(name, args)`), all reject with a string message on failure (Boat's refusals in plain words)

| command | args | notes |
|---|---|---|
| `get_state` | – | |
| `create_machine` | `{ name, size, projects? }` | resolves when done (~1 min); a `creating` row shows progress meanwhile; at the end T3 Code shows its own "Add backend?" dialog. `projects`: `local_projects` ids, added one after another once it is up (progress in `projects`; a failure notifies) |
| `local_projects` | – | → `{ id, title, path, repoKey, icon: string \| null }[]`: this computer's T3 Code projects that have a git remote (what T3's own "Add to another machine" accepts), pinned first then most recent, read from T3 Code's server with t3boat's own session. `icon`: favicon as a `data:` URL, null if none (UI shows a letter tile). A project counts as on a machine when one of its `projects` has the same `repoKey` |
| `add_project` | `{ id, projectId }` | adds that project the way T3 Code's "Add to another machine" does: `projectClone.start` on the machine (clone over HTTPS from its remote, registered as a T3 project, progress in T3 Code too), then its `.env` files via `projects.writeFile`. Resolves once cloned; not a tracked action, the machine's `projects` show progress. A clone the git host refuses rejects with a pointer to T3 Code's Settings → Source control for that machine |
| `wake_machine` | `{ id }` | tries again even right after a failed wake |
| `sleep_machine` | `{ id }` | rejects with "an agent is working" mid-turn; a run waiting only on the user does sleep, an approval it waits on expires if the resume is cold |
| `open_machine` | `{ id, thread? }` | brings T3 Code forward, into `thread` (an id from `latest_thread`) if given; re-sends the "add to T3 Code" dialog if not paired |
| `pair_machine` | `{ id }` | re-sends T3 Code's "add backend" dialog (secondary "Add to T3 Code again") |
| `sign_in_agent` | `{ id, instanceId }` | instanceId = an `agents` one's with `canSignIn`; resolves `true` once signed in (user finishes in the browser, up to 5 min), `false` when cancelled. Not a tracked action: the machine's `login` shows it |
| `turn_on_connect` | `{ id }` | turns on T3 Connect with T3's own `t3 connect login`, then `t3 up --connect`, on the machine: T3's sign-in page opens in the browser, the user approves it, T3 restarts there (no longer cancellable); resolves `true` once other devices can reach it (up to ~15 min), `false` when cancelled; not a tracked action, the machine's `login` shows it. Rejects while an agent works or waits on the user there, before the sign-in and again before the restart (the restart would stop it, or expire the approval it waits on). Details shows "other devices · T3 Connect" with Turn on, or "on" |
| `cancel_login` | `{ id }` | ends the sign-in running there (`login`): stops it on the machine, and its keeping the machine awake |
| `keep_awake` | `{ id, minutes }` | keeps the machine up that long even unused (`null`: until stopped, i.e. no auto sleep; 0 ends it; "Sleep now" ends it too); wakes it if asleep; enforced on the machine, so it holds with the laptop closed. Details has an **Auto sleep** switch (on = `!keepAwakeForever`; off → `null`, on → `0`) and, while auto sleep is on, a one-time "Stay awake for…" (15m · 30m · 1h · 2h) that runs out by itself, with Stop (`0`) while `keepAwakeUntil` is set |
| `resize_machine` | `{ id, size }` | asleep: applies on next wake; idle: sleeps and wakes onto it now, keeping a "keep awake"; working (an agent or a build), or an agent there waits on the user: applies after it next sleeps, never mid-turn |
| `delete_machine` | `{ id, discard? }` | permanent; UI must confirm first. Rejects while an agent or build works on it, or while its state can't be told yet (e.g. mid-wake); then offer "Delete anyway" = `discard: true`. An agent there waiting on the user doesn't stop it. T3 Code cannot be told to forget a backend, so deleting a paired machine brings T3 Code to the front with a notification naming the entry to remove under Settings → Environments. Its local port is never given to another machine, so that entry can't reach one. Resolves once the machine is gone here; its sandbox and snapshot are deleted on Boat in the background until Boat confirms (retried, also across launches) |
| `latest_thread` | `{ id }` | → thread id or null: the machine's most recent non-subagent thread; never wakes it. The details footer reads “Open last thread in T3 Code” (“Open T3 Code” if none) and calls `open_machine` with that id |
| `get_machine_details` | `{ id }` | → `MachineDetails`; should work while asleep (from cache / Boat API, without waking it). Rejection = toast, last data stays |
| `add_mcp` | `{ client }` | `"claudeCode" \| "codex"`: registers t3boat as an MCP server in that CLI's config so its agents can control t3boat; resolves when done, then `UiState.mcp[client]` is `true` |
| `update_settings` | `{ settings }` | full settings object |
| `setup_action` | `{ action }` | `"installBoat" \| "signInBoat" \| "installT3" \| "recheck"` |
| `quit_app` | – | |

Machines sleep a fixed 3 minutes after their last agent turn (`provision::SLEEP_AFTER_SECS`); there is no setting. New machines default to Boat's `default` size.
