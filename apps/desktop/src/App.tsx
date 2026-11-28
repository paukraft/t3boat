import { useCallback, useEffect, useMemo, useState } from "react";
import { call, errorText, useUiState } from "./api";
import type { LocalProject, McpClient, MachineView, SetupAction, UiState } from "./types";
import { machineKey, type Action } from "./machine";
import { Ocean, type OceanBoat } from "./components/Ocean";
import { MachineRow } from "./components/MachineRow";
import { NewMachine } from "./components/NewMachine";
import { SettingsView } from "./components/SettingsView";
import { MachineDetails } from "./components/MachineDetails";
import { SetupView } from "./components/SetupView";
import { Costs } from "./components/Costs";
import { Icon } from "./components/Icons";

/** "machine:<id>" = that machine's details */
type View = "list" | "new" | "settings" | `machine:${string}`;
interface Toast {
  id: number;
  text: string;
  tone: "error" | "info";
}

function useToast() {
  const [toast, setToast] = useState<Toast | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.tone === "error" ? 6000 : 4000);
    return () => clearTimeout(t);
  }, [toast]);
  const show = useCallback((text: string, tone: Toast["tone"] = "error") => setToast({ id: Date.now(), text, tone }), []);
  return { toast, show, dismiss: () => setToast(null) };
}

export default function App() {
  const { state, loadError, retry } = useUiState();
  const { toast, show, dismiss } = useToast();

  let body;
  if (loadError) {
    body = (
      <div className="view center">
        <p className="lede">Couldn't reach t3boat: {loadError}</p>
        <button className="btn btn-solid" onClick={retry}>
          Try again
        </button>
      </div>
    );
  } else if (!state) {
    body = <Ocean boats={[]} />;
  } else if (state.setup !== "ready") {
    body = <Setup state={state} onError={show} />;
  } else {
    body = <Ready state={state} toast={show} />;
  }

  return (
    <div className="app">
      {body}
      {toast ? (
        <div key={toast.id} className={`toast is-${toast.tone}`} role={toast.tone === "error" ? "alert" : "status"} onClick={dismiss}>
          {toast.tone === "error" ? <Icon name="alert" size={12} /> : null}
          <span>{toast.text}</span>
        </div>
      ) : null}
    </div>
  );
}

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _, ...rest } = record;
  return rest;
}

function Brand() {
  return (
    <div className="brand">
      <span className="brand-name">t3boat</span>
    </div>
  );
}

function Setup({ state, onError }: { state: UiState; onError: (t: string) => void }) {
  const act = (action: SetupAction) => call("setup_action", { action }).catch((e) => onError(errorText(e)));
  return (
    <>
      <Ocean boats={[{ key: "setup", name: "t3boat", state: "creating" }]}>
        <Brand />
      </Ocean>
      <SetupView setup={state.setup} busy={state.setupBusy} signInCode={state.signInCode} onAction={act} />
    </>
  );
}

