const filters = {
  Original: 'none',
  'Clean Warm': 'contrast(1.03) saturate(1.08) sepia(.08) brightness(1.02)',
  'Soft Film': 'contrast(.92) saturate(.86) sepia(.13) brightness(1.04)',
  'Kodak-like': 'contrast(1.08) saturate(1.2) sepia(.16) hue-rotate(-7deg)',
  'Polaroid-like': 'contrast(.9) saturate(.78) sepia(.2) brightness(1.08)',
  Mono: 'grayscale(1) contrast(1.06)',
};

const steps = ['Name', 'Memory', 'Date/time', 'Reveal', 'Look', 'Invite', 'Room'];
const starter = {
  title: 'Dinner & Drinks',
  host: 'CY',
  date: 'Aug 28, 2026, 7:30 PM',
  end: 'Aug 29, 2026, 12:30 AM',
  reveal: 'When it ends',
  delay: '+1 hour',
  style: 'Clean Warm',
  guests: 10,
  joined: 1,
  shots: 10,
  videos: 2,
  videoLength: 15,
  cover: './assets/friends-night.png',
  code: 'MEMENTO28',
};

let view = 'home';
let step = 0;
let sheetOpen = false;
let event = JSON.parse(localStorage.getItem('memento-web-event') || 'null') || starter;

function save() {
  localStorage.setItem('memento-web-event', JSON.stringify(event));
}

function unlockText(reveal = event.reveal, delay = event.delay) {
  if (reveal === 'Live') return 'Visible live';
  if (reveal === 'When it ends') return 'Unlocks Aug 29 at 12:30 AM';
  if (delay === '+2 hours') return 'Unlocks Aug 29 at 2:30 AM';
  if (delay === 'End of day') return 'Unlocks Aug 29 at 11:59 PM';
  if (delay === '+1 day') return 'Unlocks Aug 30 at 12:30 AM';
  return 'Unlocks Aug 29 at 1:30 AM';
}

function setView(next) {
  view = next;
  render();
}

function setEvent(next) {
  event = next;
  save();
  render();
}

function summary() {
  return `
    <article class="summary">
      <img src="${event.cover}" alt="">
      <div>
        <h2>${event.title}</h2>
        <p>Hosted by ${event.host}</p>
        <p>${event.date}</p>
        <p>${event.joined} joined · ${event.guests - event.joined} spots left</p>
        <p>${event.shots} photos per guest · ${event.videos} videos per guest</p>
        <p>${unlockText()}</p>
      </div>
    </article>`;
}

function topbar() {
  return `
    <header class="topbar">
      <button class="brand" data-view="home" aria-label="Memento home">Memento</button>
      <nav>
        <button class="ghost" data-view="intro">Intro</button>
        <button class="ink" data-create>Create</button>
      </nav>
    </header>`;
}

function home() {
  return `
    <section class="page grid-page">
      <div class="title-block"><p>My Memories</p><h1>Memento</h1></div>
      <div class="memory-grid">
        <article class="memory-card">
          <button class="image-button" data-view="detail"><img src="${event.cover}" alt="" style="filter:${filters[event.style]}"></button>
          <div class="card-copy">
            <span class="status">Active</span>
            <h2>${event.title}</h2>
            <p>${event.date}</p>
            <div class="stats">
              <span>${event.joined} joined</span><span>${event.guests - event.joined} spots left</span><span>0 moments</span><span>0 uploaded</span>
            </div>
            <div class="actions"><button class="ghost">QR</button><button class="ink" data-view="camera">Camera</button></div>
          </div>
        </article>
        <button class="new-card" data-view="intro">Create a new Memento</button>
      </div>
    </section>`;
}

function intro() {
  return `
    <section class="page intro">
      <div>
        <p class="kicker">A quiet room for shared photos</p>
        <h1>Make the night easy to remember, without making it loud.</h1>
        <p>Memento gives your guests a simple camera, a clean invite, and a reveal moment you control.</p>
        <button class="ink" data-create>Continue</button>
      </div>
      <img src="./assets/golden-retriever.png" alt="">
    </section>`;
}

function shell(title, detail, content) {
  return `<div class="shell"><h1>${title}</h1><p>${detail}</p>${content}</div>`;
}

function create() {
  const done = step >= steps.length;
  return `
    <section class="page wizard">
      ${done ? '' : `<div class="progress"><span>${steps[step]}</span><span>${step + 1} of ${steps.length}</span><i style="width:${((step + 1) / steps.length) * 100}%"></i></div>`}
      <div class="wizard-panel">${done ? success() : stepBody()}</div>
      ${done ? '' : `<footer class="wizard-footer"><button class="ghost" ${step === 0 ? 'disabled' : ''} data-back>Back</button><button class="ink" data-next>${step === steps.length - 1 ? 'Create Memento' : 'Next'}</button></footer>`}
    </section>`;
}

