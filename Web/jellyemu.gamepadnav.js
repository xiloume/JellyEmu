// JellyEmu Gamepad Menu Navigation
// Translates gamepad input (D-Pad, left stick, A/B, Start+Select) into UI navigation
// for the standalone player pages (ejs.html, play.html, pico8.html).
// Game input continues to reach the emulator untouched while "menu mode" is off:
// this module only *observes* the Gamepad API, it never consumes or blocks input.
(function () {
    'use strict';

    if (window.__jeGpNavLoaded) return;
    window.__jeGpNavLoaded = true;

    var HAS_GAMEPAD_API = typeof navigator !== 'undefined' &&
        (typeof navigator.getGamepads === 'function' || typeof navigator.webkitGetGamepads === 'function');

    // - Tunables -
    var BTN_A = 0;
    var BTN_B = 1;
    var BTN_SELECT = 8;
    var BTN_START = 9;
    var DPAD_UP = 12;
    var DPAD_DOWN = 13;
    var DPAD_LEFT = 14;
    var DPAD_RIGHT = 15;
    var AXIS_DEADZONE = 0.55;
    var COMBO_HOLD_MS = 350;      // Start+Select must be held together this long
    var REPEAT_DELAY_MS = 380;    // first auto-repeat delay for held direction
    var REPEAT_RATE_MS = 150;     // subsequent auto-repeat rate

    // - State -
    window._jeMenuMode = window._jeMenuMode || false;
    var _focusedEl = null;
    var _pausedByMenu = false;
    var _padState = {}; // gp.index -> per-pad input state
    var _focusInHandlerBound = false;

    function padState(gp) {
        var s = _padState[gp.index];
        if (!s) {
            s = _padState[gp.index] = {
                dir: null, nextAt: 0,
                a: false, b: false,
                both: false, since: 0, fired: false
            };
        }
        return s;
    }

    var FOCUSABLE_SEL = 'button:not(:disabled), a[href], input:not([type="hidden"]):not(:disabled), ' +
        'select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

    // - Debug overlay -
    // Enabled via ?jegpdebug=1 in the URL, localStorage 'jegpdebug'='1', or by
    // holding LB+RB+Select on a gamepad for ~1.5s (usable on Xbox without devtools).
    var DEBUG = /[?&]jegpdebug=1/.test(location.search) || (function () {
        try { return localStorage.getItem('jegpdebug') === '1'; } catch (e) { return false; }
    })();
    var _dbgEl = null;
    function dbg(msg) {
        try { console.log('[JEGP] ' + msg); } catch (e0) { }
        // Persist a ring buffer so the log survives an unexpected unload —
        // post-mortem diagnosis on consoles without devtools.
        try {
            var buf = JSON.parse(sessionStorage.getItem('jegpdbg') || '[]');
            buf.push(msg);
            sessionStorage.setItem('jegpdbg', JSON.stringify(buf.slice(-40)));
        } catch (e1) { }
        if (!DEBUG) return;
        if (!_dbgEl) {
            _dbgEl = document.createElement('div');
            _dbgEl.id = 'je-gpdbg';
            _dbgEl.style.cssText = 'position:fixed;top:56px;left:10px;z-index:999999;' +
                'background:rgba(0,0,0,0.85);color:#7f7;font:12px monospace;padding:8px;' +
                'max-width:70vw;pointer-events:none;white-space:pre-wrap;border-radius:6px;';
            document.body.appendChild(_dbgEl);
        }
        _dbgEl.textContent = (msg + '\n' + _dbgEl.textContent).split('\n').slice(0, 14).join('\n');
    }

    function dbgFlushPrevious() {
        try {
            var prev = JSON.parse(sessionStorage.getItem('jegpdbg') || '[]');
            sessionStorage.removeItem('jegpdbg');
            prev.slice(-10).forEach(function (l) { dbg('prev: ' + l); });
        } catch (e) { }
    }

    // - Emulator / page helpers -
    function emu() { return window.EJS_emulator || null; }

    function isVisible(el) {
        if (!el) return false;
        if (!el.getClientRects || el.getClientRects().length === 0) return false;
        try {
            var cs = window.getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden') return false;
            // Hidden bars/popups keep layout but are opaque and non-interactive
            if (cs.pointerEvents === 'none' || parseFloat(cs.opacity) === 0) return false;
        } catch (e) { }
        return true;
    }

    // The menu is "active" when our menu mode is on or any JellyEmu overlay is open.
    function menuContextActive() {
        if (window._jeMenuMode) return true;
        return !!topOverlay();
    }

    function topOverlay() {
        var els = document.querySelectorAll('.je-overlay.je-open, .je-popup.je-active');
        for (var i = els.length - 1; i >= 0; i--) {
            if (isVisible(els[i])) return els[i];
        }
        // PICO-8 / generic visible dialogs
        var dialogs = document.querySelectorAll('.ejs_settings_menu, dialog[open]');
        for (var j = dialogs.length - 1; j >= 0; j--) {
            if (isVisible(dialogs[j])) return dialogs[j];
        }
        return null;
    }

    function isRemapListening() {
        // ejs.input.js marks the button currently capturing a new binding with .je-listening
        return !!document.querySelector('.je-listening');
    }

    // - Focus candidates -
    function getFocusRoot() {
        var ov = topOverlay();
        if (ov) return [ov];
        var roots = [];
        var topbar = document.getElementById('je-topbar');
        var dock = document.getElementById('je-dock');
        var dockMin = document.getElementById('je-dock-min');
        if (topbar && isVisible(topbar)) roots.push(topbar);
        if (dock && isVisible(dock)) roots.push(dock);
        // The "Expand Controls" FAB is the only way back when the dock is
        // minimized — it must stay reachable by gamepad.
        if (dockMin && isVisible(dockMin)) roots.push(dockMin);
        return roots;
    }

    function getCandidates() {
        var roots = getFocusRoot();
        var out = [];
        for (var i = 0; i < roots.length; i++) {
            if (roots[i].matches && roots[i].matches(FOCUSABLE_SEL)) out.push(roots[i]);
            var els = roots[i].querySelectorAll(FOCUSABLE_SEL);
            for (var j = 0; j < els.length; j++) {
                if (isVisible(els[j])) out.push(els[j]);
            }
        }
        return out;
    }

    function setFocus(el) {
        if (_focusedEl && _focusedEl !== el) _focusedEl.classList.remove('je-gp-focus');
        _focusedEl = el || null;
        if (!el) return;
        el.classList.add('je-gp-focus');
        try { el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (e2) { } }
        try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e3) {
            try { el.scrollIntoView(false); } catch (e4) { }
        }
    }

    function clearFocus() {
        if (_focusedEl) _focusedEl.classList.remove('je-gp-focus');
        _focusedEl = null;
    }

    function focusDefault() {
        var cands = getCandidates();
        if (cands.length) setFocus(cands[0]);
    }

    function nextInDomOrder(cands, forward) {
        var idx = cands.indexOf(_focusedEl);
        if (idx === -1) return cands[0];
        var n = forward ? idx + 1 : idx - 1;
        if (n < 0) n = cands.length - 1;
        if (n >= cands.length) n = 0;
        return cands[n];
    }

    function moveFocus(dir) {
        var cands = getCandidates();
        if (!cands.length) { clearFocus(); return; }
        if (!_focusedEl || cands.indexOf(_focusedEl) === -1) { setFocus(cands[0]); return; }

        var from = _focusedEl.getBoundingClientRect();
        var fx = from.left + from.width / 2;
        var fy = from.top + from.height / 2;
        var best = null;
        var bestScore = Infinity;

        for (var i = 0; i < cands.length; i++) {
            var c = cands[i];
            if (c === _focusedEl) continue;
            var r = c.getBoundingClientRect();
            if (!r.width && !r.height) continue;
            var cx = r.left + r.width / 2;
            var cy = r.top + r.height / 2;
            var dx = cx - fx;
            var dy = cy - fy;
            var primary = 0, secondary = 0;

            if (dir === 'up') { if (dy > -2) continue; primary = -dy; secondary = Math.abs(dx); }
            else if (dir === 'down') { if (dy < 2) continue; primary = dy; secondary = Math.abs(dx); }
            else if (dir === 'left') { if (dx > -2) continue; primary = -dx; secondary = Math.abs(dy); }
            else if (dir === 'right') { if (dx < 2) continue; primary = dx; secondary = Math.abs(dy); }

            var score = primary + secondary * 1.8;
            if (score < bestScore) { bestScore = score; best = c; }
        }

        // No candidate strictly in that direction: fall back to DOM-order cycling
        // so the user can never get "stuck".
        if (!best) best = nextInDomOrder(cands, dir === 'down' || dir === 'right');
        setFocus(best);
    }

    // - Element activation -
    function activateEl(el) {
        if (!el) return;
        var tag = el.tagName;
        if (tag === 'SELECT') {
            // Native dropdowns can't be driven reliably by gamepad: cycle options instead
            var sel = el;
            sel.selectedIndex = (sel.selectedIndex + 1) % sel.options.length;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            return;
        }
        if (tag === 'INPUT' && (el.type === 'range')) {
            adjustRange(el, 1);
            return;
        }
        el.click();
    }

    function adjustRange(el, dir) {
        var min = parseFloat(el.min); if (isNaN(min)) min = 0;
        var max = parseFloat(el.max); if (isNaN(max)) max = 100;
        var step = parseFloat(el.step); if (isNaN(step) || step <= 0) step = (max - min) / 100;
        var v = parseFloat(el.value); if (isNaN(v)) v = min;
        v = Math.min(max, Math.max(min, v + dir * step));
        el.value = String(v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function adjustSelect(el, dir) {
        var n = el.options.length;
        if (!n) return;
        el.selectedIndex = (el.selectedIndex + dir + n) % n;
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // - Overlay / chrome control -
    function closeOverlay(ov) {
        if (!ov) return;
        var btn = ov.querySelector('[data-close], .je-popup-close, .je-closebtn');
        if (btn) { btn.click(); return; }
        ov.classList.remove('je-open');
        ov.classList.remove('je-active');
        window._jePopupOpen = !!document.querySelector('.je-overlay.je-open, .je-popup.je-active');
    }

    var _chromePrev = null; // bar classes before menu mode took them over
    function showChrome() {
        if (!_chromePrev) {
            _chromePrev = { bodyPersist: document.body.classList.contains('je-bar-persist') };
            ['je-topbar', 'je-dock'].forEach(function (id) {
                var el = document.getElementById(id);
                _chromePrev[id] = el ? el.className : null;
            });
        }
        // Play! page reveals its topbar only on body hover or .je-bar-persist.
        document.body.classList.add('je-bar-persist');
        ['je-topbar', 'je-dock'].forEach(function (id) {
            var el = document.getElementById(id);
            if (!el) return;
            el.classList.add('je-active');
            el.classList.remove('je-hidden');
        });
    }

    function hideChrome() {
        if (!_chromePrev) { document.body.classList.remove('je-bar-persist'); return; }
        ['je-topbar', 'je-dock'].forEach(function (id) {
            var el = document.getElementById(id);
            if (el && _chromePrev[id] !== null) el.className = _chromePrev[id];
        });
        if (!_chromePrev.bodyPersist) document.body.classList.remove('je-bar-persist');
        _chromePrev = null;
    }

    function refocusGame() {
        try { window.focus(); } catch (e) { }
        var e = emu();
        if (e && e.elements && e.elements.parent) { try { e.elements.parent.focus(); return; } catch (e2) { } }
        var gp = document.querySelector('.ejs_parent');
        if (gp) { try { gp.focus(); return; } catch (e3) { } }
        if (typeof window.p8_give_focus === 'function') { try { window.p8_give_focus(); return; } catch (e4) { } }
        var canvas = document.querySelector('#outputCanvas, canvas.ejs_canvas, canvas');
        if (canvas && canvas.focus) { try { canvas.focus(); } catch (e5) { } }
    }

    // - Emulator pause / resume -
    function pauseEmu() {
        // Release every in-game input first: the game must not keep a button
        // held while the menu owns the controller.
        if (typeof window._jeReleaseAllInputs === 'function') {
            try { window._jeReleaseAllInputs(); } catch (e0) { }
        }
        if (window._jePlayInputManager && typeof window._jePlayInputManager.releaseAll === 'function') {
            try { window._jePlayInputManager.releaseAll(); } catch (e1) { }
        }
        var e = emu();
        if (e && e.started && !e.paused && typeof e.pause === 'function') {
            try { e.pause(); _pausedByMenu = true; } catch (err) { }
            var btnPause = document.getElementById('je-btn-pause');
            var btnPlay = document.getElementById('je-btn-play');
            if (btnPause) btnPause.style.display = 'none';
            if (btnPlay) btnPlay.style.display = '';
        }
        // PICO-8 runtime pause (Module.pico8TogglePaused is a toggle, call only when running & unpaused)
        if (window.p8_is_running && window.Module && typeof window.Module.pico8TogglePaused === 'function' &&
            window.pico8_state && !window.pico8_state.is_paused) {
            try { window.Module.pico8TogglePaused(); _pausedByMenu = true; } catch (err2) { }
        }
        if (_pausedByMenu && typeof window._jePauseSessionTracking === 'function') {
            try { window._jePauseSessionTracking(); } catch (err3) { }
        }
    }

    function resumeEmu() {
        if (!_pausedByMenu) return;
        _pausedByMenu = false;
        var e = emu();
        if (e && e.started && e.paused && typeof e.play === 'function') {
            try { e.play(); } catch (err) { }
            var btnPause = document.getElementById('je-btn-pause');
            var btnPlay = document.getElementById('je-btn-play');
            if (btnPlay) btnPlay.style.display = 'none';
            if (btnPause) btnPause.style.display = '';
        }
        if (window.p8_is_running && window.Module && typeof window.Module.pico8TogglePaused === 'function' &&
            window.pico8_state && window.pico8_state.is_paused) {
            try { window.Module.pico8TogglePaused(); } catch (err2) { }
        }
        if (typeof window._jeResumeSessionTracking === 'function') {
            try { window._jeResumeSessionTracking(); } catch (err3) { }
        }
    }

    // - Menu mode (game <-> menus) -
    function setMenuMode(on) {
        on = !!on;
        if (on === window._jeMenuMode) return;
        window._jeMenuMode = on;
        if (on) {
            pauseEmu();
            showChrome();
            focusDefault();
        } else {
            hideChrome();
            resumeEmu();
            clearFocus();
            refocusGame();
        }
        updateHint();
    }

    function menuBack() {
        var ov = topOverlay();
        if (ov) { closeOverlay(ov); return; }
        if (window._jeMenuMode) { setMenuMode(false); return; }
        setMenuMode(true);
    }

    // Small persistent hint shown while menu mode is on (Xbox has no cursor/status bar).
    var _hintEl = null;
    function updateHint() {
        if (window._jeMenuMode && !_hintEl) {
            _hintEl = document.createElement('div');
            _hintEl.id = 'je-gpnav-hint';
            _hintEl.style.cssText =
                'position:fixed;bottom:74px;left:50%;transform:translateX(-50%);' +
                'background:rgba(0,0,0,0.78);color:#fff;padding:6px 14px;border-radius:20px;' +
                'font-size:12px;z-index:99999;pointer-events:none;white-space:nowrap;' +
                'border:1px solid rgba(255,255,255,0.15);font-family:inherit;';
            _hintEl.textContent = 'Menu \u2014 D-Pad/Stick: navigate \u00b7 A: select \u00b7 B: back \u00b7 Start+Select: resume game';
            document.body.appendChild(_hintEl);
        } else if (!window._jeMenuMode && _hintEl) {
            _hintEl.parentNode.removeChild(_hintEl);
            _hintEl = null;
        }
    }

    // - Back-navigation trap -
    // On Xbox (and any client that maps the gamepad B button to a system "back"),
    // the back action reaches the page as a real history.back() that cannot be
    // preventDefault'd. We push a sentinel state so a back pops *our* entry first,
    // then re-push it and open the menu instead of leaving the page. Deliberate
    // exits set window.__jeAllowBack first so the trap lets them through once.
    var _trapArmed = false;
    function armTrap() {
        try {
            history.pushState({ jeGpNav: true }, document.title, location.href);
            _trapArmed = true;
            dbg('back-trap armed');
        } catch (e) {
            _trapArmed = false;
            dbg('back-trap FAILED: ' + e);
        }
    }
    armTrap();

    // Marks the next popstate as a deliberate exit. The flag is time-bounded
    // because some exit paths never navigate (iframe postMessage, location.href)
    // and a lingering flag would let a stray back slip through later.
    function armAllowBack(src) {
        window.__jeAllowBack = true;
        if (DEBUG) {
            var st = '';
            try { st = (new Error().stack || '').split('\n').slice(2, 5).join(' <- '); } catch (e) { }
            dbg('armAllowBack <- ' + (src || '?') + ' | ' + st);
        }
        setTimeout(function () { window.__jeAllowBack = false; }, 800);
    }

    window.addEventListener('popstate', function () {
        dbg('popstate! allowBack=' + window.__jeAllowBack + ' popThrough=' + window.__jePopThrough);
        if (window.__jeAllowBack) {
            // Deliberate exit: this pop only consumed our trap entry.
            // Traverse once more to reach the real previous page.
            window.__jeAllowBack = false;
            window.__jePopThrough = true;
            try { history.back(); } catch (e) { }
            return;
        }
        if (window.__jePopThrough) {
            window.__jePopThrough = false;
            return;
        }
        if (_trapArmed) {
            try { history.pushState({ jeGpNav: true }, document.title, location.href); } catch (e) { }
        }
        setMenuMode(true);
    });

    // Mark deliberate exits: the visual Exit button and any inline history.back() calls.
    document.addEventListener('click', function (e) {
        var t = e.target && e.target.closest ? e.target.closest('#je-exit-btn, [onclick]') : null;
        if (!t) return;
        var oc = t.getAttribute('onclick') || '';
        if (t.id === 'je-exit-btn' || oc.indexOf('history.back') !== -1) {
            armAllowBack('click:' + (t.id || t.tagName));
        }
    }, true);

    // Wrap programmatic exits so they bypass the back trap.
    function wrapExit(fnName) {
        var orig = window[fnName];
        if (typeof orig !== 'function' || orig.__jeGpNavWrapped) return;
        var wrapped = function () {
            armAllowBack('wrap:' + fnName);
            return orig.apply(this, arguments);
        };
        wrapped.__jeGpNavWrapped = true;
        window[fnName] = wrapped;
    }
    wrapExit('EJS_onExit');
    wrapExit('jeExit');

    // - Keyboard fallback -
    // Arrow keys / Enter / Escape mirror the gamepad scheme. This also covers
    // clients that deliver gamepad input as keyboard events (gamepadtokey.js
    // style), which is the usual path on consoles.
    window.addEventListener('keydown', function (e) {
        var t = e.target;
        var tag = t && t.tagName;
        var inTextField = tag === 'TEXTAREA' || tag === 'SELECT' ||
            (tag === 'INPUT' && t.type !== 'checkbox' && t.type !== 'range' && t.type !== 'button' && t.type !== 'radio');

        // "Back" keys in all their representations.
        // Synthetic keyCode 27 without a real 'Escape' key name = gamepad B on
        // UWP/Xbox WebViews — it ALSO reaches the game via the Gamepad API, so
        // we must silence it (preventing the EXIT GAME hotkey default kb1=27)
        // WITHOUT treating it as a menu-back request.
        var isSyntheticEscape = e.keyCode === 27 && e.key !== 'Escape';
        var isBackKey = e.key === 'Escape' || e.key === 'BrowserBack' || e.key === 'GoBack' ||
            e.key === 'XF86Back' || e.key === 'Back' ||
            e.keyCode === 461 || e.keyCode === 166 || e.keyCode === 10009 || isSyntheticEscape;
        if (isBackKey) {
            if (inTextField && e.key !== 'Escape' && e.keyCode !== 27) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            if (e.repeat) return; // consume auto-repeats without re-toggling
            if (isSyntheticEscape) {
                dbg('synthetic Esc/27 suppressed (gamepad B): key=' + e.key);
            } else {
                dbg('back key consumed: ' + e.key + '/' + e.keyCode);
                menuBack();
            }
            return;
        }
        if (!menuContextActive() || inTextField) return;

        var handled = true;
        switch (e.key) {
            case 'ArrowUp': moveFocus('up'); break;
            case 'ArrowDown': moveFocus('down'); break;
            case 'ArrowLeft':
                if (_focusedEl && _focusedEl.tagName === 'INPUT' && _focusedEl.type === 'range') { adjustRange(_focusedEl, -1); break; }
                moveFocus('left'); break;
            case 'ArrowRight':
                if (_focusedEl && _focusedEl.tagName === 'INPUT' && _focusedEl.type === 'range') { adjustRange(_focusedEl, 1); break; }
                moveFocus('right'); break;
            case 'Enter':
                if (_focusedEl) activateEl(_focusedEl); else handled = false;
                break;
            default: handled = false; break;
        }
        if (handled) {
            e.preventDefault();
            e.stopImmediatePropagation();
        }
    }, true);

    // Keep our focus marker in sync when focus is moved by mouse/touch.
    function bindFocusIn() {
        if (_focusInHandlerBound) return;
        _focusInHandlerBound = true;
        document.addEventListener('focusin', function (e) {
            if (!menuContextActive()) return;
            var el = e.target;
            if (el && el !== _focusedEl && el.matches && el.matches(FOCUSABLE_SEL)) {
                var inRoot = false;
                var roots = getFocusRoot();
                for (var i = 0; i < roots.length; i++) {
                    if (roots[i].contains(el)) { inRoot = true; break; }
                }
                if (inRoot) {
                    if (_focusedEl) _focusedEl.classList.remove('je-gp-focus');
                    _focusedEl = el;
                    el.classList.add('je-gp-focus');
                }
            }
        });
    }
    bindFocusIn();

    // - Gamepad polling -
    function readPads() {
        if (!HAS_GAMEPAD_API) return [];
        try {
            if (typeof navigator.getGamepads === 'function') return navigator.getGamepads() || [];
            return navigator.webkitGetGamepads() || [];
        } catch (e) { return []; }
    }

    function btn(gp, i) {
        var b = gp && gp.buttons && gp.buttons[i];
        if (!b) return false;
        if (typeof b === 'object') return !!b.pressed || b.value > 0.45;
        return b > 0.45;
    }

    function computeDir(gp) {
        if (btn(gp, DPAD_UP)) return 'up';
        if (btn(gp, DPAD_DOWN)) return 'down';
        if (btn(gp, DPAD_LEFT)) return 'left';
        if (btn(gp, DPAD_RIGHT)) return 'right';
        var ax = gp.axes || [];
        var x = ax[0] || 0, y = ax[1] || 0;
        if (Math.abs(x) < AXIS_DEADZONE && Math.abs(y) < AXIS_DEADZONE) return null;
        if (Math.abs(x) >= Math.abs(y)) return x < 0 ? 'left' : 'right';
        return y < 0 ? 'up' : 'down';
    }

    // If the page is unloaded without a deliberate exit (e.g. a client-level
    // back that bypassed the history trap), at least flush session/playtime
    // tracking so it isn't silently lost. Keepalive requests survive unload.
    window.addEventListener('beforeunload', function () { dbg('beforeunload!'); });
    window.addEventListener('pagehide', function () {
        dbg('pagehide!');
        try {
            if (window._jellyEmuExiting) return; // EJS_onExit already flushed
            var cfg = window.JellyEmuConfig || {};
            var secs = (typeof window._jeGetActivePlaytimeSeconds === 'function')
                ? window._jeGetActivePlaytimeSeconds() : 0;
            if (!cfg.baseUrl && cfg.baseUrl !== '') return;
            var tok = (typeof _jellyToken !== 'undefined' && _jellyToken) ? _jellyToken : '';
            var headers = tok ? { 'Authorization': 'MediaBrowser Token="' + tok + '"' } : {};
            fetch((cfg.baseUrl || '') + '/jellyemu/session/stop/' + cfg.itemId + '/' + cfg.userId + '?seconds=' + secs,
                { method: 'POST', headers: headers, keepalive: true }).catch(function () { });
            if (secs > 0) {
                fetch((cfg.baseUrl || '') + '/jellyemu/playtime/' + cfg.itemId + '/' + cfg.userId,
                    { method: 'POST', headers: Object.assign({ 'Content-Type': 'text/plain' }, headers), body: String(secs), keepalive: true }).catch(function () { });
            }
        } catch (e) { }
    });

    var _lastTrapCheck = 0;

    function poll() {
        wrapExit('EJS_onExit');
        wrapExit('jeExit');

        var now0 = Date.now();
        // Re-arm the trap if the entry was consumed without our popstate path
        // (some clients traverse history in ways that skip a single entry).
        if (_trapArmed && !window.__jeAllowBack && !window.__jePopThrough && now0 - _lastTrapCheck > 500) {
            _lastTrapCheck = now0;
            try {
                if (!history.state || !history.state.jeGpNav) {
                    history.pushState({ jeGpNav: true }, document.title, location.href);
                    dbg('back-trap re-armed (entry missing)');
                }
            } catch (e) { }
        }

        // While menu mode is on, keep the bars visible — the pages' auto-hide
        // timers would otherwise hide them again after a few seconds.
        if (window._jeMenuMode) showChrome();

        // Focus may have been removed (popup closed, DOM rebuilt)
        if (_focusedEl && (!document.contains(_focusedEl) || !isVisible(_focusedEl))) {
            clearFocus();
            if (menuContextActive()) focusDefault();
        }

        var pads = readPads();
        var now = Date.now();
        for (var i = 0; i < pads.length; i++) {
            var gp = pads[i];
            if (!gp || !gp.connected) continue;
            processPad(gp, now);
        }
        requestAnimationFrame(poll);
    }

    var DEBUG_COMBO_HOLD_MS = 1500;
    var BTN_LB = 4;
    var BTN_RB = 5;

    function processPad(gp, now) {
        var st = padState(gp);
        var sel = btn(gp, BTN_SELECT);
        var sta = btn(gp, BTN_START);

        // Debug combo: LB + RB + Select held ~1.5s toggles the on-screen log.
        // Lets us diagnose gamepad/back behaviour on consoles without devtools.
        if (sel && btn(gp, BTN_LB) && btn(gp, BTN_RB)) {
            if (!st.dbgSince) st.dbgSince = now;
            else if (!st.dbgFired && (now - st.dbgSince) >= DEBUG_COMBO_HOLD_MS) {
                st.dbgFired = true;
                DEBUG = !DEBUG;
                if (DEBUG) dbgFlushPrevious();
                dbg('debug ' + (DEBUG ? 'ON' : 'OFF') + ' | trap=' + _trapArmed +
                    ' | menu=' + window._jeMenuMode + ' | gamepadAPI=' + HAS_GAMEPAD_API);
                if (!DEBUG && _dbgEl) { _dbgEl.parentNode.removeChild(_dbgEl); _dbgEl = null; }
            }
        } else {
            st.dbgSince = 0;
            st.dbgFired = false;
        }

        // Start + Select held together => toggle menu mode (both ways).
        if (sel && sta) {
            if (!st.both) {
                st.both = true;
                st.since = now;
                st.fired = false;
            } else if (!st.fired && (now - st.since) >= COMBO_HOLD_MS && !isRemapListening()) {
                st.fired = true;
                dbg('Start+Select -> menu ' + !window._jeMenuMode);
                setMenuMode(!window._jeMenuMode);
            }
        } else {
            st.both = false;
            st.fired = false;
        }

        var menuOn = menuContextActive();
        var listening = isRemapListening();

        // Directional navigation (edge + auto-repeat). Only meaningful when a
        // menu context is active; otherwise the input belongs to the game.
        var dir = computeDir(gp);
        if (menuOn && !listening) {
            if (dir !== st.dir) {
                st.dir = dir;
                st.nextAt = now + REPEAT_DELAY_MS;
                if (dir) applyDirection(dir);
            } else if (dir && now >= st.nextAt) {
                st.nextAt = now + REPEAT_RATE_MS;
                applyDirection(dir);
            }
        } else {
            st.dir = null;
        }

        // A => activate, B => menu back (edge-triggered only, no repeat).
        var a = btn(gp, BTN_A);
        var b = btn(gp, BTN_B);
        if (DEBUG && b && !st.b) dbg('gamepad B pressed (menu=' + menuOn + ')');
        if (menuOn && !listening) {
            if (a && !st.a) {
                if (!_focusedEl) focusDefault();
                else activateEl(_focusedEl);
            }
            if (b && !st.b) {
                menuBack();
            }
        }
        st.a = a;
        st.b = b;
    }

    function applyDirection(dir) {
        if (_focusedEl && _focusedEl.tagName === 'INPUT' && _focusedEl.type === 'range' &&
            (dir === 'left' || dir === 'right')) {
            adjustRange(_focusedEl, dir === 'left' ? -1 : 1);
        } else if (_focusedEl && _focusedEl.tagName === 'SELECT' &&
            (dir === 'left' || dir === 'right')) {
            adjustSelect(_focusedEl, dir === 'left' ? -1 : 1);
        } else {
            moveFocus(dir);
        }
    }

    // Exit menu mode automatically when the (new) game actually starts.
    window.addEventListener('jellyemu:gamestart', function () {
        setMenuMode(false);
    });

    requestAnimationFrame(poll);
})();
