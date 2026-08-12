/**
 * SIGNATURE SOCIETY · PROJECT STORE + NOTIFIER
 * =============================================================
 * One Google Apps Script web app behind main.html. It does three jobs:
 *
 *   1. STORE.    Holds every comment, board post, meeting note, schedule
 *                edit and uploaded file in a Google Sheet, so the page
 *                stops being one private copy per browser and becomes
 *                one project everybody sees.
 *   2. FILES.    Puts uploads in a Drive folder instead of stuffing
 *                base64 into localStorage, and hands back a link.
 *   3. MAIL.     Emails someone when they are @mentioned, and emails the
 *                whole team when a Project Update is posted. Every mail
 *                carries a link that opens the exact post it is about.
 *
 * WHY ADDRESSES LIVE HERE AND NOT IN THE PAGE
 * -------------------------------------------
 * The /exec URL sits in main.html, which anyone can read. If a request
 * could name its own recipients, that URL would be an open mail relay:
 * anyone who found it could send mail from this account to anywhere.
 *
 * So the page never sends an address. It sends a NAME, and the address
 * is looked up in the People tab below. The worst a leaked URL can do is
 * mail people who are already on this project.
 *
 * A NOTE ON WHO CAN READ THIS DATA
 * --------------------------------
 * This was a deliberate decision, recorded so nobody is surprised later:
 * there is no passcode. Anyone who finds the /exec URL in the page source
 * can read and write everything in the store, and uploaded files are
 * shared as "anyone with the link" so the page can display them. Do not
 * put anything in here that would matter if it were public.
 *
 * DEPLOYING (once)
 * ----------------
 * 1. Sign in to Google as lindsay@lindsaydev.com. This matters: MailApp
 *    sends from whichever account deploys the script, and that is what
 *    puts lindsay@lindsaydev.com in the From line.
 * 2. script.google.com > New project. Paste this file in. Name it
 *    "SIG project store".
 * 3. Run > Run function > setup. Approve the permissions prompt (Sheets,
 *    Drive and Gmail). This creates the Sheet and the Drive folder and
 *    remembers their ids. The execution log prints the Sheet URL: open
 *    it and fill in the People tab, one row per person, name exactly as
 *    it appears in the page's name dropdown.
 * 4. Run > Run function > sendTestEmail. Confirm the mail arrives before
 *    going any further.
 * 5. Deploy > New deployment > type "Web app".
 *      Execute as:       Me (lindsay@lindsaydev.com)
 *      Who has access:   Anyone
 *    "Anyone" is required. The page calls this without a signed-in
 *    Google session, and "Anyone with a Google account" would reject it.
 * 6. Copy the /exec URL and paste it into STORE_URL in main.html.
 *
 * Re-deploying after an edit: Deploy > Manage deployments > pencil icon >
 * Version: New version. Editing the code alone does NOT update the live
 * endpoint. The URL stays the same across versions.
 *
 * QUOTA: consumer Gmail allows ~100 recipients/day, Workspace ~1500.
 * A Project Update mails the whole roster, so on a consumer account that
 * is roughly 20 updates a day. Well clear of normal use.
 */

/* ---- Settings ------------------------------------------------------- */

/** Where the page lives. Every link in every email is built from this. */
var SITE_URL = "https://sigsociety.lindsaydev.com/main.html";

/** Shown as the sender name on everything this script sends. */
var MAIL_FROM_NAME = "Signature Society Project";

/** Names of the tabs inside the store Sheet. */
var TAB_RECORDS = "Records";
var TAB_PEOPLE  = "People";
var TAB_LOG     = "Log";

/**
 * Biggest upload accepted, before base64 inflates it by a third. Apps
 * Script rejects very large POST bodies outright, and a browser tab
 * building the base64 string of a huge file will stall first, so this is
 * refused politely in the page rather than failing halfway up.
 */
var MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/**
 * How long a write waits for the lock before giving up. Writes are
 * serialised so two people saving at the same moment cannot interleave
 * a read and a write and lose one of the two changes.
 */
