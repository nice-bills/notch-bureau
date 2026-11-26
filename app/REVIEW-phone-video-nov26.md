# User's phone recording (Nov 26, 11:58, Phantom in-app browser via trycloudflare)

Frames: /tmp/claude-1000/-home-bills-code/6efa98d8-3a55-43a1-83a9-299df8bf7381/scratchpad/vid1/t01..t08.png (1 fps contact sheets).
Video: /home/bills/.t3/userdata/attachments/1bc36785-f76a-4ed1-8b69-01fb48d873d3-b62bdbc9-beb0-4436-9054-8911fd35bb75-mp4.mp4

## Blockers (user is angry about 1 and 2)
1. **Wallet asked 3 times.** The user connected on Home, but Lend and Pool still showed "Connect wallet" and opened the "Sign in to start" sheet again. Connection state is per-screen. It must be ONE app-level session:
   - connect once, and every tab knows it;
   - silent reconnect on reload (wallet-standard `connect({ silent: true })` / remembered wallet);
   - never show "Connect wallet" on a tab while connected.
2. **Tab switching is bad.** Every tab switch shows a fully BLANK white screen for about 1 s. That looks like a full page reload or lazy chunks with no fallback. Once, it dropped the user back to the "Get started" landing page, signed out. Tabs must switch instantly:
   - keep all 3 tab screens mounted (or prefetched) and swap them with a transform/opacity transition;
   - no blank frames, no route reload, no losing state.
3. **"Post my limit" failed twice** with "Something went wrong" (the user never opened the real error). Find the cause on a fresh Phantom devnet wallet. Likely suspects: no devnet SOL for fees, the RPC through the tunnel, or a signing error. Then:
   - fix it;
   - if the wallet has no SOL, say so in plain words, with a one-tap devnet airdrop/faucet.
4. **The limit is lost after Back.** After the failed post, tapping Back went to "No limit yet", and the signed limit (27.76) vanished. Keep the signed limit (localStorage per wallet, until it expires or is posted) and show "Limit ready, post it" on Home.

## Also visible in the video
5. **Glass tab bar on the landing page** covers the "Get started" button. Hide the tab bar before sign-in. Elsewhere it covers content at the bottom of every screen: add a bottom content inset equal to tab bar height plus the safe area.
6. **Landing hero text sits on top of busy stamps**, so the body copy is hard to read. Give it a solid/blurred backing or move the stamps.
7. **Lend amount sheets with the iOS keyboard:** the keyboard and accessory bar cover the sheet, and the field and title get squashed into the accessory row. Use `inputmode="decimal"` and keep the sheet above the keyboard (visualViewport).
8. **Safe/Risky cards:** the text is cut off ("Hurt first, bigger fe…") and there's a stray white vertical bar on each card (a scrollbar or a decoration?). Fix the wrapping and remove the bar.
9. **Empty grey boxes** while balances load (the Lend "You have lent" box and the "Yours" boxes). Use proper skeleton shimmer or the last known value.
10. **0 test USDC and no way to get some.** Add a "Get test USDC" button (devnet only), so a judge can try Lend/Borrow without a script.
11. **Home "No limit yet" copy** still says "MTN MoMo works today". Keep MoMo out of the main copy (it's one example source only).
