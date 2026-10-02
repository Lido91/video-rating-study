/**
 * Video comparison study — Google Sheets backend.
 *
 * Paste this whole file into Extensions → Apps Script of your Google Sheet,
 * then Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone).
 * See README.md for the full steps.
 *
 * Sheets it maintains:
 *   Ratings — one row per (rater, round, question): which method the rater chose.
 *             Never edited by the script after writing.
 *   Summary — preference rate per method (with 95% CI), a position-bias check,
 *             and vote counts per sample. Rebuilt on every save.
 */

var RATINGS_SHEET = 'Ratings';
var SUMMARY_SHEET = 'Summary';

var COLUMNS = [
  'timestamp', 'study_id', 'rater_id', 'sample_id', 'question', 'choice', 'choice_position',
  'methods_shown', 'trial_index', 'plays', 'stalls', 'response_ms', 'note',
  'screen', 'session_id', 'client_time', 'submission_id'
];
// Columns stored as plain text so ids like "007" or "1-2" aren't turned into numbers or dates.
var TEXT_COLUMNS = ['study_id', 'rater_id', 'sample_id', 'question', 'choice', 'choice_position',
  'methods_shown', 'note', 'screen', 'session_id', 'client_time', 'submission_id'];

var MAX_ROWS_PER_REQUEST = 100;
var LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

// ---------- web endpoints ----------

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (err) {
    return json_({ ok: false, error: 'Server busy, try again' });
  }
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var input = Array.isArray(body.rows) ? body.rows.slice(0, MAX_ROWS_PER_REQUEST) : [];
    var sheet = ratingsSheet_();

    var lastRow = sheet.getLastRow();
    var idCol = COLUMNS.indexOf('submission_id') + 1;
    var seen = {};
    if (lastRow > 1) {
      sheet.getRange(2, idCol, lastRow - 1, 1).getValues().forEach(function (r) { seen[r[0]] = true; });
    }

    var now = new Date();
    var out = [];
    var errors = [];
    input.forEach(function (row, i) {
      var problem = validate_(row);
      if (problem) { errors.push('row ' + i + ': ' + problem); return; }
      if (seen[row.submission_id]) return; // already saved (client retried)
      seen[row.submission_id] = true;
      out.push(COLUMNS.map(function (c) {
        if (c === 'timestamp') return now;
        var v = row[c];
        return v === null || v === undefined ? '' : v;
      }));
    });

    if (out.length) {
      var start = sheet.getLastRow() + 1;
      var needed = start + out.length - 1 - sheet.getMaxRows();
      if (needed > 0) sheet.insertRowsAfter(sheet.getMaxRows(), needed + 500);
      TEXT_COLUMNS.forEach(function (c) {
        sheet.getRange(start, COLUMNS.indexOf(c) + 1, out.length, 1).setNumberFormat('@');
      });
      sheet.getRange(start, 1, out.length, COLUMNS.length).setValues(out);
      updateSummary_();
    }
    return json_({ ok: true, saved: out.length, rejected: errors.length, errors: errors.slice(0, 5) });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

// Open the web app URL in a browser to check the deployment works.
function doGet() {
  return json_({ ok: true, message: 'Video rating endpoint is running.' });
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Video ratings')
    .addItem('Refresh summary', 'refreshSummary')
    .addToUi();
}

// Run once from the Apps Script editor (select "setup", press Run) to create the sheets
// and grant the script permission to edit this spreadsheet.
function setup() {
  ratingsSheet_();
  updateSummary_();
}

function refreshSummary() {
  updateSummary_();
}

// ---------- validation ----------

var ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
var TOKEN_RE = /^[A-Za-z0-9_-]{1,64}$/;
// Sample ids are file paths and methods are folder names. Neither may start with
// "=" "+" "-" "@" (so a value can never be read as a formula) or contain "|".
var SAMPLE_RE = /^[A-Za-z0-9_][^\u0000-\u001f\u007f|]{0,199}$/;
var METHOD_RE = /^[A-Za-z0-9_][A-Za-z0-9_. -]{0,63}$/;

