(function () {
  "use strict";

  // The session page (tree of topics), the page of one topic and the change
  // review page (its part is in diff.js). The session state comes by long
  // polling; re-rendering changes only the elements that differ, so the
  // rest keep the selection, the focus, the scroll position and the typed text.
  var CFG = window.LIVE_COMMENTS || {};
  var SID = CFG.session;
  var TOPIC = CFG.topic || null;
  // The change review page: el, act and after from diff.js.
  var diff = null;
  var API = "/api/" + encodeURIComponent(SID);
  var app = document.getElementById("lc-app");
  var SEEN_KEY = "lc-seen:" + SID;

  // The state of the session. The page keeps it: the server sends only the
  // topics that changed, the others stay the same objects.
  var st = null;
  var rev = -1;
  // The server run the state came from (see Store.delta in cm.py).
  var boot = "";
  // The state without the topics, the status bar and the server time, as text.
  var meta = "";
  // What the regions of the page are built from besides Claude's work on
  // the topics: shown grows with every change of the topics on the server,
  // local — with every change made in the page itself.
  var shown = 0, local = 0;
  // Topic id → the value of shown when the topic last changed.
  var stamps = {};
  var online = false;
  var byId = {};
  var kids = {};
  // Expanded branches: topic id → its state at the moment of expanding. Kept
  // in localStorage, so they survive a reload and moving between pages; a
  // topic resolved or closed after expanding is collapsed again once it has
  // no open subquestions.
  var EXP_KEY = "lc-expanded:" + SID;
  var expanded = loadJson(EXP_KEY, {});
  // Ids of Claude's replies the user has seen.
  var seen = loadJson(SEEN_KEY, {});
  // Replies first seen on this page: the "new" mark lives until a reload.
  var fresh = {};
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
  // The topic whose "Reply" menu is open, or null.
  var replyMenu = null;
  // Whether the "Questions" window of the topic page is open.
  var treeMenu = false;
  // Whether the tree of questions of the topic page stands in the side panel
  // instead of the "Questions" window. Kept in localStorage, so it survives
  // a reload and moving between pages.
  var SIDE_KEY = "lc-tree-side";
  var side = !!loadJson(SIDE_KEY, {}).on;
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

  // ---- Markdown of messages and decisions, as in GitHub comments: headings,
  // paragraphs with their line breaks, lists (nested, tasks), quotes, code
  // blocks, tables, rules; inside lines — `code`, **bold**, *italic*,
  // ~~strikethrough~~, links, images and bare addresses; code blocks of
  // Mermaid and PlantUML are drawn as diagrams. Display only: HTML in the text
  // is shown as text.

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  var FENCE = /^( {0,3})(`{3,}(?=[^`]*$)|~{3,})[ \t]*(\S*)/;
  var HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
  var HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
  var QUOTE = /^ {0,3}> ?/;
  var ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])([ \t]+|$)/;
  var TASK = /^\[([ xX])\](?:[ \t]+|$)/;
  var SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
  var DELIM = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
  // Escapes, code, links and images, <address> and bare addresses.
  var INLINE = /\\[!-\/:-@\[-`{-~]|`+|!?\[|<(?:https?|mailto):[^\s<>]*>|(?:https?:\/\/|www\.)[^\s<]*/gi;
  // [text](address "title") and ![alt](address): 1 — "!", 2 — the text, 3 or 4 — the address, 5 — the title.
  var LINK = /^(!?)\[((?:[^\[\]\\]|\\[\s\S]|\[(?:[^\[\]\\]|\\[\s\S])*\])*)\]\([ \t]*(?:<([^<>\n]*)>|((?:[^\s()\\]|\\[\s\S]|\((?:[^\s()\\]|\\[\s\S])*\))*))(?:[ \t\n]+("[^"]*"|'[^']*'))?[ \t]*\)/;
  var WORD = /[\p{L}\p{N}_]/u;

  // A link address: http(s), mailto or relative; another scheme (javascript:,
  // data:) — null. Control characters, which the browser drops, are removed
  // first, so that they do not hide a scheme.
  function safeUrl(u) {
    u = u.replace(/\\([!-\/:-@\[-`{-~])/g, "$1").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").replace(/ /g, "%20");
    return /^[a-z][a-z0-9+.\-]*:/i.test(u) && !/^(https?|mailto|file):/i.test(u) ? null : u;
  }

  // The local path of a file:// address: "file:///home/a%20b.html" → "/home/a b.html".
  function filePath(url) {
    try {
      var p = decodeURIComponent(new URL(url).pathname);
      return /^\/[a-z]:\//i.test(p) ? p.slice(1) : p;
    } catch (e) {
      return "";
    }
  }

  // A bare address without the punctuation after it: "(see https://a.b/c)." → "https://a.b/c".
  function trimUrl(u) {
    for (;;) {
      var v = u.replace(/[?!.,:;*_~'"]+$/, "");
      if (/\)$/.test(v) && v.split(")").length > v.split("(").length) v = v.slice(0, -1);
      if (v === u) return u;
      u = v;
    }
  }

  // The start of the run of n backticks that closes a code span opened before from; -1 if there is none.
  function codeEnd(s, from, n) {
    var re = /`+/g, m;
    re.lastIndex = from;
    while ((m = re.exec(s))) if (m[0].length === n) return m.index;
    return -1;
  }

  // A link or an image from a match of LINK; with an unsafe address — its
  // text. A link opens in a new tab, except an anchor on the page and mailto;
  // a file:// link is opened by the server (openFile).
  function linkHtml(l) {
    var url = safeUrl(l[3] != null ? l[3] : l[4]);
    var title = l[5] ? ' title="' + esc(l[5].slice(1, -1)) + '"' : "";
    if (l[1]) return url == null ? esc(l[2]) : '<img src="' + esc(url) + '" alt="' + esc(l[2]) + '"' + title + ">";
    var text = inlineMd(l[2], true);
    if (url == null) return text;
    if (/^file:/i.test(url)) return '<a href="' + esc(url) + '"' + title + ' data-file="' + esc(filePath(url)) + '">' + text + "</a>";
    return '<a href="' + esc(url) + '"' + title + (/^(#|mailto:)/i.test(url) ? "" : ' target="_blank" rel="noopener"') + ">" + text + "</a>";
  }

  // Inline Markdown of text s. Escapes, code, links and addresses are set
  // aside first, so that emphasis does not touch them; a line break stays a
  // break. noLinks — the text of a link: links inside it stay text.
  function inlineMd(s, noLinks) {
    var kept = [], out = "", at = 0, re = new RegExp(INLINE.source, "gi"), m;
    function keep(html) {
      kept.push(html);
      return "\u0000" + (kept.length - 1) + "\u0000";
    }
    while ((m = re.exec(s))) {
      var t = m[0], i = m.index, c = t.charAt(0), len = t.length, html = null;
      if (c === "\\") {
        html = esc(t.charAt(1));
      } else if (c === "`") {
        var end = codeEnd(s, i + len, len);
        if (end >= 0) {
          var code = s.slice(i + len, end).replace(/\n/g, " ");
          if (/^ .*[^ ].* $/.test(code)) code = code.slice(1, -1);
          html = "<code>" + esc(code) + "</code>";
          len = end + len - i;
        }
      } else if (c === "[" || c === "!") {
        var l = LINK.exec(s.slice(i));
        if (l && (l[1] || !noLinks)) {
          html = linkHtml(l);
          len = l[0].length;
        } else len = 1;
      } else if (noLinks) {
        // An address inside the text of a link stays text.
      } else if (c === "<") {
        html = '<a href="' + esc(safeUrl(t.slice(1, -1))) + '" target="_blank" rel="noopener">' + esc(t.slice(1, -1)) + "</a>";
      } else if (!(i && WORD.test(s.charAt(i - 1)))) {
        var url = trimUrl(t);
        if (/^(https?:\/\/|www\.)./i.test(url)) {
          html = '<a href="' + esc(safeUrl(/^www\./i.test(url) ? "http://" + url : url)) + '" target="_blank" rel="noopener">' + esc(url) + "</a>";
          len = url.length;
        }
      }
      out += s.slice(at, i) + (html == null ? s.substr(i, len) : keep(html));
      at = i + len;
      re.lastIndex = at;
    }
    out += s.slice(at);
    return esc(out)
      .replace(/\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g, "<strong><em>$1</em></strong>")
      .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^\p{L}\p{N}_])__(?=\S)([\s\S]*?\S)__(?![\p{L}\p{N}_])/gu, "$1<strong>$2</strong>")
      .replace(/\*(?=\S)([\s\S]*?\S)\*/g, "<em>$1</em>")
      .replace(/(^|[^\p{L}\p{N}_])_(?=\S)([\s\S]*?\S)_(?![\p{L}\p{N}_])/gu, "$1<em>$2</em>")
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>")
      .replace(/[ \t]*\\?\n[ \t]*/g, "<br>")
      .replace(/\u0000(\d+)\u0000/g, function (x, n) { return kept[+n]; });
  }

  // The closing fence of the code block opened by match m of FENCE.
  function fenceEnd(m) {
    return new RegExp("^ {0,3}" + m[2].charAt(0) + "{" + m[2].length + ",}[ \\t]*$");
  }

  // Whether lines end inside a code block.
  function inCode(lines) {
    var end = null, m;
    lines.forEach(function (l) {
      if (end) {
        if (end.test(l)) end = null;
      } else if ((m = FENCE.exec(l))) end = fenceEnd(m);
    });
    return !!end;
  }

  // Whether line l starts a block other than a paragraph.
  function startsBlock(l) {
    return FENCE.test(l) || HEADING.test(l) || HR.test(l) || QUOTE.test(l) || ITEM.test(l);
  }

  // Whether line i ends the paragraph before it. As in CommonMark, a list
  // interrupts a paragraph only with a non-empty item, and a numbered one — only from 1.
  function breaksParagraph(lines, i) {
    var l = lines[i], m = ITEM.exec(l);
    if (m) return HR.test(l) || !!l.slice(m[0].length).trim() && (!/\d/.test(m[2]) || parseInt(m[2], 10) === 1);
    return FENCE.test(l) || HEADING.test(l) || HR.test(l) || QUOTE.test(l) || !!tableAligns(lines, i);
  }

  // The cells of a table row; "\|" is a "|" inside a cell.
  function cells(l) {
    var s = l.trim(), out = [""];
    if (s.charAt(0) === "|") s = s.slice(1);
    if (s.slice(-1) === "|" && s.slice(-2) !== "\\|") s = s.slice(0, -1);
    for (var k = 0; k < s.length; k++) {
      var c = s.charAt(k);
      if (c === "\\" && s.charAt(k + 1) === "|") {
        out[out.length - 1] += "|";
        k++;
      } else if (c === "|") out.push("");
      else out[out.length - 1] += c;
    }
    return out.map(function (x) { return x.trim(); });
  }

  // If line i is the header of a table, followed by its delimiter row: the
  // alignments of the columns; otherwise null.
  function tableAligns(lines, i) {
    var d = lines[i + 1];
    if (d == null || lines[i].indexOf("|") < 0 || d.indexOf("|") < 0 || !DELIM.test(d)) return null;
    var al = cells(d).map(function (c) {
      return /^:-+:$/.test(c) ? "center" : /-:$/.test(c) ? "right" : /^:/.test(c) ? "left" : "";
    });
    return cells(lines[i]).length === al.length ? al : null;
  }

  function tableHtml(head, rows, al) {
    function row(tag, cs) {
      return "<tr>" + al.map(function (a, k) {
        return "<" + tag + (a ? ' style="text-align:' + a + '"' : "") + ">" + inlineMd(cs[k] || "") + "</" + tag + ">";
      }).join("") + "</tr>";
    }
    return '<div class="lc-md-table"><table><thead>' + row("th", head) + "</thead>" +
      (rows.length ? "<tbody>" + rows.map(function (r) { return row("td", r); }).join("") + "</tbody>" : "") +
      "</table></div>";
  }

  function heading(n, text) {
    return "<h" + n + ">" + inlineMd(text) + "</h" + n + ">";
  }

  // The list starting at line i: { html, next — the line after its last
  // item }; base — the number of line 0 in the source text. The items of a
  // list have the same kind of marker. A blank line between items or between
  // blocks of an item makes the list loose: its paragraphs are spaced apart.
  function mdList(lines, i, base) {
    var m = ITEM.exec(lines[i]);
    var ordered = /\d/.test(m[2]), mark = m[2].slice(-1), start = parseInt(m[2], 10);
    var items = [], loose = false, end = i;
    while (i < lines.length && (m = ITEM.exec(lines[i])) && !HR.test(lines[i]) &&
        /\d/.test(m[2]) === ordered && m[2].slice(-1) === mark) {
      if (end < i) loose = true;
      // The item's lines are those indented to its text, and lines that
      // continue its paragraph without indentation.
      var w = m[1].length + m[2].length, sp = m[3].length;
      var indent = w + (sp && sp <= 4 ? sp : 1);
      var body = [lines[i].slice(indent)], j = i + 1;
      for (end = j; j < lines.length; j++) {
        var l = lines[j];
        if (!l.trim()) body.push("");
        else if (/^ */.exec(l)[0].length >= indent) body.push(l.slice(indent));
        else if (body[body.length - 1].trim() && !startsBlock(l) && !inCode(body)) body.push(l);
        else break;
        if (l.trim()) end = j + 1;
      }
      var task = TASK.exec(body[0]);
      if (task) body[0] = body[0].slice(task[0].length);
      var blocks = mdBlocks(body.slice(0, end - i), base + i);
      if (blocks.some(function (b) { return b.gap; })) loose = true;
      items.push({ blocks: blocks, task: task, src: [base + i, base + end] });
      i = j;
    }
    var tag = ordered ? "ol" : "ul";
    var html = "<" + tag + (ordered && start !== 1 ? ' start="' + start + '"' : "") + ">" + items.map(function (it) {
      var li = '<li data-l="' + it.src + '"';
      return (it.task ? li + ' class="lc-task"><input type="checkbox" disabled' + (it.task[1] === " " ? "" : " checked") + ">" : li + ">") +
        mdJoin(it.blocks, !loose) + "</li>";
    }).join("") + "</" + tag + ">";
    return { html: html, next: end };
  }

  // The blocks of lines: { p — the inline HTML of a paragraph } or { html };
  // gap — a blank line before the block; src — its lines in the source text
  // [from, to), where base is the number of line 0.
  function mdBlocks(lines, base) {
    var out = [], gap = false, i = 0, m, al;
    function add(b) {
      b.gap = gap && out.length > 0;
      gap = false;
      out.push(b);
    }
    while (i < lines.length) {
      var l = lines[i], s = i, n = out.length;
      if (!l.trim()) {
        gap = true;
        i++;
      } else if (/^ {4}/.test(l)) {
        var code = [];
        for (; i < lines.length && (/^ {4}/.test(lines[i]) || !lines[i].trim()); i++) code.push(lines[i].slice(4));
        // Blank lines after the block stay outside it.
        for (; !code[code.length - 1].trim(); i--) code.pop();
        add({ html: "<pre><code>" + esc(code.join("\n")) + "</code></pre>" });
      } else if ((m = FENCE.exec(l))) {
        var close = fenceEnd(m), dedent = new RegExp("^ {0," + m[1].length + "}"), fenced = [];
        for (i++; i < lines.length && !close.test(lines[i]); i++) fenced.push(lines[i].replace(dedent, ""));
        i++;
        // After the language — the path of the file the code is written for.
        var file = l.slice(m[0].length).trim();
        var pre = "<pre" + (file ? ' data-file="' + esc(file) + '"' : "") + "><code" +
          (m[3] ? ' class="language-' + esc(m[3]) + '"' : "") + ">" + esc(fenced.join("\n")) + "</code></pre>";
        var kind = DIAGRAM[m[3].toLowerCase()];
        add({ html: kind ? '<div class="lc-diagram" data-kind="' + kind + '">' + pre + "</div>" : pre });
      } else if ((m = HEADING.exec(l))) {
        add({ html: heading(m[1].length, m[2] || "") });
        i++;
      } else if (HR.test(l)) {
        add({ html: "<hr>" });
        i++;
      } else if (QUOTE.test(l)) {
        // A quote goes on in lines with ">" and in lines that continue its paragraph without ">".
        var q = [];
        for (; i < lines.length; i++) {
          if (QUOTE.test(lines[i])) q.push(lines[i].replace(QUOTE, ""));
          else if (lines[i].trim() && q[q.length - 1].trim() && !startsBlock(lines[i]) && !inCode(q)) q.push(lines[i]);
          else break;
        }
        add({ html: "<blockquote>" + mdJoin(mdBlocks(q, base + s), false) + "</blockquote>" });
      } else if ((al = tableAligns(lines, i))) {
        var head = cells(l), rows = [];
        for (i += 2; i < lines.length && lines[i].indexOf("|") >= 0 && !startsBlock(lines[i]); i++) rows.push(cells(lines[i]));
        add({ html: tableHtml(head, rows, al) });
      } else if (ITEM.test(l)) {
        var list = mdList(lines, i, base);
        add({ html: list.html });
        i = list.next;
      } else {
        // A paragraph; under it "===" or "---" makes it a heading.
        var para = [l.trim()], level = 0;
        for (i++; i < lines.length && lines[i].trim(); i++) {
          if ((m = SETEXT.exec(lines[i]))) {
            level = m[1].charAt(0) === "=" ? 1 : 2;
            i++;
            break;
          }
          if (breaksParagraph(lines, i)) break;
          para.push(lines[i].trim());
        }
        add(level ? { html: heading(level, para.join("\n")) } : { p: inlineMd(para.join("\n")) });
      }
      if (out.length > n) out[n].src = [base + s, base + i];
    }
    return out;
  }

  // The HTML of blocks; tight — the items of a tight list: their paragraphs
  // go without <p>. The element of a block keeps its source lines in data-l.
  function mdJoin(blocks, tight) {
    return blocks.map(function (b) {
      var at = ' data-l="' + b.src + '"';
      return b.p == null ? b.html.replace(/^<\w+/, "$&" + at) : tight ? b.p : "<p" + at + ">" + b.p + "</p>";
    }).join("");
  }

  function mdToHtml(text) {
    var lines = String(text || "").replace(/\r\n?/g, "\n").replace(/\u0000/g, "\ufffd").split("\n").map(function (l) {
      return l.replace(/^[ \t]+/, function (w) { return w.replace(/\t/g, "    "); });
    });
    return mdJoin(mdBlocks(lines, 0), false);
  }

  // The element of Markdown text. Its content is built when the element
  // enters the page (see patchKids): an element of the same text that is
  // already there stays instead. apply — the code blocks written for a file
  // get the "Apply" button.
  function md(text, cls, apply) {
    var e = make("div", "lc-md" + (cls ? " " + cls : ""));
    e.lcSig = (cls || "") + "\n" + (apply ? 1 : 0) + "\n" + text;
    e.lcFill = function () {
      e.innerHTML = mdToHtml(text);
      e.lcSrc = String(text || "").replace(/\r\n?/g, "\n").split("\n");
      e.querySelectorAll("img").forEach(imgBox);
      e.querySelectorAll(".lc-diagram").forEach(showDiagram);
      e.querySelectorAll("pre>code[class^='language-']").forEach(highlightCode);
      e.querySelectorAll("pre").forEach(codeBox);
      e.querySelectorAll("pre>code.language-diff").forEach(diffBox);
      if (apply) e.querySelectorAll(".lc-code-head").forEach(function (head) {
        if (!head.parentNode.querySelector("pre[data-file]")) return;
        var b = head.insertBefore(button("Apply", "code-apply", "lc-small primary"), head.querySelector("[data-act=code-copy]"));
        b.title = "Claude puts the code into the file right away and answers in the topic";
      });
    };
    return e;
  }

  // A button over the corner of a block.
  function tool(label, act) {
    var b = make("button", "", label);
    b.type = "button";
    b.setAttribute("data-act", act);
    return b;
  }

  // The icon of the "Full screen" button: the corners of a frame.
  var FULL_ICON = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"/></svg>';

  // The "Full screen" button of a block, the last one of its buttons: an
  // icon without text, so the text of a message is the same for a selection.
  // cls — the classes of a button of a head.
  function fullButton(cls) {
    var b = tool(null, "full");
    b.className = cls || "";
    b.title = "Full screen";
    b.setAttribute("aria-label", b.title);
    b.innerHTML = FULL_ICON;
    return b;
  }

  // Code block pre gets the "Copy" and "Full screen" buttons. A block
  // written for a file and a diff block have them in a head with the file's
  // path, another block — over its corner.
  function codeBox(pre) {
    var box = make("div", "lc-code");
    pre.parentNode.insertBefore(box, pre);
    var file = pre.getAttribute("data-file");
    if (file || pre.querySelector("code.language-diff")) {
      var head = box.appendChild(make("div", "lc-code-head"));
      head.appendChild(make("span", "lc-code-file", file));
      head.appendChild(button("Copy", "code-copy", "lc-small"));
      head.appendChild(fullButton("lc-btn lc-small"));
    } else {
      var tools = box.appendChild(make("span", "lc-tools"));
      tools.appendChild(tool("Copy", "code-copy"));
      tools.appendChild(fullButton());
    }
    box.appendChild(pre);
  }

  // Image img gets the "Full screen" button over its corner.
  function imgBox(img) {
    var box = make("span", "lc-img");
    img.parentNode.insertBefore(box, img);
    box.appendChild(img);
    box.appendChild(make("span", "lc-tools")).appendChild(fullButton());
  }

  // ---- Diffs of code blocks: ```diff is shown as on the change review page,
  // the old and new versions side by side or inline. The buttons in the head
  // of a block switch the view of all blocks; the choice is the one of the
  // change review page (see MODE_KEY in diff.js).

  var DIFF_MODE_KEY = "lc-diff-mode";

  function diffMode() {
    try {
      return window.localStorage.getItem(DIFF_MODE_KEY) === "inline" ? "inline" : "split";
    } catch (e) {
      return "split";
    }
  }

  // The lines of diff text as in file_diff of cm.py: {t: " ", "+", "-" or
  // "@", o, n, s: text}. o and n — the line numbers in the old and new
  // versions, known after a "@@ -o +n @@" line. The lines of the diff's
  // header and of the hunks' headers have t "@".
  function diffRows(text) {
    var lines = text.replace(/\n$/, "").split("\n"), rows = [], o = null, n = null;
    lines.forEach(function (l, i) {
      var m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      var head = /^(diff --git |index )/.test(l) || /^--- /.test(l) && /^\+\+\+ /.test(lines[i + 1] || "") ||
        /^\+\+\+ /.test(l) && /^--- /.test(lines[i - 1] || "");
      if (m) {
        o = +m[1];
        n = +m[2];
      }
      if (m || head) rows.push({ t: "@", s: l });
      else if (l.charAt(0) === "\\") {
        if (rows.length) rows[rows.length - 1].noeol = true;
      } else {
        var t = /^[+-]/.test(l) ? l.charAt(0) : " ", r = { t: t, s: /^[+\- ]/.test(l) ? l.slice(1) : l };
        if (o != null && t !== "+") r.o = o++;
        if (o != null && t !== "-") r.n = n++;
        rows.push(r);
      }
    });
    return rows;
  }

  // The table of diff lines rows in view mode. A cell with the text of a
  // line keeps the index of the line in data-row.
  function diffTable(rows, mode) {
    var nums = rows.some(function (r) { return r.o != null || r.n != null; });
    var table = make("table", "lc-dtable lc-dt-" + mode);
    var cols = table.appendChild(make("colgroup"));
    (mode === "inline" ? ["lc-c-ln", "lc-c-ln", "lc-c-sign", "lc-c-code"] : ["lc-c-ln", "lc-c-code", "lc-c-ln", "lc-c-code"])
      .forEach(function (c) { if (nums || c !== "lc-c-ln") cols.appendChild(make("col", c)); });
    var body = table.appendChild(make("tbody"));
    function num(tr, v, cls) {
      if (nums) tr.appendChild(make("td", "lc-ln" + cls, v == null ? "" : String(v)));
    }
    function code(tr, i, cls) {
      var r = rows[i], td = tr.appendChild(make("td", "lc-code" + cls, r ? r.s : ""));
      if (r) td.setAttribute("data-row", i);
      if (r && r.noeol) td.appendChild(make("span", "lc-noeol", "⊘ no newline at end of file"));
      return td;
    }
    window.LiveCommentsDiff.layout(rows, mode).lines.forEach(function (line) {
      var i = line.rows[0], r = rows[i], tr = body.appendChild(make("tr", "lc-dr"));
      if (r.t === "@") {
        tr.className += " lc-dr-hunk";
        code(tr, i, "").colSpan = cols.childNodes.length;
      } else if (mode === "inline") {
        tr.className += " lc-dr-" + ({ "+": "add", "-": "del", " ": "ctx" })[r.t];
        num(tr, r.o, "");
        num(tr, r.n, "");
        tr.appendChild(make("td", "lc-sign", r.t === " " ? "" : r.t));
        code(tr, i, "");
      } else {
        var del = line.blk < 0 ? i : line.del, add = line.blk < 0 ? i : line.add;
        var dc = line.blk < 0 ? "" : del != null ? " lc-cdel" : " lc-cfill";
        var ac = line.blk < 0 ? "" : add != null ? " lc-cadd" : " lc-cfill";
        num(tr, del != null ? rows[del].o : null, dc);
        code(tr, del, dc);
        num(tr, add != null ? rows[add].n : null, ac);
        code(tr, add, ac);
      }
    });
    return table;
  }

  // The block of code element code is shown as a diff: the table stands in
  // place of the source, which stays in the block for "Copy" and "Apply".
  function diffBox(code) {
    var pre = code.parentNode, box = pre.parentNode, head = box.querySelector(".lc-code-head");
    var rows = diffRows(code.textContent);
    var seg = head.insertBefore(make("span", "lc-seg"), head.querySelector("[data-act=code-copy]"));
    var view = box.appendChild(make("div", "lc-mdiff"));
    box.classList.add("lc-code-diff");
    // The block's source lines belong to the block with the table: a selection in the table is inside them.
    box.setAttribute("data-l", pre.getAttribute("data-l"));
    pre.removeAttribute("data-l");
    view.lcRows = rows;
    box.lcDraw = function () {
      var mode = diffMode();
      seg.textContent = "";
      [["split", "Side by side"], ["inline", "Inline"]].forEach(function (m) {
        var b = seg.appendChild(button(m[1], "diff-mode", "lc-small" + (mode === m[0] ? " lc-on" : "")));
        b.setAttribute("data-mode", m[0]);
      });
      view.textContent = "";
      view.appendChild(diffTable(rows, mode));
    };
    box.lcDraw();
  }

  // ---- Diagrams of code blocks: ```mermaid is drawn in the page by Mermaid
  // from the CDN, ```plantuml and ```puml by the local plantuml of the server.
  // Until the diagram is ready, and if it fails, the block shows its source.

  var DIAGRAM = { mermaid: "mermaid", plantuml: "plantuml", puml: "plantuml" };
  var MERMAID_URL = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
  // The HTML of ready diagrams and the promises of those being made, by kind and source.
  var diagramCache = {};
  var mermaidLib = null, mermaidSeq = 0;

  function mermaid() {
    if (!mermaidLib) {
      mermaidLib = import(MERMAID_URL).then(function (m) {
        // The scheme forced by the user's theme, otherwise the one of the system.
        var scheme = getComputedStyle(document.documentElement).colorScheme;
        var dark = scheme === "dark" || scheme !== "light" &&
          !!(window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches);
        m.default.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "default" });
        return m.default;
      });
      // A failed load is tried again with the next diagram.
      mermaidLib.catch(function () { mermaidLib = null; });
    }
    return mermaidLib;
  }

  // The promise of the HTML of a diagram of kind from source.
  function drawDiagram(kind, source) {
    if (kind === "mermaid") {
      return mermaid().then(function (lib) {
        var id = "lc-mermaid-" + ++mermaidSeq;
        return lib.render(id, source).then(function (r) {
          return r.svg;
        }, function (e) {
          // Mermaid leaves the element of a failed diagram in the page.
          var left = document.getElementById("d" + id);
          if (left) left.remove();
          throw e;
        });
      });
    }
    return fetch("/api/plantuml", {
      method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: source })
    }).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok) throw new Error(d.error || "HTTP " + r.status);
        // As an image: links and scripts of the SVG do not act in the page.
        var url = URL.createObjectURL(new Blob([d.svg], { type: "image/svg+xml" }));
        return '<img src="' + url + '" alt="PlantUML">';
      });
    });
  }

  // Draws the diagram of block el: the diagram is shown instead of the source,
  // the "source" button switches between them, the "Full screen" button
  // shows the one of them that is shown in the window. The buttons of the
  // source, with "Copy", are the ones of the diagram.
  function showDiagram(el) {
    var kind = el.getAttribute("data-kind"), source = el.textContent, key = kind + "\n" + source;
    function put(html) {
      var view = make("div", "lc-diagram-view");
      view.innerHTML = html;
      var tools = make("span", "lc-tools");
      tools.appendChild(tool("Copy", "code-copy"));
      var toggle = tools.appendChild(make("button", "lc-diagram-toggle", "source"));
      toggle.type = "button";
      toggle.addEventListener("click", function () {
        toggle.textContent = el.classList.toggle("lc-diagram-source") ? "diagram" : "source";
      });
      tools.appendChild(fullButton());
      el.insertBefore(view, el.firstChild);
      el.insertBefore(tools, el.firstChild);
      el.classList.add("lc-diagram-ready");
    }
    if (typeof diagramCache[key] === "string") {
      put(diagramCache[key]);
      return;
    }
    if (!diagramCache[key]) {
      diagramCache[key] = drawDiagram(kind, source).then(function (html) {
        diagramCache[key] = html;
        return html;
      }, function (e) {
        delete diagramCache[key];
        throw e;
      });
    }
    diagramCache[key].then(put, function (e) {
      el.appendChild(make("div", "lc-diagram-error", (kind === "mermaid" ? "Mermaid: " : "PlantUML: ") + (e && e.message || e)));
    });
  }

  // ---- Full screen: the "Full screen" button of a code block, a diagram or
  // an image shows it in a window over the whole page. A diagram and an image
  // are zoomed there by the wheel and moved by dragging.

  // The window: outside app, so re-rendering the page does not remove it.
  var fullEl = null;
  // The block shown in the window and the button that opened it; null while the window is closed.
  var fullSrc = null, fullBy = null;
  // The diagram or image of the window: {el, view — the part of the window
  // it moves in, w, h — its size at scale 1, vector, s — the scale, x, y —
  // its place in view, fitted — it is as fitFull has put it}.
  var pan = null;
  // The free space around a fitted diagram or image and the part of it that stays in the window, in pixels.
  var FULL_PAD = 16, FULL_EDGE = 48;

  // Shows the diagram or image of the window with its scale at its place; a part of it stays in the window.
  function placeFull() {
    var p = pan, w = p.w * p.s, h = p.h * p.s;
    p.x = Math.min(p.view.clientWidth - FULL_EDGE, Math.max(FULL_EDGE - w, p.x));
    p.y = Math.min(p.view.clientHeight - FULL_EDGE, Math.max(FULL_EDGE - h, p.y));
    p.el.style.width = w + "px";
    p.el.style.height = h + "px";
    p.el.style.transform = "translate(" + p.x + "px," + p.y + "px)";
  }

  // Puts the diagram or image of the window whole in its middle: a vector
  // one up to twice its size, another one not above its size.
  function fitFull() {
    var p = pan, vw = p.view.clientWidth, vh = p.view.clientHeight;
    p.s = Math.min((vw - 2 * FULL_PAD) / p.w, (vh - 2 * FULL_PAD) / p.h, p.vector ? 2 : 1);
    p.x = (vw - p.w * p.s) / 2;
    p.y = (vh - p.h * p.s) / 2;
    p.fitted = true;
    placeFull();
  }

  // Changes the scale of the diagram or image of the window k times; point (cx, cy) of view stays where it is.
  function zoomFull(k, cx, cy) {
    var p = pan, s = Math.min(40, Math.max(0.05, p.s * k));
    p.x = cx - (cx - p.x) * s / p.s;
    p.y = cy - (cy - p.y) * s / p.s;
    p.s = s;
    p.fitted = false;
    placeFull();
  }

  // The wheel zooms at the pointer, dragging with the left button moves.
  function panView(view) {
    var drag = null;
    view.addEventListener("wheel", function (e) {
      e.preventDefault();
      var box = view.getBoundingClientRect();
      var d = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1);
      // A pinch on a touchpad comes as the wheel with Ctrl and small steps.
      zoomFull(Math.exp(-d * (e.ctrlKey ? 0.01 : 0.0025)), e.clientX - box.left, e.clientY - box.top);
    }, { passive: false });
    view.addEventListener("pointerdown", function (e) {
      if (e.button !== 0) return;
      view.setPointerCapture(e.pointerId);
      view.classList.add("lc-full-drag");
      drag = { x: e.clientX - pan.x, y: e.clientY - pan.y };
    });
    view.addEventListener("pointermove", function (e) {
      if (!drag) return;
      pan.x = e.clientX - drag.x;
      pan.y = e.clientY - drag.y;
      pan.fitted = false;
      placeFull();
    });
    function drop() {
      drag = null;
      view.classList.remove("lc-full-drag");
    }
    view.addEventListener("pointerup", drop);
    view.addEventListener("pointercancel", drop);
    // The browser does not drag the image away instead.
    view.addEventListener("dragstart", function (e) { e.preventDefault(); });
  }

  // Builds the window with block fullSrc. A code block comes with its
  // buttons, which press the buttons of the block; a diagram and an image —
  // with the zoom buttons.
  function drawFull() {
    var src = fullSrc, head = make("div", "lc-full-head"), body = make("div", "lc-full-body");
    var file = src.querySelector(":scope > .lc-code-head > .lc-code-file");
    var img = src.querySelector(":scope > img, :scope > .lc-diagram-view > svg, :scope > .lc-diagram-view > img");
    head.appendChild(make("span", "lc-code-file", file ? file.textContent : img && img.alt || ""));
    pan = null;
    if (img) {
      var el = img.cloneNode(true), view = body.appendChild(make("div", "lc-full-view"));
      var box = img.getBoundingClientRect(), vb = img.viewBox && img.viewBox.baseVal;
      el.style.maxWidth = "none";
      el.draggable = false;
      view.appendChild(el);
      panView(view);
      pan = {
        el: el, view: view, vector: !img.naturalWidth || /^blob:|\.svg$/i.test(img.src),
        w: img.naturalWidth || vb && vb.width || box.width || 1, h: img.naturalHeight || vb && vb.height || box.height || 1
      };
      [["−", "Zoom out", 0.8], ["+", "Zoom in", 1.25]].forEach(function (z) {
        var b = head.appendChild(button(z[0], "zoom", "lc-small"));
        b.title = z[1];
        b.lcDo = function () { zoomFull(z[2], view.clientWidth / 2, view.clientHeight / 2); };
      });
      var fit = head.appendChild(button("Fit", "fit", "lc-small"));
      fit.title = "The whole image in the window";
      fit.lcDo = fitFull;
    } else {
      [].forEach.call(src.querySelector(":scope > .lc-code-head, :scope > .lc-tools").children, function (c) {
        if (c.classList.contains("lc-code-file") || c.getAttribute("data-act") === "full") return;
        var copy = head.appendChild(c.cloneNode(true));
        var was = c.matches("button") ? [c] : c.querySelectorAll("button");
        [].forEach.call(copy.matches("button") ? [copy] : copy.querySelectorAll("button"), function (b, i) {
          b.className = b.className || "lc-btn lc-small";
          b.lcPress = was[i];
        });
      });
      // A diff block is shown by its table, which stands after the source.
      var shown = src.querySelector(":scope > .lc-mdiff") || src.querySelector(":scope > pre");
      body.appendChild(make("div", "lc-md lc-full-code")).appendChild(shown.cloneNode(true));
    }
    var close = head.appendChild(button("✕", "close-full", "lc-small"));
    close.title = "Close (Esc)";
    close.lcDo = function () { showFull(null); };
    fullEl.textContent = "";
    fullEl.appendChild(head);
    fullEl.appendChild(body);
    if (pan) fitFull();
  }

  // Opens the window with the block of its "Full screen" button by; without by closes the window.
  function showFull(by) {
    if (!fullEl) {
      fullEl = make("div", "lc-full");
      fullEl.addEventListener("click", function (e) {
        var b = e.target.closest("button");
        if (b && b.lcPress) {
          b.lcPress.click();
          drawFull();
        } else if (b && b.lcDo) b.lcDo();
      });
      document.body.appendChild(fullEl);
    }
    var was = fullBy;
    fullSrc = by && by.closest(".lc-img, .lc-code, .lc-diagram");
    // A diagram switched to its source is shown as the code block of the source.
    if (fullSrc && fullSrc.classList.contains("lc-diagram-source")) fullSrc = fullSrc.querySelector(":scope > .lc-code");
    fullBy = fullSrc && by;
    fullEl.hidden = !fullSrc;
    // The page under the window does not scroll and has no scroll bar beside the window.
    document.documentElement.classList.toggle("lc-full-on", !!fullSrc);
    if (fullSrc) {
      drawFull();
      fullEl.querySelector("[data-act=close-full]").focus();
    } else {
      fullEl.textContent = "";
      pan = null;
      if (was && was.isConnected) was.focus({ preventScroll: true });
    }
  }

  // ---- Syntax highlighting of code blocks ```LANG by highlight.js from the
  // CDN with its common languages; blocks of other languages stay plain.

  var HLJS_URL = "https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11/es/highlight.min.js";
  // The promise of the library and the library itself once it is loaded.
  var hljsLoad = null, hljsLib = null;

  // Colors the code of block el; once the library is loaded, before the block is shown.
  function highlightCode(el) {
    var lang = el.className.slice("language-".length).toLowerCase();
    if (DIAGRAM[lang]) return;
    function paint(lib) {
      if (!lib.getLanguage(lang) || el.classList.contains("hljs")) return;
      // highlight.js escapes the text of the code in the HTML it returns.
      el.innerHTML = lib.highlight(el.textContent, { language: lang, ignoreIllegals: true }).value;
      el.classList.add("hljs");
    }
    if (hljsLib) return paint(hljsLib);
    if (!hljsLoad) {
      hljsLoad = import(HLJS_URL).then(function (m) {
        return (hljsLib = m.default);
      });
      // A failed load is tried again with the next block.
      hljsLoad.catch(function () { hljsLoad = null; });
    }
    hljsLoad.then(paint, function () {});
  }

  // The part of range r inside element el.
  function rangeIn(r, el) {
    var p = document.createRange();
    p.selectNodeContents(el);
    if (r.compareBoundaryPoints(Range.START_TO_START, p) > 0) p.setStart(r.startContainer, r.startOffset);
    if (r.compareBoundaryPoints(Range.END_TO_END, p) < 0) p.setEnd(r.endContainer, r.endOffset);
    return p;
  }

  // The Markdown of the selection r, if all its text is in one message or
  // decision: the source lines of the blocks it touches, without their common
  // indentation. Otherwise, and for a part of one block, null: such a
  // selection is copied as text.
  function selectedMd(r) {
    var text = r.toString().trim();
    var el = [r.startContainer, r.endContainer].map(function (c) {
      return (c.nodeType === 1 ? c : c.parentNode).closest(".lc-md");
    }).filter(function (e) {
      return e && e.lcSrc && rangeIn(r, e).toString().trim() === text;
    })[0];
    if (!text || !el) return null;
    // Blocks with selected text, outer ones before inner ones.
    var blocks = [].filter.call(el.querySelectorAll("[data-l]"), function (b) {
      return rangeIn(r, b).toString().trim();
    });
    if (!blocks.length) return null;
    function lines(b) { return b.getAttribute("data-l").split(",").map(Number); }
    function deepest(c) {
      return blocks.filter(function (b) { return b.contains(c); }).pop();
    }
    var leaves = blocks.filter(function (b) {
      return !blocks.some(function (x) { return x !== b && b.contains(x); });
    });
    var first = deepest(r.startContainer), last = deepest(r.endContainer);
    if (first && first === last && rangeIn(r, first).toString().trim() !== first.textContent.trim()) return null;
    var from = first ? lines(first)[0] : Math.min.apply(null, leaves.map(function (b) { return lines(b)[0]; }));
    var to = last ? lines(last)[1] : Math.max.apply(null, leaves.map(function (b) { return lines(b)[1]; }));
    // The selection ends in the text of a list item: its nested blocks after the end stay out.
    if (last) [].forEach.call(last.querySelectorAll("[data-l]"), function (b) {
      if (r.comparePoint(b, 0) > 0) to = Math.min(to, lines(b)[0]);
    });
    var src = el.lcSrc.slice(from, to);
    var cut = Math.min.apply(null, src.filter(function (l) { return l.trim(); }).map(function (l) {
      return /^ */.exec(l)[0].length;
    }));
    // A selected indented code block keeps the 4 spaces that make it code.
    if (first && first === last && first.tagName === "PRE" && !FENCE.test(src[0].slice(cut))) cut -= 4;
    return src.map(function (l) { return l.slice(Math.min(cut, /^ */.exec(l)[0].length)); }).join("\n");
  }

  // ---- topics

  // A topic whose parent is not in the session is a top-level one.
  function index() {
    byId = {};
    kids = {};
    st.topics.forEach(function (t) { byId[t.id] = t; });
    st.topics.forEach(function (t) {
      var p = byId[t.parent] ? t.parent : "";
      (kids[p] = kids[p] || []).push(t);
    });
  }

  // Unfinished branches on top, finished ones at the bottom; within them by creation time.
  function ordered(list) {
    return (list || []).map(function (t, i) { return [t, i]; }).sort(function (a, b) {
      var ca = finishedBranch(a[0]) ? 1 : 0, cb = finishedBranch(b[0]) ? 1 : 0;
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
    if (t.state === "closed") return ["closed", "closed"];
    if (t.state === "resolved") return ["resolved", "resolved"];
    if (st.working && st.working.tid === t.id)
      return ["working", st.working.carryOut ? "Claude is carrying it out…" :
        st.working.resolve && t.resolveRequested ? "Claude is recording the decision…" : "Claude is replying…"];
    var qi = st.queue.indexOf(t.id);
    if (qi >= 0) {
      var done = answeredIds(t);
      var asks = t.messages.filter(function (m) { return m.author === "user" && m.kind !== "resolve" && !done[m.id]; });
      var text = asks.some(function (m) { return m.carryOut; }) ? "awaiting carrying out" :
        asks.length ? "awaiting reply" : "awaiting decision";
      return ["queued", st.queue.length > 1 ? text + " · #" + (qi + 1) + " in queue" : text];
    }
    if (t.inWork) return ["working", "Claude is working on the question…"];
    if (t.messages.some(function (m) { return m.author === "claude"; })) return ["answered", ""];
    return ["idle", ""];
  }

  function isExpanded(t) {
    return !!expanded[t.id] && (expanded[t.id] === t.state || !finishedBranch(t)) && (kids[t.id] || []).length > 0;
  }

  // A Claude reply the user has not seen. Service messages — a decision, a
  // subquestion decision, a list of subquestions — repeat what is already
  // visible on the page and do not count as new.
  function unseen(m) {
    return m.author === "claude" && !m.kind && !seen[m.id];
  }

  // New replies of topic t; a closed topic has none: the question is closed without a decision.
  function unseenOf(t) {
    return t.state === "closed" ? [] : t.messages.filter(unseen);
  }

  function unseenIn(t) {
    var n = unseenOf(t).length;
    (kids[t.id] || []).forEach(function (k) { n += unseenIn(k); });
    return n;
  }

  // Resolve and Close of an open topic: unavailable while Resolve is requested.
  function canResolve(t) {
    return t.state === "open" && !t.resolveRequested;
  }

  // The user's turn: the topic is open, is not waiting for Claude and is not
  // in Claude's work, whatever the states of its parent and subquestions.
  function awaitsUser(t) {
    return t.state === "open" && st.queue.indexOf(t.id) < 0 &&
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

  // A resolved or closed topic is opened again, whatever the state of its parent.
  function canReopen(t) {
    return t.state === "resolved" || t.state === "closed";
  }

  // ---- drafts

  // Writes the text of field key to the drafts; empty text deletes the draft.
  // The drafts are re-read before writing: another tab could have changed them.
  function setDraft(key, text) {
    local++;
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

  // Decisions of subquestions nested at any depth; for an unresolved
  // subquestion they rise to its level, as in the plan block.
  function subDecisions(t) {
    var ul = make("ul", "lc-subdec");
    (kids[t.id] || []).forEach(function (k) {
      var deeper = subDecisions(k);
      if (k.state !== "resolved") {
        while (deeper && deeper.firstChild) ul.appendChild(deeper.firstChild);
        return;
      }
      var li = make("li");
      li.appendChild(link(titleOf(k), k.id, "lc-sublink"));
      li.appendChild(document.createTextNode(" — "));
      li.appendChild(md(k.decision, "lc-inline"));
      if (deeper) li.appendChild(deeper);
      ul.appendChild(li);
    });
    return ul.firstChild ? ul : null;
  }

  function messageEl(t, m) {
    var claude = m.author === "claude";
    var kind = m.kind || "";
    var el = make("div", "lc-msg " + (claude ? "lc-claude" : "lc-user") + (kind ? " lc-" + kind : "") +
      (m.revoked ? " lc-revoked" : ""));
    el.setAttribute("data-key", "m:" + m.id);
    if (claude) el.setAttribute("data-mid", m.id);
    var who = make("div", "lc-who", !claude ? (kind === "resolve" ? "Your decision" : "You") :
      kind === "decision" ? "Decision" :
      kind === "subdecision" ? "Subquestion decision" :
      kind === "branch" ? "Subquestions" : "Claude");
    if (m.revoked) who.appendChild(make("span", "lc-revoked-mark", "revoked"));
    if (m.applied) who.appendChild(make("span", "lc-revoked-mark", "applied"));
    if (m.carryOut) who.appendChild(make("span", "lc-revoked-mark", "carry out now"));
    if (claude && !kind && t.state !== "closed" && (unseen(m) || fresh[m.id]))
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
    } else {
      // "Apply" at the code blocks Claude wrote for a file.
      el.appendChild(md(m.text, "", claude && !kind && t.state === "open"));
    }
    return el;
  }

  // The reply field and buttons of an open topic; inline — under diff lines,
  // without the "Next unanswered" button. The arrow of the "Reply" menu:
  // "Reply and carry out now".
  function replyEl(t, inline) {
    var box = make("div", "lc-replybox");
    var ta = make("textarea", "lc-textarea");
    ta.rows = 2;
    ta.placeholder = "Reply in the topic";
    ta.setAttribute("data-key", "reply:" + t.id);
    ta.setAttribute("data-tid", t.id);
    box.appendChild(ta);
    var row = make("div", "lc-actions");
    var split = make("div", "lc-split lc-split-reply");
    split.appendChild(button("Reply", "reply", "primary"));
    var more = split.appendChild(button("▾", "reply-menu", "primary lc-split-more"));
    more.title = "Reply and carry out now";
    if (replyMenu === t.id) {
      var menu = make("div", "lc-menu");
      var item = menu.appendChild(button("Reply and carry out now", "reply-now", "lc-menu-item"));
      item.appendChild(make("span", "lc-menu-hint",
        "Claude carries out right away what the message asks, or with an empty field what the discussion came to, and answers with the result in the topic"));
      split.appendChild(menu);
    }
    row.appendChild(split);
    if (canResolve(t)) {
      var res = row.appendChild(button("Resolve", "resolve", "lc-resolve"));
      res.title = "Claude phrases the decision from the typed text, or from the discussion";
    }
    if (canResolve(t)) {
      var close = row.appendChild(button("Close", "close", "lc-close"));
      close.title = "Closes the question without a decision";
    }
    if (!inline) row.appendChild(nextEl());
    row.appendChild(make("span", "lc-kbd", "Ctrl+Enter — reply"));
    box.appendChild(row);
    return box;
  }

  // Under a resolved or closed topic: the "Reopen" button.
  function reopenEl(t) {
    if (!canReopen(t)) return null;
    var row = make("div", "lc-actions lc-replybox");
    row.appendChild(button("Reopen", "reopen", "lc-reopen"));
    return row;
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
  // A resolved or closed topic of an unfinished branch looks like an open one.
  // all — a row of the "Questions" window or the side panel: subquestions are always shown,
  // and the row of the open topic is marked.
  function nodeEl(t, all) {
    var list = ordered(kids[t.id]);
    var open = all ? list.length > 0 : isExpanded(t);
    var li = make("li", "lc-node lc-" + t.state + " lc-s-" + status(t)[0] +
      (t.state !== "open" && !finishedBranch(t) ? " lc-branch-open" : ""));
    li.setAttribute("data-tid", t.id);
    var row = make("div", "lc-row" + (all && t.id === TOPIC ? " lc-active" : ""));
    if (!all) row.setAttribute("data-key", "row:" + t.id);
    row.setAttribute("data-href", "/" + SID + "/" + t.id);
    var tog = make("span", "lc-tog", list.length && !all ? (open ? "▾" : "▸") : "");
    if (list.length && !all) {
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
      list.forEach(function (k) { ol.appendChild(nodeEl(k, all)); });
      li.appendChild(ol);
    }
    return li;
  }

  // The tree of all questions of the session, where a click on a row opens
  // the topic page.
  function allTreeEl() {
    var box = make("div", "lc-tree-all");
    var ol = make("ol", "lc-tree");
    ordered(kids[""]).forEach(function (t) { ol.appendChild(nodeEl(t, true)); });
    box.appendChild(ol);
    return box;
  }

  // The "Questions" button of the topic page and its window with allTreeEl;
  // "Open at the side" moves the tree to the side panel.
  function treeMenuEl() {
    var box = make("div", "lc-tree-box");
    var b = button("☰ Questions", "tree-menu");
    b.title = "Tree of all questions";
    box.appendChild(b);
    if (treeMenu) {
      var menu = make("div", "lc-menu lc-tree-menu");
      var head = make("div", "lc-tree-head");
      var dock = button("Open at the side", "tree-side", "lc-small");
      dock.title = "Keep the tree of questions at the left side of the page";
      head.appendChild(dock);
      menu.appendChild(head);
      menu.appendChild(allTreeEl());
      box.appendChild(menu);
    }
    return box;
  }

  // The side panel of the topic page with allTreeEl; "✕" brings the
  // "Questions" button back.
  function sideEl() {
    return region(make("aside", "lc-side"), function (box) {
      var head = make("div", "lc-tree-head");
      head.appendChild(make("h2", "lc-h2", "Questions"));
      var close = button("✕", "tree-unside", "lc-small");
      close.title = "Close the side panel: the tree opens with the “Questions” button";
      head.appendChild(close);
      box.appendChild(head);
      box.appendChild(allTreeEl());
    });
  }

  // The topic's discussion on its page: quote, messages, reply. Subquestions
  // are shown as a tree in the "Subquestions" messages that opened them. The
  // state of an open topic ("Claude is replying…", "awaiting reply") stands
  // right above the reply field; what Claude is doing for the topic
  // (cm.py activity --topic) replaces it, except while the user's message
  // waits in the queue. inline — the discussion under diff lines: without
  // the quote and without the "Next unanswered" button.
  function bodyEl(t, inline) {
    var b = make("div", "lc-body");
    var ctx = inline ? null : contextEl(t);
    if (ctx) b.appendChild(ctx);
    t.messages.forEach(function (m) { b.appendChild(messageEl(t, m)); });
    if (t.state === "open") {
      var s = status(t);
      var act = st.activity && st.activity.topic === t.id && s[0] !== "queued" ? st.activity : null;
      if (act) s = ["working", act.text];
      if (s[1]) {
        var line = make("div", "lc-claude-status");
        var badge = make("span", "lc-badge lc-b-" + s[0], s[1]);
        if (act) badge.title = "since " + clock(act.since);
        line.appendChild(badge);
        b.appendChild(line);
      }
      b.appendChild(replyEl(t, inline));
    }
    var reopen = reopenEl(t);
    if (reopen) b.appendChild(reopen);
    return b;
  }

  // The header state: [class, text, tooltip]. What Claude is doing now
  // (cm.py activity) replaces the "listening" phrase; the colour still tells
  // whether Claude is listening, and the tooltip — the phrase and since when.
  function statusText() {
    if (!online) return ["off", "● no connection to the server"];
    if (!st.connected) return ["off", "● session not connected: Claude will answer after cm.py open"];
    var on = st.listening || st.working;
    var s = on ? ["on", "● Claude is listening"] : ["off", "● Claude is not listening now — will answer on return"];
    if (!st.activity) return s;
    return [s[0], "● " + st.activity.text, s[1].slice(2) + " · since " + clock(st.activity.since)];
  }

  // Hours and minutes of an ISO time in the browser's time zone.
  function clock(iso) {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  // Where "Back" (Alt+U) leads: from a topic page — to the question one
  // level up, and for a top-level question — to the session page; from the
  // changes page — to the session page; from the session page — null.
  function upHref() {
    if (TOPIC) {
      var up = byId[TOPIC] && byId[TOPIC].parent;
      return "/" + SID + (byId[up] ? "/" + up : "");
    }
    return diff ? "/" + SID : null;
  }

  // Where Alt+H leads: to the session page; from the page itself — null.
  function homeHref() {
    return TOPIC || diff ? "/" + SID : null;
  }

  // The title of open topic t at the end of the path in the header. Under
  // the pointer it shows the first message of the topic in full; Esc hides
  // the message until the pointer leaves the title.
  var popOff = false;
  function crumbTopicEl(t) {
    var box = make("span", "lc-crumb-topic" + (popOff ? " lc-pop-off" : ""));
    box.appendChild(make("span", "lc-crumb-title", titleOf(t)));
    if (t.messages.length) {
      var pop = make("div", "lc-topic-pop");
      pop.appendChild(md(t.messages[0].text));
      box.appendChild(pop);
    }
    return box;
  }

  // The height of the header that stays on top while scrolling: the page
  // scrolls an element into view below it.
  function headHeight() {
    var h = app.querySelector(".lc-head-fixed");
    document.documentElement.style.setProperty("--lc-head-h", (h ? h.offsetHeight : 0) + "px");
  }

  // Hides the first message of the topic shown under the pointer.
  function hidePop() {
    var box = app.querySelector(".lc-crumb-topic:hover");
    if (!box) return;
    popOff = true;
    box.classList.add("lc-pop-off");
  }

  function headerEl() {
    var h = make("header", "lc-head" + (diff ? "" : " lc-head-fixed"));
    if (TOPIC) {
      if (!side) h.appendChild(treeMenuEl());
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
      if (byId[TOPIC]) {
        nav.appendChild(make("span", "lc-sep", "›"));
        nav.appendChild(crumbTopicEl(byId[TOPIC]));
      }
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
    var stEl = make("span", "lc-status lc-" + s[0], s[1]);
    if (s[2]) stEl.title = s[2];
    h.appendChild(stEl);
    if (!TOPIC && !diff) {
      var acts = make("div", "lc-head-acts");
      // The change review page opens in a new tab.
      var review = make("a", "lc-btn lc-review", "Changes ↗");
      review.href = "/" + SID + "/diff";
      review.target = "_blank";
      review.title = "Git change review: staging and questions on lines";
      acts.appendChild(review);
      acts.appendChild(applyEl());
      // Only a connected session has Claude's wait that gets the outcome.
      if (st.connected) {
        var stop = button("Stop discussion", "stop-session", "lc-stop");
        stop.title = "Claude stops listening and lists the outcome in the chat; the questions are deleted";
        acts.appendChild(stop);
      }
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
    a.setAttribute("data-draft", rest[0].key);
    return a;
  }

  // Whether the branch of topic t is finished: neither t nor any of its
  // subquestions at any depth is open.
  function finishedBranch(t) {
    return t.state !== "open" && (kids[t.id] || []).every(finishedBranch);
  }

  // The "Plan of accepted decisions" block under the tree: decisions of the
  // resolved topics of finished branches as numbered items in tree order,
  // each with a "↗" link to its question. Decisions of subquestions are
  // subitems of their question's decision; for an unresolved question they
  // rise to its level.
  function planEl() {
    function steps(parent) {
      var ol = make("ol", "lc-plan");
      (kids[parent] || []).forEach(function (t) {
        if (!parent && !finishedBranch(t)) return;
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

  // The number of resolved topics of finished branches.
  function resolvedCount() {
    function count(t) {
      return (t.state === "resolved" ? 1 : 0) + (kids[t.id] || []).reduce(function (n, k) { return n + count(k); }, 0);
    }
    return (kids[""] || []).filter(finishedBranch).reduce(function (n, t) { return n + count(t); }, 0);
  }

  function openCount() {
    return st.topics.filter(function (t) { return t.state === "open"; }).length;
  }

  // The "Apply resolved" button, available when at least one question of a
  // finished branch is resolved, and the arrow of its menu: turn on auto-apply — the resolved
  // ones apply by themselves as soon as no open questions are left — for good
  // or for one time, or cancel it. Auto-apply belongs to the whole session, and
  // the choice, except the one for one time, also becomes the auto-apply of new
  // sessions. While auto-apply waits, a badge with the number of open questions
  // stands next to it.
  function applyEl() {
    var box = make("div", "lc-split");
    var b = button("Apply resolved", "apply-session", "primary");
    var n = resolvedCount();
    b.disabled = !n;
    b.title = n ? "Claude will carry out the plan from the branches without open questions; these branches leave the list"
      : "No resolved questions in branches without open ones";
    var more = button("▾", "apply-menu", "primary lc-split-more");
    more.title = "Auto-apply";
    var open = openCount();
    if (st.autoApply) {
      var mark = make("span", "lc-badge lc-b-queued", (st.autoApplyOnce ? "applies once" : "applies by itself") + " · open: " + open);
      mark.title = "The resolved ones apply " + (st.autoApplyOnce ? "once " : "") + "when no open questions are left";
      box.appendChild(mark);
    }
    box.appendChild(b);
    box.appendChild(more);
    if (applyMenu) {
      var menu = make("div", "lc-menu");
      var item = st.autoApply ? button("Cancel auto-apply", "auto-apply-off", "lc-menu-item") :
        button("Apply when all questions are resolved", "auto-apply-on", "lc-menu-item");
      item.appendChild(make("span", "lc-menu-hint", st.autoApply ?
        "The resolved ones stay in the discussion until “Apply resolved” is pressed" +
        (st.autoApplyOnce ? "" : "; new sessions start without auto-apply") :
        (!open && n ? "No open questions: apply right away" :
          "The resolved ones go to Claude for execution as soon as no open questions are left") +
        "; new sessions start with auto-apply"));
      menu.appendChild(item);
      if (!st.autoApply) {
        var once = button("Apply resolved once", "auto-apply-once", "lc-menu-item");
        once.appendChild(make("span", "lc-menu-hint", (!open && n ? "No open questions: apply right away" :
          "The resolved ones go to Claude for execution one time, as soon as no open questions are left") +
          "; new sessions start as before"));
        menu.appendChild(once);
      }
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
  // The question opens at Claude's last message (see showLast).
  function nextHref() {
    var next = nextUnanswered(TOPIC);
    if (next) return "/" + SID + "/" + next.id + "#last";
    return TOPIC ? "/" + SID : null;
  }

  // A topic page opened by "Next unanswered" shows Claude's last message
  // of the topic at the top.
  var toLast = location.hash === "#last";
  function showLast() {
    if (!toLast || !byId[TOPIC]) return;
    toLast = false;
    history.replaceState(null, "", location.pathname + location.search);
    var all = app.querySelectorAll(".lc-topic>.lc-body>[data-mid]");
    if (all.length) all[all.length - 1].scrollIntoView({ block: "start" });
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
    var bar = make("footer");
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
      if (el.firstChild || item.fill === true) bar.appendChild(el);
    });
    patchKids(sbarEl, bar);
  }

  // ---- patching: a re-render builds the page anew and brings the page in
  // the browser to it, changing only what differs. An element that stays is
  // the same element: the selection, the focus, the scroll position and the
  // typed text stay with it.

  // The key of node n among its siblings; "" if it has none.
  function keyOf(n) {
    return n.nodeType === 1 && (n.getAttribute("data-key") || n.getAttribute("data-tid") ||
      n.getAttribute("data-path") || n.getAttribute("data-line")) || "";
  }

  // The kind of node n: the tag and the first class. A node is brought only
  // to a node of its kind.
  function kindOf(n) {
    return n.nodeType === 1 ? n.nodeName + "." + (n.classList[0] || "") : "#";
  }

  // Builds the content of node n and of the elements inside it whose
  // content is built on entering the page (lcFill).
  function fill(n) {
    if (n.nodeType !== 1) return;
    var whole = n.lcFill && !n.lcDeep;
    if (n.lcFill) {
      n.lcFill();
      n.lcFill = null;
    }
    if (!whole) Array.prototype.forEach.call(n.children, fill);
  }

  // Claude's work on the topics as text: the queue, the topic in work and
  // what Claude does for a topic.
  function workOf() {
    return [st.queue.join(), JSON.stringify(st.working),
      st.activity && st.activity.topic ? JSON.stringify(st.activity) : ""].join("\n");
  }

  // Topics list and their subquestions at any depth as text that changes
  // when any of them changes.
  function stampOf(list) {
    return list.map(function (t) {
      return t.id + ":" + stamps[t.id] + "(" + stampOf(kids[t.id] || []) + ")";
    }).join();
  }

  // A region of the page: element el whose content build(el) makes. It is
  // built when the region enters the page and when what it is built from
  // has changed; otherwise the region in the page stays untouched. A region
  // is built from the changes made in the page itself and from deps — a
  // list of values; without deps — from all topics and Claude's work on them.
  function region(el, build, deps) {
    el.lcSig = [local].concat(deps || [shown, workOf()]).join("\n");
    el.lcDeep = true;
    el.lcFill = function () { build(el); };
    return el;
  }

  // Brings node live to node fresh of its kind: the text, the attributes
  // and the children. An element with lcSig stays as it is while fresh has
  // the same lcSig; with another one a region (lcDeep) is brought to the
  // built fresh, and any other element is replaced by it. An input field
  // keeps its text and what the browser and the user set on it.
  function patch(live, fresh) {
    if (fresh.nodeType !== 1) {
      if (live.data !== fresh.data) live.data = fresh.data;
      return;
    }
    if (live.lcSig !== fresh.lcSig) {
      if (!live.lcDeep || !fresh.lcDeep) {
        fill(fresh);
        live.parentNode.replaceChild(fresh, live);
        return;
      }
      // The regions inside are compared on their own.
      fresh.lcFill();
      fresh.lcFill = null;
      live.lcSig = fresh.lcSig;
    } else if (fresh.lcSig !== undefined) return;
    var field = live.nodeName === "TEXTAREA";
    if (!field) live.getAttributeNames().forEach(function (a) {
      if (!fresh.hasAttribute(a)) live.removeAttribute(a);
    });
    fresh.getAttributeNames().forEach(function (a) {
      var v = fresh.getAttribute(a);
      if (live.getAttribute(a) !== v) live.setAttribute(a, v);
    });
    if (!field) patchKids(live, fresh);
  }

  // Brings the children of element live to the children of element fresh.
  // A child of fresh takes the child of live with its key, and without a
  // key — the next one of its kind, and is brought to it by patch; a child
  // without such a pair enters the page itself. The children of live left
  // without a pair leave the page. A child of live moves only when the
  // order of the keys has changed.
  function patchKids(live, fresh) {
    var cur = live.firstChild, n = fresh.firstChild, next, m, x, k;
    var have = {}, want = {};
    for (x = cur; x; x = x.nextSibling) if ((k = keyOf(x))) have[k] = x;
    for (x = n; x; x = x.nextSibling) if ((k = keyOf(x))) want[k] = true;
    for (; n; n = next) {
      next = n.nextSibling;
      k = keyOf(n);
      if (k) {
        m = have[k];
        delete want[k];
        if (m && kindOf(m) === kindOf(n)) delete have[k];
        else m = null;
      } else {
        for (m = cur; m && (keyOf(m) || kindOf(m) !== kindOf(n)); m = m.nextSibling);
      }
      if (!m) {
        fill(n);
        live.insertBefore(n, cur);
        continue;
      }
      if (m !== cur) {
        // The children before the pair leave the page, unless one of them is
        // the pair of a later child: then the pair moves to its place.
        for (x = cur; x !== m && !want[keyOf(x)]; x = x.nextSibling);
        if (x !== m) live.insertBefore(m, cur);
        else while (cur !== m) {
          x = cur.nextSibling;
          live.removeChild(cur);
          cur = x;
        }
      }
      if (m === cur) cur = cur.nextSibling;
      patch(m, n);
    }
    while (cur) {
      x = cur.nextSibling;
      live.removeChild(cur);
      cur = x;
    }
  }

  // ---- rendering

  function snapshot() {
    var snap = { focus: null, anchor: null, tree: null };
    var menu = app.querySelector(".lc-tree-all");
    if (menu) snap.tree = menu.scrollTop;
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

  // A field whose text differs from its draft gets the text of the draft,
  // and a field that has just entered the page — its height and, if the
  // field before it had the focus, the focus; the scroll position is as
  // before re-rendering. The tree of the "Questions" window or the side
  // panel keeps its scroll position, and a just opened one shows the row of
  // the open topic.
  function restore(snap) {
    Array.prototype.forEach.call(app.querySelectorAll("textarea[data-key]"), function (ta) {
      var d = drafts[ta.getAttribute("data-key")];
      var differs = d ? ta.value !== d.text : !!ta.value.trim();
      if (differs) ta.value = d ? d.text : "";
      if (differs || !ta.style.height) fit(ta);
    });
    if (snap.focus) {
      var ta = app.querySelector('textarea[data-key="' + snap.focus.key + '"]');
      if (ta && document.activeElement !== ta) {
        ta.focus({ preventScroll: true });
        ta.setSelectionRange(snap.focus.s, snap.focus.e);
      }
    }
    if (snap.anchor) {
      var el = app.querySelector('[data-key="' + snap.anchor.key + '"]');
      if (el) window.scrollBy(0, el.getBoundingClientRect().top - snap.anchor.top);
    }
    var menu = app.querySelector(".lc-tree-all");
    if (menu) {
      var cur = menu.querySelector(".lc-active");
      menu.scrollTop = snap.tree != null ? snap.tree : cur ? cur.offsetTop - menu.clientHeight / 2 : 0;
    }
  }

  // Claude's replies now on the screen of a visible tab become seen.
  // Returns whether any of them was not seen before.
  function markSeen() {
    if (document.visibilityState !== "visible") return false;
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
    return changed;
  }

  function updateTitle() {
    var n = st ? st.topics.reduce(function (acc, t) { return acc + unseenOf(t).length; }, 0) : 0;
    var base = TOPIC && byId[TOPIC] ? clip(titleOf(byId[TOPIC]), 60) :
      (diff ? "Changes" : "Discussion") + " “" + ((st && st.label) || SID) + "”";
    document.title = (n ? "(" + n + ") " : "") + base;
  }

  // Re-renders the page after a change made in the page itself.
  function render() {
    local++;
    draw();
  }

  // Brings the page to the state: the header is built anew, the regions —
  // only if what they are built from has changed (see region).
  function draw() {
    if (!st) return;
    if (openNextReply()) return;
    var snap = snapshot();
    var page = make("main");
    page.appendChild(headerEl());
    page.appendChild(region(make("div", "lc-main"), function (el) {
      el.appendChild(TOPIC ? topicEl() : diff ? diff.el() : rootEl());
    }));
    document.documentElement.classList.toggle("lc-side-on", !!TOPIC && side);
    if (TOPIC && side) page.appendChild(sideEl());
    patchKids(app, page);
    restore(snap);
    headHeight();
    showLast();
    // Replies seen just now change the marks of new replies.
    if (markSeen()) return render();
    updateTitle();
    if (diff) diff.after();
    focusDraft();
    renderStatus();
    // The "Quote" button follows its selection.
    if (quoteBar && !quoteBar.hidden) checkQuote();
  }

  // Takes state next from the server. With ids — the ids of all topics —
  // next has only the topics changed since the state the page has: the other
  // topics stay the same objects. Returns whether anything the page shows,
  // besides the status bar, has changed.
  function take(next) {
    var topics = next.topics, moved = true, got = {};
    if (next.ids) {
      next.topics.forEach(function (t) { got[t.id] = t; });
      topics = next.ids.map(function (id) { return got[id] || byId[id]; });
      // The page lacks a topic the server did not send: the next request gets the whole state.
      if (!st || topics.some(function (t) { return !t; })) {
        rev = -1;
        return false;
      }
      moved = next.topics.length > 0 || next.ids.join() !== st.topics.map(function (t) { return t.id; }).join();
    }
    next.topics = topics;
    var sig = JSON.stringify(Object.assign({}, next,
      { topics: 0, ids: 0, since: 0, rev: 0, now: 0, status: 0, lastSeen: 0 }));
    var changed = moved || sig !== meta;
    // Auto-apply fired while the page is open.
    if (st && next.autoApplied && next.autoApplied !== st.autoApplied)
      toast("No open questions left: the resolved ones were applied, the plan went to Claude");
    st = next;
    rev = next.rev;
    boot = next.boot || "";
    meta = sig;
    if (moved) {
      shown++;
      (next.ids ? Object.keys(got) : topics.map(function (t) { return t.id; })).forEach(function (id) {
        stamps[id] = shown;
      });
      index();
    }
    return changed;
  }

  // Shows the state taken from the server.
  function applyState() {
    // Marks of topics that disappeared, or were resolved or closed after
    // expanding and have no open subquestions at any depth, are erased.
    var changed = false;
    Object.keys(expanded).forEach(function (id) {
      if (!byId[id] || byId[id].state !== expanded[id] && finishedBranch(byId[id])) {
        delete expanded[id];
        changed = true;
      }
    });
    if (changed) {
      local++;
      saveJson(EXP_KEY, expanded);
    }
    // Reply drafts in topics that no longer exist are erased.
    Object.keys(drafts).forEach(function (key) {
      if (key.indexOf("reply:") === 0 && !byId[key.slice("reply:".length)]) setDraft(key, "");
    });
    draw();
  }

  function showGone(text) {
    gone = true;
    document.documentElement.classList.remove("lc-side-on");
    renderStatus();
    app.textContent = "";
    app.appendChild(make("p", "lc-hint", typeof text === "string" ? text :
      "The discussion is closed: the session is disconnected, the questions are deleted."));
    document.title = "Discussion closed";
  }

  function poll() {
    if (gone) return;
    fetch(API + "/wait?bar=1&delta=1&rev=" + rev + "&boot=" + boot, { cache: "no-store" })
      .then(function (r) {
        if (r.status === 410) return null;
        if (r.status === 404) throw new Error("no such session");
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (next) {
        if (!next) {
          // The text of the "Stop discussion" button stays.
          if (!gone) showGone();
          return;
        }
        var was = online;
        online = true;
        // A wait that ended without changes returns the state the page has.
        var news = next.rev !== rev || !next.ids;
        if (news && take(next)) applyState();
        else {
          if (news) renderStatus();
          if (!was) render();
        }
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

  // A file:// link: the browser does not open local files from the server's
  // pages, so the server opens the file with the desktop's default
  // application; if it cannot, the address is copied for the address bar.
  function openFile(a) {
    var href = a.getAttribute("href");
    post("/open", { path: a.getAttribute("data-file") }).catch(function (e) {
      function say(how) { toast(e.message + ". " + how); }
      if (!navigator.clipboard) return say("Open it from the address bar: " + href);
      navigator.clipboard.writeText(href).then(function () {
        say("The address is copied: paste it into the address bar.");
      }, function () {
        say("Open it from the address bar: " + href);
      });
    });
  }

  // Sends the text of field ta to path; okMsg — the toast after sending. With
  // empty — also an empty field, and okMsg is then a function of the text.
  // extra — more fields of the request.
  function send(ta, path, okMsg, empty, extra) {
    var text = ta ? ta.value.trim() : "";
    if (!text && !empty) return;
    var why = uploading(text);
    if (why) {
      toast(why);
      return;
    }
    var key = ta && ta.getAttribute("data-key");
    if (text) {
      ta.value = "";
      fit(ta);
      setDraft(key, "");
    }
    post(path, Object.assign({ text: text }, extra)).then(function () { toast(empty ? okMsg(text) : okMsg); }, function (e) {
      // Unsent text returns to the field from the draft.
      if (text) setDraft(key, text);
      render();
      failed(e);
    });
  }

  function tidOf(node) {
    var box = node.closest("[data-tid]");
    if (box) return box.getAttribute("data-tid");
    return TOPIC;
  }

  // Closes the menus of the "Apply resolved" and "Reply" buttons and the
  // "Questions" window without re-rendering the page, so that the click that
  // closed them reaches its target.
  function closeMenus() {
    if (!applyMenu && !replyMenu && !treeMenu) return;
    applyMenu = false;
    replyMenu = null;
    treeMenu = false;
    app.querySelectorAll(".lc-menu").forEach(function (menu) { menu.remove(); });
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
      case "reply-menu":
        replyMenu = replyMenu === tid ? null : tid;
        applyMenu = false;
        treeMenu = false;
        render();
        break;
      case "tree-menu":
        treeMenu = !treeMenu;
        replyMenu = null;
        render();
        break;
      case "tree-side":
      case "tree-unside":
        side = name === "tree-side";
        treeMenu = false;
        saveJson(SIDE_KEY, { on: side });
        render();
        break;
      case "reply-now":
        closeMenus();
        send(app.querySelector('textarea[data-key="reply:' + tid + '"]'), "/topics/" + tid + "/messages", function () {
          return "Claude will carry it out right away and answer in the topic";
        }, true, { carryOut: true });
        break;
      case "diff-mode":
        if (diff) diff.act(name, node, e);
        else {
          try {
            window.localStorage.setItem(DIFF_MODE_KEY, node.getAttribute("data-mode"));
          } catch (err) {
            // Without storage the view stays the same.
          }
        }
        app.querySelectorAll(".lc-code-diff").forEach(function (box) { box.lcDraw(); });
        break;
      case "code-copy":
        navigator.clipboard.writeText(node.closest(".lc-code, .lc-diagram").querySelector("pre").textContent).then(function () {
          toast("Copied");
        }, failed);
        break;
      case "code-apply":
        var pre = node.closest(".lc-code").querySelector("pre"), code = pre.textContent;
        var lang = (/(?:^| )language-(\S+)/.exec(pre.firstChild.className) || ["", ""])[1];
        var fence = "```";
        while (code.indexOf(fence) >= 0) fence += "`";
        post("/topics/" + tid + "/messages", {
          text: "Apply this code to `" + pre.getAttribute("data-file") + "`:\n\n" + fence + lang + "\n" + code + "\n" + fence,
          carryOut: true
        }).then(function () { toast("Claude will apply it right away and answer in the topic"); }, failed);
        break;
      case "resolve":
        send(app.querySelector('textarea[data-key="reply:' + tid + '"]'), "/topics/" + tid + "/resolve", function (text) {
          return (text ? "Claude will record your decision" : "Claude will record the decision") + " and resolve the topic";
        }, true);
        break;
      case "reopen":
        var was = t.state;
        if (!window.confirm("Reopen the question “" + titleOf(t) + "”? The topic opens again" +
          (was === "resolved" ? ", and Claude removes the decision from memory." : ", and Claude continues its discussion."))) return;
        post("/topics/" + tid + "/reopen").then(function () {
          toast(was === "resolved" ? "Decision revoked: the topic is open again" : "Reopened: the topic is open again");
        }, failed);
        break;
      case "apply-session":
        var n = resolvedCount();
        if (!window.confirm("Apply resolved? Claude gets the plan from the decisions (" + n + ") of the branches without open questions and carries it out. These branches leave the list, branches with open questions stay.")) return;
        request("/api/sessions/" + encodeURIComponent(SID) + "/apply").then(function (r) {
          toast(r.listening ? "The plan went to Claude for execution" : "The plan waits for Claude: it will be carried out when Claude returns to the discussion");
        }, failed);
        break;
      case "apply-menu":
        applyMenu = !applyMenu;
        replyMenu = null;
        render();
        break;
      case "auto-apply-on":
      case "auto-apply-once":
      case "auto-apply-off":
        var once = name === "auto-apply-once", armed = st.autoApplyOnce;
        applyMenu = false;
        render();
        request("/api/sessions/" + encodeURIComponent(SID) + "/auto-apply", { on: name !== "auto-apply-off", once: once }).then(function (r) {
          toast(r.applied ? "No open questions: the resolved ones were applied, the plan went to Claude" :
            once ? "The resolved ones will apply once when all questions are resolved" :
            r.autoApply ? "The resolved ones will apply when all questions are resolved; new sessions start with auto-apply" :
            armed ? "Auto-apply cancelled" : "Auto-apply cancelled; new sessions start without it");
        }, failed);
        break;
      case "stop-session":
        if (!window.confirm("Stop the discussion? Claude stops listening and lists the decisions and the open questions in the chat. The questions are deleted from the server, and the pages take no messages until /live-comments:start in the chat starts a new discussion.")) return;
        request("/api/sessions/" + encodeURIComponent(SID) + "/stop").then(function () {
          showGone("The discussion is stopped: Claude lists the outcome in the chat, the questions are deleted. A new discussion starts with /live-comments:start in the chat.");
        }, failed);
        break;
      case "close":
        if (!window.confirm("Close the question “" + titleOf(t) + "” without a decision? Claude will no longer work on it.")) return;
        post("/topics/" + tid + "/close").then(function (r) {
          toast(r.autoApplied ? "Closed without a decision. No open questions left: the resolved ones were applied, the plan went to Claude"
            : "Closed without a decision");
        }, failed);
        break;
      default:
        if (diff) diff.act(name, node, e);
    }
  }

  document.addEventListener("click", function (e) {
    var t = e.target;
    if (!t.closest) return;
    if (!t.closest(".lc-menu, [data-act=apply-menu], [data-act=reply-menu], [data-act=tree-menu]")) closeMenus();
    // Before links: the button of an image inside a link does not open the link.
    var full = t.closest("[data-act=full]");
    if (full && app.contains(full)) {
      e.preventDefault();
      showFull(full);
      return;
    }
    var file = t.closest("a[data-file]");
    if (file) {
      e.preventDefault();
      openFile(file);
      return;
    }
    var dr = t.closest("a[data-draft]");
    if (dr) markFocus(dr.getAttribute("data-draft"));
    if (t.closest("a")) return;
    var el = t.closest("[data-act]");
    if (el && app.contains(el)) {
      act(el.getAttribute("data-act"), el, e);
      return;
    }
    var row = t.closest(".lc-row[data-href]");
    if (row && app.contains(row)) location.href = row.getAttribute("data-href");
  });

  // A selection in a message or decision is copied as its Markdown.
  document.addEventListener("copy", function (e) {
    var sel = window.getSelection();
    var text = sel.rangeCount && !sel.isCollapsed ? selectedMd(sel.getRangeAt(0)) : null;
    if (text == null || !e.clipboardData) return;
    e.clipboardData.setData("text/plain", text);
    e.preventDefault();
  });

  // ---- quotes

  // Text as a Markdown quote with "> " before each line and ">" for an empty one.
  function quoteMd(text) {
    return text.replace(/^\n+|\s+$/g, "").split("\n").map(function (l) {
      return l.trim() ? "> " + l : ">";
    }).join("\n");
  }

  // Text of selection r inside one code block as a fenced code block in the
  // block's language, and the lines of a diff quote and of a diff block of a
  // message as a diff block. Null for a selection outside code blocks.
  function codeQuote(r, text) {
    var c = r.commonAncestorContainer;
    var view = (c.nodeType === 1 ? c : c.parentNode).closest(".lc-mdiff");
    if (view && app.contains(view)) {
      var picked = {};
      [].forEach.call(view.querySelectorAll("td[data-row]"), function (td) {
        if (rangeIn(r, td).toString() || !td.textContent && r.intersectsNode(td)) picked[td.getAttribute("data-row")] = 1;
      });
      text = view.lcRows.filter(function (row, i) { return picked[i]; }).map(function (row) {
        return row.t === "@" ? row.s : row.t + row.s;
      }).join("\n");
      return "```diff\n" + text + "\n```";
    }
    var pre = (c.nodeType === 1 ? c : c.parentNode).closest("pre");
    if (!pre || !app.contains(pre)) return null;
    var code = pre.querySelector("code");
    var lang = pre.classList.contains("lc-dquote") ? "diff" :
      (/(?:^| )language-(\S+)/.exec(code ? code.className : "") || ["", ""])[1];
    var fence = "```";
    while (text.indexOf(fence) >= 0) fence += "`";
    return fence + lang + "\n" + text.replace(/^\n+|\s+$/g, "") + "\n" + fence;
  }

  // Puts quote q in place of the selection of focused field ta, a blank line
  // away from the text before and after it. The browser's editing keeps the
  // change in the field's history, so Ctrl+Z (Cmd+Z) takes it back.
  function insertQuote(ta, q) {
    var before = ta.value.slice(0, ta.selectionStart), after = ta.value.slice(ta.selectionEnd);
    var text = (!before || /\n\n$/.test(before) ? "" : /\n$/.test(before) ? "\n" : "\n\n") + q +
      (/^\n\n/.test(after) ? "" : /^\n/.test(after) ? "\n" : "\n\n");
    if (document.execCommand("insertText", false, text)) return;
    ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, "end");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // The reply field of the open topic whose messages or quote hold both ends
  // of selection r, or null.
  function quoteField(r) {
    function part(c) {
      var el = (c.nodeType === 1 ? c : c.parentNode).closest(".lc-msg, .lc-ctx");
      return el && app.contains(el) ? el.closest(".lc-body") : null;
    }
    var body = part(r.startContainer);
    if (!body || part(r.endContainer) !== body) return null;
    return body.querySelector(":scope > .lc-replybox textarea");
  }

  // The "Quote" button at a selection in a topic's discussion adds the
  // selection to the topic's reply field as a quote, in Markdown if it is
  // copied so. quoteText is the selection's text with its line breaks.
  var quoteBar = null, quoteRange = null, quoteText = "";
  // While the mouse button is held, the button is hidden, so the selection
  // being dragged does not run into it.
  var pressed = false;

  function checkQuote() {
    if (pressed) return;
    var sel = window.getSelection();
    var r = sel.rangeCount && !sel.isCollapsed && sel.toString().trim() ? sel.getRangeAt(0) : null;
    quoteRange = r && quoteField(r) ? r.cloneRange() : null;
    quoteText = quoteRange ? sel.toString() : "";
    if (!quoteRange) {
      if (quoteBar) quoteBar.hidden = true;
      return;
    }
    if (!quoteBar) {
      quoteBar = make("div", "lc-dbar");
      // Pressing on the button must not clear the selection.
      quoteBar.addEventListener("mousedown", function (e) { e.preventDefault(); });
      var b = quoteBar.appendChild(button("Quote", "quote"));
      b.title = "Adds the selection to the reply field as a quote";
      b.addEventListener("click", quote);
      document.body.appendChild(quoteBar);
    }
    var rects = quoteRange.getClientRects();
    var box = rects.length ? rects[rects.length - 1] : quoteRange.getBoundingClientRect();
    quoteBar.hidden = false;
    quoteBar.style.top = (box.bottom + window.scrollY + 4) + "px";
    quoteBar.style.left = Math.max(8, Math.min(box.right + window.scrollX - quoteBar.offsetWidth / 2,
      window.innerWidth - quoteBar.offsetWidth - 16)) + "px";
  }

  function quote() {
    var r = quoteRange, ta = r && quoteField(r);
    if (!ta) return;
    var plain = quoteText.replace(/\r\n?/g, "\n");
    var text = selectedMd(r);
    if (text == null) text = codeQuote(r, plain);
    if (text == null) text = plain;
    window.getSelection().removeAllRanges();
    quoteBar.hidden = true;
    quoteRange = null;
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(ta.value.length, ta.value.length);
    insertQuote(ta, quoteMd(text));
    ta.scrollIntoView({ block: "nearest" });
  }

  document.addEventListener("mousedown", function (e) {
    if (e.button !== 0 || quoteBar && quoteBar.contains(e.target)) return;
    pressed = true;
    if (quoteBar) quoteBar.hidden = true;
  });

  document.addEventListener("mouseup", function () {
    pressed = false;
    setTimeout(checkQuote, 0);
  });

  var quoteTimer = null;
  document.addEventListener("selectionchange", function () {
    clearTimeout(quoteTimer);
    if (!pressed) quoteTimer = setTimeout(checkQuote, 250);
  });

  // ---- images pasted into fields: uploaded to the session's images, they go
  // into the text as ![name](address). While an image uploads, the field has
  // its placeholder, and the text is not sent. The field may be re-rendered
  // meanwhile: the placeholder is found by the field's key, and without the
  // field — in its draft.

  // The largest image, as on the server.
  var IMAGE_MAX = 20 * 1024 * 1024;
  // The images that are pasted: those the Read tool of Claude shows, and
  // SVG, which it gives as its code.
  var IMAGE_TYPES = /^image\/(png|jpeg|gif|webp|svg\+xml)$/;
  // A placeholder of an image in a text, also of an upload of another tab
  // or of a page left before the upload ended.
  var PLACEHOLDER = /!\[Uploading [^\]\n]*…\]\(\)/g;
  // The placeholders of the images this page is uploading.
  var uploads = [];

  // Why text cannot be sent because of image placeholders in it: the text
  // of the toast, or null if it can be sent.
  function uploading(text) {
    var found = text.match(PLACEHOLDER) || [];
    if (!found.length) return null;
    if (found.every(function (p) { return uploads.indexOf(p) >= 0; })) return "Wait: an image is still uploading";
    return "The text has the placeholder of an image upload ![Uploading …](): wait for it to end, " +
      "or if the upload was interrupted, delete the placeholder and paste the image again";
  }

  // Inserts text at the cursor of field ta as typed, so the draft keeps it.
  function insertText(ta, text) {
    if (document.execCommand("insertText", false, text)) return;
    ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, "end");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // Returns text with placeholder replaced by md, and position p of the
  // text moved with it: {text, at}; without placeholder — null.
  function replaced(text, placeholder, md, p) {
    var at = text.indexOf(placeholder), end = at + placeholder.length;
    if (at < 0) return null;
    return { text: text.slice(0, at) + md + text.slice(end), at: p >= end ? p + md.length - placeholder.length : p > at ? at + md.length : p };
  }

  // Replaces placeholder with md in field key, and without the field — in
  // its draft. In the focused field the replacement is an edit, so Ctrl+Z
  // keeps working; a pending quote of the field is then undone by the page
  // itself (see pasted).
  function replaceUpload(key, placeholder, md) {
    uploads = uploads.filter(function (p) { return p !== placeholder; });
    var ta = app.querySelector('textarea[data-key="' + key + '"]');
    var at = ta ? ta.value.indexOf(placeholder) : -1;
    if (at >= 0) {
      var s = replaced(ta.value, placeholder, md, ta.selectionStart).at;
      var e = replaced(ta.value, placeholder, md, ta.selectionEnd).at;
      var edited = false;
      pasting = true;
      try {
        if (document.activeElement === ta) {
          ta.setSelectionRange(at, at + placeholder.length);
          edited = document.execCommand(md ? "insertText" : "delete", false, md);
        }
        if (!edited) {
          ta.value = ta.value.slice(0, at) + md + ta.value.slice(at + placeholder.length);
          ta.dispatchEvent(new Event("input", { bubbles: true }));
        }
      } finally {
        pasting = false;
      }
      ta.setSelectionRange(s, e);
      if (pasted && pasted.key === key) {
        var plain = replaced(pasted.plain.text, placeholder, md, pasted.plain.at);
        if (plain) pasted.plain = plain;
        pasted.quoted = ta.value;
        pasted.ta = null;
      }
      return;
    }
    var d = loadJson(DRAFTS_KEY, {})[key];
    at = d ? d.text.indexOf(placeholder) : -1;
    if (at >= 0) setDraft(key, d.text.slice(0, at) + md + d.text.slice(at + placeholder.length));
  }

  // Uploads image file to the session; gives its address.
  function uploadImage(file) {
    if (file.size > IMAGE_MAX) return Promise.reject(new Error("the image is larger than 20 MB"));
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result).slice(String(r.result).indexOf(",") + 1)); };
      r.onerror = function () { reject(new Error("the image could not be read")); };
      r.readAsDataURL(file);
    }).then(function (data) {
      // Not by request: a request with keepalive carries at most 64 KB.
      return fetch(API + "/images", {
        method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: data })
      });
    }).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok) throw new Error(d.error || "HTTP " + r.status);
        return d.url;
      });
    });
  }

  // Pastes image files into field ta at the cursor, one per line. A
  // placeholder is unique across pages and tabs: drafts are shared.
  function pasteImages(ta, files) {
    var key = ta.getAttribute("data-key");
    var items = files.map(function (f) {
      var name = (f.name || "").replace(/\.[^.]*$/, "").replace(/[\[\]\\\r\n]+/g, " ").trim() || "image";
      var id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      return { file: f, name: name, placeholder: "![Uploading " + name + " " + id + "…]()" };
    });
    uploads = uploads.concat(items.map(function (x) { return x.placeholder; }));
    insertText(ta, items.map(function (x) { return x.placeholder; }).join("\n"));
    items.forEach(function (x) {
      uploadImage(x.file).then(function (url) {
        replaceUpload(key, x.placeholder, "![" + x.name + "](" + url + ")");
      }, function (e) {
        replaceUpload(key, x.placeholder, "");
        failed(e);
      });
    });
  }

  // Text pasted into a field goes in as a quote. The first Ctrl+Z (Cmd+Z)
  // leaves the text as it was pasted, and the next one takes it away.
  // pasted is the field's last paste with the field's text as pasted and
  // with the quote. A re-rendered field has lost its history, and then
  // Ctrl+Z puts the text as pasted back itself. Other editing of the field
  // drops pasted, and pasting is set while the paste itself edits the field.
  // Images of the clipboard are pasted only without text: cells of a table
  // come with their picture and go in as text.
  var pasted = null, pasting = false;

  document.addEventListener("paste", function (e) {
    var ta = e.target;
    if (ta.tagName !== "TEXTAREA" || !app.contains(ta) || !e.clipboardData) return;
    var text = e.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n");
    if (!text.trim()) {
      var files = Array.prototype.filter.call(e.clipboardData.files || [], function (f) { return /^image\//.test(f.type); });
      var images = files.filter(function (f) { return IMAGE_TYPES.test(f.type); });
      if (files.length) e.preventDefault();
      if (images.length) pasteImages(ta, images);
      if (images.length < files.length) toast("Only PNG, JPEG, GIF, WebP and SVG images are pasted: Claude can read only them");
      return;
    }
    pasting = true;
    try {
      if (!document.execCommand("insertText", false, text)) return;
      e.preventDefault();
      var plain = { text: ta.value, at: ta.selectionEnd };
      ta.setSelectionRange(ta.selectionEnd - text.length, ta.selectionEnd);
      insertQuote(ta, quoteMd(text));
      pasted = { ta: ta, key: ta.getAttribute("data-key"), plain: plain, quoted: ta.value };
    } finally {
      pasting = false;
    }
  });

  document.addEventListener("input", function (e) {
    if (pasted && !pasting && e.target.getAttribute("data-key") === pasted.key) pasted = null;
  });

  // Z is the letter of the layout if it is Latin, and the physical key otherwise.
  document.addEventListener("keydown", function (e) {
    var z = /^[a-z]$/i.test(e.key) ? e.key.toLowerCase() === "z" : e.code === "KeyZ";
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || !z || !pasted) return;
    var p = pasted, ta = document.activeElement;
    pasted = null;
    if (!ta || ta === p.ta || ta.getAttribute("data-key") !== p.key || ta.value !== p.quoted) return;
    e.preventDefault();
    ta.value = p.plain.text;
    ta.setSelectionRange(p.plain.at, p.plain.at);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });

  // The middle button on a file:// link opens the file the same way.
  document.addEventListener("auxclick", function (e) {
    var file = e.button === 1 && e.target.closest && e.target.closest("a[data-file]");
    if (file) {
      e.preventDefault();
      openFile(file);
    }
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
    list.push(["Ctrl+Enter", "send the field's text, in a topic like “Reply”"]);
    list.push(["Ctrl+Z", "right after pasting into a field — the text without the quote"]);
    if (diff) list.push(["Ctrl+P", "file list with search: ↑↓ choose, Enter opens, Esc closes"]);
    if (TOPIC) list.push(["Esc", "hide the first message shown under the pointer at the topic title"]);
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
  // the physical "/?" key. Esc closes the help. Over the full screen window
  // Esc closes the window, and the help does not open under it.
  document.addEventListener("keydown", function (e) {
    var open = keysEl && !keysEl.hidden;
    if (fullSrc) {
      if (e.key === "Escape") showFull(null);
      return;
    }
    if (e.key === "Escape" && open) {
      showKeys(false);
      return;
    }
    if (e.key === "Escape") {
      closeMenus();
      hidePop();
    }
    if (!(e.key === "?" || e.code === "Slash" && e.shiftKey) || e.ctrlKey || e.metaKey || e.altKey) return;
    var a = document.activeElement;
    if (a && (a.tagName === "TEXTAREA" || a.tagName === "INPUT" || a.isContentEditable)) return;
    e.preventDefault();
    showKeys(!open);
  });

  // The pointer has left the title of the topic in the header: the next
  // time it shows the first message again.
  app.addEventListener("mouseout", function (e) {
    var box = popOff && e.target.closest && e.target.closest(".lc-crumb-topic");
    if (!box || box.contains(e.relatedTarget)) return;
    popOff = false;
    box.classList.remove("lc-pop-off");
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
    headHeight();
    if (pan) (pan.fitted ? fitFull : placeFull)();
  });

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") render();
  });

  if (CFG.view === "diff" && window.LiveCommentsDiff) {
    app.classList.add("lc-wide");
    diff = window.LiveCommentsDiff({
      SID: SID, API: API, app: app, make: make, button: button, toast: toast, failed: failed,
      request: request, post: post, render: render, titleOf: titleOf, status: status, unseenOf: unseenOf,
      draft: function (key) { return drafts[key] || null; }, setDraft: setDraft, uploading: uploading,
      bodyEl: bodyEl, linesText: linesText, patchKids: patchKids, region: region, workOf: workOf, stampOf: stampOf,
      topics: function () { return st ? st.topics : []; }
    });
  }
  app.appendChild(make("p", "lc-hint", "Loading…"));
  poll();
  // Times until resets in the status bar go down without new data.
  setInterval(renderStatus, 30000);
})();
