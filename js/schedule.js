/* LeaveBy - the pure scheduling core.
   Zero DOM, zero storage, zero globals beyond window.Schedule.
   Every function takes `now` (ms epoch) explicitly so tests can lie about the clock. */
(function () {
  'use strict';

  var MIN_MS = 60000;
  var MAX_STEPS = 20;
  var ROLLOVER_MS = 3 * 60 * MIN_MS;

  /* ---------- time ---------- */

  // The leave deadline: today's occurrence of HH:MM, unless that moment is more
  // than 3 hours behind `now`, in which case tomorrow's.
  function resolveLeaveMs(leaveAt, now) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(leaveAt == null ? '' : leaveAt));
    var hh = m ? Number(m[1]) : 0;
    var mm = m ? Number(m[2]) : 0;
    var d = new Date(now);
    d.setHours(hh, mm, 0, 0);
    if (now - d.getTime() > ROLLOVER_MS) {
      d.setDate(d.getDate() + 1);
      d.setHours(hh, mm, 0, 0); // re-assert: a DST shift can move the wall clock
    }
    return d.getTime();
  }

  /* ---------- deadlines ---------- */

  function totalMinutes(steps) {
    var n = 0;
    for (var i = 0; i < steps.length; i++) n += steps[i].minutes;
    return n;
  }

  // Anchored BACKWARDS from leaveMs: the final step lands exactly on leaveMs and
  // each earlier one is pushed back by the minutes of everything after it.
  function withDeadlines(steps, leaveMs) {
    var out = new Array(steps.length);
    var later = 0;
    for (var i = steps.length - 1; i >= 0; i--) {
      out[i] = Object.assign({}, steps[i], { deadlineMs: leaveMs - later * MIN_MS });
      later += steps[i].minutes;
    }
    return out;
  }

  function plan(routine, now) {
    var leaveMs = resolveLeaveMs(routine.leaveAt, now);
    return { leaveMs: leaveMs, steps: withDeadlines(routine.steps || [], leaveMs) };
  }

  /* ---------- the live morning ---------- */

  function tick(routine, runState, now) {
    var steps = (routine && routine.steps) || [];
    var done = (runState && runState.done) || [];

    var doneIds = {};
    for (var i = 0; i < done.length; i++) doneIds[done[i].id] = true;

    // Anchored to the morning the run STARTED, so a run left open past the
    // rollover window stays honestly late instead of retargeting tomorrow.
    var anchor = (runState && runState.startedAt) ? runState.startedAt : now;
    var leaveMs = resolveLeaveMs(routine.leaveAt, anchor);
    var remaining = steps.filter(function (s) { return !doneIds[s.id]; });

    // Recomputed from scratch every tick, so time the kid wins back un-drops
    // steps that an earlier tick had given up on.
    var kept = remaining.slice();
    var droppedIds = [];
    var deltaMs = (leaveMs - now) - totalMinutes(kept) * MIN_MS;
    while (deltaMs < 0) {
      // Never drop the final card: a kid must always have something to tap.
      if (kept.length === 1) break;
      var idx = -1;
      for (var j = kept.length - 1; j >= 0; j--) {
        if (kept[j].optional) { idx = j; break; }
      }
      if (idx === -1) break;
      droppedIds.push(kept[idx].id);
      kept.splice(idx, 1);
      deltaMs = (leaveMs - now) - totalMinutes(kept) * MIN_MS;
    }

    var hurry = deltaMs < 0;
    var finished = remaining.length === 0;
    var current = kept.length ? kept[0] : null;

    if (!current) {
      // Either the morning is over, or everything left was dropped.
      return {
        finished: finished,
        leaveMs: leaveMs,
        currentStep: null,
        currentIndex: -1,
        deadlineMs: leaveMs,
        stepMsLeft: 0,
        stepFraction: 0,
        status: hurry ? 'red' : 'green',
        deltaMs: deltaMs,
        droppedIds: droppedIds,
        hurry: hurry,
        remainingCount: 0
      };
    }

    // Deadlines re-anchor over the KEPT steps only, so the last surviving step
    // still lands exactly on leaveMs.
    var deadlineMs = leaveMs - (totalMinutes(kept) - current.minutes) * MIN_MS;
    var stepMsLeft = deadlineMs - now;
    var stepFraction = clamp(stepMsLeft / (current.minutes * MIN_MS), 0, 1);

    var status;
    if (hurry || stepMsLeft <= 0) status = 'red';
    else if (stepFraction < 0.25 || stepMsLeft < MIN_MS) status = 'orange';
    else status = 'green';

    return {
      finished: finished,
      leaveMs: leaveMs,
      currentStep: current,
      currentIndex: steps.indexOf(current),
      deadlineMs: deadlineMs,
      stepMsLeft: stepMsLeft,
      stepFraction: stepFraction,
      status: status,
      deltaMs: deltaMs,
      droppedIds: droppedIds,
      hurry: hurry,
      remainingCount: kept.length
    };
  }

  function clamp(n, lo, hi) {
    return n < lo ? lo : (n > hi ? hi : n);
  }

  /* ---------- sharing: base64url of the UTF-8 JSON ---------- */

  function toBase64(text) {
    if (typeof Buffer !== 'undefined') return Buffer.from(text, 'utf8').toString('base64');
    var bytes = new TextEncoder().encode(text);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function fromBase64(b64) {
    if (typeof Buffer !== 'undefined') return Buffer.from(b64, 'base64').toString('utf8');
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  function encodeRoutine(routine) {
    return toBase64(JSON.stringify(routine))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  function decodeRoutine(str) {
    if (typeof str !== 'string' || !str) return null;
    var b64 = str.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';

    var raw;
    try {
      raw = JSON.parse(fromBase64(b64));
    } catch (e) {
      return null;
    }
    return normalizeRoutine(raw);
  }

  // Shape-check any untrusted routine object (a decoded link, or whatever was
  // sitting in localStorage) into a valid one, or null.
  function normalizeRoutine(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(raw.leaveAt)) return null;
    if (!Array.isArray(raw.steps) || !raw.steps.length) return null;

    var steps = [];
    for (var i = 0; i < raw.steps.length && steps.length < MAX_STEPS; i++) {
      var s = raw.steps[i];
      if (!s || typeof s !== 'object') return null;
      if (typeof s.id !== 'string' || !s.id) return null;
      if (typeof s.name !== 'string' || !s.name) return null;
      if (typeof s.emoji !== 'string') return null;
      var mins = Number(s.minutes);
      if (!isFinite(mins)) return null;
      steps.push({
        id: s.id,
        emoji: s.emoji,
        name: s.name,
        minutes: clamp(Math.round(mins), 1, 120),
        optional: !!s.optional
      });
    }
    return { v: 1, leaveAt: raw.leaveAt, steps: steps };
  }

  /* ---------- afterwards ---------- */

  function recap(routine, runState) {
    var byId = {};
    var steps = (routine && routine.steps) || [];
    for (var i = 0; i < steps.length; i++) byId[steps[i].id] = steps[i];

    var done = (runState && runState.done) || [];
    var prev = runState.startedAt;
    var perStep = [];
    for (var j = 0; j < done.length; j++) {
      var entry = done[j];
      var s = byId[entry.id];
      if (s) {
        perStep.push({
          id: s.id,
          name: s.name,
          emoji: s.emoji,
          plannedMin: s.minutes,
          actualMin: Math.max(1, Math.round((entry.at - prev) / MIN_MS))
        });
      }
      prev = entry.at;
    }

    var leaveMs = resolveLeaveMs(routine.leaveAt, runState.startedAt);
    var lastAt = done.length ? done[done.length - 1].at : runState.startedAt;

    return {
      perStep: perStep,
      flagged: perStep.filter(function (p) {
        return Math.abs(p.actualMin - p.plannedMin) >= 2;
      }),
      earlyMin: Math.max(0, Math.round((leaveMs - lastAt) / MIN_MS))
    };
  }

  var Schedule = {
    resolveLeaveMs: resolveLeaveMs,
    plan: plan,
    tick: tick,
    encodeRoutine: encodeRoutine,
    decodeRoutine: decodeRoutine,
    normalizeRoutine: normalizeRoutine,
    recap: recap
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Schedule;
  else window.Schedule = Schedule;
})();
