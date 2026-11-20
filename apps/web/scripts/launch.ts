// Films the launch video (launch.html) frame by frame: 1920 × 1080, 30 fps.
// Needs the dev server (`bun dev`), Google Chrome and ffmpeg. Run: bun scripts/launch.ts [out.mp4]
// Time runs on a paused fake clock and every CSS animation is paused and stepped with it, so
// each frame lands exactly where the timeline says, however slow the screenshots are.
import { chromium, type FrameLocator } from "playwright-core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MACHINE, type Line, type Scene } from "../src/launch/Launch";
import { WORK_MS, type Picker } from "../src/Thread";

const URL = new globalThis.URL("launch.html", process.env.SITE ?? "http://localhost:5173/").href;
const OUT = resolve(process.argv[2] ?? "launch.mp4");
const FPS = 30;
const DT = 1000 / FPS;

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5, colorScheme: "light" });
page.on("pageerror", (e) => console.error("page:", e.message));
// paused: only runFor moves time, so slow screenshots don't leak real time into the film
await page.clock.install({ time: 0 });
await page.clock.pauseAt(1000);
await page.goto(URL);

const popover = page.frameLocator("iframe.win-app");
const t3 = page.frameLocator(".win-t3 iframe");

// loading runs on the fake clock too
for (let i = 0; ; i++) {
  await page.clock.runFor(100);
  await page.waitForTimeout(50);
  const ready =
    (await page.evaluate(() => !!window.launch?.ready)) &&
    (await t3.locator('[data-mock="machine-selector"]').count()) > 0 &&
    (await popover.locator("button:has-text('New machine')").count()) > 0;
  if (ready) break;
  if (i > 300) throw new Error("the stage never got ready");
}
await page.evaluate(() => document.fonts.ready);

/** Pauses every animation in every frame and moves it on by `ms`; new ones start at 0. */
async function stepAnimations(ms: number) {
  for (const frame of page.frames()) {
    await frame.evaluate((ms) => {
      for (const a of document.getAnimations() as (Animation & { stepped?: boolean })[]) {
        const t = a.stepped ? Number(a.currentTime ?? 0) + ms : 0;
        a.pause();
        a.currentTime = t;
        a.stepped = true;
      }
    }, ms);
  }
}

// ── the desktop, the camera on it, and what moves over it ──
interface Pt {
  x: number;
  y: number;
}
interface Cam extends Pt {
  s: number;
}
interface Rect extends Pt {
  w: number;
  h: number;
}
/** what the camera shows: the frame above the band */
const VIEW = { w: 1280, h: 720 - 96 };
const FULL: Cam = { x: 0, y: 0, s: 1 };
/** `r` centered above the band, as large as fits */
function framing(r: Rect, fill = 0.94): Cam {
  const s = Math.min((VIEW.w * fill) / r.w, (VIEW.h * fill) / r.h);
  return { s, x: VIEW.w / 2 - s * (r.x + r.w / 2), y: VIEW.h / 2 - s * (r.y + r.h / 2) };
}
/** the windows on the desktop (launch.css) */
const POPOVER: Rect = { x: 868, y: 40, w: 382, h: 562 };
const T3: Rect = { x: 40, y: 56, w: 800, h: 540 };
/** T3 Code's composer, with room above it for the picker's menu */
const COMPOSER = framing({ ...T3, y: 300, h: 296 });
/** off the frame, bottom right: where the cursor waits between clicks */
const AWAY: Pt = { x: 1300, y: 760 };

let cam = FULL;
let cursor = AWAY;
let pressed = false;
/** the arrow's tip, and what it follows: a spot that may move, looked up as it goes */
let arrow: Pt = { x: 640, y: 300 };
let arrowTo: (() => Promise<Pt>) | null = null;
let arrowAt: Pt | null = null;

