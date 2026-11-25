import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useMachineDetails, useLatestThread } from "../api";
import type { MachineDetails as Details, LocalProject, MachineLogin, MachineView, Size } from "../types";
import {
  ACTIONS,
  autoSleep,
  duration,
  hourly,
  STAY_AWAKE,
  keepAwake,
  canCancelLogin,
  loginStep,
  machineKey,
  money,
  powerAction,
  openIn,
  primaryAction,
  resizeHint,
  resizeTo,
  seedOf,
  shortDate,
  signInTo,
  sizeOf,
  timeLeft,
  TURN_ON_CONNECT,
  type Action,
  type LoginAction,
} from "../machine";
import { AgentName } from "./AgentLogos";
import { BoatIcon } from "./BoatIcon";
import { DeleteErrorNote, Dots, useArmed, useDetail, useEscape, useSecsLeft } from "./common";
import { Icon } from "./Icons";
import { ProjectPicker } from "./ProjectPicker";
import { SubHeader } from "./SubHeader";

interface Props {
  machine: MachineView;
  sizes: Size[];
  /** latest UiState; every new one triggers a details refetch */
  version: unknown;
  pending: string | null;
  deleteError: string | null;
  /** opened from the row's "Add a project…" or "Add one": start with the project picker open */
  pickProject: boolean;
  onAction: (a: Action) => void;
  onLogin: (l: LoginAction) => void;
  onCancelLogin: () => void;
  onAddProject: (p: LocalProject) => void;
  onDismissDeleteError: () => void;
  onError: (text: string) => void;
  onBack: () => void;
}

export function MachineDetails({
  machine: m,
  sizes,
  version,
  pending,
  deleteError,
  pickProject,
  onAction,
  onLogin,
  onCancelLogin,
  onAddProject,
  onDismissDeleteError,
  onError,
  onBack,
}: Props) {
  const d = useMachineDetails(m.id, version, onError);
  const busy = !!pending;
  const gone = m.state === "missing";
  const latestThread = useLatestThread(m.id);
  const primary = primaryAction(m) ?? (m.paired ? openIn(latestThread) : ACTIONS.pair);
  const [primaryArmed, armPrimary] = useArmed();

  const runPrimary = () =>
    primary.cmd === "delete_machine" ? armPrimary(() => onAction(primary)) : onAction(primary);

  return (
    <div className={`view details state-${m.state}`}>
      <SubHeader title={m.name} onBack={onBack} />
      <div className="view-body details-body">
        <Glance m={m} size={sizeOf(sizes, m.size)} d={d} />
        {gone ? null : <Power m={m} busy={busy} onAction={onAction} />}
        <Agents m={m} busy={busy} onLogin={onLogin} onCancelLogin={onCancelLogin} />
        <Connect m={m} busy={busy} onLogin={onLogin} onCancelLogin={onCancelLogin} />
        <Projects m={m} pickProject={pickProject} onAddProject={onAddProject} />
        <MachineMore
          m={m}
          sizes={sizes}
          busy={busy}
          deleteError={deleteError}
          onAction={onAction}
          onDismissDeleteError={onDismissDeleteError}
        />
        <p className="details-meta">
          {d ? (
            <>
              {m.t3Version && (
                <>
                  <span>T3 {m.t3Version}</span>
                  <span className="sep">·</span>
                </>
              )}
              <span>created {shortDate(d.createdAt)}</span>
              <span className="sep">·</span>
              <span className="selectable details-id">{m.id}</span>
            </>
          ) : (
            <span className="skel skel-meta" />
          )}
        </p>
      </div>
      <div className="view-foot details-foot">
        <button
          className={`btn btn-lg ${primaryArmed ? "btn-danger" : primary.solid ? "btn-solid" : "btn-outline"}`}
          disabled={busy}
          aria-busy={busy}
          onClick={runPrimary}
        >
          {pending ? (
            <>
              <Dots /> {pending}
            </>
          ) : primaryArmed ? (
            "Confirm"
          ) : (
            <>
              {primary.label}
              {primary.cmd === "open_machine" && !primary.solid ? <Icon name="open" size={10} /> : null}
            </>
          )}
        </button>
      </div>
    </div>
  );
}

/** What a user scans for first: is it working, what is it, what does it cost. */
function Glance({ m, size, d }: { m: MachineView; size: Size | undefined; d: Details | null }) {
  // "Working · 2 threads · 3 subagents" → headline "Working", the rest underneath
  const detail = useDetail(m);
  const [headline, ...rest] = detail.split(" · ");
  return (
    <section className="glance" aria-label={`${m.name}: ${detail}`}>
      <div className="glance-top">
        <div className="glance-boat">
          <BoatIcon state={m.state} seed={seedOf(machineKey(m))} />
        </div>
        <div className="glance-text">
          <span className="glance-state">
            <i className="state-dot" aria-hidden />
            {headline}
          </span>
          {rest.length ? <span className="glance-detail">{rest.join(" · ")}</span> : null}
          <span className="glance-spec">
            <span className="chip">{m.size}</span>
            {size ? (
              <>
                <span>{size.spec}</span>
                <span className="glance-rate">{hourly(size.hourly)}</span>
              </>
            ) : null}
          </span>
        </div>
      </div>
      <div className="glance-costs">
        <Stat label="today" value={d && money(d.costToday)} />
        <Stat label="this month" value={d && money(d.costMonth)} />
        <Stat label="awake today" value={d && duration(d.awakeSecsToday)} />
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="cost">
      <span className="caption">{label}</span>
      <span className="cost-value">{value ?? <span className="skel skel-value" />}</span>
    </div>
  );
}

