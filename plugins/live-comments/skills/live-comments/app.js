(function () {
  "use strict";

  // The session page (tree of topics), the page of one topic and the change
  // review page (its part is in diff.js). The session state comes by long
  // polling; re-rendering keeps unfinished text, focus and scroll position.
  var CFG = window.LIVE_COMMENTS || {};
  var SID = CFG.session;
  var TOPIC = CFG.topic || null;
  // The change review page: el, act and after from diff.js.
  var diff = null;
  var API = "/api/" + encodeURIComponent(SID);
  var app = document.getElementById("lc-app");
  var SEEN_KEY = "lc-seen:" + SID;

  var st = null;
  var rev = -1;
  var online = false;
  var byId = {};
  var kids = {};
  // Expanded branches: topic id → its state at the moment of expanding. Kept
  // in localStorage, so they survive a reload and moving between pages; a
  // topic that closed after expanding is collapsed again.
  var EXP_KEY = "lc-expanded:" + SID;
  var expanded = loadJson(EXP_KEY, {});
  // Ids of Claude's replies the user has seen.
  var seen = loadJson(SEEN_KEY, {});
  // Replies first seen on this page: the "new" mark lives until a reload.
  var fresh = {};
  var deferred = false;
  // The discussion is deleted: the page no longer polls the server.
  var gone = false;
  var toastTimer = null;
  var toastEl = null;
  // Drafts of input fields: field key (data-key) → { text, created, anchor };
  // anchor — the anchor of a question on lines of the changes page. Kept in
  // localStorage, so they survive leaving the page and are shared by tabs.
  var DRAFTS_KEY = "lc-drafts:" + SID;
  var drafts = loadJson(DRAFTS_KEY, {});
  // The field that gets focus as soon as it appears on the page: the draft
  // reached by Alt+X. The field key comes through sessionStorage.
  var FOCUS_KEY = "lc-draft-focus";
  var focusKey = takeFocusKey();
  // Whether the menu of the "Apply resolved" button is open.
  var applyMenu = false;
  // The session page has had a state without questions where it is the
  // user's turn: the first such question that appears opens by itself.
  var autoOpen = false;

  function loadJson(key, dflt) {
    try {
      var v = JSON.parse(window.localStorage.getItem(key) || "null");
      return v && typeof v === "object" ? v : dflt;
    } catch (e) {
      return dflt;
    }
  }

  function saveJson(key, v) {
    try {
      window.localStorage.setItem(key, JSON.stringify(v));
    } catch (e) {
      // Without storage the marks survive only this page.
    }
  }

  // The key of the field waiting for focus after moving to a draft; the key
  // is read once.
  function takeFocusKey() {
    try {
      var key = window.sessionStorage.getItem(FOCUS_KEY);
      window.sessionStorage.removeItem(FOCUS_KEY);
      return key;
    } catch (e) {
      return null;
    }
  }

  // Field key gets focus on the page that opens next.
  function markFocus(key) {
    try {
      window.sessionStorage.setItem(FOCUS_KEY, key);
    } catch (e) {
      // Without storage the draft page opens without focus in the field.
    }
  }

  function make(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function button(label, act, cls) {
    var b = make("button", "lc-btn" + (cls ? " " + cls : ""), label);
    b.type = "button";
    b.setAttribute("data-act", act);
    return b;
  }

  function link(text, tid, cls) {
    var a = make("a", cls || "", text);
    a.href = "/" + SID + "/" + tid;
    return a;
  }

  function clip(s, n) {
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }

  function toast(msg) {
    if (!toastEl) {
      toastEl = make("div", "lc-toast");
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, 3000);
  }

  // ---- Markdown of replies: paragraphs, "- " and "1. " lists, `code`, **bold**, links.

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function inlineMd(t) {
    return t.split(/(`[^`]*`)/).map(function (part) {
      if (part.length > 1 && part.charAt(0) === "`" && part.charAt(part.length - 1) === "`")
        return "<code>" + esc(part.slice(1, -1)) + "</code>";
      return esc(part)
        .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
        .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    }).join("");
  }

  function mdToHtml(text) {
    var out = [];
    String(text || "").split(/\n\s*\n/).forEach(function (block) {
      var lines = block.split("\n").filter(function (l) { return l.trim(); });
      if (!lines.length) return;
      var item = /^\s*(- |\d+\. )/;
      var first = lines.findIndex(function (l) { return item.test(l); });
      if (first > 0) {
        out.push("<p>" + inlineMd(lines.slice(0, first).join(" ")) + "</p>");
        lines = lines.slice(first);
      } else if (first < 0) {
        out.push("<p>" + inlineMd(lines.join(" ")) + "</p>");
        return;
      }
      var items = [];
      lines.forEach(function (l) {
        if (item.test(l)) items.push(l.replace(item, ""));
        else items[items.length - 1] += " " + l.trim();
      });
      var tag = /^\s*- /.test(lines[0]) ? "ul" : "ol";
      out.push("<" + tag + ">" + items.map(function (i) { return "<li>" + inlineMd(i) + "</li>"; }).join("") + "</" + tag + ">");
    });
    return out.join("");
  }

  function md(text, cls) {
    var e = make("div", "lc-md" + (cls ? " " + cls : ""));
    e.innerHTML = mdToHtml(text);
    return e;
  }

  // ---- topics

  function index() {
    byId = {};
    kids = {};
    st.topics.forEach(function (t) {
      byId[t.id] = t;
      (kids[t.parent || ""] = kids[t.parent || ""] || []).push(t);
    });
  }

  // Open ones on top, resolved and declined at the bottom; within them by creation time.
  function ordered(list) {
    return (list || []).map(function (t, i) { return [t, i]; }).sort(function (a, b) {
      var ca = a[0].state === "open" ? 0 : 1, cb = b[0].state === "open" ? 0 : 1;
      if (ca !== cb) return ca - cb;
      if (a[0].created !== b[0].created) return a[0].created < b[0].created ? -1 : 1;
      return a[1] - b[1];
    }).map(function (p) { return p[0]; });
  }

  function titleOf(t) {
    if (t.title) return t.title;
    var first = t.messages.length ? t.messages[0].text : "";
    return clip(first.replace(/\s+/g, " ").trim(), 90) || "no text";
  }

  function openKids(t) {
    return (kids[t.id] || []).filter(function (k) { return k.state === "open"; });
  }

  function answeredIds(t) {
    var done = {};
    t.messages.forEach(function (m) {
      if (m.author === "claude") (m.answers || []).forEach(function (id) { done[id] = true; });
    });
    return done;
  }

  // The topic state for a badge: [class, text].
  function status(t) {
    if (t.state === "declined") return ["declined", "declined"];
    if (t.state === "resolved") return ["resolved", "resolved"];
    if (st.working && st.working.tid === t.id)
      return ["working", st.working.resolve && t.resolveRequested ? "Claude is recording the decision…" : "Claude is replying…"];
    var qi = st.queue.indexOf(t.id);
    if (qi >= 0) {
      var done = answeredIds(t);
      var asks = t.messages.some(function (m) { return m.author === "user" && !done[m.id]; });
      var text = asks ? "awaiting reply" : "awaiting decision";
      return ["queued", st.queue.length > 1 ? text + " · #" + (qi + 1) + " in queue" : text];
    }
    if (t.inWork) return ["working", "Claude is working on the question…"];
    if (t.messages.some(function (m) { return m.author === "claude"; })) return ["answered", ""];
    return ["idle", ""];
  }

  function isExpanded(t) {
    return expanded[t.id] === t.state && (kids[t.id] || []).length > 0;
  }

  // A Claude reply the user has not seen. Service messages — a decision, a
  // subquestion decision, a list of subquestions — repeat what is already
  // visible on the page and do not count as new.
  function unseen(m) {
    return m.author === "claude" && !m.kind && !seen[m.id];
  }

  // New replies of topic t; a declined topic has none: the question is dropped.
  function unseenOf(t) {
    return t.state === "declined" ? [] : t.messages.filter(unseen);
  }

  function unseenIn(t) {
    var n = unseenOf(t).length;
    (kids[t.id] || []).forEach(function (k) { n += unseenIn(k); });
    return n;
  }

  function canResolve(t) {
    return t.state === "open" && !t.resolveRequested && !openKids(t).length;
  }

  // The user's turn: the topic is open, has no open subquestions, is not
  // waiting for Claude and is not in Claude's work.
  function awaitsUser(t) {
    return t.state === "open" && !openKids(t).length && st.queue.indexOf(t.id) < 0 &&
      !(st.working && st.working.tid === t.id) && !t.inWork;
  }

  // Questions other than topic tid where it is the user's turn, in tree
  // order, starting from the one after tid; after the last one — from the
  // first, and without tid — from the first in the tree.
  function unansweredAfter(tid) {
    var order = [];
    (function walk(parent) {
      ordered(kids[parent]).forEach(function (t) { order.push(t); walk(t.id); });
    })("");
    var i = order.findIndex(function (t) { return t.id === tid; });
    var rest = order.slice(i + 1).concat(order.slice(0, i + 1));
    return rest.filter(function (t) { return t.id !== tid && awaitsUser(t); });
  }

  // The next question from unansweredAfter; null if there are no others.
  function nextUnanswered(tid) {
    return unansweredAfter(tid)[0] || null;
  }

  // A decision is revoked from a resolved topic without a parent or with an open parent.
  function canReopen(t) {
    return t.state === "resolved" && (!t.parent || (byId[t.parent] && byId[t.parent].state === "open"));
  }

  // ---- drafts

  // Writes the text of field key to the drafts; empty text deletes the draft.
  // The drafts are re-read before writing: another tab could have changed them.
  function setDraft(key, text) {
    drafts = loadJson(DRAFTS_KEY, {});
    if (!text.trim()) {
      delete drafts[key];
    } else {
      var d = drafts[key] || { created: Date.now() };
      d.text = text;
      if (key === "diffnew") d.anchor = diff.anchor();
      drafts[key] = d;
    }
    saveJson(DRAFTS_KEY, drafts);
  }

  // The page of field key with draft d: the session, topic or changes page;
  // null if the field is not there now — the topic is not open.
  function draftHref(key, d) {
    if (key === "new") return "/" + SID;
    if (key === "diffnew") return "/" + SID + "/diff?s=" + (d.anchor.staged ? 1 : 0);
    var t = byId[key.slice("reply:".length)];
    return t && t.state === "open" ? "/" + SID + "/" + t.id : null;
  }

  // Where the draft of field key is: "new question", "question on lines <file>" or the topic's question.
  function draftPlace(key) {
    if (key === "new") return "new question";
    if (key === "diffnew") return "question on lines of " + drafts[key].anchor.file;
    return titleOf(byId[key.slice("reply:".length)]);
  }

  // Drafts of other pages that Alt+X leads to: { key, href } in the order the
  // drafts were created, starting from the one after this page's draft;
  // after the last one — from the first.
  function draftsAfter() {
    var list = Object.keys(drafts).map(function (k) {
      return { key: k, href: draftHref(k, drafts[k]), created: drafts[k].created };
    }).filter(function (x) { return x.href; }).sort(function (a, b) { return a.created - b.created; });
    function here(x) { return x.href.split("?")[0] === location.pathname; }
    var i = list.findIndex(here);
    return list.slice(i + 1).concat(list.slice(0, i + 1)).filter(function (x) { return !here(x); });
  }

  // Focus in field focusKey once it appears on the page: the cursor at the
  // end of the text, the field in the middle of the screen.
  function focusDraft() {
    var ta = focusKey && app.querySelector('textarea[data-key="' + focusKey + '"]');
    if (!ta) return;
    focusKey = null;
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.scrollIntoView({ block: "center" });
  }

  // ---- elements

  // The file lines a question from the diff is asked about: "lines 10–12 of the working tree".
  function linesText(a) {
    var where = a.side === "old" ? (a.staged ? "HEAD" : "the index") : (a.staged ? "the index" : "the working tree");
    return (a.start === a.end ? "line " + a.start : "lines " + a.start + "–" + a.end) + " of " + where;
  }

  function contextEl(t) {
    var a = t.anchor;
    if (!a) return null;
    var box = make("div", "lc-ctx");
    if (a.kind === "diff") {
      var src = make("div", "lc-src", a.file + " · " + linesText(a) + " · ");
      var go = make("a", "", "in the diff ↗");
      go.href = "/" + SID + "/diff?f=" + encodeURIComponent(a.file) + "&s=" + (a.staged ? 1 : 0) + "&topic=" + t.id;
      go.target = "_blank";
      src.appendChild(go);
      box.appendChild(src);
      var pre = make("pre", "lc-dquote");
      (a.rows || []).forEach(function (r) {
        pre.appendChild(make("div", "lc-dq lc-dq-" + ({ "+": "add", "-": "del" }[r.charAt(0)] || "ctx"), r));
      });
      box.appendChild(pre);
      return box;
    }
    var page = a.pageTitle || decodeURIComponent(String(a.page || "").split("/").pop());
    box.appendChild(make("div", "lc-src", page + (a.path ? " › " + a.path : "")));
    box.appendChild(make("blockquote", "lc-quote", clip(a.quote || "", 420)));
    return box;
  }

  // Decisions of subquestions nested at any depth; declined ones are left out.
  function subDecisions(t) {
    var done = ordered(kids[t.id]).filter(function (k) { return k.state === "resolved"; });
    if (!done.length) return null;
    var ul = make("ul", "lc-subdec");
    done.forEach(function (k) {
      var li = make("li");
      li.appendChild(link(titleOf(k), k.id, "lc-sublink"));
      li.appendChild(document.createTextNode(" — "));
      li.appendChild(md(k.decision, "lc-inline"));
      var deeper = subDecisions(k);
      if (deeper) li.appendChild(deeper);
      ul.appendChild(li);
    });
    return ul;
  }

  function messageEl(t, m) {
    var claude = m.author === "claude";
    var kind = m.kind || "";
    var el = make("div", "lc-msg " + (claude ? "lc-claude" : "lc-user") + (kind ? " lc-" + kind : "") +
      (m.revoked ? " lc-revoked" : ""));
    el.setAttribute("data-key", "m:" + m.id);
    if (claude) el.setAttribute("data-mid", m.id);
    var who = make("div", "lc-who", !claude ? "You" :
      kind === "decision" ? "Decision" :
      kind === "subdecision" ? "Subquestion decision" :
      kind === "branch" ? "Subquestions" : "Claude");
    if (m.revoked) who.appendChild(make("span", "lc-revoked-mark", "revoked"));
    if (m.applied) who.appendChild(make("span", "lc-revoked-mark", "applied"));
    if (claude && !kind && t.state !== "declined" && (unseen(m) || fresh[m.id]))
      who.appendChild(make("span", "lc-new", "new"));
    el.appendChild(who);
    if (kind === "branch" && m.topics) {
      var ol = make("ol", "lc-tree lc-root lc-branch");
      ordered(m.topics.map(function (id) { return byId[id]; }).filter(Boolean)).forEach(function (k) {
        ol.appendChild(nodeEl(k));
      });
      el.appendChild(ol);
    } else if (kind === "subdecision" && m.topic && byId[m.topic]) {
      var row = make("div", "lc-md");
      row.appendChild(link(titleOf(byId[m.topic]), m.topic, "lc-sublink"));
      el.appendChild(row);
      el.appendChild(md(m.revoked ? m.decision : byId[m.topic].decision));
    } else if (kind === "decision") {
      el.appendChild(md(m.text));
      var sub = m.revoked ? null : subDecisions(t);
      if (sub) el.appendChild(sub);
    } else if (claude) {
      el.appendChild(md(m.text));
    } else {
      el.appendChild(make("div", "lc-text", m.text));
    }
    return el;
  }

  // The reply field and buttons of an open topic; inline — under diff lines,
  // without the "Next unanswered" button.
  function replyEl(t, inline) {
    var box = make("div", "lc-replybox");
    var ta = make("textarea", "lc-textarea");
    ta.rows = 2;
    ta.placeholder = "Reply in the topic";
    ta.setAttribute("data-key", "reply:" + t.id);
    ta.setAttribute("data-tid", t.id);
    box.appendChild(ta);
    var row = make("div", "lc-actions");
    row.appendChild(button("Reply", "reply", "primary"));
    if (canResolve(t)) row.appendChild(button("Resolve", "resolve", "lc-resolve"));
    row.appendChild(button("Decline", "decline", "lc-decline"));
    if (!inline) row.appendChild(nextEl());
    row.appendChild(make("span", "lc-kbd", "Ctrl+Enter — send"));
    box.appendChild(row);
    return box;
  }

  // Under a resolved topic: the "Reopen" button, and if the parent is
  // resolved, a hint to reopen the parent first.
  function reopenEl(t) {
    if (canReopen(t)) {
      var row = make("div", "lc-actions lc-replybox");
      row.appendChild(button("Reopen", "reopen", "lc-reopen"));
      return row;
    }
    var p = t.parent && byId[t.parent];
    if (t.state === "resolved" && p && p.state === "resolved")
      return make("p", "lc-hint", "To reopen this question, first reopen the question one level up.");
    return null;
  }

  // Badges of a tree row. The discussion is not shown in the tree, so new
  // replies of the topic itself are always marked, and of subquestions while
  // they are hidden.
  function badges(row, t, collapsed) {
    var s = status(t);
    if (s[1]) row.appendChild(make("span", "lc-badge lc-b-" + s[0], s[1]));
    var all = kids[t.id] || [];
    if (all.length) {
      var open = openKids(t).length;
      row.appendChild(make("span", "lc-meta", "subquestions: " + all.length + (open ? ", open " + open : "")));
    }
    var fresh = collapsed ? unseenIn(t) : unseenOf(t).length;
    if (fresh) row.appendChild(make("span", "lc-new", "new"));
    if (t.state === "open" && drafts["reply:" + t.id]) row.appendChild(make("span", "lc-badge lc-b-draft", "draft"));
  }

  // A topic in the tree: a row with the question; the arrow expands the rows
  // of subquestions, a click on the row opens the topic page with the discussion.
  function nodeEl(t) {
    var open = isExpanded(t);
    var list = ordered(kids[t.id]);
    var li = make("li", "lc-node lc-" + t.state + " lc-s-" + status(t)[0]);
    li.setAttribute("data-tid", t.id);
    var row = make("div", "lc-row");
    row.setAttribute("data-key", "row:" + t.id);
    row.setAttribute("data-href", "/" + SID + "/" + t.id);
    var tog = make("span", "lc-tog", list.length ? (open ? "▾" : "▸") : "");
    if (list.length) {
      tog.setAttribute("data-act", "toggle");
      tog.title = open ? "Collapse subquestions" : "Show subquestions";
    }
    row.appendChild(tog);
    row.appendChild(make("span", "lc-dot"));
    var a = link(titleOf(t), t.id, "lc-title");
    a.title = titleOf(t);
    row.appendChild(a);
    badges(row, t, !open);
    li.appendChild(row);
    if (open) {
      var ol = make("ol", "lc-tree");
      list.forEach(function (k) { ol.appendChild(nodeEl(k)); });
      li.appendChild(ol);
    }
    return li;
  }

  // The topic's discussion on its page: quote, messages, reply. Subquestions
  // are shown as a tree in the "Subquestions" messages that opened them. The
  // state of an open topic ("Claude is replying…", "awaiting reply") stands
  // right above the reply field. inline — the discussion under diff lines:
  // without the quote and without the "Next unanswered" button.
  function bodyEl(t, inline) {
    var b = make("div", "lc-body");
    var ctx = inline ? null : contextEl(t);
    if (ctx) b.appendChild(ctx);
    t.messages.forEach(function (m) { b.appendChild(messageEl(t, m)); });
    if (t.state === "open") {
      var s = status(t);
      if (s[1]) {
        var line = make("div", "lc-claude-status");
        line.appendChild(make("span", "lc-badge lc-b-" + s[0], s[1]));
        b.appendChild(line);
      }
      b.appendChild(replyEl(t, inline));
    }
    var reopen = reopenEl(t);
    if (reopen) b.appendChild(reopen);
    return b;
  }

  function statusText() {
    if (!online) return ["off", "● no connection to the server"];
    if (!st.connected) return ["off", "● session not connected: Claude will answer after cm.py open"];
    if (st.listening || st.working) return ["on", "● Claude is listening"];
    return ["off", "● Claude is not listening now — will answer on return"];
  }

  // Where "Back" (Alt+U) leads: from a topic page — to the question one
  // level up, and for a top-level question — to the session page; from the
  // changes page — to the session page; from the session page — null.
  function upHref() {
    if (TOPIC) {
      var up = byId[TOPIC] && byId[TOPIC].parent;
      return "/" + SID + (up ? "/" + up : "");
    }
    return diff ? "/" + SID : null;
  }

  // Where Alt+H leads: to the session page; from the page itself — null.
  function homeHref() {
    return TOPIC || diff ? "/" + SID : null;
  }

  function headerEl() {
    var h = make("header", "lc-head");
    if (TOPIC) {
      var back = make("a", "lc-btn lc-back", "← Back");
      back.href = upHref();
      back.appendChild(make("span", "lc-key", "Alt+U"));
      back.title = "One level up · Alt+U";
      h.appendChild(back);
      var nav = make("nav", "lc-crumbs");
      var home = make("a", "", "Discussion “" + (st.label || SID) + "”");
      home.href = homeHref();
      home.title = "Session page · Alt+H";
      nav.appendChild(home);
      var chain = [], p = byId[TOPIC] && byId[TOPIC].parent ? byId[byId[TOPIC].parent] : null;
      while (p) {
        chain.unshift(p);
        p = p.parent ? byId[p.parent] : null;
      }
      chain.forEach(function (x) {
        nav.appendChild(make("span", "lc-sep", "›"));
        var crumb = link(titleOf(x), x.id);
        crumb.title = titleOf(x);
        nav.appendChild(crumb);
      });
      h.appendChild(nav);
    } else if (diff) {
      var home = make("a", "lc-btn lc-back", "← Discussion");
      home.href = upHref();
      home.appendChild(make("span", "lc-key", "Alt+U"));
      home.title = "Session page · Alt+U, Alt+H";
      h.appendChild(home);
      h.appendChild(make("h1", "lc-h1", "Changes · “" + (st.label || SID) + "”"));
    } else {
      h.appendChild(make("h1", "lc-h1", "Discussion “" + (st.label || SID) + "”"));
    }
    var dr = draftsEl();
    if (dr) h.appendChild(dr);
    var s = statusText();
    h.appendChild(make("span", "lc-status lc-" + s[0], s[1]));
    if (!TOPIC && !diff) {
      var acts = make("div", "lc-head-acts");
      // The change review page opens in a new tab.
      var review = make("a", "lc-btn lc-review", "Changes ↗");
      review.href = "/" + SID + "/diff";
      review.target = "_blank";
      review.title = "Git change review: staging and questions on lines";
      acts.appendChild(review);
      acts.appendChild(applyEl());
      h.appendChild(acts);
    }
    return h;
  }

  // The "Drafts (N)" button if there are drafts on other pages: leads to the
  // first of draftsAfter, N — how many there are. Key — Alt+X.
  function draftsEl() {
    var rest = draftsAfter();
    if (!rest.length) return null;
    var a = make("a", "lc-btn lc-drafts", "Drafts (" + rest.length + ") →");
    a.href = rest[0].href;
    a.appendChild(make("span", "lc-key", "Alt+X"));
    a.title = "Next draft: " + draftPlace(rest[0].key) + " · Alt+X";
    a.addEventListener("click", function () { markFocus(rest[0].key); });
    return a;
  }

  // The "Plan of accepted decisions" block under the tree: decisions of the
  // session's resolved topics as numbered items in tree order, each with a
  // "↗" link to its question. Decisions of subquestions are subitems of their
  // question's decision; for an unresolved question they rise to its level.
  function planEl() {
    function steps(parent) {
      var ol = make("ol", "lc-plan");
      (kids[parent] || []).forEach(function (t) {
        var sub = steps(t.id);
        if (t.state !== "resolved") {
          while (sub.firstChild) ol.appendChild(sub.firstChild);
          return;
        }
        var li = make("li");
        li.appendChild(md(t.decision, "lc-inline"));
        var src = link("↗", t.id, "lc-src");
        src.title = "Question: " + titleOf(t);
        li.appendChild(src);
        if (sub.firstChild) li.appendChild(sub);
        ol.appendChild(li);
      });
      return ol;
    }
    var plan = steps("");
    if (!plan.firstChild) return null;
    var box = make("section", "lc-decisions");
    box.appendChild(make("h2", "lc-h2", "Plan of accepted decisions"));
    box.appendChild(plan);
    return box;
  }

  function resolvedCount() {
    return st.topics.filter(function (t) { return t.state === "resolved"; }).length;
  }

  function openCount() {
    return st.topics.filter(function (t) { return t.state === "open"; }).length;
  }

  // The "Apply resolved" button, available when at least one question is
  // resolved, and the arrow of its menu: turn on auto-apply — the resolved
  // ones apply by themselves as soon as no open questions are left — or
  // cancel it. Auto-apply belongs to the whole session, and the choice also
  // becomes the auto-apply of new sessions. While auto-apply waits, a badge
  // with the number of open questions stands next to it.
  function applyEl() {
    var box = make("div", "lc-split");
    var b = button("Apply resolved", "apply-session", "primary");
    var n = resolvedCount();
    b.disabled = !n;
    b.title = n ? "Claude will carry out the plan from the resolved questions; resolved and declined questions leave the list"
      : "No resolved questions";
    var more = button("▾", "apply-menu", "primary lc-split-more");
    more.title = "Auto-apply";
    var open = openCount();
    if (st.autoApply) {
      var mark = make("span", "lc-badge lc-b-queued", "applies by itself · open: " + open);
      mark.title = "The resolved ones apply when no open questions are left";
      box.appendChild(mark);
    }
    box.appendChild(b);
    box.appendChild(more);
    if (applyMenu) {
      var menu = make("div", "lc-menu");
      var item = st.autoApply ? button("Cancel auto-apply", "auto-apply-off", "lc-menu-item") :
        button("Apply when all questions are resolved", "auto-apply-on", "lc-menu-item");
      item.appendChild(make("span", "lc-menu-hint", st.autoApply ?
        "The resolved ones stay in the discussion until “Apply resolved” is pressed; new sessions start without auto-apply" :
        (!open && n ? "No open questions: apply right away" :
          "The resolved ones go to Claude for execution as soon as no open questions are left") +
        "; new sessions start with auto-apply"));
      menu.appendChild(item);
      box.appendChild(menu);
    }
    return box;
  }

  function rootEl() {
    var wrap = make("div");
    var ask = make("div", "lc-ask");
    var ta = make("textarea", "lc-textarea");
    ta.rows = 2;
    ta.placeholder = "New question — Claude will answer in this session";
    ta.setAttribute("data-key", "new");
    ask.appendChild(ta);
    var row = make("div", "lc-actions");
    row.appendChild(button("Ask", "ask", "primary"));
    row.appendChild(make("span", "lc-kbd", "Ctrl+Enter — send"));
    ask.appendChild(row);
    wrap.appendChild(ask);
    var list = ordered(kids[""]);
    if (!list.length) {
      wrap.appendChild(make("p", "lc-hint", "No questions yet. Ask a question above, select a fragment of an HTML page connected to the discussion, or lines on the changes page."));
    } else {
      var ol = make("ol", "lc-tree lc-root");
      list.forEach(function (t) { ol.appendChild(nodeEl(t)); });
      wrap.appendChild(ol);
    }
    var dec = planEl();
    if (dec) wrap.appendChild(dec);
    return wrap;
  }

  // Where "Next unanswered" leads: from a topic page — to nextUnanswered,
  // and if there are no other such questions — to the session page; from the
  // session page — to the first such question, and if there are none — null.
  function nextHref() {
    var next = nextUnanswered(TOPIC);
    if (next) return "/" + SID + "/" + next.id;
    return TOPIC ? "/" + SID : null;
  }

  // On the session page, after a state without questions where it is the
  // user's turn, opens the first such question as soon as it appears: Claude
  // has replied. While the user types in a field, the switch waits for a
  // rendering with the field empty. True if the page is being left.
  function openNextReply() {
    if (TOPIC || diff || gone) return false;
    var next = nextUnanswered(null);
    if (!next) {
      autoOpen = true;
      return false;
    }
    var a = document.activeElement;
    if (!autoOpen || a && a.tagName === "TEXTAREA" && app.contains(a) && a.value.trim()) return false;
    location.href = "/" + SID + "/" + next.id;
    return true;
  }

  // The topic page button leading to nextHref: "Next unanswered (N)", where
  // N is how many such questions there are besides the open one, and if
  // there are none — "Home". Key — Alt+N.
  function nextEl() {
    var rest = unansweredAfter(TOPIC);
    var next = rest[0] || null;
    var nb = make("a", "lc-btn lc-next", next ? "Next unanswered (" + rest.length + ") →" : "Home →");
    nb.href = nextHref();
    nb.appendChild(make("span", "lc-key", "Alt+N"));
    nb.title = (next ? titleOf(next) : "No other unanswered questions: session page") + " · Alt+N";
    return nb;
  }

  function topicEl() {
    var t = byId[TOPIC];
    if (!t) {
      // The question left the discussion: applied with the resolved ones or deleted.
      var msg = make("p", "lc-hint", "This question is not in the discussion: the resolved ones were applied or the question was deleted. ");
      var home = make("a", "", "To the session page");
      home.href = "/" + SID;
      msg.appendChild(home);
      return msg;
    }
    var art = make("article", "lc-topic lc-" + t.state);
    var h = make("div", "lc-topic-head");
    h.appendChild(make("h1", "lc-h1", titleOf(t)));
    var s = status(t);
    if (s[1] && t.state !== "open") h.appendChild(make("span", "lc-badge lc-b-" + s[0], s[1]));
    h.appendChild(nextEl());
    art.appendChild(h);
    art.appendChild(bodyEl(t));
    return art;
  }

  // ---- status bar

  // The status bar at the bottom of the page: items of standard blocks from
  // the user's file statusbar.py (protocol.md of the statusbar skill), which
  // live-comments-line.py sends on every update of the Claude Code status
  // line. It is outside app, so its updates do not re-render the page.
  var sbarEl = null;
  var SB_STYLES = { good: 1, warn: 1, bad: 1, accent: 1, muted: 1, strong: 1, mono: 1 };

  // A duration of ms milliseconds in short: "3d 4h", "2h 13m", "42m", "<1m".
  function span(ms) {
    var m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
    if (d) return d + "d " + h % 24 + "h";
    if (h) return h + "h " + m % 60 + "m";
    return m > 0 ? m + "m" : "<1m";
  }

  // The classes of the style names of a block, "good mono" → "lc-sb-good
  // lc-sb-mono"; without style — of dflt. Unknown names are left out.
  function sbStyle(style, dflt) {
    return String(style || dflt || "").split(/\s+/).filter(function (n) { return SB_STYLES[n] === 1; })
      .map(function (n) { return "lc-sb-" + n; }).join(" ");
  }

  // The element of block b; null for an unknown or empty block. now — the
  // current time, updated — when the bar came, in ms.
  function sbBlock(b, now, updated) {
    if (!b || typeof b !== "object") return null;
    if (typeof b.text === "string") return make("span", sbStyle(b.style), b.text);
    if (typeof b.chip === "string") return make("span", "lc-sb-chip " + sbStyle(b.style, "accent"), b.chip);
    if (typeof b.meter === "number") {
      var warn = typeof b.warn === "number" ? b.warn : 70, bad = typeof b.bad === "number" ? b.bad : 90;
      var lvl = "lc-sb-" + (b.meter >= bad ? "bad" : b.meter >= warn ? "warn" : "good");
      var box = make("span", "lc-sb-meterbox");
      var meter = make("span", "lc-sb-meter " + lvl), fill = make("span");
      fill.style.width = Math.max(0, Math.min(100, b.meter)) + "%";
      meter.appendChild(fill);
      box.appendChild(meter);
      box.appendChild(make("span", "lc-sb-strong " + lvl, Math.round(b.meter) + "%"));
      return box;
    }
    if (typeof b.dot === "string") return make("span", "lc-sb-dot " + sbStyle(b.dot, "muted"));
    if (typeof b.link === "string") {
      if (!/^https?:\/\//.test(b.href || "")) return make("span", sbStyle(b.style), b.link);
      var a = make("a", sbStyle(b.style), b.link);
      a.href = b.href;
      a.target = "_blank";
      a.rel = "noopener";
      return a;
    }
    if (typeof b.countdown === "number") {
      var left = b.countdown * 1000 - now;
      var text = left > 0 ? (b.prefix || "") + span(left) : b.done || "";
      return text ? make("span", sbStyle(b.style, "muted"), text) : null;
    }
    if (b.age === true && updated) return make("span", sbStyle(b.style, "muted"), (b.prefix || "") + span(now - updated) + " ago");
    return null;
  }

  // Draws the status bar from st.status; without items, or when the
  // discussion is closed, hides the bar. Countdowns are counted from now.
  function renderStatus() {
    var s = st && !gone ? st.status : null;
    var items = s && Array.isArray(s.items) ? s.items : [];
    document.documentElement.classList.toggle("lc-has-sbar", items.length > 0);
    if (!items.length) {
      if (sbarEl) sbarEl.hidden = true;
      return;
    }
    if (!sbarEl) {
      sbarEl = make("footer", "lc-sbar");
      document.body.appendChild(sbarEl);
      // The page keeps the bar's height free at its end and below the line
      // being typed: the bar covers neither.
      new ResizeObserver(function () {
        document.documentElement.style.setProperty("--lc-sbar-h", sbarEl.offsetHeight + "px");
      }).observe(sbarEl);
    }
    sbarEl.hidden = false;
    sbarEl.textContent = "";
    var now = Date.now(), updated = Date.parse(s.updated) || 0;
    items.forEach(function (item) {
      if (!item || !Array.isArray(item.blocks)) return;
      var el = make("span", "lc-sb-item" + (item.fill === true ? " lc-sb-fill" : ""));
      if (typeof item.title === "string" && item.title) el.title = item.title;
      item.blocks.forEach(function (b) {
        var e = sbBlock(b, now, updated);
        if (e) el.appendChild(e);
      });
      // An empty fill item still pushes the next items to the right.
      if (el.firstChild || item.fill === true) sbarEl.appendChild(el);
    });
  }

  // Whether states a and b differ only in the status bar and in the server
  // time: then the page itself is not re-rendered.
  function onlyStatus(a, b) {
    function core(x) { return JSON.stringify(Object.assign({}, x, { rev: 0, now: 0, status: 0 })); }
    return core(a) === core(b);
  }

  // ---- rendering

  function snapshot() {
    var snap = { focus: null, anchor: null };
    Array.prototype.forEach.call(app.querySelectorAll("textarea[data-key]"), function (ta) {
      if (document.activeElement === ta) snap.focus = { key: ta.getAttribute("data-key"), s: ta.selectionStart, e: ta.selectionEnd };
    });
    var a = document.activeElement;
    var el = a && app.contains(a) && a.getAttribute("data-key") ? a : null;
    if (!el) {
      var keyed = app.querySelectorAll("[data-key]");
      for (var i = 0; i < keyed.length; i++) {
        if (keyed[i].getBoundingClientRect().bottom > 2) {
          el = keyed[i];
          break;
        }
      }
    }
    if (el) snap.anchor = { key: el.getAttribute("data-key"), top: el.getBoundingClientRect().top };
    return snap;
  }

  // The height of input field ta follows its text, so the whole text is
  // visible; the field does not get smaller than its set number of rows. A
  // hidden field does not change: its height cannot be measured.
  function fit(ta) {
    if (!ta.offsetHeight) return;
    // While the field is shrunk to its initial height, the page can get
    // shorter and scroll; the scroll position is restored.
    var y = window.scrollY;
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + ta.offsetHeight - ta.clientHeight + "px";
    window.scrollTo(window.scrollX, y);
  }

  // Fields get the text of their drafts, focus and scroll position as
  // before re-rendering.
  function restore(snap) {
    Array.prototype.forEach.call(app.querySelectorAll("textarea[data-key]"), function (ta) {
      var d = drafts[ta.getAttribute("data-key")];
      if (d) ta.value = d.text;
      fit(ta);
    });
    if (snap.focus) {
      var ta = app.querySelector('textarea[data-key="' + snap.focus.key + '"]');
      if (ta) {
        ta.focus({ preventScroll: true });
        ta.setSelectionRange(snap.focus.s, snap.focus.e);
      }
    }
    if (snap.anchor) {
      var el = app.querySelector('[data-key="' + snap.anchor.key + '"]');
      if (el) window.scrollBy(0, el.getBoundingClientRect().top - snap.anchor.top);
    }
  }

  function selecting() {
    var sel = window.getSelection();
    return sel && !sel.isCollapsed && app.contains(sel.anchorNode);
  }

  // Claude's replies now on the screen of a visible tab become seen.
  function markSeen() {
    if (document.visibilityState !== "visible") return;
    var changed = false;
    Array.prototype.forEach.call(app.querySelectorAll("[data-mid]"), function (e) {
      var id = e.getAttribute("data-mid");
      if (!seen[id]) {
        seen[id] = 1;
        fresh[id] = true;
        changed = true;
      }
    });
    if (changed) saveJson(SEEN_KEY, seen);
  }

  function updateTitle() {
    var n = st ? st.topics.reduce(function (acc, t) { return acc + unseenOf(t).length; }, 0) : 0;
    var base = TOPIC && byId[TOPIC] ? clip(titleOf(byId[TOPIC]), 60) :
      (diff ? "Changes" : "Discussion") + " “" + ((st && st.label) || SID) + "”";
    document.title = (n ? "(" + n + ") " : "") + base;
  }

  function render() {
    if (!st) return;
    if (selecting()) {
      deferred = true;
      return;
    }
    deferred = false;
    if (openNextReply()) return;
    var snap = snapshot();
    app.textContent = "";
    app.appendChild(headerEl());
    app.appendChild(TOPIC ? topicEl() : diff ? diff.el() : rootEl());
    restore(snap);
    markSeen();
    updateTitle();
    if (diff) diff.after();
    focusDraft();
    renderStatus();
  }

  function applyState(next) {
    // Auto-apply fired while the page is open.
    if (st && next.autoApplied && next.autoApplied !== st.autoApplied)
      toast("No open questions left: the resolved ones were applied, the plan went to Claude");
    st = next;
    rev = next.rev;
    index();
    // Marks of topics that closed after expanding or disappeared are erased.
    var changed = false;
    Object.keys(expanded).forEach(function (id) {
      if (!byId[id] || byId[id].state !== expanded[id]) {
        delete expanded[id];
        changed = true;
      }
    });
    if (changed) saveJson(EXP_KEY, expanded);
    // Reply drafts in topics that no longer exist are erased.
    Object.keys(drafts).forEach(function (key) {
      if (key.indexOf("reply:") === 0 && !byId[key.slice("reply:".length)]) setDraft(key, "");
    });
    render();
  }

  function showGone(text) {
    gone = true;
    renderStatus();
    app.textContent = "";
    app.appendChild(make("p", "lc-hint", typeof text === "string" ? text :
      "The discussion is closed: the session is disconnected, the questions are deleted."));
    document.title = "Discussion closed";
  }

  function poll() {
    if (gone) return;
    fetch(API + "/wait?bar=1&rev=" + rev, { cache: "no-store" })
      .then(function (r) {
        if (r.status === 410) return null;
        if (r.status === 404) throw new Error("no such session");
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (next) {
        if (!next) {
          showGone();
          return;
        }
        var was = online;
        online = true;
        if (next.rev !== rev && was && st && onlyStatus(st, next)) {
          st = next;
          rev = next.rev;
          renderStatus();
        } else if (next.rev !== rev) applyState(next);
        else if (!was) render();
        setTimeout(poll, 30);
      }, function (e) {
        online = false;
        if (st) render();
        else app.firstChild.textContent = e.message === "no such session" ? "No such session." : "No connection to the server, retrying…";
        setTimeout(poll, 3000);
      });
  }

  // ---- actions

  function post(path, obj) {
    return request(API + path, obj);
  }

  function request(url, obj) {
    // keepalive: the request reaches the server even if the page is left right away.
    return fetch(url, {
      method: "POST", cache: "no-store", keepalive: true, headers: { "Content-Type": "application/json" },
      body: JSON.stringify(obj || {})
    }).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok) throw new Error(d.error || "HTTP " + r.status);
        return d;
      });
    });
  }

  function failed(e) {
    toast("Failed: " + e.message);
  }

  function send(ta, path, okMsg) {
    var text = ta.value.trim();
    if (!text) return;
    var key = ta.getAttribute("data-key");
    ta.value = "";
    fit(ta);
    setDraft(key, "");
    post(path, { text: text }).then(function () { toast(okMsg); }, function (e) {
      // Unsent text returns to the field from the draft.
      setDraft(key, text);
      render();
      failed(e);
    });
  }

  function tidOf(node) {
    var box = node.closest("[data-tid]");
    if (box) return box.getAttribute("data-tid");
    return TOPIC;
  }

  // Closes the "Apply resolved" menu without re-rendering the page, so that
  // the click that closed it reaches its target.
  function closeApplyMenu() {
    if (!applyMenu) return;
    applyMenu = false;
    var menu = app.querySelector(".lc-menu");
    if (menu) menu.remove();
  }

  function act(name, node, e) {
    var tid = tidOf(node);
    var t = byId[tid];
    switch (name) {
      case "toggle":
        if (isExpanded(t)) delete expanded[tid];
        else expanded[tid] = t.state;
        saveJson(EXP_KEY, expanded);
        render();
        break;
      case "ask":
        send(app.querySelector('textarea[data-key="new"]'), "/topics", "Question sent to Claude");
        break;
      case "reply":
        send(app.querySelector('textarea[data-key="reply:' + tid + '"]'), "/topics/" + tid + "/messages", "Sent to Claude");
        break;
      case "resolve":
        post("/topics/" + tid + "/resolve").then(function () { toast("Claude will record the decision and close the topic"); }, failed);
        break;
      case "reopen":
        if (!window.confirm("Reopen the question “" + titleOf(t) + "”? The topic opens again, and Claude removes the decision from memory.")) return;
        post("/topics/" + tid + "/reopen").then(function () { toast("Decision revoked: the topic is open again"); }, failed);
        break;
      case "apply-session":
        var n = resolvedCount();
        if (!window.confirm("Apply resolved? Claude gets the plan from the decisions (" + n + ") and carries it out. Resolved and declined questions leave the list, open ones stay.")) return;
        request("/api/sessions/" + encodeURIComponent(SID) + "/apply").then(function (r) {
          toast(r.listening ? "The plan went to Claude for execution" : "The plan waits for Claude: it will be carried out when Claude returns to the discussion");
        }, failed);
        break;
      case "apply-menu":
        applyMenu = !applyMenu;
        render();
        break;
      case "auto-apply-on":
      case "auto-apply-off":
        applyMenu = false;
        render();
        request("/api/sessions/" + encodeURIComponent(SID) + "/auto-apply", { on: name === "auto-apply-on" }).then(function (r) {
          toast(r.applied ? "No open questions: the resolved ones were applied, the plan went to Claude" :
            r.autoApply ? "The resolved ones will apply when all questions are resolved; new sessions start with auto-apply" :
            "Auto-apply cancelled; new sessions start without it");
        }, failed);
        break;
      case "decline":
        var more = openKids(t).length ? " and its open subquestions" : "";
        if (!window.confirm("Decline the question “" + titleOf(t) + "”" + more + "? Claude will no longer work on it.")) return;
        post("/topics/" + tid + "/decline").then(function (r) {
          toast(r.autoApplied ? "Declined: the question is closed. No open questions left: the resolved ones were applied, the plan went to Claude"
            : "Declined: the question is closed");
        }, failed);
        break;
      default:
        if (diff) diff.act(name, node, e);
    }
  }

  document.addEventListener("click", function (e) {
    var t = e.target;
    if (!t.closest) return;
    if (!t.closest(".lc-split")) closeApplyMenu();
    if (t.closest("a")) return;
    var el = t.closest("[data-act]");
    if (el && app.contains(el)) {
      act(el.getAttribute("data-act"), el, e);
      return;
    }
    var row = t.closest(".lc-row[data-href]");
    if (row && app.contains(row)) location.href = row.getAttribute("data-href");
  });

  // Navigation by keys, including from the reply field; by the physical key,
  // so it works in any keyboard layout. Alt+N — "Next unanswered" on the
  // topic and session pages, Alt+U — "Back", Alt+H — to the session page,
  // Alt+X — to the next draft.
  document.addEventListener("keydown", function (e) {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.repeat || !st || gone) return;
    var draft = e.code === "KeyX" ? draftsAfter()[0] : null;
    var href = draft ? draft.href :
      e.code === "KeyN" ? (diff ? null : nextHref()) :
      e.code === "KeyU" ? upHref() :
      e.code === "KeyH" ? homeHref() : null;
    if (!href) return;
    e.preventDefault();
    if (draft) markFocus(draft.key);
    location.href = href;
  });

  document.addEventListener("keydown", function (e) {
    if (!(e.ctrlKey || e.metaKey) || e.key !== "Enter") return;
    var a = document.activeElement;
    if (!a || a.tagName !== "TEXTAREA" || !app.contains(a)) return;
    e.preventDefault();
    var key = a.getAttribute("data-key");
    act(key === "new" ? "ask" : key === "diffnew" ? "diff-ask" : "reply", a);
  });

  // ---- keyboard shortcuts help

  // The help window: outside app, so re-rendering the page does not remove it.
  var keysEl = null;

  // Keys of this page: [key, what it does].
  function keyList() {
    var list = [];
    if (!diff) list.push(["Alt+N", "next unanswered question"]);
    if (TOPIC) list.push(["Alt+U", "one level up, like “← Back”"]);
    if (diff) list.push(["Alt+U", "to the session page, like “← Discussion”"]);
    if (TOPIC || diff) list.push(["Alt+H", "to the session page"]);
    list.push(["Alt+X", "next draft"]);
    list.push(["Ctrl+Enter", "send the field's text"]);
    if (diff) list.push(["Esc", "close the file list"]);
    list.push(["?", "this help; Esc or a click outside closes it"]);
    return list;
  }

  function showKeys(on) {
    if (!keysEl) {
      keysEl = make("div", "lc-keys-wrap");
      keysEl.addEventListener("click", function (e) {
        if (e.target === keysEl) showKeys(false);
      });
      document.body.appendChild(keysEl);
    }
    if (on) {
      keysEl.textContent = "";
      var box = make("div", "lc-keys");
      box.appendChild(make("h2", "lc-h2", "Keyboard shortcuts"));
      var dl = make("dl");
      keyList().forEach(function (k) {
        var dt = make("dt");
        dt.appendChild(make("span", "lc-key", k[0]));
        dl.appendChild(dt);
        dl.appendChild(make("dd", "", k[1]));
      });
      box.appendChild(dl);
      box.appendChild(make("p", "lc-hint", "Alt keys work in any keyboard layout and from an input field."));
      keysEl.appendChild(box);
    }
    keysEl.hidden = !on;
  }

  // ? opens and closes the help, except while typing in a field: there it is
  // a question mark. The key is the one with "?" in the current layout, or
  // the physical "/?" key. Esc closes the help.
  document.addEventListener("keydown", function (e) {
    var open = keysEl && !keysEl.hidden;
    if (e.key === "Escape" && open) {
      showKeys(false);
      return;
    }
    if (e.key === "Escape") closeApplyMenu();
    if (!(e.key === "?" || e.code === "Slash" && e.shiftKey) || e.ctrlKey || e.metaKey || e.altKey) return;
    var a = document.activeElement;
    if (a && (a.tagName === "TEXTAREA" || a.tagName === "INPUT" || a.isContentEditable)) return;
    e.preventDefault();
    showKeys(!open);
  });

  // Typed text becomes the field's draft right away.
  document.addEventListener("input", function (e) {
    var ta = e.target;
    if (ta.tagName !== "TEXTAREA" || !app.contains(ta)) return;
    fit(ta);
    setDraft(ta.getAttribute("data-key"), ta.value);
  });

  // Drafts changed in another tab of the session; a hidden tab re-renders
  // when it is shown.
  window.addEventListener("storage", function (e) {
    if (e.key !== DRAFTS_KEY) return;
    drafts = loadJson(DRAFTS_KEY, {});
    if (document.visibilityState === "visible") render();
  });

  // With a different window width the text wraps differently.
  window.addEventListener("resize", function () {
    Array.prototype.forEach.call(app.querySelectorAll("textarea"), fit);
  });

  document.addEventListener("selectionchange", function () {
    if (deferred && !selecting()) render();
  });

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") render();
  });

  if (CFG.view === "diff" && window.LiveCommentsDiff) {
    app.classList.add("lc-wide");
    diff = window.LiveCommentsDiff({
      SID: SID, API: API, app: app, make: make, button: button, toast: toast, failed: failed,
      request: request, post: post, render: render, titleOf: titleOf, status: status, unseenOf: unseenOf,
      draft: function (key) { return drafts[key] || null; }, setDraft: setDraft,
      bodyEl: bodyEl, linesText: linesText,
      topics: function () { return st ? st.topics : []; }
    });
  }
  app.appendChild(make("p", "lc-hint", "Loading…"));
  poll();
  // Times until resets in the status bar go down without new data.
  setInterval(renderStatus, 30000);
})();
