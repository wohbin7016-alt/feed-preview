import { loadState, commitState } from './storage.js';

const MAX_PHOTOS = 100;
const MAX_BYTES = 30 * 1024 * 1024;
const LONG_EDGE = 1600;
const $ = id => document.getElementById(id);
const ui = Object.fromEntries([
  'add-photos', 'empty-add', 'photo-input', 'photo-grid', 'empty-state',
  'photo-count', 'grid-ratio', 'ratio-portrait', 'ratio-square', 'selection-bar',
  'selection-index', 'selection-name', 'clear-selection', 'move-before', 'move-after',
  'delete-photo', 'undo-notice', 'undo-delete', 'dismiss-undo', 'toast',
  'import-progress', 'import-text', 'storage-status', 'storage-text',
  'live-announcement', 'drop-zone'
].map(id => [id, $(id)]));
let state = { photos: new Map(), order: [], undo: null, ratio: 'portrait', revision: 0 };
let ready = false;
let busy = 0;
let selectedId = null;
let undoDismissed = false;
let mutationTail = Promise.resolve();
let toastTimer;
let announceTimer;
const objectURLs = new Map();

function announce(message, type = 'normal', showToast = true) {
  clearTimeout(announceTimer);
  ui['live-announcement'].textContent = '';
  announceTimer = setTimeout(() => { ui['live-announcement'].textContent = message; }, 30);
  if (!showToast) return;
  clearTimeout(toastTimer);
  ui.toast.textContent = message;
  ui.toast.dataset.type = type;
  ui.toast.hidden = false;
  toastTimer = setTimeout(() => { ui.toast.hidden = true; }, type === 'error' ? 9000 : 4200);
}

function storageStatus(text, status = 'saved') {
  ui['storage-text'].textContent = text;
  ui['storage-status'].dataset.status = status;
}

function imageURL(photo) {
  if (!objectURLs.has(photo.id)) objectURLs.set(photo.id, URL.createObjectURL(photo.blob));
  return objectURLs.get(photo.id);
}

function renderControls() {
  const index = state.order.indexOf(selectedId);
  const locked = !ready || busy > 0;
  ui['add-photos'].disabled = locked || state.order.length >= MAX_PHOTOS;
  ui['empty-add'].disabled = locked;
  ui['photo-input'].disabled = locked;
  ui['ratio-portrait'].disabled = locked;
  ui['ratio-square'].disabled = locked;
  ui['ratio-portrait'].setAttribute('aria-pressed', String(state.ratio === 'portrait'));
  ui['ratio-square'].setAttribute('aria-pressed', String(state.ratio === 'square'));
  ui['photo-count'].textContent = String(state.order.length);
  ui['grid-ratio'].textContent = state.ratio === 'square' ? '1:1' : '3:4';
  document.documentElement.style.setProperty('--ratio', state.ratio === 'square' ? '1 / 1' : '3 / 4');
  ui['selection-bar'].hidden = index < 0;
  if (index >= 0) {
    ui['selection-index'].textContent = String(index + 1);
    ui['selection-name'].textContent = state.photos.get(selectedId)?.name || '사진';
  }
  ui['move-before'].disabled = locked || index <= 0;
  ui['move-after'].disabled = locked || index < 0 || index >= state.order.length - 1;
  ui['delete-photo'].disabled = locked || index < 0;
  ui['undo-notice'].hidden = !state.undo || undoDismissed;
  ui['undo-delete'].disabled = locked || !state.undo || state.order.length >= MAX_PHOTOS;
  ui['undo-delete'].title = state.order.length >= MAX_PHOTOS ? '사진을 한 장 삭제한 뒤 복구할 수 있어요.' : '';
  for (const card of ui['photo-grid'].children) card.setAttribute('aria-pressed', String(card.dataset.id === selectedId));
}

