(function () {
  "use strict";

  // Connects an HTML page to the session's discussion on the cm.py server.
  // A selected fragment becomes a session topic, fragments with topics are
  // highlighted, a click on a highlight opens the topic on the server. The
  // discussion itself happens only there.
  var me = document.currentScript;
  if (!me) return;
  var ORIGIN = new URL(me.src).origin;
  var SID = me.getAttribute("data-session") || "";
  var API = ORIGIN + "/api/" + encodeURIComponent(SID);
  var PAGE = location.href.split("#")[0].split("?")[0];
  // The tab where discussion pages open: one per session.
  var WIN = "live-comments-" + SID;
  var body = document.body;
  var root = document.querySelector("main") || body;
  var BLOCK = /^(P|LI|TD|TH|H1|H2|H3|H4|H5|H6|DIV|DD|DT|DL|FIGCAPTION|FIGURE|BLOCKQUOTE|SECTION|HEADER|FOOTER|SUMMARY|DETAILS|UL|OL|TABLE|THEAD|TBODY|TR|MAIN|NAV)$/;

  var st = null;
  var rev = -1;
  var online = false;
  // Anchors of the page: anchor key → {gid, anchor, tids}. Topics with the
  // same quote (after splitting into questions) share one highlight.
  var groups = {};
  var nextGid = 1;
  var pending = null;
  var draft = null;
  var ui = {};
  var selTimer = null;
  var toastTimer = null;

  var css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = ORIGIN + "/embed.css";
  document.head.appendChild(css);
  ["/fonts.css", "/theme.css"].forEach(function (href) {
    var link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = ORIGIN + href;
    document.head.appendChild(link);
  });

  function elOf(node) {
    return node && node.nodeType === 1 ? node : node && node.parentNode;
  }

  function inUi(node) {
    var e = elOf(node);
    return !!(e && e.closest && e.closest(".lc-ui"));
  }

  function skippable(node) {
    for (var p = node.parentNode; p && p !== root; p = p.parentNode) {
      if (p.nodeType !== 1) continue;
      var tag = p.nodeName.toUpperCase();
      if (tag === "SVG" || tag === "SCRIPT" || tag === "STYLE" || tag === "TEXTAREA") return true;
      if (p.classList && p.classList.contains("lc-ui")) return true;
    }
    return false;
  }

  function blockOf(node) {
    for (var p = node.parentNode; p && p !== root; p = p.parentNode) {
      if (p.nodeType === 1 && BLOCK.test(p.nodeName.toUpperCase())) return p;
    }
    return root;
  }

  // The page text with whitespace collapsed as when displayed, and for each
  // character — its text node and the offset in it.
  function buildIndex() {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var chars = [], nodes = [], offs = [];
    var lastSpace = true, lastBlock = null, n;
    while ((n = walker.nextNode())) {
      if (!n.data || skippable(n)) continue;
      var blk = blockOf(n);
      if (blk !== lastBlock) {
        if (!lastSpace && chars.length) {
          chars.push(" ");
          nodes.push(n);
          offs.push(0);
          lastSpace = true;
        }
        lastBlock = blk;
      }
      var d = n.data;
      for (var i = 0; i < d.length; i++) {
        var ch = d.charAt(i);
        if (/\s/.test(ch)) {
          if (lastSpace) continue;
          ch = " ";
          lastSpace = true;
        } else {
          lastSpace = false;
        }
        chars.push(ch);
        nodes.push(n);
        offs.push(i);
      }
    }
    return { text: chars.join(""), nodes: nodes, offs: offs };
  }

  function boundaryIndex(idx, container, offset) {
    var probe = document.createRange();
    try {
      probe.setStart(container, offset);
    } catch (e) {
      return -1;
    }
    probe.collapse(true);
    var lo = 0, hi = idx.nodes.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      var c;
      try {
        c = probe.comparePoint(idx.nodes[mid], idx.offs[mid]);
      } catch (e) {
        c = 1;
      }
      if (c < 0) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  function textOf(e, max) {
    var t = (e.textContent || "").replace(/\s+/g, " ").trim();
    return max && t.length > max ? t.slice(0, max - 1) + "…" : t;
  }

  // The path to a fragment by page sections: "section › subsection › row …".
  function locate(e) {
    var parts = [];
    var sec = e.closest("section");
    if (sec) {
      var h2 = sec.querySelector("h2");
      if (h2) parts.push(textOf(h2));
      var h3s = sec.querySelectorAll("h3"), cur = null;
      for (var i = 0; i < h3s.length; i++) {
        if (h3s[i] === e || h3s[i].contains(e) || (h3s[i].compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING)) cur = h3s[i];
      }
      if (cur) parts.push(textOf(cur, 90));
    } else if (e.closest("header")) {
      parts.push("Header");
    } else if (e.closest("footer")) {
      parts.push("Footer");
    }
    var tr = e.closest("tr");
    if (tr && !e.closest("thead")) {
      var td = tr.querySelector("td");
      if (td) parts.push("row “" + textOf(td, 60) + "”");
    }
    var fig = e.closest("figure");
    if (fig) {
      var ft = fig.querySelector(".ftitle, figcaption");
      if (ft) parts.push("figure “" + textOf(ft, 70) + "”");
    }
    var labeled = e.closest("[data-cm-label]");
    if (labeled) parts.push(labeled.getAttribute("data-cm-label"));
    return parts.join(" › ");
  }

  function anchorOf(e) {
    var a = e.closest("[id]");
    return a ? a.id : "";
  }

  function figPos(idx, fig) {
    for (var i = 0; i < idx.nodes.length; i++) {
      if (fig.contains(idx.nodes[i])) return i;
    }
    return 0;
  }

  // The selection anchor: the quote with its surroundings, the place in the
  // text and the section. For a selection inside a figure without text —
  // the figure's id.
  function describe(range) {
    var startEl = elOf(range.startContainer);
    var endEl = elOf(range.endContainer);
    if (!startEl || !endEl) return null;
    var info = { page: PAGE, pageTitle: document.title, path: locate(startEl), anchor: anchorOf(startEl), fig: "" };
    var idx = buildIndex();
    var s = boundaryIndex(idx, range.startContainer, range.startOffset);
    var e = boundaryIndex(idx, range.endContainer, range.endOffset);
    if (s < 0 || e < 0) return null;
    while (s < e && idx.text.charAt(s) === " ") s++;
    while (e > s && idx.text.charAt(e - 1) === " ") e--;
    if (e > s) {
      info.quote = idx.text.slice(s, e);
      info.prefix = idx.text.slice(Math.max(0, s - 40), s);
      info.suffix = idx.text.slice(e, e + 40);
      info.pos = s;
      return info;
    }
    var fig = startEl.closest("figure") || endEl.closest("figure");
    var t = range.toString().replace(/\s+/g, " ").trim();
    if (!t || !fig || !fig.id) return null;
    info.quote = t;
    info.prefix = "";
    info.suffix = "";
    info.pos = figPos(idx, fig);
    info.fig = fig.id;
    return info;
  }

  function commonTail(a, b) {
    var n = 0;
    while (n < a.length && n < b.length && a.charAt(a.length - 1 - n) === b.charAt(b.length - 1 - n)) n++;
    return n;
  }

  function commonHead(a, b) {
    var n = 0;
    while (n < a.length && n < b.length && a.charAt(n) === b.charAt(n)) n++;
    return n;
  }

  function findQuote(idx, a) {
    var q = a.quote;
    if (!q) return null;
    var hits = [], from = 0, i;
    while ((i = idx.text.indexOf(q, from)) !== -1 && hits.length < 200) {
      hits.push(i);
      from = i + 1;
    }
    if (!hits.length) return null;
    var best = hits[0], bestScore = -Infinity;
    for (var k = 0; k < hits.length; k++) {
      var h = hits[k];
      var pre = idx.text.slice(Math.max(0, h - (a.prefix || "").length), h);
      var suf = idx.text.slice(h + q.length, h + q.length + (a.suffix || "").length);
      var score = commonTail(pre, a.prefix || "") + commonHead(suf, a.suffix || "") - Math.abs(h - (a.pos || 0)) / 1e6;
      if (score > bestScore) {
        bestScore = score;
        best = h;
      }
    }
    return [best, best + q.length];
  }

  function wrapRange(range, gid) {
    var container = range.commonAncestorContainer;
    if (container.nodeType === 3) container = container.parentNode;
    var walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
    var parts = [], n;
    while ((n = walker.nextNode())) {
      if (!range.intersectsNode(n) || skippable(n)) continue;
      var a = n === range.startContainer ? range.startOffset : 0;
      var b = n === range.endContainer ? range.endOffset : n.data.length;
      if (b > a && n.data.slice(a, b).trim()) parts.push([n, a, b]);
    }
    parts.forEach(function (p) {
      var node = p[0], a = p[1], b = p[2];
      if (a > 0) {
        node = node.splitText(a);
        b -= a;
      }
      if (b < node.data.length) node.splitText(b);
      var m = document.createElement("mark");
      m.className = "lc-hl";
      m.setAttribute("data-gid", gid);
      node.parentNode.insertBefore(m, node);
      m.appendChild(node);
    });
  }

  function highlight(g) {
    var a = g.anchor;
    if (a.fig) {
      var f = document.getElementById(a.fig);
      if (!f) return;
      f.classList.add("lc-fig-hl");
      var ids = (f.getAttribute("data-gids") || "").split(" ").filter(Boolean);
      ids.push(String(g.gid));
      f.setAttribute("data-gids", ids.join(" "));
      return;
    }
    var idx = buildIndex();
    var hit = findQuote(idx, a);
    if (!hit) return;
    var r = document.createRange();
    r.setStart(idx.nodes[hit[0]], idx.offs[hit[0]]);
    r.setEnd(idx.nodes[hit[1] - 1], idx.offs[hit[1] - 1] + 1);
    wrapRange(r, g.gid);
  }

  function marksOf(g) {
    return root.querySelectorAll('mark.lc-hl[data-gid="' + g.gid + '"]');
  }

  function keyOf(a) {
    return [a.fig || "", a.quote || "", a.prefix || "", a.suffix || ""].join("\u0001");
  }

  function find(tid) {
    for (var i = 0; i < st.topics.length; i++) if (st.topics[i].id === tid) return st.topics[i];
    return null;
  }

  function titleOf(t) {
    if (t.title) return t.title;
    var first = t.messages.length ? t.messages[0].text : "";
    return clip(first.replace(/\s+/g, " ").trim(), 90);
  }

  function clip(s, n) {
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }

  // The highlight state by its topics: waiting for Claude, answered, resolved, declined.
  function groupState(g) {
    var ts = g.tids.map(find).filter(Boolean);
    if (ts.some(function (t) { return st.queue.indexOf(t.id) >= 0 || (st.working && st.working.tid === t.id); })) return "waiting";
    if (ts.some(function (t) { return t.state === "open"; })) return "answered";
    if (ts.some(function (t) { return t.state === "resolved"; })) return "resolved";
    return "declined";
  }

  function applyState(next) {
    st = next;
    rev = next.rev;
    var seenKeys = {};
    st.topics.forEach(function (t) {
      var a = t.anchor;
      if (!a || a.page !== PAGE) return;
      var key = keyOf(a);
      var g = groups[key];
      if (!g) {
        g = groups[key] = { gid: nextGid++, anchor: a, tids: [] };
        highlight(g);
      }
      if (!seenKeys[key]) {
        seenKeys[key] = true;
        g.tids = [];
      }
      g.tids.push(t.id);
    });
    Object.keys(groups).forEach(function (key) {
      var g = groups[key];
      var state = groupState(g);
      var title = g.tids.map(function (id) { var t = find(id); return t ? "• " + titleOf(t) : ""; }).join("\n");
      Array.prototype.forEach.call(marksOf(g), function (m) {
        m.className = "lc-hl lc-" + state;
        m.title = title;
      });
    });
    updateFab();
  }

  // ---- interface

  function make(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function button(label, act, cls) {
    var b = make("button", "lc-btn" + (cls ? " " + cls : ""), label);
    b.type = "button";
    if (act) b.setAttribute("data-act", act);
    return b;
  }

  function placeNear(e, range, width, small) {
    var rects = range.getClientRects();
    var r = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
    var sx = window.pageXOffset, sy = window.pageYOffset;
    var vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    var left = (small ? r.right - width / 2 : r.left) + sx;
    left = Math.max(sx + 8, Math.min(left, sx + vw - width - 8));
    var top = r.bottom + sy + 8;
    var h = e.offsetHeight || (small ? 34 : 200);
    if (!small && r.bottom + h + 16 > vh && r.top - h - 16 > 0) top = r.top + sy - h - 8;
    e.style.left = left + "px";
    e.style.top = top + "px";
  }

  function toast(msg) {
    ui.toast.textContent = msg;
    ui.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { ui.toast.hidden = true; }, 2600);
  }

  function buildUi() {
    ui.selBtn = button("Ask", "comment", "lc-ui lc-sel-btn primary");
    ui.selBtn.hidden = true;
    ui.selBtn.addEventListener("mousedown", function (e) { e.preventDefault(); });

    ui.pop = make("div", "lc-ui lc-pop");
    ui.pop.hidden = true;
    ui.pop.appendChild(make("div", "lc-pop-label", "Question about the fragment"));
    ui.popQuote = make("div", "lc-pop-quote");
    ui.pop.appendChild(ui.popQuote);
    ui.popText = make("textarea", "lc-textarea");
    ui.popText.rows = 4;
    ui.popText.placeholder = "Question — Claude will answer in the session's discussion";
    ui.pop.appendChild(ui.popText);
    var row = make("div", "lc-row");
    row.appendChild(button("Ask", "save", "primary"));
    row.appendChild(button("Cancel", "cancel"));
    row.appendChild(make("span", "lc-kbd", "Ctrl+Enter — ask · Esc — cancel"));
    ui.pop.appendChild(row);

    ui.menu = make("div", "lc-ui lc-menu");
    ui.menu.hidden = true;

    ui.fab = make("a", "lc-ui lc-fab", "Discussion");
    ui.fab.href = ORIGIN + "/" + SID;
    ui.fab.target = WIN;
    ui.fabCount = make("span", "lc-count", "");
    ui.fab.appendChild(ui.fabCount);

    ui.toast = make("div", "lc-ui lc-toast");
    ui.toast.hidden = true;

    [ui.selBtn, ui.pop, ui.menu, ui.fab, ui.toast].forEach(function (e) { body.appendChild(e); });
  }

  function updateFab() {
    var open = st ? st.topics.filter(function (t) {
      return t.state === "open" && t.anchor && t.anchor.page === PAGE;
    }).length : 0;
    ui.fabCount.textContent = open ? String(open) : "";
    ui.fab.classList.toggle("lc-off", !online);
    ui.fab.title = online ? "Open questions on this page: " + open : "No connection to the discussion server";
  }

  function hideSelBtn() {
    ui.selBtn.hidden = true;
  }

  function checkSelection() {
    if (!ui.pop.hidden) return;
    var sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      hideSelBtn();
      return;
    }
    var r = sel.getRangeAt(0);
    if (!root.contains(r.startContainer) || !root.contains(r.endContainer) || inUi(r.startContainer) || inUi(r.endContainer) || !sel.toString().trim()) {
      hideSelBtn();
      return;
    }
    pending = r.cloneRange();
    ui.selBtn.hidden = false;
    placeNear(ui.selBtn, r, ui.selBtn.offsetWidth || 110, true);
  }

  function openPopover() {
    if (!pending) return;
    var info = describe(pending);
    hideSelBtn();
    if (!info) {
      toast("A question cannot be asked about this fragment");
      return;
    }
    draft = info;
    ui.popQuote.textContent = clip(info.quote, 280);
    ui.popText.value = "";
    ui.pop.hidden = false;
    placeNear(ui.pop, pending, Math.min(400, document.documentElement.clientWidth - 16), false);
    ui.popText.focus();
  }

  function closePopover() {
    ui.pop.hidden = true;
    draft = null;
    pending = null;
  }

  function savePopover() {
    var text = ui.popText.value.trim();
    if (!draft || !text) return;
    var anchor = draft;
    closePopover();
    var sel = window.getSelection();
    if (sel) sel.removeAllRanges();
    fetch(API + "/topics", {
      method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: text, anchor: anchor })
    }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      toast("Question sent — the answer will be in the discussion");
    }).catch(function (e) {
      toast("The discussion server is unavailable: " + e.message);
    });
  }

  function openTopic(tid) {
    window.open(ORIGIN + "/" + SID + "/" + tid, WIN);
  }

  // A click on a highlight: a single topic opens right away, several are
  // offered in a menu.
  function clickMarks(target, x, y) {
    var tids = [];
    for (var e = target; e && e !== root; e = e.parentNode) {
      var gids = [];
      if (e.matches && e.matches("mark.lc-hl")) gids = [e.getAttribute("data-gid")];
      else if (e.classList && e.classList.contains("lc-fig-hl")) gids = (e.getAttribute("data-gids") || "").split(" ");
      gids.forEach(function (gid) {
        Object.keys(groups).forEach(function (k) {
          if (String(groups[k].gid) === gid) groups[k].tids.forEach(function (t) { if (tids.indexOf(t) < 0) tids.push(t); });
        });
      });
    }
    if (!tids.length || !st) return false;
    if (tids.length === 1) {
      openTopic(tids[0]);
      return true;
    }
    ui.menu.textContent = "";
    tids.map(find).filter(Boolean).forEach(function (t) {
      var b = button(titleOf(t), "open-topic", "lc-menu-item lc-" + t.state);
      b.setAttribute("data-tid", t.id);
      ui.menu.appendChild(b);
    });
    ui.menu.hidden = false;
    ui.menu.style.left = Math.max(8, Math.min(x + window.pageXOffset, window.pageXOffset + document.documentElement.clientWidth - 360)) + "px";
    ui.menu.style.top = (y + window.pageYOffset + 12) + "px";
    return true;
  }

  function poll() {
    fetch(API + "/wait?rev=" + rev, { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (next) {
        online = true;
        if (next.rev !== rev) applyState(next);
        else updateFab();
        setTimeout(poll, 30);
      }, function () {
        online = false;
        updateFab();
        setTimeout(poll, 3000);
      });
  }

  function bind() {
    document.addEventListener("click", function (e) {
      var t = e.target;
      if (!t.closest) return;
      var actEl = t.closest(".lc-ui[data-act], .lc-ui [data-act]");
      if (actEl) {
        var act = actEl.getAttribute("data-act");
        if (act === "comment") openPopover();
        else if (act === "save") savePopover();
        else if (act === "cancel") closePopover();
        else if (act === "open-topic") {
          ui.menu.hidden = true;
          openTopic(actEl.getAttribute("data-tid"));
        }
        return;
      }
      if (!t.closest(".lc-menu")) ui.menu.hidden = true;
      var sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;
      if (t.closest("mark.lc-hl, .lc-fig-hl")) clickMarks(t, e.clientX, e.clientY);
    });
    document.addEventListener("mouseup", function (e) {
      if (!inUi(e.target)) setTimeout(checkSelection, 0);
    });
    document.addEventListener("selectionchange", function () {
      clearTimeout(selTimer);
      selTimer = setTimeout(checkSelection, 250);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        if (!ui.menu.hidden) ui.menu.hidden = true;
        else if (!ui.pop.hidden) closePopover();
        else hideSelBtn();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !ui.pop.hidden && document.activeElement === ui.popText) {
        e.preventDefault();
        savePopover();
      }
    });
  }

  buildUi();
  bind();
  updateFab();
  poll();
})();
