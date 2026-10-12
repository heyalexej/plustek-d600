import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { createScannerServer } from '../ui/server.mjs';
import { pgmToPng, pnmToPng } from '../ui/png.mjs';

// The fixture is used only by this isolated test server, never by the live UI.
async function fixture(t, mode = 'success') {
  const root = mkdtempSync(join(tmpdir(), 'd600-ui-test-'));
  const fake = join(root, 'driver.cjs');
  if (mode === 'buttons') writeFileSync(join(root, 'button'), '1');
  writeFileSync(fake, `
    const fs = require('node:fs'), path = require('node:path');
    const root = __dirname, args = process.argv.slice(2), mode = ${JSON.stringify(mode)};
    if (args[0] === '--scan-auto') {
      fs.writeFileSync(path.join(root, 'scan-args.json'), JSON.stringify(args));
      fs.writeFileSync(path.join(root, 'scan-env.json'), JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('D600_')))));
      if (mode === 'empty') { console.error('No paper at feed sensor; scan refused'); process.exit(1); }
      if (mode === 'limit') {
        fs.writeFileSync(args[2] + '.raw', Buffer.from([128, 128]));
        console.error('Automatic scan limit reached before complete paper end; raw partial data saved'); process.exit(1);
      }
      if (mode === 'slow') {
        process.on('SIGTERM', () => { fs.writeFileSync(path.join(root, 'stopped'), 'yes'); process.exit(143); });
        console.log('Scan rows: 5000 end=0'); setInterval(() => {}, 100);
      } else {
        const height = mode === 'long' ? 12000 : 2;
        const color = args[1].endsWith('color300.json') || args[1].endsWith('color600.json');
        fs.writeFileSync(args[2], Buffer.concat([Buffer.from((color ? 'P6' : 'P5') + '\\n2 ' + height + '\\n255\\n'), Buffer.alloc(2 * height * (color ? 3 : 1), 128)]));
        if (args[1].includes('native-duplex-') && mode !== 'missing-back') {
          fs.writeFileSync(args[2].replace(/\\.(pgm|ppm)$/, '-back.$1'), Buffer.concat([Buffer.from((color ? 'P6' : 'P5') + '\\n2 ' + height + '\\n255\\n'), Buffer.alloc(2 * height * (color ? 3 : 1), 64)]));
        }
        fs.writeFileSync(path.join(root, 'scanned'), 'yes'); console.log('Image bytes: 4/4 (USB LIBUSB_SUCCESS)');
      }
    } else if (args[0] === '--status') {
      const read = (name, fallback) => fs.existsSync(path.join(root, name)) ? fs.readFileSync(path.join(root, name), 'utf8') : fallback;
      const empty = mode === 'buttons' ? read('paper', '1') === '0' : mode === 'empty' || fs.existsSync(path.join(root, 'scanned'));
      const irq = read('irq', '00');
      fs.rmSync(path.join(root, 'irq'), {force: true});
      console.log(' 01=80 41=' + (empty ? 'd8' : 'd0') + ' button=' + read('button', '0') + ' irq=' + irq);
    } else if (args[0] === '--eject-tail') {
      fs.writeFileSync(path.join(root, 'ejected'), 'yes');
      fs.writeFileSync(path.join(root, 'eject-period'), process.env.D600_FEED_PERIOD || '10000');
    }
  `);
  let app, base;
  const start = async () => {
    app = createScannerServer({ root, driver: process.execPath, driverArgs: [fake], pollInterval: mode === 'buttons' ? 50 : 100000 });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${app.server.address().port}`;
  };
  await start();
  t.after(async () => { await app.shutdown(); rmSync(root, { recursive: true, force: true }); });
  const state = () => fetch(base + '/api/state').then(response => response.json());
  const post = (route, headers = {}) => fetch(base + route, { method: 'POST', headers: { 'X-Scanner-UI': '1', ...headers } });
  return { root, get base() { return base; }, state, post, restart: async () => { await app.shutdown(); await start(); } };
}
async function until(read, predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('Timed out waiting for scanner state');
}

test('PGM conversion preserves every pixel and rejects truncated captures', () => {
  const pgm = Buffer.concat([Buffer.from('P5\n2 2\n255\n'), Buffer.from([0, 40, 128, 255])]);
  const result = pgmToPng(pgm);
  assert.equal(result.width, 2); assert.equal(result.height, 2);
  const length = result.png.readUInt32BE(33);
  assert.deepEqual([...inflateSync(result.png.subarray(41, 41 + length))], [0, 0, 40, 0, 128, 255]);
  assert.throws(() => pgmToPng(pgm.subarray(0, -1)), /Unvollständig/);
});

test('RGB PNG preserves red, green, blue and white without channel swapping', () => {
  const pixels = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
  const ppm = Buffer.concat([Buffer.from('P6\n2 2\n255\n'), pixels]);
  const result = pnmToPng(ppm);
  assert.equal(result.channels, 3);
  assert.equal(result.png[25], 2, 'PNG must declare truecolor RGB');
  const length = result.png.readUInt32BE(33);
  assert.deepEqual([...inflateSync(result.png.subarray(41, 41 + length))], [0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255]);
  assert.throws(() => pnmToPng(ppm.subarray(0, -1)), /Unvollständig/);
});

test('color selection chooses the RGB driver profile and publishes PNG plus PPM', async t => {
  const f = await fixture(t);
  assert.equal((await f.post('/api/mode?mode=invalid')).status, 400);
  assert.equal((await f.post('/api/mode?mode=color')).status, 200);
  assert.equal(JSON.parse(readFileSync(join(f.root, 'captures/ui/settings.json'))).mode, 'color');
  assert.equal((await f.post('/api/scan')).status, 202);
  const state = await until(f.state, value => value.job?.phase === 'done');
  assert.equal(state.job.mode, 'color'); assert.equal(state.scans[0].mode, 'color');
  const args = JSON.parse(readFileSync(join(f.root, 'scan-args.json')));
  assert.ok(args[1].endsWith('/profiles/native-color600.json'));
  const png = Buffer.from(await (await fetch(`${f.base}/scans/${state.job.id}.png`)).arrayBuffer());
  assert.equal(png[25], 2);
  const ppm = await fetch(`${f.base}/scans/${state.job.id}.ppm?download=1`);
  assert.equal(ppm.headers.get('content-type'), 'image/x-portable-pixmap');
  assert.ok((await ppm.text()).startsWith('P6\n'));
  assert.equal((await fetch(`${f.base}/scans/${state.job.id}.pgm`)).status, 404);
  await f.restart();
  const restored = await f.state();
  assert.equal(restored.settings.mode, 'color');
  assert.equal(restored.scans[0].id, state.job.id);
  assert.equal((await fetch(`${f.base}/scans/${state.job.id}.ppm`)).status, 200);
});

test('scan runs the driver, publishes a valid download, and ejects only after sensor clears', async t => {
  const f = await fixture(t);
  await until(f.state, value => value.device.connected);
  assert.equal((await f.post('/api/scan')).status, 202);
  const state = await until(f.state, value => value.job?.phase === 'done');
  assert.equal(state.scans.length, 1); assert.equal(state.scans[0].width, 2);
  assert.ok(existsSync(join(f.root, 'ejected')));
  const image = await fetch(`${f.base}/scans/${state.scans[0].id}.png?download=1`);
  assert.equal(image.status, 200); assert.match(image.headers.get('content-disposition'), /attachment/);
  assert.deepEqual([...new Uint8Array(await image.arrayBuffer()).slice(0, 8)], [137,80,78,71,13,10,26,10]);
  assert.equal((await f.post('/api/scan', { Origin: 'https://unrelated.example' })).status, 403);
  assert.equal((await fetch(f.base + '/scans/not-a-scan.png')).status, 404);
});

test('empty feeder produces a real error without publishing a fake scan', async t => {
  const f = await fixture(t, 'empty');
  assert.equal((await f.post('/api/scan')).status, 202);
  const state = await until(f.state, value => value.job?.phase === 'error');
  assert.match(state.job.message, /Kein Papier/); assert.equal(state.scans.length, 0);
  assert.ok(!existsSync(join(f.root, 'ejected')));
});

test('parallel scan is rejected; stop signals the existing process and releases the scanner', async t => {
  const f = await fixture(t, 'slow');
  assert.equal((await f.post('/api/scan')).status, 202);
  const scanning = await until(f.state, value => value.job?.rows === 5000);
  assert.equal(scanning.job.progress, null);
  assert.equal((await f.post('/api/scan')).status, 409);
  assert.equal((await f.post('/api/mode?mode=color')).status, 409);
  assert.equal((await f.post('/api/sides?sides=duplex')).status, 409);
  assert.equal((await f.post('/api/preset?preset=fast')).status, 409);
  assert.equal((await f.post('/api/stop')).status, 202);
  const state = await until(f.state, value => value.job?.phase === 'cancelled' && !value.busy);
  assert.ok(existsSync(join(f.root, 'stopped'))); assert.equal(state.scans.length, 0);
});

test('long receipt keeps all 12000 rows in the published PNG', async t => {
  const f = await fixture(t, 'long');
  assert.equal((await f.post('/api/scan')).status, 202);
  const state = await until(f.state, value => value.job?.phase === 'done');
  assert.equal(state.scans[0].height, 12000);
  const png = Buffer.from(await (await fetch(`${f.base}/scans/${state.scans[0].id}.png`)).arrayBuffer());
  assert.equal(png.readUInt32BE(20), 12000);
});

test('scan limit keeps partial data private and reports an incomplete receipt', async t => {
  const f = await fixture(t, 'limit');
  assert.equal((await f.post('/api/scan')).status, 202);
  const state = await until(f.state, value => value.job?.phase === 'error');
  assert.match(state.job.message, /maximale Scanlänge/);
  assert.equal(state.scans.length, 0);
  assert.ok(existsSync(join(f.root, 'captures/ui', state.job.id + '.pgm.raw')));
  assert.equal((await fetch(`${f.base}/scans/${state.job.id}.png`)).status, 404);
  assert.ok(!existsSync(join(f.root, 'ejected')));
});

test('physical button starts once per press, accepts short IRQ pulses, and ignores paper events', async t => {
  const f = await fixture(t, 'buttons');
  const set = (name, value) => writeFileSync(join(f.root, name), value);
  const settle = () => new Promise(resolve => setTimeout(resolve, 550));
  await until(f.state, value => value.device.connected && value.device.button);
  await settle();
  assert.equal((await f.state()).job, null, 'held button at startup must not scan');
  set('button', '0');
  await until(f.state, value => !value.device.button);
  set('irq', '20');
  await settle();
  assert.equal((await f.state()).job, null, 'insertion alone must not scan');
  set('button', '1');
  const first = await until(f.state, value => value.job?.phase === 'done');
  assert.equal(first.job.source, 'button');
  await settle();
  assert.equal((await f.state()).job.id, first.job.id, 'held button must not repeat');
  set('button', '0');
  await until(f.state, value => !value.device.button);
  assert.equal((await f.post('/api/preset?preset=fast')).status, 200);
  set('irq', '04');
  const second = await until(f.state, value => value.job?.phase === 'done' && value.job.id !== first.job.id);
  assert.equal(second.job.source, 'button');
  assert.equal(second.job.mode, 'color');
  assert.equal(second.job.duplex, true);
  assert.equal(second.job.dpi, 300);
  assert.equal(second.scans[0].pages.length, 2);
  set('paper', '0');
  await until(f.state, value => !value.device.paper);
  set('irq', '04');
  await settle();
  assert.equal((await f.state()).job.id, second.job.id, 'empty feeder must not scan');
});

for (const mode of ['gray', 'color']) test(`duplex ${mode} publishes distinct pages and restores both after restart`, async t => {
  const f = await fixture(t);
  assert.equal((await f.post('/api/sides?sides=invalid')).status, 400);
  assert.equal((await f.post('/api/sides?sides=duplex')).status, 200);
  assert.equal((await f.post(`/api/mode?mode=${mode}`)).status, 200);
  assert.equal((await f.state()).settings.duplex, true, 'changing color must preserve duplex');
  assert.equal((await f.post('/api/scan')).status, 202);
  const state = await until(f.state, value => value.job?.phase === 'done');
  assert.equal(state.scans.length, 1); assert.equal(state.scans[0].pages.length, 2);
  const args = JSON.parse(readFileSync(join(f.root, 'scan-args.json')));
  assert.ok(args[1].endsWith(`/profiles/native-duplex-${mode}600.json`));
  const front = Buffer.from(await (await fetch(`${f.base}/scans/${state.job.id}.png`)).arrayBuffer());
  const back = Buffer.from(await (await fetch(`${f.base}/scans/${state.job.id}-back.png`)).arrayBuffer());
  assert.notDeepEqual(front, back);
  const extension = mode === 'color' ? 'ppm' : 'pgm';
  const download = await fetch(`${f.base}/scans/${state.job.id}-back.${extension}?download=1`);
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition'), /-back\./);
  const raw = Buffer.from(await download.arrayBuffer()); assert.equal(raw[raw.length - 1], 64);
  await f.restart();
  assert.deepEqual((await f.state()).settings, { mode, duplex: true, preset: 'standard' });
  assert.equal((await fetch(`${f.base}/scans/${state.job.id}-back.png`)).status, 200);
});

test('a missing duplex page never publishes a one-sided success', async t => {
  const f = await fixture(t, 'missing-back');
  assert.equal((await f.post('/api/sides?sides=duplex')).status, 200);
  assert.equal((await f.post('/api/scan')).status, 202);
  const state = await until(f.state, value => value.job?.phase === 'error');
  assert.match(state.job.message, /Rückseite fehlt/);
  assert.equal(state.scans.length, 0);
  assert.equal((await fetch(`${f.base}/scans/${state.job.id}.png`)).status, 404);
  await f.restart(); assert.equal((await f.state()).scans.length, 0);
});

for (const [preset, dpi, period, gain] of [['fast', 300, '1400', '49'], ['fast600', 600, '2800', '47']])
test(`fast ${dpi} dpi preset persists, uses tested timing and returns to conservative 600 dpi`, async t => {
  const f = await fixture(t);
  assert.equal((await f.post('/api/preset?preset=invalid')).status, 400);
  assert.equal((await f.post(`/api/preset?preset=${preset}`)).status, 200);
  await f.restart();
  assert.deepEqual((await f.state()).settings, { mode: 'color', duplex: true, preset });
  assert.equal((await f.post('/api/scan')).status, 202);
  const state = await until(f.state, value => value.job?.phase === 'done');
  const read = name => JSON.parse(readFileSync(join(f.root, name)));
  assert.ok(read('scan-args.json')[1].endsWith(`/profiles/native-duplex-color${dpi}.json`));
  assert.equal(read('scan-env.json').D600_LINE_PERIOD, period);
  assert.equal(read('scan-env.json').D600_GAIN, gain);
  assert.equal(read('scan-env.json').D600_EXPOSURE, undefined, 'use separate profile RGB exposures');
  assert.equal(readFileSync(join(f.root, 'eject-period'), 'utf8'), '1000');
  assert.equal(state.scans[0].dpi, dpi);
  assert.equal(state.scans[0].pages.length, 2);
  assert.equal((await fetch(`${f.base}/scans/${state.job.id}-back.png`)).status, 200);
  assert.equal((await f.post('/api/mode?mode=gray')).status, 200);
  assert.equal((await f.state()).settings.preset, 'standard', 'unvalidated fast combinations must fall back');
  assert.equal((await f.post('/api/scan')).status, 202);
  const standard = await until(f.state, value => value.job?.phase === 'done' && value.job.id !== state.job.id);
  assert.equal(standard.scans[0].dpi, 600);
  assert.equal(read('scan-env.json').D600_LINE_PERIOD, '20000');
  assert.equal(read('scan-env.json').D600_EXPOSURE, '10000');
  assert.equal(read('scan-env.json').D600_GAIN, '0');
  assert.equal(readFileSync(join(f.root, 'eject-period'), 'utf8'), '10000');
});