function Section({ title, count, extra, children }: { title: string; count?: number; extra?: ReactNode; children: ReactNode }) {
  return (
    <section className="section">
      <div className="section-head">
        <span className="caption">
          {title}
          {count ? <span className="count">{count}</span> : null}
        </span>
        <span className="section-rule" />
        {extra}
      </div>
      {children}
    </section>
  );
}

function Power({ m, busy, onAction }: { m: MachineView; busy: boolean; onAction: (a: Action) => void }) {
  const power = powerAction(m);
  // optimistic, so the switch moves on click; the next state is the source of truth
  const [want, setWant] = useState<boolean | null>(null);
  useEffect(() => {
    if (!busy) setWant(null);
  }, [busy]);
  const on = want ?? !m.keepAwakeForever;

  return (
    <Section title="power">
      <label className="toggle">
        <span className="toggle-text">
          <span className="toggle-name">Auto sleep</span>
          <span className="hint">
            {on ? "Sleeps 3 min after agents finish; asleep is free" : "Stays up and bills until you turn this back on"}
          </span>
        </span>
        <input
          type="checkbox"
          role="switch"
          className="switch"
          checked={on}
          disabled={busy}
          onChange={(e) => {
            setWant(e.target.checked);
            onAction(autoSleep(e.target.checked));
          }}
        />
      </label>
      <div className="power-row">
        {/* the wake-failure note below has the same action as "Try again" */}
        {m.wakeError && power === ACTIONS.wake ? null : (
          <button className="btn btn-sm btn-quiet" disabled={busy || !power} onClick={() => power && onAction(power)}>
            {(power ?? ACTIONS.sleep).label}
          </button>
        )}
        {on ? <StayAwake m={m} busy={busy} onAction={onAction} /> : null}
      </div>
      {m.wakeError ? (
        <div className="row-note is-danger" role="alert">
          <span className="row-note-text">Couldn't wake: {m.wakeError}</span>
          <button className="btn btn-link" disabled={busy} onClick={() => onAction(ACTIONS.retry)}>
            {ACTIONS.retry.label}
          </button>
        </div>
      ) : null}
    </Section>
  );
}

