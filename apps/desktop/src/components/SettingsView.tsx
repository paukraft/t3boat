import { useState } from "react";
import type { McpClient, Settings, UiState } from "../types";
import { AgentName, AgentNames } from "./AgentLogos";
import { Icon } from "./Icons";
import { Dots } from "./common";
import { SubHeader } from "./SubHeader";

const CLIENTS: { id: McpClient; name: string }[] = [
  { id: "claudeCode", name: "Claude Code" },
  { id: "codex", name: "Codex" },
];

interface Props {
  state: UiState;
  /** rejects once the caller showed the error */
  onSave: (s: Settings) => Promise<void>;
  /** never rejects; errors are shown by the caller */
  onAddMcp: (client: McpClient) => Promise<void>;
  onQuit: () => void;
  onBack: () => void;
}

export function SettingsView({ state, onSave, onAddMcp, onQuit, onBack }: Props) {
  // optimistic while saving; the backend sends the new state before the save resolves
  const [saving, setSaving] = useState<Settings | null>(null);
  const s = saving ?? state.settings;

  // hidden by default so screen recordings don't leak the email
  const [showEmail, setShowEmail] = useState(false);
  const email = state.account?.identifier;
  const plan = state.account?.plan;

  const [adding, setAdding] = useState<McpClient | null>(null);
  const add = (client: McpClient) => {
    setAdding(client);
    onAddMcp(client).finally(() => setAdding(null));
  };
  const missing = CLIENTS.filter((c) => state.mcp[c.id] === null).map((c) => c.name);

  const change = (p: Partial<Settings>) => {
    const next = { ...s, ...p };
    setSaving(next);
    // either way the props now hold the latest confirmed settings
    const done = () => setSaving(null);
    onSave(next).then(done, done);
  };

  return (
    <div className="view">
      <SubHeader title="Settings" onBack={onBack} />
      <div className="view-body settings">
        <p className="hint">
          Machines sleep 3 minutes after their agents finish and wake by themselves when you use them in T3 Code.
        </p>
        <label className="setting setting-row">
          <span className="setting-name">Start at login</span>
          <input
            type="checkbox"
            role="switch"
            className="switch"
            checked={s.startAtLogin}
            disabled={saving !== null}
            onChange={(e) => change({ startAtLogin: e.target.checked })}
          />
        </label>
        <div className="setting">
          <span className="caption">mcp</span>
          <span className="setting-name">
            Let <AgentNames names={CLIENTS.map((c) => c.name)} /> control t3boat
          </span>
          <div className="mcp-buttons">
            {CLIENTS.map((c) => {
              const added = state.mcp[c.id];
              return added ? (
                <span key={c.id} className="mcp-added">
                  <Icon name="check" size={10} />
                  <span>
                    Added to <AgentName name={c.name} />
                  </span>
                </span>
              ) : (
                <button
                  key={c.id}
                  className="btn btn-sm btn-outline"
                  disabled={added === null || adding !== null}
                  aria-busy={adding === c.id}
                  onClick={() => add(c.id)}
                >
                  {adding === c.id ? (
                    <>
                      <Dots /> Adding…
                    </>
                  ) : (
                    <span>
                      Add to <AgentName name={c.name} />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <span className="hint">
            {missing.length ? (
              <>
                <AgentNames names={missing} /> {missing.length === 1 ? "isn't" : "aren't"} installed on this computer
              </>
            ) : (
              "Their agents can then create, wake and send work to machines"
            )}
          </span>
        </div>
      </div>
      <div className="view-foot settings-foot">
        <span className="setting-value" title="Boat account">
          {email && (
            <button className="account-email" onClick={() => setShowEmail((v) => !v)}>
              {showEmail ? email : "Show email"}
            </button>
          )}
          {email && plan && " · "}
          {plan}
        </span>
        <button className="btn btn-sm btn-quiet" onClick={onQuit}>
          Quit t3boat
        </button>
      </div>
    </div>
  );
}