function stepBody() {
  if (step === 0) return shell('What should we call you?', 'This name appears when you host or join.', `<input data-field="host" value="${event.host}">`);
  if (step === 1) return shell('Name the Memento.', 'Use the real memory name: dinner, wedding, trip, weekend.', `<input data-field="title" value="${event.title}">`);
  if (step === 2) return shell('When does it happen?', 'Set the date and capture window.', `<div class="two-fields"><input data-field="date" value="${event.date}"><input data-field="end" value="${event.end}"></div>`);
  if (step === 3) return reveal();
  if (step === 4) return style();
  if (step === 5) return cover();
  return room();
}

function reveal() {
  const choices = ['Live', 'When it ends', 'Custom'];
  return shell('How should photos unlock?', 'Keep the choice simple: live, at the end, or after a short delay.', `
    <div class="reveal-grid">
      ${choices.map(choice => `
        <button class="reveal-card ${event.reveal === choice ? 'selected' : ''}" data-reveal="${choice}">
          <img src="${choice === 'Live' ? './assets/golden-retriever.png' : './assets/friends-night.png'}" alt="">
          ${event.reveal === choice ? `<span>${unlockText(choice, event.delay)}</span>` : ''}
          <strong>${choice}</strong>
          <small>${choice === 'Live' ? 'Photos visible after sync.' : choice === 'When it ends' ? 'Reveal after capture closes.' : 'Choose your reveal time.'}</small>
        </button>`).join('')}
    </div>
    ${event.reveal === 'Custom' ? `<div class="option-row">${['+1 hour', '+2 hours', 'End of day', '+1 day'].map(delay => `<button class="${event.delay === delay ? 'selected' : ''}" data-delay="${delay}">${delay}</button>`).join('')}</div>` : ''}`);
}

function style() {
  return shell('Choose the camera look.', 'The original image stays untouched. Memento saves only the style.', `
    <img class="preview" src="${event.cover}" alt="" style="filter:${filters[event.style]}">
    <div class="style-row">${Object.keys(filters).map(name => `<button class="${event.style === name ? 'selected' : ''}" data-style="${name}">${name}</button>`).join('')}</div>`);
}

function cover() {
  return shell('Frame the invite cover.', 'Use the selected image as the cover. The crop area keeps the card proportion clear on every screen.', `
    <div class="cropper"><img src="${event.cover}" alt=""><div></div></div>
    <div class="actions centered"><button class="ghost">Take photo</button><label class="ghost">Album<input type="file" accept="image/*" hidden data-album></label><button class="ghost" data-reset>Reset</button></div>`);
}

function room() {
  return shell('Set the room limits.', 'Free includes 10 guests, 10 shots per guest, 2 videos per guest, and 15 sec video length.', `
    <div class="limit-grid">
      ${dial('Guests', 'guests', [10, 25, 50])}
      ${dial('Shots per guest', 'shots', [10, 25, 50])}
      ${dial('Videos per guest', 'videos', [2, 3, 5])}
      ${dial('Video length', 'videoLength', [15, 30], event.videos === 2)}
    </div>
    <p class="fine">${event.joined} joined · ${event.guests - event.joined} spots left · moments uploaded locally for now</p>`);
}

function dial(label, key, values, locked = false) {
  return `<div class="dial ${locked ? 'locked' : ''}"><span>${label}</span>${values.map(value => `<button ${locked && event[key] !== value ? 'disabled' : ''} class="${event[key] === value ? 'selected' : ''}" data-limit="${key}" data-value="${value}">${value}${label.includes('length') ? ' sec' : ''}</button>`).join('')}</div>`;
}

function success() {
  return `<div class="success"><h1>Memento created.</h1>${summary()}<button class="ink" data-sheet>Show invite</button></div>`;
}

function detail() {
  return `
    <section class="page detail">
      <img class="hero-cover" src="${event.cover}" alt="" style="filter:${filters[event.style]}">
      <div>
        ${summary()}
        <div class="actions"><button class="ghost">QR</button><button class="ink" data-view="camera">Camera</button><button class="ghost">Album</button><button class="ghost" data-view="poster">Poster</button></div>
        <div class="gallery"><img src="./assets/golden-retriever.png" alt=""><img src="./assets/friends-night.png" alt=""></div>
      </div>
    </section>`;
}

function camera() {
  return `
    <section class="camera">
      <button class="close light" data-view="detail">Close</button>
      <video autoplay playsinline muted></video>
      <div class="camera-label">Camera preview</div>
      <div class="camera-controls">
        <button class="selected" data-mode="Photo">Photo</button>
        <button data-mode="Video">Video</button>
        <button class="shutter" data-shutter aria-label="Capture"></button>
      </div>
    </section>`;
}