var LOCK_WAIT_MS = 20000;

/* ---- Endpoint ------------------------------------------------------- */

/**
 * Reads come in as GET so they stay cacheable and simple, writes as POST
 * with Content-Type: text/plain. That content type is deliberate: it
 * keeps the request "simple" in CORS terms, so the browser skips the
 * preflight OPTIONS call, which Apps Script does not answer usefully.
 *
 * Supports ?callback=fn for JSONP. Apps Script serves its real response
 * from a redirect to script.googleusercontent.com, which does send an
 * open CORS header, so plain fetch normally works. JSONP is the escape
 * hatch if Google ever changes that, and the page has a switch for it.
 */
function doGet(e) {
  var params = (e && e.parameter) || {};
  var out;
  try {
    out = handle({
      action: params.action || "pull",
      since: params.since ? Number(params.since) : 0
    });
  } catch (err) {
    out = { ok: false, error: String(err) };
  }
  return reply(out, params.callback);
}

function doPost(e) {
  var params = (e && e.parameter) || {};
  var req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || "{}");
  } catch (err) {
    return reply({ ok: false, error: "bad json" }, params.callback);
  }
  var out;
  try {
    out = handle(req);
  } catch (err) {
    // Logged to the execution log, not handed back to the caller.
    console.error("store error: " + err + " :: " + JSON.stringify(req && req.action));
    out = { ok: false, error: String(err) };
  }
  return reply(out, params.callback);
}

/** One place that turns a result object into a response. */
function reply(obj, callback) {
  var json = JSON.stringify(obj);
  if (callback) {
    return ContentService
      .createTextOutput(callback + "(" + json + ");")
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService
    .createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}

/** The router. Every action the page can ask for is listed here. */
function handle(req) {
  switch (req.action) {
    case "pull":         return pull(Number(req.since) || 0);
    case "put":          return put(req);
    case "del":          return del(req);
    case "putMany":      return putMany(req);
    case "append":       return append(req);
    case "upload":       return upload(req);
    case "notifyMention":return notifyMention(req);
    case "notifyUpdate": return notifyUpdate(req);
    case "ping":         return { ok: true, now: Date.now(), people: peopleNames() };
    default:             return { ok: false, error: "unknown action" };
  }
}

/* ---- The store ------------------------------------------------------ */

/**
 * Everything changed since a timestamp. The page sends the `now` it got
 * from its previous pull, so a poll returns nothing at all when nothing
 * has happened, which is the normal case.
 *
 * `now` is read BEFORE the rows are, never after. Taking it afterwards
 * would skip any record written during the read itself, and that record
 * would then never appear in any later pull either.
 *
 * People are returned as names only. The page has no use for addresses
 * and this response is readable by anyone, so they stay in the Sheet.
 */
function pull(since) {
  var now = Date.now();
  var sheet = recordsSheet();
  var values = sheet.getDataRange().getValues();
  var out = [];
  // Row 0 is the header.
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (!row[0]) continue;
    var updatedAt = Number(row[4]) || 0;
    if (updatedAt <= since) continue;
    out.push({
      kind: String(row[1]),
      id: String(row[2]),
      payload: parseJSON(row[3]),
      updatedAt: updatedAt,
      updatedBy: String(row[5] || ""),
      deleted: row[6] === true || row[6] === "TRUE"
    });
  }
  return { ok: true, now: now, since: since, records: out, people: peopleNames() };
}

/**
 * Write one record. The key is kind + id, so the page can decide ids
 * itself ("m1755...-482913" for a message, the task id for a task) and
 * writing the same thing twice updates rather than duplicates.
 *
 * Returns the stamp it wrote. The page stores that as its high-water
 * mark so its own write does not come straight back down on the next
 * poll and overwrite what the person has typed since.
 */
