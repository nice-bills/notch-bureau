# Performance

The user reported the app "feels somehow slow". This file holds the numbers before and after the fix, how they were measured, and what changed.

## How it was measured

Everything runs at **390×844 with the CPU throttled 4×** (Chrome DevTools Protocol `Emulation.setCPUThrottlingRate`), to stand in for a mid-range Android phone.

- **Interactions** use `e2e/perf.spec.ts`, which runs the real app on the local test chain: `PERF=1 NOTCH_LLM=off pnpm e2e -- e2e/perf.spec.ts`.
  - It records frames (requestAnimationFrame), long tasks, and Event Timing. Event Timing measures input to next paint, i.e. how long a tap takes to show on screen.
  - It also reads Chrome's own counters: style recalcs, layouts, and main-thread task time.
  - It runs against the Vite dev server, so compare the before and after columns with each other, not with production.
- **First load** uses production builds (`vite build` + `vite preview`) of the old and the new code.
  - Phone emulation, 4× CPU, network at 1.6 Mbit/s with 150 ms latency.
  - Median of 3 cold loads.

## First load (production build)

| | before | after |
|---|---:|---:|
| First paint (FCP = LCP) | 1572 ms | **1424 ms** |
| JS needed for first paint (gzip) | 129 KB, 1 file | **104 KB**, 1 file |
| Main chunk (raw / gzip) | 421 / 133 KB | **339 / 107 KB** |
| Total blocking time | 0 ms | 0 ms |

The rest of the JS (the other screens, about 31 KB gzip) is fetched while the browser is idle after first paint. Pollar (Google sign-in) and Supabase (live status) were already lazy-loaded, and still are: they load only on use.

## Interactions (4× CPU, dev build)

| Scenario | Metric | before | after |
|---|---|---:|---:|
| Tap → next paint, worst case (any scenario) | ms | 176 | **96** |
| Open Borrow screen | long tasks | 670 ms (5) | **0 ms** |
| | input → paint | 176 ms | **32 ms** |
| | worst frame | 150 ms | **33 ms** |
| Tab switches (Home → Lend → Pool → Home) | long tasks | 306 ms | **180 ms** |
| | input → paint | 128 ms | **96 ms** |
| Account sheet open and close | input → paint | 104 ms | **88 ms** |
| Scroll Home under the glass | frames over 50 ms | 1 | **0** |
| | style recalcs / style time | 59 / 98 ms | **32 / 41 ms** |
| Slide-to-borrow knob drag | style time | 492 ms | **144 ms** |
| | main-thread task time | 3052 ms | **2291 ms** |
| Stamp taps (tear 4) | style time | 111 ms | **80 ms** |
| Mouse sweep, 60 moves (desktop light) | style recalcs / style time | 62 / 1023 ms | **32 / 485 ms** |
| | frames over 50 ms | 53 | **33** |

About the mouse sweep: a control run that writes an unused CSS variable costs almost the same task time. So most of the remaining cost there is the test harness's synthetic mouse input under 4× throttling, not the app. On a phone the light no longer runs at all during touch, as described below.

## What was slow, and the fix

1. **The rim light restyled the whole page on every pointer move and every scroll.**
   - `startLight` wrote `--lx/--ly/--la` on `<html>` for each `pointermove` and `scroll`. On a phone, every finger drag (the slider) and every scroll paid for a full style recalc and a repaint of every glass rim.
   - Now it follows the **mouse only** (touch and pen are ignored), at most about 20 updates a second, and only when the light moves visibly. The scroll handler is gone, and phone tilt is sampled the same way.
2. **The lens filters were rebuilt after every React render.**
   - `buildLenses()` ran in a layout effect with no dependencies. It queried every `.lens` and read `offsetWidth`, which forces a layout on each render.
   - Now a `MutationObserver` rebuilds them only when a `.lens` element is added, or when the window is resized.
3. **Code splitting.**
   - GetLimit, Borrow, Lend, Pool and Attacks are lazy chunks; Attacks pulls in tweetnacl. Only Home is in the first chunk.
   - All chunks are prefetched in `requestIdleCallback` after first paint. A tab also prefetches its chunk on `pointerdown`.
   - A skeleton screen covers the rare case of a chunk that has not arrived yet.
4. **Tap feedback.** The tab-bar pill moves on `pointerdown`, before the next screen renders. `.tap` press feedback takes 200 ms or less.
5. **Transitions are 250 ms or less and use only transform/opacity.**
   - Sheet rise: 460 → 250 ms. Scrim: 300 → 200 ms. Tab pill: 500 → 220 ms. Tab bar: 450 → 250 ms. Stamps: 450 → 220 ms. Meter: 900 → 250 ms. Knob spring back: 500 → 250 ms.
   - The loss-demo bar animated `width` (layout on every frame); it now uses `transform: scaleX`. Its stripes squash slightly at small values, which is accepted.
   - `.tap` no longer transitions `background-color`.
   - One deliberate exception: the limit stamp's one-time "drop" landing is 500 ms (it was 820 ms). It is a celebration, not a navigation, and it is transform-only.
6. **Endless animations moved off the main thread.**
   - The skeleton shimmer and the "Slide to borrow" shimmer used to animate `background-position`, which repaints every frame forever.
   - The skeleton is now a highlight moved with `transform`. The label now "breathes" with `opacity`.
7. **The slide knob.**
   - It read `offsetWidth` on every move, after writing a transform, which forced a layout each move. The width is now measured once, on press.
   - The knob is an opaque dark disc, so its backdrop blur was invisible but re-rendered on every frame. That blur was dropped.
8. **The stamp tilt** on the "limit came back" screen.
   - After the first release, every later move kept a 0.7 s transition, so the stamp lagged behind the finger.
   - It also read `getBoundingClientRect` on every move.
   - Now tracking is 1:1: the box is measured once per gesture, writes are batched per frame, and a 250 ms spring back runs only on release.
9. **Optimistic UI after a confirmed transaction.**
   - `useChain().patch()` applies the known result at once after deposit, draw, repay and deposit withdrawal. It uses absolute values computed from before the action, then re-reads the chain.
   - A read that was already running when the patch landed is dropped, so stale numbers cannot flash back.
   - Chain reads already showed skeletons (Home, Lend, Pool, Borrow). The pool, the line and the balances are global, polled every 12 s and refreshed after every transaction, so the next screen's data is already loaded when it opens.

## Not changed

- **react-dom is 203 KB of the 339 KB main chunk.** Switching to Preact would cut that, but it is a riskier change than this pass.
- **The SVG displacement refraction** (`.lens`, Chromium only) applies to 4 small elements: the tab bar, the back button, the brand pill and the slider track. With the light no longer repainting during scroll and drag, these did not show up as a cost.
