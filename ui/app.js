import { translate, chooseLanguage } from './i18n.mjs';
const $ = id => document.getElementById(id);
let selected = null, scanSignature = '', previousJob = null, requesting = false, lastState = null;
let language = chooseLanguage(localStorage.getItem('d600-language'), navigator.language);
let selectedSide = 'front';
const t = (message, values) => translate(language, message, values);
const locale = () => language === 'de' ? 'de-DE' : 'en-GB';
const formatDate = value => new Date(value).toLocaleString(locale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

function selectScan(scan, scans, side = 'front') {
  selected = scan.id; selectedSide = side;
  const fileId = scan.id + (scan.duplex && side === 'back' ? '-back' : '');
  $('preview').src = `/scans/${fileId}.png`;
  $('preview').hidden = false; $('empty').hidden = true;
  $('image-dimensions').textContent = `${scan.width.toLocaleString(locale())} × ${scan.height.toLocaleString(locale())} px`;
  $('preview-title').textContent = scan.reference ? t('Letzter Testscan') : scan.duplex ? (side === 'back' ? t('Rückseite') : t('Vorderseite')) : t('Dein Scan');
  $('page-picker').hidden = !scan.duplex;
  $('page-front').setAttribute('aria-pressed', String(side !== 'back'));
  $('page-back').setAttribute('aria-pressed', String(side === 'back'));
  $('scan-name').textContent = scan.reference ? t(scan.name) : t('Scan vom {date}', {date: formatDate(scan.createdAt)});
  $('scan-date').textContent = `${formatDate(scan.createdAt)} · ${scan.mode === 'color' ? t('Farbe') : t('Graustufen')}${scan.duplex ? ` · ${t('Beidseitig')}` : ''} · PNG · ${t('Originalauflösung')}`;
  for (const [id, extension] of [['download', 'png'], ['raw-download', scan.mode === 'color' ? 'ppm' : 'pgm']]) {
    $(id).href = `/scans/${fileId}.${extension}?download=1`;
    $(id).download = `d600-${fileId}.${extension}`; $(id).hidden = false;
  }
  renderHistory(scans);
}
function renderHistory(scans) {
  $('history-section').hidden = !scans.length;
  $('history').replaceChildren(...scans.map(scan => {
    const button = document.createElement('button');
    button.className = `history-item${scan.id === selected ? ' active' : ''}`;
    button.setAttribute('aria-label', scan.reference ? t('Vorherigen AprilTag-Testscan anzeigen') : t('Scan vom {date} anzeigen', {date: formatDate(scan.createdAt)}));
    button.setAttribute('aria-pressed', String(scan.id === selected));
    const img = document.createElement('img'); img.src = `/scans/${scan.id}.png`; img.alt = ''; img.loading = 'lazy';
    const label = document.createElement('span'); label.textContent = scan.reference ? t('AprilTag · Testscan') : `${formatDate(scan.createdAt)}${scan.duplex ? ` · ${t('2 Seiten')}` : ''}`;
    button.append(img, label); button.onclick = () => selectScan(scan, lastState.scans);
    return button;
  }));
}
function render(state) {
  lastState = state;
  $('connection').textContent = state.device.connected ? t('● Verbunden') : t('Nicht verbunden');
  $('connection').classList.toggle('online', state.device.connected);
  $('paper-status').textContent = t(state.device.message);
  $('paper-dot').classList.toggle('ready', state.device.connected && state.device.paper);
  $('scan').disabled = requesting || state.busy || !state.device.connected;
  $('scan-mode').disabled = requesting || state.busy;
  $('scan-sides').disabled = requesting || state.busy;
  if (!requesting) $('scan-mode').value = state.settings?.mode || 'gray';
  if (!requesting) $('scan-sides').value = state.settings?.duplex ? 'duplex' : 'simplex';
  $('mode-label').textContent = state.settings?.mode === 'color' ? t('Farbe · RGB') : t('Graustufen');
  $('color-note').hidden = state.settings?.mode !== 'color';
  $('duplex-note').hidden = !state.settings?.duplex;
  $('sides-label').textContent = state.settings?.duplex ? t('Beidseitig') : t('Einseitig');
  $('stop').disabled = !state.busy || state.job?.cancelled;
  $('scan').querySelector('span').textContent = state.busy ? t('Scan läuft …') : t('Scan starten');
  const job = state.job;
  $('job-panel').hidden = !state.busy;
  $('scan-overlay').hidden = !state.busy;
  if (job) {
    $('phase').textContent = ({ starting: t('Vorbereiten'), scanning: t('Scannen'), saving: t('Speichern'), ejecting: t('Papierausgabe') })[job.phase] || t('Abschließen');
    $('percent').textContent = job.progress === null ? t('{rows} Zeilen', {rows: (job.rows || 0).toLocaleString(locale())}) : `${job.progress} %`;
    if (job.progress === null) $('progress').removeAttribute('value');
    else $('progress').value = job.progress;
    $('message').textContent = t(job.message); $('message').classList.toggle('error', job.phase === 'error');
  }
  const signature = state.scans.map(scan => scan.id).join(',');
  if (signature !== scanSignature) {
    scanSignature = signature;
    const newest = state.scans[0];
    if (newest && (!selected || newest.id === job?.scanId)) selectScan(newest, state.scans);
    else renderHistory(state.scans);
  }
  if (job?.scanId && job.scanId !== previousJob) {
    const scan = state.scans.find(item => item.id === job.scanId);
    if (scan) { previousJob = job.scanId; selectScan(scan, state.scans); }
  }
}
async function poll() {
  try {
    const response = await fetch('/api/state', { cache: 'no-store' });
    if (!response.ok) throw new Error(t('Status nicht erreichbar'));
    render(await response.json());
  } catch {
    $('connection').textContent = t('Verbindung unterbrochen'); $('connection').classList.remove('online');
    $('scan').disabled = true; $('stop').disabled = true;
    $('paper-status').textContent = t('Die lokale Oberfläche ist nicht erreichbar. Verbindung wird erneut versucht …');
  } finally { setTimeout(poll, 700); }
}
async function command(action) {
  if (requesting) return;
  requesting = true; $('scan').disabled = true;
  if (action === 'stop') $('stop').disabled = true;
  try {
    const response = await fetch(`/api/${action}`, { method: 'POST', headers: { 'X-Scanner-UI': '1' } });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || t('Anfrage fehlgeschlagen.'));
    const state = await fetch('/api/state', { cache: 'no-store' }).then(result => result.json());
    render(state);
  } catch (error) {
    $('message').textContent = t(error.message); $('message').classList.add('error');
  } finally { requesting = false; if (lastState) $('scan').disabled = lastState.busy || !lastState.device.connected; }
}
$('scan').onclick = () => command('scan');
$('scan-mode').onchange = () => command(`mode?mode=${encodeURIComponent($('scan-mode').value)}`);
$('scan-sides').onchange = () => command(`sides?sides=${encodeURIComponent($('scan-sides').value)}`);
for (const side of ['front', 'back']) $(`page-${side}`).onclick = () => {
  const scan = lastState?.scans.find(item => item.id === selected);
  if (scan) selectScan(scan, lastState.scans, side);
};
$('stop').onclick = () => command('stop');
// Remember original text nodes/attributes so switching language never destroys markup.
const staticText = [];
const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
while (walker.nextNode()) {
  const node = walker.currentNode, text = node.textContent.trim();
  if (text) staticText.push({node, text, original: node.textContent});
}
const staticAttributes = [...document.querySelectorAll('[aria-label], [title], [alt]')].flatMap(node =>
  ['aria-label', 'title', 'alt'].filter(name => node.hasAttribute(name)).map(name => ({node, name, text: node.getAttribute(name)})));
function applyLanguage() {
  document.documentElement.lang = language;
  $('language').value = language;
  for (const {node, text, original} of staticText) if (node.isConnected) node.textContent = original.replace(text, t(text));
  for (const {node, name, text} of staticAttributes) node.setAttribute(name, t(text));
  if (lastState) {
    render(lastState);
    const scan = lastState.scans.find(item => item.id === selected);
    if (scan) selectScan(scan, lastState.scans, selectedSide);
  }
}
$('language').onchange = () => {
  language = chooseLanguage($('language').value);
  localStorage.setItem('d600-language', language);
  applyLanguage();
};
applyLanguage();
void poll();
