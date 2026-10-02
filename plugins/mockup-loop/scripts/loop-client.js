// click-loop client helper, served by click-loop.mjs as /__loop.js.
// A mockup page includes <script src="/__loop.js"></script> and calls pick('<id>', '<optional note>').
// The page remembers the round it loaded with; a pick carries that round, so a pick from an outdated
// page is rejected (409) instead of being counted for the wrong round. The page reloads itself when
// the round changes.
(function () {
  'use strict';

  var POLL_MS = 2000;
  var overlay = null;
  var hideTimer = null;

  function readRound() {
    return fetch('/__round', { cache: 'no-store' }).then(function (res) {
      if (!res.ok) throw new Error('round ' + res.status);
      return res.text();
    }).then(function (text) {
      return text.trim();
    });
  }

  var loadedRound = readRound();

  function show(message, kind) {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.setAttribute('role', 'status');
      overlay.style.cssText = [
        'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647', 'padding:10px 14px',
        'border-radius:8px', 'font:14px/1.4 system-ui,sans-serif', 'color:#fff',
        'box-shadow:0 4px 16px rgba(0,0,0,.25)', 'max-width:80vw', 'pointer-events:none',
      ].join(';');
      document.body.appendChild(overlay);
    }
    overlay.style.background = kind === 'ok' ? '#1f7a3a' : kind === 'warn' ? '#8a6100' : '#a32020';
    overlay.textContent = message;
    overlay.style.display = 'block';
    clearTimeout(hideTimer);
    if (kind === 'ok') hideTimer = setTimeout(function () { overlay.style.display = 'none'; }, 4000);
  }

  function pick(id, note) {
    return loadedRound.then(function (round) {
      var url = '/__pick/' + encodeURIComponent(String(id)) + '?round=' + encodeURIComponent(round);
      if (note) url += '&note=' + encodeURIComponent(String(note));
      return fetch(url, { method: 'POST', cache: 'no-store' });
    }).then(function (res) {
      if (res.status === 204) {
        show('sent: ' + id, 'ok');
      } else if (res.status === 409) {
        show('stale page, reloading', 'warn');
        setTimeout(function () { location.reload(); }, 800);
      } else {
        show('not delivered — tell Claude in chat', 'error');
      }
    }).catch(function () {
      show('not delivered — tell Claude in chat', 'error');
    });
  }

  window.pick = pick;

  loadedRound.then(function (round) {
    setInterval(function () {
      readRound().then(function (current) {
        if (current !== round) location.reload();
      }).catch(function () { /* server gone or busy: keep the page as it is */ });
    }, POLL_MS);
  }).catch(function () { /* no round known: pick() reports "not delivered" when used */ });
})();
