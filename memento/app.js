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

const FEATURES = {
  albumImport: false,
};

const routeParams = new URLSearchParams(location.search);
const routeParts = location.pathname.split('/').map(decodeURIComponent).filter(Boolean);
const explicitInvitePathIndex = routeParts.findIndex((part) => ['invite', 'join'].includes(part.toLowerCase()));
const mementoPathIndex = routeParts.findIndex((part) => part.toLowerCase() === 'memento');
const inviteFromPath = explicitInvitePathIndex >= 0
  ? routeParts[explicitInvitePathIndex + 1]
  : routeParts[mementoPathIndex + 1];
const inviteCode = (routeParams.get('invite') || routeParams.get('code') || inviteFromPath || '').trim();

const state = {
  view: inviteCode ? 'invite' : 'home',
  inviteCode,
  guest: loadGuestSession(),
  loading: true,
  error: '',
  joinError: '',
  galleryNotice: '',
  guestMenuOpen: false,
  memories: [],
  selectedId: null,
  coverUrls: new Map(),
  mediaUrls: new Map(),
  localCaptures: new Map(),
  albumOpenedAt: new Map(),
  viewer: null,
  previousViewer: null,
  viewerDirection: 0,
  reactions: new Map(),
  showCapturedBy: loadCapturedByPreference(),
  mode: 'photo',
  recording: false,
  recordingSecondsLeft: 0,
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
    await hydrateCoverImages(false);
    render();
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
    supabaseJson(`media_items?select=id,member_id,media_type,original_path,thumbnail_path,uploaded_at,captured_by_name&memento_id=eq.${encodeURIComponent(mementoId)}`),
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
    media: guestMedia.map(mapMediaItem),
    memberNames: members.map((member) => normalizeName(member.guest_name)),
    coverPath: row.cover_thumbnail_path || row.cover_original_path || '',
    cover: '',
  };
}

