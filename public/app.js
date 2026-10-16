import { sendFile, receiveFile, deleteFile } from './transfer.mjs';
import { MAX_FILE_BYTES, KEY_DIGITS, cleanKey, formatKey } from './crypto.mjs';

const $ = (id) => document.getElementById(id);
const isTouch = matchMedia('(pointer: coarse)').matches;

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
const fmtClock = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const extOf = (name) => (/\.([a-z0-9]{1,5})$/i.exec(name || '') || [, 'file'])[1];

function showError(el, msg) {
  el.textContent = msg;
  el.hidden = !msg;
}

function setProgress(prefix, { stage, done, total }) {
  $(`${prefix}-progress`).hidden = false;
  const verb = prefix === 'send' ? 'Encrypting & uploading' : 'Downloading & decrypting';
  const pct = stage === 'key' ? 4 : Math.max(6, Math.round((done / total) * 100));
  $(`${prefix}-stage`).textContent = stage === 'key' ? 'Securing your key…' : verb + '…';
  $(`${prefix}-pct`).textContent = stage === 'key' ? '' : `${pct}%`;
  $(`${prefix}-bar`).style.width = `${pct}%`;
}

function fillThumb(el, file, url) {
  el.textContent = '';
  if (url && /^image\//.test(file.type)) {
    const img = new Image();
    img.src = url;
    img.alt = '';
    el.append(img);
  } else {
    el.textContent = extOf(file.name);
  }
}

// ---------------- tabs ----------------

function setTab(name) {
  const send = name === 'send';
  $('tab-send').setAttribute('aria-selected', send);
  $('tab-recv').setAttribute('aria-selected', !send);
  $('send').hidden = !send;
  $('recv').hidden = send;
  if (!send && !isTouch && !$('recv-form').hidden) $('key-in').focus();
}
$('tab-send').onclick = () => setTab('send');
$('tab-recv').onclick = () => setTab('recv');

// Tell the user up front if the server's storage isn't connected.
fetch('api/health')
  .then((r) => r.json())
  .then((h) => {
    if (h.ok) return;
    $('banner').textContent = "The server isn't ready yet (storage not connected). Try again in a few minutes.";
    $('banner').hidden = false;
  })
  .catch(() => {});

// ---------------- send ----------------

let picked = null;
let pickedUrl = null;
let sending = false;
let sent = null; // { key, id }
let countdown = null;

function pick(file) {
  showError($('send-error'), '');
  if (!file) return;
  if (file.size > MAX_FILE_BYTES) {
    showError($('send-error'), `"${file.name}" is ${fmtSize(file.size)}. The limit is 30 MB.`);
    return;
  }
  if (pickedUrl) URL.revokeObjectURL(pickedUrl);
  picked = file;
  pickedUrl = /^image\//.test(file.type) ? URL.createObjectURL(file) : null;
  fillThumb($('pick-thumb'), file, pickedUrl);
  $('pick-name').textContent = file.name;
  $('pick-size').textContent = fmtSize(file.size);
  $('drop').hidden = true;
  $('picked').hidden = false;
  $('pick-clear').hidden = false;
  $('send-btn').hidden = false;
  $('send-btn').disabled = false;
}

function resetSend() {
  clearInterval(countdown);
  if (pickedUrl) URL.revokeObjectURL(pickedUrl);
  picked = pickedUrl = sent = null;
  $('file').value = '';
  $('drop').hidden = false;
  for (const id of ['picked', 'send-btn', 'send-progress', 'sent']) $(id).hidden = true;
  showError($('send-error'), '');
}

$('file').onchange = (e) => pick(e.target.files[0]);
$('pick-clear').onclick = resetSend;

// Drag & drop anywhere on the page, and paste (Ctrl+V) on desktop.
const canPick = () => $('recv').hidden && !sending && !sent;
addEventListener('dragover', (e) => {
  if (!canPick()) return;
  e.preventDefault();
  $('drop').classList.add('over');
});
addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) $('drop').classList.remove('over');
});
addEventListener('drop', (e) => {
  $('drop').classList.remove('over');
  if (!canPick()) return;
  e.preventDefault();
  pick(e.dataTransfer.files[0]);
});
addEventListener('paste', (e) => {
  if (!canPick() || !e.clipboardData.files.length) return;
  e.preventDefault();
  pick(e.clipboardData.files[0]);
});

$('send-btn').onclick = async () => {
  if (!picked || sending) return;
  sending = true;
  $('send-btn').hidden = true;
  $('pick-clear').hidden = true;
  showError($('send-error'), '');
  try {
    const bytes = new Uint8Array(await picked.arrayBuffer());
    const result = await sendFile({
      bytes,
      name: picked.name,
      type: picked.type,
      onProgress: (p) => setProgress('send', p),
    });
    showSent(result);
  } catch (err) {
    showError($('send-error'), err.message || 'Something went wrong. Please try again.');
    $('send-btn').hidden = false;
    $('pick-clear').hidden = false;
  } finally {
    sending = false;
    $('send-progress').hidden = true;
  }
};

function showSent({ key, id, expiresIn }) {
  sent = { key, id };
  $('picked').hidden = true;
  $('sent').hidden = false;

  const out = $('key-out');
  out.className = 'key';
  out.replaceChildren(...formatKey(key).split('-').map((g) => Object.assign(document.createElement('span'), { textContent: g })));

  const link = `${location.origin}${location.pathname}#k=${key}`;
  try {
    QR.render($('qr'), link);
  } catch {
    $('qr').closest('figure').hidden = true;
  }

  $('copy-key').onclick = () => copy(formatKey(key), $('copy-key'));
  $('share-link').onclick = async () => {
    if (navigator.share) {
      try {
        await navigator.share({ title: 'File Mover', text: `Key: ${formatKey(key)}`, url: link });
      } catch {}
    } else {
      copy(link, $('share-link'), 'Link copied');
    }
  };

  const deadline = Date.now() + expiresIn;
  const tick = () => {
    const left = deadline - Date.now();
    $('countdown').textContent = fmtClock(left);
    if (left <= 0) markGone('Expired. The file has been deleted.');
  };
  clearInterval(countdown);
  countdown = setInterval(tick, 1000);
  tick();
}

