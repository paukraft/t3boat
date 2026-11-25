// Mirrors docs/ui-contract.md exactly.

export type Setup = "starting" | "ready" | "installBoat" | "signInBoat" | "installT3";

export type MachineState =
  | "working"
  | "idle"
  | "sleeping"
  | "asleep"
  | "waking"
  | "creating"
  | "missing"
  | "unknown";

export interface MachineView {
  id: string;
  name: string;
  size: string;
  state: MachineState;
  detail: string;
  wakeError: string | null; // why the last wake failed, in plain words, until one succeeds or T3 answers anyway; not while it wakes again
  countdown: Countdown | null; // set while `detail` counts down
  paired: boolean;
  agents: AgentLogin[]; // its agents whose sign-in is known
  needsSignIn: boolean; // no agent there is signed in: offer a sign-in for those it `canSignIn`
  login: MachineLogin | null; // a browser sign-in t3boat runs there
  t3Version: string; // "" while unknown
  projects: MachineProject[]; // its T3 projects as last seen (never wakes it), then those being added
  keepAwakeUntil: number | null; // when a "keep awake" runs out (unix ms); null when off or until stopped
  keepAwakeForever: boolean; // kept awake until someone stops it: no auto sleep
  waiting: boolean; // an agent there waits on the user: a resize waits for the next sleep
  connect: boolean; // T3 Connect is on: the user's other devices reach it with their T3 account
}

/** An agent provider on a machine: T3's `instanceId` picks it, its display `name` (the user's to edit) shows it. */
export interface AgentRef {
  instanceId: string;
  name: string;
}

export interface AgentLogin extends AgentRef {
  signedIn: boolean;
  canSignIn: boolean; // t3boat can sign it in there (T3's default Claude and Codex)
}

/** A sign-in t3boat runs on a machine: an agent's (`instanceId` as in `agents`), or T3 Connect's (`instanceId` null). */
export interface MachineLogin {
  instanceId: string | null;
  name: string; // the agent's display name, or "T3 Connect"
  // browser: its page is open, the user approves it there; finishing: signed in, no longer cancellable
  step: "waking" | "starting" | "browser" | "finishing";
}

export interface MachineProject {
  id: string; // T3's project id on the machine; while t3boat adds it, the local project's id
  title: string;
  repoKey: string | null; // T3's repository key: the same repo has it on every machine
  status: string | null; // set while t3boat adds it: clone progress as T3 Code words it
}

/** A T3 Code project on this computer that can go to a machine (it has a git remote). */
export interface LocalProject {
  id: string;
  title: string;
  path: string;
  repoKey: string;
  icon: string | null; // data: URL of the project's favicon in T3 Code
}

/** `detail` as `template` with `{left}` filled in: the time left until `endsAt` (unix ms). */
export interface Countdown {
  template: string;
  endsAt: number;
}

export interface Settings {
  startAtLogin: boolean;
}

export interface Size {
  id: string;
  spec: string;
  hourly: number;
}

export type McpClient = "claudeCode" | "codex";

export interface UiState {
  setup: Setup;
  setupBusy: boolean;
  /** while a Boat sign-in waits: the code its page may ask for */
  signInCode: string | null;
  account: { identifier: string | null; plan: string | null } | null;
  machines: MachineView[];
  costs: { today: number; month: number; startsToday: number; startsLimit: number | null }; // null: no limit
  settings: Settings;
  sizes: Size[];
  /** null = that CLI isn't installed */
  mcp: Record<McpClient, boolean | null>;
}

export interface MachineDetails {
  id: string;
  costToday: number;
  costMonth: number;
  awakeSecsToday: number;
  createdAt: number; // unix secs
}

export type SetupAction = "installBoat" | "signInBoat" | "installT3" | "recheck";

export interface Commands {
  get_state: [undefined, UiState];
  create_machine: [{ name: string; size: string; projects?: string[] }, void]; // projects: LocalProject ids to add once up
  local_projects: [undefined, LocalProject[]]; // pinned first, then most recent
  add_project: [{ id: string; projectId: string }, void]; // resolves once cloned
  wake_machine: [{ id: string }, void];
  sleep_machine: [{ id: string }, void];
  open_machine: [{ id: string; thread?: string }, void];
  pair_machine: [{ id: string }, void];
  delete_machine: [{ id: string; discard?: boolean }, void];
  resize_machine: [{ id: string; size: string }, void];
  keep_awake: [{ id: string; minutes: number | null }, void]; // null: until stopped; 0: stop
  sign_in_agent: [{ id: string; instanceId: string }, boolean]; // false: cancelled
  turn_on_connect: [{ id: string }, boolean]; // resolves once reachable, after the browser sign-in; false: cancelled
  cancel_login: [{ id: string }, void];
  latest_thread: [{ id: string }, string | null]; // thread id
  get_machine_details: [{ id: string }, MachineDetails];
  add_mcp: [{ client: McpClient }, void];
  update_settings: [{ settings: Settings }, void];
  setup_action: [{ action: SetupAction }, void];
  quit_app: [undefined, void];
}

export type CommandName = keyof Commands;
export type CommandArgs<C extends CommandName> = Commands[C][0];
export type CommandResult<C extends CommandName> = Commands[C][1];