function mapMediaItem(row) {
  const isCurrentParticipant = state.guest?.memberId && row.member_id === state.guest.memberId;
  return {
    id: row.id,
    type: row.media_type === 'video' ? 'video' : 'photo',
    path: row.thumbnail_path || row.original_path,
    originalPath: row.original_path,
    capturedByName: row.captured_by_name || (isCurrentParticipant ? currentParticipantName() : ''),
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

function loadCapturedByPreference() {
  return localStorage.getItem('memento_show_captured_by') !== 'false';
}

function saveCapturedByPreference(value) {
  localStorage.setItem('memento_show_captured_by', value ? 'true' : 'false');
  state.showCapturedBy = value;
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

function currentParticipantName() {
  return String(state.guest?.name || '').trim();
}

async function hydrateCoverImages(renderWhenDone = true) {
  const paths = [];
  await Promise.all(state.memories.map(async (memory) => {
    if (memory.coverPath && !state.coverUrls.has(memory.id)) {
      const url = await storageObjectUrl(memory.coverPath);
      if (url) {
        state.coverUrls.set(memory.id, url);
        memory.cover = url;
      }
    }
    memory.media.forEach((item) => paths.push(item.path, item.originalPath));
  }));
  await Promise.all(paths.map((path) => storageObjectUrl(path)));
  if (renderWhenDone) render();
}

async function storageObjectUrl(path) {
  if (!path) return '';
  if (state.mediaUrls.has(path)) return state.mediaUrls.get(path);
  const normalized = path.split('/').map(encodeURIComponent).join('/');
  const signed = await fetch(`${supabase.url}/storage/v1/object/sign/${supabase.originalsBucket}/${normalized}`, {
    method: 'POST',
    headers: {
      ...headers(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expiresIn: 600 }),
  });
  if (signed.ok) {
    const data = await signed.json();
    const url = data.signedURL?.startsWith('http') ? data.signedURL : `${supabase.url}/storage/v1${data.signedURL}`;
    state.mediaUrls.set(path, url);
    return url;
  }

  const publicUrl = `${supabase.url}/storage/v1/object/public/${supabase.originalsBucket}/${normalized}`;
  state.mediaUrls.set(path, publicUrl);
  return publicUrl;
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

function mediaUrl(item) {
  return item.localUrl || state.mediaUrls.get(item.path) || state.mediaUrls.get(item.originalPath) || '';
}

function setView(next, id) {
  if (state.view === 'camera' && next !== 'camera') stopCamera();
  if (next === 'camera') enterImmersiveMode();
  state.guestMenuOpen = false;
  state.view = next;
  if (id) state.selectedId = id;
  render();
  if (next === 'camera') startCamera();
}

function enterImmersiveMode() {
  const root = document.documentElement;
  if (document.fullscreenElement || !root.requestFullscreen) return;
  root.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
}

function topbar() {
  if (['invite', 'loading'].includes(state.view)) return '';
  const showMenu = state.guest?.name && ['home', 'detail'].includes(state.view);
  return `
    <header class="topbar">
      <button class="brand" data-view="home" aria-label="Memento home">Memento</button>
      ${showMenu ? `<button class="guest-menu-button" data-guest-menu aria-label="Guest menu">${icon('menu')}</button>` : ''}
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

function invite() {
  if (state.loading) return loading();
  if (state.error) return quietState('Invite unavailable', state.error, true);
  const memory = currentMemory();
  if (!memory) return emptyState();

  return `
    <section class="invite-open">
      <div class="invite-backdrop">${imageMarkup(memory, 'invite-backdrop-image')}</div>
      <article class="invite-panel">
        <button class="invite-close" data-view="join" aria-label="Continue in browser">${icon('close')}</button>
        <div class="invite-art">
          <div class="invite-cardlet">
            <h1>You're invited!</h1>
            <p>Welcome to the private gallery. Capture the best moments today.</p>
          </div>
        </div>
        <div class="invite-copy">
          <div>
            <h2>You're invited to the album!</h2>
            <p>Capture memories to make it last forever.</p>
          </div>
          <button class="open-button" data-open-invite>Open</button>
        </div>
        <p class="invite-note">Open in the app when installed, or continue here in your browser.</p>
        <div class="powered-row">
          <span class="app-mark">*</span>
          <span><small>Powered by</small><strong>Memento</strong></span>
          <span class="store-link">App Store ></span>
        </div>
      </article>
    </section>`;
}

function loading() {
  return `
    <section class="guest-loading">
      ${appBanner()}
      <div class="loading-center">
        <span class="spinner"></span>
        <p>Loading film...</p>
      </div>
    </section>`;
}

function appBanner() {
  return `
    <aside class="app-banner">
      <span class="app-icon">*</span>
      <span><small>Powered by</small><strong>Memento</strong><em>Guest camera for your event</em></span>
      <a href="#" aria-label="Open Memento in the App Store">App Store ></a>
    </aside>`;
}

function join() {
  if (state.loading) return loading();
  if (state.error) return quietState('Invite unavailable', state.error, true);
  const memory = currentMemory();
  if (!memory) return emptyState();
  if (state.guest?.mementoId === memory.id) return detail();

  return `
    <section class="join-hero">
      ${appBanner()}
      <div class="join-bg">${imageMarkup(memory, 'join-bg-image')}</div>
      <form class="join-overlay-card" data-join-form>
        <p class="invited-by">${icon('users')} Invited by Memento</p>
        <h1>${escapeHtml(memory.title)}</h1>
        <p class="event-meta">${icon('clock')} ${escapeHtml(memory.reveal)} <span></span> ${icon('camera')} ${memory.shots} shots available</p>
        <label class="name-pill">${icon('edit')}<input name="guest_name" autocomplete="name" maxlength="40" placeholder="Enter your name" required></label>
        ${state.joinError ? `<p class="form-error">${escapeHtml(state.joinError)}</p>` : ''}
        <button class="take-camera" type="submit">Take your camera ${icon('arrow-right')}</button>
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
        <div class="actions">${cameraSupported() ? `<button class="ink light-ink" data-view="camera" data-id="${memory.id}">Camera</button>` : ''}${albumAction(memory, 'ghost light-ghost')}</div>
      </div>
    </article>`;
}

function albumAction(memory, buttonClass = 'ghost') {
  if (!FEATURES.albumImport) return '';
  return `<button class="${buttonClass}" data-open-album data-id="${memory.id}" type="button">Album</button><input class="album-input" type="file" accept="image/*,video/*" hidden data-local-import data-album-input data-id="${memory.id}">`;
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
    <div class="detail-overlay">
      <h2>${escapeHtml(memory.title)}</h2>
      <p>Starts ${escapeHtml(memory.date)}<br>Ends ${escapeHtml(memory.end)}</p>
    </div>`;
}

function detail() {
  const memory = currentMemory();
  if (!memory) return emptyState();

  return `
    <section class="page detail">
      <div class="detail-cover">
        ${imageMarkup(memory, 'hero-cover')}
        ${summary(memory)}
      </div>
      <div class="detail-body">
        <div class="actions detail-actions">${cameraSupported() ? `<button class="ink" data-view="camera" data-id="${memory.id}">Camera</button>` : ''}${albumAction(memory)}</div>
        ${state.galleryNotice ? `<p class="gallery-notice">${escapeHtml(state.galleryNotice)}</p>` : ''}
        ${guestGallery(memory)}
      </div>
      ${guestMenu()}
      ${viewer(memory)}
    </section>`;
}

function guestMenu() {
  if (!state.guestMenuOpen) return '';
  const name = currentParticipantName() || 'Guest';
  return `
    <aside class="guest-menu" role="dialog" aria-label="Guest menu">
      <p>Signed in as</p>
      <strong>${escapeHtml(name)}</strong>
    </aside>`;
}

function guestGallery(memory) {
  const local = state.localCaptures.get(memory.id) || [];
  const items = [...local, ...memory.media];
  const toggle = `
    <div class="gallery-heading">
      <h2>Gallery</h2>
      <label class="name-toggle">Names <input type="checkbox" data-captured-toggle ${state.showCapturedBy ? 'checked' : ''}></label>
    </div>`;
  if (!items.length) return `${toggle}<section class="guest-gallery empty-gallery"><p>No moments yet.</p></section>`;
  return `${toggle}<section class="guest-gallery">${items.map((item, index) => mediaTile(item, index)).join('')}</section>`;
}

function mediaTile(item, index) {
  const url = mediaUrl(item);
  const capturedBy = state.showCapturedBy && item.capturedByName
    ? `<span class="captured-pill">${escapeHtml(item.capturedByName)}</span>`
    : '';
  const media = item.type === 'video'
    ? `${item.posterUrl ? `<img src="${item.posterUrl}" loading="lazy" alt="">` : `<video src="${url}" muted playsinline preload="metadata"></video>`}<span class="play">${icon('play')}</span>`
    : `<img src="${url}" loading="lazy" alt="">`;
  return `<button class="media-tile" data-open-media="${index}" type="button">${media}${capturedBy}<small>${escapeHtml(item.sync || 'Uploaded')}</small></button>`;
}

function viewer(memory) {
  if (state.viewer == null) return '';
  const items = [...(state.localCaptures.get(memory.id) || []), ...memory.media];
  const item = items[state.viewer];
  if (!item) return '';
  const previousIndex = viewerIndex(items.length, -1);
  const nextIndex = viewerIndex(items.length, 1);
  const url = mediaUrl(item);
  const reaction = state.reactions.get(item.id) || {};
  const incomingClass = state.viewerDirection < 0 ? 'viewer-frame enter-left' : state.viewerDirection > 0 ? 'viewer-frame enter-right' : 'viewer-frame';
  const outgoingItem = state.previousViewer == null ? null : items[state.previousViewer];
  const outgoingReaction = outgoingItem ? state.reactions.get(outgoingItem.id) || {} : {};
  const outgoingClass = state.viewerDirection < 0 ? 'viewer-frame exit-right' : state.viewerDirection > 0 ? 'viewer-frame exit-left' : '';
  const outgoingMedia = outgoingItem && state.viewerDirection
    ? viewerMediaElement(outgoingItem, mediaUrl(outgoingItem), outgoingReaction, outgoingClass, false)
    : '';
  const media = `${outgoingMedia}${viewerMediaElement(item, url, reaction, incomingClass, true)}`;
  return `
    <aside class="viewer" role="dialog" aria-modal="true">
      <button class="viewer-close" data-close-viewer aria-label="Close">${icon('close')}</button>
      <button class="viewer-nav viewer-prev" data-viewer-step="-1" aria-label="Previous moment" ${previousIndex == null ? 'disabled' : ''}>${icon('chevron-left')}</button>
      <div class="viewer-media" data-viewer-swipe>${media}</div>
      <button class="viewer-nav viewer-next" data-viewer-step="1" aria-label="Next moment" ${nextIndex == null ? 'disabled' : ''}>${icon('chevron-right')}</button>
      <div class="viewer-tools">
        <button data-react="${item.id}" data-reaction="liked" class="${reaction.liked ? 'selected' : ''}" type="button">${icon('heart')} Like</button>
        <button data-react="${item.id}" data-reaction="loved" class="${reaction.loved ? 'selected' : ''}" type="button">${icon('sparkle')} Love</button>
        <label><span>${reaction.emoji || 'Emoji'}</span><input data-emoji="${item.id}" maxlength="2" inputmode="text" value="${escapeHtml(reaction.emoji || '')}"></label>
        <label class="caption-field"><span>Text</span><input data-caption="${item.id}" maxlength="80" value="${escapeHtml(reaction.caption || '')}"></label>
        <button data-filter="${item.id}" data-filter-value="" type="button">Original</button>
        <button data-filter="${item.id}" data-filter-value="viewer-warm" type="button">Warm</button>
        <button data-filter="${item.id}" data-filter-value="viewer-mono" type="button">Mono</button>
      </div>
      ${reaction.emoji || reaction.caption ? `<div class="viewer-sticker"><strong>${escapeHtml(reaction.emoji || '')}</strong><span>${escapeHtml(reaction.caption || '')}</span></div>` : ''}
    </aside>`;
}

function viewerMediaElement(item, url, reaction, className, active) {
  const classes = `${className} ${reaction.filter || ''}`.trim();
  return item.type === 'video'
    ? `<video class="${classes}" src="${url}" ${active ? 'controls autoplay' : 'muted'} playsinline></video>`
    : `<img class="${classes}" src="${url}" alt="">`;
}

function viewerIndex(total, step) {
  if (state.viewer == null || total <= 1) return null;
  const next = state.viewer + step;
  if (next < 0 || next >= total) return null;
  return next;
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
        <button class="${state.mode === 'photo' ? 'selected' : ''}" data-mode="photo" type="button">Photo</button>
        <button class="${state.mode === 'video' ? 'selected' : ''}" data-mode="video" type="button">Video</button>
      </div>
      <div class="zoom-strip" data-zoom-strip>
        <button data-zoom-choice="0.5">0.5</button>
        <button class="selected" data-zoom-choice="1">1</button>
        <button data-zoom-choice="2">2</button>
        <button data-zoom-choice="5">5</button>
      </div>
      <div class="camera-bottom">
        ${FEATURES.albumImport ? `<button class="last-shot import-tile" data-open-album data-id="${memory.id}" type="button"><img alt=""><span></span></button>` : '<div class="last-shot import-tile" aria-hidden="true"><img alt=""><span></span></div>'}
        <button class="shutter" data-shutter disabled aria-label="${state.mode === 'photo' ? 'Take photo' : 'Record video'}"></button>
        <div class="tool-stack">
          <button data-flash aria-label="Flash">${icon('flash-off')}</button>
          <button data-facing aria-label="Switch camera">${icon('flip')}</button>
        </div>
      </div>
      ${FEATURES.albumImport ? `<input type="file" accept="image/*,video/*" hidden data-local-import data-album-input data-id="${memory.id}">` : ''}
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
    'chevron-right': '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
    users: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>',
    camera: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z"/><circle cx="12" cy="13" r="3"/></svg>',
    edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 20 9-9-4-4-9 9-2 6 6-2Z"/><path d="m15 6 4 4"/></svg>',
    'arrow-right': '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>',
    menu: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/></svg>',
    'flash-off': '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m13 2-2 8h7l-7 12 2-8H6l7-12Z"/><path d="m2 2 20 20"/></svg>',
    flash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m13 2-2 8h7l-7 12 2-8H6l7-12Z"/></svg>',
    flip: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 0 0-15.5-6.2L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 15.5 6.2L21 16"/><path d="M16 16h5v5"/></svg>',
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7V5Z"/></svg>',
    heart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8Z"/></svg>',
    sparkle: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 1.9 5.9L20 11l-6.1 2.1L12 19l-1.9-5.9L4 11l6.1-2.1L12 3Z"/></svg>',
  };
  return icons[name] || '';
}

function cameraSupported() {
  return Boolean(navigator.mediaDevices?.getUserMedia);
}

function updateCameraMode() {
  document.querySelectorAll('[data-mode]').forEach((button) => {
    button.classList.toggle('selected', button.dataset.mode === state.mode);
  });
  const memory = currentMemory();
  if (!memory) return;
  const count = remainingFor(memory, state.mode);
  updateRemaining(count, state.mode, { animate: false });
  const shutter = document.querySelector('[data-shutter]');
  if (shutter) {
    shutter.disabled = count === 0 || !activeStream;
    shutter.ariaLabel = state.mode === 'photo' ? 'Take photo' : 'Record video';
    shutter.classList.toggle('video-ready', state.mode === 'video');
  }
}

function render() {
  const app = document.getElementById('app');
  const page = state.view === 'invite' ? invite() : state.view === 'loading' ? loading() : state.view === 'join' ? join() : state.view === 'home' ? home() : state.view === 'detail' ? detail() : camera();
  app.innerHTML = (state.view === 'camera' ? '' : topbar()) + page;
  bind();
  document.documentElement.classList.toggle('camera-open', state.view === 'camera');
  document.documentElement.classList.toggle('viewer-open', state.viewer != null);
}

function bind() {
  document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => {
    setView(button.dataset.view, button.dataset.id);
  }));
  document.querySelectorAll('[data-open-album]').forEach((button) => button.addEventListener('click', () => {
    if (!FEATURES.albumImport) return;
    if (button.dataset.id) state.selectedId = button.dataset.id;
    state.albumOpenedAt.set(button.dataset.id, Date.now());
    document.querySelector(`[data-album-input][data-id="${button.dataset.id}"]`)?.click();
  }));
  document.querySelector('[data-guest-menu]')?.addEventListener('click', () => {
    state.guestMenuOpen = !state.guestMenuOpen;
    render();
  });

  document.querySelector('[data-reload]')?.addEventListener('click', loadMemories);
  document.querySelectorAll('[data-local-import]').forEach((input) => input.addEventListener('change', importLocalMedia));
  document.querySelector('[data-captured-toggle]')?.addEventListener('change', (event) => {
    saveCapturedByPreference(event.currentTarget.checked);
    render();
  });
  document.querySelectorAll('[data-open-media]').forEach((button) => button.addEventListener('click', () => {
    state.viewer = Number(button.dataset.openMedia);
    state.previousViewer = null;
    state.viewerDirection = 0;
    render();
  }));
  document.querySelector('[data-close-viewer]')?.addEventListener('click', () => {
    state.viewer = null;
    state.previousViewer = null;
    state.viewerDirection = 0;
    render();
  });
  document.querySelectorAll('[data-viewer-step]').forEach((button) => button.addEventListener('click', () => {
    moveViewer(Number(button.dataset.viewerStep));
  }));
  bindViewerSwipe();
  bindViewerKeys();
  document.querySelectorAll('[data-react]').forEach((button) => button.addEventListener('click', () => {
    const current = state.reactions.get(button.dataset.react) || {};
    state.reactions.set(button.dataset.react, { ...current, [button.dataset.reaction]: !current[button.dataset.reaction] });
    render();
  }));
  document.querySelectorAll('[data-emoji]').forEach((input) => input.addEventListener('change', () => {
    const current = state.reactions.get(input.dataset.emoji) || {};
    state.reactions.set(input.dataset.emoji, { ...current, emoji: input.value.trim() });
    render();
  }));
  document.querySelectorAll('[data-caption]').forEach((input) => input.addEventListener('change', () => {
    const current = state.reactions.get(input.dataset.caption) || {};
    state.reactions.set(input.dataset.caption, { ...current, caption: input.value.trim() });
    render();
  }));
  document.querySelectorAll('[data-filter]').forEach((button) => button.addEventListener('click', () => {
    const current = state.reactions.get(button.dataset.filter) || {};
    state.reactions.set(button.dataset.filter, { ...current, filter: button.dataset.filterValue });
    render();
  }));
  document.querySelector('[data-join-form]')?.addEventListener('submit', joinMemento);
  document.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', () => {
    if (state.mode === button.dataset.mode) return;
    state.mode = button.dataset.mode;
    updateCameraMode();
  }));
  document.querySelector('[data-open-invite]')?.addEventListener('click', openInvite);

  const cameraSurface = document.querySelector('.camera');
  cameraSurface?.addEventListener('dblclick', (event) => event.preventDefault());
  cameraSurface?.addEventListener('touchend', preventFastDoubleTap, { passive: false });
  settleViewerAnimation();
}

