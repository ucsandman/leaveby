/* LeaveBy - tests for the pure scheduling core.
   Runs in Node (node js/schedule.test.js) and in a browser (test.html).
   No framework, no dependencies. */
(function () {
  'use strict';

  var isNode = (typeof module !== 'undefined' && module.exports);
  var S = isNode ? require('./schedule.js') : window.Schedule;

  /* ---------- tiny harness ---------- */
  var asserts = 0;
  var failures = [];

  function ok(cond, msg) {
    asserts++;
    if (!cond) failures.push(msg);
  }
  function eq(actual, expected, msg) {
    asserts++;
    if (actual !== expected) {
      failures.push(msg + ' -- got ' + str(actual) + ', want ' + str(expected));
    }
  }
  function jeq(actual, expected, msg) {
    asserts++;
    var a = JSON.stringify(actual), b = JSON.stringify(expected);
    if (a !== b) failures.push(msg + ' -- got ' + a + ', want ' + b);
  }
  function str(v) {
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }
  function group(name, fn) {
    try {
      fn();
    } catch (e) {
      asserts++;
      failures.push(name + ' -- THREW: ' + ((e && e.message) || e));
    }
  }

  /* ---------- fixtures ---------- */
  // A safe weekday far from any DST transition, built with the local-time
  // constructor so every assertion is timezone independent.
  var Y = 2026, M = 2, D = 17; // 2026-03-17
  function at(hh, mm, ss) { return new Date(Y, M, D, hh, mm, ss || 0, 0).getTime(); }
  function atNext(hh, mm) { return new Date(Y, M, D + 1, hh, mm, 0, 0).getTime(); }
  var MIN = 60000;

  function step(id, emoji, name, minutes, optional) {
    return { id: id, emoji: emoji, name: name, minutes: minutes, optional: !!optional };
  }

  // Fixture A: simple, on time. 5 + 3 + 2 = 10 min, leave 08:00.
  var A = {
    v: 1, leaveAt: '08:00',
    steps: [
      step('a', '👟', 'Shoes', 5, false),
      step('b', '🧥', 'Coat', 3, false),
      step('c', '🧢', 'Hat', 2, false)
    ]
  };

  // Fixture B: behind schedule. 5 + 5 + 10 + 4 + 3 = 27 min, leave 08:00.
  // Two optionals ('bk' at index 1, 'sg' at index 3) so drop ORDER is provable.
  var B = {
    v: 1, leaveAt: '08:00',
    steps: [
      step('ws', '🚽', 'Wash', 5, false),
      step('bk', '📖', 'Book time', 5, true),
      step('et', '🥣', 'Breakfast', 10, false),
      step('sg', '🎵', 'Song', 4, true),
      step('sh', '👟', 'Shoes', 3, false)
    ]
  };

  // Fixture C: impossible. 20 + 5 + 15 = 40 min with 5 minutes on the clock.
  var C = {
    v: 1, leaveAt: '08:00',
    steps: [
      step('p', '🥣', 'Porridge', 20, false),
      step('q', '📖', 'Book time', 5, true),
      step('r', '👟', 'Shoes', 15, false)
    ]
  };

  var STARTER = {
    v: 1, leaveAt: '07:45',
    steps: [
      step('s1', '🚽', 'Bathroom', 5, false),
      step('s2', '👕', 'Get dressed', 5, false),
      step('s3', '🥣', 'Breakfast', 15, false),
      step('s4', '🪥', 'Brush teeth', 3, false),
      step('s5', '📖', 'Book time', 5, true),
      step('s6', '👟', 'Shoes', 3, false),
      step('s7', '🧥', 'Coat', 2, false)
    ]
  };

  /* ---------- 1. resolveLeaveMs: the 3-hour rollover, both directions ---------- */
  group('resolveLeaveMs', function () {
    eq(S.resolveLeaveMs('07:45', at(6, 0)), at(7, 45),
      'leave time still ahead resolves to today');
    eq(S.resolveLeaveMs('07:45', at(7, 45)), at(7, 45),
      'exactly at the leave time resolves to today');
    eq(S.resolveLeaveMs('07:45', at(9, 0)), at(7, 45),
      '75 min past is not more than 3h, stays today');
    eq(S.resolveLeaveMs('07:45', at(10, 45)), at(7, 45),
      'exactly 3h past is NOT more than 3h, stays today');
    eq(S.resolveLeaveMs('07:45', at(10, 46)), atNext(7, 45),
      '3h01m past rolls over to tomorrow');
    eq(S.resolveLeaveMs('07:45', at(12, 0)), atNext(7, 45),
      '4h15m past rolls over to tomorrow');
    eq(S.resolveLeaveMs('00:05', at(23, 30)), at(0, 5) + 24 * 60 * MIN,
      'a past-midnight leave time near end of day rolls to tomorrow');
  });

  /* ---------- 2. plan: hand-computed deadlines, last step lands on leaveMs ---------- */
  group('plan', function () {
    var p = S.plan(A, at(7, 30));
    eq(p.leaveMs, at(8, 0), 'plan leaveMs');
    eq(p.steps.length, 3, 'plan keeps every step');
    eq(p.steps[2].deadlineMs, at(8, 0), 'final step deadline equals leaveMs exactly');
    eq(p.steps[1].deadlineMs, at(7, 58), 'Coat deadline = leave - 2 min (Hat)');
    eq(p.steps[0].deadlineMs, at(7, 55), 'Shoes deadline = leave - 5 min (Coat + Hat)');
    eq(p.steps[0].name, 'Shoes', 'plan carries the original step fields through');
    eq(p.steps[0].minutes, 5, 'plan carries minutes through');
    eq(A.steps[0].deadlineMs, undefined, 'plan does not mutate the input routine');
  });

  /* ---------- 3. tick fixture A: simple on-time 3-step morning ---------- */
  group('tick on-time', function () {
    var run = { startedAt: at(7, 30), done: [] };
    var t = S.tick(A, run, at(7, 30));
    eq(t.finished, false, 'A: not finished');
    eq(t.leaveMs, at(8, 0), 'A: leaveMs');
    eq(t.currentStep.id, 'a', 'A: current step is the first one');
    eq(t.currentIndex, 0, 'A: currentIndex 0');
    eq(t.deadlineMs, at(7, 55), 'A: current deadline = leave - 5 min');
    eq(t.stepMsLeft, 25 * MIN, 'A: 25 min until the Shoes deadline');
    eq(t.stepFraction, 1, 'A: fraction clamps to 1 when way ahead');
    eq(t.status, 'green', 'A: green');
    eq(t.deltaMs, 20 * MIN, 'A: 30 min of clock minus 10 min of work = 20 min slack');
    jeq(t.droppedIds, [], 'A: nothing dropped');
    eq(t.hurry, false, 'A: no hurry');
    eq(t.remainingCount, 3, 'A: 3 steps to go');
  });

  group('tick advances after a tap', function () {
    var run = { startedAt: at(7, 30), done: [{ id: 'a', at: at(7, 36) }] };
    var t = S.tick(A, run, at(7, 36));
    eq(t.currentStep.id, 'b', 'A: current step is Coat after Shoes is tapped');
    eq(t.currentIndex, 1, 'A: currentIndex is the index in routine.steps');
    eq(t.remainingCount, 2, 'A: 2 steps to go');
    eq(t.deadlineMs, at(7, 58), 'A: Coat deadline unchanged, still anchored to leaveMs');
    eq(t.deltaMs, 19 * MIN, 'A: 24 min of clock minus 5 min of work');
  });

  /* ---------- 4. tick fixture B: behind schedule, the RIGHT optional drops ---------- */
  group('tick drops the last optional first', function () {
    var run = { startedAt: at(7, 40), done: [] };
    var t = S.tick(B, run, at(7, 40));
    // 20 min of clock vs 27 min of work = -7. Drop 'sg' (last optional, 4 min)
    // -> -3, still short. Drop 'bk' (5 min) -> +2. Stop.
    jeq(t.droppedIds, ['sg', 'bk'], 'B: drops the LAST optional first, then the next one back');
    eq(t.hurry, false, 'B: recovered, so no hurry');
    eq(t.deltaMs, 2 * MIN, 'B: 20 min of clock minus 18 min of kept work');
    eq(t.remainingCount, 3, 'B: 3 kept steps remain');
    eq(t.currentStep.id, 'ws', 'B: current step is the first KEPT step');
    eq(t.deadlineMs, at(7, 47), 'B: Wash deadline re-anchored = leave - 13 min (kept only)');
    eq(t.stepFraction, 1, 'B: 7 min left on a 5 min step clamps to 1');
    eq(t.status, 'green', 'B: green once the drop recovers the morning');
  });

  group('tick re-anchors so the last KEPT step lands on leaveMs', function () {
    var run = {
      startedAt: at(7, 40),
      done: [{ id: 'ws', at: at(7, 45) }, { id: 'et', at: at(7, 55) }]
    };
    var t = S.tick(B, run, at(7, 55));
    // Only 'bk', 'sg', 'sh' remain: 5 + 4 + 3 = 12 min against 5 min of clock.
    // Drop 'sg' -> 8 min, still short. Drop 'bk' -> 3 min, delta +2.
    jeq(t.droppedIds, ['sg', 'bk'], 'B: both optionals dropped again');
    eq(t.currentStep.id, 'sh', 'B: Shoes is the only kept step left');
    eq(t.deadlineMs, at(8, 0), 'B: the last kept step deadline IS leaveMs exactly');
    eq(t.remainingCount, 1, 'B: one kept step to go');
    eq(t.hurry, false, 'B: no hurry');
  });

  group('tick un-drops when time is recovered', function () {
    // Wash was planned at 5 min but the kid did it in 1. 'bk' should come back.
    var run = { startedAt: at(7, 40), done: [{ id: 'ws', at: at(7, 41) }] };
    var t = S.tick(B, run, at(7, 41));
    // Remaining bk+et+sg+sh = 22 min against 19 min of clock = -3.
    // Drop 'sg' (4) -> 18 min, delta +1. 'bk' is NOT dropped this time.
    jeq(t.droppedIds, ['sg'], 'B: only the last optional stays dropped, Book time is back');
    eq(t.currentStep.id, 'bk', 'B: Book time is current again after time was recovered');
    eq(t.deltaMs, 1 * MIN, 'B: 19 min of clock minus 18 min of kept work');
    eq(t.remainingCount, 3, 'B: bk + et + sh');
    eq(t.hurry, false, 'B: no hurry');
  });

  /* ---------- 5. tick fixture C: impossible morning ---------- */
  group('tick impossible morning', function () {
    var run = { startedAt: at(7, 55), done: [] };
    var t = S.tick(C, run, at(7, 55));
    // 5 min of clock vs 40 min of work. Dropping the only optional leaves 35.
    jeq(t.droppedIds, ['q'], 'C: the one optional is dropped');
    eq(t.hurry, true, 'C: hurry stays true, nothing left to drop');
    eq(t.deltaMs, -30 * MIN, 'C: 5 min of clock minus 35 min of kept work');
    eq(t.status, 'red', 'C: red');
    eq(t.currentStep.id, 'p', 'C: current step is still the first kept one');
    eq(t.currentIndex, 0, 'C: currentIndex 0');
    eq(t.deadlineMs, at(7, 45), 'C: Porridge deadline = leave - 15 min, already blown');
    eq(t.stepMsLeft, -10 * MIN, 'C: the current deadline is 10 min in the past');
    eq(t.stepFraction, 0, 'C: fraction clamps to 0, never negative');
    eq(t.remainingCount, 2, 'C: remainingCount stays positive');
    ok(t.remainingCount >= 0, 'C: remainingCount is never negative');
    ok(t.droppedIds.length <= C.steps.length, 'C: never drops more than exists');
    eq(t.finished, false, 'C: not finished');
  });

  /* ---------- 6. stepFraction clamping, including a mid-range value ---------- */
  group('stepFraction clamping', function () {
    var solo = { v: 1, leaveAt: '08:00', steps: [step('x', '👟', 'Shoes', 10, false)] };
    var run = { startedAt: at(7, 50), done: [] };

    var mid = S.tick(solo, run, at(7, 56));
    eq(mid.deadlineMs, at(8, 0), 'solo: the only step lands on leaveMs');
    eq(mid.stepMsLeft, 4 * MIN, 'solo: 4 min left');
    eq(mid.stepFraction, 0.4, 'solo: 4 of 10 min is fraction 0.4, unclamped');

    var over = S.tick(solo, run, at(7, 30));
    eq(over.stepFraction, 1, 'solo: fraction above 1 clamps to 1');

    var under = S.tick(solo, run, at(8, 30));
    eq(under.stepFraction, 0, 'solo: fraction below 0 clamps to 0');
    eq(under.status, 'red', 'solo: past the deadline is red');
  });

  /* ---------- 7. finished, and the all-optionals-dropped edge ---------- */
  group('tick finished', function () {
    var run = {
      startedAt: at(7, 30),
      done: [{ id: 'a', at: at(7, 35) }, { id: 'b', at: at(7, 38) }, { id: 'c', at: at(7, 40) }]
    };
    var t = S.tick(A, run, at(7, 40));
    eq(t.finished, true, 'finished when nothing remains');
    eq(t.currentStep, null, 'finished: no current step');
    eq(t.currentIndex, -1, 'finished: currentIndex -1');
    eq(t.remainingCount, 0, 'finished: remainingCount 0');
    eq(t.stepFraction, 0, 'finished: fraction 0');
    eq(t.status, 'green', 'finished on time is green');
    eq(t.hurry, false, 'finished on time is not a hurry');
  });

  group('the last remaining card never drops', function () {
    // Past the leave time with only an optional step left: dropping it would
    // leave the kid a frozen screen with nothing to tap, so the final card
    // always survives even when it no longer fits.
    var opt = {
      v: 1, leaveAt: '08:00',
      steps: [step('a', '👟', 'Shoes', 5, false), step('z', '📖', 'Book time', 5, true)]
    };
    var run = { startedAt: at(7, 50), done: [{ id: 'a', at: at(8, 2) }] };
    var t = S.tick(opt, run, at(8, 2));
    jeq(t.droppedIds, [], 'last card: nothing is dropped');
    ok(t.currentStep && t.currentStep.id === 'z', 'last card: the optional step is still the current card');
    eq(t.finished, false, 'last card: not finished');
    eq(t.hurry, true, 'last card: past the leave time is still a hurry');
    eq(t.status, 'red', 'last card: red');
    eq(t.remainingCount, 1, 'last card: one kept step remains');
  });

  group('an all-optional tail still drops down to one card', function () {
    // Two optionals left and no time: the later one drops, the earlier one
    // stays tappable.
    var opt2 = {
      v: 1, leaveAt: '08:00',
      steps: [step('bk', '📖', 'Book time', 5, true), step('sg', '🎵', 'Song', 4, true)]
    };
    var run = { startedAt: at(7, 50), done: [] };
    var t = S.tick(opt2, run, at(8, 10));
    jeq(t.droppedIds, ['sg'], 'tail: the later optional drops first');
    ok(t.currentStep && t.currentStep.id === 'bk', 'tail: the earlier optional is the current card');
    eq(t.hurry, true, 'tail: still a hurry');
    eq(t.remainingCount, 1, 'tail: one kept step');
  });

  group('tick anchors the deadline to the run, not the wall clock', function () {
    // A run left open long past the leave time must stay red and late, not
    // silently retarget tomorrow and turn green.
    var run = { startedAt: at(7, 30), done: [] };
    var t = S.tick(A, run, at(11, 30));
    eq(t.leaveMs, at(8, 0), 'anchor: leaveMs stays at the run day 08:00');
    eq(t.hurry, true, 'anchor: three and a half hours late is a hurry');
    eq(t.status, 'red', 'anchor: red, not a fresh green tomorrow');
    var noRun = S.tick(A, null, at(11, 30));
    eq(noRun.leaveMs, atNext(8, 0), 'anchor: with no run, the deadline falls back to the clock (tomorrow)');
  });

  /* ---------- 8. encode / decode round trip, emoji included ---------- */
  group('encode/decode round trip', function () {
    var enc = S.encodeRoutine(STARTER);
    eq(typeof enc, 'string', 'encodeRoutine returns a string');
    ok(enc.indexOf('+') === -1, 'encoded string has no + (base64url)');
    ok(enc.indexOf('/') === -1, 'encoded string has no / (base64url)');
    ok(enc.indexOf('=') === -1, 'encoded string has no = padding');
    ok(/^[A-Za-z0-9_-]+$/.test(enc), 'encoded string is URL-hash safe');

    var back = S.decodeRoutine(enc);
    ok(back !== null, 'decodeRoutine returns a routine');
    jeq(back, STARTER, 'round trip is lossless');
    eq(back.steps[0].emoji, '🚽', 'emoji survives the round trip (toilet)');
    eq(back.steps[3].emoji, '🪥', 'emoji survives the round trip (toothbrush, a 2019 codepoint)');
    eq(back.steps[4].optional, true, 'the optional flag survives');
    eq(back.leaveAt, '07:45', 'leaveAt survives');
    eq(back.steps.length, 7, 'all 7 starter steps survive');
  });

  /* ---------- 9. decode clamps, caps and strips ---------- */
  group('decode clamps and strips', function () {
    var dirty = {
      v: 1, leaveAt: '07:45', junk: 'nope',
      steps: [
        { id: 'a', emoji: '👟', name: 'Zero', minutes: 0, optional: false, extra: 1 },
        { id: 'b', emoji: '🧥', name: 'Huge', minutes: 999, optional: false },
        { id: 'c', emoji: '🥣', name: 'Fractional', minutes: 7.6, optional: 'yes' }
      ]
    };
    var d = S.decodeRoutine(S.encodeRoutine(dirty));
    ok(d !== null, 'a dirty but valid routine decodes');
    eq(d.steps[0].minutes, 1, 'minutes 0 clamps up to 1');
    eq(d.steps[1].minutes, 120, 'minutes 999 clamps down to 120');
    eq(d.steps[2].minutes, 8, 'fractional minutes round to the nearest integer');
    eq(d.steps[2].optional, true, 'optional is coerced to a real boolean');
    eq(d.junk, undefined, 'unknown routine fields are stripped');
    eq(d.steps[0].extra, undefined, 'unknown step fields are stripped');
    eq(d.v, 1, 'version is normalised to 1');

    var many = { v: 1, leaveAt: '07:45', steps: [] };
    for (var i = 0; i < 25; i++) many.steps.push(step('k' + i, '👟', 'Step ' + i, 2, false));
    var capped = S.decodeRoutine(S.encodeRoutine(many));
    eq(capped.steps.length, 20, '25 steps are capped at 20');
    eq(capped.steps[19].id, 'k19', 'the cap keeps the FIRST 20 steps');
  });

  /* ---------- 10. decode rejects garbage ---------- */
  group('decode rejects garbage', function () {
    eq(S.decodeRoutine(''), null, 'empty string is rejected');
    eq(S.decodeRoutine(null), null, 'null is rejected');
    eq(S.decodeRoutine(undefined), null, 'undefined is rejected');
    eq(S.decodeRoutine('!!!not base64!!!'), null, 'non base64 is rejected');
    eq(S.decodeRoutine('eyJ2IjoxfQ'), null, '{"v":1} with no steps is rejected');
    eq(S.decodeRoutine('ImhlbGxvIg'), null, 'a bare JSON string is rejected');
    eq(S.decodeRoutine('WzEsMiwzXQ'), null, 'a bare JSON array is rejected');
    eq(S.decodeRoutine('bnVsbA'), null, 'JSON null is rejected');
    eq(S.decodeRoutine('eyJ2IjoxLCJsZWF2ZUF0IjoiMDc6NDUiLCJzdGVwcyI6W119'), null,
      'an empty steps array is rejected');
    eq(S.decodeRoutine('eyJ2IjoxLCJsZWF2ZUF0IjoiOTk6OTkiLCJzdGVwcyI6W3siaWQiOiJhIiwiZW1vamk' +
      'iOiJ4IiwibmFtZSI6IkEiLCJtaW51dGVzIjo1fV19'), null,
      'an impossible leaveAt of 99:99 is rejected');
  });

  /* ---------- 11. recap ---------- */
  group('recap', function () {
    var started = at(7, 40);
    var run = {
      startedAt: started,
      done: [
        { id: 'a', at: started + 7 * MIN },        // 7 min against a 5 min plan
        { id: 'b', at: started + 564000 },          // 2.4 min against a 3 min plan
        { id: 'c', at: started + 564000 }           // 0 min, floors to 1, against 2
      ]
    };
    var r = S.recap(A, run);
    eq(r.perStep.length, 3, 'recap has one row per completed step');
    eq(r.perStep[0].id, 'a', 'recap rows follow the tap order');
    eq(r.perStep[0].name, 'Shoes', 'recap carries the name');
    eq(r.perStep[0].emoji, '👟', 'recap carries the emoji');
    eq(r.perStep[0].plannedMin, 5, 'recap carries plannedMin');
    eq(r.perStep[0].actualMin, 7, 'first step measures from startedAt');
    eq(r.perStep[1].actualMin, 2, '2.4 min rounds to 2');
    eq(r.perStep[2].actualMin, 1, 'a zero-length step floors to 1 min');
    eq(r.flagged.length, 1, 'only the 2-min miss is flagged');
    eq(r.flagged[0].id, 'a', 'Shoes is the flagged step');
    // leave 08:00 minus last tap at 07:49:24 = 10.6 min -> 11
    eq(r.earlyMin, 11, 'earlyMin is the banked time rounded to the nearest minute');
  });

  group('recap flags an under-run and never banks negative time', function () {
    var started = at(7, 40);
    var run = {
      startedAt: started,
      done: [
        { id: 'a', at: started + 1 * MIN },   // 1 min against a 5 min plan -> flagged
        { id: 'b', at: started + 4 * MIN },   // 3 min against a 3 min plan -> clean
        { id: 'c', at: at(8, 12) }            // finished 12 min after the door
      ]
    };
    var r = S.recap(A, run);
    eq(r.flagged.length, 2, 'a fast step and a slow step are both flagged');
    eq(r.flagged[0].id, 'a', 'the 4-min under-run is flagged');
    eq(r.flagged[1].id, 'c', 'the long final step is flagged');
    eq(r.perStep[1].actualMin, 3, 'an on-plan step is not flagged');
    eq(r.earlyMin, 0, 'finishing late banks 0 minutes, never a negative');
  });

  /* ---------- report ---------- */
  var results = { asserts: asserts, failures: failures };

  if (isNode) {
    if (failures.length) {
      console.log('FAIL  ' + failures.length + ' of ' + asserts + ' asserts failed');
      for (var i = 0; i < failures.length; i++) console.log('  x ' + failures[i]);
      process.exitCode = 1;
    } else {
      console.log('PASS  ' + asserts + ' asserts');
    }
    module.exports = results;
  } else {
    window.ScheduleTestResults = results;
  }
})();
