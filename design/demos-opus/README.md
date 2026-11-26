# Notch UI demos (Opus)

Three phone-sized, clickable demos. Same flows, same fake data (Ama in Accra, 45 USDC base limit, 67.50 with Seeker). Each covers onboarding, the Notch inbox, the live check, the limit moment, borrow, lend, and app checks. Open any file in a browser; on desktop a side panel lets you jump to any screen.

| | 1 · Kite | 2 · Ledger | 3 · Post (calm) |
|---|---|---|---|
| Idea | An illustrated sky stays behind every screen. Your statement flies into a locked cloud; your limit comes out as a kite. Kite height = what you can still borrow. | A calm money app. The one loud moment is the sealed box handing you your limit. | Airmail paper: cool grey ground, white cards, navy ink. You mail a sealed envelope; your limit comes back as an engraved stamp you can tilt. |
| Feel | Most playful (Breeje side) | Most "real bank" (Divan side) | Quiet and editorial; colour only on stamps and postmarks |
| Signature moment | Paper plane into the cloud, kite climbs out | Ticket springs out of the box slot, number rolls up | Stamp drops and squashes, blue postmark thumps on |
| Borrow control | Drag the kite knob (5 USDC ticks) | Custom keypad + hold to borrow | Amount chips + slide to borrow, with a sheet of 5-USDC stamps tearing off |
| Lend screen | Accordion cards + layer drawing | Safe/Risky switch + sparkline | Side-by-side Safe/Risky cards + "show a 5% loss" demo |
| Fonts | Bricolage Grotesque + Figtree | Geist + Geist Mono | Instrument Serif + Schibsted Grotesk |
| Risk | Sky can feel childish for lenders | Can read as "another fintech" | Stamp idea needs the intro to land |

## Round 3: why it still read as slop

Decision: Post is the direction. Kite and Ledger are frozen. The user still read round 2 as slop, and couldn't see what had changed.

The 10 biggest tells, judged against the before shots in `round3/before-*.png`:
1. **Empty flat canvas.** Every screen is one flat grey with no depth or material, and half of each screen is dead air (the middle of onboarding, the bottom of the limit screen, the bottom of borrow).
2. **Clip-art.** The envelope with a "+" seal and the flat navy postbox are drawn at a different quality from everything else.
3. **Template buttons.** The same full-width 56 px navy rectangle appears on every screen, as in every AI mockup.
4. **The AI type trope.** A condensed serif headline with one italic blue word ("Mail us your *statement*."), and serif numbers mixed into the UI.
5. **Stamps don't look like stamps.** Borrow shows flat pink tiles with a "5", wrapping 7 + 2 into an orphan row.
6. **Generic form chrome.** A boxed back button with a small grey title, a row of white chips with uneven widths, and a receipt card with dashed dividers.
7. **Everything is a white card with a 1 px ring.** Nothing separates chrome, controls and content.
8. **A weak signature moment.** The stamp drops, but the postmark is faint, the screen around it is empty, and the stamp has no light or material.
9. **Tiny grey filler copy** ("Tilt the stamp", "Step 2 of 3", "Swipe") does the explaining that the UI should do.
10. **Lifeless motion.** Only fades and slides. Controls don't behave like materials: no moving selection, no light, and the tab bar is a static frosted box.

### How round 3 kills each one
1. Content goes full-bleed (a wall of stamps, an engraved rosette field, a real stamp sheet), and Liquid Glass controls float over it.
2. Every object is redrawn at one quality: engraved line art on stamp paper with real paper shadows.
3. Buttons are glass capsules: tinted glass for the main action, clear glass for the rest. They float over content.
4. The UI uses one face (Inter, with tight tracking on big numbers). Serif appears only inside the stamp engravings.
5. Borrow uses a real perforated sheet: 3 columns with a selvage margin. Tap a stamp to tear off up to it.
6. Glass circle back buttons, and a glass segmented control with a sliding lens. The receipt is plain aligned rows.
7. Three layers: paper (content), glass (controls and chrome), ink (text). Cards appear only where grouping is needed.
8. The limit lands on an engraved rosette. The stamp has a foil sheen that follows tilt, and the postmark strikes in full ink.
9. Filler copy is gone. Progress is a glass capsule, and hints come from motion.
10. The glass reacts: the rim light follows your finger or the phone's tilt, the tab-bar lens slides with a spring, and the bar shrinks on scroll.

### Round 3 result
- Live (new, private): https://claude.ai/artifact/JQdUSrGejLDw6QAo82Uw3L, built as `demo-3-post-glass.html` (`build.py` writes it).
- Before and after shots: `round3/compare-intro.png`, `compare-landed.png` and `compare-borrow.png` (plus the raw `before-*` and `after-*` files).
- Inspiration: Saif Shaikh's "Luma" finance app shots (x.com/saifgeeky/status/2125614177159090260). Taken from it: a light neutral ground, white cards, an iridescent foil hero card (our limit stamp), near-black pill buttons, pastel gradient tiles (Safe and Risky), and a floating tab bar.
- The glass is real backdrop blur plus saturation, a conic rim light and a specular bloom, both driven by your pointer or the phone's tilt. In Chromium it also refracts at the edges through an SVG displacement map built for each control's size. Glass is used only on chrome and controls, never stacked. Reduced transparency makes it solid; reduced motion removes the motion.
- Tap test at 390x844: every control responds. The script flags only the slide knob, a false positive: its synthetic click skips the drag, and a real tap nudges the knob and shows a hint.

## Cleanup round 2