function bindViewerSwipe() {
  const surface = document.querySelector('[data-viewer-swipe]');
  if (!surface) return;
  let startX = 0;
  let startY = 0;
  let tracking = false;
  surface.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    tracking = true;
    startX = event.clientX;
    startY = event.clientY;
  });
  surface.addEventListener('pointerup', (event) => {
    if (!tracking) return;
    tracking = false;
    const deltaX = event.clientX - startX;
    const deltaY = event.clientY - startY;
    if (Math.abs(deltaX) < 48 || Math.abs(deltaX) < Math.abs(deltaY) * 1.4) return;
    moveViewer(deltaX < 0 ? 1 : -1);
  });
  surface.addEventListener('pointercancel', () => {
    tracking = false;
  });
}

function bindViewerKeys() {
  if (state.viewer == null || window.viewerKeyBound) return;
  window.viewerKeyBound = true;
  window.addEventListener('keydown', (event) => {
    if (state.viewer == null) return;
    if (event.key === 'ArrowLeft') moveViewer(-1);
    if (event.key === 'ArrowRight') moveViewer(1);
    if (event.key === 'Escape') {
      state.viewer = null;
      state.previousViewer = null;
      state.viewerDirection = 0;
      render();
    }
  });
}

function moveViewer(step) {
  const memory = currentMemory();
  if (!memory || state.viewer == null) return;
  const items = [...(state.localCaptures.get(memory.id) || []), ...memory.media];
  const next = viewerIndex(items.length, step);
  if (next == null) return;
  state.previousViewer = state.viewer;
  state.viewerDirection = step;
  state.viewer = next;
  render();
}

