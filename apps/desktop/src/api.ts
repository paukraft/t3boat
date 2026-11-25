import { useCallback, useEffect, useRef, useState } from "react";
import type { CommandArgs, CommandName, CommandResult, MachineDetails, UiState } from "./types";

export interface Backend {
  call<C extends CommandName>(cmd: C, args: CommandArgs<C>): Promise<CommandResult<C>>;
  /** Calls `cb` on every "state" event. Resolves to an unsubscribe function once listening. */
  subscribe(cb: (s: UiState) => void): Promise<() => void>;
}

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function tauriBackend(): Promise<Backend> {
  const [{ invoke }, { listen }] = await Promise.all([
    import("@tauri-apps/api/core"),
    import("@tauri-apps/api/event"),
  ]);
  return {
    call: (cmd, args) => invoke(cmd, args ?? undefined),
    subscribe: (cb) => listen<UiState>("state", (e) => cb(e.payload)),
  };
}

let backendPromise: Promise<Backend> | null = null;
function backend(): Promise<Backend> {
  backendPromise ??= inTauri ? tauriBackend() : import("./mock").then((m) => m.mockBackend());
  return backendPromise;
}

export function call<C extends CommandName>(cmd: C, args: CommandArgs<C>): Promise<CommandResult<C>> {
  return backend().then((b) => b.call(cmd, args));
}

/** Rejections are strings per contract; normalise anything else. */
export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return "Something went wrong";
}

export function useUiState(): { state: UiState | null; loadError: string | null; retry: () => void } {
  const [state, setState] = useState<UiState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    let unsubscribe: (() => void) | undefined;
    (async () => {
      const b = await backend();
      // Listening before the snapshot: an event sent meanwhile is never sent again.
      let pushed = false;
      const stop = await b.subscribe((s) => {
        pushed = true;
        if (alive) setState(s);
      });
      if (!alive) return stop();
      unsubscribe = stop;
      b.call("get_state", undefined).then(
        // an event during the fetch is newer than the snapshot
        (s) => alive && !pushed && setState(s),
        (e) => alive && setLoadError(errorText(e)),
      );
    })();
    return () => {
      alive = false;
      unsubscribe?.();
    };
  }, [attempt]);

  const retry = useCallback(() => {
    setLoadError(null);
    setAttempt((n) => n + 1);
  }, []);

  return { state, loadError, retry };
}

/**
 * Fetches a machine's details now and again whenever `version` changes (pass the
 * latest UiState: a new object arrives with every "state" event). A failed refetch
 * keeps the last data; `onError` fires once per run of failures.
 */
export function useMachineDetails(id: string, version: unknown, onError: (text: string) => void): MachineDetails | null {
  const [details, setDetails] = useState<MachineDetails | null>(null);
  const failing = useRef(false);
  const latest = useRef(0);

  useEffect(() => {
    const req = ++latest.current;
    call("get_machine_details", { id }).then(
      (d) => {
        if (req !== latest.current) return;
        failing.current = false;
        setDetails(d);
      },
      (e) => {
        if (req !== latest.current || failing.current) return;
        failing.current = true;
        onError(errorText(e));
      },
    );
  }, [id, version, onError]);

  return details?.id === id ? details : null;
}

/** The machine's latest thread id, looked up once per machine; null when it has none. */
export function useLatestThread(id: string): string | null {
  const [latest, setLatest] = useState<{ id: string; thread: string | null } | null>(null);
  useEffect(() => {
    let live = true;
    call("latest_thread", { id }).then(
      (thread) => live && setLatest({ id, thread }),
      () => live && setLatest({ id, thread: null }),
    );
    return () => {
      live = false;
    };
  }, [id]);
  return latest?.id === id ? latest.thread : null;
}
