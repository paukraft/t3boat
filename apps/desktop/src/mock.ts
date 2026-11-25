// Browser-only stand-in for the Tauri backend so `bun run dev` works without Tauri.
// URL params shape the starting state: ?setup=installBoat|signInBoat|installT3|starting
// ?machines=0|many|<count>  ?busy=1  ?mcp=mixed (Claude Code added, Codex not installed)
// ?projects=0|error (T3 Code has no projects with a remote / listing them fails)
// ?ready=1 (a new machine comes up in T3 Code with its agents signed in and acme on it, as the website shows it)
import type { Backend } from "./api";
import { timeLapse } from "./pixel/clock";
import type { CommandArgs, CommandName, LocalProject, MachineDetails, MachineProject, MachineView, Setup, UiState } from "./types";

const params = new URLSearchParams(location.search);

type Seed = Omit<
  MachineView,
  "wakeError" | "countdown" | "agents" | "needsSignIn" | "login" | "t3Version" | "projects" | "keepAwakeUntil" | "keepAwakeForever" | "waiting" | "connect"
> &
  Partial<Pick<MachineView, "wakeError" | "countdown" | "agents" | "needsSignIn" | "projects" | "connect">>;
/** T3's default Claude and Codex instances (those t3boat signs in), both signed in or neither. */
const agents = (signedIn: boolean): Pick<MachineView, "agents" | "needsSignIn"> => ({
  agents: [
    { instanceId: "claudeAgent", name: "Claude", signedIn, canSignIn: true },
    { instanceId: "codex", name: "Codex", signedIn, canSignIn: true },
  ],
  needsSignIn: !signedIn,
});
const machine = (m: Seed): MachineView => ({
  wakeError: null,
  countdown: null,
  ...agents(true),
  login: null,
  t3Version: "0.0.21",
  projects: [],
  keepAwakeUntil: null,
  keepAwakeForever: false,
  waiting: false,
  connect: false,
  ...m,
});

const onMachine = (title: string, repoKey: string): MachineProject => ({ id: title, title, repoKey, status: null });

/** T3 Code's projects with a git remote: pinned first, then most recent; most have no favicon. */
const LOCAL_PROJECTS: LocalProject[] = [
  { id: "p1", title: "t3code", path: "/Users/you/Documents/Dev/t3code", repoKey: "github.com/pingdotgg/t3code", icon: null },
  { id: "p2", title: "website", path: "/Users/you/Documents/Dev/website", repoKey: "github.com/you/website", icon: null },
  { id: "p3", title: "acme", path: "/Users/you/Documents/Dev/acme", repoKey: "github.com/you/acme", icon: null },
  { id: "p4", title: "dotfiles", path: "/Users/you/dotfiles", repoKey: "github.com/you/dotfiles", icon: null },
];

/** An idle machine's detail: sleeps 3 minutes from now. */
const idle = () => ({ detail: "Idle · sleeps in 3m", countdown: { template: "Idle · sleeps in {left}", endsAt: Date.now() + 3 * 60_000 } });

const WAKING = { state: "waking", detail: "Waking up…", wakeError: null, countdown: null } as const;

/** Kept awake until `endsAt` (unix ms). */
const keptAwake = (endsAt: number) => ({
  state: "idle" as const,
  keepAwakeForever: false,
  keepAwakeUntil: endsAt,
  detail: "Kept awake",
  countdown: { template: "Kept awake · {left} left", endsAt },
});

const seedMachines: MachineView[] = [
  // first: asleep until its T3 Code sends a turn
  machine({ id: "sb_e4d1", name: "devbox", size: "default", state: "asleep", detail: "Asleep · free", paired: true, projects: [onMachine("acme", "github.com/you/acme")] }),
  machine({
    id: "sb_7f2a",
    name: "t3-main",
    size: "default",
    state: "working",
    detail: "Working · 2 threads · 3 subagents",
    paired: true,
    projects: [onMachine("t3code", "github.com/pingdotgg/t3code"), onMachine("website", "github.com/you/website")],
    connect: true,
  }),
  machine({
    id: "sb_19c0",
    name: "side-quest",
    size: "small",
    state: "idle",
    ...idle(),
    paired: true,
    ...agents(false),
  }),
  machine({ id: "sb_02bb", name: "scratch", size: "small", state: "idle", detail: "Idle · not in T3 Code yet", paired: false }),
];