function validate_(r) {
  if (!r || typeof r !== 'object') return 'not an object';
  if (!ID_RE.test(String(r.study_id))) return 'bad study_id';
  if (!ID_RE.test(String(r.rater_id))) return 'bad rater_id';
  if (!SAMPLE_RE.test(String(r.sample_id))) return 'bad sample_id';
  if (!ID_RE.test(String(r.question))) return 'bad question';
  if (!TOKEN_RE.test(String(r.session_id))) return 'bad session_id';
  if (!TOKEN_RE.test(String(r.submission_id))) return 'bad submission_id';

  var shown = String(r.methods_shown || '').split('|');
  if (shown.length < 2 || shown.length > LETTERS.length) return 'bad methods_shown';
  var unique = {};
  for (var i = 0; i < shown.length; i++) {
    if (!METHOD_RE.test(shown[i]) || unique[shown[i]]) return 'bad methods_shown';
    unique[shown[i]] = true;
  }
  if (r.note === 'playback_error') {
    if (r.choice || r.choice_position) return 'choice with playback_error';
  } else {
    if (r.note) return 'bad note';
    var pos = shown.indexOf(String(r.choice));
    if (pos < 0) return 'choice not among methods_shown';
    if (r.choice_position !== LETTERS[pos]) return 'choice_position does not match choice';
  }
  if (!isInt_(r.trial_index, 1, 100000)) return 'bad trial_index';
  if (!isInt_(r.plays, 0, 1000)) return 'bad plays';
  if (!isInt_(r.stalls, 0, 100000)) return 'bad stalls';
  if (!isInt_(r.response_ms, 0, 1e9)) return 'bad response_ms';
  if (r.screen && !/^\d{1,5}x\d{1,5}$/.test(String(r.screen))) return 'bad screen';
  if (r.client_time && !/^[0-9T:.\-Z+]{1,40}$/.test(String(r.client_time))) return 'bad client_time';
  return '';
}

function isInt_(v, min, max) {
  return typeof v === 'number' && Math.floor(v) === v && v >= min && v <= max;
}

// ---------- summary ----------

