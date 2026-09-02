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

function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
    sessionStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable in private browsing; the URL remains the source of truth.
  }
}

const routeParams = new URLSearchParams(location.search);
const routeParts = location.pathname.split('/').map(decodeURIComponent).filter(Boolean);
const explicitInvitePathIndex = routeParts.findIndex((part) => ['invite', 'join'].includes(part.toLowerCase()));
const mementoPathIndex = routeParts.findIndex((part) => part.toLowerCase() === 'memento');
const inviteFromPath = explicitInvitePathIndex >= 0
  ? routeParts[explicitInvitePathIndex + 1]
  : routeParts[mementoPathIndex + 1];
const routeInviteCode = (routeParams.get('invite') || routeParams.get('code') || inviteFromPath || '').trim();
const routeGuestToken = (routeParams.get('guest_token') || '').trim();
const inviteCode = routeInviteCode;
if (routeInviteCode) storageSet('memento_last_invite_code', routeInviteCode);

const state = {
  view: inviteCode ? 'invite' : 'home',
  inviteCode,
  guest: loadGuestSession(),
  guestToken: routeGuestToken,
  loading: true,
  error: '',
  joinError: '',
  nameSheetOpen: false,
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
  inviteSheet: false,
  lastCaptureId: '',
  reactions: new Map(),
  showCapturedBy: loadCapturedByPreference(),
  mode: 'photo',
  recording: false,
  recordingSecondsLeft: 0,
  viewportSettled: false,
};
let revealRefreshTimer = null;
let eventRefreshTimer = null;
let gallerySyncTimer = null;
let viewportHeight = 0;
let viewportTop = 0;
let viewportSettlingView = '';

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
  if (!response.ok) throw new Error(await response.text().catch(() => `Supabase RPC ${response.status}`));
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

async function loadMemories(options = {}) {
  const previousSignature = gallerySignature();
  preserveInviteInUrl();
  state.loading = true;
  state.error = '';
  if (!options.quiet) render();

  try {
    await recoverGuestSessionFromToken();
    state.memories = await fetchGuestMementos();
    if (!state.selectedId && state.memories.length) state.selectedId = state.memories[0].id;
    if (state.inviteCode && state.guest?.mementoId === state.selectedId && ['invite', 'loading', 'home'].includes(state.view)) state.view = 'join';
  } catch {
    state.error = 'Could not load Memento data. Please try again later.';
    state.memories = [];
    state.selectedId = null;
  } finally {
    state.loading = false;
    await hydrateCoverImages(false);
    scheduleRevealRefresh();
    scheduleEventRefresh();
    scheduleGallerySync();
    if (!options.renderOnlyWhenChanged || previousSignature !== gallerySignature()) render();
  }
}

function gallerySignature() {
  return state.memories.map((memory) => [
    memory.id,
    memory.revealed,
    memory.ended,
    memory.media.map((item) => [item.id, item.path, item.originalPath, item.locked, item.sync].join(':')).join('|'),
  ].join('~')).join('||');
}

async function fetchGuestMementos() {
  const invite = state.inviteCode;
  if (!invite) return [];

  const inviteRows = await supabaseJson(`invite_codes?select=memento_id,code,invite_url&is_active=eq.true&code=eq.${encodeURIComponent(invite)}&limit=1`);
  const inviteRow = inviteRows[0];
  const mementoId = inviteRow?.memento_id;
  if (!mementoId) return [];

  const [rows, members, media] = await Promise.all([
    supabaseJson(`mementos?select=*&id=eq.${encodeURIComponent(mementoId)}&limit=1`),
    supabaseJson(`memento_members?select=id,guest_name,role,device_id,guest_return_token&memento_id=eq.${encodeURIComponent(mementoId)}`),
    supabaseJson(`media_items?select=id,member_id,media_type,original_path,thumbnail_path,taken_at,uploaded_at,created_at,captured_by_name&memento_id=eq.${encodeURIComponent(mementoId)}&order=taken_at.desc.nullslast&order=uploaded_at.desc.nullslast&order=created_at.desc.nullslast`),
  ]);
  return rows.map((row) => mapMemory(row, members, media, inviteRow));
}

function mapMemory(row, members = [], media = [], inviteRow = null) {
  const start = parseDate(row.start_time);
  const end = parseDate(row.end_time);
  const revealTime = parseDate(row.reveal_time) || end;
  const currentName = normalizeName(currentParticipantName());
  const guestMedia = currentName ? media.filter((item) => mediaCapturedByName(item) === currentName) : [];
  const revealMode = String(row.reveal_mode || '').toLowerCase();
  const revealed = revealMode === 'live' || (revealTime && Date.now() >= revealTime.getTime());
  const ended = end ? Date.now() >= end.getTime() : false;
  const sharedGallery = Boolean(row.host_preview_before_reveal);
  const visibleMedia = media.filter((item) => isMediaVisibleForMemory(item, { revealed, sharedGallery }));

  return {
    id: row.id,
    title: row.title || 'Untitled Memento',
    date: formatDateTime(start),
    dateRange: formatDateRange(start, end),
    end: formatDateTime(end),
    endTime: end,
    ended,
    style: styleName(row.photo_style),
    shots: numberValue(row.shots_per_guest, 0),
    videos: numberValue(row.videos_per_guest, 0),
    videoLength: numberValue(row.video_duration_seconds, 0),
    revealMode,
    revealTime,
    revealed,
    reveal: revealLabel(row.reveal_mode, revealTime),
    revealAtLabel: revealTime ? revealDateLabel(revealTime) : 'later',
    inviteCode: inviteRow?.code || state.inviteCode,
    inviteUrl: inviteRow?.invite_url || inviteUrl(inviteRow?.code || state.inviteCode),
    sharedGallery,
    guestLimit: numberValue(row.guest_limit, 0),
    joined: members.length,
    uploadedPhotos: visibleMedia.filter((item) => item.media_type === 'photo').length,
    uploadedVideos: visibleMedia.filter((item) => item.media_type === 'video').length,
    ownUploadedPhotos: guestMedia.filter((item) => item.media_type === 'photo').length,
    ownUploadedVideos: guestMedia.filter((item) => item.media_type === 'video').length,
    media: visibleMedia.map((item) => mapMediaItem(item, { revealed, sharedGallery, revealAtLabel: revealTime ? revealDateLabel(revealTime) : 'later' })),
    members: members.filter((member) => member.role === 'guest'),
    memberNames: members.filter((member) => member.role === 'guest').map((member) => normalizeName(member.guest_name)),
    coverPath: row.cover_thumbnail_path || row.cover_original_path || '',
    cover: '',
  };
}

function isMediaVisibleForMemory(row, memory = {}) {
  if (isOwnMedia(row)) return true;
  if (!memory.sharedGallery) return false;
  return true;
}

function mapMediaItem(row, memory = {}) {
  const isCurrentParticipant = isOwnMedia(row);
  return {
    id: row.id,
    type: row.media_type === 'video' ? 'video' : 'photo',
    path: row.thumbnail_path || '',
    originalPath: row.original_path,
    locked: memory.sharedGallery && !memory.revealed && !isCurrentParticipant,
    revealLabel: `Reveals ${memory.revealAtLabel || 'later'}`,
    capturedByName: row.captured_by_name || (isCurrentParticipant ? currentParticipantName() : ''),
    capturedAt: mediaTimestamp(row),
    sync: row.uploaded_at ? 'Uploaded' : 'Syncing',
  };
}

function isOwnMedia(row) {
  const currentName = normalizeName(currentParticipantName());
  return Boolean(currentName && mediaCapturedByName(row) === currentName);
}

function mediaCapturedByName(row) {
  return normalizeName(row.captured_by_name || row.capturedByName || '');
}