function settleViewerAnimation() {
  if (!state.viewerDirection) return;
  window.clearTimeout(viewerAnimationTimer);
  viewerAnimationTimer = window.setTimeout(() => {
    state.previousViewer = null;
    state.viewerDirection = 0;
  }, 360);
}

function openInvite() {
  state.view = 'loading';
  render();
  window.location.href = `memento://invite/${encodeURIComponent(state.inviteCode)}`;
  window.setTimeout(() => {
    if (state.view === 'loading') {
      state.view = 'join';
      render();
    }
  }, 1100);
}

let lastTouchEnd = 0;

function preventFastDoubleTap(event) {
  const now = Date.now();
  if (now - lastTouchEnd <= 320) event.preventDefault();
  lastTouchEnd = now;
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
  const type = file.type.startsWith('video/') ? 'video' : 'photo';
  state.galleryNotice = '';
  if (looksLikeFreshCameraCapture(file, memory.id)) {
    state.galleryNotice = 'Please use the Memento Camera button to take new photos or videos. Album is for importing from your library.';
    state.albumOpenedAt.delete(memory.id);
    event.target.value = '';
    render();
    return;
  }
  if (looksLikeFileProviderImport(file, memory.id)) {
    state.galleryNotice = 'Please choose photos or videos from Photo Library. File providers are not supported for this Memento.';
    state.albumOpenedAt.delete(memory.id);
    event.target.value = '';
    render();
    return;
  }
  let posterUrl = '';
  if (type === 'video') {
    let duration = 0;
    try {
      duration = await videoDuration(file);
    } catch {
      state.galleryNotice = 'Could not read this video. Please choose another clip.';
      state.albumOpenedAt.delete(memory.id);
      event.target.value = '';
      render();
      return;
    }
    if (memory.videoLength > 0 && duration > memory.videoLength + 0.5) {
      state.galleryNotice = `This video is ${Math.round(duration)} seconds. This Memento allows videos up to ${memory.videoLength} seconds.`;
      state.albumOpenedAt.delete(memory.id);
      event.target.value = '';
      render();
      return;
    }
  }
  const localUrl = URL.createObjectURL(file);
  if (type === 'video') {
    posterUrl = await generateVideoPoster(localUrl).catch(() => '');
  }
  const item = addLocalCapture(memory.id, {
    id: crypto.randomUUID(),
    type,
    localUrl,
    posterUrl,
    capturedByName: currentParticipantName(),
    sync: 'Syncing',
  });
  if (state.view === 'camera') {
    showLastShot(item.localUrl, 'Syncing', type);
    updateCameraMode();
  }
  uploadCapture(memory, item, file, file.type || 'application/octet-stream').catch(() => markCapture(memory.id, item.id, 'Retry'));
  state.albumOpenedAt.delete(memory.id);
  event.target.value = '';
}