function put(req) {
  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_WAIT_MS);
  try {
    var stamp = writeRecord(req.kind, req.id, req.payload, req.actor, false);
    return { ok: true, updatedAt: stamp };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Several records in one call, under a single lock. Used by the one-time
 * seed from Lindsay's browser, where writing a hundred records one
 * request at a time would take minutes and risk stopping half done.
 */
function putMany(req) {
  var items = req.items || [];
  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_WAIT_MS);
  try {
    var stamp = 0;
    for (var i = 0; i < items.length; i++) {
      stamp = writeRecord(items[i].kind, items[i].id, items[i].payload, req.actor, false);
    }
    return { ok: true, count: items.length, updatedAt: stamp };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Adds one item to an array inside a record, server side, under the lock.
 *
 * This exists because of a specific way comments used to get lost. A
 * comment lives inside its task, so saving a comment means writing the
 * whole task back. If two people comment within the same polling window,
 * each is writing a copy of the task that predates the other's comment,
 * and whoever saves second silently erases the first comment.
 *
 * Appending here instead means the read and the write happen inside one
 * lock, against whatever is currently stored, so neither comment can be
 * written on top of the other. `path` walks into the payload, so
 * "comments" reaches a task's own thread and "reviewFiles/2/comments"
 * reaches the thread on its third review file.
 *
 * Items are matched by id, so a retry after a dropped connection adds
 * the comment once rather than twice.
 */
function append(req) {
  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_WAIT_MS);
  try {
    var current = readRecord(req.kind, req.id);
    var payload = current ? current.payload : (req.fallback || {});
    var parts = String(req.path || "").split("/").filter(String);
    var node = payload;

    // Walk to the array's parent, creating plain objects on the way so a
    // comment on a task that has never been written still lands.
    for (var i = 0; i < parts.length - 1; i++) {
      var key = /^\d+$/.test(parts[i]) ? Number(parts[i]) : parts[i];
      if (node[key] == null) node[key] = {};
      node = node[key];
    }
    var last = parts[parts.length - 1];
    if (!Array.isArray(node[last])) node[last] = [];

    var already = false;
    for (var j = 0; j < node[last].length; j++) {
      if (req.item && node[last][j] && node[last][j].id === req.item.id) already = true;
    }
    if (!already) node[last].push(req.item);

    var stamp = writeRecord(req.kind, req.id, payload, req.actor, false);
    return { ok: true, updatedAt: stamp, list: node[last] };
  } finally {
    lock.releaseLock();
  }
}

/** One record by kind and id, or null. Callers hold the lock. */
function readRecord(kind, id) {
  var sheet = recordsSheet();
  var key = kind + ":" + id;
  var values = sheet.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][0]) === key) {
      return { payload: parseJSON(values[i][3]), updatedAt: Number(values[i][4]) || 0 };
    }
  }
  return null;
}

/**
 * Deletes are soft. The row stays with deleted = TRUE and a fresh
 * timestamp, because a hard delete is invisible to a since-based pull:
 * every other browser would keep showing the post forever, having no
 * way to learn it had gone.
 */
function del(req) {
  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_WAIT_MS);
  try {
    var stamp = writeRecord(req.kind, req.id, req.payload || {}, req.actor, true);
    return { ok: true, updatedAt: stamp };
  } finally {
    lock.releaseLock();
  }
}

/**
 * The single point where a row is created or replaced. Callers hold the
 * lock. Row lookup is a linear scan of the key column, which is fine at
 * this size and keeps the sheet readable by hand, which matters more
 * here: this Sheet is also the admin view when something needs fixing.
 */
function writeRecord(kind, id, payload, actor, deleted) {
  var sheet = recordsSheet();
  var key = kind + ":" + id;
  var stamp = Date.now();
  var row = [key, kind, id, JSON.stringify(payload || {}), stamp, actor || "", !!deleted];

  var keys = sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 1), 1).getValues();
  for (var i = 1; i < keys.length; i++) {
    if (String(keys[i][0]) === key) {
      sheet.getRange(i + 1, 1, 1, row.length).setValues([row]);
      return stamp;
    }
  }
  sheet.appendRow(row);
  return stamp;
}

/* ---- Files ---------------------------------------------------------- */

