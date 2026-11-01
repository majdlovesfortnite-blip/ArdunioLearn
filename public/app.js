'use strict';
const $ = id => document.getElementById(id);
let mode = 'login';
let lessons = [];
let completed = new Set();
let current = null;

async function api(url, body) {
  const res = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function show(id) {
  for (const s of ['auth', 'path', 'lesson']) $(s).hidden = s !== id;
  $('logout').hidden = id === 'auth';
}

$('toggle-auth').onclick = e => {
  e.preventDefault();
  mode = mode === 'login' ? 'signup' : 'login';
  $('auth-title').textContent = mode === 'login' ? 'Log in' : 'Create account';
  $('auth-submit').textContent = mode === 'login' ? 'Log in' : 'Sign up';
  $('toggle-auth').textContent = mode === 'login' ? 'Need an account? Sign up' : 'Have an account? Log in';
  $('auth-error').textContent = '';
};

$('auth-form').onsubmit = async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    await api(mode === 'login' ? '/api/login' : '/api/register',
      { email: f.get('email'), password: f.get('password') });
    e.target.reset();
    $('auth-error').textContent = '';
    await loadApp();
  } catch (err) {
    $('auth-error').textContent = err.message;
  }
};

function renderPath() {
  const ul = $('lesson-list');
  ul.replaceChildren();
  lessons.forEach((l, i) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    const locked = i > 0 && !completed.has(lessons[i - 1].id);
    btn.textContent = (completed.has(l.id) ? '✓ ' : '') + l.title;  // textContent: never innerHTML with server data
    btn.disabled = locked;
    btn.onclick = () => openLesson(l);
    li.append(btn);
    ul.append(li);
  });
}

function openLesson(l) {
  current = l;
  $('lesson-title').textContent = l.title;
  $('lesson-text').textContent = l.text;
  $('editor').value = l.starter;
  $('output').textContent = '';
  $('sim').src = l.wokwi.startsWith('REPLACE') ? 'about:blank'
    : `https://wokwi.com/projects/${encodeURIComponent(l.wokwi)}`;
  show('lesson');
}

async function loadApp() {
  try {
    await api('/api/me');
  } catch {
    show('auth');
    return;
  }
  const [l, p] = await Promise.all([api('/api/lessons'), api('/api/progress')]);
  lessons = l.lessons;
  completed = new Set(p.completed);
  renderPath();
  show('path');
}

$('compile').onclick = async () => {
  $('output').textContent = 'Compiling…';
  try {
    const r = await api('/api/compile', { code: $('editor').value });
    $('output').textContent = (r.success ? 'Compiled successfully.\n' : 'Compile failed.\n') + r.output;
  } catch (err) {
    $('output').textContent = err.message;
  }
};

$('complete').onclick = async () => {
  try {
    await api('/api/progress', { lessonId: current.id });
    completed.add(current.id);
    renderPath();
    show('path');
  } catch (err) {
    $('output').textContent = err.message;
  }
};

$('back').onclick = e => { e.preventDefault(); renderPath(); show('path'); };

$('logout').onclick = async () => {
  await api('/api/logout', {});
  completed = new Set();
  show('auth');
};

loadApp();
