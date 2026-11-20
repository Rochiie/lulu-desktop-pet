// Settings window: shows the current settings and sends each change to main,
// which applies it to Lulu straight away.
(function () {
  'use strict';

  const api = window.luluSettings;
  const $ = (id) => document.getElementById(id);
  const SLIDERS = ['lookMultiplier', 'moodStrength', 'walkPace', 'tripChance', 'followSeconds'];
  const SWITCHES = ['noticeMouse', 'walkBetweenScreens', 'walkIn', 'avoidFullscreen', 'waterBowl', 'dogBed', 'toy', 'shadow', 'startWithWindows'];
  const SEND_DELAY_MS = 120;

  let view = null;
  let pending = {};
  let sendTimer = null;

  const format = {
    lookMultiplier: (v) => (v === 1 ? 'Normal' : `${v}×`),
    moodStrength: (v) => (v === 0 ? 'Off' : `${Math.round(v * 100)}%`),
    walkPace: (v) => (Math.abs(v - 1) < 0.001 ? 'Normal' : `${Math.round(v * 100)}%`),
    tripChance: (v) => (v === 0 ? 'Never' : `${Math.round(v * 100)}% of walks`),
    followSeconds: (v) => (v < 60 ? `${v} s` : `${Math.floor(v / 60)} min${v % 60 ? ` ${v % 60} s` : ''}`),
  };

  function setStatus(text) {
    $('status').textContent = text;
  }

  function effective(key) {
    return view.values[key];
  }

  function render() {
    const { values, meta } = view;
    $('version').textContent = `Version ${meta.version}`;
    for (const radio of document.querySelectorAll('input[name="size"]')) {
      radio.checked = Number(radio.value) === values.size;
    }
    for (const radio of document.querySelectorAll('input[name="snow"]')) {
      radio.checked = radio.value === values.snow;
    }
    for (const key of SLIDERS) {
      if (key in pending) continue; // don't fight the slider while it is moving
      $(key).value = String(effective(key));
      document.querySelector(`output[data-for="${key}"]`).textContent = format[key](effective(key));
    }
    for (const key of SWITCHES) $(key).checked = values[key];

    $('startWithWindows').disabled = !meta.canStartWithWindows;
    $('startHint').hidden = meta.canStartWithWindows;
    $('avoidFullscreen').disabled = !meta.fullscreenAvailable;
    $('walkBetweenScreens').disabled = !meta.multipleScreens;
    const tripsOff = !meta.multipleScreens || !values.walkBetweenScreens;
    $('tripChance').disabled = tripsOff;
    document.querySelector('[data-needs="walkBetweenScreens"]').dataset.disabled = String(tripsOff);
  }

  async function flush() {
    sendTimer = null;
    const patch = pending;
    pending = {};
    try {
      view = await api.update(patch);
      render();
      setStatus('Saved');
    } catch (err) {
      setStatus('Could not save that change');
      console.error(err);
    }
  }

  function queue(patch) {
    Object.assign(pending, patch);
    clearTimeout(sendTimer);
    sendTimer = setTimeout(flush, SEND_DELAY_MS);
  }

  function wire() {
    for (const radio of document.querySelectorAll('input[name="size"]')) {
      radio.addEventListener('change', () => queue({ size: Number(radio.value) }));
    }
    for (const radio of document.querySelectorAll('input[name="snow"]')) {
      radio.addEventListener('change', () => queue({ snow: radio.value }));
    }
    for (const key of SLIDERS) {
      $(key).addEventListener('input', () => {
        const v = Number($(key).value);
        document.querySelector(`output[data-for="${key}"]`).textContent = format[key](v);
        queue({ [key]: v });
      });
    }
    for (const key of SWITCHES) {
      $(key).addEventListener('change', () => queue({ [key]: $(key).checked }));
    }
    $('reset').addEventListener('click', async () => {
      clearTimeout(sendTimer);
      pending = {};
      try {
        view = await api.reset();
        render();
        setStatus('Back to defaults');
      } catch (err) {
        setStatus('Could not reset');
        console.error(err);
      }
    });
    api.onChanged((next) => {
      view = next;
      render();
    });
  }

  async function main() {
    view = await api.get();
    wire();
    render();
    $('form').setAttribute('aria-busy', 'false');
  }

  main().catch((err) => {
    setStatus('Settings could not load');
    console.error(err);
  });
})();
