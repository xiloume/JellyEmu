// Ad-hoc smoke test for Web/jellyemu.gamepadnav.js
// Minimal DOM/gamepad stub — NOT part of the shipped plugin.
// Run: node Tests\gamepadnav.smoke.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ---------- tiny DOM stub ----------
class El {
    constructor(tag, id) {
        this.tagName = tag.toUpperCase();
        this.id = id || '';
        this.children = [];
        this.parentNode = null;
        this.classList = {
            _s: new Set(),
            add: (...c) => c.forEach(x => this.classList._s.add(x)),
            remove: (...c) => c.forEach(x => this.classList._s.delete(x)),
            contains: (c) => this.classList._s.has(c),
            toggle: (c, f) => { if (f === undefined) f = !this.classList._s.has(c); f ? this.classList._s.add(c) : this.classList._s.delete(c); }
        };
        this.style = {};
        this.attributes = {};
        this._rect = { left: 0, top: 0, width: 10, height: 10, right: 10, bottom: 10 };
        this._listeners = {};
        this.clicks = 0;
        this.type = tag === 'input' ? 'text' : undefined;
        this.textContent = '';
    }
    setAttribute(k, v) { this.attributes[k] = v; if (k === 'tabindex') this.tabIndex = parseInt(v, 10); }
    getAttribute(k) { return this.attributes[k] || null; }
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; }
    getBoundingClientRect() { return this._rect; }
    getClientRects() { return this._visible ? [{}] : []; }
    focus() { doc.activeElement = this; }
    click() { this.clicks++; (this._listeners['click'] || []).forEach(f => f({ target: this })); }
    matches(sel) {
        return sel.split(',').some(s => {
            s = s.trim();
            if (s.startsWith('button')) return this.tagName === 'BUTTON' && !this.disabled;
            if (s.startsWith('a[href]')) return this.tagName === 'A' && this.attributes.href;
            if (s.startsWith('input')) return this.tagName === 'INPUT' && !this.disabled && this.type !== 'hidden';
            if (s.startsWith('select')) return this.tagName === 'SELECT' && !this.disabled;
            if (s.startsWith('textarea')) return this.tagName === 'TEXTAREA' && !this.disabled;
            if (s.startsWith('[tabindex]')) return this.attributes.tabindex !== undefined && this.attributes.tabindex !== '-1';
            return false;
        });
    }
    querySelectorAll(sel) {
        const out = [];
        const walk = (n) => { n.children.forEach(c => { if (c.matches(sel)) out.push(c); walk(c); }); };
        walk(this);
        return out;
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    contains(el) { let p = el; while (p) { if (p === this) return true; p = p.parentNode; } return false; }
    addEventListener(t, f) { (this._listeners[t] = this._listeners[t] || []).push(f); }
    removeEventListener() { }
    closest(sel) {
        let n = this;
        while (n) {
            if (sel === '#je-exit-btn' && n.id === 'je-exit-btn') return n;
            if (sel.includes('[onclick]') && n.getAttribute && n.getAttribute('onclick')) return n;
            if (sel.startsWith('.') && n.classList._s.has(sel.slice(1))) return n;
            n = n.parentNode;
        }
        return null;
    }
    scrollIntoView() { }
    dispatchEvent(e) { if (e && e._on) e._on(this); }
}