function renderGrid() {
  const focused = document.activeElement?.closest('.photo-card')?.dataset.id;
  const fragment = document.createDocumentFragment();
  state.order.forEach((id, index) => {
    const photo = state.photos.get(id);
    if (!photo) return;
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'photo-card';
    card.dataset.id = id;
    card.setAttribute('aria-label', `${index + 1}번째 사진: ${photo.name}`);
    card.setAttribute('aria-pressed', String(id === selectedId));
    const img = document.createElement('img');
    img.src = imageURL(photo);
    img.alt = '';
    img.draggable = false;
    img.decoding = 'async';
    const position = document.createElement('span');
    position.className = 'photo-position';
    position.textContent = String(index + 1);
    position.setAttribute('aria-hidden', 'true');
    card.append(img, position);
    fragment.append(card);
  });
  ui['photo-grid'].replaceChildren(fragment);
  ui['empty-state'].hidden = state.order.length > 0;
  if (!state.order.includes(selectedId)) selectedId = null;
  for (const [id, url] of objectURLs) {
    if (!state.photos.has(id)) { URL.revokeObjectURL(url); objectURLs.delete(id); }
  }
  renderControls();
  if (focused) {
    const restore = state.order.includes(focused) ? focused : selectedId;
    if (restore) cardFor(restore)?.focus({ preventScroll: true });
    else ui['add-photos'].focus({ preventScroll: true });
  }
}

function cloneState() { return { ...state, photos: new Map(state.photos), order: [...state.order], undo: state.undo ? { ...state.undo } : null }; }

async function save(next, changes = {}) {
  // Only publish the new UI state after the entire IDB transaction commits.
  const revision = await commitState(next, changes);
  state = { ...next, revision };
}

function enqueue(operation) {
  if (!ready) return Promise.resolve();
  busy += 1;
  cancelDrag();
  renderControls();
  const run = mutationTail.then(async () => {
    storageStatus('변경 내용을 저장하는 중', 'saving');
    try {
      await operation();
      storageStatus('이 브라우저에 자동 저장됨');
    } catch (error) {
      if (error.name === 'ConflictError') {
        try { state = await loadState(); } catch { ready = false; }
      }
      const message = error.name === 'QuotaExceededError'
        ? '저장 공간이 부족해요. 기존 사진은 그대로예요. 필요 없는 사진을 지운 뒤 다시 시도해 주세요.'
        : error.message || '저장하지 못했어요. 기존 사진은 그대로예요. 다시 시도해 주세요.';
      storageStatus('저장하지 못했어요 · 다시 시도해 주세요', 'error');
      announce(message, 'error');
    } finally {
      busy -= 1;
      ui['import-progress'].hidden = true;
      renderGrid();
    }
  });
  mutationTail = run.catch(() => {});
  return run;
}

async function decodeImage(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file);
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch { /* Safari may decode formats that createImageBitmap does not. */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('읽을 수 없는 이미지예요. JPG 또는 PNG로 다시 추가해 주세요.'));
      img.src = url;
    });
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => { img.src = ''; URL.revokeObjectURL(url); } };
  } catch (error) { URL.revokeObjectURL(url); throw error; }
}

