/**
 * Video rating study — Google Sheets backend.
 *
 * Paste this whole file into Extensions → Apps Script of your Google Sheet,
 * then Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone).
 * See README.md for the full steps.
 *
 * Sheets it maintains:
 *   Ratings — one row per (rater, video, question). Never edited by the script after writing.
 *   Summary — one row per (video, question): N, MOS, SD, 95% CI, score counts. Rebuilt on every save.
 */

var RATINGS_SHEET = 'Ratings';
var SUMMARY_SHEET = 'Summary';

var COLUMNS = [
  'timestamp', 'study_id', 'rater_id', 'video_id', 'question', 'score',
  'trial_index', 'plays', 'stalls', 'video_seconds', 'response_ms', 'note',
  'screen', 'session_id', 'client_time', 'submission_id'
];
// Columns stored as plain text so IDs like "007" or "1-2" aren't turned into numbers or dates.
var TEXT_COLUMNS = ['study_id', 'rater_id', 'video_id', 'question', 'note', 'screen', 'session_id', 'client_time', 'submission_id'];

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
var QUESTION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
// Video ids are relative file paths. The first character must be a letter, digit or _
// so a value can never start with "=" "+" "-" "@" and be read as a formula.
var VIDEO_RE = /^[A-Za-z0-9_][^\u0000-\u001f\u007f]{0,199}$/;

function validate_(r) {
  if (!r || typeof r !== 'object') return 'not an object';
  if (!ID_RE.test(String(r.study_id))) return 'bad study_id';
  if (!ID_RE.test(String(r.rater_id))) return 'bad rater_id';
  if (!VIDEO_RE.test(String(r.video_id))) return 'bad video_id';
  if (!QUESTION_RE.test(String(r.question))) return 'bad question';
  if (!TOKEN_RE.test(String(r.session_id))) return 'bad session_id';
  if (!TOKEN_RE.test(String(r.submission_id))) return 'bad submission_id';
  if (r.note === 'playback_error') {
    if (r.score !== null && r.score !== '' && r.score !== undefined) return 'score with playback_error';
  } else {
    if (r.note) return 'bad note';
    if (!isInt_(r.score, 1, 20)) return 'bad score';
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

// ---------- summary ----------

function updateSummary_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var data = ratingsSheet_().getDataRange().getValues();
  var header = data.shift() || [];
  var col = {};
  header.forEach(function (h, i) { col[h] = i; });

  var groups = {};
  var order = [];
  var maxScore = 5;
  data.forEach(function (row) {
    var video = String(row[col.video_id]);
    var question = String(row[col.question]);
    if (!video) return;
    var key = video + '\u0000' + question;
    var g = groups[key];
    if (!g) {
      g = groups[key] = { video: video, question: question, scores: [], raters: {}, errors: 0 };
      order.push(key);
    }
    var score = row[col.score];
    if (row[col.note] === 'playback_error' || score === '' || score === null) {
      g.errors += 1;
      return;
    }
    score = Number(score);
    g.scores.push(score);
    g.raters[row[col.rater_id]] = true;
    if (score > maxScore) maxScore = score;
  });

  var head = ['video_id', 'question', 'n', 'MOS', 'SD', 'CI95 (±)', 'min', 'max', 'unique_raters', 'playback_errors'];
  for (var s = 1; s <= maxScore; s++) head.push('#' + s);

  order.sort();
  var rows = order.map(function (key) {
    var g = groups[key];
    var st = stats_(g.scores);
    var r = [g.video, g.question, st.n, st.mean, st.sd, '', st.min, st.max, Object.keys(g.raters).length, g.errors];
    for (var s = 1; s <= maxScore; s++) {
      r.push(g.scores.filter(function (x) { return x === s; }).length);
    }
    return r;
  });

  var sheet = ss.getSheetByName(SUMMARY_SHEET) || ss.insertSheet(SUMMARY_SHEET);
  sheet.clear();
  if (sheet.getMaxRows() < rows.length + 1) sheet.insertRowsAfter(sheet.getMaxRows(), rows.length + 1 - sheet.getMaxRows());
  if (sheet.getMaxColumns() < head.length) sheet.insertColumnsAfter(sheet.getMaxColumns(), head.length - sheet.getMaxColumns());
  sheet.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
  sheet.setFrozenRows(1);
  if (rows.length) {
    sheet.getRange(2, 1, rows.length, 2).setNumberFormat('@');
    sheet.getRange(2, 1, rows.length, head.length).setValues(rows);
    // 95% CI half-width using the t distribution: t(0.975, n-1) * SD / sqrt(n).
    var ci = rows.map(function (_, i) {
      var r = i + 2;
      return ['=IF(C' + r + '>1, T.INV.2T(0.05, C' + r + '-1) * E' + r + ' / SQRT(C' + r + '), "")'];
    });
    sheet.getRange(2, 6, rows.length, 1).setFormulas(ci);
    sheet.getRange(2, 4, rows.length, 3).setNumberFormat('0.000');
  }
  sheet.autoResizeColumns(1, head.length);
}

function stats_(xs) {
  var n = xs.length;
  if (!n) return { n: 0, mean: '', sd: '', min: '', max: '' };
  var sum = 0, min = Infinity, max = -Infinity;
  xs.forEach(function (x) { sum += x; if (x < min) min = x; if (x > max) max = x; });
  var mean = sum / n;
  var ss = 0;
  xs.forEach(function (x) { ss += (x - mean) * (x - mean); });
  var sd = n > 1 ? Math.sqrt(ss / (n - 1)) : '';
  return { n: n, mean: mean, sd: sd, min: min, max: max };
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