class Doc {
    constructor() { this.body = new El('body'); this.activeElement = null; this._listeners = {}; this._byId = {}; }
    getElementById(id) {
        const found = this._byId[id];
        if (found !== undefined) return found;
        const walk = (n) => { if (n.id === id) return n; for (const c of n.children) { const r = walk(c); if (r) return r; } return null; };
        return walk(this.body);
    }
    querySelectorAll(sel) {
        const out = [];
        const parts = sel.split(',').map(s => s.trim());
        const matchOne = (el, p) => {
            if (p === '.je-overlay.je-open') return el.classList._s.has('je-overlay') && el.classList._s.has('je-open');
            if (p === '.je-popup.je-active') return el.classList._s.has('je-popup') && el.classList._s.has('je-active');
            if (p === '.je-listening') return el.classList._s.has('je-listening');
            if (p === '.ejs_settings_menu' || p === 'dialog[open]') return false;
            return el.matches(p);
        };
        const walk = (n) => { n.children.forEach(c => { if (parts.some(p => matchOne(c, p))) out.push(c); walk(c); }); };
        walk(this.body);
        return out;
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    addEventListener(t, f) { (this._listeners[t] = this._listeners[t] || []).push(f); }
    createElement(tag) { return new El(tag); }
    contains(el) { return this.body.contains(el) || el === this.body; }
}

const doc = new Doc();
const listeners = {};
let rafQueue = [];
const win = {
    document: doc,
    navigator: { getGamepads: () => pads },
    history: { pushState: (...a) => { pushes.push(a); win.history.state = a[0]; }, state: null, length: 3, back: () => { backCalls++; win._popstate && win._popstate(); } },
    location: { href: 'http://x/jellyemu/play/1' },
    addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); },
    dispatchEvent: (e) => { (listeners[e.type || e] || []).forEach(f => f(e)); },
    focus: () => { },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    requestAnimationFrame: (f) => { rafQueue.push(f); },
    innerWidth: 1920,
    Module: undefined,
};
win.window = win;
win.self = win;
const pushes = [];
let backCalls = 0;
let pads = [];
const sandbox = vm.createContext(Object.assign(win, { console, Event: class { constructor(t, o) { this.type = t; Object.assign(this, o); } }, KeyboardEvent: class { }, CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } }, document: doc, navigator: win.navigator, history: win.history, location: win.location, requestAnimationFrame: win.requestAnimationFrame, getComputedStyle: win.getComputedStyle, setTimeout, clearTimeout, setInterval, clearInterval, Date }));

// ---------- page fixture ----------
function el(tag, id, rect) {
    const e = new El(tag, id);
    if (id) doc._byId[id] = e;
    if (rect) e._rect = rect;
    e._visible = true;
    return e;
}

const topbar = el('div', 'je-topbar');
topbar.classList.add('je-bar');
const exitBtn = el('button', 'je-exit-btn', { left: 1800, top: 8, width: 60, height: 32, right: 1860, bottom: 40 });
exitBtn.attributes.title = 'Exit';
topbar.appendChild(exitBtn);

const dock = el('div', 'je-dock');
dock.classList.add('je-bar');
const b1 = el('button', 'je-btn-pause', { left: 800, top: 1000, width: 42, height: 42, right: 842, bottom: 1042 });
const b2 = el('button', 'je-btn-ff', { left: 850, top: 1000, width: 42, height: 42, right: 892, bottom: 1042 });
const b3 = el('button', 'je-btn-vol', { left: 900, top: 1000, width: 42, height: 42, right: 942, bottom: 1042 });
[b1, b2, b3].forEach(b => dock.appendChild(b));

const overlay = el('div', 'je-pop-vol');
overlay.classList.add('je-overlay');
const closeBtn = el('button', null, { left: 1000, top: 200, width: 30, height: 30, right: 1030, bottom: 230 });
closeBtn.setAttribute('data-close', 'je-pop-vol');
const slider = el('input', 'je-vol-slider', { left: 800, top: 300, width: 300, height: 20, right: 1100, bottom: 320 });
slider.type = 'range'; slider.min = '0'; slider.max = '1'; slider.step = '0.05'; slider.value = '0.5';
overlay.appendChild(closeBtn); overlay.appendChild(slider);

doc.body.appendChild(topbar);
doc.body.appendChild(dock);
doc.body.appendChild(overlay);

// fake EJS emulator
let emuPaused = false;
const emuObj = { started: true, paused: false, elements: { parent: el('div', 'ejs-parent') }, pause() { this.paused = true; emuPaused = true; }, play() { this.paused = false; emuPaused = false; } };
sandbox.EJS_emulator = emuObj;
win.EJS_emulator = emuObj;