function addLocalCapture(memoryId, item) {
  const list = state.localCaptures.get(memoryId) || [];
  state.localCaptures.set(memoryId, [item, ...list]);
  if (state.view !== 'camera') render();
  return item;
}

function looksLikeFreshCameraCapture(file, memoryId) {
  const openedAt = state.albumOpenedAt.get(memoryId) || 0;
  const capturedAfterAlbumOpened = openedAt && file.lastModified >= openedAt - 5000;
  if (capturedAfterAlbumOpened) return true;

  const name = String(file.name || '').toLowerCase();
  const genericName = !name || /^image\.(jpe?g|png|heic|heif)$/.test(name) || /^video\.(mov|mp4|webm)$/.test(name);
  const agent = navigator.userAgent || '';
  const mobileSafari = /iPhone|iPad|iPod/i.test(agent) && /Safari/i.test(agent) && !/CriOS|FxiOS|EdgiOS/i.test(agent);
  const activePickerSession = openedAt && Date.now() - openedAt < 180000;

  const ageMs = Date.now() - file.lastModified;
  const recentlyModified = ageMs >= 0 && ageMs < 600000;
  if (mobileSafari && activePickerSession && recentlyModified) return true;
  if (mobileSafari && activePickerSession && genericName) return true;

  if (ageMs < 0 || ageMs > 90000) return false;
  return isMobileBrowser() && genericName;
}