function mediaTimestamp(row) {
  const value = row.capturedAt || row.taken_at || row.uploaded_at || row.created_at || 0;
  const time = typeof value === 'number' ? value : new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
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
  const normalized = String(value).trim().toLowerCase().replace(/[_-]+/g, ' ');
  const aliases = {
    original: 'Original',
    none: 'Original',
    clean: 'Clean Warm',
    'clean warm': 'Clean Warm',
    warm: 'Clean Warm',
    film: 'Soft Film',
    'soft film': 'Soft Film',
    kodak: 'Kodak-like',
    'kodak like': 'Kodak-like',
    polaroid: 'Polaroid-like',
    'polaroid like': 'Polaroid-like',
    mono: 'Mono',
    monogram: 'Mono',
    monochrome: 'Mono',
    blackwhite: 'Mono',
    'black white': 'Mono',
  };
  if (aliases[normalized]) return aliases[normalized];
  const match = Object.keys(filters).find((name) => name.toLowerCase() === normalized);
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

function formatDateRange(start, end) {
  if (!start && !end) return 'Date not set';
  const formatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  if (!start) return formatter.format(end);
  if (!end) return formatter.format(start);
  return `${formatter.format(start)}-${formatter.format(end)}`;
}

function revealLabel(mode, revealTime) {
  if (mode === 'live') return 'Live';
  return revealTime ? `Unlocks ${formatClock(revealTime)}` : 'Unlocks later';
}

function revealDateLabel(date) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
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
  storageSet(`memento_guest_${stateKey()}`, JSON.stringify(guest));
  state.guest = guest;
  if (guest?.guestToken) state.guestToken = guest.guestToken;
  preserveInviteInUrl();
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
  const existing = localStorage.getItem(key) || sessionStorage.getItem(key);
  if (existing) {
    storageSet(key, existing);
    return existing;
  }
  const next = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  storageSet(key, next);
  return next;
}

async function recoverGuestSessionFromToken() {
  if (state.guest?.mementoId || !state.guestToken) return;
  try {
    const rows = await supabaseJson(`memento_members?select=id,memento_id,guest_name,role,guest_return_token&guest_return_token=eq.${encodeURIComponent(state.guestToken)}&limit=1`);
    const member = rows[0];
    if (!member || member.role !== 'guest') return;
    saveGuestSession({
      memberId: member.id,
      mementoId: member.memento_id,
      name: member.guest_name,
      guestToken: member.guest_return_token,
    });
    if (!state.selectedId) state.selectedId = member.memento_id;
  } catch {
    // Older Supabase schema/RLS may not expose guest_return_token yet; normal invite join still works.
  }
}

function currentParticipantName() {
  return String(state.guest?.name || '').trim();
}

