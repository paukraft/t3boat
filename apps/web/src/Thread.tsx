// T3 Code in a frame: public/t3code is a mock of its window built from T3 Code's own source
// (twittergame's apps/embed; `bun run embed` there rebuilds it). This draws a new thread with
// its machine picker, then, once sent, one turn on the picked machine as far along as `stage`
// says. The mock only draws the picker: clicks on it come back here, to whoever holds it.
// Shared by the site's demo (Together.tsx) and the launch video (launch/Launch.tsx).
import { useEffect, useRef, useState } from "react";
import type { MockBackend } from "@t3boat/desktop/mock";
import type { MachineView } from "@t3boat/desktop/types";

type Message =
  | { kind: "user" | "assistant"; id: string; text: string }
  /** something the agent did */
  | { kind: "work"; id: string; label: string; icon: "eye" | "square-pen" | "terminal" }
  /** the running turn's header: "Working for 12s" */
  | { kind: "working"; id: string; elapsed: string };

interface Environment {
  id: string;
  label: string;
  kind: "laptop" | "server";
}

/** The machine picker under the composer, before the first send. */
export interface Picker {
  selectedId: string;
  menuOpen: boolean;
  highlightedId: string | null;
  hovered: boolean;
}

/** This device, in the picker. */
export const LOCAL = "local";
export const NO_PICK: Picker = { selectedId: LOCAL, menuOpen: false, highlightedId: null, hovered: false };

/** The mock's handle on its window. */
interface Frame {
  show(scene: {
    title: string;
    messages: Message[];
    draft: string;
    running: boolean;
    machine?: string;
    picker?: Picker & { environments: Environment[] };
  }): void;
  /** the send button was pressed */
  onSend: (() => void) | null;
}

export type Stage = "unsent" | "waking" | "working" | "idle";

/** How long a message takes to wake a sleeping machine: long enough to read that it does. */
const WAKE_MS = 3500;
/** How long the agent works on it: its steps, its reply, and a moment to read that. */
export const WORK_MS = 7500;

const TITLE = "Fix the flaky checkout test";
const PROMPT = "The checkout test is flaky on CI. Fix it, then run the whole suite.";
const STEPS = [
  { label: "Read 3 files", icon: "eye" },
  { label: "Edited cart.ts", icon: "square-pen" },
  { label: "Edited checkout.test.ts", icon: "square-pen" },
  { label: "Ran tests", icon: "terminal" },
] as const;
const REPLY = "It raced the cart's debounce. The test now awaits the flush, and all 212 tests pass.";

/** The thread's message, sent to `m`: it wakes if asleep, the agent works, then it idles. */
export function sendTurn(mock: MockBackend, m: MachineView, onStage: (s: Stage) => void) {
  const wake = m.state === "asleep" ? WAKE_MS : 0;
  if (wake) {
    mock.turn(m.id, "wake");
    onStage("waking");
  }
  setTimeout(() => {
    mock.turn(m.id, "work");
    onStage("working");
  }, wake);
  setTimeout(() => {
    mock.turn(m.id, "done");
    onStage("idle");
  }, wake + WORK_MS);
}

/**
 * `machine`: the one the picker offers besides this device, once there is one. `onPick`: a
 * click on the picker, as the change it makes.
 */
export function Thread({
  machine,
  stage,
  picker,
  onPick,
  onSend,
}: {
  machine?: string;
  stage: Stage;
  picker: Picker;
  onPick: (p: Partial<Picker>) => void;
  onSend: () => void;
}) {
  const [win, setWin] = useState<Window & { t3code?: Frame }>();
  /** how far the working agent is: its steps one by one, then its reply */
  const [done, setDone] = useState(0);
  const [secs, setSecs] = useState(0);
  const menuOpen = useRef(picker.menuOpen);
  menuOpen.current = picker.menuOpen;
  const pick = useRef(onPick);
  pick.current = onPick;

  useEffect(() => {
    if (stage === "unsent") {
      setDone(0);
      setSecs(0);
    }
    if (stage === "unsent" || stage === "idle") return;
    const clock = setInterval(() => setSecs((n) => n + 1), 1000);
    const work =
      stage === "working" ? setInterval(() => setDone((n) => n + 1), WORK_MS / (STEPS.length + 1.5)) : undefined;
    return () => {
      clearInterval(clock);
      clearInterval(work);
    };
  }, [stage]);

  // the picker's clicks: its button opens the menu, an option picks, anywhere else closes it
  useEffect(() => {
    if (!win) return;
    const click = (e: MouseEvent) => {
      const spot = (e.target as Element).closest("[data-mock]")?.getAttribute("data-mock");
      if (spot === "machine-selector") pick.current({ menuOpen: !menuOpen.current, hovered: true });
      else if (spot?.startsWith("machine-option:"))
        pick.current({ ...NO_PICK, selectedId: spot.slice("machine-option:".length) });
      else if (menuOpen.current) pick.current({ menuOpen: false, highlightedId: null, hovered: false });
    };
    const over = (e: PointerEvent) => {
      const spot = (e.target as Element).closest("[data-mock]")?.getAttribute("data-mock");
      if (spot?.startsWith("machine-option:")) pick.current({ highlightedId: spot.slice("machine-option:".length) });
    };
    win.document.addEventListener("click", click);
    win.document.addEventListener("pointerover", over);
    return () => {
      win.document.removeEventListener("click", click);
      win.document.removeEventListener("pointerover", over);
    };
  }, [win]);

  useEffect(() => {
    const frame = win?.t3code;
    if (!frame) return;
    frame.onSend = onSend;
    const answered = stage === "idle" || done > STEPS.length;
    const steps = STEPS.slice(0, answered ? STEPS.length : done).map((s, i) => ({ kind: "work" as const, id: `w${i}`, ...s }));
    frame.show(
      stage === "unsent"
        ? {
            title: "New thread",
            messages: [],
            draft: PROMPT,
            running: false,
            picker: {
              ...picker,
              environments: [
                { id: LOCAL, label: "MacBook Pro", kind: "laptop" },
                ...(machine ? [{ id: machine, label: machine, kind: "server" as const }] : []),
              ],
            },
          }
        : {
            title: TITLE,
            messages: [
              { kind: "user", id: "u", text: PROMPT },
              ...(answered ? [] : [{ kind: "working" as const, id: "working", elapsed: `${secs}s` }]),
              ...steps,
              ...(answered ? [{ kind: "assistant" as const, id: "a", text: REPLY }] : []),
            ],
            draft: "",
            running: !answered,
            machine,
          },
    );
  });

  return (
    <div className="t3">
      <iframe
        src="/t3code/index.html"
        title="T3 Code"
        loading="lazy"
        onLoad={(e) => setWin(e.currentTarget.contentWindow ?? undefined)}
      />
    </div>
  );
}
