const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'workouts.json');
const PORT = Number(process.env.PORT) || 3000;
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || '';
const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function readWorkouts() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]', 'utf8');
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function writeWorkouts(workouts) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(workouts, null, 2), 'utf8');
}

function isPublicSupabaseKey(key) {
  if (key.startsWith('sb_secret_')) return false;
  try {
    const payload = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString('utf8'));
    return payload.role !== 'service_role';
  } catch {
    return key.startsWith('sb_publishable_');
  }
}

function publicWorkout({ userId, ...workout }) {
  return workout;
}

async function authenticateRequest(request) {
  const token = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return null;

  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!response.ok) return null;
  const user = await response.json();
  return typeof user.id === 'string' ? { user, token } : null;
}

async function supabaseTableRequest(pathname, token, options = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${pathname}`, {
    ...options,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  const text = await response.text();
  const result = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(result?.message || 'تعذر التواصل مع جدول المجموعات.');
  return result;
}

function sendJson(response, status, payload) {
  response.writeHead(status, { 'Content-Type': MIME_TYPES['.json'] });
  response.end(JSON.stringify(payload));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) reject(new Error('حجم الطلب أكبر من المسموح.'));
    });
    request.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('تعذر قراءة بيانات الطلب.'));
      }
    });
    request.on('error', reject);
  });
}

async function handleApi(request, response, pathname) {
  if (request.method === 'GET' && pathname === '/api/config') {
    const configured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY && isPublicSupabaseKey(SUPABASE_ANON_KEY));
    return sendJson(response, 200, {
      configured,
      url: configured ? SUPABASE_URL : null,
      anonKey: configured ? SUPABASE_ANON_KEY : null,
    });
  }

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !isPublicSupabaseKey(SUPABASE_ANON_KEY)) {
    return sendJson(response, 503, { error: 'لم يتم إعداد اتصال Supabase.' });
  }
  const auth = await authenticateRequest(request);
  if (!auth) return sendJson(response, 401, { error: 'سجّل الدخول للمتابعة.' });
  const { user, token } = auth;

  if (request.method === 'GET' && pathname === '/api/workouts') {
    const workouts = readWorkouts().filter((workout) => workout.userId === user.id);
    const query = new URLSearchParams({
      select: 'id,workout_id,exercise,weight,reps,completed_at',
      user_id: `eq.${user.id}`,
      order: 'completed_at.asc',
    });
    const rows = await supabaseTableRequest(`workout_sets?${query}`, token);
    const setsByWorkout = new Map();
    for (const row of rows) {
      const sets = setsByWorkout.get(row.workout_id) || [];
      sets.push({ id: row.id, exercise: row.exercise, weight: Number(row.weight), reps: row.reps, completedAt: row.completed_at });
      setsByWorkout.set(row.workout_id, sets);
    }
    return sendJson(response, 200, workouts.map((workout) => publicWorkout({
      ...workout,
      sets: [...(Array.isArray(workout.sets) ? workout.sets : []), ...(setsByWorkout.get(workout.id) || [])],
    })));
  }

  if (request.method === 'POST' && pathname === '/api/workouts') {
    const workouts = readWorkouts();
    const active = workouts.find((workout) => workout.userId === user.id && !workout.finishedAt);
    if (active) return sendJson(response, 200, publicWorkout(active));

    const workout = { id: randomUUID(), userId: user.id, startedAt: new Date().toISOString(), finishedAt: null, sets: [] };
    workouts.unshift(workout);
    writeWorkouts(workouts);
    return sendJson(response, 201, publicWorkout(workout));
  }

  const finishMatch = pathname.match(/^\/api\/workouts\/([^/]+)\/finish$/);
  if (request.method === 'POST' && finishMatch) {
    const workouts = readWorkouts();
    const workout = workouts.find((entry) => entry.id === finishMatch[1] && entry.userId === user.id);
    if (!workout) return sendJson(response, 404, { error: 'لم نعثر على جلسة التمرين.' });
    workout.finishedAt = new Date().toISOString();
    writeWorkouts(workouts);
    return sendJson(response, 200, publicWorkout(workout));
  }

  const setsMatch = pathname.match(/^\/api\/workouts\/([^/]+)\/sets$/);
  if (request.method === 'POST' && setsMatch) {
    const body = await readBody(request);
    const exercise = typeof body.exercise === 'string' ? body.exercise.trim().slice(0, 60) : '';
    const reps = Number(body.reps);
    const weight = Number(body.weight);
    if (!exercise || !Number.isInteger(reps) || reps < 1 || reps > 1000 || !Number.isFinite(weight) || weight < 0 || weight > 10000) {
      return sendJson(response, 400, { error: 'أدخل تمرينًا وتكرارات ووزنًا صالحًا.' });
    }

    const workouts = readWorkouts();
    const workout = workouts.find((entry) => entry.id === setsMatch[1] && entry.userId === user.id && !entry.finishedAt);
    if (!workout) return sendJson(response, 404, { error: 'جلسة التمرين غير موجودة أو منتهية.' });
    const [row] = await supabaseTableRequest('workout_sets', token, {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ workout_id: workout.id, exercise, reps, weight }),
    });
    const set = { id: row.id, exercise: row.exercise, reps: row.reps, weight: Number(row.weight), completedAt: row.completed_at };
    return sendJson(response, 201, set);
  }

  const deleteSetMatch = pathname.match(/^\/api\/workouts\/([^/]+)\/sets\/([^/]+)$/);
  if (request.method === 'DELETE' && deleteSetMatch) {
    const workouts = readWorkouts();
    const workout = workouts.find((entry) => entry.id === deleteSetMatch[1] && entry.userId === user.id && !entry.finishedAt);
    if (!workout) return sendJson(response, 404, { error: 'جلسة التمرين غير موجودة أو منتهية.' });
    const query = new URLSearchParams({ id: `eq.${deleteSetMatch[2]}`, workout_id: `eq.${workout.id}`, select: 'id' });
    const deleted = await supabaseTableRequest(`workout_sets?${query}`, token, {
      method: 'DELETE',
      headers: { Prefer: 'return=representation' },
    });
    if (deleted.length) return sendJson(response, 200, { ok: true });

    const originalLength = Array.isArray(workout.sets) ? workout.sets.length : 0;
    workout.sets = (workout.sets || []).filter((set) => set.id !== deleteSetMatch[2]);
    if (workout.sets.length === originalLength) return sendJson(response, 404, { error: 'لم نعثر على المجموعة.' });
    writeWorkouts(workouts);
    return sendJson(response, 200, { ok: true });
  }

  return sendJson(response, 404, { error: 'المسار غير موجود.' });
}

const server = http.createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname.startsWith('/api/')) return await handleApi(request, response, pathname);

    const requestedFile = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
    const filePath = path.resolve(ROOT, requestedFile);
    if (!filePath.startsWith(`${ROOT}${path.sep}`) && filePath !== path.join(ROOT, 'index.html')) {
      return sendJson(response, 403, { error: 'غير مسموح.' });
    }

    fs.readFile(filePath, (error, content) => {
      if (error) return sendJson(response, 404, { error: 'الملف غير موجود.' });
      response.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream' });
      response.end(content);
    });
  } catch (error) {
    sendJson(response, 400, { error: error.message || 'حدث خطأ غير متوقع.' });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Gym log is running at http://127.0.0.1:${PORT}`);
});