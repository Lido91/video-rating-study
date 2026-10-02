/**
 * Video comparison study — Google Sheets backend.
 *
 * Paste this whole file into Extensions → Apps Script of your Google Sheet,
 * then Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone).
 * See README.md for the full steps.
 *
 * Sheets:
 *   Ratings — one row per (rater, video, question): which version (A, B, C...) was chosen.
 *             Written by the script, never edited after writing.
 *   Mapping — filled in by you: which method is A, B, C... in each video.
 *             Use * as the video_id for an order that applies to every video not listed.
 *   Summary — preference rate per method (with 95% CI), a position-bias check,
 *             and per-video vote counts. Rebuilt on every save and whenever Mapping is edited.
 */

var RATINGS_SHEET = 'Ratings';
var MAPPING_SHEET = 'Mapping';
var SUMMARY_SHEET = 'Summary';

var COLUMNS = [
  'timestamp', 'study_id', 'rater_id', 'video_id', 'question', 'choice', 'options',
  'trial_index', 'plays', 'stalls', 'video_seconds', 'response_ms', 'note',
  'screen', 'session_id', 'client_time', 'submission_id'
];
// Columns stored as plain text so ids like "007" or "1-2" aren't turned into numbers or dates.
var TEXT_COLUMNS = ['study_id', 'rater_id', 'video_id', 'question', 'choice', 'options',
  'note', 'screen', 'session_id', 'client_time', 'submission_id'];

var MAX_ROWS_PER_REQUEST = 100;

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

// Rebuild the summary as soon as you change the Mapping tab.
function onEdit(e) {
  if (e && e.range && e.range.getSheet().getName() === MAPPING_SHEET) updateSummary_();
}

// Run once from the Apps Script editor (select "setup", press Run) to create the sheets
// and grant the script permission to edit this spreadsheet.
function setup() {
  ratingsSheet_();
  mappingSheet_();
  updateSummary_();
}

function refreshSummary() {
  updateSummary_();
}

// ---------- validation ----------

var ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
var TOKEN_RE = /^[A-Za-z0-9_-]{1,64}$/;
// Video ids are relative file paths. The first character must be a letter, digit or _
// so a value can never start with "=" "+" "-" "@" and be read as a formula.
var VIDEO_RE = /^[A-Za-z0-9_][^\u0000-\u001f\u007f]{0,199}$/;
var LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,31}$/;

function validate_(r) {
  if (!r || typeof r !== 'object') return 'not an object';
  if (!ID_RE.test(String(r.study_id))) return 'bad study_id';
  if (!ID_RE.test(String(r.rater_id))) return 'bad rater_id';
  if (!VIDEO_RE.test(String(r.video_id))) return 'bad video_id';
  if (!ID_RE.test(String(r.question))) return 'bad question';
  if (!TOKEN_RE.test(String(r.session_id))) return 'bad session_id';
  if (!TOKEN_RE.test(String(r.submission_id))) return 'bad submission_id';

  var options = String(r.options || '').split('|');
  if (options.length < 2 || options.length > 26) return 'bad options';
  var unique = {};
  for (var i = 0; i < options.length; i++) {
    if (!LABEL_RE.test(options[i]) || unique[options[i]]) return 'bad options';
    unique[options[i]] = true;
  }
  if (r.note === 'playback_error') {
    if (r.choice) return 'choice with playback_error';
  } else {
    if (r.note) return 'bad note';
    if (options.indexOf(String(r.choice)) < 0) return 'choice not among options';
  }
  if (!isInt_(r.trial_index, 1, 100000)) return 'bad trial_index';
  if (!isInt_(r.plays, 0, 1000)) return 'bad plays';
  if (!isInt_(r.stalls, 0, 100000)) return 'bad stalls';
  if (typeof r.video_seconds !== 'number' || !(r.video_seconds >= 0 && r.video_seconds < 1e6)) return 'bad video_seconds';
  if (!isInt_(r.response_ms, 0, 1e9)) return 'bad response_ms';
  if (r.screen && !/^\d{1,5}x\d{1,5}$/.test(String(r.screen))) return 'bad screen';
  if (r.client_time && !/^[0-9T:.\-Z+]{1,40}$/.test(String(r.client_time))) return 'bad client_time';
  return '';
}

function isInt_(v, min, max) {
  return typeof v === 'number' && Math.floor(v) === v && v >= min && v <= max;
}

// ---------- mapping ----------

// Returns { videoId: { A: 'ours', B: 'baseline1', ... } }. Row "*" is the default.
function readMapping_() {
  var values = mappingSheet_().getDataRange().getValues();
  var head = (values.shift() || []).map(function (h) { return String(h).trim(); });
  var map = {};
  values.forEach(function (row) {
    var video = String(row[0]).trim();
    if (!video) return;
    var m = {};
    var any = false;
    for (var j = 1; j < head.length; j++) {
      var method = String(row[j] === undefined ? '' : row[j]).trim();
      if (head[j] && method) { m[head[j]] = method; any = true; }
    }
    if (any) map[video] = m;
  });
  return map;
}

// The method for each option label of a video, or null if the mapping is incomplete.
function methodsFor_(map, video, options) {
  var m = map[video] || map[video.replace(/\.[^.\/]+$/, '')] || map['*'];
  if (!m) return null;
  var out = [];
  for (var i = 0; i < options.length; i++) {
    if (!m[options[i]]) return null;
    out.push(m[options[i]]);
  }
  return out;
}