async function hydrateCoverImages(renderWhenDone = true) {
  const paths = [];
  await Promise.all(state.memories.map(async (memory) => {
    if (memory.coverPath && state.coverUrls.has(memory.id)) {
      memory.cover = state.coverUrls.get(memory.id);
    } else if (memory.coverPath) {
      const url = await storageObjectUrl(memory.coverPath);
      if (url) {
        state.coverUrls.set(memory.id, url);
        memory.cover = url;
      }
    }
    memory.media.forEach((item) => {
      if (!item.locked && item.path) paths.push(item.path);
      if (!item.locked && item.originalPath) paths.push(item.originalPath);
    });
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
  if (!memory.cover) return `<div class="cover-placeholder ${className}"><span>${escapeHtml(memory.title)}</span></div>`;
  return `<img class="${className}" src="${memory.cover}" alt="">`;
}

function filterForStyle(memory) {
  return filters[memory?.style] || filters.Original;
}

function mediaUrl(item) {
  if (item.locked) return item.localUrl || state.mediaUrls.get(item.path) || '';
  return item.localUrl || state.mediaUrls.get(item.originalPath) || state.mediaUrls.get(item.path) || '';
}

function setView(next, id) {
  if (state.view === 'camera' && next !== 'camera') stopCamera();
  if (next === 'camera') {
    state.lastCaptureId = '';
    enterImmersiveMode();
  }
  state.guestMenuOpen = false;
  state.view = next;
  if (id) state.selectedId = id;
  render();
  if (next === 'camera') startCamera();
}

function preserveInviteInUrl() {
  if (!state.inviteCode) return;
  storageSet('memento_last_invite_code', state.inviteCode);
  const params = new URLSearchParams(location.search);
  let changed = false;
  if (params.get('invite') !== state.inviteCode) {
    params.set('invite', state.inviteCode);
    changed = true;
  }
  if (state.guestToken && params.get('guest_token') !== state.guestToken) {
    params.set('guest_token', state.guestToken);
    changed = true;
  }
  if (!changed) return;
  const nextUrl = `${location.pathname}?${params.toString()}${location.hash}`;
  history.replaceState(history.state, '', nextUrl);
}

function scheduleRevealRefresh() {
  window.clearTimeout(revealRefreshTimer);
  const nextReveal = state.memories
    .filter((memory) => !memory.revealed && memory.revealTime)
    .map((memory) => memory.revealTime.getTime() - Date.now())
    .filter((delayMs) => delayMs > 0)
    .sort((a, b) => a - b)[0];
  if (!nextReveal) return;
  revealRefreshTimer = window.setTimeout(() => {
    state.mediaUrls.clear();
    if (state.view !== 'camera') loadMemories();
  }, Math.min(nextReveal + 1000, 2147483647));
}

function scheduleEventRefresh() {
  window.clearTimeout(eventRefreshTimer);
  const nextEnd = state.memories
    .filter((memory) => !memory.ended && memory.endTime)
    .map((memory) => memory.endTime.getTime() - Date.now())
    .filter((delayMs) => delayMs > 0)
    .sort((a, b) => a - b)[0];
  const delay = nextEnd ? Math.min(nextEnd + 1000, 2147483647) : 60000;
  eventRefreshTimer = window.setTimeout(() => {
    if (state.view !== 'camera') {
      loadMemories();
      return;
    }
    refreshCurrentEventState();
  }, delay);
}

function scheduleGallerySync() {
  window.clearTimeout(gallerySyncTimer);
  if (!state.inviteCode || state.view !== 'detail' || state.viewer != null) return;
  gallerySyncTimer = window.setTimeout(() => {
    if (state.view === 'detail' && state.viewer == null) loadMemories({ quiet: true, renderOnlyWhenChanged: true });
  }, 7000);
}

async function refreshCurrentEventState() {
  const currentId = state.selectedId;
  await loadMemories({ quiet: true });
  if (currentId) state.selectedId = currentId;
  const memory = currentMemory();
  if (state.view === 'camera' && memory?.ended) {
    stopCamera();
    render();
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    state.mediaUrls.clear();
    if (state.view === 'camera') refreshCurrentEventState();
    else loadMemories();
  }
});

function syncViewportHeight() {
  const viewport = window.visualViewport;
  const height = Math.round(viewport?.height || window.innerHeight || document.documentElement.clientHeight || 0);
  const top = Math.round(viewport?.offsetTop || 0);
  if (!height) return;
  if (height === viewportHeight && top === viewportTop) return;
  viewportHeight = height;
  viewportTop = top;
  document.documentElement.style.setProperty('--app-height', `${height}px`);
  document.documentElement.style.setProperty('--app-top', `${top}px`);
}

function stabilizeJoinViewport() {
  syncViewportHeight();
  if (!['invite', 'loading', 'join'].includes(state.view)) return;
  if (viewportSettlingView !== state.view) {
    viewportSettlingView = state.view;
    state.viewportSettled = false;
    document.documentElement.classList.remove('viewport-settled');
    window.setTimeout(() => {
      if (viewportSettlingView !== state.view) return;
      state.viewportSettled = true;
      document.documentElement.classList.add('viewport-settled');
    }, 320);
  }
  [0, 40, 120, 280, 560, 1000, 1600, 2400].forEach((delay) => window.setTimeout(syncViewportHeight, delay));
  let frames = 0;
  const watch = () => {
    syncViewportHeight();
    frames += 1;
    if (frames < 90 && ['invite', 'loading', 'join'].includes(state.view)) requestAnimationFrame(watch);
  };
  requestAnimationFrame(watch);
}

function stabilizeCameraViewport() {
  syncViewportHeight();
  if (state.view !== 'camera') return;
  [0, 40, 120, 280, 560, 1000, 1600].forEach((delayMs) => {
    window.setTimeout(() => {
      if (state.view !== 'camera') return;
      syncViewportHeight();
      updateCameraMode();
    }, delayMs);
  });
  let frames = 0;
  const watch = () => {
    if (state.view !== 'camera') return;
    syncViewportHeight();
    frames += 1;
    if (frames < 60) requestAnimationFrame(watch);
  };
  requestAnimationFrame(watch);
}

window.addEventListener('resize', syncViewportHeight);
window.addEventListener('orientationchange', () => {
  stabilizeJoinViewport();
  stabilizeCameraViewport();
});
window.addEventListener('pageshow', () => {
  stabilizeJoinViewport();
  stabilizeCameraViewport();
});
window.visualViewport?.addEventListener('resize', syncViewportHeight);
window.visualViewport?.addEventListener('scroll', () => {
  syncViewportHeight();
  if (state.view === 'camera') updateCameraMode();
});

function enterImmersiveMode() {
  const root = document.documentElement;
  if (document.fullscreenElement || !root.requestFullscreen) return;
  root.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
}

function topbar() {
  if (['invite', 'loading', 'join', 'camera'].includes(state.view)) return '';
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
  const returningGuest = state.guest?.mementoId === memory.id;
  const photoRemaining = remainingFor(memory, 'photo');
  const videoRemaining = remainingFor(memory, 'video');
  const available = `${photoRemaining} ${photoRemaining === 1 ? 'shot' : 'shots'}${memory.videos ? `, ${videoRemaining} ${videoRemaining === 1 ? 'video' : 'videos'}` : ''} available`;
  const ended = eventEnded(memory);
  const actionText = `Continue to event ${icon('arrow-right')}`;
  const nameSheet = state.nameSheetOpen && !returningGuest ? `
    <div class="name-sheet-backdrop" data-close-name-sheet>
      <form class="name-sheet" data-join-form>
        <button class="name-sheet-close" type="button" data-close-name-sheet aria-label="Close name entry">${icon('close')}</button>
        <label class="name-pill sheet-name-pill">${icon('edit')}<input name="guest_name" autocomplete="name" maxlength="40" placeholder="Enter your name" required autofocus></label>
        ${state.joinError ? `<p class="form-error">${escapeHtml(state.joinError)}</p>` : ''}
        <button class="take-camera" type="submit" ${ended ? 'disabled' : ''}>${ended ? 'Memento has ended' : `Take your camera ${icon('arrow-right')}`}</button>
      </form>
    </div>` : '';

  return `
    <section class="join-hero ${returningGuest ? 'returning-join' : 'name-join'}">
      ${appBanner()}
      <div class="join-bg">${imageMarkup(memory, 'join-bg-image')}</div>
      <div class="join-overlay-card ${returningGuest ? 'returning' : ''}">
        <div class="join-event-copy">
          <p class="invited-by">${icon('users')} Invited by Memento</p>
          <h1>${escapeHtml(memory.title)}</h1>
          <p class="event-meta">${icon('clock')} ${escapeHtml(eventTimeLeft(memory))} <span></span> ${icon('camera')} ${escapeHtml(available)}</p>
        </div>
        <div class="join-bottom-actions">
          ${returningGuest ? `<p class="welcome-back">${icon('check')} Welcome back, ${escapeHtml(currentParticipantName())}!</p>` : ''}
          ${!state.nameSheetOpen && state.joinError ? `<p class="form-error">${escapeHtml(state.joinError)}</p>` : ''}
          <button class="take-camera" ${returningGuest ? `type="button" data-view="detail" data-id="${memory.id}"` : 'type="button" data-open-name-sheet'} ${ended && !returningGuest ? 'disabled' : ''}>${returningGuest ? actionText : ended ? 'Memento has ended' : `Get started ${icon('arrow-right')}`}</button>
        </div>
      </div>
    </section>
    ${nameSheet}`;
}

function memoryCard(memory) {
  const actions = memory.ended ? '<p class="event-status">Memento has ended</p>' : `${cameraSupported() ? `<button class="ink light-ink" data-view="camera" data-id="${memory.id}">Camera</button>` : ''}${albumAction(memory, 'ghost light-ghost')}`;
  const spotsLeft = Math.max(memory.guestLimit - memory.joined, 0);
  const moments = memory.uploadedPhotos + memory.uploadedVideos;
  return `
    <article class="memory-card cover-card">
      <button class="image-button" data-view="detail" data-id="${memory.id}">${imageMarkup(memory)}</button>
      <div class="card-overlay">
        <div class="overlay-status"><span>${memory.ended ? 'Ended' : 'Active'}</span><span>${moments} uploaded</span></div>
        <h2>${escapeHtml(memory.title)}</h2>
        <p>${escapeHtml(memory.dateRange)}</p>
        <div class="stats">
          <span><strong>${memory.joined}</strong> joined</span>
          <span><strong>${spotsLeft}</strong> spots left</span>
          <span><strong>${moments}</strong> moments</span>
        </div>
        <div class="actions">${actions}</div>
      </div>
    </article>`;
}

function albumAction(memory, buttonClass = 'ghost') {
  if (!FEATURES.albumImport || memory.ended) return '';
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
  const spotsLeft = Math.max(memory.guestLimit - memory.joined, 0);
  const moments = memory.uploadedPhotos + memory.uploadedVideos;
  return `
    <div class="detail-overlay">
      <div class="detail-overlay-top">
        <h2>${escapeHtml(memory.title)}</h2>
        <span>${moments} uploaded</span>
      </div>
      <p class="detail-status">${memory.ended ? 'Ended' : 'Active'}</p>
      <p>${escapeHtml(memory.dateRange)}</p>
      <div class="stats">
        <span><strong>${memory.joined}</strong> joined</span>
        <span><strong>${spotsLeft}</strong> spots left</span>
        <span><strong>${moments}</strong> moments</span>
      </div>
    </div>`;
}

function detail() {
  const memory = currentMemory();
  if (!memory) return emptyState();
  const inviteAction = memory.inviteCode ? `<button class="ghost detail-action-button" data-show-invite-sheet type="button">${icon('qr')} Invite</button>` : '';
  const cameraAction = !memory.ended && cameraSupported() ? `<button class="ghost detail-action-button" data-view="camera" data-id="${memory.id}">${icon('camera')} Camera</button>` : '';
  const actions = memory.ended ? `${inviteAction}<p class="event-status">Memento has ended</p>` : `${inviteAction}${cameraAction}`;

  return `
    <section class="page detail">
      <div class="detail-cover">
        ${imageMarkup(memory, 'hero-cover')}
        ${summary(memory)}
      </div>
      <div class="detail-body">
        <div class="actions detail-actions">${actions}</div>
        ${state.galleryNotice ? `<p class="gallery-notice">${escapeHtml(state.galleryNotice)}</p>` : ''}
        ${guestGallery(memory)}
      </div>
      ${guestMenu()}
      ${inviteSheet(memory)}
      ${viewer(memory)}
    </section>`;
}

function inviteSheet(memory) {
  if (!state.inviteSheet || !memory?.inviteCode) return '';
  const code = memory.inviteCode;
  const url = memory.inviteUrl || inviteUrl(code);
  const qrSvg = qrSvgMarkup(url);
  const qrDownload = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrSvg)}`;
  return `
    <div class="sheet-backdrop" data-close-invite-sheet>
      <section class="invite-sheet" role="dialog" aria-label="Memento invite" data-sheet-panel>
        <button class="sheet-handle" data-close-invite-sheet aria-label="Close invite"></button>
        <button class="sheet-close" data-close-invite-sheet aria-label="Close invite">${icon('close')}</button>
        <h2>Hand out the cameras.</h2>
        <p>Guests scan to join. No app or account needed.</p>
        <div class="qr-card">
          <div class="qr-image">${qrSvg}</div>
          <strong>${escapeHtml(code)}</strong>
          <span>Invitation code</span>
          <small>${escapeHtml(url)}</small>
        </div>
        <div class="invite-sheet-actions">
          <button data-share-invite="${escapeHtml(url)}" type="button">${icon('link')}<span>Share link</span></button>
          <a href="${qrDownload}" download="${escapeHtml(code)}.svg">${icon('download')}<span>Save QR</span></a>
          <button type="button">${icon('grid')}<span>Invite poster</span></button>
          <a href="${escapeHtml(url)}">${icon('compass')}<span>Web invite</span></a>
        </div>
      </section>
    </div>`;
}

function inviteUrl(code = state.inviteCode) {
  return `${location.origin}/memento/?invite=${encodeURIComponent(code)}`;
}

function qrSvgMarkup(value) {
  if (typeof qrcode !== 'function') return '<div class="qr-fallback">QR</div>';
  const qr = qrcode(0, 'M');
  qr.addData(value);
  qr.make();
  return qr.createSvgTag(5, 3)
    .replace('<svg ', '<svg role="img" aria-label="Invitation QR code" ')
    .replace(/<rect/g, '<rect shape-rendering="crispEdges"');
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
  const items = galleryItems(memory);
  const momentLabel = `${items.length} ${items.length === 1 ? 'moment' : 'moments'}`;
  const toggle = `
    <div class="gallery-heading">
      <h2>Gallery</h2>
      <div class="gallery-controls"><button class="name-eye-toggle" type="button" data-captured-toggle aria-label="${state.showCapturedBy ? 'Hide names' : 'Show names'}">${icon(state.showCapturedBy ? 'eye' : 'eye-off')}</button><span class="gallery-count">${escapeHtml(momentLabel)}</span></div>
    </div>`;
  if (!items.length) return `${toggle}<section class="empty-gallery">${icon('image')}<strong>No moments yet</strong><p>Photos and videos taken here will appear in this gallery.</p></section>`;
  return `${toggle}<section class="guest-gallery">${items.map((item, index) => mediaTile(item, index, memory)).join('')}</section>`;
}

function mediaTile(item, index, memory) {
  const url = mediaUrl(item);
  const style = unlockedMediaFilter(item, memory);
  const capturedBy = !item.locked && state.showCapturedBy && item.capturedByName
    ? `<span class="captured-pill">${escapeHtml(item.capturedByName)}</span>`
    : '';
  const locked = item.locked ? `<span class="locked-label">${escapeHtml(item.revealLabel)}</span>` : '';
  const media = item.locked
    ? `<span class="locked-placeholder">${icon('lock')}</span>`
    : item.type === 'video'
    ? `${item.posterUrl ? `<img src="${item.posterUrl}" loading="lazy" alt="" style="${style}">` : `<video src="${url}" muted playsinline preload="metadata" style="${style}"></video>`}<span class="play">${icon('play')}</span>`
    : `<img src="${url}" loading="lazy" alt="" style="${style}">`;
  return `<button class="media-tile ${item.locked ? 'locked' : ''}" data-open-media="${index}" type="button">${media}${locked}${capturedBy}<small>${escapeHtml(item.sync || 'Uploaded')}</small></button>`;
}

function viewer(memory) {
  if (state.viewer == null) return '';
  const items = galleryItems(memory);
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
    ? viewerMediaElement(outgoingItem, mediaUrl(outgoingItem), outgoingReaction, outgoingClass, false, memory)
    : '';
  const media = `${outgoingMedia}${viewerMediaElement(item, url, reaction, incomingClass, true, memory)}`;
  return `
    <aside class="viewer" role="dialog" aria-modal="true">
      <button class="viewer-close" data-close-viewer aria-label="Close">${icon('close')}</button>
      <button class="viewer-nav viewer-prev" data-viewer-step="-1" aria-label="Previous moment" ${previousIndex == null ? 'disabled' : ''}>${icon('chevron-left')}</button>
      <div class="viewer-media" data-viewer-swipe>${media}</div>
      <button class="viewer-nav viewer-next" data-viewer-step="1" aria-label="Next moment" ${nextIndex == null ? 'disabled' : ''}>${icon('chevron-right')}</button>
      ${item.locked ? '' : `<div class="viewer-tools">
        <button data-react="${item.id}" data-reaction="liked" class="${reaction.liked ? 'selected' : ''}" type="button">${icon('heart')} Like</button>
        <button data-react="${item.id}" data-reaction="loved" class="${reaction.loved ? 'selected' : ''}" type="button">${icon('sparkle')} Love</button>
        <label><span>${reaction.emoji || 'Emoji'}</span><input data-emoji="${item.id}" maxlength="2" inputmode="text" value="${escapeHtml(reaction.emoji || '')}"></label>
        <label class="caption-field"><span>Text</span><input data-caption="${item.id}" maxlength="80" value="${escapeHtml(reaction.caption || '')}"></label>
        <button data-filter="${item.id}" data-filter-value="" type="button">Original</button>
        <button data-filter="${item.id}" data-filter-value="viewer-warm" type="button">Warm</button>
        <button data-filter="${item.id}" data-filter-value="viewer-mono" type="button">Mono</button>
      </div>`}
      ${!item.locked && (reaction.emoji || reaction.caption) ? `<div class="viewer-sticker"><strong>${escapeHtml(reaction.emoji || '')}</strong><span>${escapeHtml(reaction.caption || '')}</span></div>` : ''}
    </aside>`;
}

function viewerMediaElement(item, url, reaction, className, active, memory) {
  const classes = `${className} ${reaction.filter || ''}`.trim();
  const style = unlockedMediaFilter(item, memory, reaction);
  if (item.locked) {
    return `<div class="${classes} locked-viewer-placeholder">${icon('lock')}</div><span class="viewer-lock-label">${escapeHtml(item.revealLabel)}</span>`;
  }
  return item.type === 'video'
    ? `<video class="${classes}" src="${url}" ${active ? 'controls autoplay' : 'muted'} playsinline style="${style}"></video>`
    : `<img class="${classes}" src="${url}" alt="" style="${style}">`;
}

function unlockedMediaFilter(item, memory, reaction = {}) {
  if (reaction.filter) return '';
  if (!memory || item.locked) return '';
  return '';
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
  const ended = eventEnded(memory);
  return `
    <section class="camera ${ended ? 'ended' : ''}">
      <video autoplay playsinline muted ${ended ? 'hidden' : ''} style="filter:${filterForStyle(memory)}"></video>
      <div class="camera-scrim"></div>
      <div class="camera-label">${ended ? 'Memento has ended' : 'Camera preview'}</div>
      <div class="camera-top">
        <button class="camera-back" data-view="detail" data-id="${memory.id}" aria-label="Back">${icon('chevron-down')}</button>
        <div class="camera-title"><strong>${escapeHtml(memory.title)}</strong><span>${icon('users')} ${joined}<i></i>${icon('clock')} ${escapeHtml(memory.reveal)}</span></div>
        <div class="remaining-counter"><strong data-remaining>${currentRemaining}</strong><span data-remaining-label>${remainingLabel(currentRemaining, state.mode)}</span></div>
      </div>
      <div class="capture-mode" ${ended ? 'hidden' : ''}>
        <button class="${state.mode === 'photo' ? 'selected' : ''}" data-mode="photo" type="button">Photo</button>
        <button class="${state.mode === 'video' ? 'selected' : ''}" data-mode="video" type="button">Video</button>
      </div>
      <div class="zoom-strip" data-zoom-strip ${ended ? 'hidden' : ''}>
        <button data-zoom-choice="0.5">0.5</button>
        <button class="selected" data-zoom-choice="1">1</button>
        <button data-zoom-choice="2">2</button>
        <button data-zoom-choice="5">5</button>
      </div>
      <div class="camera-bottom" ${ended ? 'hidden' : ''}>
        ${FEATURES.albumImport ? `<button class="last-shot import-tile" data-open-album data-id="${memory.id}" type="button"><img alt=""><span></span></button>` : `<button class="last-shot import-tile" data-open-last-capture data-id="${memory.id}" type="button" aria-label="Open latest capture" disabled><img alt=""><span></span></button>`}
        <button class="shutter" data-shutter disabled aria-label="${state.mode === 'photo' ? 'Take photo' : 'Record video'}">${currentRemaining === 0 ? icon('lock') : ''}</button>
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
  if (eventEnded(memory)) return 0;
  const local = (state.localCaptures.get(memory.id) || []).filter((item) => item.type === type && item.sync !== 'Uploaded').length;
  const uploaded = type === 'photo' ? memory.ownUploadedPhotos : memory.ownUploadedVideos;
  const limit = type === 'photo' ? memory.shots : memory.videos;
  return Math.max(limit - uploaded - local, 0);
}