function markGone(text) {
  clearInterval(countdown);
  $('key-out').classList.add('dead');
  $('timer').classList.add('dead');
  $('timer').textContent = text;
  for (const id of ['copy-key', 'share-link', 'delete-now']) $(id).disabled = true;
  $('qr').closest('figure').hidden = true;
}

$('delete-now').onclick = async () => {
  if (!sent || !confirm('Delete this file from the server now? The key will stop working.')) return;
  $('delete-now').disabled = true;
  try {
    await deleteFile({ id: sent.id });
    markGone('Deleted. The key no longer works.');
  } catch (err) {
    $('delete-now').disabled = false;
    showError($('send-error'), err.message);
  }
};

$('send-again').onclick = () => {
  for (const id of ['copy-key', 'share-link', 'delete-now']) $(id).disabled = false;
  $('timer').className = 'timer';
  $('timer').innerHTML = 'Deleted automatically in <b id="countdown">30:00</b>';
  $('qr').closest('figure').hidden = false;
  resetSend();
};

async function copy(text, btn, done = 'Copied!') {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const t = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(t);
    t.select();
    document.execCommand('copy');
    t.remove();
  }
  const label = btn.querySelector('span');
  const old = label.textContent;
  label.textContent = done;
  setTimeout(() => (label.textContent = old), 1400);
}

addEventListener('beforeunload', (e) => {
  if (sending) e.preventDefault();
});

// ---------------- receive ----------------

const keyIn = $('key-in');
let receiving = false;
let received = null; // { file, url }

keyIn.addEventListener('input', () => {
  const digits = cleanKey(keyIn.value);
  keyIn.value = formatKey(digits);
  $('recv-btn').disabled = digits.length !== KEY_DIGITS;
  showError($('recv-error'), '');
  if (digits.length === KEY_DIGITS) receive(digits); // no need to tap the button
});

$('paste-key').onclick = async () => {
  try {
    const text = await navigator.clipboard.readText();
    keyIn.value = text;
    keyIn.dispatchEvent(new Event('input'));
  } catch {
    keyIn.focus();
  }
};

$('recv-form').onsubmit = (e) => {
  e.preventDefault();
  receive(cleanKey(keyIn.value));
};

async function receive(digits) {
  if (receiving || digits.length !== KEY_DIGITS) return;
  receiving = true;
  keyIn.blur();
  $('recv-btn').disabled = true;
  showError($('recv-error'), '');
  try {
    const got = await receiveFile({ key: digits, onProgress: (p) => setProgress('recv', p) });
    let burned = true;
    await deleteFile({ id: got.id }).catch(() => (burned = false));
    showGot(got, burned);
  } catch (err) {
    showError($('recv-error'), err.message || 'Something went wrong. Please try again.');
    $('recv-btn').disabled = false;
    if (!isTouch) keyIn.select();
  } finally {
    receiving = false;
    $('recv-progress').hidden = true;
  }
}

function showGot({ name, type, bytes }, burned) {
  const file = new File([bytes], name, { type: type || 'application/octet-stream' });
  const url = URL.createObjectURL(file);
  received = { file, url };

  const preview = $('preview');
  preview.textContent = '';
  const media = /^image\//.test(type) ? 'img' : /^video\//.test(type) ? 'video' : /^audio\//.test(type) ? 'audio' : null;
  if (media) {
    const el = document.createElement(media);
    el.src = url;
    if (media !== 'img') el.controls = true;
    preview.append(el);
  }
  preview.hidden = !media;

  fillThumb($('got-thumb'), file, url);
  $('got-name').textContent = name;
  $('got-size').textContent = fmtSize(bytes.length);
  $('burn-note').textContent = burned
    ? '✓ Decrypted on this device and deleted from the server'
    : '✓ Decrypted on this device';

  const share = isTouch && navigator.canShare && navigator.canShare({ files: [file] });
  $('download-btn').hidden = !share;
  $('recv-form').hidden = true;
  $('got').hidden = false;
}

function download() {
  const a = Object.assign(document.createElement('a'), { href: received.url, download: received.file.name });
  document.body.append(a);
  a.click();
  a.remove();
}

// On phones, the share sheet offers "Save Image"/"Save to Files"; elsewhere, download.
$('save-btn').onclick = () => {
  const { file } = received;
  if (isTouch && navigator.canShare && navigator.canShare({ files: [file] })) {
    navigator.share({ files: [file] }).catch((err) => {
      if (err.name !== 'AbortError') download();
    });
  } else {
    download();
  }
};
$('download-btn').onclick = download;

$('recv-again').onclick = () => {
  if (received) URL.revokeObjectURL(received.url);
  received = null;
  $('got').hidden = true;
  $('recv-form').hidden = false;
  keyIn.value = '';
  $('recv-btn').disabled = true;
  keyIn.focus();
};

// ---------------- shared link (#k=...) ----------------
// The key lives in the URL fragment, which browsers never send to the server.
const fromLink = cleanKey((/[#&]k=([\d-]+)/.exec(location.hash) || [])[1]);
if (fromLink.length === KEY_DIGITS) {
  history.replaceState(null, '', location.pathname + location.search); // don't leave the key in the address bar
  setTab('recv');
  keyIn.value = formatKey(fromLink);
  receive(fromLink);
}
