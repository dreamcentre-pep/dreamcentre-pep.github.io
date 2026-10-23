/**
 * PEP Magazine automation
 * Reads the weekly Word/Google Doc from Drive, picks images, emails a preview + Approve link,
 * and serves the approved issue to the website (GitHub Action pulls it from ?p=feed).
 *
 * One-time: run setup() from the editor, then Deploy > New deployment > Web app
 * (Execute as: Me, Who has access: Anyone).
 */

var SETTINGS_ID = '1fGA7ETBsirnW-ZVaJonMohjlvLjy7Mgz3OFc7BECkug';
var TZ = 'Africa/Lagos';
var STOP = ('a an and the of to in on for with what who has have not you your is are be by at as it this that from ' +
  'into over our my me i we us will shall can do does did all any every than then so but if or no').split(' ');

/* ---------------- settings ---------------- */
function cfg_() {
  var sh = SpreadsheetApp.openById(SETTINGS_ID).getSheets()[0];
  var rows = sh.getDataRange().getValues(), c = {};
  rows.forEach(function (r) { if (r[0]) c[String(r[0]).trim().toLowerCase()] = String(r[1] || '').trim(); });
  var list = function (s) { return (s || '').split(/[,;\s]+/).filter(function (x) { return x.indexOf('@') > 0; }); };
  return {
    approvers: list(c['approver emails']),
    notify: list(c['notify emails']),
    mode: (c['image mode'] || 'Library + stock').toLowerCase(),
    pexels: c['pexels api key'] || '',
    publish: parseDayTime_(c['publish day and time'] || 'Saturday 18:00'),
    reminder: parseDayTime_(c['reminder day and time'] || 'Saturday 15:00'),
    website: (c['website'] || 'https://dreamcentre-pep.github.io').replace(/\/$/, ''),
    issues: c['issues folder id'], monthly: c['monthly folder id'],
    library: c['image library folder id'], templates: c['templates folder id']
  };
}
function parseDayTime_(s) {
  var days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  var m = String(s).toLowerCase().match(/([a-z]+)\s+(\d{1,2})[:.](\d{2})/) || [];
  var d = days.indexOf(m[1]); return { dow: d < 0 ? 6 : d, h: +(m[2] || 18), m: +(m[3] || 0) };
}
/** Date (Lagos) of the weekday on or before the Sunday, at h:m. */
function dueTime_(sundayIso, dt) {
  var back = (7 - dt.dow) % 7;           // Saturday -> 1 day before Sunday
  var p = sundayIso.split('-');
  var utc = Date.UTC(+p[0], +p[1] - 1, +p[2] - back, dt.h - 1, dt.m); // Lagos = UTC+1, no DST
  return new Date(utc);
}
function todayIso_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }
function prettyDate_(iso) {
  var p = iso.split('-'); var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2], 12));
  return Utilities.formatDate(d, 'UTC', 'EEEE d MMMM yyyy');
}
var CUR_DATE = '';
var props_ = PropertiesService.getScriptProperties();
function getJ_(k, d) { var v = props_.getProperty(k); return v ? JSON.parse(v) : d; }
function setJ_(k, v) { props_.setProperty(k, JSON.stringify(v)); }

/* ---------------- status sheet ---------------- */
function statusSheet_() {
  var ss = SpreadsheetApp.openById(SETTINGS_ID), sh = ss.getSheetByName('Issues');
  if (!sh) {
    sh = ss.insertSheet('Issues');
    sh.appendRow(['Sunday', 'Status', 'Last built', 'Approved at', 'Published at', 'Notes']);
    sh.setFrozenRows(1); sh.getRange('A1:F1').setFontWeight('bold');
  }
  return sh;
}
function setStatus_(date, fields) {
  var sh = statusSheet_(), vals = sh.getDataRange().getValues(), row = -1;
  for (var i = 1; i < vals.length; i++) if (String(vals[i][0]) === date) row = i + 1;
  if (row < 0) { sh.appendRow([date, '', '', '', '', '']); row = sh.getLastRow(); }
  var cols = { status: 2, built: 3, approved: 4, published: 5, notes: 6 };
  Object.keys(fields).forEach(function (k) { sh.getRange(row, cols[k]).setNumberFormat('@').setValue(fields[k]); });
}
function stamp_() { return Utilities.formatDate(new Date(), TZ, 'EEE d MMM, HH:mm'); }

