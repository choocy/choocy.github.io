const filters = {
  Original: 'none',
  'Clean Warm': 'contrast(1.03) saturate(1.08) sepia(.08) brightness(1.02)',
  'Soft Film': 'contrast(.92) saturate(.86) sepia(.13) brightness(1.04)',
  'Kodak-like': 'contrast(1.08) saturate(1.2) sepia(.16) hue-rotate(-7deg)',
  'Polaroid-like': 'contrast(.9) saturate(.78) sepia(.2) brightness(1.08)',
  Mono: 'grayscale(1) contrast(1.06)',
};

const supabase = {
  url: 'https://omtdedqgtheuutxqzoij.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9tdGRlZHFndGhldXV0eHF6b2lqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc4NDcyNzEsImV4cCI6MjEwMzQyMzI3MX0.0iIUhdbngD8iRMQjAjZNgqtsJ7_0xam6sFVx9JP5Ep0',
  originalsBucket: 'memento-originals',
};

const routeParams = new URLSearchParams(location.search);
const inviteCode = (routeParams.get('invite') || routeParams.get('code') || '').trim();

const state = {
  view: inviteCode ? 'join' : 'home',
  inviteCode,
  guest: loadGuestSession(),
  loading: true,
  error: '',
  joinError: '',
  memories: [],
  selectedId: null,
  coverUrls: new Map(),
  localCaptures: new Map(),
  mode: 'photo',
  recording: false,
};

function headers() {
  return {
    apikey: supabase.anonKey,
    Authorization: `Bearer ${supabase.anonKey}`,
  };
}

async function supabaseJson(path) {
  const response = await fetch(`${supabase.url}/rest/v1/${path}`, { headers: headers() });
  if (!response.ok) throw new Error(`Supabase ${response.status}`);
  return response.json();
}