/**
 * Takes a base64 file, writes it to the project Drive folder, shares it
 * by link and hands back a URL. The bytes never touch the Sheet: the
 * record the page then writes holds the Drive id and the link only.
 */
function upload(req) {
  var bytes = Utilities.base64Decode(req.dataBase64 || "");
  if (bytes.length > MAX_UPLOAD_BYTES) {
    return { ok: false, error: "too big" };
  }
  var blob = Utilities.newBlob(bytes, req.mime || "application/octet-stream", req.name || "file");
  var file = filesFolder().createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return {
    ok: true,
    driveId: file.getId(),
    url: "https://drive.google.com/uc?id=" + file.getId(),
    viewUrl: file.getUrl(),
    size: bytes.length
  };
}

/* ---- Mail ----------------------------------------------------------- */

/**
 * Someone was @mentioned. One mail each, to the mentioned people only,
 * addresses resolved from the People tab. A name with no row gets no
 * mail and is logged rather than failing the whole request: the comment
 * itself has already saved by the time this runs, and a typo in a name
 * must never look like a lost comment.
 */
function notifyMention(req) {
  var names = req.names || [];
  var author = String(req.author || "Someone");
  var text = String(req.text || "");
  var where = describeContext(req.context);
  var link = buildLink(req.context);
  var sent = [], skipped = [];

  for (var i = 0; i < names.length; i++) {
    var name = String(names[i] || "").trim();
    if (!name || name === author) continue;          // nobody needs mail about mentioning themselves
    var email = emailFor(name);
    if (!email) { skipped.push(name); continue; }
    MailApp.sendEmail({
      to: email,
      subject: author + " mentioned you in " + where.short,
      htmlBody: mailBody({
        heading: author + " mentioned you",
        where: where.longText,
        author: author,
        text: text,
        link: link,
        cta: "Open the " + where.ctaNoun
      }),
      name: MAIL_FROM_NAME
    });
    sent.push(name);
  }
  if (skipped.length) console.warn("no email on file for: " + skipped.join(", "));
  log("mention", author, where.short + " -> " + sent.join(", "));
  return { ok: true, sent: sent, skipped: skipped };
}

/**
 * A Project Update was posted. This is the one board that mails
 * everybody, which is the whole point of it, so the recipient list is
 * every row in People with notify left on. The author is left off their
 * own announcement.
 */
function notifyUpdate(req) {
  var author = String(req.author || "Someone");
  var text = String(req.text || "");
  var link = buildLink({ kind: "board", board: "updates", id: req.id });
  var rows = peopleRows();
  var sent = [];

  for (var i = 0; i < rows.length; i++) {
    if (!rows[i].email || !rows[i].notify) continue;
    if (rows[i].name === author) continue;
    MailApp.sendEmail({
      to: rows[i].email,
      subject: "Project update from " + author + " · Signature Society Website",
      htmlBody: mailBody({
        heading: "New project update",
        where: author + " posted an update to the Signature Society website project.",
        author: author,
        text: text,
        link: link,
        cta: "Open Project Updates"
      }),
      name: MAIL_FROM_NAME
    });
    sent.push(rows[i].name);
  }
  log("update", author, sent.join(", "));
  return { ok: true, sent: sent };
}

/**
 * Turns the context the page sent into the link that opens exactly that
 * thing. These hashes are read by the router in main.html. Keep the two
 * in step: a hash shape invented here and not handled there sends people
 * to a page that just sits on the timeline.
 */
function buildLink(ctx) {
  ctx = ctx || {};
  if (ctx.kind === "board") {
    return SITE_URL + "#board=" + encodeURIComponent(ctx.board || "messages") +
           "&post=" + encodeURIComponent(ctx.id || "");
  }
  if (ctx.kind === "comment") {
    return SITE_URL + "#task=" + encodeURIComponent(ctx.taskId || "") +
           "&comment=" + encodeURIComponent(ctx.id || "");
  }
  if (ctx.kind === "note") {
    return SITE_URL + "#note=" + encodeURIComponent(ctx.id || "");
  }
  return SITE_URL;
}