/* ---------------- setup ---------------- */
function setup() {
  var c = cfg_();
  statusSheet_();
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('tick').timeBased().everyMinutes(15).create();
  // Monthly template as a Google Doc copy of the current month's doc
  var tpl = DriveApp.getFolderById(c.templates);
  if (!tpl.getFilesByName('PEP Monthly Template').hasNext()) {
    var it = DriveApp.getFolderById(c.monthly).getFolders();
    while (it.hasNext()) {
      var f = it.next().getFiles();
      while (f.hasNext()) { var x = f.next(); if (x.getMimeType() === MimeType.GOOGLE_DOCS) { x.makeCopy('PEP Monthly Template', tpl); break; } }
      break;
    }
  }
  if (!props_.getProperty('secret')) props_.setProperty('secret', Utilities.getUuid());
  Logger.log('Setup done. Now deploy as a web app.');
}

/* ---------------- main loop (every 15 min) ---------------- */
function tick() {
  var lock = LockService.getScriptLock(); if (!lock.tryLock(5000)) return;
  try {
    var c = cfg_(); scanIssues_(c); remindAndPublish_(c);
  } catch (e) { notifyError_('Automatic check failed', e); }
  finally { lock.releaseLock(); }
}

function upcomingSunday_() {
  var t = new Date(); var lag = new Date(t.getTime() + 3600e3);
  var dow = lag.getUTCDay(); var add = (7 - dow) % 7;
  var s = new Date(Date.UTC(lag.getUTCFullYear(), lag.getUTCMonth(), lag.getUTCDate() + add, 12));
  return Utilities.formatDate(s, 'UTC', 'yyyy-MM-dd');
}

function scanIssues_(c) {
  var folders = DriveApp.getFolderById(c.issues).getFolders(), today = todayIso_();
  while (folders.hasNext()) {
    var folder = folders.next();
    var fp = fingerprint_(folder, c);
    var key = 'fp:' + folder.getId();
    if (props_.getProperty(key) === fp) continue;
    var doc = findDoc_(folder); if (!doc) continue;
    try {
      var issue = buildIssue_(folder, doc, c);
      if (issue.date < today) { props_.setProperty(key, fp); continue; }
      var st = getJ_('st:' + issue.date, {});
      var wasApproved = st.status === 'Approved' || st.status === 'Published';
      st.folder = folder.getId(); st.token = st.token || Utilities.getUuid().replace(/-/g, '');
      st.status = 'Draft'; st.built = stamp_();
      setJ_('st:' + issue.date, st);
      writeJson_(folder, '_issue.json', issue);
      setStatus_(issue.date, { status: 'Waiting for approval', built: st.built, notes: issue.warnings.join(' ') });
      if (!st.mailed || wasApproved) { mailDraft_(c, issue, st, wasApproved); st.mailed = true; setJ_('st:' + issue.date, st); }
      props_.setProperty(key, fp);
    } catch (e) { notifyError_('Could not read the issue in folder "' + folder.getName() + '"', e); props_.setProperty(key, fp); }
  }
}

function fingerprint_(folder, c) {
  var parts = [], f = folder.getFiles();
  while (f.hasNext()) { var x = f.next(); if (x.getName().charAt(0) !== '_') parts.push(x.getId() + x.getLastUpdated().getTime()); }
  var m = DriveApp.getFolderById(c.monthly).getFolders();
  while (m.hasNext()) { var mf = m.next().getFiles(); while (mf.hasNext()) { var y = mf.next(); parts.push(y.getId() + y.getLastUpdated().getTime()); } }
  parts.push(props_.getProperty('swap:' + folder.getId()) || '');
  parts.sort(); return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, parts.join('|')));
}

function remindAndPublish_(c) {
  var sunday = upcomingSunday_(), now = new Date();
  var st = getJ_('st:' + sunday, null);
  var rem = dueTime_(sunday, c.reminder), pub = dueTime_(sunday, c.publish);
  var flags = getJ_('flags:' + sunday, {});
  if (now >= rem && now < pub && !flags.reminded) {
    if (!st) mail_(c.notify.concat(c.approvers), 'No PEP Magazine issue yet for ' + prettyDate_(sunday),
      '<p>No issue has been added to the Issues folder for <b>' + prettyDate_(sunday) + '</b>. Last week\'s issue will stay online until one is approved.</p>');
    else if (st.status === 'Draft') mailDraft_(c, readJson_(DriveApp.getFolderById(st.folder), '_issue.json'), st, false, true);
    flags.reminded = true; setJ_('flags:' + sunday, flags);
  }
  // mark published once release time passed
  if (st && st.status === 'Approved' && now >= releaseAt_(sunday, st, c)) {
      st.status = 'Published'; st.published = stamp_(); setJ_('st:' + sunday, st);
      setStatus_(sunday, { status: 'Live', published: st.published });
      mail_(c.notify, 'PEP Magazine for ' + prettyDate_(sunday) + ' is now live',
        '<p>The issue is now live at <a href="' + c.website + '">' + c.website + '</a>. It can take up to 15 minutes to appear.</p>');
  }
}
function releaseAt_(sunday, st, c) {
  var pub = dueTime_(sunday, c.publish);
  var ap = st.approvedAt ? new Date(st.approvedAt) : null;
  return ap && ap > pub ? ap : pub;
}