async function prepareImage(file) {
  if (!file.size) throw new Error('빈 파일이에요.');
  if (file.size > MAX_BYTES) throw new Error('사진 한 장은 30MB 이하만 추가할 수 있어요.');
  if (file.type && !file.type.startsWith('image/')) throw new Error('이미지 파일이 아니에요.');
  const decoded = await decodeImage(file);
  const canvas = document.createElement('canvas');
  try {
    if (!decoded.width || !decoded.height) throw new Error('이미지 크기를 읽을 수 없어요.');
    const scale = Math.min(1, LONG_EDGE / Math.max(decoded.width, decoded.height));
    canvas.width = Math.max(1, Math.round(decoded.width * scale));
    canvas.height = Math.max(1, Math.round(decoded.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('이미지를 준비하지 못했어요. 다시 시도해 주세요.');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(decoded.source, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve, reject) => canvas.toBlob(result => result ? resolve(result) : reject(new Error('이미지를 변환하지 못했어요.')), 'image/jpeg', 0.88));
    const id = globalThis.crypto?.randomUUID?.() || `photo-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return { id, blob, name: file.name || '사진', createdAt: Date.now() };
  } finally { decoded.close(); canvas.width = 1; canvas.height = 1; }
}

function importFiles(input) {
  const files = Array.from(input || []);
  if (!files.length || busy || !ready) return;
  return enqueue(async () => {
    const room = MAX_PHOTOS - state.order.length;
    if (!room) { announce('사진은 최대 100장까지 놓을 수 있어요.'); return; }
    const photos = [];
    const failures = [];
    let excess = 0;
    ui['import-progress'].hidden = false;
    for (let index = 0; index < files.length; index += 1) {
      if (photos.length >= room) { excess = files.length - index; break; }
      ui['import-text'].textContent = `사진 준비 중 ${index + 1} / ${files.length}`;
      try { photos.push(await prepareImage(files[index])); }
      catch (error) { failures.push(`${files[index].name || '사진'}: ${error.message}`); }
    }
    if (photos.length) {
      ui['import-text'].textContent = `${photos.length}장 저장 중`;
      const next = cloneState();
      for (const photo of photos) next.photos.set(photo.id, photo);
      next.order = [...photos.map(photo => photo.id), ...next.order];
      await save(next, { put: photos });
      selectedId = photos[0].id;
    }
    const messages = [photos.length ? `${photos.length}장을 맨 앞에 놓았어요.` : '추가할 수 있는 사진이 없어요.'];
    if (excess) messages.push(`최대 100장이라 ${excess}장은 제외했어요.`);
    if (failures.length) messages.push(`${failures.length}장은 읽지 못했어요. ${failures[0]}`);
    announce(messages.join('\n'), failures.length ? 'error' : 'normal');
  });
}

function selectPhoto(id) {
  selectedId = state.order.includes(id) ? id : null;
  renderControls();
}

function movePhoto(id, targetIndex) {
  return enqueue(async () => {
    const from = state.order.indexOf(id);
    const to = Math.max(0, Math.min(state.order.length - 1, targetIndex));
    if (from < 0 || from === to) return;
    const next = cloneState();
    next.order.splice(from, 1);
    next.order.splice(to, 0, id);
    await save(next);
    selectedId = id;
    announce(`${from + 1}번째 사진을 ${to + 1}번째로 옮겼어요.`, 'normal', false);
  });
}

function deletePhoto(id) {
  return enqueue(async () => {
    const index = state.order.indexOf(id);
    if (index < 0) return;
    const next = cloneState();
    const remove = [];
    if (next.undo) { remove.push(next.undo.id); next.photos.delete(next.undo.id); }
    next.order.splice(index, 1);
    next.undo = { id, index };
    await save(next, { remove });
    selectedId = next.order[Math.min(index, next.order.length - 1)] || null;
    undoDismissed = false;
    announce('사진을 삭제했어요. 되돌리기로 복구할 수 있어요.', 'normal', false);
  });
}

function undoDelete() {
  return enqueue(async () => {
    if (!state.undo) return;
    if (state.order.length >= MAX_PHOTOS) { announce('사진을 한 장 삭제한 뒤 복구할 수 있어요.'); return; }
    const next = cloneState();
    const { id, index } = next.undo;
    next.order.splice(Math.min(index, next.order.length), 0, id);
    next.undo = null;
    await save(next);
    selectedId = id;
    announce('삭제한 사진을 원래 자리에 복구했어요.');
  });
}

function setRatio(ratio) {
  if (!['portrait', 'square'].includes(ratio)) return;
  return enqueue(async () => {
    if (state.ratio === ratio) return;
    const next = cloneState();
    next.ratio = ratio;
    await save(next);
    announce(ratio === 'square' ? '정사각형 미리보기로 바꿨어요.' : '세로형 미리보기로 바꿨어요.', 'normal', false);
  });
}

function cardFor(id) { return [...ui['photo-grid'].children].find(card => card.dataset.id === id); }
let drag = null;
let suppressClickUntil = 0;
let autoScrollFrame = 0;

function updateDrag(x, y) {
  if (!drag?.active) return;
  drag.x = x; drag.y = y;
  drag.ghost.style.left = `${x}px`;
  drag.ghost.style.top = `${y}px`;
  const hit = document.elementFromPoint(x, y)?.closest('.photo-card');
  drag.targetId = hit && ui['photo-grid'].contains(hit) ? hit.dataset.id : null;
  for (const card of ui['photo-grid'].children) card.classList.toggle('is-drop-target', card.dataset.id === drag.targetId && card.dataset.id !== drag.id);
}

function autoScroll() {
  if (!drag?.active) return;
  const band = 70;
  const speed = drag.y < band ? -Math.ceil((band - drag.y) / 6)
    : drag.y > innerHeight - band ? Math.ceil((drag.y - innerHeight + band) / 6) : 0;
  if (speed) { window.scrollBy(0, Math.max(-16, Math.min(16, speed))); updateDrag(drag.x, drag.y); }
  autoScrollFrame = requestAnimationFrame(autoScroll);
}

function startDrag() {
  if (!drag || busy || !ready) { cancelDrag(); return; }
  clearTimeout(drag.timer);
  drag.active = true;
  selectedId = drag.id;
  renderControls();
  const ghost = document.createElement('img');
  ghost.src = imageURL(state.photos.get(drag.id));
  ghost.className = 'drag-ghost';
  ghost.alt = '';
  ghost.setAttribute('aria-hidden', 'true');
  drag.ghost = ghost;
  document.body.append(ghost);
  cardFor(drag.id)?.classList.add('is-dragging');
  document.body.classList.add('is-arranging');
  updateDrag(drag.x, drag.y);
  autoScrollFrame = requestAnimationFrame(autoScroll);
  announce('사진을 이동할 위치에 놓아주세요.', 'normal', false);
}

function cancelDrag() {
  if (!drag) return;
  clearTimeout(drag.timer);
  cancelAnimationFrame(autoScrollFrame);
  if (drag.active) suppressClickUntil = Date.now() + 500;
  drag.ghost?.remove();
  document.body.classList.remove('is-arranging');
  for (const card of ui['photo-grid'].children) card.classList.remove('is-dragging', 'is-drop-target');
  drag = null;
}

function finishDrag() {
  if (!drag) return;
  const { id, targetId, active } = drag;
  cancelDrag();
  if (active && targetId) movePhoto(id, state.order.indexOf(targetId));
  else if (active) announce('이동을 취소했어요.', 'normal', false);
}

function bindDragInteractions() {
  ui['photo-grid'].addEventListener('pointerdown', event => {
    if (event.pointerType === 'touch' || event.button !== 0 || busy || !ready) return;
    const card = event.target.closest('.photo-card');
    if (!card) return;
    cancelDrag();
    drag = { id: card.dataset.id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, active: false, kind: 'pointer' };
  });
  document.addEventListener('pointermove', event => {
    if (!drag || drag.kind !== 'pointer' || drag.pointerId !== event.pointerId) return;
    drag.x = event.clientX; drag.y = event.clientY;
    if (!drag.active && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) >= 5) startDrag();
    if (drag?.active) { event.preventDefault(); updateDrag(event.clientX, event.clientY); }
  });
  document.addEventListener('pointerup', event => {
    if (drag?.kind === 'pointer' && drag.pointerId === event.pointerId) finishDrag();
  });
  document.addEventListener('pointercancel', event => {
    if (drag?.kind === 'pointer' && drag.pointerId === event.pointerId) cancelDrag();
  });
  ui['photo-grid'].addEventListener('touchstart', event => {
    if (event.touches.length !== 1) { cancelDrag(); return; }
    if (busy || !ready) return;
    const card = event.target.closest('.photo-card');
    if (!card) return;
    const touch = event.touches[0];
    cancelDrag();
    drag = { id: card.dataset.id, touchId: touch.identifier, startX: touch.clientX, startY: touch.clientY, x: touch.clientX, y: touch.clientY, active: false, kind: 'touch' };
    drag.timer = setTimeout(startDrag, 350);
  }, { passive: true });
  document.addEventListener('touchmove', event => {
    if (!drag || drag.kind !== 'touch') return;
    if (event.touches.length !== 1) { cancelDrag(); return; }
    const touch = [...event.touches].find(item => item.identifier === drag.touchId);
    if (!touch) { cancelDrag(); return; }
    if (!drag.active) {
      if (Math.hypot(touch.clientX - drag.startX, touch.clientY - drag.startY) > 8) cancelDrag();
      return; // A normal swipe remains native scrolling until long-press activates.
    }
    if (event.cancelable) event.preventDefault();
    updateDrag(touch.clientX, touch.clientY);
  }, { passive: false });
  document.addEventListener('touchend', event => {
    if (!drag || drag.kind !== 'touch') return;
    if (![...event.changedTouches].some(touch => touch.identifier === drag.touchId)) return;
    if (drag.active && event.cancelable) event.preventDefault();
    finishDrag();
  }, { passive: false });
  document.addEventListener('touchcancel', cancelDrag);
  ui['photo-grid'].addEventListener('contextmenu', event => { if (event.target.closest('.photo-card')) event.preventDefault(); });
  ui['photo-grid'].addEventListener('dragstart', event => event.preventDefault());
  window.addEventListener('blur', cancelDrag);
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancelDrag(); });
}

function bindEvents() {
  const openPicker = () => { if (!busy && ready) ui['photo-input'].click(); };
  ui['add-photos'].addEventListener('click', openPicker);
  ui['empty-add'].addEventListener('click', openPicker);
  ui['photo-input'].addEventListener('change', event => { importFiles(event.target.files); event.target.value = ''; });
  ui['ratio-portrait'].addEventListener('click', () => setRatio('portrait'));
  ui['ratio-square'].addEventListener('click', () => setRatio('square'));
  ui['clear-selection'].addEventListener('click', () => selectPhoto(null));
  ui['move-before'].addEventListener('click', () => movePhoto(selectedId, state.order.indexOf(selectedId) - 1));
  ui['move-after'].addEventListener('click', () => movePhoto(selectedId, state.order.indexOf(selectedId) + 1));
  ui['delete-photo'].addEventListener('click', () => deletePhoto(selectedId));
  ui['undo-delete'].addEventListener('click', undoDelete);
  ui['dismiss-undo'].addEventListener('click', () => { undoDismissed = true; renderControls(); });
  ui['photo-grid'].addEventListener('click', event => {
    if (Date.now() < suppressClickUntil) return;
    const card = event.target.closest('.photo-card');
    if (card) selectPhoto(card.dataset.id === selectedId ? null : card.dataset.id);
  });
  ui['photo-grid'].addEventListener('keydown', event => {
    const card = event.target.closest('.photo-card');
    if (!card || busy || !ready || event.altKey || event.ctrlKey || event.metaKey) return;
    const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -3, ArrowDown: 3 }[event.key];
    if (delta) { event.preventDefault(); selectPhoto(card.dataset.id); movePhoto(card.dataset.id, state.order.indexOf(card.dataset.id) + delta); }
    else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); deletePhoto(card.dataset.id); }
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { cancelDrag(); selectPhoto(null); }
  });
  const isFiles = event => Array.from(event.dataTransfer?.types || []).includes('Files');
  let dragDepth = 0;
  ui['drop-zone'].addEventListener('dragenter', event => {
    if (!isFiles(event)) return;
    event.preventDefault(); dragDepth += 1;
    if (!busy) ui['drop-zone'].classList.add('is-file-over');
  });
  ui['drop-zone'].addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) ui['drop-zone'].classList.remove('is-file-over');
  });
  ui['drop-zone'].addEventListener('dragover', event => { if (isFiles(event)) { event.preventDefault(); event.dataTransfer.dropEffect = busy ? 'none' : 'copy'; } });
  ui['drop-zone'].addEventListener('drop', event => {
    if (!isFiles(event)) return;
    event.preventDefault(); dragDepth = 0;
    ui['drop-zone'].classList.remove('is-file-over');
    importFiles(event.dataTransfer.files);
  });
  // Dropping outside the import surface must not navigate away from this app.
  window.addEventListener('dragover', event => { if (isFiles(event)) event.preventDefault(); });
  window.addEventListener('drop', event => { if (isFiles(event)) event.preventDefault(); });
  bindDragInteractions();
  window.addEventListener('pagehide', event => {
    cancelDrag();
    // Keep URLs intact for back/forward-cache restores; revoke on real unload.
    if (!event.persisted) {
      for (const url of objectURLs.values()) URL.revokeObjectURL(url);
      objectURLs.clear();
    }
  });
}

async function init() {
  bindEvents();
  renderControls();
  try {
    state = await loadState();
    ready = true;
    storageStatus(state.order.length ? '이 브라우저에 자동 저장됨' : '추가한 사진은 이 브라우저에만 저장돼요');
  } catch (error) {
    storageStatus('저장을 사용할 수 없어요 · 새로고침해 주세요', 'error');
    announce(error.message || '사진 저장을 사용할 수 없어요. 일반 브라우저 모드에서 다시 열어주세요.', 'error');
  }
  renderGrid();
  if ('serviceWorker' in navigator && globalThis.isSecureContext) {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      // Online editing remains usable if offline installation is unavailable.
      announce('오프라인 준비를 마치지 못했어요. 인터넷 연결 상태에서 계속 사용할 수 있어요.', 'normal', false);
    });
  }
}

init();