/** Human wording for the same context, used in subject lines and body. */
function describeContext(ctx) {
  ctx = ctx || {};
  if (ctx.kind === "board") {
    var boards = {
      messages:    { short: "the Message Board",  noun: "Message Board" },
      suggestions: { short: "Suggestions",        noun: "Suggestions board" },
      updates:     { short: "Project Updates",    noun: "Project Updates board" }
    };
    var b = boards[ctx.board] || boards.messages;
    return { short: b.short, ctaNoun: b.noun, longText: "Posted on " + b.short + "." };
  }
  if (ctx.kind === "comment") {
    var task = ctx.taskName ? '"' + ctx.taskName + '"' : "a task";
    return {
      short: "a comment on " + task,
      ctaNoun: "comment",
      longText: "In the comments on " + task + "."
    };
  }
  if (ctx.kind === "note") {
    return {
      short: "a meeting note",
      ctaNoun: "meeting note",
      longText: "In the meeting notes" + (ctx.taskName ? " for " + ctx.taskName : "") + "."
    };
  }
  return { short: "the project", ctaNoun: "project", longText: "" };
}

/**
 * One mail template for both kinds of notification. Deliberately plain
 * HTML with inline styles: Gmail strips <style> blocks, and Yahoo, which
 * one of the recipients uses, is stricter still.
 */
function mailBody(o) {
  var quoted = escapeHtml(o.text).replace(/\n/g, "<br>");
  return '' +
    '<div style="font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1c2430;">' +
      '<p style="margin:0 0 4px;font-size:17px;font-weight:600;">' + escapeHtml(o.heading) + '</p>' +
      '<p style="margin:0 0 16px;color:#5a6472;">' + escapeHtml(o.where) + '</p>' +
      '<div style="margin:0 0 20px;padding:14px 16px;background:#f4f2ee;border-left:3px solid #7d1128;">' +
        '<div style="font-weight:600;margin-bottom:6px;">' + escapeHtml(o.author) + '</div>' +
        '<div>' + quoted + '</div>' +
      '</div>' +
      '<p style="margin:0 0 24px;">' +
        '<a href="' + o.link + '" style="display:inline-block;background:#1c2430;color:#ffffff;' +
        'text-decoration:none;padding:11px 20px;border-radius:2px;font-size:14px;">' +
        escapeHtml(o.cta) + '</a>' +
      '</p>' +
      '<p style="margin:0;font-size:12px;color:#8a929c;">' +
        'Signature Society website project. If the button does not work, paste this into your browser:<br>' +
        '<span style="color:#5a6472;">' + o.link + '</span>' +
      '</p>' +
    '</div>';
}

/* ---- People --------------------------------------------------------- */

/** Every row of the People tab, normalised. */
function peopleRows() {
  var sheet = peopleSheet();
  var values = sheet.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var name = String(values[i][0] || "").trim();
    if (!name) continue;
    out.push({
      name: name,
      email: String(values[i][1] || "").trim(),
      // Blank counts as on, so a row added in a hurry still gets mail.
      notify: values[i][2] === "" || values[i][2] === true || String(values[i][2]).toUpperCase() === "TRUE"
    });
  }
  return out;
}

/** Names only. This is what the page is allowed to see. */
function peopleNames() {
  return peopleRows().map(function (p) { return p.name; });
}

/** Case-insensitive so "@morgan" and "@Morgan" both land. */
function emailFor(name) {
  var want = String(name || "").trim().toLowerCase();
  var rows = peopleRows();
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].name.toLowerCase() === want) return rows[i].email;
  }
  return "";
}

/* ---- Sheet and folder plumbing -------------------------------------- */

/**
 * Creates the Sheet and the Drive folder and remembers their ids in
 * script properties. Safe to run twice: it reuses whatever already
 * exists rather than making a second copy.
 */
