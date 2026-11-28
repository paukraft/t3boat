// T3 Code and t3boat side by side, each in a frame: a mock of T3 Code's window, and the real
// popover on its mock backend, with no machines yet. The visitor makes one, picks it in T3
// Code, and sends; the agent then works on it. An arrow points at what to click, ringed, its
// note saying what that does (clicking the note works too), or at what to watch meanwhile.
import { useEffect, useRef, useState } from "react";
import type { MockBackend } from "@t3boat/desktop/mock";
import type { MachineView } from "@t3boat/desktop/types";
import { NO_PICK, sendTurn, Thread, type Picker, type Stage } from "./Thread";

type Look = "t3" | "app";

/** Where the arrow points, and what its note says there. */
interface Spot {
  at: string;
  /** the point of its box the arrow's tip goes to */
  x: number;
  y: number;
  text: string;
  /** the visitor's move: click it */
  click?: boolean;
}

/** The visitor's machine: typed into the new-machine form over the name it suggests. */
const NAME = "beebox";
/** The new-machine form's launch button. */
const LAUNCH = ".view-foot button[type=submit]";

/** Where the note sits from the arrow's tip, unless that runs off the stage. */
const NOTE_AT = 38;

/** What happens now: the window to watch, and the first of `spots` found in it. */
interface Phase {
  look: Look;
  spots: Spot[];
  /** the round is over: the note offers to start over */
  done?: boolean;
}

/** What happens now, from the machine, the picker and the thread. */
function phaseOf(machine: MachineView | undefined, picker: Picker, stage: Stage): Phase {
  if (!machine)
    return {
      look: "app",
      spots: [
        { at: LAUNCH, x: 0.5, y: 0.7, text: "Click to launch it", click: true },
        { at: ".empty button, .list-head button", x: 0.6, y: 0.7, text: "Try it: click to create a machine", click: true },
      ],
    };
  // under its status line
  const status = { at: ".row-detail", x: 0.3, y: 1 };
  if (machine.state === "creating" || !machine.paired)
    return { look: "app", spots: [{ ...status, text: "t3boat creates the machine on Boat, sets everything up, and connects it to T3 Code." }] };
  const { name } = machine;
  if (stage === "unsent" && picker.selectedId !== name)
    return {
      look: "t3",
      spots: [
        { at: `[data-mock="machine-option:${name}"]`, x: 0.3, y: 0.8, text: `Click ${name} to run the thread there`, click: true },
        { at: '[data-mock="machine-selector"]', x: 0.5, y: 0.7, text: "Click to pick a machine", click: true },
      ],
    };
  if (stage === "unsent")
    return { look: "t3", spots: [{ at: 'button[type="submit"]', x: 0.9, y: 0.9, text: "Click to send", click: true }] };
  // T3 Code's newest message: the last row of the thread is a spacer
  const newest = { at: ".messages-timeline-row-frame:nth-last-child(2)", x: 0.42, y: 0.45 };
  if (stage !== "idle")
    return { look: "t3", spots: [{ ...newest, text: `The agent works on ${name}. Close your laptop, it keeps going.` }] };
  return { look: "t3", spots: [{ ...newest, text: `Done, on ${name}. Your laptop only showed the chat.` }], done: true };
}