Feedback from round 1: "not bad, still sloppy". Solid green and big solid brand fills are out. Mobile money must not read as MoMo-only.

### Rules now held on every screen
- **One type scale:** 12 · 14 · 16 · 20 · 24 · 32 · 40 · 56 · 72 px. Nothing else.
- **8pt spacing grid:** padding, margins and gaps are 4 (half step) or multiples of 8. One side gutter: 24 px. Cards align to that gutter.
- **Component sizes on the grid:** icons 16 / 20 / 24; controls 32 / 40 / 48 / 56 px.
- **One radius set:** 8 · 12 · 16 · 24 · 32 (sheets), plus pills and circles.
- **One icon set:** the shared sprite (`src/icons.html`, 24 px, 1.8 stroke). Illustrations are separate on purpose.
- **Copy:** headers say "your statement" or "mobile money". MTN MoMo appears only as an example source.
- Re-check with `python3 src/normalize.py src/demo-*.src.html` (prints anything off-scale and snaps it), and `src/deadtaps.js` in the browser console (taps every control, lists ones that change nothing).

### What the audit found (and fixed)

**All three (shared core)**
- 23 different font sizes per demo (10, 10.5, 11.5, 12.5, 13, 13.5, 14.5, 15, 17, 19, 22, 26, 30, 34, 38, 44, 46, 60, 76, 84…). Snapped to the 9-step scale.
- Spacing mixed 1, 2, 3, 5, 6, 7, 10, 13, 14, 18, 20, 22, 26 px. Snapped to the 8pt grid. Side gutters were 16, 20, 22 and 24 on different screens; now 24 everywhere.
- Up to 17 different corner radii per demo (10, 13, 14, 15, 18, 20, 22, 26, 28, 34, 36). Now 5.
- Control sizes 34, 36, 38, 42, 44, 46, 50, 52, 54 px. Now 32 / 40 / 48 / 56.
- Bottom-bar padding 12/20/28 and sheet padding 20/22 were off-grid. Now 16/24/32 and 24.
- Headers used "MoMo" as the headline ("Waiting for MoMo", "Send us your MoMo statement", "Lend USDC to MoMo earners", "MTN seal only"). Rewritten provider-neutral.
- Dead taps: Back did nothing after jumping to a screen from the side panel. It now steps back through the flow. A quick tap on any "hold to confirm" button did nothing; it now says "Press and hold to confirm". A plain tap on Post's slide-to-borrow knob did nothing; it now nudges and says "Slide right to borrow". The tap-every-control script finds no other dead controls.

**Kite**
- On load the kite flew in from the top-left corner and sat on the logo. It now starts in place.
- Hills, the baobab and houses showed through the sign-in card (card was 90% opaque). Now 97%.
- Limit screen: the kite string and sun ran across "67.50" and the caption. Kite and sun moved to the edges.
- Inbox "how" chips were 12 px and wrapped ("Open / Statements"). Now 14 px, two words each.
- Due card was a big solid yellow block. Now white with a yellow icon only.
- Borrow slider end label showed "48" when you can borrow 47.50. Shows the real number now.
- Borrow header and breakdown sat at a 16 px gutter while the rest used 24. Aligned.
- Clouds sat over "Hi Ama", the balance and the limit caption. Clouds now hide on the limit, home, lend and checks screens, and the sun no longer sweeps across text on the way to home.
- The kite touched the account button on home and lend. Moved left.
- Borrow button was a big solid orange fill. Now navy like every other main button.
- Bold text mixed 600, 700 and 800 in body copy. Body bold is 600; 800 only in the display face.

**Ledger**
- Status: the progress meter stayed as a heavy black bar under a finished step. It now shows only while that step runs, at 4 px.
- Home due card copy wrapped to three lines ("Due 25 Dec · deposit back after"). Now "Due 25 Dec".
- Spacing and type snapped (14 px gaps and 13.5 px labels were everywhere).

**Post: kept, as a calm version.** The idea never needed the green; the stamp carries the brand.
- Solid green screens and cards are gone. Cool grey ground (#F3F5F8), white cards with hairline rings, navy ink.
- Primary buttons are navy, not solid red. Red and blue live only on small things: stamps, postmark, airmail stripe.
- Risky card was a solid red block. Now a white card with a red title and red fill bar.
- The big stamp is engraved paper (light blue lines, navy number, red label) instead of a solid green block.
- Status station icons were hand-drawn at a different stroke. Now from the shared icon set.
- The inbox "MTN seal only" box became a plain lock mark.
- Gold text on green failed contrast in places. Accents are now blue on white (passes AA).

### Compared with the refs
- **Divan (clean light fintech):** Ledger matches best: big balance with grey cents, round quick actions, filter chips, bottom sheets. Post now shares that calm base.
- **Breeje (illustrated scenes behind frosted cards):** Kite matches best: persistent sky scene, frosted sign-in card, chunky press states.
- The refs are X videos that can't be saved, so this check compares against the notes taken when we watched them.

**My pick:** Ledger as the base app, with Post's stamp as the limit moment. Kite if you want the most playful brand.

## Links (private Artifacts, round 2)
- Kite: https://claude.ai/artifact/Bg8iv8TtJ9QxnRFFs8pm6q
- Ledger: https://claude.ai/artifact/HdQnbSMhqL6MpJsgFfuc7o
- Post: https://claude.ai/artifact/DETnVYiV22CmB4uct8C7QQ

## Files
- `demo-1-kite.html`, `demo-2-ledger.html`, `demo-3-post.html`: built, self-contained.
- `src/`: sources. Edit there, then run `python3 src/build.py` from this folder.
