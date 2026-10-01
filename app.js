const $ = (selector) => document.querySelector(selector);
const arabicDigits = new Intl.NumberFormat('ar');
const dateTimeFormatter = new Intl.DateTimeFormat('ar', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const durationInput = $('#duration-input');
const timerStorageKey = 'idda-rest-timer-v1';
const guestStorageKey = 'idda-guest-workouts-v1';

let workouts = [];
let activeWorkout = null;
let timerState = loadTimer();
let noticeTimeout;
let timerAudioContext;
let supabaseClient = null;
let currentUserId = null;
let authMode = 'login';
let isGuestMode = false;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function loadGuestWorkouts() {
  try {
    const saved = JSON.parse(localStorage.getItem(guestStorageKey));
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function saveGuestWorkouts(guestWorkouts) {
  localStorage.setItem(guestStorageKey, JSON.stringify(guestWorkouts));
}

function guestApi(path, options = {}) {
  const method = options.method || 'GET';
  const guestWorkouts = loadGuestWorkouts();
  if (method === 'GET' && path === '/api/workouts') return guestWorkouts;

  if (method === 'POST' && path === '/api/workouts') {
    const active = guestWorkouts.find((workout) => !workout.finishedAt);
    if (active) return active;
    const workout = { id: crypto.randomUUID(), startedAt: new Date().toISOString(), finishedAt: null, sets: [] };
    guestWorkouts.unshift(workout);
    saveGuestWorkouts(guestWorkouts);
    return workout;
  }

  const finishMatch = path.match(/^\/api\/workouts\/([^/]+)\/finish$/);
  if (method === 'POST' && finishMatch) {
    const workout = guestWorkouts.find((entry) => entry.id === decodeURIComponent(finishMatch[1]));
    if (!workout) throw new Error('لم نعثر على جلسة التمرين.');
    workout.finishedAt = new Date().toISOString();
    saveGuestWorkouts(guestWorkouts);
    return workout;
  }

  const setsMatch = path.match(/^\/api\/workouts\/([^/]+)\/sets$/);
  if (method === 'POST' && setsMatch) {
    const body = JSON.parse(options.body || '{}');
    const exercise = typeof body.exercise === 'string' ? body.exercise.trim().slice(0, 60) : '';
    const reps = Number(body.reps);
    const weight = Number(body.weight);
    if (!exercise || !Number.isInteger(reps) || reps < 1 || reps > 1000 || !Number.isFinite(weight) || weight < 0 || weight > 10000) {
      throw new Error('أدخل تمرينًا وتكرارات ووزنًا صالحًا.');
    }
    const workout = guestWorkouts.find((entry) => entry.id === decodeURIComponent(setsMatch[1]) && !entry.finishedAt);
    if (!workout) throw new Error('جلسة التمرين غير موجودة أو منتهية.');
    const set = { id: crypto.randomUUID(), exercise, reps, weight, completedAt: new Date().toISOString() };
    workout.sets.push(set);
    saveGuestWorkouts(guestWorkouts);
    return set;
  }

  const deleteSetMatch = path.match(/^\/api\/workouts\/([^/]+)\/sets\/([^/]+)$/);
  if (method === 'DELETE' && deleteSetMatch) {
    const workout = guestWorkouts.find((entry) => entry.id === decodeURIComponent(deleteSetMatch[1]) && !entry.finishedAt);
    if (!workout) throw new Error('جلسة التمرين غير موجودة أو منتهية.');
    const originalLength = workout.sets.length;
    workout.sets = workout.sets.filter((set) => set.id !== decodeURIComponent(deleteSetMatch[2]));
    if (workout.sets.length === originalLength) throw new Error('لم نعثر على المجموعة.');
    saveGuestWorkouts(guestWorkouts);
    return { ok: true };
  }

  throw new Error('المسار غير موجود.');
}

async function api(path, options = {}) {
  if (isGuestMode) return guestApi(path, options);
  if (!supabaseClient) throw new Error('تعذر تهيئة تسجيل الدخول.');
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) throw new Error('سجّل الدخول للمتابعة.');
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}`, ...options.headers },
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'تعذر إكمال الطلب.');
  return result;
}

function showNotice(message, success = false) {
  const notice = $('#notice');
  notice.textContent = message;
  notice.classList.toggle('success', success);
  notice.hidden = false;
  clearTimeout(noticeTimeout);
  noticeTimeout = setTimeout(() => { notice.hidden = true; }, 3500);
}

function showAuthNotice(message, success = false) {
  const notice = $('#auth-notice');
  notice.textContent = message;
  notice.classList.toggle('success', success);
  notice.hidden = false;
}

function setAuthMode(mode) {
  authMode = mode;
  const signingUp = mode === 'signup';
  $('#auth-mode-login').setAttribute('aria-pressed', String(!signingUp));
  $('#auth-mode-signup').setAttribute('aria-pressed', String(signingUp));
  $('#auth-heading').textContent = signingUp ? 'أنشئ حسابك' : 'مرحبًا بعودتك';
  $('#auth-copy').textContent = signingUp ? 'أنشئ حسابًا لحفظ جلساتك بأمان.' : 'سجّل الدخول لمتابعة جلساتك.';
  $('#auth-submit').textContent = signingUp ? 'إنشاء الحساب' : 'دخول';
  $('#auth-password').autocomplete = signingUp ? 'new-password' : 'current-password';
  $('#auth-notice').hidden = true;
}

function authErrorMessage(error) {
  if (error.message.includes('Invalid login credentials')) return 'البريد الإلكتروني أو كلمة المرور غير صحيحة.';
  if (error.message.includes('Email not confirmed')) return 'أكد بريدك الإلكتروني قبل تسجيل الدخول.';
  if (error.message.includes('User already registered')) return 'هذا البريد الإلكتروني مسجل بالفعل.';
  return error.message;
}

async function applyAuthSession(session) {
  const user = session?.user;
  isGuestMode = false;
  $('#auth-gate').hidden = Boolean(user);
  $('#app-content').hidden = !user;
  $('#account-meta').hidden = !user;
  $('#sign-out').textContent = 'تسجيل الخروج';

  if (!user) {
    currentUserId = null;
    workouts = [];
    activeWorkout = null;
    return;
  }

  $('#account-email').textContent = user.email || '';
  if (currentUserId === user.id) return;
  currentUserId = user.id;
  try {
    await refreshData();
  } catch (error) {
    showNotice(error.message);
  }
}

async function enterGuestMode() {
  isGuestMode = true;
  currentUserId = 'guest';
  $('#auth-gate').hidden = true;
  $('#app-content').hidden = false;
  $('#account-meta').hidden = false;
  $('#account-email').textContent = 'ضيف';
  $('#sign-out').textContent = 'إنهاء وضع الضيف';
  await refreshData();
}

$('#auth-mode-login').addEventListener('click', () => setAuthMode('login'));
$('#auth-mode-signup').addEventListener('click', () => setAuthMode('signup'));
$('#guest-continue').addEventListener('click', () => { void enterGuestMode(); });

$('#auth-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#auth-submit');
  button.disabled = true;
  $('#auth-notice').hidden = true;
  try {
    const email = $('#auth-email').value.trim();
    const password = $('#auth-password').value;
    const result = authMode === 'signup'
      ? await supabaseClient.auth.signUp({ email, password })
      : await supabaseClient.auth.signInWithPassword({ email, password });
    if (result.error) throw result.error;
    if (authMode === 'signup' && !result.data.session) {
      showAuthNotice('تحقق من بريدك الإلكتروني لتأكيد الحساب.', true);
    } else if (result.data.session) {
      await applyAuthSession(result.data.session);
    }
  } catch (error) {
    showAuthNotice(authErrorMessage(error));
  } finally {
    button.disabled = false;
  }
});

$('#sign-out').addEventListener('click', async () => {
  if (isGuestMode) {
    isGuestMode = false;
    currentUserId = null;
    workouts = [];
    activeWorkout = null;
    $('#auth-gate').hidden = false;
    $('#app-content').hidden = true;
    $('#account-meta').hidden = true;
    setAuthMode('login');
    return;
  }
  const { error } = await supabaseClient.auth.signOut();
  if (error) showNotice(authErrorMessage(error));
});

function formatDuration(milliseconds) {
  const totalMinutes = Math.floor(milliseconds / 60000);
  const seconds = Math.floor((milliseconds % 60000) / 1000);
  return `${String(totalMinutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function durationWords(seconds) {
  if (seconds < 60) return `${arabicDigits.format(seconds)} ثانية`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${arabicDigits.format(minutes)} د و${arabicDigits.format(remainder)} ث` : `${arabicDigits.format(minutes)} دقيقة`;
}

function groupSets(sets) {
  return sets.reduce((groups, set) => {
    groups[set.exercise] = (groups[set.exercise] || 0) + 1;
    return groups;
  }, {});
}

function renderWorkout() {
  const sets = activeWorkout?.sets || [];
  const exerciseGroups = groupSets(sets);
  const active = Boolean(activeWorkout);
  $('#workout-state').textContent = active ? 'جلسة نشطة' : 'لا توجد جلسة نشطة';
  $('.live-label').classList.toggle('is-active', active);
  $('#set-count').textContent = arabicDigits.format(sets.length);
  $('#exercise-count').textContent = arabicDigits.format(Object.keys(exerciseGroups).length);
  $('#sets-caption').textContent = `${arabicDigits.format(sets.length)} مجموعات`;
  $('#started-label').textContent = active
    ? `بدأت ${dateTimeFormatter.format(new Date(activeWorkout.startedAt))}`
    : 'تبدأ جلستك مع أول مجموعة';
  $('#finish-workout').disabled = !active;

  $('#sets-list').innerHTML = sets.slice().reverse().map((set, index) => `
    <div class="set-row">
      <span class="set-number">${arabicDigits.format(sets.length - index)}</span>
      <span class="set-exercise" title="${escapeHtml(set.exercise)}">${escapeHtml(set.exercise)}</span>
      <span class="set-value">${arabicDigits.format(set.weight)} <span>كجم</span></span>
      <span class="set-value">${arabicDigits.format(set.reps)} <span>تكرار</span></span>
      <button class="delete-set" type="button" data-set-id="${escapeHtml(set.id)}" aria-label="حذف مجموعة ${escapeHtml(set.exercise)}">×</button>
    </div>`).join('');
  $('#empty-sets').hidden = sets.length > 0;
  $('#set-form').querySelector('button').disabled = false;
}

function renderHistory() {
  const history = workouts.filter((workout) => workout.finishedAt);
  $('#history-total').textContent = arabicDigits.format(history.length);
  $('#empty-history').hidden = history.length > 0;
  $('#history-list').innerHTML = history.slice(0, 5).map((workout) => {
    const duration = Math.max(0, new Date(workout.finishedAt) - new Date(workout.startedAt));
    const groups = groupSets(workout.sets);
    const exercises = Object.entries(groups).map(([name, count]) => `${escapeHtml(name)} <span>× ${arabicDigits.format(count)}</span>`).join('، ');
    return `<article class="history-card">
      <div class="history-card-top"><time class="history-date">${dateTimeFormatter.format(new Date(workout.startedAt))}</time><span class="history-duration">${formatDuration(duration)}</span></div>
      <div class="history-meta"><span>${arabicDigits.format(workout.sets.length)} مجموعة</span><span>${arabicDigits.format(Object.keys(groups).length)} تمرين</span></div>
      ${exercises ? `<div class="history-exercises">${exercises}</div>` : ''}
    </article>`;
  }).join('');
}

function render() {
  renderWorkout();
  renderHistory();
}

function loadTimer() {
  try {
    const saved = JSON.parse(localStorage.getItem(timerStorageKey));
    if (!saved || typeof saved !== 'object') return { endAt: null, remainingMs: 90000, paused: false };
    return {
      endAt: Number.isFinite(saved.endAt) ? saved.endAt : null,
      remainingMs: Number.isFinite(saved.remainingMs) ? saved.remainingMs : 90000,
      paused: Boolean(saved.paused),
    };
  } catch {
    return { endAt: null, remainingMs: 90000, paused: false };
  }
}

function saveTimer() {
  localStorage.setItem(timerStorageKey, JSON.stringify(timerState));
}

function unlockTimerAudio() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;
  try {
    timerAudioContext ||= new AudioContext();
    if (timerAudioContext.state === 'suspended') timerAudioContext.resume().catch(() => { });
  } catch { }
}

function playTimerBeep() {
  if (!timerAudioContext) return;
  timerAudioContext.resume().then(() => {
    const oscillator = timerAudioContext.createOscillator();
    const gain = timerAudioContext.createGain();
    const now = timerAudioContext.currentTime;
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(880, now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.22, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);
    oscillator.connect(gain);
    gain.connect(timerAudioContext.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.46);
  }).catch(() => { });
}

function updateTimer() {
  let remainingMs = timerState.remainingMs;
  if (timerState.endAt && !timerState.paused) remainingMs = Math.max(0, timerState.endAt - Date.now());
  const seconds = Math.ceil(remainingMs / 1000);
  $('#timer-display').textContent = formatDuration(remainingMs);
  $('#timer-subtitle').textContent = seconds ? durationWords(seconds) : 'حان وقت المجموعة التالية';
  $('#timer-caption').textContent = timerState.endAt && !timerState.paused ? 'وقت الراحة' : 'جاهز؟';
  $('#timer-toggle').textContent = timerState.endAt && !timerState.paused ? 'إيقاف مؤقت' : timerState.paused ? 'استئناف' : 'ابدأ الراحة';
  $('#timer-face').classList.toggle('is-running', Boolean(timerState.endAt && !timerState.paused && remainingMs > 0));

  if (timerState.endAt && remainingMs <= 0) {
    timerState = { endAt: null, remainingMs: 0, paused: false };
    saveTimer();
    $('#timer-caption').textContent = 'انتهت الراحة';
    $('#timer-toggle').textContent = 'ابدأ من جديد';
    $('#timer-face').classList.remove('is-running');
    playTimerBeep();
    if ('Notification' in window && Notification.permission === 'granted') new Notification('انتهت الراحة', { body: 'حان وقت مجموعتك التالية.' });
  }
  $('#elapsed-time').textContent = activeWorkout ? formatDuration(Date.now() - new Date(activeWorkout.startedAt).getTime()) : '٠٠:٠٠';
}

function startTimer(seconds = Number(durationInput.value)) {
  const safeSeconds = Math.min(600, Math.max(15, Math.round(seconds)));
  timerState = { endAt: Date.now() + safeSeconds * 1000, remainingMs: safeSeconds * 1000, paused: false };
  saveTimer();
  updateTimer();
}

async function refreshData() {
  workouts = await api('/api/workouts');
  activeWorkout = workouts.find((workout) => !workout.finishedAt) || null;
  render();
}

$('#set-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  unlockTimerAudio();
  const exercise = $('#exercise-input').value.trim();
  if (!exercise) {
    $('#exercise-input').focus();
    return showNotice('اكتب اسم التمرين أولًا.');
  }

  try {
    if (!activeWorkout) activeWorkout = await api('/api/workouts', { method: 'POST', body: '{}' });
    const set = await api(`/api/workouts/${encodeURIComponent(activeWorkout.id)}/sets`, {
      method: 'POST',
      body: JSON.stringify({ exercise, weight: $('#weight-input').value, reps: $('#reps-input').value }),
    });
    activeWorkout.sets.push(set);
    if (!workouts.some((workout) => workout.id === activeWorkout.id)) workouts.unshift(activeWorkout);
    render();
    showNotice('تم تسجيل المجموعة. راحة موفقة.', true);
    startTimer(Number(durationInput.value));
    $('#reps-input').focus();
  } catch (error) {
    showNotice(error.message);
  }
});

$('#sets-list').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-set-id]');
  if (!button || !activeWorkout) return;
  try {
    await api(`/api/workouts/${encodeURIComponent(activeWorkout.id)}/sets/${encodeURIComponent(button.dataset.setId)}`, { method: 'DELETE' });
    activeWorkout.sets = activeWorkout.sets.filter((set) => set.id !== button.dataset.setId);
    renderWorkout();
  } catch (error) { showNotice(error.message); }
});

$('#finish-workout').addEventListener('click', async () => {
  if (!activeWorkout || !window.confirm('إنهاء جلسة التمرين؟')) return;
  try {
    const finished = await api(`/api/workouts/${encodeURIComponent(activeWorkout.id)}/finish`, { method: 'POST', body: '{}' });
    workouts = workouts.map((workout) => workout.id === finished.id ? finished : workout);
    activeWorkout = null;
    render();
    showNotice('انتهت الجلسة وحُفظت في السجل.', true);
  } catch (error) { showNotice(error.message); }
});

$('#timer-toggle').addEventListener('click', () => {
  if (timerState.endAt && !timerState.paused) {
    timerState.remainingMs = Math.max(0, timerState.endAt - Date.now());
    timerState.endAt = null;
    timerState.paused = true;
    saveTimer();
    updateTimer();
  } else {
    unlockTimerAudio();
    startTimer(timerState.paused ? timerState.remainingMs / 1000 : Number(durationInput.value));
  }
});

$('#timer-add').addEventListener('click', () => {
  unlockTimerAudio();
  const remaining = timerState.endAt && !timerState.paused
    ? Math.max(0, timerState.endAt - Date.now())
    : timerState.remainingMs;
  const next = Math.min(600, Math.ceil(remaining / 1000) + 30);
  startTimer(next || 30);
});

$('#timer-reset').addEventListener('click', () => {
  timerState = { endAt: null, remainingMs: Number(durationInput.value) * 1000, paused: false };
  saveTimer();
  updateTimer();
});

durationInput.addEventListener('change', () => {
  const duration = Math.min(600, Math.max(15, Math.round(Number(durationInput.value) / 15) * 15));
  durationInput.value = String(duration);
  if (!timerState.endAt && !timerState.paused) {
    timerState.remainingMs = duration * 1000;
    saveTimer();
    updateTimer();
  }
});

async function initialize() {
  try {
    const response = await fetch('/api/config');
    if (!response.ok) throw new Error('تعذر قراءة إعدادات تسجيل الدخول.');
    const config = await response.json();
    if (!config.configured) {
      $('#auth-form').hidden = true;
      $('#auth-modes').hidden = true;
      $('#auth-config-note').hidden = false;
    } else if (!window.supabase?.createClient) {
      showAuthNotice('تعذر تحميل مكتبة Supabase. تحقق من اتصال الإنترنت ثم أعد تحميل الصفحة.');
    } else {
      supabaseClient = window.supabase.createClient(config.url, config.anonKey);
      supabaseClient.auth.onAuthStateChange((_event, session) => {
        setTimeout(() => { void applyAuthSession(session); }, 0);
      });
      const { data, error } = await supabaseClient.auth.getSession();
      if (error) throw error;
      await applyAuthSession(data.session);
    }
  } catch (error) {
    showAuthNotice(error.message);
  }
  if (!timerState.endAt && !timerState.paused && timerState.remainingMs === 90000) {
    timerState.remainingMs = Number(durationInput.value) * 1000;
  }
  updateTimer();
  setInterval(updateTimer, 250);
  setInterval(() => {
    if (activeWorkout) $('#elapsed-time').textContent = formatDuration(Date.now() - new Date(activeWorkout.startedAt).getTime());
  }, 1000);
}

setAuthMode('login');
initialize();