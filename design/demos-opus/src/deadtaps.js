// Paste into a demo page: taps every visible control on each screen and lists the ones that change nothing.
window.deadTaps = (async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const dead = [];
  const screens = $$('.jump button').map(b => b.dataset.go);
  for (const id of screens) {
    jumpTo(id); await wait(500);
    const scr = $(`.screen[data-screen="${id}"]`);
    const ctrls = [...scr.querySelectorAll('button, .tap, [role="button"]')].filter(b => b.offsetParent && !b.closest('.tabs'));
    for (let i = 0; i < ctrls.length; i++) {
      jumpTo(id); await wait(350);
      const list = [...scr.querySelectorAll('button, .tap, [role="button"]')].filter(b => b.offsetParent && !b.closest('.tabs'));
      const b = list[i]; if (!b) continue;
      const before = device.innerHTML;
      b.click(); await wait(450);
      if (device.innerHTML === before) dead.push(id + ': ' + (b.getAttribute('aria-label') || b.textContent.trim().replace(/\s+/g, ' ')).slice(0, 40));
      closeSheet(); await wait(300);
    }
  }
  jumpTo(screens[0]);
  return dead;
});