const manyExtra: MachineView[] = [
  machine({ id: "sb_aa01", name: "docs-site", size: "small", state: "waking", detail: "Waking up…", paired: true }),
  machine({
    id: "sb_aa02",
    name: "infra",
    size: "default",
    state: "asleep",
    detail: "Asleep",
    wakeError: "Boat's limit on machine starts is reached for now. Try again later.",
    paired: true,
  }),
  machine({ id: "sb_aa03", name: "old-spike", size: "small", state: "missing", detail: "Deleted on Boat", paired: true }),
  machine({ id: "", name: "new-api", size: "default", state: "creating", detail: "Installing T3 server…", paired: false }),
];

/** Per-machine extras get_machine_details adds on top of MachineView. */
const seedDetails: Record<string, { awake: number; month: number; days: number }> = {
  sb_7f2a: { awake: 8040, month: 6.4, days: 13 },
  sb_19c0: { awake: 1260, month: 1.1, days: 4 },
  sb_e4d1: { awake: 0, month: 3.9, days: 30 },
};

function seed(): UiState {
  const m = params.get("machines");
  const all = [...seedMachines, ...manyExtra];
  const count = Number(m);
  const machines =
    m === "many"
      ? all
      : count >= 0 && m
        ? Array.from({ length: count }, (_, i) => {
            const base = all[i % all.length];
            const lap = Math.floor(i / all.length);
            return lap ? { ...base, id: base.id && `${base.id}-${lap}`, name: `${base.name}-${lap + 1}` } : base;
          })
        : seedMachines;
  return {
    setup: (params.get("setup") as Setup | null) ?? "ready",
    setupBusy: params.get("busy") === "1",
    signInCode: params.get("busy") === "1" && params.get("setup") === "signInBoat" ? "XM22-RFXJ" : null,
    account: { identifier: "you@example.com", plan: "Pro" },
    machines: structuredClone(machines),
    costs: { today: 0.42, month: 12.8, startsToday: 3, startsLimit: 50 },
    settings: { startAtLogin: true },
    mcp: params.get("mcp") === "mixed" ? { claudeCode: true, codex: null } : { claudeCode: false, codex: false },
    sizes: [
      { id: "small", spec: "2 vCPU · 4 GB", hourly: 0.018 },
      { id: "default", spec: "4 vCPU · 8 GB", hourly: 0.036 },
      { id: "large", spec: "8 vCPU · 16 GB", hourly: 0.072 },
    ],
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The mock, with T3 Code's side of a machine: what the real backend sees through its proxy. */
export interface MockBackend extends Backend {
  /**
   * A turn sent from T3 Code, a stage at a time for a demo that steps through it: the
   * machine wakes for the message, an agent works on it, and once that is done it idles.
   */
  turn(id: string, stage: "wake" | "work" | "done"): void;
  /**
   * Time flies for an idle machine: its countdown runs out within `ms`, the sea a time lapse
   * meanwhile, then it goes to sleep.
   */
  later(id: string, ms: number): Promise<void>;
}

let shared: MockBackend | null = null;
/** One per page: the UI and whoever plays T3 Code next to it share its state. */
export const mockBackend = (): MockBackend => (shared ??= create());

function create(): MockBackend {
  let state = seed();
  const listeners = new Set<(s: UiState) => void>();

  const emit = () => {
    state = structuredClone(state);
    listeners.forEach((l) => l(state));
  };
  const patch = (id: string, p: Partial<MachineView>) => {
    state.machines = state.machines.map((m) => (m.id === id ? { ...m, ...p } : m));
    emit();
  };
  const find = (id: string) => {
    const m = state.machines.find((x) => x.id === id);
    if (!m) throw "machine not found";
    return m;
  };

  /** Each machine's latest sign-in: a cancelled one's steps must not run on into the next. */
  const logins = new Map<string, symbol>();
  /** A browser sign-in as the backend runs it: waking, its page opening, the user approving, putting it to use. False once cancelled. */
  const browserLogin = async (id: string, instanceId: string | null, name: string) => {
    const running = find(id).login;
    if (running) throw `the ${running.name} sign-in is still open there; finish or cancel it first`;
    const mine = Symbol();
    logins.set(id, mine);
    for (const [step, ms] of [["waking", 1200], ["starting", 800], ["browser", 3000], ["finishing", 1000]] as const) {
      patch(id, { login: { instanceId, name, step } });
      await wait(ms);
      if (!find(id).login || logins.get(id) !== mine) return false;
    }
    patch(id, { login: null });
    return true;
  };

  const setupOrder: Setup[] = ["installBoat", "signInBoat", "installT3", "ready"];

  const handlers: { [C in CommandName]: (a: CommandArgs<C>) => Promise<unknown> } = {
    get_state: async () => structuredClone(state),

    async create_machine({ name, size, projects }) {
      if (state.machines.some((m) => m.name === name)) throw `a machine called "${name}" already exists`;
      const row = machine({ id: "", name, size, state: "creating", detail: "Creating sandbox…", paired: false });
      state.machines = [...state.machines, row];
      emit();
      const steps = ["Creating sandbox…", "Installing T3 server…", "Starting T3 server…", "Asking T3 Code to add it…"];
      for (const step of steps) {
        state.machines = state.machines.map((m) => (m.name === name ? { ...m, detail: step } : m));
        emit();
        await wait(1800);
      }
      const id = `sb_${Math.random().toString(16).slice(2, 6)}`;
      state.machines = state.machines.map((m) =>
        m.name === name
          ? {
              ...m,
              id,
              state: "idle",
              ...idle(),
              ...(params.get("ready") === "1"
                ? { paired: true, projects: projects?.length ? [] : [onMachine("acme", "github.com/you/acme")] }
                : agents(false)),
            }
          : m,
      );
      state.costs.startsToday += 1;
      emit();
      for (const p of projects ?? []) await handlers.add_project({ id, projectId: p });
    },

    async local_projects() {
      await wait(400);
      if (params.get("projects") === "error") throw "T3 Code is not running";
      return params.get("projects") === "0" ? [] : LOCAL_PROJECTS;
    },

    async add_project({ id, projectId }) {
      const p = LOCAL_PROJECTS.find((x) => x.id === projectId);
      if (!p) throw "no such project";
      const set = (status: string | null) =>
        patch(id, { projects: [...find(id).projects.filter((x) => x.repoKey !== p.repoKey), { id: p.id, title: p.title, repoKey: p.repoKey, status }] });
      set("Waking the machine");
      await wait(900);
      for (const pct of [8, 35, 71, 100]) {
        set(`Receiving objects · ${pct}% · 3.1 MiB/s`);
        await wait(700);
      }
      set("Checking out files");
      await wait(600);
      set(null);
    },

    async wake_machine({ id }) {
      find(id);
      patch(id, WAKING);
      await wait(2600);
      patch(id, { state: "idle", ...idle() });
      state.costs.startsToday += 1;
      emit();
    },

    async sleep_machine({ id }) {
      if (find(id).state === "working") throw "an agent is working";
      patch(id, { state: "sleeping", detail: "Going to sleep…", countdown: null });
      await wait(1800);
      // A stop ends any keep-awake, as on a real machine.
      patch(id, { state: "asleep", detail: "Asleep · free", keepAwakeUntil: null, keepAwakeForever: false });
    },

    async keep_awake({ id, minutes }) {
      await wait(600);
      patch(
        id,
        minutes === null
          ? { keepAwakeForever: true, keepAwakeUntil: null, state: "idle", detail: "Awake until you stop it", countdown: null }
          : minutes
            ? keptAwake(Date.now() + minutes * 60_000)
            : { keepAwakeForever: false, keepAwakeUntil: null, ...idle() },
      );
    },

    async resize_machine({ id, size }) {
      const m = find(id);
      if (m.state === "idle") {
        patch(id, { state: "sleeping", detail: "Moving to " + size + "…", countdown: null });
        await wait(1600);
        patch(id, WAKING);
        await wait(2200);
        patch(id, { size, state: "idle", ...idle() });
      } else {
        patch(id, { size });
      }
    },

    async turn_on_connect({ id }) {
      if (!(await browserLogin(id, null, "T3 Connect"))) return false;
      patch(id, { connect: true });
      return true;
    },

    async sign_in_agent({ id, instanceId }) {
      const agent = find(id).agents.find((a) => a.instanceId === instanceId && a.canSignIn);
      if (!agent) throw "this agent has to be signed in from T3 Code's settings";
      if (!(await browserLogin(id, instanceId, agent.name))) return false;
      patch(id, {
        agents: find(id).agents.map((a) => (a.instanceId === instanceId ? { ...a, signedIn: true } : a)),
        needsSignIn: false,
      });
      return true;
    },

    async cancel_login({ id }) {
      if (find(id).login) patch(id, { login: null });
    },

    async open_machine({ id }) {
      const m = find(id);
      if (!m.paired) {
        await wait(1200);
        patch(id, { paired: true, ...idle() });
      }
      // pretend the user finishes the agent sign-ins in T3 Code
      if (m.needsSignIn) setTimeout(() => patch(id, agents(true)), 4000);
    },

    async pair_machine({ id }) {
      find(id);
      await wait(1200);
      patch(id, { paired: true });
    },

    async delete_machine({ id, discard }) {
      if (find(id).state === "working" && !discard) {
        await wait(400);
        throw "work is still running on it (an agent or a build); wait for it to finish, or delete and discard";
      }
      await wait(500);
      state.machines = state.machines.filter((x) => x.id !== id);
      emit();
    },

    async latest_thread({ id }) {
      await wait(150);
      return id === "sb_7f2a" ? "th_1" : null;
    },

    async get_machine_details({ id }): Promise<MachineDetails> {
      const m = find(id);
      await wait(350);
      const size = state.sizes.find((s) => s.id === m.size);
      const extra = seedDetails[id] ?? { awake: 0, month: 0, days: 0 };
      const awake = extra.awake + (m.state === "working" || m.state === "idle" ? 300 : 0);
      const costToday = (awake / 3600) * (size?.hourly ?? 0);
      return {
        id,
        costToday,
        costMonth: extra.month + costToday,
        awakeSecsToday: awake,
        createdAt: Math.floor(Date.now() / 1000) - extra.days * 86400,
      };
    },

    async add_mcp({ client }) {
      if (state.mcp[client] === null) throw "not installed";
      await wait(900);
      state.mcp = { ...state.mcp, [client]: true };
      emit();
    },

    async update_settings({ settings }) {
      state.settings = settings;
      emit();
    },

    async setup_action({ action }) {
      state.setupBusy = true;
      emit();
      await wait(1600);
      state.setupBusy = false;
      if (action === "recheck" || action === state.setup) {
        state.setup = setupOrder[setupOrder.indexOf(state.setup) + 1] ?? "ready";
      }
      emit();
    },

    async quit_app() {
      console.info("[mock] quit_app");
    },
  };

  // The watchdog: a timed keep-awake that ran out falls back to the idle countdown, and an
  // idle machine sleeps when its countdown runs out.
  setInterval(() => {
    const now = Date.now();
    state.machines
      .filter((m) => m.state === "idle" && m.keepAwakeUntil !== null && m.keepAwakeUntil <= now)
      .forEach((m) => patch(m.id, { keepAwakeUntil: null, ...idle() }));
    state.machines
      .filter((m) => m.state === "idle" && !m.keepAwakeUntil && m.countdown && m.countdown.endsAt <= now)
      .forEach((m) => void handlers.sleep_machine({ id: m.id }));
  }, 500);

  if (state.setup === "starting") {
    setTimeout(() => {
      state.setup = "installBoat";
      emit();
    }, 1500);
  }

  return {
    async call(cmd, args) {
      await wait(120);
      return (handlers[cmd] as (a: typeof args) => Promise<never>)(args);
    },
    async subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    turn(id, stage) {
      if (stage === "wake") state.costs.startsToday += 1;
      patch(
        id,
        stage === "wake"
          ? WAKING
          : stage === "work"
            ? { state: "working", detail: "Working · 1 thread", countdown: null }
            : { state: "idle", ...idle() },
      );
    },
    async later(id, ms) {
      const { countdown } = find(id);
      const left = countdown ? countdown.endsAt - Date.now() : 0;
      const ticks = Math.round(ms / 100);
      timeLapse(left / ms);
      for (let i = 1; countdown && i <= ticks; i++) {
        await wait(ms / ticks);
        // woken, slept or deleted meanwhile: no more time to skip
        if (state.machines.find((m) => m.id === id)?.state !== "idle") break;
        patch(id, { countdown: { ...countdown, endsAt: Date.now() + (left * (ticks - i)) / ticks } });
      }
      timeLapse(1);
      if (state.machines.find((m) => m.id === id)?.state === "idle") await handlers.sleep_machine({ id });
    },
  };
}