function eventEnded(memory) {
  return Boolean(memory?.ended || (memory?.endTime && Date.now() >= memory.endTime.getTime()));
}

function eventTimeLeft(memory) {
  if (eventEnded(memory)) return 'Ended';
  const endTime = memory?.endTime?.getTime?.();
  if (!endTime) return memory?.reveal || 'Time left';
  const totalMinutes = Math.max(0, Math.ceil((endTime - Date.now()) / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h left`;
  if (hours > 0) return `${hours}h ${minutes}m left`;
  return `${minutes}m left`;
}

function icon(name) {
  const icons = {
    'chevron-left': '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18 9 12l6-6"/></svg>',
    'chevron-right': '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>',
    'chevron-down': '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
    users: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>',
    camera: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z"/><circle cx="12" cy="13" r="3"/></svg>',
    image: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.5"/><path d="m21 15-5-5L5 19"/></svg>',
    eye: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>',
    'eye-off': '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.7 5.2A10.6 10.6 0 0 1 12 5c6.5 0 10 7 10 7a17.5 17.5 0 0 1-3.2 4.1"/><path d="M6.6 6.6A17.8 17.8 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 4.4-1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="M2 2l20 20"/></svg>',
    edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 20 9-9-4-4-9 9-2 6 6-2Z"/><path d="m15 6 4 4"/></svg>',
    'arrow-right': '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>',
    lock: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
    menu: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/></svg>',
    qr: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3z"/><path d="M21 14h-2"/><path d="M14 21h7v-3"/></svg>',
    link: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1"/><path d="M14 11a5 5 0 0 0-7.1 0l-2 2A5 5 0 0 0 12 20.1l1.1-1.1"/></svg>',
    download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>',
    grid: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
    compass: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m16 8-2.2 5.8L8 16l2.2-5.8L16 8Z"/></svg>',
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
    shutter.innerHTML = count === 0 ? icon('lock') : '';
    shutter.classList.toggle('video-ready', state.mode === 'video');
  }
}

function render() {
  syncViewportHeight();
  preserveInviteInUrl();
  const app = document.getElementById('app');
  const page = state.view === 'invite' ? invite() : state.view === 'loading' ? loading() : state.view === 'join' ? join() : state.view === 'home' ? home() : state.view === 'detail' ? detail() : camera();
  const memory = currentMemory();
  app.innerHTML = topbar() + page;
  bind();
  document.documentElement.classList.toggle('camera-open', state.view === 'camera');
  document.documentElement.classList.toggle('join-open', state.view === 'join');
  document.documentElement.classList.toggle('join-returning', state.view === 'join' && Boolean(memory) && state.guest?.mementoId === memory.id);
  document.documentElement.classList.toggle('viewer-open', state.viewer != null);
  stabilizeJoinViewport();
  stabilizeCameraViewport();
  scheduleGallerySync();
}

function bind() {
  document.querySelectorAll('.join-bg-image, .invite-backdrop-image').forEach((image) => {
    if (image.complete) return;
    image.addEventListener('load', stabilizeJoinViewport, { once: true });
  });
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
  document.querySelector('[data-show-invite-sheet]')?.addEventListener('click', () => {
    state.inviteSheet = true;
    render();
  });
  document.querySelectorAll('[data-close-invite-sheet]').forEach((button) => button.addEventListener('click', (event) => {
    if (event.currentTarget.classList.contains('sheet-backdrop') && event.target !== event.currentTarget) return;
    state.inviteSheet = false;
    render();
  }));
  document.querySelector('[data-sheet-panel]')?.addEventListener('click', (event) => {
    event.stopPropagation();
  });
  document.querySelector('[data-share-invite]')?.addEventListener('click', shareInviteLink);

  document.querySelector('[data-reload]')?.addEventListener('click', loadMemories);
  document.querySelectorAll('[data-local-import]').forEach((input) => input.addEventListener('change', importLocalMedia));
  document.querySelector('[data-captured-toggle]')?.addEventListener('click', () => {
    saveCapturedByPreference(!state.showCapturedBy);
    render();
  });
  document.querySelectorAll('[data-open-media]').forEach((button) => button.addEventListener('click', () => {
    state.viewer = Number(button.dataset.openMedia);
    state.previousViewer = null;
    state.viewerDirection = 0;
    render();
  }));
  document.querySelector('[data-open-last-capture]')?.addEventListener('click', (event) => {
    openLastCapture(event.currentTarget.dataset.id);
  });
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
  document.querySelectorAll('[data-join-form]').forEach((form) => form.addEventListener('submit', joinMemento));
  document.querySelectorAll('[data-open-name-sheet]').forEach((button) => button.addEventListener('click', () => {
    state.joinError = '';
    state.nameSheetOpen = true;
    render();
  }));
  document.querySelectorAll('[data-close-name-sheet]').forEach((element) => element.addEventListener('click', (event) => {
    if (event.target !== element && element.classList.contains('name-sheet-backdrop')) return;
    state.nameSheetOpen = false;
    render();
  }));
  document.querySelector('.name-sheet')?.addEventListener('click', (event) => event.stopPropagation());
  document.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', () => {
    if (state.mode === button.dataset.mode) return;
    state.mode = button.dataset.mode;
    updateCameraMode();
    const video = document.querySelector('.camera video');
    const label = document.querySelector('.camera-label');
    if (video && label) openCameraStream(video, label);
  }));
  document.querySelector('[data-open-invite]')?.addEventListener('click', openInvite);

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
  const items = galleryItems(memory);
  const next = viewerIndex(items.length, step);
  if (next == null) return;
  state.previousViewer = state.viewer;
  state.viewerDirection = step;
  state.viewer = next;
  render();
}

function openLastCapture(memoryId) {
  const memory = state.memories.find((entry) => entry.id === memoryId) || currentMemory();
  if (!memory || !state.lastCaptureId) return;
  if (state.view === 'camera') stopCamera();
  state.view = 'detail';
  state.selectedId = memory.id;
  const items = [...(state.localCaptures.get(memory.id) || []), ...memory.media];
  const index = items.findIndex((item) => item.id === state.lastCaptureId);
  state.viewer = index >= 0 ? index : null;
  state.previousViewer = null;
  state.viewerDirection = 0;
  render();
}

function galleryItems(memory) {
  const local = (state.localCaptures.get(memory.id) || []).filter((item) => item.sync !== 'Uploaded');
  return [...local, ...memory.media].sort(compareMediaNewestFirst);
}

function compareMediaNewestFirst(a, b) {
  const byTime = mediaTimestamp(b) - mediaTimestamp(a);
  if (byTime) return byTime;
  return String(b.id || '').localeCompare(String(a.id || ''));
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

async function shareInviteLink(event) {
  const url = event.currentTarget.dataset.shareInvite;
  try {
    if (navigator.share) {
      await navigator.share({ title: 'Memento invite', text: 'Join this Memento.', url });
    } else {
      await navigator.clipboard?.writeText(url);
      state.galleryNotice = 'Invite link copied.';
      state.inviteSheet = false;
      render();
    }
  } catch {
    state.galleryNotice = 'Could not share invite link.';
    state.inviteSheet = false;
    render();
  }
}

let lastTouchEnd = 0;

function preventFastDoubleTap(event) {
  const now = Date.now();
  if (now - lastTouchEnd <= 320) event.preventDefault();
  lastTouchEnd = now;
}

document.addEventListener('dblclick', (event) => event.preventDefault(), { passive: false });
document.addEventListener('touchend', preventFastDoubleTap, { passive: false });

async function joinMemento(event) {
  event.preventDefault();
  const memory = currentMemory();
  const name = new FormData(event.currentTarget).get('guest_name')?.toString().trim().replace(/\s+/g, ' ');
  if (!memory || !name) return;

  state.joinError = '';
  state.nameSheetOpen = true;

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
      guestToken: joined.guest_return_token || joined.return_token || '',
    });
    state.selectedId = joined.memento_id;
    state.nameSheetOpen = false;
    await loadMemories();
    setView('detail', joined.memento_id);
  } catch (error) {
    if (duplicateJoinError(error) && isLikelyInAppBrowser()) {
      const recovered = await continueAsExistingGuest(memory, name);
      if (recovered) return;
    }
    state.joinError = joinErrorMessage(error);
    render();
  }
}

async function continueAsExistingGuest(memory, name) {
  const normalized = normalizeName(name);
  const currentDeviceId = getDeviceId();
  const member = memory.members?.find((item) => normalizeName(item.guest_name) === normalized);
  if (!member || member.device_id !== currentDeviceId) return false;
  saveGuestSession({
    memberId: member.id,
    mementoId: memory.id,
    name: member.guest_name,
    guestToken: member.guest_return_token || '',
  });
  state.selectedId = memory.id;
  state.joinError = '';
  state.nameSheetOpen = false;
  await loadMemories();
  setView('detail', memory.id);
  return true;
}

function isLikelyInAppBrowser() {
  const ua = navigator.userAgent || '';
  const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  const knownInApp = /(FBAN|FBAV|Instagram|Line\/|MicroMessenger|CriOS\/.*Mobile\/|GSA\/|Twitter|LinkedInApp|Pinterest|DuckDuckGo|FxiOS)/i.test(ua);
  const codeScannerLike = /iPhone|iPad|iPod/i.test(ua) && /Safari/i.test(ua) && !standalone && document.referrer === '';
  return knownInApp || codeScannerLike;
}

function duplicateJoinError(error) {
  const message = String(error?.message || '').toLowerCase();
  return message.includes('already') || message.includes('duplicate') || message.includes('unique');
}

function joinErrorMessage(error) {
  if (duplicateJoinError(error)) return 'This name has already joined. Please use a different name.';
  const detail = readableSupabaseError(error);
  return detail ? `Could not join this Memento. ${detail}` : 'Could not join this Memento. Please try again.';
}

function readableSupabaseError(error) {
  const raw = String(error?.message || '').trim();
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    return String(parsed.message || parsed.details || '').replace(/\.$/, '');
  } catch {
    return raw.replace(/^Supabase RPC \d+\s*/i, '').slice(0, 160);
  }
}

async function importLocalMedia(event) {
  if (event.target.dataset.id) state.selectedId = event.target.dataset.id;
  const memory = currentMemory();
  const file = event.target.files?.[0];
  if (!memory || !file) return;
  if (eventEnded(memory)) {
    state.galleryNotice = 'Memento has ended';
    state.albumOpenedAt.delete(memory.id);
    event.target.value = '';
    render();
    return;
  }
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
    capturedAt: Date.now(),
    sync: 'Syncing',
  });
  if (state.view === 'camera') {
    showLastShot(item.localUrl, 'Syncing', type);
    updateCameraMode();
  }
  uploadCapture(memory, item, file, file.type || 'application/octet-stream').catch((error) => handleUploadFailure(memory, item, error));
  state.albumOpenedAt.delete(memory.id);
  event.target.value = '';
}

function addLocalCapture(memoryId, item) {
  const list = state.localCaptures.get(memoryId) || [];
  state.lastCaptureId = item.id;
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
  if (sync === 'Uploaded') {
    updateLastShotStatus(sync);
    if (state.view === 'camera') {
      const next = list.map((item) => item.id === itemId ? { ...item, sync } : item);
      state.localCaptures.set(memoryId, next);
      updateCameraMode();
    } else {
      state.localCaptures.set(memoryId, list.filter((item) => item.id !== itemId));
      loadMemories({ quiet: true });
    }
    return;
  }
  const next = list.map((item) => item.id === itemId ? { ...item, sync } : item);
  state.localCaptures.set(memoryId, next);
  updateLastShotStatus(sync);
  if (state.view === 'camera') updateCameraMode();
  if (state.view !== 'camera') render();
}

function handleUploadFailure(memory, item, error) {
  const ended = error?.message === 'Memento has ended';
  markCapture(memory.id, item.id, ended ? 'Ended' : 'Retry');
}

let activeStream = null;
let facingMode = 'environment';
let activeTrack = null;
let mediaRecorder = null;
let recordedChunks = [];
let flashMode = false;
let viewerAnimationTimer = null;
let recordingStartedAt = 0;
let streamHasAudio = false;
let recordingCanvas = null;
let recordingDrawFrame = 0;
let photoCaptureInFlight = false;

function startCamera() {
  const memory = currentMemory();
  const video = document.querySelector('video');
  const label = document.querySelector('.camera-label');
  if (!memory || !video || !label) return;
  if (eventEnded(memory)) {
    stopCamera();
    label.textContent = 'Memento has ended';
    return;
  }

  openCameraStream(video, label);

  document.querySelector('[data-facing]')?.addEventListener('click', () => {
    const camera = document.querySelector('.camera');
    camera?.classList.add('switching-camera');
    const nextFacingMode = facingMode === 'environment' ? 'user' : 'environment';
    if (state.recording) switchCameraDuringRecording(video, label, nextFacingMode);
    else openCameraStream(video, label, nextFacingMode);
  });

  document.querySelector('[data-flash]')?.addEventListener('click', () => toggleFlash());

  document.querySelector('[data-shutter]')?.addEventListener('click', async (event) => {
    if (eventEnded(memory)) {
      stopCamera();
      label.textContent = 'Memento has ended';
      updateCameraMode();
      return;
    }
    if (state.mode === 'video') {
      const videos = remainingFor(memory, 'video');
      if (videos <= 0) return;
      if (state.recording) {
        stopRecordingVideo();
        return;
      }
      try {
        await ensureVideoAudioStream(video, label);
      } catch {
        updateCameraMode();
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
    if (photos <= 0 || photoCaptureInFlight) return;
    photoCaptureInFlight = true;
    event.currentTarget.disabled = true;
    try {
      const photo = await capturePhoto(video, memory.style);
      photos = Math.max(0, photos - 1);
      const item = addLocalCapture(memory.id, { id: crypto.randomUUID(), type: 'photo', localUrl: photo.localUrl, capturedByName: currentParticipantName(), capturedAt: Date.now(), sync: 'Syncing' });
      showLastShot(photo.localUrl, 'Syncing');
      updateRemaining(photos, state.mode);
      uploadCapture(memory, item, photo.blob, 'image/jpeg').catch((error) => handleUploadFailure(memory, item, error));
    } catch (error) {
      label.textContent = `Could not capture photo${error?.message ? `: ${error.message}` : ''}`;
    } finally {
      photoCaptureInFlight = false;
      event.currentTarget.disabled = remainingFor(memory, 'photo') === 0 || !activeStream;
    }
  });
}

function openCameraStream(video, label, nextFacingMode = facingMode) {
  facingMode = nextFacingMode;
  const camera = document.querySelector('.camera');
  stopCamera();
  label.textContent = 'Starting camera';
  const wantsAudio = state.mode === 'video';
  navigator.mediaDevices?.getUserMedia({ video: { facingMode }, audio: wantsAudio }).then((stream) => {
    activeStream = stream;
    streamHasAudio = wantsAudio && stream.getAudioTracks().length > 0;
    activeTrack = stream.getVideoTracks()[0] || null;
    video.srcObject = stream;
    camera?.classList.toggle('selfie', facingMode === 'user');
    video.muted = true;
    video.setAttribute('playsinline', '');
    video.play().then(() => {
      label.textContent = '';
      window.setTimeout(() => camera?.classList.remove('switching-camera'), 80);
      updateCameraMode();
    }).catch(() => {
      label.textContent = 'Tap shutter when camera is ready';
      window.setTimeout(() => camera?.classList.remove('switching-camera'), 80);
      updateCameraMode();
    });
    bindZoomIfSupported(stream);
    bindFlashIfSupported();
  }).catch(() => {
    label.textContent = 'Camera permission needed';
    window.setTimeout(() => camera?.classList.remove('switching-camera'), 80);
  });
}

function stopCamera() {
  activeStream?.getTracks().forEach((track) => track.stop());
  activeStream = null;
  activeTrack = null;
  streamHasAudio = false;
}

async function switchCameraDuringRecording(video, label, nextFacingMode) {
  if (!navigator.mediaDevices?.getUserMedia) return;
  const audioTracks = activeStream?.getAudioTracks() || [];
  const oldVideoTracks = activeStream?.getVideoTracks() || [];
  const camera = document.querySelector('.camera');
  camera?.classList.add('switching-camera');
  const previousFacingMode = facingMode;
  facingMode = nextFacingMode || (facingMode === 'environment' ? 'user' : 'environment');
  label.textContent = 'Switching camera';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode }, audio: false });
    oldVideoTracks.forEach((track) => track.stop());
    activeTrack = stream.getVideoTracks()[0] || null;
    activeStream = new MediaStream([...stream.getVideoTracks(), ...audioTracks]);
    streamHasAudio = audioTracks.length > 0;
    video.srcObject = activeStream;
    camera?.classList.toggle('selfie', facingMode === 'user');
    await video.play().catch(() => {});
    bindZoomIfSupported(activeStream);
    bindFlashIfSupported();
    label.textContent = '';
  } catch {
    facingMode = previousFacingMode;
    label.textContent = '';
  } finally {
    window.setTimeout(() => camera?.classList.remove('switching-camera'), 220);
  }
}

async function ensureVideoAudioStream(video, label) {
  if (streamHasAudio || !navigator.mediaDevices?.getUserMedia) return;
  label.textContent = 'Starting microphone';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode }, audio: true });
    stopCamera();
    activeStream = stream;
    streamHasAudio = stream.getAudioTracks().length > 0;
    activeTrack = stream.getVideoTracks()[0] || null;
    video.srcObject = stream;
    document.querySelector('.camera')?.classList.toggle('selfie', facingMode === 'user');
    video.muted = true;
    video.setAttribute('playsinline', '');
    await video.play().catch(() => {});
    bindZoomIfSupported(stream);
    bindFlashIfSupported();
    label.textContent = '';
  } catch {
    label.textContent = 'Microphone permission needed';
    throw new Error('microphone permission needed');
  }
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

async function capturePhoto(video, style = 'Original') {
  const filter = filters[style] || filters.Original;
  await ensureCameraReady(video);
  if (activeTrack && typeof ImageCapture !== 'undefined' && filter === filters.Original) {
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
        return canvasPhotoFromSource(bitmap, bitmap.width, bitmap.height, style);
      } catch {
        // Canvas capture below works on browsers without ImageCapture support.
      }
    }
  }
  const settings = activeTrack?.getSettings?.() || {};
  const width = video.videoWidth || settings.width || 1280;
  const height = video.videoHeight || settings.height || 720;
  return canvasPhotoFromSource(video, width, height, style);
}

async function canvasPhotoFromSource(source, width, height, style = 'Original') {
  const filter = filters[style] || filters.Original;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas unavailable');
  context.filter = filter;
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  if (style === 'Mono') applyMonoPixels(context, canvas.width, canvas.height);
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

function applyMonoPixels(context, width, height) {
  const imageData = context.getImageData(0, 0, width, height);
  const pixels = imageData.data;
  for (let index = 0; index < pixels.length; index += 4) {
    const gray = (pixels[index] * 0.299) + (pixels[index + 1] * 0.587) + (pixels[index + 2] * 0.114);
    const toned = Math.max(0, Math.min(255, ((gray - 128) * 1.06) + 128));
    pixels[index] = toned;
    pixels[index + 1] = toned;
    pixels[index + 2] = toned;
  }
  context.putImageData(imageData, 0, 0);
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
  if (eventEnded(memory)) {
    document.querySelector('.camera-label').textContent = 'Memento has ended';
    return;
  }
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
  state.recording = true;
  const video = document.querySelector('.camera video');
  const recorderStream = video ? recordingStreamFromCanvas(video) : activeStream;
  try {
    mediaRecorder = new MediaRecorder(recorderStream || activeStream, mimeType ? { mimeType } : undefined);
  } catch {
    stopRecordingCanvas();
    state.recording = false;
    mediaRecorder = new MediaRecorder(activeStream, mimeType ? { mimeType } : undefined);
  }
  recordingStartedAt = Date.now();
  state.recordingSecondsLeft = Math.max(memory.videoLength, 1);
  document.querySelector('.shutter')?.classList.add('recording');
  document.querySelector('.camera-label').textContent = '';
  updateRemaining(state.recordingSecondsLeft, 'recording', { animate: false });
  const timer = window.setInterval(() => {
    if (!state.recording) {
      window.clearInterval(timer);
      return;
    }
    if (eventEnded(memory)) {
      document.querySelector('.camera-label').textContent = 'Memento has ended';
      stopRecordingVideo();
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
    stopRecordingCanvas();
    document.querySelector('.shutter')?.classList.remove('recording');
    const blob = new Blob(recordedChunks, { type: normalizedContentType(mediaRecorder.mimeType || 'video/webm') });
    if (!blob.size) {
      document.querySelector('.camera-label').textContent = 'Could not save video';
      updateCameraMode();
      return;
    }
    const localUrl = URL.createObjectURL(blob);
    const posterUrl = await generateVideoPoster(localUrl).catch(() => '');
    const item = addLocalCapture(memory.id, { id: crypto.randomUUID(), type: 'video', localUrl, posterUrl, capturedByName: currentParticipantName(), capturedAt: recordingStartedAt || Date.now(), sync: 'Syncing' });
    showLastShot(posterUrl || localUrl, 'Syncing', 'video');
    uploadCapture(memory, item, blob, blob.type || 'video/webm').catch((error) => handleUploadFailure(memory, item, error));
    onDone();
  };
  mediaRecorder.start(1000);
}

function recordingStreamFromCanvas(video) {
  if (!video || typeof document.createElement('canvas').captureStream !== 'function') return null;
  const settings = activeTrack?.getSettings?.() || {};
  const width = video.videoWidth || settings.width || 1280;
  const height = video.videoHeight || settings.height || 720;
  recordingCanvas = document.createElement('canvas');
  recordingCanvas.width = width;
  recordingCanvas.height = height;
  const context = recordingCanvas.getContext('2d');
  if (!context) return null;
  const draw = () => {
    if (!state.recording || !recordingCanvas) return;
    context.save();
    context.clearRect(0, 0, width, height);
    if (facingMode === 'user') {
      context.translate(width, 0);
      context.scale(-1, 1);
    }
    context.drawImage(video, 0, 0, width, height);
    context.restore();
    recordingDrawFrame = requestAnimationFrame(draw);
  };
  const stream = recordingCanvas.captureStream(30);
  activeStream?.getAudioTracks().forEach((track) => stream.addTrack(track));
  recordingDrawFrame = requestAnimationFrame(draw);
  return stream;
}

function stopRecordingCanvas() {
  if (recordingDrawFrame) cancelAnimationFrame(recordingDrawFrame);
  recordingDrawFrame = 0;
  recordingCanvas = null;
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
  if (item.uploadStarted) return;
  item.uploadStarted = true;
  if (!state.guest?.memberId) throw new Error('Missing guest member');
  const endTime = memory.endTime?.getTime?.();
  const capturedAfterEnd = endTime && item.capturedAt && item.capturedAt >= endTime;
  const unknownCaptureAfterEnd = !item.capturedAt && eventEnded(memory);
  if (capturedAfterEnd || unknownCaptureAfterEnd) {
    markCapture(memory.id, item.id, 'Ended');
    throw new Error('Memento has ended');
  }
  const uploadType = item.type === 'video' ? 'video/mp4' : normalizedContentType(contentType);
  const extension = uploadType.includes('video') ? videoExtension(uploadType) : 'jpg';
  const storagePath = `mementos/${memory.id}/media/${item.id}.${extension}`;
  const thumbnailPath = `mementos/${memory.id}/thumbs/${item.id}.jpg`;
  const thumbnailBlob = await generateBlurredThumbnail(item, blob).catch(() => null);
  if (thumbnailBlob) await uploadStorageObject(thumbnailPath, thumbnailBlob, 'image/jpeg');
  await uploadStorageObject(storagePath, blob, uploadType);
  await supabaseInsert('media_items?select=id', {
    memento_id: memory.id,
    member_id: state.guest.memberId,
    media_type: item.type,
    original_path: storagePath,
    thumbnail_path: thumbnailBlob ? thumbnailPath : null,
    captured_by_name: item.capturedByName || currentParticipantName(),
    file_size_bytes: blob.size,
    duration_seconds: item.type === 'video' ? memory.videoLength : null,
    uploaded_at: new Date().toISOString(),
    approval_status: memory.sharedGallery ? 'approved' : 'pending',
  });
  if (item.type === 'photo') {
    memory.uploadedPhotos += 1;
    memory.ownUploadedPhotos += 1;
  } else {
    memory.uploadedVideos += 1;
    memory.ownUploadedVideos += 1;
  }
  markCapture(memory.id, item.id, 'Uploaded');
}

async function generateBlurredThumbnail(item, blob) {
  if (item.type === 'video') {
    const url = item.localUrl || URL.createObjectURL(blob);
    try {
      return await generateVideoPosterBlob(url, true);
    } finally {
      if (!item.localUrl) URL.revokeObjectURL(url);
    }
  }
  if ('createImageBitmap' in window) {
    const bitmap = await createImageBitmap(blob);
    try {
      return imageSourceToThumbnailBlob(bitmap, bitmap.width, bitmap.height, true);
    } finally {
      bitmap.close?.();
    }
  }
  const url = item.localUrl || URL.createObjectURL(blob);
  try {
    const image = await loadImage(url);
    return imageSourceToThumbnailBlob(image, image.naturalWidth || image.width, image.naturalHeight || image.height, true);
  } finally {
    if (!item.localUrl) URL.revokeObjectURL(url);
  }
}

function imageSourceToThumbnailBlob(source, sourceWidth, sourceHeight, blurred = false) {
  const canvas = document.createElement('canvas');
  canvas.width = 240;
  canvas.height = 300;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas unavailable');
  if (blurred) context.filter = 'blur(10px) saturate(.82) brightness(.72)';
  drawCover(context, source, sourceWidth, sourceHeight, canvas.width, canvas.height);
  return new Promise((resolve) => {
    if (canvas.toBlob) {
      canvas.toBlob((blob) => resolve(blob || dataUrlToBlob(canvas.toDataURL('image/jpeg', 0.62))), 'image/jpeg', 0.62);
    } else {
      resolve(dataUrlToBlob(canvas.toDataURL('image/jpeg', 0.62)));
    }
  });
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not load image'));
    image.src = url;
  });
}

function videoExtension(contentType) {
  if (contentType.includes('mp4')) return 'mp4';
  if (contentType.includes('quicktime')) return 'mov';
  return 'webm';
}

function normalizedContentType(contentType) {
  return String(contentType || 'application/octet-stream').split(';')[0].trim().toLowerCase();
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

async function generateVideoPoster(url) {
  const blob = await generateVideoPosterBlob(url, false);
  return blobToDataUrl(blob);
}

function generateVideoPosterBlob(url, blurred = false) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    const capture = () => {
      const width = video.videoWidth || 640;
      const height = video.videoHeight || 360;
      const canvas = document.createElement('canvas');
      canvas.width = blurred ? 240 : 720;
      canvas.height = blurred ? 300 : 900;
      const context = canvas.getContext('2d');
      if (!context) {
        reject(new Error('Canvas unavailable'));
        return;
      }
      if (blurred) context.filter = 'blur(10px) saturate(.82) brightness(.72)';
      drawCover(context, video, width, height, canvas.width, canvas.height);
      if (canvas.toBlob) {
        canvas.toBlob((blob) => resolve(blob || dataUrlToBlob(canvas.toDataURL('image/jpeg', blurred ? 0.62 : 0.78))), 'image/jpeg', blurred ? 0.62 : 0.78);
      } else {
        resolve(dataUrlToBlob(canvas.toDataURL('image/jpeg', blurred ? 0.62 : 0.78)));
      }
    };
    video.onloadeddata = capture;
    video.onloadedmetadata = () => {
      video.currentTime = Math.min(0.15, Math.max((video.duration || 1) / 10, 0));
    };
    video.onerror = () => reject(new Error('Could not create video thumbnail'));
    video.src = url;
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Could not read thumbnail'));
    reader.readAsDataURL(blob);
  });
}

function showLastShot(url, statusText = 'Saved local', type = 'photo') {
  const shot = document.querySelector('.last-shot');
  if (shot) {
    shot.classList.add('has-capture');
    shot.classList.toggle('video-capture', type === 'video');
    shot.disabled = false;
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

syncViewportHeight();
loadMemories();