function looksLikeFileProviderImport(file, memoryId) {
  const openedAt = state.albumOpenedAt.get(memoryId) || 0;
  if (!openedAt || Date.now() - openedAt > 180000) return false;
  if (!isMobileBrowser()) return false;
  const name = String(file.name || '').toLowerCase();
  if (!name) return false;
  return !looksLikePhotoLibraryName(name);
}

function looksLikePhotoLibraryName(name) {
  return /^(img|vid|pxl|dsc|dji|gopr|gh|mvimg|live|screenshot|screenrecording|rpreplay)[-_ ]?\d/i.test(name)
    || /^fullsizerender/i.test(name)
    || /^screen ?shot \d{4}/i.test(name)
    || /^screen ?recording \d{4}/i.test(name);
}

function isMobileBrowser() {
  return /Android|iPhone|iPad|iPod|CriOS|FxiOS|EdgiOS/i.test(navigator.userAgent || '') || ((navigator.platform || '') === 'MacIntel' && navigator.maxTouchPoints > 1);
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
  if (state.view === 'camera') updateCameraMode();
  if (state.view !== 'camera') render();
}

let activeStream = null;
let facingMode = 'environment';
let activeTrack = null;
let mediaRecorder = null;
let recordedChunks = [];
let flashMode = false;
let viewerAnimationTimer = null;

function startCamera() {
  const memory = currentMemory();
  const video = document.querySelector('video');
  const label = document.querySelector('.camera-label');
  if (!memory || !video || !label) return;

  openCameraStream(video, label);

  document.querySelector('[data-facing]')?.addEventListener('click', () => {
    facingMode = facingMode === 'environment' ? 'user' : 'environment';
    openCameraStream(video, label);
  });

  document.querySelector('[data-flash]')?.addEventListener('click', () => toggleFlash());

  document.querySelector('[data-shutter]')?.addEventListener('click', async (event) => {
    if (state.mode === 'video') {
      const videos = remainingFor(memory, 'video');
      if (videos <= 0) return;
      if (state.recording) {
        stopRecordingVideo();
        return;
      }
      startRecordingVideo(memory, () => {
        const remaining = remainingFor(memory, 'video');
        event.currentTarget.disabled = remaining === 0;
        updateRemaining(remaining, state.mode);
      });
      return;
    }
    let photos = remainingFor(memory, 'photo');
    if (photos <= 0) return;
    event.currentTarget.disabled = true;
    try {
      const photo = await capturePhoto(video);
      photos = Math.max(0, photos - 1);
      const item = addLocalCapture(memory.id, { id: crypto.randomUUID(), type: 'photo', localUrl: photo.localUrl, capturedByName: currentParticipantName(), sync: 'Syncing' });
      showLastShot(photo.localUrl, 'Syncing');
      updateRemaining(photos, state.mode);
      uploadCapture(memory, item, photo.blob, 'image/jpeg').catch(() => markCapture(memory.id, item.id, 'Retry'));
    } catch (error) {
      label.textContent = `Could not capture photo${error?.message ? `: ${error.message}` : ''}`;
    } finally {
      event.currentTarget.disabled = remainingFor(memory, 'photo') === 0 || !activeStream;
    }
  });
}

