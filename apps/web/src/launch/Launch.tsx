// The launch video, one 1280 × 720 frame. It opens on the hero's sea and ends signed on plain blue; between, a
// desktop on plain blue: a menu bar, t3boat's popover on its mock backend and T3 Code's window,
// a camera that frames what is happening, the site's red arrow at what to watch, and a band
// below that says what it is. scripts/launch.ts moves the camera, arrow and cursor, and clicks.
import { useEffect, useRef, useState } from "react";
import icon from "@t3boat/desktop/icon.png";
import tray from "../../../desktop/src-tauri/icons/tray@2x.png";
import type { MockBackend } from "@t3boat/desktop/mock";
import type { MachineView } from "@t3boat/desktop/types";
import { Hero } from "../Hero";
import { AppleMark, BoatLogo, LinuxMark, T3CodeMark, WindowsMark } from "../logos";
import { NO_PICK, sendTurn, Thread, type Picker, type Stage } from "../Thread";

/** open: the hero. desk: the popover alone. chat: T3 Code next to it. end: t3boat, signed, on plain blue. */
export type Scene = "open" | "desk" | "chat" | "end";
/** The one machine: made in the popover, then picked in T3 Code. */
export const MACHINE = "beebox";

/** What the band says: the window to watch, the line, and whether time runs fast. */
export interface Line {
  look: "t3boat" | "T3 Code";
  text: string;
  fast?: boolean;
}

export interface LaunchHandle {
  ready: boolean;
  scene(s: Scene): void;
  say(line: Line | null): void;
  /** the camera: scale `s`, then move by `x`, `y` */
  camera(x: number, y: number, s: number): void;
  /** T3 Code's machine picker, as the pointer works it */
  pick(p: Partial<Picker>): void;
  /** the drawn cursor, on the desktop (under the camera) */
  cursor(x: number, y: number, down: boolean): void;
  /** the red arrow's tip, on the desktop; hidden when `shown` is false */
  arrow(x: number, y: number, shown: boolean): void;
  /** time flies for the idle machine until it sleeps */
  later(): void;
}

declare global {
  interface Window {
    launch?: LaunchHandle;
  }
}

export function Launch() {
  const [scene, setScene] = useState<Scene>("open");
  const [line, setLine] = useState<Line | null>(null);
  const [mock, setMock] = useState<MockBackend>();
  const [machines, setMachines] = useState<MachineView[]>([]);
  const [stage, setStage] = useState<Stage>("unsent");
  const [picker, setPicker] = useState<Picker>(NO_PICK);
  const camera = useRef<HTMLDivElement>(null);
  const cursor = useRef<HTMLDivElement>(null);
  const arrow = useRef<HTMLDivElement>(null);
  const home = machines.find((m) => m.name === MACHINE);

  useEffect(() => {
    if (!mock) return;
    mock.call("get_state", undefined).then((s) => setMachines(s.machines));
    return mock.subscribe((s) => setMachines(s.machines));
  }, [mock]);

  const pick = (p: Partial<Picker>) => setPicker((now) => ({ ...now, ...p }));

  const send = () => {
    if (!mock || !home || stage !== "unsent") return;
    sendTurn(mock, home, setStage);
  };

  useEffect(() => {
    window.launch = {
      ready: !!mock,
      scene: setScene,
      say: setLine,
      pick,
      camera(x, y, s) {
        camera.current!.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
      },
      cursor(x, y, down) {
        cursor.current!.style.transform = `translate(${x}px, ${y}px) scale(${down ? 0.86 : 1})`;
      },
      arrow(x, y, shown) {
        arrow.current!.style.transform = `translate(${x}px, ${y}px)`;
        arrow.current!.classList.toggle("is-shown", shown);
      },
      later() {
        if (mock && home) mock.later(home.id, 3000);
      },
    };
  });

  return (
    <div className="launch" data-scene={scene}>
      <Hero nav={<span className="wordmark">t3boat</span>}>
        <h1>
          Run your{" "}
          <span className="h1-t3" role="img" aria-label="T3 Code">
            <T3CodeMark aria-hidden />
            Code
          </span>{" "}
          agents in the cloud, on <BoatLogo className="h1-boat" role="img" aria-label="Boat" />
        </h1>
      </Hero>

      <div className="desk" />

      <div ref={camera} className="camera">
        <div className="menubar">
          <span className="menubar-left">
            <AppleMark className="menubar-apple" aria-hidden />
            <b>T3 Code</b>
            <span>File</span>
            <span>Edit</span>
            <span>View</span>
            <span>Window</span>
            <span>Help</span>
          </span>
          <span className="menubar-right">
            <img className="menubar-tray" src={tray} alt="" />
            <span>Tue Nov 17 9:41</span>
          </span>
        </div>

        <div className="win-t3">
          <Thread machine={MACHINE} stage={stage} picker={picker} onPick={pick} onSend={send} />
        </div>

        <iframe
          className="win-app"
          src="/demo.html?machines=0&ready=1"
          title="t3boat"
          width={380}
          height={560}
          onLoad={(e) => e.currentTarget.contentWindow?.mock?.then(setMock)}
        />

        {/* the site's arrow (Together.tsx): pixels, its tip at the top left */}
        <div ref={arrow} className="arrow" aria-hidden>
          <svg viewBox="-0.5 -0.5 10 10">
            <path d="M0 0h6v1H0zM0 1h5v1H0zM0 2h4v1H0zM0 3h5v1H0zM0 4h2v1H0zM3 4h3v1H3zM0 5h1v1H0zM4 5h3v1H4zM5 6h3v1H5zM6 7h3v1H6zM7 8h2v1H7z" />
          </svg>
        </div>

        <div ref={cursor} className="cursor" aria-hidden>
          <svg viewBox="-1 -1 16 23" width="22" height="33">
            <path d="M0 0v17l4.4-4.2 3 6.8 2.9-1.3-3-6.6H13z" />
          </svg>
        </div>
      </div>

      <div className="band">
        {line && (
          <p key={line.text}>
            <span className="band-look">{line.look}</span>
            {line.text}
          </p>
        )}
        {line?.fast && (
          <span className="band-fast">
            {/* the site's fast-forward sign */}
            <svg viewBox="0 0 9 7" aria-hidden>
              <path d="M0 0h1v1h1v1h1v1h1v1H3v1H2v1H1v1H0zM5 0h1v1h1v1h1v1h1v1H8v1H7v1H6v1H5z" />
            </svg>
            sped up
          </span>
        )}
      </div>

      <div className="endcard">
        <div className="endcard-mark">
          <img src={icon} alt="" width={112} height={112} />
          t3boat
        </div>
        <p className="endcard-line">Free and open source</p>
        <p className="endcard-os">
          <AppleMark aria-hidden />
          <WindowsMark aria-hidden />
          <LinuxMark aria-hidden />
        </p>
        <p className="endcard-url">t3boat.paukraft.com</p>
        <p className="endcard-note">Not affiliated with or endorsed by T3 Code or Boat.</p>
      </div>
    </div>
  );
}