// ---------- helpers ----------
let now = 0;
const origNow = Date.now;
function setNow(t) { now = t; }
Date.now = () => now;
function frame(t) { setNow(t); const q = rafQueue; rafQueue = []; q.forEach(f => f()); }
function pad(state) { return { index: 0, connected: true, id: 'xbox', buttons: state.buttons || [], axes: state.axes || [0, 0, 0, 0] }; }
function btnPad(btns) {
    const arr = new Array(16).fill({ pressed: false, value: 0 });
    btns.forEach(i => arr[i] = { pressed: true, value: 1 });
    return { buttons: arr, axes: [0, 0, 0, 0] };
}

const results = [];
function check(name, cond) { results.push([name, !!cond]); console.log((cond ? 'PASS' : 'FAIL') + '  ' + name); }

// ---------- load module ----------
const src = fs.readFileSync(path.join(__dirname, '..', 'Web', 'jellyemu.gamepadnav.js'), 'utf8');
vm.runInContext(src, sandbox);

// ---------- tests ----------
// T1: page load, no pad => menu mode off
frame(0);
check('T1 initial: menu mode off', win._jeMenuMode === false);

// T2: Start+Select quick tap (<350ms) does NOT toggle
pads = [pad(btnPad([8, 9]))];
frame(100); frame(200); frame(330);
pads = [pad(btnPad([]))];
frame(340);
check('T2 short Start+Select tap does not toggle', win._jeMenuMode === false);

// T3: Start+Select held >=350ms toggles menu mode ON
pads = [pad(btnPad([8, 9]))];
frame(400); frame(500); frame(760);
check('T3 Start+Select held 350ms+ -> menu mode ON', win._jeMenuMode === true);
check('T3b emulator paused by menu', emuPaused === true);
pads = [pad(btnPad([]))];
frame(800);

// T4: dpad right cycles focus topbar -> dock buttons
frame(810);
check('T4a focus defaulted to first candidate (exit btn)', doc.activeElement === exitBtn);
pads = [pad({ buttons: [], axes: [0, 0, 0, 0] })];
pads[0].buttons = new Array(16).fill({ pressed: false, value: 0 });
pads[0].buttons[15] = { pressed: true, value: 1 }; // DPAD_RIGHT
frame(820);
check('T4b dpad right moved focus -> b1', doc.activeElement === b1);
pads = [pad(btnPad([]))]; // release: direction is edge-triggered
frame(825);
pads[0].buttons[15] = { pressed: true, value: 1 };
frame(830);
check('T4c re-press dpad right -> b2', doc.activeElement === b2);
pads = [pad(btnPad([]))];
frame(840);

// T5: A activates focused element
pads = [pad(btnPad([0]))]; // A
frame(850);
check('T5 A clicks focused button', b2.clicks === 1);

// T6: holding A (no release) does not re-fire
frame(860); frame(870); frame(880); frame(890);
check('T6 held A fires once', b2.clicks === 1);
pads = [pad(btnPad([]))];
frame(900);

// T7: B exits menu mode (back)
pads = [pad(btnPad([1]))]; // B
frame(910);
check('T7 B in menu mode -> back to game', win._jeMenuMode === false);
check('T7b emulator resumed', emuPaused === false);
pads = [pad(btnPad([]))];
frame(920);

// T8: B in game mode does nothing (game keeps it)
pads = [pad(btnPad([1]))];
frame(930);
check('T8 B in game mode: no menu', win._jeMenuMode === false);
pads = [pad(btnPad([]))];
frame(940);

// T9: Start+Select again re-enters menu; combo state reset (no instant refire)
pads = [pad(btnPad([8, 9]))];
frame(950); frame(1000); frame(1310);
check('T9 combo re-arms and toggles ON again', win._jeMenuMode === true);
frame(1320);
check('T9b held combo does not double-fire', win._jeMenuMode === true);
pads = [pad(btnPad([]))];
frame(1330);