function openCameraStream(video, label) {
  stopCamera();
  label.textContent = 'Starting camera';
  navigator.mediaDevices?.getUserMedia({ video: { facingMode }, audio: false }).then((stream) => {
    activeStream = stream;
    activeTrack = stream.getVideoTracks()[0] || null;
    video.srcObject = stream;
    video.muted = true;
    video.setAttribute('playsinline', '');
    video.play().then(() => {
      label.textContent = 'Camera ready';
      updateCameraMode();
    }).catch(() => {
      label.textContent = 'Tap shutter when camera is ready';
      updateCameraMode();
    });
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
  await ensureCameraReady(video);
  if (activeTrack && typeof ImageCapture !== 'undefined') {
    try {
      const imageCapture = new ImageCapture(activeTrack);
      const blob = await imageCapture.takePhoto();
      return {
        blob,
        localUrl: URL.createObjectURL(blob),
      };
    } catch {
      try {
        const imageCapture = new ImageCapture(activeTrack);
        const bitmap = await imageCapture.grabFrame();
        return canvasPhotoFromSource(bitmap, bitmap.width, bitmap.height);
      } catch {
        // Canvas capture below works on browsers without ImageCapture support.
      }
    }
  }
  const settings = activeTrack?.getSettings?.() || {};
  const width = video.videoWidth || settings.width || 1280;
  const height = video.videoHeight || settings.height || 720;
  return canvasPhotoFromSource(video, width, height);
}

async function canvasPhotoFromSource(source, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas unavailable');
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => {
    if (canvas.toBlob) {
      canvas.toBlob(resolve, 'image/jpeg', 0.9);
    } else {
      resolve(dataUrlToBlob(canvas.toDataURL('image/jpeg', 0.9)));
    }
  });
  const fallbackBlob = blob || dataUrlToBlob(canvas.toDataURL('image/jpeg', 0.9));
  return {
    blob: fallbackBlob,
    localUrl: URL.createObjectURL(fallbackBlob),
  };
}

async function ensureCameraReady(video) {
  if (!activeStream || !video.srcObject) throw new Error('camera not ready');
  await video.play().catch(() => {});
  if (typeof video.requestVideoFrameCallback === 'function') {
    await Promise.race([
      new Promise((resolve) => video.requestVideoFrameCallback(resolve)),
      delay(1200),
    ]);
  }
  if (hasVideoFrame(video)) return;
  await Promise.race([
    new Promise((resolve) => {
      const done = () => {
        video.removeEventListener('loadedmetadata', done);
        video.removeEventListener('loadeddata', done);
        video.removeEventListener('canplay', done);
        video.removeEventListener('playing', done);
        resolve();
      };
      video.addEventListener('loadedmetadata', done, { once: true });
      video.addEventListener('loadeddata', done, { once: true });
      video.addEventListener('canplay', done, { once: true });
      video.addEventListener('playing', done, { once: true });
    }),
    delay(2200),
  ]);
  await video.play().catch(() => {});
  if (!hasVideoFrame(video)) throw new Error('camera frame not ready');
}

function hasVideoFrame(video) {
  const settings = activeTrack?.getSettings?.() || {};
  const hasSize = Boolean(video.videoWidth || settings.width) && Boolean(video.videoHeight || settings.height);
  return hasSize && (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA || activeTrack?.readyState === 'live');
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function dataUrlToBlob(dataUrl) {
  const [meta, data] = dataUrl.split(',');
  const mime = meta.match(/data:(.*?);/)?.[1] || 'image/jpeg';
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mime });
}

function drawCover(context, source, sourceWidth, sourceHeight, targetWidth, targetHeight) {
  const sourceRatio = sourceWidth / sourceHeight;
  const targetRatio = targetWidth / targetHeight;
  let width = sourceWidth;
  let height = sourceHeight;
  let x = 0;
  let y = 0;
  if (sourceRatio > targetRatio) {
    width = sourceHeight * targetRatio;
    x = (sourceWidth - width) / 2;
  } else {
    height = sourceWidth / targetRatio;
    y = (sourceHeight - height) / 2;
  }
  context.drawImage(source, x, y, width, height, 0, 0, targetWidth, targetHeight);
}

