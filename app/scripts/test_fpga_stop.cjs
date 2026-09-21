// Regression tests: real store and React/Zustand; only hardware IPC and time are simulated.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const pkgRequire = createRequire(path.join(__dirname, '../package.json'));
const ts = pkgRequire('typescript');
const root = process.env.LEGION_TEST_SOURCE_ROOT || path.resolve(__dirname, '../..');
function makeRuntime({ desktop = true } = {}) {
    let now = 10000, seq = 0;
    const timers = new Map(), calls = [], cache = new Map();
    let handler = async (request) => {
        if (request.op === 'close' || request.op === 'tx_off')
            return { ok: true };
        if (request.op !== 'fpga')
            throw Error('Unexpected external operation ' + request.op);
        if (request.cmd.op === 'ping')
            return { ok: true, legion: true, fake: false, board: 'bladerf2' };
        if (request.cmd.op === 'status')
            return { ok: true, legion: true, det_active: true, det_count: 10 };
        return { ok: true };
    };
    const clock = {
        set(fn, ms, repeat) { const id = ++seq; timers.set(id, { fn, ms, repeat, due: now + ms }); return id; },
        clear(id) { timers.delete(id); },
        async flush() { for (let i = 0; i < 120; i++)
            await Promise.resolve(); },
        async tick(ms) { const to = now + ms; let n = 0; while (true) {
            const due = [...timers].filter(([, t]) => t.due <= to).sort((a, b) => a[1].due - b[1].due)[0];
            if (!due)
                break;
            if (++n > 10000)
                throw Error('Timer loop');
            now = due[1].due;
            if (due[1].repeat)
                due[1].due += due[1].ms;
            else
                timers.delete(due[0]);
            due[1].fn();
            await clock.flush();
        } now = to; await clock.flush(); },
        pending: () => [...timers.values()].map(t => ({ interval: t.repeat, ms: t.ms })), now: () => now
    };
    const FakeDate = class extends Date {
        constructor(...a) { super(...(a.length ? a : [now])); }
        static now() { return now; }
    };
    const ctx = vm.createContext({ console, Date: FakeDate, performance: { now: () => now }, setTimeout: (fn, ms = 0) => clock.set(fn, ms, false), clearTimeout: id => clock.clear(id), setInterval: (fn, ms) => clock.set(fn, ms, true), clearInterval: id => clock.clear(id), TextEncoder, TextDecoder, URL, Blob, Buffer, navigator: {}, window: { location: { hostname: 'localhost' }, ...(desktop ? { __TAURI_INTERNALS__: {} } : {}) } });
    const tauri = { invoke: async (cmd, args) => { if (cmd !== 'sdr_rpc')
            throw Error('Unexpected Tauri command ' + cmd); const req = JSON.parse(args.req); calls.push({ time: now, op: req.cmd?.op ?? req.op, gateway: req.gw, token: req.cmd?.token, action: req.cmd?.action }); return JSON.stringify(await handler(req)); } };
    function load(p) {
        const file = path.isAbsolute(p) ? p : path.join(root, p);
        if (cache.has(file))
            return cache.get(file).exports;
        const module = { exports: {} };
        cache.set(file, module);
        const src = fs.readFileSync(file, 'utf8');
        const js = ts.transpileModule(src, { fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
        const req = id => {
            if (id === '@tauri-apps/api/core')
                return tauri;
            if (id === 'tauri-plugin-serialplugin-api')
                return { SerialPort: class {
                        constructor() { throw Error('Hardware disabled'); }
                    } };
            if (id.startsWith('.')) {
                let resolved = path.resolve(path.dirname(file), id);
                if (!path.extname(resolved))
                    resolved += fs.existsSync(resolved + '.ts') ? '.ts' : '.tsx';
                return load(resolved);
            }
            if (['zustand', 'react', 'react/jsx-runtime', 'react-dom/server'].includes(id))
                return pkgRequire(id);
            throw Error('External import blocked ' + id);
        };
        const f = vm.runInContext('(function(require,module,exports){' + js + '\n})', ctx, { filename: file });
        f(req, module, module.exports);
        return module.exports;
    }
    const store = load('app/src/state/store.ts');
    const run = load('app/src/components/cinema/run.ts');
    const status = load('app/src/components/cinema/status.ts');
    return { load, store, run, status, clock, calls, get: () => store.useLegion.getState(), setHandler: fn => { handler = fn; } };
}
const assert = require('node:assert/strict');
const tests = [];
function test(name, run) { tests.push({ name, run }); }
function normal(q) {
    if (q.op === 'close' || q.op === 'tx_off')
        return { ok: true };
    if (q.op !== 'fpga')
        throw Error('Unexpected external operation ' + q.op);
    if (q.cmd.op === 'ping')
        return { ok: true, legion: true, fake: false, board: 'bladerf2' };
    if (q.cmd.op === 'status')
        return { ok: true, legion: true, det_active: true, det_count: 10 };
    return { ok: true };
}
function opts(r) {
    const s = r.get();
    return { f1: s.sdrF1, f2: s.sdrF2, wave: s.signalKind, loadOk: true, path: 'auto' };
}
async function start(r) {
    r.get().setSdrGateway('gateway-A');
    r.get().setFpgaToken('test-token-A');
    assert(await r.run.runSmartStart(opts(r)));
    await r.clock.flush();
    assert(r.get().fpgaArmed);
    return r;
}
const hero = r => r.status.heroStatusLine(r.get());
function pending(r) {
    assert.equal(r.get().fpgaStopPending, true);
    assert.equal(hero(r).kind, 'error');
    assert.match(hero(r).text, /ОСТАНОВКА НЕ ПОДТВЕРЖДЕНА/);
    assert(r.run.cinemaIsLive(r.get()));
}
async function clean(r) {
    r.setHandler(normal);
    await r.run.runCinemaStop();
    await r.clock.flush();
    assert.equal(r.get().fpgaStopPending, false);
    assert.equal(r.get().fpgaArmed, false);
    assert.equal(r.clock.pending().length, 0);
}
test('active connection cannot move STOP to another gateway', async () => {
    const r = await start(makeRuntime());
    const id = r.get().sdrId;
    r.get().setSdrGateway('gateway-B');
    r.get().setFpgaToken('test-token-B');
    r.get().setSdrId('hackrf');
    assert.equal(r.get().sdrGateway, 'gateway-A');
    assert.equal(r.get().fpgaToken, 'test-token-A');
    assert.equal(r.get().sdrId, id);
    Object.assign(r.store.useLegion.getInitialState(), r.get());
    const panel = r.load('app/src/components/SdrPanel.tsx').SdrPanel;
    const html = pkgRequire('react-dom/server').renderToStaticMarkup(pkgRequire('react').createElement(panel));
    assert.match(html, /<input[^>]*aria-label="Адрес Ethernet SDR или шлюза"[^>]*disabled/);
    const from = r.calls.length;
    await clean(r);
    assert.deepEqual(r.calls.slice(from).map(c => [c.op, c.gateway, c.token]), [
        ['disarm', 'gateway-A', 'test-token-A'], ['usb', 'gateway-A', 'test-token-A'],
    ]);
    r.get().setSdrGateway('gateway-B');
    r.get().setFpgaToken('test-token-B');
    assert.equal(r.get().sdrGateway, 'gateway-B');
    assert.equal(r.get().fpgaToken, 'test-token-B');
});
test('connection stays locked while initial preparation is in flight', async () => {
    const r = makeRuntime();
    let reply;
    r.setHandler(q => q.cmd?.op === 'ping' ? new Promise(resolve => reply = resolve) : normal(q));
    r.get().setSdrGateway('gateway-A');
    assert(await r.run.runSmartStart(opts(r)));
    await r.clock.flush();
    assert(r.get().fpgaBusy && !r.get().fpgaArmed);
    r.get().setSdrGateway('gateway-B');
    assert.equal(r.get().sdrGateway, 'gateway-A');
    await r.run.runCinemaStop();
    reply({ ok: false, reason: 'cancelled preparation' });
    await r.clock.flush();
    assert(!r.get().fpgaArmed && !r.get().fpgaBusy);
    assert(!r.calls.some(c => c.op === 'arm'));
});
test('quick refusal stays unconfirmed and retries only DISARM until recovery', async () => {
    const r = await start(makeRuntime());
    r.setHandler(q => q.cmd?.op === 'disarm' ? { ok: false, reason: 'CTRL write failed' } : normal(q));
    const from = r.calls.length;
    await r.run.runCinemaStop();
    pending(r);
    assert.match(hero(r).detail, /CTRL write failed/);
    const dock = r.load('app/src/components/cinema/CinemaDock.tsx').CinemaDock;
    // SSR reads getInitialState; render an explicit snapshot of this isolated store.
    Object.assign(r.store.useLegion.getInitialState(), r.get());
    const html = pkgRequire('react-dom/server').renderToStaticMarkup(pkgRequire('react').createElement(dock, {
        mode: 'sdr', onMode() { }, onStart() { }, onSettings() { },
    }));
    assert.match(html, /Остановка FPGA не подтверждена/);
    assert.match(html, /CTRL write failed/);
    await r.clock.tick(6000);
    pending(r);
    assert.equal(r.calls.slice(from).length, 7);
    assert(r.calls.slice(from).every(c => c.op === 'disarm' && c.gateway === 'gateway-A'));
    r.get().setSdrGateway('gateway-B');
    assert.equal(r.get().sdrGateway, 'gateway-A');
    // A successful retry finishes by itself, without a second user click.
    r.setHandler(normal);
    await r.clock.tick(1000);
    assert.equal(r.get().fpgaStopPending, false);
    assert.equal(r.get().fpgaArmed, false);
    assert.equal(hero(r).kind, 'idle');
    const done = r.calls.length;
    await r.clock.tick(10000);
    assert.equal(r.calls.length, done);
    assert.equal(r.clock.pending().length, 0);
});
test('slow refusal cannot use elapsed time as a false acknowledgement', async () => {
    const r = await start(makeRuntime());
    r.setHandler(q => q.cmd?.op === 'disarm'
        ? new Promise(resolve => r.clock.set(() => resolve({ ok: false, reason: 'timeout' }), 4000, false))
        : normal(q));
    const stop = r.run.runCinemaStop();
    await r.clock.flush();
    pending(r);
    await r.clock.tick(4000);
    await stop;
    pending(r);
    assert(r.get().fpgaArmed);
    await clean(r);
});
test('concurrent manual stops share one RPC and one retry timer', async () => {
    const r = await start(makeRuntime());
    let reply;
    r.setHandler(q => q.cmd?.op === 'disarm' ? new Promise(resolve => reply = resolve) : normal(q));
    const from = r.calls.length;
    const a = r.run.runCinemaStop();
    const b = r.run.runCinemaStop();
    await r.clock.flush();
    assert.equal(r.calls.length - from, 1);
    reply({ ok: false, reason: 'refused' });
    await Promise.all([a, b]);
    assert.equal(r.clock.pending().length, 1);
    await r.clock.tick(1000);
    const c = r.run.runCinemaStop();
    await r.clock.flush();
    assert.equal(r.calls.length - from, 2);
    reply({ ok: true });
    await c;
    await r.clock.flush();
    assert.equal(r.get().fpgaStopPending, false);
    assert.equal(r.clock.pending().length, 0);
});
test('late STATUS and kick replies cannot overwrite pending STOP', async () => {
    const r = await start(makeRuntime());
    let statusReply, kickReply;
    r.setHandler(q => {
        if (q.cmd?.op === 'status')
            return new Promise(resolve => statusReply = resolve);
        if (q.cmd?.op === 'kick')
            return new Promise(resolve => kickReply = resolve);
        if (q.cmd?.op === 'disarm')
            return { ok: false, reason: 'stop refused' };
        return normal(q);
    });
    await r.clock.tick(500);
    assert(statusReply && kickReply);
    await r.run.runCinemaStop();
    const n = r.calls.length;
    statusReply({ ok: true, det_active: true, wd_fired: true });
    kickReply({ ok: false, reason: 'old kick failed' });
    await r.clock.flush();
    pending(r);
    assert.equal(r.get().fpgaStatus.reason, 'stop refused');
    assert.equal(r.calls.length, n);
    await r.get().fpgaPollStatus();
    assert.equal(r.calls.length, n);
    await clean(r);
});
test('USB release finishes against the original connection before unlock', async () => {
    const r = await start(makeRuntime());
    let reply;
    r.setHandler(q => q.cmd?.op === 'usb' && q.cmd.action === 'release'
        ? new Promise(resolve => reply = resolve) : normal(q));
    const stop = r.run.runCinemaStop();
    await r.clock.flush();
    assert(!r.get().fpgaArmed && r.get().fpgaStopPending);
    assert.equal(hero(r).text, 'ЗАВЕРШЕНИЕ ОСТАНОВКИ');
    r.get().setSdrGateway('gateway-B');
    assert.equal(r.get().sdrGateway, 'gateway-A');
    reply({ ok: false, reason: 'release refused' });
    await stop;
    assert(r.get().fpgaStopPending, 'failed release must keep cleanup pending');
    assert(r.get().log.some(l => /release refused/.test(l.text)));
    assert.equal(r.clock.pending().length, 1);
    await clean(r);
});
test('STOP during pending ARM keeps failed cancellation visible and blocks a new start', async () => {
    const r = makeRuntime();
    let reply;
    r.setHandler(q => {
        if (q.cmd?.op === 'arm')
            return new Promise(resolve => reply = resolve);
        if (q.cmd?.op === 'disarm')
            return { ok: false, reason: 'cancel refused' };
        return normal(q);
    });
    r.get().setSdrGateway('gateway-A');
    assert(await r.run.runSmartStart(opts(r)));
    await r.clock.flush();
    assert(reply && r.get().fpgaBusy && !r.get().fpgaArmed);
    await r.run.runCinemaStop();
    reply({ ok: true });
    await r.clock.flush();
    pending(r);
    assert(!r.get().fpgaArmed);
    const from = r.calls.length;
    await r.get().fpgaArm();
    assert.equal(await r.get().startFpgaPath('solo'), false);
    r.get().startScan();
    await r.get().openSdr();
    await r.get().signalFlash();
    await r.clock.flush();
    assert.equal(r.calls.length, from);
    assert(!r.calls.some(c => c.op === 'kick'));
    await clean(r);
});
test('closing or changing backend cannot conceal a refused stop or release USB', async () => {
    const r = await start(makeRuntime());
    r.setHandler(q => q.cmd?.op === 'disarm' ? { ok: false, reason: 'refused' } : normal(q));
    const from = r.calls.length;
    await r.get().closeSdr();
    pending(r);
    assert(!r.calls.slice(from).some(c => c.op === 'usb'));
    r.get().setSdrEmulation(true);
    await r.clock.flush();
    pending(r);
    assert.equal(r.get().sdrEmulation, false);
    await clean(r);
});
test('null, absent and malformed gate telemetry are unknown, never closed', async () => {
    const r = await start(makeRuntime());
    for (const status of [null, {}, { ok: true }, { ok: true, det_active: null }, { ok: true, det_active: 0 }, { det_active: false }]) {
        r.store.useLegion.setState({ fpgaStatus: status });
        assert.equal(hero(r).kind, 'unknown');
        assert.doesNotMatch(hero(r).detail, /гейт закрыт/);
    }
    for (const [status, kind] of [
        [{ ok: true, det_active: false }, 'relay-wait'],
        [{ ok: true, det_active: true }, 'relay'],
        [{ ok: false, reason: 'no telemetry' }, 'error'],
    ]) {
        r.store.useLegion.setState({ fpgaStatus: status });
        assert.equal(hero(r).kind, kind);
    }
    await clean(r);
});
test('real start with delayed first STATUS shows unknown until data arrives', async () => {
    const r = makeRuntime();
    let reply;
    r.setHandler(q => q.cmd?.op === 'status' ? new Promise(resolve => reply = resolve) : normal(q));
    await start(r);
    assert.equal(r.get().fpgaStatus, null);
    assert.equal(hero(r).kind, 'unknown');
    reply({ ok: true, det_active: false });
    await r.clock.flush();
    assert.equal(hero(r).kind, 'relay-wait');
    await clean(r);
});
test('changing an idle connection invalidates its late STATUS response', async () => {
    const r = makeRuntime();
    let reply;
    r.get().setSdrGateway('gateway-A');
    r.setHandler(q => q.cmd?.op === 'status' ? new Promise(resolve => reply = resolve) : normal(q));
    const poll = r.get().fpgaPollStatus();
    await r.clock.flush();
    r.get().setSdrGateway('gateway-B');
    reply({ ok: true, det_active: true });
    await poll;
    assert.equal(r.get().sdrGateway, 'gateway-B');
    assert.equal(r.get().fpgaStatus, null);
});
test('ordinary successful STOP leaves no retries or stale telemetry', async () => {
    const r = await start(makeRuntime());
    const from = r.calls.length;
    await clean(r);
    assert.equal(hero(r).kind, 'idle');
    assert.equal(r.get().lastForwardMhz, null);
    assert.equal(r.get().fpgaStatus, null);
    assert.equal(r.calls.slice(from).filter(c => c.op === 'disarm').length, 1);
});
test('control: normal STOP sends DISARM and clears ARM without a timer', async () => {
    const r = await start(makeRuntime());
    const from = r.calls.length;
    await r.run.runCinemaStop();
    assert.equal(r.get().fpgaArmed, false);
    assert.equal(r.clock.pending().length, 0);
    assert.equal(r.calls.slice(from).filter(c => c.op === 'disarm').length, 1);
});
test('cancelled ARM with a lost reply still requires confirmed DISARM', async () => {
    const r = makeRuntime();
    let failArm;
    r.setHandler(q => {
        if (q.cmd?.op === 'arm') return new Promise((_, reject) => failArm = reject);
        if (q.cmd?.op === 'disarm') return { ok: false, reason: 'disconnect not confirmed' };
        return normal(q);
    });
    r.get().setSdrGateway('gateway-A');
    await r.run.runSmartStart(opts(r));
    await r.clock.flush();
    assert(failArm, 'the ARM request must actually be in flight');
    await r.run.runCinemaStop();
    failArm(Error('gateway response timeout after sending ARM'));
    await r.clock.flush();
    assert.equal(r.calls.filter(c => c.op === 'disarm').length, 1);
    pending(r);
    assert(r.get().log.some(l => /gateway response timeout after sending ARM/.test(l.text)));
    assert(!r.calls.some(c => c.op === 'kick'));
    await r.clock.tick(1000);
    assert.equal(r.calls.filter(c => c.op === 'disarm').length, 2);
    await clean(r);
});
test('closing SDR revokes an ARM that is still awaiting its reply', async () => {
    const r = makeRuntime();
    let finishArm;
    r.setHandler(q => q.cmd?.op === 'arm'
        ? new Promise(resolve => finishArm = resolve) : normal(q));
    await r.run.runSmartStart(opts(r));
    await r.clock.flush();
    assert(finishArm);
    await r.get().closeSdr();
    finishArm({ ok: true });
    await r.clock.flush();
    assert.equal(r.get().fpgaArmed, false);
    assert.equal(r.get().fpgaStopPending, false);
    assert.equal(r.calls.filter(c => c.op === 'disarm').length, 1);
    assert(!r.calls.some(c => c.op === 'kick' || c.op === 'status'));
    assert.equal(r.clock.pending().length, 0);
});
test('backend switching is refused while FPGA preparation is in flight', async () => {
    const r = makeRuntime();
    let finishArm;
    r.setHandler(q => q.cmd?.op === 'arm'
        ? new Promise(resolve => finishArm = resolve) : normal(q));
    await r.run.runSmartStart(opts(r));
    await r.clock.flush();
    assert(finishArm);
    r.get().setSdrEmulation(true);
    await r.clock.flush();
    assert.equal(r.get().sdrEmulation, false);
    assert(r.get().log.some(l => /Смена бэкенда заблокирована/.test(l.text)));
    Object.assign(r.store.useLegion.getInitialState(), r.get());
    const panel = r.load('app/src/components/SdrPanel.tsx').SdrPanel;
    const html = pkgRequire('react-dom/server').renderToStaticMarkup(pkgRequire('react').createElement(panel));
    assert.match(html, /<input[^>]*type="checkbox"[^>]*disabled/);
    await r.run.runCinemaStop();
    finishArm({ ok: true });
    await r.clock.flush();
    assert(!r.get().fpgaArmed && !r.get().fpgaStopPending);
});
for (const entry of ['manual', 'solo', 'air']) {
    test(`${entry}: cancellation after a lost ARM reply requires DISARM`, async () => {
        const r = makeRuntime();
        let failArm;
        r.setHandler(q => {
            // Only the external hardware boundary is simulated, including preparation.
            if (q.op === 'probe') return { ok: true, soapy: true };
            if (q.op === 'open' || q.op === 'park') return { ok: true, fake: false };
            if (q.cmd?.op === 'arm') return new Promise((_, reject) => failArm = reject);
            if (q.cmd?.op === 'disarm') return { ok: false, reason: 'no shutdown acknowledgement' };
            return normal(q);
        });
        r.get().setSdrLoad(true);
        r.get().setFpgaMode('nco');
        r.get().armTxWave('sine');
        // A single window keeps this shutdown test independent of calibration fixtures.
        r.get().setSdrAllowField('sdrF2', String(Number(r.get().sdrF1) + 1));
        const starting = entry === 'manual' ? r.get().fpgaArm() : r.get().startFpgaPath(entry);
        await r.clock.flush();
        assert(failArm, 'must reach an actual ARM request through the original store');
        await r.run.runCinemaStop();
        failArm(Error('lost ARM response'));
        await r.clock.flush();
        await starting;
        assert.equal(r.calls.filter(c => c.op === 'disarm').length, 1);
        pending(r);
        assert(!r.calls.some(c => c.op === 'kick'));
        await clean(r);
    });
}
test('closing during ping cancels preparation without creating an unconfirmed ARM', async () => {
    const r = makeRuntime();
    let finishPing;
    r.setHandler(q => q.cmd?.op === 'ping'
        ? new Promise(resolve => finishPing = resolve) : normal(q));
    await r.run.runSmartStart(opts(r));
    await r.clock.flush();
    assert(finishPing);
    await r.get().closeSdr();
    finishPing({ ok: true, legion: true, fake: false });
    await r.clock.flush();
    assert(!r.get().fpgaArmed && !r.get().fpgaStopPending && !r.get().fpgaBusy);
    assert(!r.calls.some(c => c.op === 'arm' || c.op === 'disarm' || c.op === 'kick'));
    assert.equal(r.clock.pending().length, 0);
});
test('backend switching still works when idle and after confirmed shutdown', async () => {
    const r = await start(makeRuntime());
    r.get().setSdrEmulation(true);
    await r.clock.flush();
    assert.equal(r.get().sdrEmulation, true);
    assert(!r.get().fpgaArmed && !r.get().fpgaStopPending);
    assert.equal(r.clock.pending().length, 0);
    assert(r.calls.some(c => c.op === 'disarm'));
    r.get().setSdrEmulation(false);
    await r.clock.flush();
    assert.equal(r.get().sdrEmulation, false);
});
for (const action of ['stop', 'close']) {
    test(`${action} during USB acquisition releases the late acquired connection`, async () => {
        const r = makeRuntime();
        let finishAcquire, owned = false;
        r.setHandler(q => {
            if (q.cmd?.op === 'usb' && q.cmd.action === 'acquire') {
                return new Promise(resolve => finishAcquire = () => { owned = true; resolve({ ok: true }); });
            }
            if (q.cmd?.op === 'usb' && q.cmd.action === 'release') {
                owned = false;
                return { ok: true };
            }
            return normal(q);
        });
        await r.run.runSmartStart(opts(r));
        await r.clock.flush();
        assert(finishAcquire);
        if (action === 'stop') await r.run.runCinemaStop();
        else await r.get().closeSdr();
        finishAcquire();
        await r.clock.flush();
        assert.equal(owned, false);
        assert(!r.calls.some(c => c.op === 'arm' || c.op === 'kick'));
        assert(!r.get().fpgaArmed && !r.get().fpgaBusy && !r.get().fpgaStopPending);
    });
}
test('x40 cancellation during preparation releases the reacquired connection', async () => {
    const r = makeRuntime();
    let finishPark, owned = false;
    r.get().setSdrId('bladerf-x40');
    r.setHandler(q => {
        if (q.op === 'probe') return { ok: true, soapy: true };
        if (q.op === 'open') return { ok: true, fake: false };
        if (q.op === 'park') return new Promise(resolve => finishPark = resolve);
        if (q.cmd?.op === 'usb') owned = q.cmd.action === 'acquire';
        return normal(q);
    });
    await r.run.runSmartStart(opts(r));
    await r.clock.flush();
    assert(finishPark);
    await r.run.runCinemaStop();
    finishPark({ ok: true, fake: false });
    await r.clock.flush();
    assert.equal(owned, false);
    assert(!r.calls.some(c => c.op === 'arm' || c.op === 'kick'));
    assert(!r.get().fpgaBusy && !r.get().fpgaArmed && !r.get().fpgaStopPending);
});

for (const entry of ['smart', 'manual', 'solo', 'air']) {
    test(`${entry}: a lost ARM response without a Stop click still fails closed`, async () => {
        const r = makeRuntime();
        let failArm, hardwareArmed = false;
        r.setHandler(q => {
            if (q.op === 'probe') return { ok: true, soapy: true };
            if (q.op === 'open' || q.op === 'park') return { ok: true, fake: false };
            if (q.cmd?.op === 'arm') {
                hardwareArmed = true;
                return new Promise((_, reject) => failArm = reject);
            }
            if (q.cmd?.op === 'disarm') return { ok: false, reason: 'shutdown link unavailable' };
            return normal(q);
        });
        r.get().setSdrLoad(true);
        r.get().setFpgaMode('nco');
        r.get().armTxWave('sine');
        r.get().setSdrAllowField('sdrF2', String(Number(r.get().sdrF1) + 1));
        const starting = entry === 'smart' ? r.run.runSmartStart(opts(r))
            : entry === 'manual' ? r.get().fpgaArm() : r.get().startFpgaPath(entry);
        await r.clock.flush();
        assert(failArm && hardwareArmed);
        failArm(Error('reply lost after applying ARM'));
        await r.clock.flush();
        await starting;
        assert.equal(r.calls.filter(c => c.op === 'disarm').length, 1, 'ambiguous ARM must trigger shutdown');
        pending(r);
        assert(!r.calls.some(c => c.op === 'kick'));
        assert(r.get().log.some(l => /reply lost after applying ARM/.test(l.text)));
        await clean(r);
    });
}
test('failed USB release retains ownership lock and retries only release at original target', async () => {
    const r = await start(makeRuntime());
    let owned = true;
    r.setHandler(q => q.cmd?.op === 'usb' && q.cmd.action === 'release'
        ? { ok: false, reason: 'transport still owned' } : normal(q));
    const from = r.calls.length;
    await r.run.runCinemaStop();
    assert(owned && r.get().fpgaStopPending, 'cannot report idle with unconfirmed release');
    assert(!r.get().fpgaArmed, 'confirmed DISARM remains confirmed');
    assert.equal(hero(r).kind, 'error');
    assert.match(hero(r).detail, /transport still owned/);
    assert.doesNotMatch(hero(r).detail, /повторяем команду отключения/);
    Object.assign(r.store.useLegion.getInitialState(), r.get());
    const dock = r.load('app/src/components/cinema/CinemaDock.tsx').CinemaDock;
    const html = pkgRequire('react-dom/server').renderToStaticMarkup(pkgRequire('react').createElement(dock, {
        mode: 'sdr', onMode() {}, onStart() {}, onSettings() {},
    }));
    assert.match(html, /Освобождаем соединение/);
    assert.match(html, /transport still owned/);
    const beforeRestart = r.calls.length;
    await r.get().fpgaArm();
    assert.equal(await r.get().startFpgaPath('solo'), false);
    r.get().startScan();
    await r.clock.flush();
    assert.equal(r.calls.length, beforeRestart, 'release failure blocks new sessions');
    r.get().setSdrGateway('gateway-B');
    r.get().setFpgaToken('token-B');
    assert.equal(r.get().sdrGateway, 'gateway-A');
    assert.equal(r.get().fpgaToken, 'test-token-A');
    await r.clock.tick(3000);
    const calls = r.calls.slice(from);
    assert.equal(calls.filter(c => c.op === 'disarm').length, 1);
    assert.equal(calls.filter(c => c.op === 'usb' && c.action === 'release').length, 4);
    assert(calls.every(c => c.gateway === 'gateway-A' && c.token === 'test-token-A'));
    r.setHandler(q => { if (q.cmd?.op === 'usb' && q.cmd.action === 'release') owned = false; return normal(q); });
    await r.clock.tick(1000);
    assert(!owned && !r.get().fpgaStopPending);
    assert.equal(hero(r).kind, 'idle');
    assert.equal(r.clock.pending().length, 0);
});
test('cancelled acquisition keeps retrying a failed cleanup without ARM or DISARM', async () => {
    const r = makeRuntime();
    let acquire, owned = false;
    r.setHandler(q => {
        if (q.cmd?.op === 'usb' && q.cmd.action === 'acquire')
            return new Promise(resolve => acquire = () => { owned = true; resolve({ ok: true }); });
        if (q.cmd?.op === 'usb' && q.cmd.action === 'release') return { ok: false, reason: 'release lost' };
        return normal(q);
    });
    await r.run.runSmartStart(opts(r));
    await r.clock.flush();
    assert(acquire);
    await r.run.runCinemaStop();
    acquire();
    await r.clock.flush();
    assert(owned && r.get().fpgaStopPending);
    assert.equal(hero(r).kind, 'error');
    await r.clock.tick(2000);
    assert(!r.calls.some(c => c.op === 'arm' || c.op === 'disarm' || c.op === 'kick'));
    assert.equal(r.calls.filter(c => c.op === 'usb' && c.action === 'release').length, 3);
    r.setHandler(q => { if (q.cmd?.op === 'usb' && q.cmd.action === 'release') owned = false; return normal(q); });
    await r.clock.tick(1000);
    assert(!owned && !r.get().fpgaStopPending);
    assert.equal(r.clock.pending().length, 0);
});

for (const entry of ['manual', 'solo', 'air']) {
    test(`${entry}: cancel before ARM releases a late USB acquisition`, async () => {
        const r = makeRuntime();
        let acquire, owned = false;
        r.setHandler(q => {
            if (q.op === 'probe') return { ok: true, soapy: true };
            if (q.op === 'open' || q.op === 'park') return { ok: true, fake: false };
            if (q.cmd?.op === 'usb' && q.cmd.action === 'acquire')
                return new Promise(resolve => acquire = () => { owned = true; resolve({ ok: true }); });
            if (q.cmd?.op === 'usb' && q.cmd.action === 'release') owned = false;
            return normal(q);
        });
        r.get().setSdrLoad(true);
        r.get().setFpgaMode('nco');
        r.get().armTxWave('sine');
        r.get().setSdrAllowField('sdrF2', String(Number(r.get().sdrF1) + 1));
        const starting = entry === 'manual' ? r.get().fpgaArm() : r.get().startFpgaPath(entry);
        await r.clock.flush();
        assert(acquire);
        await r.run.runCinemaStop();
        acquire();
        await r.clock.flush();
        await starting;
        assert.equal(owned, false, 'cancelled preparation must not retain USB');
        assert(!r.calls.some(c => c.op === 'arm' || c.op === 'disarm' || c.op === 'kick'));
        assert(!r.get().fpgaBusy && !r.get().fpgaArmed && !r.get().fpgaStopPending);
    });
}

for (const entry of ['smart', 'manual', 'solo', 'air']) {
    test(`${entry}: failed ARM with successful shutdown releases USB exactly once`, async () => {
        const r = makeRuntime();
        let hardwareArmed = false, owned = false;
        r.setHandler(q => {
            if (q.op === 'probe') return { ok: true, soapy: true };
            if (q.op === 'open' || q.op === 'park') return { ok: true, fake: false };
            if (q.cmd?.op === 'arm') { hardwareArmed = true; throw Error('ARM acknowledgement lost'); }
            if (q.cmd?.op === 'disarm') hardwareArmed = false;
            if (q.cmd?.op === 'usb') owned = q.cmd.action === 'acquire';
            return normal(q);
        });
        r.get().setSdrLoad(true);
        r.get().setFpgaMode('nco');
        r.get().armTxWave('sine');
        r.get().setSdrAllowField('sdrF2', String(Number(r.get().sdrF1) + 1));
        if (entry === 'smart') await r.run.runSmartStart(opts(r));
        else if (entry === 'manual') await r.get().fpgaArm();
        else assert.equal(await r.get().startFpgaPath(entry), false);
        await r.clock.flush();
        assert(!hardwareArmed && !owned);
        const armAt = r.calls.findIndex(c => c.op === 'arm');
        assert(armAt >= 0);
        assert.deepEqual(r.calls.slice(armAt + 1).map(c => [c.op, c.action]), [
            ['disarm', undefined], ['usb', 'release'],
        ]);
        assert(!r.get().fpgaArmed && !r.get().fpgaStopPending && !r.get().fpgaBusy);
        assert.equal(r.clock.pending().length, 0);
    });
}
test('manual cleanup and automatic release retry share one request', async () => {
    const r = await start(makeRuntime());
    r.setHandler(q => q.cmd?.op === 'usb' ? { ok: false, reason: 'release transport timeout' } : normal(q));
    await r.run.runCinemaStop();
    let release;
    r.setHandler(q => q.cmd?.op === 'usb' && q.cmd.action === 'release'
        ? new Promise(resolve => release = resolve) : normal(q));
    const from = r.calls.length;
    await r.clock.tick(1000);
    const manual = r.run.runCinemaStop();
    const another = r.get().closeSdr();
    await r.clock.flush();
    assert.equal(r.calls.length - from, 1);
    assert.equal(r.calls[from].action, 'release');
    release({ ok: true });
    await Promise.all([manual, another]);
    assert(!r.get().fpgaStopPending && !r.get().fpgaBusy);
    assert.equal(r.clock.pending().length, 0);
});

(async () => {
    let failures = 0;
    for (const { name, run } of tests) {
        try {
            await run();
            console.log('PASS', name);
        }
        catch (e) {
            failures++;
            console.error('FAIL', name, e.message);
        }
    }
    console.log(`FPGA STOP: ${tests.length - failures}/${tests.length} passed`);
    process.exitCode = failures ? 1 : 0;
})();