/** `selector`'s box on the desktop: on screen it is seen through the camera */
async function rect(where: FrameLocator, selector: string): Promise<Rect> {
  const box = (await where.locator(selector).first().boundingBox())!;
  return { x: (box.x - cam.x) / cam.s, y: (box.y - cam.y) / cam.s, w: box.width / cam.s, h: box.height / cam.s };
}
/** a point of `selector`'s box, (`dx`, `dy`) of the way across */
const spot = (where: FrameLocator, selector: string, dx = 0.5, dy = 0.5) => async () => {
  const r = await rect(where, selector);
  return { x: r.x + r.w * dx, y: r.y + r.h * dy };
};

const dir = await mkdtemp(join(tmpdir(), "launch-"));
let n = 0;
/** The fake clock's time so far, ms. */
let clockMs = 0;
/** One frame; `speed` > 1 is a time lapse. */
async function frame(speed = 1) {
  await page.clock.runFor(DT * speed);
  clockMs += DT * speed;
  // React renders off the fake clock: let it commit before the shot
  await page.waitForTimeout(12);
  if (arrowTo) {
    // its spot moves when the window's content does: look it up again now and then
    if (!arrowAt || n % 3 === 0) arrowAt = await arrowTo();
    arrow = { x: arrow.x + (arrowAt.x - arrow.x) * 0.22, y: arrow.y + (arrowAt.y - arrow.y) * 0.22 };
  }
  await page.evaluate(
    ({ cam, cursor, pressed, arrow, shown }) => {
      window.launch!.camera(cam.x, cam.y, cam.s);
      window.launch!.cursor(cursor.x, cursor.y, pressed);
      window.launch!.arrow(arrow.x, arrow.y, shown);
    },
    { cam, cursor, pressed, arrow, shown: !!arrowTo },
  );
  await page.mouse.move(cam.x + cursor.x * cam.s, cam.y + cursor.y * cam.s);
  await stepAnimations(DT);
  await page.screenshot({ path: join(dir, `${String(n++).padStart(5, "0")}.png`) });
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const mix = (a: number, b: number, k: number) => a + (b - a) * k;
/** Over `seconds`, eases the camera and the cursor to where they're told, if anywhere. */
async function go(seconds: number, to: { cam?: Cam; cursor?: Pt } = {}, speed = 1) {
  const from = { cam, cursor };
  const frames = Math.round(seconds * FPS);
  for (let i = 1; i <= frames; i++) {
    const k = ease(i / frames);
    if (to.cam) cam = { x: mix(from.cam.x, to.cam.x, k), y: mix(from.cam.y, to.cam.y, k), s: mix(from.cam.s, to.cam.s, k) };
    if (to.cursor) cursor = { x: mix(from.cursor.x, to.cursor.x, k), y: mix(from.cursor.y, to.cursor.y, k) };
    await frame(speed);
  }
}
const hold = (seconds: number, speed = 1) => go(seconds, {}, speed);
/** Holds until the fake clock reaches `ms`. */
async function until(ms: number, speed = 1) {
  while (clockMs < ms) await frame(speed);
}
/** The arrow goes to `to` and stays on it; null hides it. */
async function point(to: (() => Promise<Pt>) | null) {
  arrowTo = to;
  arrowAt = null;
  // it appears right at its spot instead of flying in from the last one
  if (to) arrow = await to();
}
/** The cursor goes to `to`, unhurried, and clicks; `then` instead of a real click for the mock's drawn-only controls. */
async function click(to: () => Promise<Pt>, then?: () => Promise<unknown>) {
  await go(1, { cursor: await to() });
  await hold(0.25);
  await press(then);
}
/** A click where the cursor is. */
async function press(then?: () => Promise<unknown>) {
  pressed = true;
  await frame();
  if (!then) await page.mouse.down();
  await frame();
  await frame();
  if (then) await then();
  else await page.mouse.up();
  pressed = false;
  await frame();
}
const pick = (p: Partial<Picker>) => page.evaluate((p) => window.launch!.pick(p), p);
async function type(text: string) {
  for (const ch of text) {
    await page.keyboard.press(ch);
    await frame();
    await frame();
    await frame();
  }
}
const scene = (s: Scene) => page.evaluate((s) => window.launch!.scene(s), s);
const say = (line: Line | null) => page.evaluate((line) => window.launch!.say(line), line);

// the arrow's spot: under the machine's status line in the popover
const status = spot(popover, ".row-detail", 0.3, 1.1);
/** the mock's creation steps, 1.8s each: the last asks T3 Code to add it, agents signed in */
const ADDING = 3 * 1800;
const CREATED = 4 * 1800;
/** later(): the countdown runs out over 3s, then the mock's sleep step */
const TO_SLEEP = 3000 + 1800 + 300;

// ── the timeline ──────────────────────────────────────
await hold(1.5);

// the menu bar and t3boat's popover: the machine
await scene("desk");
await say({ look: "t3boat", text: "Create a machine from the menu bar." });
await go(1.4, { cam: framing(POPOVER) });
// the form suggests a name: cleared before it is seen, so the name is typed into an empty field
await click(spot(popover, "button:has-text('New machine')", 0.45, 0.6), async () => {
  await page.mouse.down();
  await page.mouse.up();
  await popover.locator("#machine-name").fill("");
});
await hold(0.8);
await type(MACHINE);
await hold(0.6);
await click(spot(popover, "button:has-text('Launch machine')", 0.5, 0.6));
const launched = clockMs;
await go(0.8, { cursor: AWAY });
await say({ look: "t3boat", text: "It's ready in about a minute.", fast: true });
await until(launched + ADDING + 300, 2.2);
await say({ look: "t3boat", text: "t3boat adds it to T3 Code for you." });
await until(launched + CREATED, 2.2);
await hold(0.4);

// T3 Code next to it: pick the machine, send, the agent works there
await scene("chat");
await say({ look: "T3 Code", text: "In T3 Code, pick the machine." });
await go(1.2, { cam: COMPOSER });
const trigger = spot(t3, '[data-mock="machine-selector"]', 0.5, 0.6);
await click(trigger, () => pick({ menuOpen: true, hovered: true }));
await hold(0.2);
await go(0.5, { cursor: await spot(t3, `[data-mock="machine-option:${MACHINE}"]`, 0.4, 0.55)() });
await pick({ highlightedId: MACHINE });
await hold(0.15);
await press(() => pick({ selectedId: MACHINE, menuOpen: false, highlightedId: null, hovered: false }));
await hold(0.8);
await say({ look: "T3 Code", text: "Then chat as usual." });
await click(spot(t3, 'button[type="submit"]'));
const sent = clockMs;
await say({ look: "T3 Code", text: `The agent works on ${MACHINE}. Close your laptop, it keeps going.`, fast: true });
await go(1.2, { cam: FULL, cursor: AWAY });
await until(sent + WORK_MS, 1.8);
await say({ look: "T3 Code", text: `Done, on ${MACHINE}. Your laptop only showed the chat.` });
await hold(2.4);
await say({ look: "t3boat", text: "Idle for a bit, it goes back to sleep.", fast: true });
await go(1.2, { cam: framing(POPOVER) });
await point(status);
await hold(0.4);
const idle = clockMs;
await page.evaluate(() => window.launch!.later());
await until(idle + TO_SLEEP, 1.6);
await say({ look: "t3boat", text: "Asleep, it costs nothing until your next message." });
await hold(2.4);

await point(null);
await scene("end");
await say(null);
await hold(3.8);

await browser.close();
console.log(`${n} frames, ${(n / FPS).toFixed(1)}s`);

const ffmpeg = Bun.spawnSync(
  [
    "ffmpeg", "-y", "-loglevel", "error",
    "-framerate", String(FPS), "-i", join(dir, "%05d.png"),
    "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-profile:v", "high", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    OUT,
  ],
  { stdio: ["ignore", "inherit", "inherit"] },
);
await rm(dir, { recursive: true });
if (!ffmpeg.success) process.exit(1);
console.log(OUT);