/* ---------------- document parsing ---------------- */
function findDoc_(folder) {
  var f = folder.getFiles(), best = null;
  while (f.hasNext()) {
    var x = f.next(), mt = x.getMimeType(), n = x.getName();
    if (n.charAt(0) === '_' || n.charAt(0) === '~') continue;
    if (mt === MimeType.GOOGLE_DOCS || mt === MimeType.MICROSOFT_WORD || /\.docx$/i.test(n)) {
      if (!best || x.getLastUpdated() > best.getLastUpdated()) best = x;
    }
  }
  return best;
}
function openAsDoc_(file) {
  if (file.getMimeType() === MimeType.GOOGLE_DOCS) return { doc: DocumentApp.openById(file.getId()), temp: null };
  var res = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + file.getId() + '/copy', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    payload: JSON.stringify({ name: '_tmp_' + file.getName(), mimeType: 'application/vnd.google-apps.document' })
  });
  if (res.getResponseCode() >= 300) throw new Error('Could not convert the Word file: ' + res.getContentText());
  var id = JSON.parse(res.getContentText()).id;
  return { doc: DocumentApp.openById(id), temp: id };
}
function norm_(s) { return String(s).toLowerCase().replace(/[^a-z0-9]/g, ''); }
var LABELS = ['sunday date', 'service title', 'cover image keywords', 'accent colour (optional)', 'accent colour', 'accent color',
  'title', 'quote', 'authors', 'study number', 'image keywords', 'reference', 'text', 'line', 'verse', 'opening', 'name', 'zone',
  'month', 'month theme', 'series', 'subtitle'];

/** Returns {sectionKey: {fields:{}, blocks:[], images:[Blob]}} */
function readSections_(doc) {
  var body = doc.getBody(), out = {}, cur = null;
  for (var i = 0; i < body.getNumChildren(); i++) {
    var el = body.getChild(i), type = el.getType();
    if (type !== DocumentApp.ElementType.PARAGRAPH && type !== DocumentApp.ElementType.LIST_ITEM) continue;
    var p = type === DocumentApp.ElementType.PARAGRAPH ? el.asParagraph() : el.asListItem();
    var text = p.getText().replace(/\u00a0/g, ' ').trim(), head = p.getHeading();
    if (type === DocumentApp.ElementType.PARAGRAPH && head === DocumentApp.ParagraphHeading.HEADING1) {
      var k = norm_(text); if (k.indexOf('propheticwords') === 0) k = 'prophetic';
      cur = out[k] = { title: text, fields: {}, blocks: [], images: [] }; continue;
    }
    if (!cur) continue;
    for (var j = 0; j < p.getNumChildren(); j++) {
      var ch = p.getChild(j);
      if (ch.getType() === DocumentApp.ElementType.INLINE_IMAGE) cur.images.push(ch.asInlineImage().getBlob());
    }
    if (!text || /^tip:/i.test(text)) continue;
    if (type === DocumentApp.ElementType.LIST_ITEM) {
      var g = p.getGlyphType(), numbered = g === DocumentApp.GlyphType.NUMBER || g === DocumentApp.GlyphType.LATIN_LOWER ||
        g === DocumentApp.GlyphType.LATIN_UPPER || g === DocumentApp.GlyphType.ROMAN_LOWER || g === DocumentApp.GlyphType.ROMAN_UPPER;
      var last = cur.blocks[cur.blocks.length - 1];
      if (last && last.list && last.numbered === numbered) last.list.push(text);
      else cur.blocks.push({ list: [text], numbered: numbered });
      continue;
    }
    if (head === DocumentApp.ParagraphHeading.HEADING2 || head === DocumentApp.ParagraphHeading.HEADING3) { cur.blocks.push({ h: text }); continue; }
    var m = text.match(/^([A-Za-z][A-Za-z0-9 ()']{1,40}):\s*(.*)$/);
    if (m) {
      var lab = m[1].trim().toLowerCase();
      if (lab === 'scripture') { var sp = m[2].split('|'); cur.blocks.push({ scripture: (sp[1] || sp[0]).trim(), ref: sp[1] ? sp[0].trim() : '' }); continue; }
      if (lab === 'highlight') { cur.blocks.push({ callout: m[2].trim() }); continue; }
      if (lab === 'programme' || lab === 'program') { (cur.programmes = cur.programmes || []).push(m[2]); continue; }
      if (LABELS.indexOf(lab) >= 0 && !(lab in cur.fields)) { cur.fields[lab] = m[2].trim(); continue; }
    }
    cur.blocks.push({ p: text });
  }
  return out;
}
var MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
function parseDate_(s) {
  s = String(s || '').trim(); var m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return iso_(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/))) return iso_(+m[3], +m[2], +m[1]);
  if ((m = s.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\.?,?\s+(\d{4})/i))) return iso_(+m[3], monthNo_(m[2]), +m[1]);
  return null;
}
function monthNo_(name) { var n = name.toLowerCase().slice(0, 3); for (var i = 0; i < 12; i++) if (MONTHS[i].indexOf(n) === 0) return i + 1; return 0; }
function iso_(y, m, d) { return y + '-' + ('0' + m).slice(-2) + '-' + ('0' + d).slice(-2); }
function paras_(sec) { return (sec ? sec.blocks : []).filter(function (b) { return b.p; }).map(function (b) { return b.p; }); }
function f_(sec, k) { return sec && sec.fields[k] ? sec.fields[k] : ''; }