// ---------- summary ----------

function updateSummary_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var data = ratingsSheet_().getDataRange().getValues();
  var header = data.shift() || [];
  var col = {};
  header.forEach(function (h, i) { col[h] = i; });
  var map = readMapping_();
  var hasMapping = Object.keys(map).length > 0;

  var questions = [];
  var labels = [];           // every option label seen, in first-seen order
  var methods = [];          // every mapped method seen
  var byMethod = {};         // q|method -> { chosen, shown, chanceSum }
  var byLabel = {};          // q|label  -> { chosen, shown }
  var byVideo = {};          // video|q  -> { labels{}, methods{}, n, raters{}, errors, mapping }
  var videoKeys = [];
  var unmapped = 0;

  data.forEach(function (row) {
    var video = String(row[col.video_id]);
    var q = String(row[col.question]);
    if (!video) return;
    var options = String(row[col.options]).split('|');
    options.forEach(function (l) { if (labels.indexOf(l) < 0) labels.push(l); });
    if (questions.indexOf(q) < 0) questions.push(q);
    var mapped = methodsFor_(map, video, options);

    var vk = video + '\u0000' + q;
    var v = byVideo[vk];
    if (!v) {
      v = byVideo[vk] = { video: video, question: q, labels: {}, methods: {}, n: 0, raters: {}, errors: 0,
        mapping: mapped ? options.map(function (l, i) { return l + '=' + mapped[i]; }).join(', ') : '' };
      videoKeys.push(vk);
    }
    if (row[col.note] === 'playback_error' || !row[col.choice]) {
      v.errors += 1;
      return;
    }
    var choice = String(row[col.choice]);
    v.n += 1;
    v.labels[choice] = (v.labels[choice] || 0) + 1;
    v.raters[row[col.rater_id]] = true;

    options.forEach(function (l) {
      var lk = q + '\u0000' + l;
      var e = byLabel[lk] || (byLabel[lk] = { chosen: 0, shown: 0 });
      e.shown += 1;
      if (l === choice) e.chosen += 1;
    });

    if (!mapped) { unmapped += 1; return; }
    var chosenMethod = mapped[options.indexOf(choice)];
    v.methods[chosenMethod] = (v.methods[chosenMethod] || 0) + 1;
    mapped.forEach(function (m) {
      if (methods.indexOf(m) < 0) methods.push(m);
      var mk = q + '\u0000' + m;
      var e = byMethod[mk] || (byMethod[mk] = { chosen: 0, shown: 0, chanceSum: 0 });
      e.shown += 1;
      e.chanceSum += 1 / options.length;
      if (m === chosenMethod) e.chosen += 1;
    });
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
  function note(text) {
    rows.push([text]);
    blocks.push({ start: rows.length, count: 0, pct: [] });
  }

  section('Preference by method — share of answers in which the method was chosen',
    ['question', 'method', 'chosen', 'answers', 'preference', '95% CI low', '95% CI high', 'chance level'],
    [4, 5, 6, 7]);
  questions.forEach(function (q) {
    methods.forEach(function (m) {
      var e = byMethod[q + '\u0000' + m];
      if (!e || !e.shown) return;
      var ci = wilson_(e.chosen, e.shown);
      add([q, m, e.chosen, e.shown, e.chosen / e.shown, ci[0], ci[1], e.chanceSum / e.shown]);
    });
  });
  if (!hasMapping) {
    note('Fill in the Mapping tab (which method is A, B, C in each video) to see results per method.');
  } else if (unmapped) {
    note(unmapped + ' answer(s) are for videos missing from the Mapping tab and are not counted in this table.');
  }

  section('Position check — should be close to chance if raters are not biased by position',
    ['question', 'position', 'chosen', 'answers', 'share'], [4]);
  questions.forEach(function (q) {
    labels.forEach(function (l) {
      var e = byLabel[q + '\u0000' + l];
      if (e) add([q, l, e.chosen, e.shown, e.chosen / e.shown]);
    });
  });

  section('Per video — how many raters chose each version',
    ['video_id', 'question', 'n'].concat(labels, ['mapping'],
      methods.map(function (m) { return '# ' + m; }), ['unique_raters', 'playback_errors']), []);
  videoKeys.sort();
  videoKeys.forEach(function (vk) {
    var v = byVideo[vk];
    add([v.video, v.question, v.n]
      .concat(labels.map(function (l) { return v.labels[l] || 0; }))
      .concat([v.mapping])
      .concat(methods.map(function (m) { return v.mapping ? (v.methods[m] || 0) : ''; }))
      .concat([Object.keys(v.raters).length, v.errors]));
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
  // The first two columns hold ids (video, question, method): keep them as text so "001" stays "001".
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

function mappingSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(MAPPING_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(MAPPING_SHEET);
    sheet.getRange(1, 1, sheet.getMaxRows(), 1).setNumberFormat('@');
    sheet.getRange(1, 1, 1, 4).setValues([['video_id', 'A', 'B', 'C']]).setFontWeight('bold');
    sheet.getRange(1, 1).setNote(
      'One row per video: the method shown as A, B, C (add columns for more positions).\n' +
      'video_id is the file path inside videos/, e.g. clip01.mp4 (the extension may be left out).\n' +
      'If every video uses the same order, fill in a single row with * as the video_id.');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