function startRecordingVideo(memory, onDone) {
  if (!activeStream || typeof MediaRecorder === 'undefined') {
    document.querySelector('.camera-label').textContent = 'Video is not supported here';
    return;
  }
  recordedChunks = [];
  const mimeType = supportedVideoMimeType();
  if (!mimeType) {
    document.querySelector('.camera-label').textContent = 'Video upload needs MP4 support';
    return;
  }
  mediaRecorder = new MediaRecorder(activeStream, mimeType ? { mimeType } : undefined);
  state.recording = true;
  state.recordingSecondsLeft = Math.max(memory.videoLength, 1);
  document.querySelector('.shutter')?.classList.add('recording');
  document.querySelector('.camera-label').textContent = 'Recording';
  updateRemaining(state.recordingSecondsLeft, 'recording', { animate: false });
  const timer = window.setInterval(() => {
    if (!state.recording) {
      window.clearInterval(timer);
      return;
    }
    state.recordingSecondsLeft = Math.max(0, state.recordingSecondsLeft - 1);
    updateRemaining(state.recordingSecondsLeft, 'recording');
    if (state.recordingSecondsLeft === 0) stopRecordingVideo();
  }, 1000);
  mediaRecorder.ondataavailable = (event) => {
    if (event.data.size > 0) recordedChunks.push(event.data);
  };
  mediaRecorder.onstop = async () => {
    state.recording = false;
    window.clearInterval(timer);
    document.querySelector('.shutter')?.classList.remove('recording');
    const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || 'video/webm' });
    if (!blob.size) {
      document.querySelector('.camera-label').textContent = 'Could not save video';
      updateCameraMode();
      return;
    }
    const localUrl = URL.createObjectURL(blob);
    const posterUrl = await generateVideoPoster(localUrl).catch(() => '');
    const item = addLocalCapture(memory.id, { id: crypto.randomUUID(), type: 'video', localUrl, posterUrl, capturedByName: currentParticipantName(), sync: 'Syncing' });
    showLastShot(posterUrl || localUrl, 'Syncing', 'video');
    uploadCapture(memory, item, blob, blob.type || 'video/webm').catch(() => markCapture(memory.id, item.id, 'Retry'));
    onDone();
  };
  mediaRecorder.start(1000);
}

function stopRecordingVideo() {
  if (mediaRecorder?.state === 'recording') {
    mediaRecorder.requestData?.();
    mediaRecorder.stop();
  }
}

function supportedVideoMimeType() {
  const types = ['video/mp4;codecs=h264', 'video/mp4'];
  return types.find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

async function uploadCapture(memory, item, blob, contentType) {
  if (!state.guest?.memberId) throw new Error('Missing guest member');
  const extension = contentType.includes('video') ? videoExtension(contentType) : 'jpg';
  const uploadType = item.type === 'video' ? 'video/mp4' : contentType;
  const storagePath = `mementos/${memory.id}/media/${item.id}.${extension}`;
  await uploadStorageObject(storagePath, blob, uploadType);
  await supabaseInsert('media_items?select=id', {
    memento_id: memory.id,
    member_id: state.guest.memberId,
    media_type: item.type,
    original_path: storagePath,
    captured_by_name: item.capturedByName || currentParticipantName(),
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

function videoDuration(file) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const url = URL.createObjectURL(file);
    const cleanup = () => URL.revokeObjectURL(url);
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    video.onloadedmetadata = () => {
      const duration = video.duration || 0;
      cleanup();
      resolve(duration);
    };
    video.onerror = () => {
      cleanup();
      reject(new Error('Could not read video duration'));
    };
    video.src = url;
  });
}

function generateVideoPoster(url) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    const capture = () => {
      const width = video.videoWidth || 640;
      const height = video.videoHeight || 360;
      const canvas = document.createElement('canvas');
      canvas.width = 720;
      canvas.height = 900;
      const context = canvas.getContext('2d');
      if (!context) {
        reject(new Error('Canvas unavailable'));
        return;
      }
      drawCover(context, video, width, height, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.78));
    };
    video.onloadeddata = capture;
    video.onloadedmetadata = () => {
      video.currentTime = Math.min(0.15, Math.max((video.duration || 1) / 10, 0));
    };
    video.onerror = () => reject(new Error('Could not create video thumbnail'));
    video.src = url;
  });
}

function showLastShot(url, statusText = 'Saved local', type = 'photo') {
  const shot = document.querySelector('.last-shot');
  if (shot) {
    shot.classList.add('has-capture');
    shot.classList.toggle('video-capture', type === 'video');
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

function updateRemaining(count, mode, options = {}) {
  const node = document.querySelector('[data-remaining]');
  const label = document.querySelector('[data-remaining-label]');
  if (node) node.textContent = count;
  if (label) label.textContent = remainingLabel(count, mode);
  if (options.animate === false) return;
  node?.animate([{ transform: 'translateY(14px)', opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }], { duration: 220, easing: 'ease-out' });
}

function remainingLabel(count, mode) {
  if (mode === 'recording') return count === 1 ? 'sec left' : 'sec left';
  if (mode === 'video') return count === 1 ? 'video remaining' : 'videos remaining';
  return count === 1 ? 'photo remaining' : 'photos remaining';
}

loadMemories();