function buildIssue_(folder, file, c) {
  var o = openAsDoc_(file), S;
  try { S = readSections_(o.doc); } finally { if (o.temp) DriveApp.getFileById(o.temp).setTrashed(true); }
  var warn = [];
  var is = S.issue || { fields: {}, blocks: [] };
  var date = parseDate_(f_(is, 'sunday date')) || parseDate_(folder.getName());
  if (!date) throw new Error('No Sunday date found. Fill in "Sunday date" under the Issue heading, e.g. 25/10/2026.');
  var fh = S.fromthefathersheart, ps = fh ? paras_(fh) : [];
  var salutation = ps.length && /beloved|^dear/i.test(ps[0]) ? ps.shift() : 'Dearly Beloved,';
  var closing = ps.length && /till next week|go and win/i.test(ps[ps.length - 1]) ? ps.pop() : 'Till next week, go and win with Jesus.';
  var y = +date.slice(0, 4), mo = +date.slice(5, 7);
  var bible = paras_(S.bibleinayear).map(function (line) {
    var parts = line.split('|').map(function (x) { return x.trim(); });
    var m = parts[0].match(/(\d{1,2})\s*([a-z]+)/i) || parts[0].match(/([a-z]+)\s*(\d{1,2})/i); if (!m) return null;
    var d = /^\d/.test(m[1]) ? +m[1] : +m[2], mn = monthNo_(/^\d/.test(m[1]) ? m[2] : m[1]);
    var yy = y + (mn < mo - 6 ? 1 : mn > mo + 6 ? -1 : 0);
    return { date: iso_(yy, mn, d), readings: parts.slice(1).filter(String) };
  }).filter(Boolean);
  var st = S.pepstudies, gw = S.greaterworksscripture, cv = S.covenantinthehouse, hy = S.hymn, av = S.anointedvocabulary, ts = S.testimony;
  var issue = {
    date: date, status: 'draft', accent: (f_(is, 'accent colour (optional)') || f_(is, 'accent colour') || f_(is, 'accent color')).match(/#?[0-9a-f]{6}/i) ? ('#' + (f_(is, 'accent colour (optional)') || f_(is, 'accent colour') || f_(is, 'accent color')).match(/[0-9a-f]{6}/i)[0]) : '',
    service: { title: f_(is, 'service title') || 'Sunday Service', background: null },
    fathersHeart: fh ? { title: f_(fh, 'title'), salutation: salutation, paragraphs: ps, quote: f_(fh, 'quote') || (ps[1] || '').split('. ')[0], closing: closing, signature: "God's Servant,\nRev. Olusola Areogun" } : null,
    messageForWeek: S.messagefortheweek && f_(S.messagefortheweek, 'title') ? { title: f_(S.messagefortheweek, 'title'), image: null } : null,
    bookForWeek: S.bookfortheweek && f_(S.bookfortheweek, 'title') ? { title: f_(S.bookfortheweek, 'title'), authors: f_(S.bookfortheweek, 'authors'), image: null } : null,
    hymn: hy ? { title: f_(hy, 'title'), reference: f_(hy, 'reference') } : null,
    study: st ? { number: f_(st, 'study number'), title: f_(st, 'title'), image: null, blocks: st.blocks.map(function (b) { if (b.list) return { list: b.list }; return b; }) } : null,
    greaterWorks: gw ? { reference: f_(gw, 'reference'), text: f_(gw, 'text'), image: null } : null,
    covenant: cv ? { title: f_(cv, 'title'), line: f_(cv, 'line'), image: null } : null,
    bibleInYear: bible,
    vocabulary: av ? { reference: f_(av, 'reference'), verse: f_(av, 'verse'), items: av.blocks.filter(function (b) { return b.list; }).reduce(function (a, b) { return a.concat(b.list); }, []) } : null,
    propheticWords: S.prophetic ? S.prophetic.blocks.reduce(function (a, b) { return a.concat(b.list || (b.p ? [b.p] : [])); }, []) : [],
    testimony: ts ? { opening: f_(ts, 'opening'), paragraphs: paras_(ts), author: f_(ts, 'name'), zone: f_(ts, 'zone') } : null,
    programmes: ((S.notices && S.notices.programmes) || []).map(function (x) { var p = x.split('|'); return { title: p[0].trim(), dates: (p[1] || '').trim() }; }),
    credits: [], warnings: warn
  };
  if (!issue.fathersHeart) warn.push("From the Father's Heart is missing.");
  if (!bible.length) warn.push('Bible in a Year readings are missing.');

  // Images
  CUR_DATE = date;
  var used = getJ_('used', {}), exclude = getJ_('swap:' + folder.getId(), []);
  var pick = function (slot, keywords, sec, allowStock) {
    var r = pickImage_(slot, keywords, folder, sec, c, used, exclude, allowStock);
    if (r && r.credit) issue.credits.push(r.credit);
    if (r) used[r.key] = date;
    return r;
  };
  issue.service.background = pick('cover', f_(is, 'cover image keywords') || (issue.fathersHeart && issue.fathersHeart.title) || 'golden light', null, true);
  if (issue.study) issue.study.image = pick('study', f_(st, 'image keywords') || issue.study.title, st, true);
  if (issue.covenant) issue.covenant.image = pick('covenant', f_(cv, 'image keywords') || issue.covenant.title, cv, true);
  if (issue.greaterWorks) issue.greaterWorks.image = pick('greater', f_(gw, 'image keywords') || 'eagle sky', gw, true);
  if (issue.messageForWeek) issue.messageForWeek.image = pick('message', '', S.messagefortheweek, false);
  if (issue.bookForWeek) { issue.bookForWeek.image = pick('book', '', S.bookfortheweek, false); if (!issue.bookForWeek.image) warn.push('Book for the Week has no cover image, so it is hidden.'); }
  setJ_('used', trimUsed_(used));

  issue.month = buildMonth_(date, c, used);
  return issue;
}
function trimUsed_(u) { var keys = Object.keys(u); if (keys.length < 300) return u; keys.sort(function (a, b) { return u[a] < u[b] ? -1 : 1; }); keys.slice(0, keys.length - 300).forEach(function (k) { delete u[k]; }); return u; }

function buildMonth_(date, c, used) {
  var ym = date.slice(0, 7), it = DriveApp.getFolderById(c.monthly).getFolders(), folder = null;
  while (it.hasNext()) { var f = it.next(); if (f.getName().indexOf(ym) === 0) folder = f; }
  if (!folder) return null;
  var file = findDoc_(folder); if (!file) return null;
  var o = openAsDoc_(file), S;
  try { S = readSections_(o.doc); } finally { if (o.temp) DriveApp.getFileById(o.temp).setTrashed(true); }
  var mh = S.month || { fields: {}, blocks: [] }, w = S.godswordforthemonth || { fields: {}, blocks: [] };
  var y = +ym.slice(0, 4), m = +ym.slice(5, 7), sundays = [];
  for (var d = 1; d <= 31; d++) { var dt = new Date(Date.UTC(y, m - 1, d, 12)); if (dt.getUTCMonth() !== m - 1) break; if (dt.getUTCDay() === 0) sundays.push(iso_(y, m, d)); }
  var blocks = w.blocks.slice(); if (blocks[0] && blocks[0].p) blocks[0] = { lead: blocks[0].p };
  var cached = getJ_('monthimg:' + ym, null), fixed = pickImage_('month', '', folder, w, c, used, [], false);
  var img = fixed || cached || pickImage_('month', f_(mh, 'image keywords') || f_(w, 'title'), folder, w, c, {}, [], true);
  if (!fixed && img) setJ_('monthimg:' + ym, img);
  return {
    month: ym,
    honour: { title: f_(mh, 'month theme'), series: f_(mh, 'series'), sundays: sundays },
    word: { title: f_(w, 'title'), subtitle: f_(w, 'subtitle'), image: img, portrait: 'assets/fixed/rev-month.webp', blocks: blocks, signature: "God's Servant,\nOlusola Areogun" },
    credit: img && img.credit || ''
  };
}

/* ---------------- images ---------------- */
function keywords_(s) {
  return String(s || '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(function (w) { return w.length > 2 && STOP.indexOf(w) < 0; });
}
function pickImage_(slot, kw, folder, sec, c, used, exclude, allowStock) {
  // 1. a file named after the slot in the folder (cover.jpg, study.png ...)
  var f = folder.getFiles();
  while (f.hasNext()) { var x = f.next(); if (x.getMimeType().indexOf('image/') === 0 && x.getName().toLowerCase().split('.')[0] === slot) return { drive: x.getId(), key: 'd:' + x.getId() }; }
  // 2. an image pasted in that section of the document
  if (sec && sec.images && sec.images.length) {
    var name = '_' + slot + '.png', old = folder.getFilesByName(name); while (old.hasNext()) old.next().setTrashed(true);
    var saved = folder.createFile(sec.images[0].setName(name));
    return { drive: saved.getId(), key: 'd:' + saved.getId() };
  }
  if (!allowStock) return null;
  var words = keywords_(kw), mode = c.mode;
  var useLib = mode.indexOf('library') >= 0, useStock = mode.indexOf('stock') >= 0 && c.pexels;
  var lib = useLib ? libraryPick_(words, c, used, exclude, mode.indexOf('stock') < 0) : null;
  if (lib && lib.score > 0) return lib;
  if (useStock) { var p = pexelsPick_(words, slot, c, used, exclude); if (p) return p; }
  return lib || (useLib ? null : libraryPick_(words, c, used, exclude, true));
}
function libraryPick_(words, c, used, exclude, anyIfNoMatch) {
  if (!c.library) return null;
  var it = DriveApp.getFolderById(c.library).getFiles(), best = null;
  while (it.hasNext()) {
    var x = it.next(); if (x.getMimeType().indexOf('image/') !== 0) continue;
    var key = 'd:' + x.getId(); if (exclude.indexOf(key) >= 0) continue;
    var toks = keywords_(x.getName().replace(/\.[a-z]+$/i, '').replace(/[-_]/g, ' '));
    var score = 0; words.forEach(function (w) { toks.forEach(function (t) { if (t === w || (w.length > 4 && t.slice(0, 5) === w.slice(0, 5))) score++; }); });
    var age = used[key] && used[key] !== CUR_DATE ? used[key] : '0000';
    if (!best || score > best.score || (score === best.score && age < best.age)) best = { drive: x.getId(), key: key, score: score, age: age };
  }
  if (!best) return null;
  if (best.score === 0 && !anyIfNoMatch) return { drive: best.drive, key: best.key, score: 0 };
  return { drive: best.drive, key: best.key, score: best.score };
}
function pexelsPick_(words, slot, c, used, exclude) {
  var q = words.slice(0, 4).join(' ') || 'light';
  var res = UrlFetchApp.fetch('https://api.pexels.com/v1/search?per_page=30&orientation=' + (slot === 'covenant' ? 'square' : 'landscape') +
    '&query=' + encodeURIComponent(q), { headers: { Authorization: c.pexels }, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return null;
  var photos = JSON.parse(res.getContentText()).photos || [];
  for (var i = 0; i < photos.length; i++) {
    var key = 'p:' + photos[i].id;
    if ((used[key] && used[key] !== CUR_DATE) || exclude.indexOf(key) >= 0) continue;
    return { url: photos[i].src.large2x || photos[i].src.large, key: key, credit: 'Photo: ' + photos[i].photographer + ' / Pexels', avg: photos[i].avg_color };
  }
  return null;
}
function imageBlob_(ref) {
  if (!ref) return null;
  if (ref.url) return UrlFetchApp.fetch(ref.url).getBlob();
  var meta = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + ref.drive + '?fields=thumbnailLink,size',
    { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
  try {
    var m = JSON.parse(meta.getContentText());
    if (m.thumbnailLink && +m.size > 900000) {
      var r = UrlFetchApp.fetch(m.thumbnailLink.replace(/=s\d+$/, '=s1800'), { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
      if (r.getResponseCode() === 200) return r.getBlob();
    }
  } catch (e) { }
  return DriveApp.getFileById(ref.drive).getBlob();
}
function dataUri_(ref) { var b = imageBlob_(ref); return b ? 'data:' + b.getContentType() + ';base64,' + Utilities.base64Encode(b.getBytes()) : null; }

/* ---------------- json helpers ---------------- */
function writeJson_(folder, name, obj) {
  var it = folder.getFilesByName(name); if (it.hasNext()) { it.next().setContent(JSON.stringify(obj)); return; }
  folder.createFile(name, JSON.stringify(obj), MimeType.PLAIN_TEXT);
}
function readJson_(folder, name) { var it = folder.getFilesByName(name); return it.hasNext() ? JSON.parse(it.next().getBlob().getDataAsString()) : null; }

/* ---------------- web app ---------------- */
function doGet(e) {
  var p = e.parameter || {}, c = cfg_();
  try {
    if (p.p === 'feedinfo' || p.p === 'feed') return feed_(c, p.p === 'feed');
    var st = p.d ? getJ_('st:' + p.d, null) : null;
    if (!st || p.t !== st.token) return page_('Link not valid', 'This link is out of date. Use the newest email about this issue.');
    var folder = DriveApp.getFolderById(st.folder);
    if (p.p === 'approve') return approve_(c, p.d, st, folder);
    if (p.p === 'swap') {
      var issue = readJson_(folder, '_issue.json'), slot = p.s;
      var cur = { cover: issue.service.background, study: issue.study && issue.study.image, covenant: issue.covenant && issue.covenant.image, greater: issue.greaterWorks && issue.greaterWorks.image }[slot];
      var ex = getJ_('swap:' + folder.getId(), []); if (cur && cur.key) ex.push(cur.key); setJ_('swap:' + folder.getId(), ex.slice(-60));
      props_.deleteProperty('fp:' + folder.getId()); tick();
      return HtmlService.createHtmlOutput('<meta http-equiv="refresh" content="0;url=' + ScriptApp.getService().getUrl() + '?p=preview&d=' + p.d + '&t=' + p.t + '"><p style="font-family:sans-serif">Picking another image...</p>');
    }
    return preview_(c, p.d, st, folder);
  } catch (err) { return page_('Something went wrong', String(err)); }
}
function page_(title, msg) {
  return HtmlService.createHtmlOutput('<div style="font-family:system-ui,sans-serif;max-width:520px;margin:15vh auto;padding:0 20px"><h2>' + title + '</h2><p style="font-size:17px;line-height:1.5">' + msg + '</p></div>')
    .setTitle(title).addMetaTag('viewport', 'width=device-width,initial-scale=1');
}
function bundleFor_(c, issue, inline) {
  var assets = {}, n = 0;
  var conv = function (ref, path) { if (!ref) return null; var key = path || ('img/' + (n++)); assets[key] = inline ? dataUri_(ref) : ref; return key; };
  var I = JSON.parse(JSON.stringify(issue));
  I.service.background = conv(issue.service.background, 'cover');
  if (I.study) I.study.image = conv(issue.study.image, 'study');
  if (I.covenant) I.covenant.image = conv(issue.covenant.image, 'covenant');
  if (I.greaterWorks) I.greaterWorks.image = conv(issue.greaterWorks.image, 'greater');
  if (I.messageForWeek) { if (issue.messageForWeek.image) I.messageForWeek.image = conv(issue.messageForWeek.image, 'message'); else I.messageForWeek = null; }
  if (I.bookForWeek) { if (issue.bookForWeek.image) I.bookForWeek.image = conv(issue.bookForWeek.image, 'book'); else I.bookForWeek = null; }
  var M = I.month; delete I.month;
  if (M && M.word) M.word.image = conv(issue.month.word.image, 'month');
  if (M && M.credit) I.credits.push(M.credit);
  return { issue: I, month: M, assets: assets };
}
function preview_(c, date, st, folder) {
  var issue = readJson_(folder, '_issue.json');
  var b = bundleFor_(c, issue, true), base = ScriptApp.getService().getUrl() + '?d=' + date + '&t=' + st.token;
  var site = JSON.parse(UrlFetchApp.fetch(c.website + '/data/site.json').getContentText());
  Object.keys(site).forEach(function (k) { if (typeof site[k] === 'string' && site[k].indexOf('assets/') === 0) b.assets[site[k]] = c.website + '/' + site[k]; });
  b.assets['assets/fixed/rev-month.webp'] = c.website + '/assets/fixed/rev-month.webp';
  b.issue.status = st.status === 'Draft' ? 'draft' : 'approved';
  b.issue.preview = {
    approve: base + '&p=approve', status: st.status,
    swap: ['cover', 'study', 'covenant', 'greater'].filter(function (s) { var r = { cover: issue.service.background, study: issue.study && issue.study.image, covenant: issue.covenant && issue.covenant.image, greater: issue.greaterWorks && issue.greaterWorks.image }[s]; return r && !r.drive; })
      .map(function (s) { return { slot: s, url: base + '&p=swap&s=' + s }; })
  };
  var html = UrlFetchApp.fetch(c.website + '/index.html?v=' + Date.now()).getContentText();
  var inject = '<script>window.PEP_DATA=' + JSON.stringify({ site: site, issue: b.issue, month: b.month }).replace(/</g, '\\u003c') +
    ';window.PEP_ASSETS=' + JSON.stringify(b.assets) + ';</script>\n';
  html = html.replace('<script>\n(function(){', inject + '<script>\n(function(){');
  return HtmlService.createHtmlOutput(html).setTitle('PEP preview ' + date).addMetaTag('viewport', 'width=device-width,initial-scale=1,viewport-fit=cover');
}
function approve_(c, date, st, folder) {
  if (st.status === 'Draft') {
    var issue = readJson_(folder, '_issue.json');
    writeJson_(folder, '_approved.json', issue);
    st.status = 'Approved'; st.approvedAt = new Date().toISOString(); st.version = Utilities.getUuid().slice(0, 8);
    setJ_('st:' + date, st);
    var approvedList = getJ_('approvedDates', []); if (approvedList.indexOf(date) < 0) approvedList.push(date); setJ_('approvedDates', approvedList.sort());
    setStatus_(date, { status: 'Approved', approved: stamp_() });
    mail_(c.notify, 'PEP Magazine for ' + prettyDate_(date) + ' was approved', '<p>It will go live ' + whenLive_(date, st, c) + '.</p>');
  }
  return page_('Approved', 'Thank you. The issue for <b>' + prettyDate_(date) + '</b> is approved and will go live ' + whenLive_(date, st, c) + '.');
}
function whenLive_(date, st, c) {
  var r = releaseAt_(date, st, c);
  return new Date() >= r ? 'within the next 15 minutes' : 'on ' + Utilities.formatDate(r, TZ, "EEEE d MMMM 'at' h:mm a");
}
/** What the website should show right now. */
function currentApproved_(c) {
  var list = getJ_('approvedDates', []), now = new Date();
  for (var i = list.length - 1; i >= 0; i--) {
    var st = getJ_('st:' + list[i], null); if (!st || !st.approvedAt) continue;
    if (now >= releaseAt_(list[i], st, c)) return { date: list[i], st: st };
  }
  return null;
}
function feed_(c, full) {
  var cur = currentApproved_(c), out = { ok: !!cur };
  if (cur) {
    out.date = cur.date; out.version = cur.st.version || cur.st.approvedAt;
    if (full) {
      var folder = DriveApp.getFolderById(cur.st.folder), issue = readJson_(folder, '_approved.json');
      var b = bundleFor_(c, issue, false), imgs = {};
      Object.keys(b.assets).forEach(function (k) { var blob = imageBlob_(b.assets[k]); if (blob) imgs[k] = { type: blob.getContentType(), b64: Utilities.base64Encode(blob.getBytes()) }; });
      out.issue = b.issue; out.month = b.month; out.images = imgs;
    }
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------------- email ---------------- */
function mail_(to, subject, html) {
  to = (to || []).filter(function (x, i, a) { return a.indexOf(x) === i; });
  if (!to.length) return;
  MailApp.sendEmail({ to: to.join(','), subject: subject, name: 'PEP Magazine', htmlBody:
    '<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a;max-width:560px">' + html + '</div>' });
}
function btn_(href, label, dark) {
  return '<a href="' + href + '" style="display:inline-block;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:bold;margin:6px 8px 6px 0;' +
    (dark ? 'background:#1a1a1a;color:#fff' : 'background:#fec91b;color:#1a1406') + '">' + label + '</a>';
}
function mailDraft_(c, issue, st, again, reminder) {
  var base = ScriptApp.getService().getUrl() + '?d=' + issue.date + '&t=' + st.token;
  var when = Utilities.formatDate(dueTime_(issue.date, c.publish), TZ, "EEEE 'at' h:mm a");
  var subj = (reminder ? 'Reminder: ' : again ? 'Updated, please approve again: ' : '') + 'PEP Magazine for ' + prettyDate_(issue.date);
  var warn = issue.warnings && issue.warnings.length ? '<p style="color:#9a3412"><b>Check:</b> ' + issue.warnings.join(' ') + '</p>' : '';
  mail_(c.approvers.concat(c.notify), subj,
    '<p>The PEP Magazine for <b>' + prettyDate_(issue.date) + '</b> is ready' + (again ? ' again after changes' : '') + '.</p>' +
    '<p>Open the preview, check it, then tap <b>Approve</b>. Once approved it goes live on ' + when + '. If it is approved after that, it goes live straight away.</p>' +
    warn + '<p>' + btn_(base + '&p=preview', 'Open preview', true) + btn_(base + '&p=approve', 'Approve') + '</p>' +
    '<p style="color:#666;font-size:13px">In the preview you can also ask for a different picture. Until this issue is approved, last week\'s issue stays online.</p>');
}
function notifyError_(what, e) {
  try { mail_(cfg_().notify, 'PEP Magazine: ' + what, '<p>' + what + '.</p><p style="color:#666">' + String(e && e.message || e) + '</p>'); } catch (x) { }
}
