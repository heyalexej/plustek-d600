#!/usr/bin/env node
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync,
  readdirSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pnmToPng } from './png.mjs';

const uiDirectory = dirname(fileURLToPath(import.meta.url));
export function createScannerServer({ root = resolve(uiDirectory, '..'),
  driver = join(root, 'artifacts/bin/d600-experiment'), driverArgs = [],
  scanDirectory = join(root, 'captures/ui'), pollInterval = 250 } = {}) {
  mkdirSync(scanDirectory, { recursive: true });
  const profile = join(root, 'profiles/native-gray600.json');
  const state = { device: { connected: false, paper: null, message: 'Scanner wird verbunden …' },
    job: null, scans: [], settings: { mode: 'gray', duplex: false } };
  const settingsPath = join(scanDirectory, 'settings.json');
  try {
    const saved = JSON.parse(readFileSync(settingsPath, 'utf8'));
    if (['gray', 'color'].includes(saved.mode)) state.settings.mode = saved.mode;
    if (typeof saved.duplex === 'boolean') state.settings.duplex = saved.duplex;
  } catch (error) { if (error.code !== 'ENOENT') console.error('Einstellungen:', error.message); }
  const files = new Map();
  let operation = null, child = null, probe = null, shuttingDown = false;
  let buttonArmed = false, deviceInitialized = false;

  function registerScan(scan, png, pgm, back = null) {
    files.set(scan.id, { png, [scan.mode === 'color' ? 'ppm' : 'pgm']: pgm });
    if (back) files.set(`${scan.id}-back`, back);
    state.scans = [scan, ...state.scans.filter(item => item.id !== scan.id)]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 12);
  }
  for (const file of readdirSync(scanDirectory).filter(name => /^[\da-f-]+\.json$/.test(name))) {
    try {
      const scan = JSON.parse(readFileSync(join(scanDirectory, file), 'utf8'));
      if (!/^[\da-f-]+$/.test(scan.id) || file !== `${scan.id}.json` || typeof scan.createdAt !== 'string') continue;
      const png = join(scanDirectory, `${scan.id}.png`), pgm = join(scanDirectory, `${scan.id}.${scan.mode === 'color' ? 'ppm' : 'pgm'}`);
      const back = scan.duplex ? { png: join(scanDirectory, `${scan.id}-back.png`),
        [scan.mode === 'color' ? 'ppm' : 'pgm']: join(scanDirectory, `${scan.id}-back.${scan.mode === 'color' ? 'ppm' : 'pgm'}`) } : null;
      if (existsSync(png) && existsSync(pgm) && (!back || Object.values(back).every(existsSync))) registerScan(scan, png, pgm, back);
    } catch (error) { console.error('Scan-Metadaten:', error.message); }
  }
  const referencePng = join(root, 'captures/tag-full-width-01.png');
  const referencePgm = join(root, 'captures/tag-full-width-01.pgm');
  if (existsSync(referencePng) && existsSync(referencePgm)) {
    registerScan({ id: 'reference', name: 'AprilTag · vorheriger Testscan', width: 2480, height: 3072,
      createdAt: statSync(referencePng).mtime.toISOString(), reference: true }, referencePng, referencePgm);
  }

  function run(args, { timeout = 12000, log = null, progress = null, rowProgress = null } = {}) {
    return new Promise((resolveRun, reject) => {
      if (child) return reject(new Error('Scanner ist bereits belegt.'));
      const label = `scanner:${args[0]}:${randomUUID().slice(0, 6)}`;
      console.time(label);
      const env = { ...process.env };
      for (const name of Object.keys(env)) if (name.startsWith('D600_')) delete env[name];
      Object.assign(env, { D600_LINE_PERIOD: '20000',
        D600_EXPOSURE: '10000', D600_GAIN: '0', D600_FILTER: '2', D600_SIDE: '1', D600_LAMPS: '3' });
      const processHandle = spawn(driver, [...driverArgs, ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
      child = processHandle;
      let stdout = '', stderr = '', pending = '', timedOut = false, spawnFailed = false;
      const outputLog = log ? createWriteStream(log, { flags: 'a' }) : null;
      outputLog?.on('error', error => console.error('Protokoll:', error.message));
      processHandle.stdout.on('data', bytes => {
        const text = bytes.toString(); stdout = (stdout + text).slice(-64000); outputLog?.write(text);
        pending += text;
        const lines = pending.split('\n'); pending = lines.pop();
        for (const line of lines) {
          const match = /Image bytes: (\d+)\/(\d+)/.exec(line);
          if (match && progress) progress(Math.min(100, Math.floor(Number(match[1]) / Number(match[2]) * 100)));
          const rows = /Scan rows: (\d+) end=(\d+)/.exec(line);
          if (rows && rowProgress) rowProgress(Number(rows[1]), Number(rows[2]));
        }
      });
      processHandle.stderr.on('data', bytes => {
        stderr = (stderr + bytes.toString()).slice(-16000); outputLog?.write(bytes);
      });
      // SIGTERM invokes the driver's motor/lamp cleanup. Do not SIGKILL it.
      const timer = setTimeout(() => { timedOut = true; processHandle.kill('SIGTERM'); }, timeout);
      processHandle.on('error', error => {
        spawnFailed = true;
        clearTimeout(timer); child = null; outputLog?.end(); console.timeEnd(label); reject(error);
      });
      processHandle.on('close', (code, signal) => {
        clearTimeout(timer); if (child === processHandle) child = null;
        outputLog?.end();
        if (!spawnFailed) console.timeEnd(label);
        resolveRun({ code, signal, stdout, stderr, timedOut });
      });
    });
  }

  function deviceFrom(result) {
    if (result.code !== 0) return { connected: false, paper: null,
      message: 'Scanner nicht erreichbar. USB und Stromversorgung prüfen.' };
    const match = /(?:^|\s)41=([\da-f]{2})(?:\s|$)/i.exec(result.stdout);
    if (!match) return { connected: false, paper: null, message: 'Scannerstatus konnte nicht gelesen werden.' };
    const paper = !(parseInt(match[1], 16) & 8);
    const button = /(?:^|\s)button=1(?:\s|$)/.test(result.stdout);
    const irq = /(?:^|\s)irq=([\da-f]{2})(?:\s|$)/i.exec(result.stdout);
    return { connected: true, paper, button, buttonEvent: Boolean(irq && (parseInt(irq[1], 16) & 4)),
      message: paper ? 'Papier eingelegt. Bereit zum Scannen.' : 'Bereit. Bitte Papier einlegen.' };
  }
  async function refreshDevice(initialize = false) {
    if (operation || shuttingDown) return;
    operation = 'probe';
    let startFromButton = false;
    probe = (async () => {
      try {
        if (initialize || !state.device.connected) {
          deviceInitialized = false; buttonArmed = false;
          const initialized = await run(['--init', profile]);
          if (initialized.code !== 0) { state.device = deviceFrom(initialized); return; }
        }
        state.device = deviceFrom(await run(['--status']));
        if (state.device.connected) {
          // Ignore stale events at startup/reconnect. A held button must be
          // released before another scan can start. Paper events (20) never scan.
          if (deviceInitialized && buttonArmed && state.device.paper &&
              (state.device.button || state.device.buttonEvent)) {
            buttonArmed = false; startFromButton = true;
          } else if (!state.device.button) buttonArmed = true;
          deviceInitialized = true;
        } else { buttonArmed = false; deviceInitialized = false; }
      } catch (error) {
        state.device = { connected: false, paper: null,
          message: error.code === 'ENOENT' ? 'Scannerprogramm fehlt. Bitte zuerst „make“ ausführen.' : error.message };
      } finally { operation = null; probe = null; }
    })();
    await probe;
    if (startFromButton && !operation && !shuttingDown) startScan('button');
  }

  function startScan(source = 'ui') {
    operation = 'scan'; buttonArmed = false;
    const job = { id: randomUUID(), source, mode: state.settings.mode, duplex: state.settings.duplex, phase: 'starting', progress: null, rows: 0,
      message: source === 'button' ? 'Gerätetaster erkannt. Scan wird vorbereitet …' : 'Scanner wird vorbereitet …', cancelled: false };
    state.job = job; void performScan(job); return job;
  }

  async function performScan(job) {
    const path = join(scanDirectory, job.id), log = `${path}.log`;
    const color = job.mode === 'color', rawPath = `${path}.${color ? 'ppm' : 'pgm'}`;
    const scanProfile = join(root, `profiles/native-${job.duplex ? 'duplex-' : ''}${color ? 'color' : 'gray'}600.json`);
    try {
      const result = await run(['--scan-auto', scanProfile, rawPath], { timeout: (color ? 840000 : 300000) * (job.duplex ? 2 : 1), log,
        rowProgress: (rows, end) => {
          job.rows = rows; job.progress = end ? Math.min(99, Math.floor(rows / end * 100)) : null;
          job.phase = 'scanning'; job.message = end ? 'Papierende erkannt. Rest wird gescannt …' : 'Beleg wird gescannt. Warte auf das Papierende …';
        },
        progress: value => { job.progress = value; job.phase = 'scanning'; job.message = 'Vorlage wird gescannt …'; } });
      if (job.cancelled) { job.phase = 'cancelled'; job.message = 'Scan gestoppt.'; return; }
      if (result.code !== 0) {
        if (result.stderr.includes('No paper')) throw new Error('Kein Papier erkannt. Blatt einlegen und erneut scannen.');
        if (result.stderr.includes('Expected exactly one')) throw new Error('Scanner nicht gefunden. USB und Stromversorgung prüfen.');
        if (result.timedOut) throw new Error('Der Scan hat zu lange gedauert und wurde gestoppt.');
        if (result.stderr.includes('Automatic scan limit')) throw new Error('Die maximale Scanlänge wurde vor dem Papierende erreicht. Der unvollständige Scan liegt als Rohdatei vor.');
        throw new Error('Scan fehlgeschlagen. Verbindung und Papier prüfen; das Geräteprotokoll wurde gespeichert.');
      }
      job.phase = 'saving'; job.message = 'Scan wird gespeichert …';
      const pages = [];
      for (const suffix of job.duplex ? ['', '-back'] : ['']) {
        const pagePath = `${path}${suffix}.${color ? 'ppm' : 'pgm'}`;
        if (!existsSync(pagePath)) throw new Error(suffix ? 'Duplexscan unvollständig: Die Rückseite fehlt.' : 'Das Scanbild fehlt.');
        const converted = pnmToPng(readFileSync(pagePath));
        if (converted.channels !== (color ? 3 : 1)) throw new Error('Der Scanner hat ein unerwartetes Farbformat geliefert.');
        if (pages.length && (converted.width !== pages[0].width || converted.height !== pages[0].height)) throw new Error('Die beiden Scanseiten sind unvollständig.');
        writeFileSync(`${path}${suffix}.png`, converted.png);
        pages.push({ side: suffix ? 'back' : 'front', width: converted.width, height: converted.height });
      }
      const scan = { id: job.id, name: 'Scan', mode: job.mode, duplex: job.duplex, pages, dpi: 600, createdAt: new Date().toISOString(), width: pages[0].width, height: pages[0].height };
      writeFileSync(`${path}.json`, JSON.stringify(scan, null, 2) + '\n');
      registerScan(scan, `${path}.png`, rawPath, job.duplex ? { png: `${path}-back.png`, [color ? 'ppm' : 'pgm']: `${path}-back.${color ? 'ppm' : 'pgm'}` } : null);
      job.scanId = scan.id;
      state.device = deviceFrom(await run(['--status'], { log }));
      if (job.cancelled) { job.phase = 'cancelled'; job.message = 'Scan gespeichert. Nachlauf gestoppt.'; return; }
      let message = state.device.connected ? 'Scan gespeichert. Papier ist noch im Einzug.' : 'Scan gespeichert. Scannerverbindung prüfen.';
      if (state.device.connected && !state.device.paper) {
        job.phase = 'ejecting'; job.message = 'Scan gespeichert. Papier wird ausgegeben …';
        const ejected = await run(['--eject-tail', profile], { timeout: 15000, log });
        message = ejected.code === 0 ? 'Scan fertig. Papiernachlauf abgeschlossen.' : 'Scan gespeichert. Papiernachlauf wurde nicht abgeschlossen.';
      }
      job.phase = job.cancelled ? 'cancelled' : 'done';
      job.message = job.cancelled ? 'Scan gespeichert. Nachlauf gestoppt.' : message;
      job.progress = 100;
    } catch (error) {
      job.phase = job.cancelled ? 'cancelled' : 'error'; job.message = job.cancelled ? 'Scan gestoppt.' : error.message;
      console.error('Scan:', error.message);
    } finally {
      operation = null;
      if (!shuttingDown) await refreshDevice();
    }
  }

  function json(response, code, value) {
    response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(value));
  }
  const staticFiles = new Map([['/', ['index.html', 'text/html; charset=utf-8']],
    ['/i18n.mjs', ['i18n.mjs', 'text/javascript; charset=utf-8']],
    ['/icon.svg', ['icon.svg', 'image/svg+xml']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/style.css', ['style.css', 'text/css; charset=utf-8']]]);
  const server = http.createServer(async (request, response) => {
    try {
      const address = server.address();
      const allowedHosts = [`127.0.0.1:${address.port}`, `localhost:${address.port}`];
      if (!allowedHosts.includes(request.headers.host)) return json(response, 403, { error: 'Nur lokal erreichbar.' });
      const origin = request.headers.origin;
      if ((origin && !allowedHosts.some(host => origin === `http://${host}`)) ||
          request.headers['sec-fetch-site'] === 'cross-site') return json(response, 403, { error: 'Fremder Ursprung abgelehnt.' });
      const url = new URL(request.url, `http://${request.headers.host}`);
      if (request.method === 'GET' && url.pathname === '/api/state') return json(response, 200, { ...state, busy: operation === 'scan' || operation === 'stop' });
      if (request.method === 'POST' && !['/api/scan', '/api/stop', '/api/mode', '/api/sides'].includes(url.pathname)) return json(response, 404, { error: 'Nicht gefunden.' });
      if (request.method === 'POST') {
        if (request.headers['x-scanner-ui'] !== '1') return json(response, 403, { error: 'Scan bitte über die Oberfläche starten.' });
        if (shuttingDown) return json(response, 503, { error: 'Die Oberfläche wird beendet.' });
        if (probe) await probe;
        if (url.pathname === '/api/mode' || url.pathname === '/api/sides') {
          if (operation) return json(response, 409, { error: 'Einstellungen erst nach dem Scan ändern.' });
          const settings = { ...state.settings };
          if (url.pathname === '/api/mode') {
            const mode = url.searchParams.get('mode');
            if (!['gray', 'color'].includes(mode)) return json(response, 400, { error: 'Ungültiger Farbmodus.' });
            settings.mode = mode;
          } else {
            const sides = url.searchParams.get('sides');
            if (!['simplex', 'duplex'].includes(sides)) return json(response, 400, { error: 'Ungültige Seitenauswahl.' });
            settings.duplex = sides === 'duplex';
          }
          writeFileSync(settingsPath, JSON.stringify(settings) + '\n');
          state.settings = settings;
          return json(response, 200, settings);
        }
        if (url.pathname === '/api/stop') {
          if (operation === 'scan') {
            state.job.cancelled = true; state.job.message = 'Scan wird gestoppt …';
            child?.kill('SIGTERM');
          } else if (!operation) {
            operation = 'stop';
            try { const result = await run(['--stop']); if (result.code !== 0) return json(response, 502, { error: 'Scanner konnte nicht gestoppt werden.' }); }
            finally { operation = null; }
          }
          return json(response, 202, { ok: true });
        }
        if (operation) return json(response, 409, { error: 'Es läuft bereits ein Scan.' });
        const job = startScan();
        return json(response, 202, { id: job.id });
      }
      if (request.method === 'GET' && staticFiles.has(url.pathname)) {
        const [name, type] = staticFiles.get(url.pathname);
        response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache',
          'Content-Security-Policy': "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff' });
        return response.end(readFileSync(join(uiDirectory, name)));
      }
      const match = /^\/scans\/([\da-f-]+|reference)(-back)?\.(png|pgm|ppm)$/.exec(url.pathname);
      const fileId = match && match[1] + (match[2] || '');
      if (request.method === 'GET' && match && files.get(fileId)?.[match[3]]) {
        const path = files.get(fileId)[match[3]];
        response.writeHead(200, { 'Content-Type': match[3] === 'png' ? 'image/png' : match[3] === 'ppm' ? 'image/x-portable-pixmap' : 'image/x-portable-graymap',
          'Content-Length': statSync(path).size,
          ...(url.searchParams.has('download') ? { 'Content-Disposition': `attachment; filename="d600-${fileId}.${match[3]}"` } : {}) });
        createReadStream(path).on('error', () => response.destroy()).pipe(response); return;
      }
      json(response, 404, { error: 'Nicht gefunden.' });
    } catch (error) { console.error(error); if (!response.headersSent) json(response, 500, { error: 'Die Anfrage konnte nicht verarbeitet werden.' }); else response.destroy(); }
  });
  const poller = setInterval(() => void refreshDevice(), pollInterval);
  poller.unref();
  server.on('listening', () => void refreshDevice(true));
  server.on('close', () => clearInterval(poller));
  async function shutdown() {
    shuttingDown = true; clearInterval(poller);
    if (state.job && operation === 'scan') state.job.cancelled = true;
    child?.kill('SIGTERM');
    while (child || operation) await new Promise(resolveWait => setTimeout(resolveWait, 50));
    await new Promise(resolveClose => server.close(resolveClose));
  }
  return { server, shutdown };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.time('scanner-ui-start');
  const port = Number(process.env.PORT || 8765);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT muss zwischen 1024 und 65535 liegen.');
  const app = createScannerServer();
  app.server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  app.server.listen(port, '127.0.0.1', () => {
    console.timeEnd('scanner-ui-start'); console.log(`Scanner-Oberfläche: http://127.0.0.1:${port}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.shutdown(); process.exit(0); });
}