export function Together() {
  const [mock, setMock] = useState<MockBackend>();
  const [machine, setMachine] = useState<MachineView>();
  const [picker, setPicker] = useState(NO_PICK);
  const [stage, setStage] = useState<Stage>("unsent");
  /** the spot the arrow is at, if any is found */
  const [spot, setSpot] = useState<Spot>();
  const box = useRef<HTMLDivElement>(null);
  const pointer = useRef<HTMLDivElement>(null);
  const arrow = useRef<SVGSVGElement>(null);
  const note = useRef<HTMLDivElement>(null);
  const ring = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!mock) return;
    // the visitor's machine: the first one, as the popover starts with none
    mock.call("get_state", undefined).then((s) => setMachine(s.machines[0]));
    const unsubscribe = mock.subscribe((s) => setMachine(s.machines[0]));
    return () => void unsubscribe.then((stop) => stop());
  }, [mock]);

  const now = phaseOf(machine, picker, stage);
  const frameOf = (look: Look) => box.current?.querySelector<HTMLIFrameElement>(`.pane-${look} iframe`);

  const pick = (p: Partial<Picker>) => setPicker((was) => ({ ...was, ...p }));
  const send = () => {
    if (mock && machine && stage === "unsent" && picker.selectedId === machine.name) sendTurn(mock, machine, setStage);
  };
  const startOver = async () => {
    if (!mock || !machine) return;
    await mock.call("delete_machine", { id: machine.id });
    setPicker(NO_PICK);
    setStage("unsent");
  };

  // the arrow follows its spot, which moves with the window's layout and what the window shows
  const phase = useRef(now);
  phase.current = now;
  useEffect(() => {
    const still = matchMedia("(prefers-reduced-motion: reduce)");
    let tick = requestAnimationFrame(function draw(t) {
      tick = requestAnimationFrame(draw);
      const { look, spots } = phase.current;
      const frame = frameOf(look);
      const at = frame?.contentDocument;
      const found = at ? spots.find((s) => at.querySelector(s.at)) : undefined;
      setSpot((was) => (was?.at === found?.at && was?.text === found?.text ? was : found));
      const el = found && at?.querySelector(found.at);
      pointer.current!.style.visibility = ring.current!.style.visibility = el ? "" : "hidden";
      if (!frame || !el) return;
      // what is drawn over the windows sits inside the stage's frame
      const stage = box.current!.getBoundingClientRect();
      const origin = { left: stage.left + box.current!.clientLeft, top: stage.top + box.current!.clientTop };
      const win = frame.getBoundingClientRect();
      const rect = el.getBoundingClientRect();
      // T3 Code's frame is zoomed
      const zoom = win.width / frame.offsetWidth;
      const left = win.left - origin.left + frame.clientLeft + rect.left * zoom;
      const top = win.top - origin.top + frame.clientTop + rect.top * zoom;
      const x = Math.round(left + rect.width * found.x * zoom);
      const y = Math.round(top + rect.height * found.y * zoom);
      pointer.current!.style.transform = `translate(${x}px, ${y}px)`;
      // its note at its tail, kept inside the stage
      const width = note.current!.offsetWidth;
      note.current!.style.left = `${Math.max(-x, Math.min(NOTE_AT, box.current!.clientWidth - x - width))}px`;
      Object.assign(ring.current!.style, {
        transform: `translate(${Math.round(left)}px, ${Math.round(top)}px)`,
        width: `${Math.round(rect.width * zoom)}px`,
        height: `${Math.round(rect.height * zoom)}px`,
        borderRadius: getComputedStyle(el).borderRadius,
      });
      // steps back and forth along its own line
      const nudge = still.matches ? 0 : Math.round(2 + 2 * Math.sin((t / 1000) * 6));
      arrow.current!.style.transform = `translate(${nudge}px, ${nudge}px)`;
    });
    return () => cancelAnimationFrame(tick);
  }, []);

  // the form opens: the name goes in, a key at a time
  useEffect(() => {
    if (spot?.at !== LAUNCH) return;
    const input = frameOf("app")?.contentDocument?.querySelector<HTMLInputElement>("#machine-name");
    if (!input) return;
    // past React's own value setter, so the input event reaches its onChange
    const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!;
    let typed = 0;
    const key = setInterval(() => {
      set.call(input, NAME.slice(0, ++typed));
      input.dispatchEvent(new Event("input", { bubbles: true }));
      if (typed === NAME.length) clearInterval(key);
    }, 90);
    return () => clearInterval(key);
  }, [spot?.at]);

  /** a click on the note: as if on its spot */
  const clickSpot = () => spot && frameOf(now.look)?.contentDocument?.querySelector<HTMLElement>(spot.at)?.click();

  return (
    <main id="how-it-works" className="together">
      <h2>Create a machine. Pick it in T3 Code. Your agents run there.</h2>
      <p className="together-lede">
        Try it right here: click where the <span className="together-red">red arrow</span> points.
      </p>

      <div ref={box} className="stage" data-look={now.look}>
        <p className="stage-badge">Interactive demo</p>
        <div className="pane-t3">
          <Thread machine={machine?.paired ? machine.name : undefined} stage={stage} picker={picker} onPick={pick} onSend={send} />
        </div>

        {/* around the spot, when it is the visitor's to click */}
        <div ref={ring} className="ring" data-on={spot?.click || undefined} />

        <div ref={pointer} className="pointer" data-click={spot?.click || undefined}>
          {/* pixels, its tip at the top left */}
          <svg ref={arrow} viewBox="-0.5 -0.5 10 10" aria-hidden>
            <path d="M0 0h6v1H0zM0 1h5v1H0zM0 2h4v1H0zM0 3h5v1H0zM0 4h2v1H0zM3 4h3v1H3zM0 5h1v1H0zM4 5h3v1H4zM5 6h3v1H5zM6 7h3v1H6zM7 8h2v1H7z" />
          </svg>
          <div ref={note} className="note" aria-live="polite" data-ai-ignore>
            {spot?.click ? (
              <button key={spot.text} type="button" onClick={clickSpot}>
                {spot.text}
              </button>
            ) : (
              <p key={spot?.text}>
                {spot?.text}
                {now.done && (
                  <button type="button" onClick={startOver}>
                    Start over
                  </button>
                )}
              </p>
            )}
          </div>
        </div>

        <div className="pane-app">
          <iframe
            src="/demo.html?machines=0&ready=1"
            title="t3boat demo"
            width={380}
            height={560}
            loading="lazy"
            onLoad={(e) => e.currentTarget.contentWindow?.mock?.then(setMock)}
          />
        </div>
      </div>
    </main>
  );
}