function Ready({ state, toast }: { state: UiState; toast: (t: string, tone?: "error" | "info") => void }) {
  const [view, setView] = useState<View>("list");
  const [pickProject, setPickProject] = useState(false); // details opened to add a project there
  const [hover, setHover] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [pending, setPending] = useState<Record<string, string>>({});
  const [deleteErrors, setDeleteErrors] = useState<Record<string, string>>({});
  const back = useCallback(() => setView("list"), []);
  const detailsError = useCallback((text: string) => toast(`Couldn't load details: ${text}`), [toast]);

  const detailsId = view.startsWith("machine:") ? view.slice("machine:".length) : null;
  const selected = detailsId ? state.machines.find((m) => m.id === detailsId) : undefined;
  const canOpen = (m: MachineView) => !!m.id && m.state !== "creating";

  // the machine went away (deleted) while its details were open
  useEffect(() => {
    if (detailsId && !selected) setView("list");
  }, [detailsId, selected]);

  const boats: OceanBoat[] = useMemo(() => {
    const list: OceanBoat[] = state.machines.map((m) => ({
      key: machineKey(m),
      name: m.name,
      state: m.state,
      pickable: canOpen(m),
    }));
    if (view === "new") list.push({ key: "__draft", name: draftName, state: "creating", label: draftName || "new" });
    return list;
  }, [state.machines, view, draftName]);

  const openDetails = (m: MachineView, pick = false) => {
    setPickProject(pick);
    setView(`machine:${m.id}`);
  };

  // Not a tracked action: a clone can take minutes, and its progress shows on the machine.
  const addProject = (m: MachineView, p: LocalProject) =>
    call("add_project", { id: m.id, projectId: p.id }).then(
      () => toast(`${p.title} is on ${m.name}`, "info"),
      (e) => toast(`Couldn't add ${p.title} to ${m.name}: ${errorText(e)}`),
    );

  const pick = (key: string) => {
    const m = state.machines.find((x) => machineKey(x) === key);
    if (m && canOpen(m)) openDetails(m);
  };

  /** Runs a machine command, showing `busy` on its row meanwhile. */
  const track = (m: MachineView, busy: string, job: () => Promise<void>) => {
    const key = machineKey(m);
    setPending((p) => ({ ...p, [key]: busy }));
    job()
      .catch((e) => toast(`${m.name}: ${errorText(e)}`))
      .finally(() => setPending((p) => without(p, key)));
  };

  const act = (m: MachineView, a: Action) =>
    track(m, a.busy, async () => {
      const key = machineKey(m);
      const acceptHint = () => toast(`Switch to T3 Code to accept "${m.name}"`, "info");
      switch (a.cmd) {
        case "delete_machine":
          setDeleteErrors((d) => without(d, key));
          try {
            await call("delete_machine", { id: m.id, discard: a.discard });
          } catch (e) {
            if (a.discard) throw e;
            setDeleteErrors((d) => ({ ...d, [key]: errorText(e) }));
          }
          return;
        case "sign_in_agent":
          await call("sign_in_agent", { id: m.id, agent: a.agent });
          toast(`${a.agent} is signed in on ${m.name}`, "info");
          return;
        case "turn_on_connect":
          await call("turn_on_connect", { id: m.id });
          toast(`${m.name} is reachable from your other devices`, "info");
          return;
        case "keep_awake":
          await call("keep_awake", { id: m.id, minutes: a.minutes });
          return;
        case "resize_machine":
          await call("resize_machine", { id: m.id, size: a.size });
          return;
        case "open_machine":
          await call("open_machine", { id: m.id, thread: a.thread });
          if (!m.paired) acceptHint();
          return;
        default:
          await call(a.cmd, { id: m.id });
          if (a.cmd === "pair_machine") acceptHint();
      }
    });

  const addMcp = (client: McpClient) => call("add_mcp", { client }).catch((e) => toast(errorText(e)));

  const create = (name: string, size: string, projects: string[]) => {
    setView("list");
    call("create_machine", { name, size, projects }).catch((e) => toast(errorText(e)));
  };

  return (
    <>
      <Ocean
        boats={boats}
        active={view === "new" ? "__draft" : selected ? machineKey(selected) : hover}
        compact={view !== "list"}
        onPick={view === "new" ? undefined : pick}
      >
        <Brand />
        <button className="btn btn-icon btn-on-sea" onClick={() => setView("settings")} aria-label="Settings">
          <Icon name="sliders" />
        </button>
      </Ocean>

      {selected ? (
        <MachineDetails
          key={selected.id}
          machine={selected}
          sizes={state.sizes}
          version={state}
          pending={pending[machineKey(selected)] ?? null}
          deleteError={deleteErrors[machineKey(selected)] ?? null}
          pickProject={pickProject}
          onAction={(a) => act(selected, a)}
          onAddProject={(p) => addProject(selected, p)}
          onDismissDeleteError={() => setDeleteErrors((d) => without(d, machineKey(selected)))}
          onError={detailsError}
          onBack={back}
        />
      ) : view === "new" ? (
        <NewMachine state={state} onNameChange={setDraftName} onCreate={create} onBack={back} />
      ) : view === "settings" ? (
        <SettingsView
          state={state}
          onSave={(settings) =>
            call("update_settings", { settings }).catch((e) => {
              toast(errorText(e));
              throw e;
            })
          }
          onAddMcp={addMcp}
          onQuit={() => call("quit_app", undefined).catch((e) => toast(errorText(e)))}
          onBack={back}
        />
      ) : (
        <div className="view">
          {state.machines.length === 0 ? (
            <div className="empty">
              <h1 className="display">No machines yet</h1>
              <p className="lede">
                A machine is a cloud computer your T3 Code agents work on. It sleeps when nobody's working, and
                sleeping is free.
              </p>
              <button className="btn btn-solid btn-lg" onClick={() => setView("new")}>
                <Icon name="plus" /> New machine
              </button>
            </div>
          ) : (
            <>
              <div className="list-head">
                <span className="caption">
                  machines <span className="count">{state.machines.length}</span>
                </span>
                <button className="btn btn-sm btn-solid" onClick={() => setView("new")}>
                  <Icon name="plus" size={12} /> New machine
                </button>
              </div>
              <ul className="list">
                {state.machines.map((m) => (
                  <MachineRow
                    key={machineKey(m)}
                    machine={m}
                    sizes={state.sizes}
                    pending={pending[machineKey(m)] ?? null}
                    deleteError={deleteErrors[machineKey(m)] ?? null}
                    onAction={(a) => act(m, a)}
                    onDismissDeleteError={() => setDeleteErrors((d) => without(d, machineKey(m)))}
                    onHover={setHover}
                    onOpen={canOpen(m) ? (pick) => openDetails(m, pick) : undefined}
                  />
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {selected ? null : <Costs costs={state.costs} />}
    </>
  );
}