/** Like caffeinate: a one-time "stay up at least this long", which simply runs out. */
function StayAwake({ m, busy, onAction }: { m: MachineView; busy: boolean; onAction: (a: Action) => void }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  useEscape(open, close);
  const left = useSecsLeft(m.keepAwakeUntil);

  if (m.keepAwakeUntil !== null) {
    return (
      <div className="stay-awake is-on" role="status">
        <i className="state-dot" aria-hidden />
        <span className="stay-awake-left">Awake · {timeLeft(left)} left</span>
        <button className="btn btn-link" disabled={busy} onClick={() => onAction(keepAwake(0))}>
          Stop
        </button>
      </div>
    );
  }
  return (
    <div className="stay-awake">
      <button
        className={`btn btn-sm btn-quiet stay-awake-btn${open ? " is-open" : ""}`}
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen((o) => !o)}
      >
        Stay awake for…
        <Icon name="chevron" size={8} />
      </button>
      {open ? (
        <div className="segmented stay-awake-options" role="menu">
          {STAY_AWAKE.map((min) => (
            <button
              key={min}
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onAction(keepAwake(min));
              }}
            >
              {duration(min * 60)}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

interface LoginProps {
  m: MachineView;
  /** a tracked action runs for this machine */
  busy: boolean;
  onLogin: (l: LoginAction) => void;
  onCancelLogin: () => void;
}

/** Where a sign-in is, with a way out: it can wait on a browser tab that was left. */
function LoginRunning({ login, onCancel }: { login: MachineLogin; onCancel: () => void }) {
  return (
    <span className="line-status caption">
      <Dots /> <span className="line-status-text">{loginStep(login)}</span>
      {canCancelLogin(login) ? (
        <button className="btn btn-link" onClick={onCancel}>
          Cancel
        </button>
      ) : null}
    </span>
  );
}

function Agents({ m, busy, onLogin, onCancelLogin }: LoginProps) {
  const login = m.login;
  // A running sign-in keeps its row even when the list was cleared meanwhile (T3 upgraded during the wake).
  const agents =
    login?.instanceId != null && !m.agents.some((a) => a.instanceId === login.instanceId)
      ? [...m.agents, { instanceId: login.instanceId, name: login.name, signedIn: false, canSignIn: false }]
      : m.agents;
  if (!agents.length) return null;
  return (
    <Section title="agents">
      <ul className="lines">
        {agents.map((a) => (
          <li key={a.instanceId} className="line">
            <span className="line-main">
              <AgentName name={a.name} />
            </span>
            {login?.instanceId === a.instanceId ? (
              <LoginRunning login={login} onCancel={onCancelLogin} />
            ) : a.signedIn ? (
              <span className="line-ok">
                <Icon name="check" size={10} /> signed in
              </span>
            ) : a.canSignIn ? (
              <button
                className="btn btn-sm btn-outline"
                disabled={busy || !!login || m.state === "missing"}
                onClick={() => onLogin(signInTo(a))}
              >
                Sign in
              </button>
            ) : (
              <span className="caption">signed out</span>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** T3 Connect: the user's phone or a browser reach the machine with their T3 account. */
function Connect({ m, busy, onLogin, onCancelLogin }: LoginProps) {
  return (
    <Section title="other devices">
      <ul className="lines">
        <li className="line">
          <span className="line-main">T3 Connect</span>
          {m.connect ? (
            <span className="line-ok">
              <Icon name="check" size={10} /> on
            </span>
          ) : m.login && m.login.instanceId === null ? (
            <LoginRunning login={m.login} onCancel={onCancelLogin} />
          ) : (
            <button
              className="btn btn-sm btn-outline"
              disabled={busy || !!m.login || m.state === "missing"}
              onClick={() => onLogin(TURN_ON_CONNECT)}
            >
              Turn on
            </button>
          )}
        </li>
        {m.connect ? null : (
          <li className="line">
            <span className="line-main line-dim">T3 Code on your phone or in a browser, with your T3 account</span>
          </li>
        )}
      </ul>
    </Section>
  );
}

/** Its T3 projects, and adding one the way T3 Code's "Add to another machine" does. */
function Projects({
  m,
  pickProject,
  onAddProject,
}: {
  m: MachineView;
  pickProject: boolean;
  onAddProject: (p: LocalProject) => void;
}) {
  const gone = m.state === "missing";
  if (gone && !m.projects.length) return null;
  return (
    <Section title="projects" count={m.projects.length}>
      <ul className="lines">
        {m.projects.map((p) => (
          <li key={p.id} className="line">
            <span className="line-main" title={p.title}>
              {p.title}
            </span>
            {p.status ? (
              <span className="line-status caption" title={p.status}>
                <Dots /> {p.status}
              </span>
            ) : null}
          </li>
        ))}
        {!m.projects.length && !gone ? (
          <li className="line">
            <span className="line-main line-dim">Cloned from its git remote, .env files included</span>
          </li>
        ) : null}
        {gone ? null : (
          <li className="line line-send">
            <ProjectPicker m={m} initialOpen={pickProject} onAdd={onAddProject} />
          </li>
        )}
      </ul>
    </Section>
  );
}


/** The rare stuff: size and delete, folded away. */
function MachineMore({
  m,
  sizes,
  busy,
  deleteError,
  onAction,
  onDismissDeleteError,
}: {
  m: MachineView;
  sizes: Size[];
  busy: boolean;
  deleteError: string | null;
  onAction: (a: Action) => void;
  onDismissDeleteError: () => void;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [deleteArmed, armDelete] = useArmed();
  const size = sizeOf(sizes, m.size);
  const gone = m.state === "missing";

  // a refused delete (from here or the list) must be visible
  useEffect(() => {
    if (deleteError && ref.current) ref.current.open = true;
  }, [deleteError]);

  return (
    <details ref={ref} className="section more">
      <summary className="section-head">
        <span className="caption">machine</span>
        <span className="section-rule" />
        <span className="caption more-peek">
          {gone ? "gone" : size ? `${m.size} · ${hourly(size.hourly)}` : m.size}
        </span>
        <Icon name="chevron" size={8} />
      </summary>
      <div className="more-body">
        {gone ? null : (
          <div className="more-group">
            <span className="toggle-name">Size</span>
            <div className="segmented" role="radiogroup" aria-label="Size">
              {sizes.map((s) => (
                <button
                  key={s.id}
                  role="radio"
                  aria-checked={s.id === m.size}
                  className={s.id === m.size ? "is-on" : undefined}
                  disabled={busy}
                  onClick={() => s.id !== m.size && onAction(resizeTo(s.id))}
                >
                  {s.id}
                  <small>{s.spec}</small>
                  <small>{hourly(s.hourly)}</small>
                </button>
              ))}
            </div>
            <span className="hint">{resizeHint(m)}</span>
          </div>
        )}
        <div className="more-group">
          <button
            className={`btn btn-sm ${deleteArmed ? "btn-danger" : "btn-quiet is-danger"} delete-btn`}
            disabled={busy}
            onClick={() => armDelete(() => onAction(ACTIONS.del))}
          >
            {deleteArmed ? "Click again to delete forever" : "Delete machine…"}
          </button>
          {deleteError ? (
            <DeleteErrorNote
              error={deleteError}
              busy={busy}
              onDeleteAnyway={() => onAction(ACTIONS.deleteAnyway)}
              onKeep={onDismissDeleteError}
            />
          ) : null}
        </div>
      </div>
    </details>
  );
}
