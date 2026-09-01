/* LeaveBy app shell. All schedule math lives in js/schedule.js (window.Schedule). */
(function () {
  'use strict';

  var S = window.Schedule;
  var KEY = { routine: 'leaveby.routine', run: 'leaveby.run', stats: 'leaveby.stats' };

  var STARTER = {
    v: 1,
    leaveAt: '07:45',
    steps: [
      { id: 'bath', emoji: '🚽', name: 'Bathroom', minutes: 5, optional: false },
      { id: 'drss', emoji: '👕', name: 'Get dressed', minutes: 5, optional: false },
      { id: 'brek', emoji: '🥣', name: 'Breakfast', minutes: 15, optional: false },
      { id: 'teet', emoji: '🪥', name: 'Brush teeth', minutes: 3, optional: false },
      { id: 'book', emoji: '📖', name: 'Book time', minutes: 5, optional: true },
      { id: 'shoe', emoji: '👟', name: 'Shoes', minutes: 3, optional: false },
      { id: 'coat', emoji: '🧥', name: 'Coat', minutes: 2, optional: false }
    ]
  };

  function $(id) { return document.getElementById(id); }
  function loadJSON(k, dflt) {
    try { var raw = localStorage.getItem(k); return raw ? JSON.parse(raw) : dflt; }
    catch (e) { return dflt; }
  }
  function saveJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function drop(k) { try { localStorage.removeItem(k); } catch (e) {} }
  function uid() { return Math.random().toString(36).slice(2, 8); }
  function ymd(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }
  function hhmm(ms) {
    var d = new Date(ms);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  // localStorage is as untrusted as a share link: normalize or fall back.
  var routine = S.normalizeRoutine(loadJSON(KEY.routine, null)) || STARTER;
  var run = loadJSON(KEY.run, null);
  // A run older than 12h is yesterday's abandoned morning, not a resume.
  if (run && (typeof run.startedAt !== 'number' || !Array.isArray(run.done) ||
      Date.now() - run.startedAt > 12 * 3600000)) {
    run = null;
    drop(KEY.run);
  }
  var stats = loadJSON(KEY.stats, null) ||
    { bankedMin: 0, streak: 0, lastOnTimeDate: null, lastRunDate: null };

  var timer = null;
  var wakeLock = null;
  var seenDropped = null;   // null = first tick of the run, do not flash
  var flashTimer = null;

  function persistRoutine() { saveJSON(KEY.routine, routine); }

  /* ---------------- mode ---------------- */
  function setMode(m) {
    document.body.className = 'mode-' + m;
    if (m !== 'kid' && timer) { clearInterval(timer); timer = null; }
    if (m !== 'finish') clearConfetti();
  }

  /* ---------------- setup ---------------- */
  var stepList = $('stepList');

  function renderSetup() {
    $('leaveAt').value = routine.leaveAt;
    stepList.innerHTML = '';
    routine.steps.forEach(function (s, i) {
      var li = document.createElement('li');
      li.className = 'step' + (s.optional ? ' isOptional' : '');
      li.dataset.i = i;
      li.innerHTML =
        '<input class="emojiIn" data-f="emoji" type="text" maxlength="4" aria-label="Emoji">' +
        '<input class="nameIn" data-f="name" type="text" maxlength="30" aria-label="Step name">' +
        '<span class="minWrap"><input class="minIn" data-f="minutes" type="number" min="1" max="120" aria-label="Minutes"><span>min</span></span>' +
        '<span class="stepFoot">' +
        '<label class="optToggle"><input data-f="optional" type="checkbox">Optional</label>' +
        '<button type="button" class="iconBtn" data-a="up" aria-label="Move up">&#9650;</button>' +
        '<button type="button" class="iconBtn" data-a="down" aria-label="Move down">&#9660;</button>' +
        '<button type="button" class="iconBtn del" data-a="del" aria-label="Delete step">&#10005;</button>' +
        '</span>';
      li.querySelector('[data-f="emoji"]').value = s.emoji;
      li.querySelector('[data-f="name"]').value = s.name;
      li.querySelector('[data-f="minutes"]').value = s.minutes;
      li.querySelector('[data-f="optional"]').checked = !!s.optional;
      stepList.appendChild(li);
    });
    renderPlanLine();
    renderSetupStats();
    $('start').disabled = routine.steps.length === 0;
  }

  function renderPlanLine() {
    var total = routine.steps.reduce(function (n, s) { return n + s.minutes; }, 0);
    var startMs = S.resolveLeaveMs(routine.leaveAt, Date.now()) - total * 60000;
    $('planLine').textContent = routine.steps.length +
      (routine.steps.length === 1 ? ' step, ' : ' steps, ') + total +
      ' min. Start by ' + hhmm(startMs) + '.';
  }

  function renderSetupStats() {
    $('setupStats').textContent = stats.bankedMin > 0 || stats.streak > 0
      ? stats.bankedMin + ' min banked · ' + stats.streak + ' morning streak'
      : '';
  }

  function fieldEdit(e) {
    var li = e.target.closest('.step');
    if (!li) return;
    var s = routine.steps[+li.dataset.i];
    var f = e.target.dataset.f;
    if (!s || !f) return;
    if (f === 'optional') {
      s.optional = e.target.checked;
      li.classList.toggle('isOptional', s.optional);
    } else if (f === 'minutes') {
      var n = parseInt(e.target.value, 10);
      if (!isNaN(n)) s.minutes = Math.max(1, Math.min(120, n));
      if (e.type === 'change') e.target.value = s.minutes;   // clamp visibly on commit
      renderPlanLine();
    } else {
      s[f] = e.target.value;
    }
    persistRoutine();
  }
  stepList.addEventListener('input', fieldEdit);
  stepList.addEventListener('change', fieldEdit);

  stepList.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-a]');
    if (!btn) return;
    var i = +btn.closest('.step').dataset.i;
    var a = btn.dataset.a;
    if (a === 'del') routine.steps.splice(i, 1);
    else if (a === 'up' && i > 0) routine.steps.splice(i - 1, 0, routine.steps.splice(i, 1)[0]);
    else if (a === 'down' && i < routine.steps.length - 1) routine.steps.splice(i + 1, 0, routine.steps.splice(i, 1)[0]);
    else return;
    persistRoutine();
    renderSetup();
  });

  $('leaveAt').addEventListener('change', function () {
    if (!this.value) { this.value = routine.leaveAt; return; }
    routine.leaveAt = this.value;
    persistRoutine();
    renderPlanLine();
  });

  $('addStep').addEventListener('click', function () {
    routine.steps.push({ id: uid(), emoji: '⭐', name: 'New step', minutes: 5, optional: false });
    persistRoutine();
    renderSetup();
    var last = stepList.lastElementChild;
    if (last) last.querySelector('.nameIn').focus();
  });

  $('start').addEventListener('click', function () {
    if (!routine.steps.length) return;
    run = { startedAt: Date.now(), done: [] };
    saveJSON(KEY.run, run);
    enterKid();
  });

  /* ---------------- kid ---------------- */
  var card = $('card');

  function enterKid() {
    seenDropped = null;
    setMode('kid');
    requestWakeLock();
    renderKid();
    if (timer) clearInterval(timer);
    timer = setInterval(renderKid, 250);
    card.focus();
  }

  function renderKid() {
    var t = S.tick(routine, run, Date.now());
    if (t.finished) { finish(); return; }

    flashNewDrops(t.droppedIds);

    card.className = 'card status-' + t.status +
      (card.classList.contains('tapped') ? ' tapped' : '');
    $('cardEmoji').textContent = t.currentStep.emoji;
    $('cardName').textContent = t.currentStep.name;
    $('bar').style.width = (t.stepFraction * 100).toFixed(1) + '%';
    $('hurry').hidden = !t.hurry;
    $('cardMeta').textContent = t.remainingCount + (t.remainingCount === 1 ? ' step to go' : ' steps to go');
  }

  function flashNewDrops(ids) {
    ids = ids || [];
    if (seenDropped === null) { seenDropped = ids.slice(); return; }
    var fresh = ids.filter(function (id) { return seenDropped.indexOf(id) === -1; });
    seenDropped = ids.slice();
    if (!fresh.length) return;
    var names = fresh.map(function (id) {
      var s = routine.steps.find(function (x) { return x.id === id; });
      return s ? s.name : 'a step';
    }).join(' and ');
    var el = $('flash');
    el.textContent = 'Skipping ' + names + ' to make it out the door';
    el.hidden = false;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { el.hidden = true; }, 3000);
  }

  var lastTapAt = 0;
  card.addEventListener('click', function () {
    var nowMs = Date.now();
    if (nowMs - lastTapAt < 600) return; // a kid's excited double-tap is one tap
    lastTapAt = nowMs;
    var t = S.tick(routine, run, nowMs);
    if (t.finished || !t.currentStep) return;
    run.done.push({ id: t.currentStep.id, at: nowMs });
    saveJSON(KEY.run, run);
    card.classList.add('tapped');
    setTimeout(function () { card.classList.remove('tapped'); }, 250);
    renderKid();
  });

  $('back').addEventListener('click', function () {
    if (!run || !run.done.length) return;
    run.done.pop();
    saveJSON(KEY.run, run);
    renderKid();
  });

  function requestWakeLock() {
    try {
      if (!navigator.wakeLock) return;
      navigator.wakeLock.request('screen').then(function (l) { wakeLock = l; }, function () {});
    } catch (e) {}
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && document.body.classList.contains('mode-kid')) {
      requestWakeLock();
      renderKid();
    }
  });

  /* ---------------- finish ---------------- */
  var pendingRealTimes = null;

  function finish() {
    if (timer) { clearInterval(timer); timer = null; }
    if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; }

    var r = S.recap(routine, run);
    var leaveMs = S.resolveLeaveMs(routine.leaveAt, run.startedAt);
    var lastAt = run.done.length ? run.done[run.done.length - 1].at : Date.now();
    var today = ymd(new Date());

    var yesterday = ymd(new Date(Date.now() - 86400000));
    var onTime = lastAt <= leaveMs;

    // Bank and score only the first finish of the day; a replay for fun must
    // not double-bank minutes or torch an already-earned streak.
    if (stats.lastRunDate !== today) stats.bankedMin += r.earlyMin;
    if (onTime) {
      if (stats.lastOnTimeDate !== today) {
        stats.streak = stats.lastOnTimeDate === yesterday ? (stats.streak || 0) + 1 : 1;
        stats.lastOnTimeDate = today;
      }
    } else if (stats.lastOnTimeDate !== today) {
      stats.streak = 0;
    }
    stats.lastRunDate = today;
    saveJSON(KEY.stats, stats);
    drop(KEY.run);

    $('bank').textContent = stats.bankedMin;
    $('streak').textContent = stats.streak > 0
      ? '🔥 ' + stats.streak + (stats.streak === 1 ? ' morning on time' : ' mornings on time in a row')
      : 'Streak reset — tomorrow starts a new one.';

    var list = $('recap');
    list.innerHTML = '';
    pendingRealTimes = r.flagged;
    if (r.flagged.length) {
      r.flagged.forEach(function (f) {
        var li = document.createElement('li');
        li.textContent = f.emoji + ' ' + f.name + ': you planned ' + f.plannedMin +
          ', it took ' + f.actualMin + '.';
        list.appendChild(li);
      });
    } else {
      var li = document.createElement('li');
      li.className = 'clean';
      li.textContent = 'Every step landed on plan.';
      list.appendChild(li);
    }
    var useReal = $('useReal');
    useReal.hidden = !r.flagged.length;
    useReal.disabled = false;
    useReal.textContent = 'Use real times';

    $('copied').hidden = true;
    $('shareUrl').hidden = true;

    setMode('finish');
    confetti();
  }

  $('useReal').addEventListener('click', function () {
    if (!pendingRealTimes) return;
    pendingRealTimes.forEach(function (f) {
      var s = routine.steps.find(function (x) { return x.id === f.id; });
      if (s) s.minutes = Math.max(1, Math.min(120, f.actualMin));
    });
    persistRoutine();
    this.textContent = 'Times updated';
    this.disabled = true;
  });

  $('share').addEventListener('click', function () {
    var url = location.href.split('#')[0] + '#r=' + S.encodeRoutine(routine);
    function fallback() {
      var box = $('shareUrl');
      box.hidden = false;
      box.value = url;
      box.focus();
      box.select();
      $('copied').textContent = 'Copy this link:';
      $('copied').hidden = false;
    }
    try {
      navigator.clipboard.writeText(url).then(function () {
        $('copied').textContent = 'Link copied.';
        $('copied').hidden = false;
      }, fallback);
    } catch (e) { fallback(); }
  });

  $('again').addEventListener('click', function () {
    renderSetup();
    setMode('setup');
  });

  var COLORS = ['#FF7A1A', '#2FB56B', '#FFA114', '#E5484D', '#1A1D26'];
  function clearConfetti() { $('confetti').innerHTML = ''; }
  function confetti() {
    var box = $('confetti');
    box.innerHTML = '';
    for (var i = 0; i < 40; i++) {
      var p = document.createElement('i');
      p.style.left = (Math.random() * 100) + '%';
      p.style.background = COLORS[i % COLORS.length];
      p.style.animationDuration = (2.2 + Math.random() * 1.8) + 's';
      p.style.animationDelay = (Math.random() * 1.2) + 's';
      box.appendChild(p);
    }
  }

  /* ---------------- boot ---------------- */
  function importFromHash() {
    var h = location.hash.replace(/^#/, '');
    if (!h) return false;
    var code = new URLSearchParams(h).get('r');
    if (!code) return false;
    var incoming = S.decodeRoutine(code);
    if (!incoming) return false;
    routine = incoming;
    persistRoutine();
    $('linkBanner').hidden = false;
    try { history.replaceState(null, '', location.href.split('#')[0]); } catch (e) {}
    return true;
  }

  window.addEventListener('hashchange', function () {
    if (location.hash.indexOf('r=') !== -1) location.reload();
  });

  // Say so out loud when the browser blocks storage (private mode, full disk):
  // the app still runs, but nothing survives a reload.
  try {
    localStorage.setItem('leaveby.probe', '1');
    localStorage.removeItem('leaveby.probe');
  } catch (e) {
    $('storageWarn').hidden = false;
  }

  var fromLink = importFromHash();
  if (!fromLink) persistRoutine();   // first visit: starter routine becomes the saved one
  renderSetup();
  if (!fromLink && run && run.startedAt && Array.isArray(run.done)) enterKid();
  else { run = null; drop(KEY.run); setMode('setup'); }
})();