function updateSummary_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var data = ratingsSheet_().getDataRange().getValues();
  var header = data.shift() || [];
  var col = {};
  header.forEach(function (h, i) { col[h] = i; });

  var methods = [];          // every method seen, in first-seen order
  var questions = [];
  var byMethod = {};         // q|method -> {chosen, shown, chance}
  var byPosition = {};       // q|letter -> {chosen, shown}
  var bySample = {};         // sample|q -> {counts{method}, n, raters{}, errors}
  var sampleKeys = [];
  var maxPositions = 0;

  data.forEach(function (row) {
    var sample = String(row[col.sample_id]);
    var q = String(row[col.question]);
    if (!sample) return;
    var shown = String(row[col.methods_shown]).split('|');
    shown.forEach(function (m) { if (methods.indexOf(m) < 0) methods.push(m); });
    if (questions.indexOf(q) < 0) questions.push(q);

    var sk = sample + '\u0000' + q;
    var s = bySample[sk];
    if (!s) {
      s = bySample[sk] = { sample: sample, question: q, counts: {}, n: 0, raters: {}, errors: 0 };
      sampleKeys.push(sk);
    }
    if (row[col.note] === 'playback_error' || !row[col.choice]) {
      s.errors += 1;
      return;
    }
    var choice = String(row[col.choice]);
    s.n += 1;
    s.counts[choice] = (s.counts[choice] || 0) + 1;
    s.raters[row[col.rater_id]] = true;

    shown.forEach(function (m, i) {
      var mk = q + '\u0000' + m;
      var e = byMethod[mk] || (byMethod[mk] = { chosen: 0, shown: 0, chanceSum: 0 });
      e.shown += 1;
      e.chanceSum += 1 / shown.length;
      if (m === choice) e.chosen += 1;

      var pk = q + '\u0000' + LETTERS[i];
      var p = byPosition[pk] || (byPosition[pk] = { chosen: 0, shown: 0 });
      p.shown += 1;
      if (m === choice) p.chosen += 1;
    });
    maxPositions = Math.max(maxPositions, shown.length);
  });

  var rows = [];
  var bold = [];     // row indexes (0-based) of titles and headers
  var blocks = [];   // data rows of each section: { start, count, pct: [column indexes] }

  function section(title, head, pctCols) {
    if (rows.length) rows.push([]);
    rows.push([title]);
    bold.push(rows.length - 1);
    rows.push(head);
    bold.push(rows.length - 1);
    blocks.push({ start: rows.length, count: 0, pct: pctCols });
  }
  function add(row) {
    rows.push(row);
    blocks[blocks.length - 1].count += 1;
  }

  section('Preference by method — share of rounds in which the method was chosen',
    ['question', 'method', 'chosen', 'rounds shown', 'preference', '95% CI low', '95% CI high', 'chance level'],
    [4, 5, 6, 7]);
  questions.forEach(function (q) {
    methods.forEach(function (m) {
      var e = byMethod[q + '\u0000' + m];
      if (!e || !e.shown) return;
      var ci = wilson_(e.chosen, e.shown);
      add([q, m, e.chosen, e.shown, e.chosen / e.shown, ci[0], ci[1], e.chanceSum / e.shown]);
    });
  });

  section('Position check — should be close to chance if raters are not biased by position (A = left-most)',
    ['question', 'position', 'chosen', 'rounds', 'share'], [4]);
  questions.forEach(function (q) {
    for (var i = 0; i < maxPositions; i++) {
      var p = byPosition[q + '\u0000' + LETTERS[i]];
      if (p) add([q, LETTERS[i], p.chosen, p.shown, p.chosen / p.shown]);
    }
  });

  section('Per sample — how many raters chose each method',
    ['sample_id', 'question', 'n'].concat(methods, ['unique_raters', 'playback_errors']), []);
  sampleKeys.sort();
  sampleKeys.forEach(function (sk) {
    var s = bySample[sk];
    add([s.sample, s.question, s.n]
      .concat(methods.map(function (m) { return s.counts[m] || 0; }))
      .concat([Object.keys(s.raters).length, s.errors]));
  });

  var width = 1;
  rows.forEach(function (r) { width = Math.max(width, r.length); });
  rows = rows.map(function (r) {
    var padded = r.slice();
    while (padded.length < width) padded.push('');
    return padded;
  });

  var sheet = ss.getSheetByName(SUMMARY_SHEET) || ss.insertSheet(SUMMARY_SHEET);
  sheet.clear();
  if (sheet.getMaxRows() < rows.length) sheet.insertRowsAfter(sheet.getMaxRows(), rows.length - sheet.getMaxRows());
  if (sheet.getMaxColumns() < width) sheet.insertColumnsAfter(sheet.getMaxColumns(), width - sheet.getMaxColumns());
  // The first two columns hold ids (sample, question, method): keep them as text so "001" stays "001".
  sheet.getRange(1, 1, rows.length, 2).setNumberFormat('@');
  blocks.forEach(function (b) {
    if (!b.count) return;
    b.pct.forEach(function (c) { sheet.getRange(b.start + 1, c + 1, b.count, 1).setNumberFormat('0.0%'); });
  });
  sheet.getRange(1, 1, rows.length, width).setValues(rows);
  bold.forEach(function (i) { sheet.getRange(i + 1, 1, 1, width).setFontWeight('bold'); });
  sheet.autoResizeColumns(1, width);
}

// 95% Wilson score interval for k successes out of n.
function wilson_(k, n) {
  var z = 1.96;
  var p = k / n;
  var denom = 1 + z * z / n;
  var center = (p + z * z / (2 * n)) / denom;
  var half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

// ---------- helpers ----------

function ratingsSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(RATINGS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(RATINGS_SHEET, 0);
    sheet.getRange(1, 1, 1, COLUMNS.length).setValues([COLUMNS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