function setup() {
  var props = PropertiesService.getScriptProperties();
  var ss;
  if (props.getProperty("SHEET_ID")) {
    ss = SpreadsheetApp.openById(props.getProperty("SHEET_ID"));
  } else {
    ss = SpreadsheetApp.create("SIG 2026 Website Project Store");
    props.setProperty("SHEET_ID", ss.getId());
  }
  ensureTabs(ss);

  if (!props.getProperty("FOLDER_ID")) {
    var folder = DriveApp.createFolder("SIG 2026 Website Project Files");
    props.setProperty("FOLDER_ID", folder.getId());
  }

  Logger.log("Sheet:  " + ss.getUrl());
  Logger.log("Folder: https://drive.google.com/drive/folders/" + props.getProperty("FOLDER_ID"));
  Logger.log("Now fill in the People tab, then deploy as a web app.");
  return ss.getUrl();
}

function ensureTabs(ss) {
  var records = ss.getSheetByName(TAB_RECORDS);
  if (!records) {
    records = ss.insertSheet(TAB_RECORDS);
    records.appendRow(["key", "kind", "id", "payload", "updatedAt", "updatedBy", "deleted"]);
    records.setFrozenRows(1);
  }
  var people = ss.getSheetByName(TAB_PEOPLE);
  if (!people) {
    people = ss.insertSheet(TAB_PEOPLE);
    people.appendRow(["name", "email", "notify"]);
    people.setFrozenRows(1);
    // Seeded from the names already in the page's dropdown. Addresses
    // are left blank on purpose so nobody is mailed by accident before
    // the list has been checked.
    people.appendRow(["Lindsay", "", true]);
    people.appendRow(["Morgan", "", true]);
    people.appendRow(["Angel", "", true]);
    people.appendRow(["Matt", "", true]);
  }
  var logTab = ss.getSheetByName(TAB_LOG);
  if (!logTab) {
    logTab = ss.insertSheet(TAB_LOG);
    logTab.appendRow(["when", "what", "who", "detail"]);
    logTab.setFrozenRows(1);
  }
  // A brand new spreadsheet arrives with an empty default sheet.
  var first = ss.getSheetByName("Sheet1");
  if (first && ss.getSheets().length > 1) ss.deleteSheet(first);
}

function store() {
  var id = PropertiesService.getScriptProperties().getProperty("SHEET_ID");
  if (!id) throw new Error("Not set up yet. Run setup() once from the editor.");
  return SpreadsheetApp.openById(id);
}

function recordsSheet() { return store().getSheetByName(TAB_RECORDS); }
function peopleSheet()  { return store().getSheetByName(TAB_PEOPLE); }

function filesFolder() {
  var id = PropertiesService.getScriptProperties().getProperty("FOLDER_ID");
  if (!id) throw new Error("Not set up yet. Run setup() once from the editor.");
  return DriveApp.getFolderById(id);
}

/** Who did what, for working out later why a mail did or did not go. */
function log(what, who, detail) {
  try {
    store().getSheetByName(TAB_LOG).appendRow([new Date(), what, who, detail]);
  } catch (err) {
    console.warn("log failed: " + err);
  }
}

/* ---- Helpers -------------------------------------------------------- */

function parseJSON(s) {
  try { return JSON.parse(s || "{}"); } catch (err) { return {}; }
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ---- Run these by hand to check things work ------------------------- */

/**
 * Sends one real mention email to the first person in People who has an
 * address. Run this before wiring up the page, so a silent failure later
 * is known to be the page and not the mail.
 */
function sendTestEmail() {
  var rows = peopleRows().filter(function (p) { return p.email; });
  if (!rows.length) {
    Logger.log("No addresses in the People tab yet. Fill one in and run this again.");
    return;
  }
  notifyMention({
    names: [rows[0].name],
    author: "Test",
    text: "This is a test of the mention notification. If the button below opens the Message Board, the links are working.",
    context: { kind: "board", board: "messages", id: "test" }
  });
  Logger.log("Sent to: " + rows[0].name + " <" + rows[0].email + ">");
}

/** Prints what the page would receive from a cold pull. */
function testPull() {
  var res = pull(0);
  Logger.log(res.records.length + " records, people: " + res.people.join(", "));
}