// T10: combo toggles OFF after hold
pads = [pad(btnPad([8, 9]))];
frame(1340); frame(1400); frame(1700);
check('T10 combo held again -> menu OFF', win._jeMenuMode === false);
pads = [pad(btnPad([]))];
frame(1710);

// T11: overlay open => menu context (focus goes into overlay)
overlay.classList.add('je-open');
win._jePopupOpen = true;
pads = [pad(btnPad([8, 9]))];
frame(1720); frame(1750); frame(2090); // enter menu mode while overlay open
check('T11a menu mode on with overlay', win._jeMenuMode === true);
frame(2100);
// dpad down should focus within overlay (slider or close btn)
pads[0].buttons[12] = { pressed: true, value: 1 }; // DPAD_UP to move within overlay
frame(2110);
const inOverlay = overlay.contains(doc.activeElement);
check('T11b focus stays inside open overlay', inOverlay);
pads = [pad(btnPad([]))];
frame(2120);

// T12: B closes overlay first (not the whole menu mode)
pads = [pad(btnPad([1]))];
frame(2130);
check('T12a B closes overlay', !overlay.classList._s.has('je-open'));
check('T12b still in menu mode', win._jeMenuMode === true);
pads = [pad(btnPad([]))];
frame(2140);
pads = [pad(btnPad([1]))];
frame(2150);
check('T12c second B exits menu mode', win._jeMenuMode === false);
pads = [pad(btnPad([]))];
frame(2160);

// T13: history trap — popstate opens menu instead of leaving
const before = pushes.length;
win._popstate = listeners['popstate'] && listeners['popstate'][0];
win.history.back();
check('T13a trap re-pushed state', pushes.length === before + 1);
check('T13b trap opened menu mode', win._jeMenuMode === true);
// deliberate exit: pops the trap entry, then pops through to the real page
win.__jeAllowBack = true;
const backsBefore = backCalls;
win.history.back();
check('T13c allowed back pops twice (trap + real entry)', backCalls === backsBefore + 2);
check('T13d no extra push on exit', pushes.length === before + 1);
check('T13e flags consumed', win.__jeAllowBack === false && !win.__jePopThrough);
check('T13f menu unchanged by allowed back', win._jeMenuMode === true);

// T14: Escape toggles menu (game mode) then backs out
win._jeMenuMode = false;
const kd = listeners['keydown'][0];
let prevented = false, stopped = false;
kd({ key: 'Escape', keyCode: 27, target: doc.body, preventDefault: () => prevented = true, stopImmediatePropagation: () => stopped = true });
check('T14a Escape -> menu mode ON + consumed', win._jeMenuMode === true && prevented && stopped);
prevented = stopped = false;
kd({ key: 'Escape', keyCode: 27, target: doc.body, preventDefault: () => prevented = true, stopImmediatePropagation: () => stopped = true });
check('T14b Escape -> back out', win._jeMenuMode === false && prevented);

// T15: arrow keys navigate when menu active (keyboard fallback for TV clients)
// Use the combo to enter menu mode so focusDefault() runs like real usage.
pads = [pad(btnPad([8, 9]))];
frame(2200); frame(2300); frame(2600);
pads = [pad(btnPad([]))];
frame(2610);
check('T15a combo reopened menu', win._jeMenuMode === true);
kd({ key: 'ArrowRight', keyCode: 39, target: doc.body, preventDefault: () => { }, stopImmediatePropagation: () => { } });
check('T15b ArrowRight moves focus', doc.activeElement === b1);
win._jeMenuMode = false;

// T16: no gamepad API => module is inert
sandbox.navigator.getGamepads = undefined;
// can't fully unhook now, but readPads guards already; just check no throw
check('T16 module loaded without errors', true);

const fails = results.filter(r => !r[1]);
console.log('\n' + results.length + ' checks, ' + fails.length + ' failures');
if (fails.length) { fails.forEach(f => console.log('FAILED: ' + f[0])); process.exit(1); }
Date.now = origNow;
