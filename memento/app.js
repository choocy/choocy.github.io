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

const state = {
  view: 'home',
  sheetOpen: false,
  loading: true,
  error: '',
  memories: [],
  selectedId: null,
  coverUrls: new Map(),
  mediaUrls: new Map(),
  localCaptures: new Map(),
  viewerItem: null,
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

async function loadMemories() {
  state.loading = true;
  state.error = '';
  render();

  try {
    const [mementos, invites, media] = await Promise.all([
      supabaseJson('mementos?select=*&order=created_at.desc'),
      supabaseJson('invite_codes?select=memento_id,code,invite_url'),
      supabaseJson('media_items?select=*&order=uploaded_at.desc'),
    ]);

    const invitesByMemento = new Map(invites.map((invite) => [invite.memento_id, invite]));
    const mediaByMemento = media.reduce((map, item) => {
      const list = map.get(item.memento_id) || [];
      list.push(item);
      map.set(item.memento_id, list);
      return map;
    }, new Map());

    state.memories = mementos.map((row) => mapMemory(row, invitesByMemento.get(row.id), mediaByMemento.get(row.id) || []));
    if (!state.selectedId && state.memories.length) state.selectedId = state.memories[0].id;
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

function mapMemory(row, invite, mediaItems) {
  const photoCount = mediaItems.filter((item) => item.media_type === 'photo').length;
  const videoCount = mediaItems.filter((item) => item.media_type === 'video').length;
  const start = parseDate(row.start_time);
  const end = parseDate(row.end_time);
  const revealTime = parseDate(row.reveal_time) || end;

  return {
    id: row.id,
    title: row.title || 'Untitled Memento',
    host: row.host_name || 'Host',
    date: formatDateTime(start),
    end: formatDateTime(end),
    dateRange: formatDateRange(start, end),
    reveal: revealLabel(row.reveal_mode, revealTime),
    style: styleName(row.photo_style),
    guests: numberValue(row.guest_limit, 0),
    joined: numberValue(row.joined_count, 0),
    shots: numberValue(row.shots_per_guest, 0),
    videos: numberValue(row.videos_per_guest, 0),
    videoLength: numberValue(row.video_duration_seconds, 0),
    coverPath: row.cover_thumbnail_path || row.cover_original_path || mediaItems[0]?.thumbnail_path || mediaItems[0]?.original_path || '',
    cover: '',
    code: invite?.code || 'Invite pending',
    inviteUrl: invite?.invite_url || '',
    media: mediaItems.filter((item) => item.original_path).map(mapMediaItem),
    moments: mediaItems.length,
    uploaded: mediaItems.length,
    photos: photoCount,
    videoUploads: videoCount,
    status: statusLabel(row.status),
  };
}

function mapMediaItem(row) {
  return {
    id: row.id,
    type: row.media_type === 'video' ? 'video' : 'photo',
    path: row.thumbnail_path || row.original_path,
    originalPath: row.original_path,
    sync: row.uploaded_at ? 'Uploaded' : 'Syncing',
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

function statusLabel(value) {
  if (value === 'waiting_for_reveal') return 'Waiting';
  if (value === 'revealed') return 'Memory';
  if (value === 'draft') return 'Draft';
  if (value === 'archived') return 'Archived';
  return 'Active';
}

function revealLabel(mode, revealTime) {
  if (mode === 'live') return 'Visible live';
  return revealTime ? `Unlocks ${formatShortDateTime(revealTime)}` : 'Unlocks when ready';
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

function formatShortDateTime(date) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function formatDateRange(start, end) {
  if (!start && !end) return 'Date not set';
  if (!start) return formatDateTime(end);
  if (!end) return formatDateTime(start);
  const startText = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(start);
  const endText = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(end);
  return `${startText}-${endText}`;
}

async function hydrateCoverImages() {
  const mediaPaths = [];

  await Promise.all(state.memories.map(async (memory) => {
    if (memory.coverPath && !state.coverUrls.has(memory.id)) {
      const url = await storageObjectUrl(memory.coverPath);
    if (url) {
      state.coverUrls.set(memory.id, url);
      memory.cover = url;
    }
    }
    memory.media.forEach((item) => {
      mediaPaths.push(item.path, item.originalPath);
    });
  }));

  await Promise.all(mediaPaths.map((path) => storageObjectUrl(path)));
  render();
}

async function storageObjectUrl(path) {
  if (state.mediaUrls.has(path)) return state.mediaUrls.get(path);
  const normalized = path.split('/').map(encodeURIComponent).join('/');
  const response = await fetch(`${supabase.url}/storage/v1/object/${supabase.originalsBucket}/${normalized}`, { headers: headers() });
  if (!response.ok) {
    state.mediaUrls.set(path, '');
    return '';
  }
  const url = URL.createObjectURL(await response.blob());
  state.mediaUrls.set(path, url);
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
  state.sheetOpen = false;
  state.viewerItem = null;
  render();
  if (next === 'camera') startCamera();
}

function topbar() {
  return `
    <header class="topbar">
      <button class="brand" data-view="home" aria-label="Memento home">Memento</button>
      <nav>
        <button class="ghost" data-reload>Refresh</button>
      </nav>
    </header>`;
}

function home() {
  if (state.loading) return quietState('Loading Mementos', 'Fetching your saved events from Supabase.');
  if (state.error) return quietState('Could not load', state.error, true);
  if (!state.memories.length) return emptyState();

  return `
    <section class="page grid-page">
      <div class="title-block"><p>My Memories</p><h1>Memento</h1></div>
      <div class="memory-grid">
        ${state.memories.map(memoryCard).join('')}
      </div>
    </section>`;
}

function memoryCard(memory) {
  return `
    <article class="memory-card cover-card">
      <button class="image-button" data-view="detail" data-id="${memory.id}">${imageMarkup(memory)}</button>
      <div class="card-overlay">
        <span class="status">${escapeHtml(memory.status)}</span>
        <h2>${escapeHtml(memory.title)}</h2>
        <p>${escapeHtml(memory.dateRange)}</p>
        <div class="stats">
          <span>${memory.joined} joined</span><span>${Math.max(memory.guests - memory.joined, 0)} spots left</span><span>${memory.moments} moments</span><span>${memory.uploaded} uploaded</span>
        </div>
        <div class="actions"><button class="ghost light-ghost" data-sheet data-id="${memory.id}">Invite</button>${cameraSupported() ? `<button class="ink light-ink" data-view="camera" data-id="${memory.id}">Camera</button>` : ''}</div>
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
      <p class="kicker">My Memories</p>
      <h1>Memento</h1>
      <p>No Supabase memories yet. Create one from the iPhone app, then refresh this page.</p>
      <button class="ink" data-reload>Refresh</button>
    </section>`;
}

function intro() {
  return `
    <section class="page intro">
      <div>
        <p class="kicker">A quiet room for shared photos</p>
        <h1>Make the night easy to remember, without making it loud.</h1>
        <p>Memento gives your guests a simple camera, a clean invite, and a reveal moment you control.</p>
        <button class="ink" data-create>Create flow unavailable</button>
      </div>
      <img src="./assets/golden-retriever.png" alt="">
    </section>`;
}

function create() {
  return `
    <section class="page wizard">
      <div class="wizard-panel readonly-panel">
        <p class="kicker">Read-only preview</p>
        <h1>Create is not connected yet.</h1>
        <p>This web page is now reading from Supabase only. Web creation and uploads will be connected after you ask for writes.</p>
        <button class="ink" data-view="home">Back to Memento</button>
      </div>
    </section>`;
}

function summary(memory) {
  return `
    <article class="summary">
      <div>
        <h2>${escapeHtml(memory.title)}</h2>
        <p>Hosted by ${escapeHtml(memory.host)}</p>
        <p>${escapeHtml(memory.dateRange)}</p>
        <p>${memory.joined} joined · ${Math.max(memory.guests - memory.joined, 0)} spots left</p>
        <p>${memory.shots} photos per guest · ${memory.videos} videos per guest</p>
        <p>${memory.videoLength} sec videos · ${escapeHtml(memory.reveal)}</p>
        <p>${escapeHtml(memory.style)}</p>
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
        <span class="release-label">${escapeHtml(memory.reveal)}</span>
      </div>
      <div class="detail-body">
        ${summary(memory)}
        <div class="actions detail-actions"><button class="ghost" data-sheet data-id="${memory.id}">Invite</button>${cameraSupported() ? `<button class="ink" data-view="camera" data-id="${memory.id}">Camera</button>` : ''}<label class="ghost">Album<input type="file" accept="image/*,video/*" hidden data-local-import></label><button class="ghost" data-view="poster" data-id="${memory.id}">Poster</button></div>
        ${gallery(memory)}
      </div>
    </section>`;
}

function gallery(memory) {
  const local = state.localCaptures.get(memory.id) || [];
  const items = [...local, ...memory.media];
  if (!items.length) return `<div class="gallery empty-gallery"><p>No uploaded moments yet.</p></div>`;
  return `<div class="gallery">${items.map(mediaTile).join('')}</div>`;
}

function mediaTile(item) {
  const url = item.localUrl || state.mediaUrls.get(item.path) || state.mediaUrls.get(item.originalPath) || '';
  if (!url) return `<div class="media-tile needs-sync"><span>Needs sync</span></div>`;
  return `
    <button class="media-tile" data-viewer="${item.id}">
      ${item.type === 'video' ? `<video preload="metadata" muted playsinline src="${url}"></video><i></i>` : `<img loading="lazy" src="${url}" alt="">`}
      <span>${escapeHtml(item.sync || 'Uploaded')}</span>
    </button>`;
}

function camera() {
  const memory = currentMemory();
  if (!memory) return emptyState();
  return `
    <section class="camera">
      <button class="close light" data-view="detail" data-id="${memory.id}">Close</button>
      <video autoplay playsinline muted></video>
      <div class="camera-label">Camera preview</div>
      <div class="camera-info"><strong>${escapeHtml(memory.title)}</strong><span>${memory.joined} joined · ${escapeHtml(memory.reveal)}</span></div>
      <div class="last-shot" hidden><img alt=""><span>Saved local</span></div>
      <div class="flash"></div>
      <div class="camera-controls">
        <button data-facing>Flip</button>
        <button class="shutter" data-shutter aria-label="Take photo"></button>
      </div>
    </section>`;
}

function poster() {
  const memory = currentMemory();
  if (!memory) return emptyState();
  return `
    <section class="page poster">
      <button class="ghost" data-view="detail" data-id="${memory.id}">Back</button>
      <article><p>You are invited to</p><h1>${escapeHtml(memory.title)}</h1><div class="qr">QR</div><strong>${escapeHtml(memory.code)}</strong><span>${escapeHtml(memory.dateRange)}</span></article>
    </section>`;
}

function inviteSheet() {
  const memory = currentMemory();
  if (!memory) return '';
  return `
    <div class="modal-backdrop" data-close-sheet>
      <aside class="invite-sheet">
        <button class="close" data-close-sheet>Close</button>
        <h2>Invite ready</h2>
        <div class="qr">QR</div>
        <strong>${escapeHtml(memory.code)}</strong>
        <p>${memory.inviteUrl ? escapeHtml(memory.inviteUrl) : 'Invite link pending'}</p>
        <div class="sheet-actions"><button data-share>Share link</button><button>Save QR</button><button data-view="poster" data-id="${memory.id}">Invite poster</button><button>Web invite</button></div>
      </aside>
    </div>`;
}

function viewer() {
  const item = findMediaItem(state.viewerItem);
  if (!item) return '';
  const url = item.localUrl || state.mediaUrls.get(item.originalPath) || state.mediaUrls.get(item.path) || '';
  if (!url) return '';
  return `
    <div class="viewer" data-close-viewer>
      <button class="close light" data-close-viewer>Close</button>
      ${item.type === 'video' ? `<video controls autoplay playsinline src="${url}"></video>` : `<img src="${url}" alt="">`}
    </div>`;
}

function findMediaItem(id) {
  if (!id) return null;
  for (const memory of state.memories) {
    const item = [...(state.localCaptures.get(memory.id) || []), ...memory.media].find((media) => media.id === id);
    if (item) return item;
  }
  return null;
}

function cameraSupported() {
  return Boolean(navigator.mediaDevices?.getUserMedia);
}

function render() {
  const app = document.getElementById('app');
  const page = state.view === 'home' ? home() : state.view === 'detail' ? detail() : state.view === 'camera' ? camera() : poster();
  app.innerHTML = topbar() + page + (state.sheetOpen ? inviteSheet() : '') + viewer();
  bind();
}

function bind() {
  document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => {
    setView(button.dataset.view, button.dataset.id);
  }));

  document.querySelectorAll('[data-create]').forEach((button) => button.addEventListener('click', () => {
    setView('create');
  }));

  document.querySelectorAll('[data-sheet]').forEach((button) => button.addEventListener('click', () => {
    if (button.dataset.id) state.selectedId = button.dataset.id;
    state.sheetOpen = true;
    render();
  }));

  document.querySelectorAll('[data-close-sheet]').forEach((item) => item.addEventListener('click', (event) => {
    if (event.target === item) {
      state.sheetOpen = false;
      render();
    }
  }));

  document.querySelectorAll('[data-close-viewer]').forEach((item) => item.addEventListener('click', (event) => {
    if (event.target === item) {
      state.viewerItem = null;
      render();
    }
  }));

  document.querySelectorAll('[data-viewer]').forEach((button) => button.addEventListener('click', () => {
    state.viewerItem = button.dataset.viewer;
    render();
  }));

  document.querySelector('[data-reload]')?.addEventListener('click', loadMemories);
  document.querySelector('[data-local-import]')?.addEventListener('change', importLocalMedia);

  document.querySelector('[data-share]')?.addEventListener('click', async () => {
    const memory = currentMemory();
    const url = memory?.inviteUrl || location.href;
    if (navigator.share) {
      navigator.share({ title: memory?.title || 'Memento', text: memory?.code || '', url }).catch(() => {});
    } else if (navigator.clipboard) {
      await navigator.clipboard.writeText(url);
    }
  });
}

function importLocalMedia(event) {
  const memory = currentMemory();
  const file = event.target.files?.[0];
  if (!memory || !file) return;
  addLocalCapture(memory.id, {
    id: crypto.randomUUID(),
    type: file.type.startsWith('video/') ? 'video' : 'photo',
    localUrl: URL.createObjectURL(file),
    sync: 'Saved local',
  });
}

function addLocalCapture(memoryId, item) {
  const list = state.localCaptures.get(memoryId) || [];
  state.localCaptures.set(memoryId, [item, ...list]);
  render();
}

function rememberLocalCapture(memoryId, item) {
  const list = state.localCaptures.get(memoryId) || [];
  state.localCaptures.set(memoryId, [item, ...list]);
}

let activeStream = null;
let facingMode = 'environment';

function startCamera() {
  const memory = currentMemory();
  const video = document.querySelector('video');
  const label = document.querySelector('.camera-label');
  if (!memory || !video || !label) return;

  let photos = Math.max(memory.shots, 0);

  openCameraStream(video, label);
  label.textContent = remainingText(photos);

  document.querySelector('[data-facing]')?.addEventListener('click', () => {
    facingMode = facingMode === 'environment' ? 'user' : 'environment';
    openCameraStream(video, label);
  });

  document.querySelector('[data-shutter]')?.addEventListener('click', (event) => {
    if (photos <= 0) return;
    const localUrl = capturePhoto(video);
    photos = Math.max(0, photos - 1);
    label.textContent = remainingText(photos);
    event.currentTarget.disabled = photos === 0;
    showLastShot(localUrl);
    rememberLocalCapture(memory.id, { id: crypto.randomUUID(), type: 'photo', localUrl, sync: 'Saved local' });
  });
}

function openCameraStream(video, label) {
  stopCamera();
  navigator.mediaDevices?.getUserMedia({ video: { facingMode }, audio: false }).then((stream) => {
    activeStream = stream;
    video.srcObject = stream;
    bindZoomIfSupported(stream);
  }).catch(() => {
    label.textContent = 'Camera permission needed';
  });
}

function stopCamera() {
  activeStream?.getTracks().forEach((track) => track.stop());
  activeStream = null;
}

function bindZoomIfSupported(stream) {
  const track = stream.getVideoTracks()[0];
  const capabilities = track?.getCapabilities?.();
  if (!capabilities?.zoom || document.querySelector('[data-zoom]')) return;
  const controls = document.querySelector('.camera-controls');
  const input = document.createElement('input');
  input.type = 'range';
  input.min = capabilities.zoom.min;
  input.max = capabilities.zoom.max;
  input.step = capabilities.zoom.step || 0.1;
  input.value = capabilities.zoom.min;
  input.dataset.zoom = 'true';
  input.ariaLabel = 'Zoom';
  input.addEventListener('input', () => track.applyConstraints({ advanced: [{ zoom: Number(input.value) }] }).catch(() => {}));
  controls.prepend(input);
}

function capturePhoto(video) {
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth || 1280;
  canvas.height = video.videoHeight || 720;
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.9);
}

function showLastShot(url) {
  const shot = document.querySelector('.last-shot');
  const flash = document.querySelector('.flash');
  if (shot) {
    shot.hidden = false;
    shot.querySelector('img').src = url;
  }
  flash?.animate([{ opacity: 0 }, { opacity: 0.55 }, { opacity: 0 }], { duration: 240 });
}

function remainingText(count) {
  return `${count} photo remaining`;
}

loadMemories();