function poster() {
  return `
    <section class="page poster">
      <button class="ghost" data-view="detail">Back</button>
      <article><p>You are invited to</p><h1>${event.title}</h1><div class="qr">QR</div><strong>${event.code}</strong><span>${event.date}</span></article>
    </section>`;
}

function inviteSheet() {
  return `
    <div class="modal-backdrop" data-close-sheet>
      <aside class="invite-sheet">
        <button class="close" data-close-sheet>Close</button>
        <h2>Invite ready</h2>
        <div class="qr">QR</div>
        <strong>${event.code}</strong>
        <div class="sheet-actions"><button>Share link</button><button>Save QR</button><button data-view="poster">Invite poster</button><button>Web invite</button></div>
      </aside>
    </div>`;
}

function render() {
  const app = document.getElementById('app');
  const page = view === 'home' ? home() : view === 'intro' ? intro() : view === 'create' ? create() : view === 'detail' ? detail() : view === 'camera' ? camera() : poster();
  app.innerHTML = topbar() + page + (sheetOpen ? inviteSheet() : '');
  bind();
  if (view === 'camera') startCamera();
}

function bind() {
  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => {
    sheetOpen = false;
    setView(button.dataset.view);
  }));
  document.querySelectorAll('[data-create]').forEach(button => button.addEventListener('click', () => {
    step = 0;
    setView('create');
  }));
  document.querySelector('[data-back]')?.addEventListener('click', () => {
    step = Math.max(0, step - 1);
    render();
  });
  document.querySelector('[data-next]')?.addEventListener('click', () => {
    step += 1;
    render();
  });
  document.querySelectorAll('[data-field]').forEach(input => input.addEventListener('input', eventInput => {
    event[input.dataset.field] = eventInput.target.value;
    save();
  }));
  document.querySelectorAll('[data-reveal]').forEach(button => button.addEventListener('click', () => setEvent({ ...event, reveal: button.dataset.reveal })));
  document.querySelectorAll('[data-delay]').forEach(button => button.addEventListener('click', () => setEvent({ ...event, delay: button.dataset.delay })));
  document.querySelectorAll('[data-style]').forEach(button => button.addEventListener('click', () => setEvent({ ...event, style: button.dataset.style })));
  document.querySelectorAll('[data-limit]').forEach(button => button.addEventListener('click', () => {
    const key = button.dataset.limit;
    const value = Number(button.dataset.value);
    const next = { ...event, [key]: value };
    if (key === 'videos' && value === 2) next.videoLength = 15;
    setEvent(next);
  }));
  document.querySelector('[data-reset]')?.addEventListener('click', () => setEvent({ ...event, cover: './assets/friends-night.png' }));
  document.querySelector('[data-album]')?.addEventListener('change', inputEvent => {
    const file = inputEvent.target.files?.[0];
    if (file) setEvent({ ...event, cover: URL.createObjectURL(file) });
  });
  document.querySelector('[data-sheet]')?.addEventListener('click', () => {
    sheetOpen = true;
    render();
  });
  document.querySelectorAll('[data-close-sheet]').forEach(item => item.addEventListener('click', closeEvent => {
    if (closeEvent.target === item) {
      sheetOpen = false;
      view = 'home';
      render();
    }
  }));
}

function startCamera() {
  const video = document.querySelector('video');
  const label = document.querySelector('.camera-label');
  let mode = 'Photo';
  let photos = 1;
  let videos = event.videos;
  const mediaRecorderSupported = 'MediaRecorder' in window;

  navigator.mediaDevices?.getUserMedia({ video: true, audio: true }).then(stream => {
    video.srcObject = stream;
    label.textContent = `${photos} photo remaining`;
  }).catch(() => {
    label.textContent = 'Camera permission needed';
  });

  document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => {
    mode = button.dataset.mode;
    document.querySelectorAll('[data-mode]').forEach(item => item.classList.toggle('selected', item === button));
    label.textContent = mode === 'Photo' ? `${photos} photo${photos === 1 ? '' : 's'} remaining` : mediaRecorderSupported ? `${videos} video${videos === 1 ? '' : 's'} remaining` : 'Video recording is not supported in this browser. Photo capture still works.';
  }));

  document.querySelector('[data-shutter]')?.addEventListener('click', clickEvent => {
    if (mode === 'Photo') photos = Math.max(0, photos - 1);
    if (mode === 'Video' && mediaRecorderSupported) videos = Math.max(0, videos - 1);
    label.textContent = mode === 'Photo' && photos === 0 ? 'No shots left' : mode === 'Photo' ? `${photos} photo${photos === 1 ? '' : 's'} remaining` : `${videos} video${videos === 1 ? '' : 's'} remaining`;
    clickEvent.currentTarget.disabled = mode === 'Photo' ? photos === 0 : videos === 0;
  });
}

render();