async function supabaseRpc(functionName, body) {
  const response = await fetch(`${supabase.url}/rest/v1/rpc/${functionName}`, {
    method: 'POST',
    headers: {
      ...headers(),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Supabase RPC ${response.status}`);
  return response.json();
}

async function supabaseInsert(path, body) {
  const response = await fetch(`${supabase.url}/rest/v1/${path}`, {
    method: 'POST',
    headers: {
      ...headers(),
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Supabase insert ${response.status}`);
  return response.json();
}

async function uploadStorageObject(path, blob, contentType) {
  const normalized = path.split('/').map(encodeURIComponent).join('/');
  const response = await fetch(`${supabase.url}/storage/v1/object/${supabase.originalsBucket}/${normalized}`, {
    method: 'POST',
    headers: {
      ...headers(),
      'Content-Type': contentType,
      'x-upsert': 'false',
    },
    body: blob,
  });
  if (!response.ok) throw new Error(`Supabase storage ${response.status}`);
  return path;
}

async function loadMemories() {
  state.loading = true;
  state.error = '';
  render();

  try {
    state.memories = await fetchGuestMementos();
    if (!state.selectedId && state.memories.length) state.selectedId = state.memories[0].id;
    if (state.inviteCode && state.guest?.mementoId === state.selectedId) state.view = 'detail';
  } catch {
    state.error = 'Could not load Memento data. Please try again later.';
    state.memories = [];
    state.selectedId = null;
  } finally {
    state.loading = false;
    render();
    hydrateCoverImages();
  }
}

async function fetchGuestMementos() {
  const invite = state.inviteCode;
  if (!invite) return [];

  const inviteRows = await supabaseJson(`invite_codes?select=memento_id&is_active=eq.true&code=eq.${encodeURIComponent(invite)}&limit=1`);
  const mementoId = inviteRows[0]?.memento_id;
  if (!mementoId) return [];

  const [rows, members, media] = await Promise.all([
    supabaseJson(`mementos?select=*&id=eq.${encodeURIComponent(mementoId)}&limit=1`),
    supabaseJson(`memento_members?select=id,guest_name,role&memento_id=eq.${encodeURIComponent(mementoId)}&role=eq.guest`),
    supabaseJson(`media_items?select=id,member_id,media_type&memento_id=eq.${encodeURIComponent(mementoId)}`),
  ]);
  return rows.map((row) => mapMemory(row, members, media));
}

function mapMemory(row, members = [], media = []) {
  const start = parseDate(row.start_time);
  const end = parseDate(row.end_time);
  const revealTime = parseDate(row.reveal_time) || end;
  const guestMedia = state.guest?.memberId ? media.filter((item) => item.member_id === state.guest.memberId) : [];

  return {
    id: row.id,
    title: row.title || 'Untitled Memento',
    date: formatDateTime(start),
    end: formatDateTime(end),
    style: styleName(row.photo_style),
    shots: numberValue(row.shots_per_guest, 0),
    videos: numberValue(row.videos_per_guest, 0),
    videoLength: numberValue(row.video_duration_seconds, 0),
    reveal: revealLabel(row.reveal_mode, revealTime),
    canHostPreview: Boolean(row.host_preview_before_reveal),
    guestLimit: numberValue(row.guest_limit, 0),
    joined: members.length,
    uploadedPhotos: guestMedia.filter((item) => item.media_type === 'photo').length,
    uploadedVideos: guestMedia.filter((item) => item.media_type === 'video').length,
    memberNames: members.map((member) => normalizeName(member.guest_name)),
    coverPath: row.cover_thumbnail_path || row.cover_original_path || '',
    cover: '',
  };
}

function parseDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function numberValue(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function styleName(value) {
  if (!value) return 'Original';
  const match = Object.keys(filters).find((name) => name.toLowerCase() === String(value).toLowerCase());
  return match || 'Original';
}

function formatDateTime(date) {
  if (!date) return 'Date not set';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function revealLabel(mode, revealTime) {
  if (mode === 'live') return 'Live';
  return revealTime ? `Unlocks ${formatClock(revealTime)}` : 'Unlocks later';
}

function formatClock(date) {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function normalizeName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function loadGuestSession() {
  try {
    const raw = localStorage.getItem(`memento_guest_${stateKey()}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveGuestSession(guest) {
  localStorage.setItem(`memento_guest_${stateKey()}`, JSON.stringify(guest));
  state.guest = guest;
}

function stateKey() {
  return inviteCode || 'direct';
}

function getDeviceId() {
  const key = 'memento_guest_device_id';
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const next = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  localStorage.setItem(key, next);
  return next;
}

async function hydrateCoverImages() {
  await Promise.all(state.memories.map(async (memory) => {
    if (memory.coverPath && !state.coverUrls.has(memory.id)) {
      const url = await storageObjectUrl(memory.coverPath);
      if (url) {
        state.coverUrls.set(memory.id, url);
        memory.cover = url;
      }
    }
  }));
  render();
}

async function storageObjectUrl(path) {
  if (!path) return '';
  if (state.coverUrls.has(path)) return state.coverUrls.get(path);
  const normalized = path.split('/').map(encodeURIComponent).join('/');
  const response = await fetch(`${supabase.url}/storage/v1/object/${supabase.originalsBucket}/${normalized}`, { headers: headers() });
  if (!response.ok) {
    state.coverUrls.set(path, '');
    return '';
  }
  const url = URL.createObjectURL(await response.blob());
  state.coverUrls.set(path, url);
  return url;
}

function currentMemory() {
  return state.memories.find((memory) => memory.id === state.selectedId) || state.memories[0] || null;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  }[char]));
}

function imageMarkup(memory, className = '') {
  const filter = filters[memory.style] || filters.Original;
  if (!memory.cover) return `<div class="cover-placeholder ${className}"><span>${escapeHtml(memory.title)}</span></div>`;
  return `<img class="${className}" src="${memory.cover}" alt="" style="filter:${filter}">`;
}

function setView(next, id) {
  if (state.view === 'camera' && next !== 'camera') stopCamera();
  state.view = next;
  if (id) state.selectedId = id;
  render();
  if (next === 'camera') startCamera();
}

function topbar() {
  return `
    <header class="topbar">
      <button class="brand" data-view="home" aria-label="Memento home">Memento</button>
    </header>`;
}

function home() {
  if (state.loading) return quietState('Loading Mementos', 'Fetching this event from Supabase.');
  if (state.error) return quietState('Could not load', state.error, true);
  if (!state.memories.length) return emptyState();

  return `
    <section class="page grid-page">
      <div class="title-block"><p>Guest</p><h1>Memento</h1></div>
      <div class="memory-grid">
        ${state.memories.map(memoryCard).join('')}
      </div>
    </section>`;
}

function join() {
  if (state.loading) return quietState('Opening Memento', 'Checking this event invite.');
  if (state.error) return quietState('Invite unavailable', state.error, true);
  const memory = currentMemory();
  if (!memory) return emptyState();
  if (state.guest?.mementoId === memory.id) return detail();

  return `
    <section class="page join-page">
      <div class="join-cover">
        ${imageMarkup(memory, 'hero-cover')}
      </div>
      <form class="join-card" data-join-form>
        <p class="kicker">Guest</p>
        <h1>${escapeHtml(memory.title)}</h1>
        <p>Starts ${escapeHtml(memory.date)}</p>
        <p>Ends ${escapeHtml(memory.end)}</p>
        <label class="field-label">Your name<input name="guest_name" autocomplete="name" maxlength="40" required></label>
        ${state.joinError ? `<p class="form-error">${escapeHtml(state.joinError)}</p>` : ''}
        <button class="ink" type="submit">Join</button>
      </form>
    </section>`;
}

function memoryCard(memory) {
  return `
    <article class="memory-card cover-card">
      <button class="image-button" data-view="detail" data-id="${memory.id}">${imageMarkup(memory)}</button>
      <div class="card-overlay">
        <h2>${escapeHtml(memory.title)}</h2>
        <p>Starts ${escapeHtml(memory.date)}<br>Ends ${escapeHtml(memory.end)}</p>
        <div class="actions">${cameraSupported() ? `<button class="ink light-ink" data-view="camera" data-id="${memory.id}">Camera</button>` : ''}<label class="ghost light-ghost">Album<input type="file" accept="image/*,video/*" hidden data-local-import data-id="${memory.id}"></label></div>
      </div>
    </article>`;
}

function quietState(title, detail, retry = false) {
  return `
    <section class="page quiet-state">
      <p class="kicker">Memento</p>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(detail)}</p>
      ${retry ? '<button class="ink" data-reload>Reload</button>' : ''}
    </section>`;
}

function emptyState() {
  return `
    <section class="page quiet-state">
      <p class="kicker">Memento</p>
      <h1>Invite needed</h1>
      <p>Please open Memento from the event invite link.</p>
      <button class="ink" data-reload>Refresh</button>
    </section>`;
}

function summary(memory) {
  return `
    <article class="summary">
      <div>
        <h2>${escapeHtml(memory.title)}</h2>
        <p>Starts ${escapeHtml(memory.date)}</p>
        <p>Ends ${escapeHtml(memory.end)}</p>
      </div>
    </article>`;
}

function detail() {
  const memory = currentMemory();
  if (!memory) return emptyState();

  return `
    <section class="page detail">
      <div class="detail-cover">
        ${imageMarkup(memory, 'hero-cover')}
      </div>
      <div class="detail-body">
        ${summary(memory)}
        <div class="actions detail-actions">${cameraSupported() ? `<button class="ink" data-view="camera" data-id="${memory.id}">Camera</button>` : ''}<label class="ghost">Album<input type="file" accept="image/*,video/*" hidden data-local-import data-id="${memory.id}"></label></div>
        ${localCaptureNotice(memory)}
      </div>
    </section>`;
}

function localCaptureNotice(memory) {
  const local = state.localCaptures.get(memory.id) || [];
  if (!local.length) return '';
  return `<p class="local-note">${local.length} selected locally. Upload sync is not enabled on web yet.</p>`;
}

function camera() {
  const memory = currentMemory();
  if (!memory) return emptyState();
  const photos = remainingFor(memory, 'photo');
  const videos = remainingFor(memory, 'video');
  const currentRemaining = state.mode === 'video' ? videos : photos;
  const joined = state.guest?.mementoId === memory.id ? Math.max(memory.joined, 1) : memory.joined;
  return `
    <section class="camera">
      <video autoplay playsinline muted></video>
      <div class="camera-scrim"></div>
      <div class="camera-label">Camera preview</div>
      <div class="camera-top">
        <button class="camera-back" data-view="detail" data-id="${memory.id}" aria-label="Back">${icon('chevron-left')}</button>
        <div class="camera-title"><strong>${escapeHtml(memory.title)}</strong><span>${icon('users')} ${joined}<i></i>${icon('clock')} ${escapeHtml(memory.reveal)}</span></div>
        <div class="remaining-counter"><strong data-remaining>${currentRemaining}</strong><span data-remaining-label>${remainingLabel(currentRemaining, state.mode)}</span></div>
      </div>
      <div class="capture-mode">
        <button class="${state.mode === 'photo' ? 'selected' : ''}" data-mode="photo">Photo</button>
        <button class="${state.mode === 'video' ? 'selected' : ''}" data-mode="video">Video</button>
      </div>
      <div class="zoom-strip" data-zoom-strip>
        <button data-zoom-choice="0.5">0.5</button>
        <button class="selected" data-zoom-choice="1">1</button>
        <button data-zoom-choice="2">2</button>
        <button data-zoom-choice="5">5</button>
      </div>
      <div class="camera-bottom">
        <label class="last-shot import-tile"><img alt=""><span></span><input type="file" accept="image/*,video/*" hidden data-local-import data-id="${memory.id}"></label>
        <button class="shutter" data-shutter aria-label="${state.mode === 'photo' ? 'Take photo' : 'Record video'}"></button>
        <div class="tool-stack">
          <button data-flash aria-label="Flash">${icon('flash-off')}</button>
          <button data-facing aria-label="Switch camera">${icon('flip')}</button>
        </div>
      </div>
      <div class="flash"></div>
    </section>`;
}

function remainingFor(memory, type) {
  const local = (state.localCaptures.get(memory.id) || []).filter((item) => item.type === type && item.sync !== 'Uploaded').length;
  const uploaded = type === 'photo' ? memory.uploadedPhotos : memory.uploadedVideos;
  const limit = type === 'photo' ? memory.shots : memory.videos;
  return Math.max(limit - uploaded - local, 0);
}

function icon(name) {
  const icons = {
    'chevron-left': '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18 9 12l6-6"/></svg>',
    users: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>',
    'flash-off': '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m13 2-2 8h7l-7 12 2-8H6l7-12Z"/><path d="m2 2 20 20"/></svg>',
    flash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m13 2-2 8h7l-7 12 2-8H6l7-12Z"/></svg>',
    flip: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 0 0-15.5-6.2L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 15.5 6.2L21 16"/><path d="M16 16h5v5"/></svg>',
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7V5Z"/></svg>',
  };
  return icons[name] || '';
}

function cameraSupported() {
  return Boolean(navigator.mediaDevices?.getUserMedia);
}

function render() {
  const app = document.getElementById('app');
  const page = state.view === 'join' ? join() : state.view === 'home' ? home() : state.view === 'detail' ? detail() : camera();
  app.innerHTML = (state.view === 'camera' ? '' : topbar()) + page;
  bind();
}

function bind() {
  document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => {
    setView(button.dataset.view, button.dataset.id);
  }));

  document.querySelector('[data-reload]')?.addEventListener('click', loadMemories);
  document.querySelectorAll('[data-local-import]').forEach((input) => input.addEventListener('change', importLocalMedia));
  document.querySelector('[data-join-form]')?.addEventListener('submit', joinMemento);
  document.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', () => {
    if (state.mode === button.dataset.mode) return;
    state.mode = button.dataset.mode;
    render();
    startCamera();
  }));
}

async function joinMemento(event) {
  event.preventDefault();
  const memory = currentMemory();
  const name = new FormData(event.currentTarget).get('guest_name')?.toString().trim().replace(/\s+/g, ' ');
  if (!memory || !name) return;

  state.joinError = '';
  const normalized = normalizeName(name);
  if (memory.memberNames.includes(normalized)) {
    state.joinError = 'This name has already joined. Please use a different name.';
    render();
    return;
  }

  if (memory.guestLimit > 0 && memory.joined >= memory.guestLimit) {
    state.joinError = 'This Memento is already full.';
    render();
    return;
  }

  try {
    event.currentTarget.querySelector('button[type="submit"]').disabled = true;
    const [joined] = await supabaseRpc('join_memento_by_invite', {
      invite_code: state.inviteCode,
      guest_display_name: name,
      guest_device_id: getDeviceId(),
    });
    saveGuestSession({
      memberId: joined.member_id,
      mementoId: joined.memento_id,
      name: joined.display_name,
    });
    state.selectedId = joined.memento_id;
    await loadMemories();
    setView('detail', joined.memento_id);
  } catch {
    state.joinError = 'Could not join this Memento. Please try again.';
    render();
  }
}

async function importLocalMedia(event) {
  if (event.target.dataset.id) state.selectedId = event.target.dataset.id;
  const memory = currentMemory();
  const file = event.target.files?.[0];
  if (!memory || !file) return;
  const item = addLocalCapture(memory.id, {
    id: crypto.randomUUID(),
    type: file.type.startsWith('video/') ? 'video' : 'photo',
    localUrl: URL.createObjectURL(file),
    sync: 'Syncing',
  });
  uploadCapture(memory, item, file, file.type || 'application/octet-stream').catch(() => markCapture(memory.id, item.id, 'Retry'));
}

function addLocalCapture(memoryId, item) {
  const list = state.localCaptures.get(memoryId) || [];
  state.localCaptures.set(memoryId, [item, ...list]);
  render();
  return item;
}

function rememberLocalCapture(memoryId, item) {
  const list = state.localCaptures.get(memoryId) || [];
  state.localCaptures.set(memoryId, [item, ...list]);
}

function markCapture(memoryId, itemId, sync) {
  const list = state.localCaptures.get(memoryId) || [];
  const next = list.map((item) => item.id === itemId ? { ...item, sync } : item);
  state.localCaptures.set(memoryId, next);
  updateLastShotStatus(sync);
}

let activeStream = null;
let facingMode = 'environment';
let activeTrack = null;
let mediaRecorder = null;
let recordedChunks = [];
let flashMode = false;

function startCamera() {
  const memory = currentMemory();
  const video = document.querySelector('video');
  const label = document.querySelector('.camera-label');
  if (!memory || !video || !label) return;

  let photos = remainingFor(memory, 'photo');
  let videos = remainingFor(memory, 'video');

  openCameraStream(video, label);
  label.textContent = 'Camera ready';

  document.querySelector('[data-facing]')?.addEventListener('click', () => {
    facingMode = facingMode === 'environment' ? 'user' : 'environment';
    openCameraStream(video, label);
  });

  document.querySelector('[data-flash]')?.addEventListener('click', () => toggleFlash());

  document.querySelector('[data-shutter]')?.addEventListener('click', async (event) => {
    if (state.mode === 'video') {
      if (videos <= 0) return;
      if (state.recording) {
        stopRecordingVideo();
        return;
      }
      startRecordingVideo(memory, () => {
        videos = Math.max(0, videos - 1);
        event.currentTarget.disabled = videos === 0;
        updateRemaining(videos, state.mode);
      });
      return;
    }
    if (photos <= 0) return;
    const photo = await capturePhoto(video);
    photos = Math.max(0, photos - 1);
    event.currentTarget.disabled = photos === 0;
    const item = addLocalCapture(memory.id, { id: crypto.randomUUID(), type: 'photo', localUrl: photo.localUrl, sync: 'Syncing' });
    showLastShot(photo.localUrl, 'Syncing');
    updateRemaining(photos, state.mode);
    uploadCapture(memory, item, photo.blob, 'image/jpeg').catch(() => markCapture(memory.id, item.id, 'Retry'));
  });
}

function openCameraStream(video, label) {
  stopCamera();
  navigator.mediaDevices?.getUserMedia({ video: { facingMode }, audio: state.mode === 'video' }).then((stream) => {
    activeStream = stream;
    activeTrack = stream.getVideoTracks()[0] || null;
    video.srcObject = stream;
    bindZoomIfSupported(stream);
    bindFlashIfSupported();
  }).catch(() => {
    label.textContent = 'Camera permission needed';
  });
}

function stopCamera() {
  activeStream?.getTracks().forEach((track) => track.stop());
  activeStream = null;
  activeTrack = null;
}

function bindZoomIfSupported(stream) {
  const track = stream.getVideoTracks()[0];
  const capabilities = track?.getCapabilities?.();
  document.querySelectorAll('[data-zoom-choice]').forEach((button) => {
    const zoom = Number(button.dataset.zoomChoice);
    const supported = capabilities?.zoom && zoom >= capabilities.zoom.min && zoom <= capabilities.zoom.max;
    button.hidden = !supported;
    button.addEventListener('click', () => {
      document.querySelectorAll('[data-zoom-choice]').forEach((choice) => choice.classList.remove('selected'));
      button.classList.add('selected');
      track.applyConstraints({ advanced: [{ zoom }] }).catch(() => {});
    });
  });
}

function bindFlashIfSupported() {
  const button = document.querySelector('[data-flash]');
  const capabilities = activeTrack?.getCapabilities?.();
  if (!button) return;
  button.classList.toggle('unsupported-tool', !capabilities?.torch);
  button.title = capabilities?.torch ? 'Flash' : 'Screen flash';
}

function toggleFlash() {
  const capabilities = activeTrack?.getCapabilities?.();
  const button = document.querySelector('[data-flash]');
  if (!activeTrack || !capabilities?.torch) {
    triggerScreenFlash();
    return;
  }
  flashMode = !flashMode;
  activeTrack.applyConstraints({ advanced: [{ torch: flashMode }] }).catch(() => {});
  button?.classList.toggle('active', flashMode);
  if (button) button.innerHTML = icon(flashMode ? 'flash' : 'flash-off');
}

async function capturePhoto(video) {
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth || 1280;
  canvas.height = video.videoHeight || 720;
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
  return {
    blob,
    localUrl: URL.createObjectURL(blob),
  };
}

function startRecordingVideo(memory, onDone) {
  if (!activeStream || typeof MediaRecorder === 'undefined') {
    document.querySelector('.camera-label').textContent = 'Video is not supported here';
    return;
  }
  recordedChunks = [];
  const mimeType = supportedVideoMimeType();
  mediaRecorder = new MediaRecorder(activeStream, mimeType ? { mimeType } : undefined);
  state.recording = true;
  document.querySelector('.shutter')?.classList.add('recording');
  document.querySelector('.camera-label').textContent = 'Recording';
  mediaRecorder.ondataavailable = (event) => {
    if (event.data.size > 0) recordedChunks.push(event.data);
  };
  mediaRecorder.onstop = () => {
    state.recording = false;
    document.querySelector('.shutter')?.classList.remove('recording');
    const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || 'video/webm' });
    const localUrl = URL.createObjectURL(blob);
    const item = addLocalCapture(memory.id, { id: crypto.randomUUID(), type: 'video', localUrl, sync: 'Syncing' });
    showLastShot(localUrl, 'Syncing');
    uploadCapture(memory, item, blob, blob.type).catch(() => markCapture(memory.id, item.id, 'Retry'));
    onDone();
  };
  mediaRecorder.start();
  window.setTimeout(() => {
    if (state.recording) stopRecordingVideo();
  }, Math.max(memory.videoLength, 1) * 1000);
}

function stopRecordingVideo() {
  if (mediaRecorder?.state === 'recording') mediaRecorder.stop();
}

function supportedVideoMimeType() {
  const types = ['video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
  return types.find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

async function uploadCapture(memory, item, blob, contentType) {
  if (!state.guest?.memberId) throw new Error('Missing guest member');
  const extension = contentType.includes('video') ? videoExtension(contentType) : 'jpg';
  const storagePath = `mementos/${memory.id}/media/${item.id}.${extension}`;
  await uploadStorageObject(storagePath, blob, contentType);
  await supabaseInsert('media_items?select=id', {
    memento_id: memory.id,
    member_id: state.guest.memberId,
    media_type: item.type,
    original_path: storagePath,
    file_size_bytes: blob.size,
    duration_seconds: item.type === 'video' ? memory.videoLength : null,
    uploaded_at: new Date().toISOString(),
    approval_status: memory.canHostPreview ? 'approved' : 'pending',
  });
  if (item.type === 'photo') {
    memory.uploadedPhotos += 1;
  } else {
    memory.uploadedVideos += 1;
  }
  markCapture(memory.id, item.id, 'Uploaded');
}

function videoExtension(contentType) {
  if (contentType.includes('mp4')) return 'mp4';
  if (contentType.includes('quicktime')) return 'mov';
  return 'webm';
}

function showLastShot(url, statusText = 'Saved local') {
  const shot = document.querySelector('.last-shot');
  if (shot) {
    shot.classList.add('has-capture');
    shot.classList.toggle('video-capture', !url);
    const img = shot.querySelector('img');
    if (img && url) img.src = url;
    const status = shot.querySelector('span');
    if (status) status.textContent = statusText;
  }
  triggerScreenFlash();
}

function updateLastShotStatus(text) {
  const status = document.querySelector('.last-shot span');
  if (status) status.textContent = text;
}

function triggerScreenFlash() {
  document.querySelector('.flash')?.animate([{ opacity: 0 }, { opacity: 0.55 }, { opacity: 0 }], { duration: 240 });
}

function updateRemaining(count, mode) {
  const node = document.querySelector('[data-remaining]');
  const label = document.querySelector('[data-remaining-label]');
  if (node) node.textContent = count;
  if (label) label.textContent = remainingLabel(count, mode);
  node?.animate([{ transform: 'translateY(14px)', opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }], { duration: 220, easing: 'ease-out' });
}

function remainingLabel(count, mode) {
  if (mode === 'video') return count === 1 ? 'video remaining' : 'videos remaining';
  return count === 1 ? 'photo remaining' : 'photos remaining';
}

loadMemories();
