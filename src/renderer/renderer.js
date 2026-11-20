// Page entry point: loads the clips, checks transparency, then wires the
// player, behaviour and mouse handling to the main process.
(function () {
  'use strict';

  const api = window.lulu;
  const describe = (err) => (err && err.stack ? err.stack : String(err));

  window.addEventListener('error', (event) => api.reportError(`Uncaught: ${describe(event.error || event.message)}`));
  window.addEventListener('unhandledrejection', (event) => api.reportError(`Unhandled rejection: ${describe(event.reason)}`));

  // Click-through everywhere except on Lulu: the window ignores the mouse
  // (forwarding moves to us) until the cursor is over one of her pixels.
  function setupPointer({ canvas, player, behaviour, hitTester, config }) {
    let interactive = false;
    let over = null; // 'lulu' | 'bowl' | null
    let mouse = null;
    let drag = null;
    let lastCheck = 0;
    let checkTimer = null;
    const rub = window.LuluLogic.createRubDetector({
      minTravelPx: config.petMinTravelPx,
      reversals: config.petReversals,
      windowMs: config.petWindowMs,
    });

    const setInteractive = (on) => {
      if (on === interactive) return;
      interactive = on;
      if (!on) rub.reset();
      api.setInteractive(on);
      document.body.classList.toggle('over-lulu', on);
    };

    const check = () => {
      checkTimer = null;
      lastCheck = performance.now();
      if (drag) return;
      if (!mouse) {
        setInteractive(false);
        return;
      }
      if (hitTester.hit(player.source, { ...behaviour.view(), size: player.displaySize() }, mouse.x, mouse.y)) over = 'lulu';
      else if (player.bowlHit(mouse.x, mouse.y)) over = 'bowl';
      else over = null;
      setInteractive(over !== null);
    };

    const scheduleCheck = () => {
      if (checkTimer !== null) return;
      const wait = Math.max(0, config.hitCheckMs - (performance.now() - lastCheck));
      checkTimer = setTimeout(check, wait);
    };

    const onDragMove = (event) => {
      const dx = event.clientX - drag.startX;
      if (!drag.moved && Math.abs(dx) > config.dragThresholdPx) {
        drag.moved = true;
        if (drag.kind === 'lulu') behaviour.beginDrag();
      }
      if (!drag.moved) return;
      if (drag.kind === 'lulu') behaviour.dragTo(drag.startX0 + dx);
      else behaviour.moveBowl(drag.startX0 + dx);
    };

    const endPointer = (event, cancelled) => {
      if (!drag || event.pointerId !== drag.id) return;
      const finished = drag;
      drag = null;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      if (finished.kind === 'bowl') {
        if (finished.moved) api.saveBowl(behaviour.prefs.bowlX);
        else if (!cancelled) behaviour.request('drink'); // clicking her bowl sends her for a drink
      } else if (finished.moved) {
        behaviour.endDrag();
      } else if (!cancelled) {
        behaviour.click();
      }
      scheduleCheck();
    };

    window.addEventListener('pointermove', (event) => {
      mouse = { x: event.clientX, y: event.clientY };
      if (drag && event.pointerId === drag.id) {
        onDragMove(event);
        return;
      }
      // The mouse coming near her: she notices and looks up at you.
      if (behaviour.isNear(event.clientX)) behaviour.notice();
      // Rubbing over her with no button held is petting.
      if (over === 'lulu' && event.buttons === 0) {
        if (rub.move(event.clientX, event.timeStamp)) behaviour.pet();
      } else {
        rub.reset();
      }
      scheduleCheck();
    });
    document.documentElement.addEventListener('pointerleave', () => {
      mouse = null;
      if (!drag) scheduleCheck();
    });
    canvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || !interactive || over === null) return;
      const startX0 = over === 'lulu' ? behaviour.cx : player.bowl.x;
      drag = { kind: over, id: event.pointerId, startX: event.clientX, startX0, moved: false };
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener('pointerup', (event) => endPointer(event, false));
    canvas.addEventListener('pointercancel', (event) => endPointer(event, true));
    window.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      if (over === 'lulu' && !drag) api.showMenu();
    });

    // She may walk under a still cursor, so re-test after each drawn frame.
    player.onDraw = () => {
      if (mouse && !drag) scheduleCheck();
    };

    return {
      // After the window moves, start from "ignore the mouse" and re-test.
      reset() {
        interactive = true;
        over = null;
        setInteractive(false);
        scheduleCheck();
      },
    };
  }

  function setupTune({ behaviour, el }) {
    const render = () => {
      el.textContent = `Tune mode · walk pace ${Math.round(behaviour.pace * 100)}% · `
        + 'Ctrl+Alt+= faster · Ctrl+Alt+- slower · Ctrl+Alt+W walk · Ctrl+Alt+T treat · Ctrl+Alt+F follow · Ctrl+Alt+K trick · Ctrl+Alt+S save';
    };
    el.hidden = false;
    render();
    api.onTune((msg) => {
      if (msg.delta) {
        behaviour.setPace(behaviour.pace + msg.delta);
        render();
      } else if (msg.walk) {
        behaviour.command('walk');
      } else if (msg.trick) {
        behaviour.nextTrick();
      } else if (msg.save) {
        api.saveWalkPace(behaviour.pace);
        el.textContent = `Saved: walk pace ${Math.round(behaviour.pace * 100)}%`;
        setTimeout(render, 2000);
      }
    });
  }

  async function main() {
    const config = window.LuluConfig;
    // Main may move the window (e.g. away from a fullscreen app) while the
    // clips are still loading. Keep the newest layout and apply it once ready.
    let onLayout = null;
    let queuedLayout = null;
    api.onLayout((next) => {
      if (onLayout) onLayout(next);
      else if (!queuedLayout || next.seq > queuedLayout.seq) queuedLayout = next;
    });

    const { manifest, settings, prefs, layout, tune } = await api.init();
    const canvas = document.getElementById('stage');

    let behaviour = null;
    const player = new window.LuluPlayer({
      canvas,
      manifest,
      assetBase: '../../assets/',
      mediaHost: document.getElementById('media'),
      view: () => (behaviour ? behaviour.view() : { cx: layout.width / 2, dir: 1, scale: layout.scale }),
      sizeFor: (clip, pose, index) => window.LuluLogic.displaySize(clip, pose, index, config),
    });
    await player.load();

    const alpha = player.checkAlpha(config.alphaThreshold);
    if (!alpha.ok) {
      api.reportFatal(alpha.reason);
      return;
    }

    let pointer = null;
    const prepareLayout = (next) => {
      player.resize(next);
      if (pointer) pointer.reset();
    };

    behaviour = new window.LuluBehaviour({
      player,
      manifest,
      config,
      api,
      extents: player.bodyExtents(config.alphaThreshold),
      prefs,
      tune,
      prepareLayout,
    });
    const hitTester = new window.LuluHitTester({
      manifest,
      threshold: config.alphaThreshold,
      radiusPx: config.hitRadiusPx,
    });
    player.bodyExtent = player.bodyExtents(config.alphaThreshold);
    pointer = setupPointer({ canvas, player, behaviour, hitTester, config });

    prepareLayout(layout);
    behaviour.applyLayout(layout, { xFraction: settings.xFraction });
    behaviour.setPrefs(prefs); // draws her bowl and shadow
    // Walk in from the side at start-up, rather than popping into view.
    if (prefs.walkIn && !tune) behaviour.walkInTo(behaviour.cx);

    onLayout = (next) => {
      prepareLayout(next);
      behaviour.applyLayout(next);
      player.draw();
    };
    if (queuedLayout && queuedLayout.seq > layout.seq) onLayout(queuedLayout);
    queuedLayout = null;
    api.onCommand((cmd) => behaviour.command(cmd.name, cmd));
    api.onIdle((idle) => behaviour.setUserIdle(idle));
    api.onRunState((running) => behaviour.setRunning(running));
    api.onPrefs((next) => behaviour.setPrefs(next));
    api.onFollow((msg) => behaviour.setFollow(msg));
    if (tune) {
      setupTune({ behaviour, el: document.getElementById('tune') });
      // Tune mode only: a handle for inspecting her from the developer tools.
      window.__lulu = { behaviour, player };
    }

    behaviour.start();
    api.ready();
  }

  main().catch((err) => api.reportFatal(`Lulu failed to start: ${describe(err)}`));
})();
