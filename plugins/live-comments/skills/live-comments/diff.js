(function () {
  "use strict";

  // The session's change review page /<session id>/diff, as in VS Code: the
  // diffs of all files of a group — working tree changes or staged changes —
  // one under another, versions side by side or inline. The file list is a
  // tree with a search field in a popup in the middle of the window, opened
  // by a button or by Ctrl+P. A file can be collapsed and marked
  // viewed. A file, a change block or selected lines are staged and
  // unstaged, changes of a working tree file and block can be discarded; a
  // question can be asked about selected lines — it becomes a session topic,
  // and its discussion is shown under these lines. The page is drawn by
  // app.js: it calls LiveCommentsDiff with its own functions (lc) and embeds
  // el() into the page.
  window.LiveCommentsDiff = function (lc) {
    var make = lc.make;
    var params = new URLSearchParams(location.search);
    // The group on the page: staged changes (index against HEAD) or working
    // tree changes (working tree against index).
    var staged = params.get("s") === "1";
    // The file and topic to scroll the page to after the first render.
    var focusFile = params.get("f");
    var focusTopic = params.get("topic");
    var repo = null;
    // Diffs of the group's files (see file_diff in cm.py) in git status order.
    var files = null;
    var error = "";
    var shown = "";
    // Selected lines: the file path, the hash of its diff and the indexes of diff lines.
    var pick = null;
    // A new question on lines: the anchor the topic gets. app.js keeps its
    // text with the anchor in the "diffnew" draft.
    var draft = null;
    var focusDraft = false;
    // Expanded discussions under lines: topic id → true or false.
    var cardOpen = {};
    // The table row from which Shift+click on a line number extends the
    // selection: the file path and the row number.
    var lastLine = null;
    // Diff view: "split" — the old and new versions side by side, "inline" —
    // one column. The choice is remembered in the browser.
    var MODE_KEY = "lc-diff-mode";
    var mode = load(MODE_KEY, "split") === "inline" ? "inline" : "split";
    // Layouts of file diffs from the last render: path → layoutOf.
    var lays = {};
    // Collapsed files: file key (keyOf) → true or false, while the page is open.
    var folded = {};
    // A draft of a question on lines brings back the question field; the question's file is expanded.
    var saved = lc.draft("diffnew");
    if (saved) {
      draft = saved.anchor;
      folded[keyOf(draft.file, draft.staged)] = false;
    }
    // Viewed files: file key → the hash of its diff at the moment of marking.
    // If the diff has changed since then, the file is not viewed again.
    var REVIEW_KEY = "lc-reviewed:" + lc.SID;
    var reviewed = load(REVIEW_KEY, {});
    // A diff longer than this many lines is collapsed until expanded.
    var BIG = 500;
    // The file list popup: its window lies outside lc.app, so re-rendering
    // the page keeps the search text and focus. listBox — the window with
    // the dimmed backdrop, listHead, listInput, listTree — its header, search
    // field and tree.
    var listOpen = false;
    var listBox = null, listHead = null, listInput = null, listTree = null;
    // The rows of the tree from the last render (see treeRows) and the key of the chosen row.
    var listRows = [];
    var activeKey = null;
    // Collapsed folders of the tree: folder key → true. They are remembered
    // in the browser for the repository (dirsKey — the storage key, known
    // once the changes are read), so all sessions on it share them. While
    // searching, all folders are expanded, and folders collapsed then
    // (closedFound) stay collapsed until the search text changes.
    var closedDirs = {}, closedFound = {};
    var dirsKey = null;
    // Whether the changes are being read and whether to re-read them right away.
    var busy = false;
    var again = false;
    var bar = null;

    function load(key, dflt) {
      try {
        var v = window.localStorage.getItem(key);
        return v == null ? dflt : typeof dflt === "string" ? v : JSON.parse(v);
      } catch (e) {
        return dflt;
      }
    }

    function save(key, v) {
      try {
        window.localStorage.setItem(key, typeof v === "string" ? v : JSON.stringify(v));
      } catch (e) {
        // Without storage the choice lives only until a reload.
      }
    }

    function getJson(url) {
      return fetch(url, { cache: "no-store" }).then(function (r) {
        return r.json().then(function (d) {
          if (!r.ok) throw new Error(d.error || "HTTP " + r.status);
          return d;
        });
      });
    }

    function keyOf(path, side) {
      return ((side == null ? staged : side) ? "s:" : "w:") + path;
    }

    function fileOf(path) {
      return (files || []).find(function (d) { return d.path === path; }) || null;
    }

    function isReviewed(d) {
      return reviewed[keyOf(d.path)] === d.hash;
    }

    function isFolded(d) {
      var f = folded[keyOf(d.path)];
      return f != null ? f : isReviewed(d) || d.rows.length > BIG;
    }

    function groups() {
      var all = (repo && repo.files) || [];
      return [
        { staged: false, title: "Changes", files: all.filter(function (f) { return f.work !== " "; }) },
        { staged: true, title: "Staged Changes", files: all.filter(function (f) {
          return f.index !== " " && f.index !== "?";
        }) }
      ];
    }

    function letter(f, side) {
      var c = side ? f.index : f.work;
      return c === "?" ? "U" : c;
    }

    function syncUrl() {
      history.replaceState(null, "", location.pathname + "?s=" + (staged ? 1 : 0));
    }

    // Re-reads the repository changes and the diffs of the group's files and
    // re-renders the page if something changed.
    function refresh() {
      if (busy) {
        again = true;
        return Promise.resolve();
      }
      busy = true;
      var side = staged;
      return getJson(lc.API + "/git").then(function (next) {
        repo = next;
        if (!dirsKey) {
          dirsKey = "lc-closed-dirs:" + repo.repo;
          closedDirs = load(dirsKey, {});
        }
        return getJson(lc.API + "/git/diffs?staged=" + (side ? 1 : 0));
      }).then(function (d) {
        // The group could have been switched during the request: such a response is stale.
        if (side !== staged) return;
        error = "";
        files = d.files;
        var p = pick && fileOf(pick.path);
        if (pick && (!p || p.hash !== pick.hash)) clearSelection();
      }, function (e) {
        error = e.message;
      }).then(function () {
        busy = false;
        var now = JSON.stringify([staged, repo, files, error]);
        if (now !== shown) {
          shown = now;
          lc.render();
        }
        if (again || side !== staged) {
          again = false;
          return refresh();
        }
      });
    }

    // ---- line selection

    // Diff lines where at least one character is selected: {path, hash, idx};
    // null if the selection is not in diff lines or spans several files.
    function selectedRows() {
      var sel = window.getSelection();
      if (!files || !sel || sel.isCollapsed || !sel.rangeCount) return null;
      var range = sel.getRangeAt(0);
      var tables = Array.prototype.filter.call(lc.app.querySelectorAll(".lc-dtable"), function (t) {
        return range.intersectsNode(t);
      });
      if (tables.length !== 1) return null;
      var idx = [];
      Array.prototype.forEach.call(tables[0].querySelectorAll("tr[data-rows]"), function (tr) {
        if (!range.intersectsNode(tr)) return;
        var part = document.createRange();
        part.selectNodeContents(tr);
        if (range.compareBoundaryPoints(Range.START_TO_START, part) > 0) part.setStart(range.startContainer, range.startOffset);
        if (range.compareBoundaryPoints(Range.END_TO_END, part) < 0) part.setEnd(range.endContainer, range.endOffset);
        if (!part.collapsed && part.toString())
          tr.getAttribute("data-rows").split(",").forEach(function (k) { idx.push(+k); });
      });
      var d = fileOf(tables[0].getAttribute("data-path"));
      if (!idx.length || !d) return null;
      return { path: d.path, hash: d.hash, idx: idx.sort(function (x, y) { return x - y; }) };
    }

    function lineTr(path, n) {
      return lc.app.querySelector('.lc-dtable[data-path="' + CSS.escape(path) + '"] tr[data-line="' + n + '"]');
    }

    // Selects the table rows of file path from a to b in full.
    function selectLines(path, a, b) {
      var lo = lineTr(path, Math.min(a, b)), hi = lineTr(path, Math.max(a, b));
      if (!lo || !hi) return;
      var first = lo.querySelector(".lc-code"), cells = hi.querySelectorAll(".lc-code");
      var last = cells[cells.length - 1];
      var r = document.createRange();
      r.setStart(first, 0);
      r.setEnd(last, last.childNodes.length);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    }

    function changed(d, idx) {
      return idx.filter(function (i) { return d.rows[i].t === "+" || d.rows[i].t === "-"; });
    }

    // The bar above selected lines: staging or unstaging and a question.
    function showBar() {
      pick = selectedRows();
      if (!pick) {
        if (bar) bar.hidden = true;
        return;
      }
      if (!bar) {
        bar = make("div", "lc-dbar");
        // Pressing on the bar must not clear the line selection.
        bar.addEventListener("mousedown", function (e) { e.preventDefault(); });
        bar.addEventListener("click", function (e) {
          var b = e.target.closest("[data-act]");
          if (b) act(b.getAttribute("data-act"), b, e);
        });
        document.body.appendChild(bar);
      }
      var d = fileOf(pick.path);
      bar.textContent = "";
      var n = changed(d, pick.idx).length;
      if (n && !d.binary)
        bar.appendChild(lc.button((staged ? "Unstage " : "Stage ") + n + " " + (n === 1 ? "line" : "lines"),
          staged ? "unstage-rows" : "stage-rows", staged ? "" : "primary"));
      bar.appendChild(lc.button("Ask a question", "comment-rows"));
      var box = lineTr(pick.path, lays[pick.path].lineOf[pick.idx[pick.idx.length - 1]]).getBoundingClientRect();
      bar.hidden = false;
      bar.style.top = (box.bottom + window.scrollY + 4) + "px";
      bar.style.left = Math.max(8, Math.min(box.left + window.scrollX + 110, window.innerWidth - bar.offsetWidth - 16)) + "px";
    }

    function clearSelection() {
      window.getSelection().removeAllRanges();
      pick = null;
      if (bar) bar.hidden = true;
    }

    // ---- questions on lines

    // The topic anchor by lines idx of diff d: the file, the diff side, line
    // numbers in the new version (and if only removed lines are selected — in
    // the old one) and the lines themselves with the signs "+", "-", " ".
    function anchorOf(d, idx) {
      var rows = idx.map(function (i) { return d.rows[i]; }).filter(function (r) { return r.t !== "@"; });
      var news = rows.filter(function (r) { return r.t !== "-"; });
      var side = news.length ? "new" : "old";
      var nums = (news.length ? news : rows).map(function (r) { return side === "new" ? r.n : r.o; });
      var lines = rows.map(function (r) { return r.t + r.s; });
      return { kind: "diff", file: d.path, staged: staged, side: side, start: Math.min.apply(null, nums),
        end: Math.max.apply(null, nums), rows: lines, quote: lines.join("\n") };
    }

    // The index of the diff d line under which the topic with anchor a
    // stands: the last line of the run of lines matching the anchor's lines
    // that is nearest to its line numbers; -1 if there is no such run in the
    // diff. Hunk headers do not break the run.
    function placeOf(d, a) {
      var want = a.rows || [], idx = [];
      d.rows.forEach(function (r, i) { if (r.t !== "@") idx.push(i); });
      var best = -1, dist = Infinity;
      for (var i = 0; want.length && i + want.length <= idx.length; i++) {
        var ok = want.every(function (w, k) { var r = d.rows[idx[i + k]]; return r.t + r.s === w; });
        if (!ok) continue;
        var end = d.rows[idx[i + want.length - 1]];
        var gap = Math.abs((a.side === "old" ? end.o : end.n) - a.end);
        if (gap < dist) {
          dist = gap;
          best = idx[i + want.length - 1];
        }
      }
      return best;
    }

    function fileTopics(path) {
      return lc.topics().filter(function (t) { return t.anchor && t.anchor.kind === "diff" && t.anchor.file === path; });
    }

    function openTopics(path) {
      return fileTopics(path).filter(function (t) { return t.state === "open"; }).length;
    }

    // A topic's discussion under lines: a row with the question and state,
    // and when expanded — the messages and the reply field. Open topics are
    // expanded, closed ones collapsed until expanded.
    function cardEl(t) {
      var open = cardOpen[t.id] != null ? cardOpen[t.id] : t.state === "open";
      var box = make("div", "lc-dcard lc-" + t.state + " lc-s-" + lc.status(t)[0]);
      box.setAttribute("data-tid", t.id);
      var head = make("div", "lc-dcard-head");
      head.setAttribute("data-act", "card-toggle");
      head.setAttribute("data-key", "card:" + t.id);
      head.appendChild(make("span", "lc-tog", open ? "▾" : "▸"));
      head.appendChild(make("span", "lc-dot"));
      var title = make("span", "lc-title", lc.titleOf(t));
      title.title = lc.titleOf(t);
      head.appendChild(title);
      // An expanded open topic has its state above the reply field.
      var s = lc.status(t);
      if (s[1] && (!open || t.state !== "open")) head.appendChild(make("span", "lc-badge lc-b-" + s[0], s[1]));
      if (lc.unseenOf(t).length) head.appendChild(make("span", "lc-new", "new"));
      var go = make("a", "lc-src", "question page ↗");
      go.href = "/" + lc.SID + "/" + t.id;
      go.target = "_blank";
      head.appendChild(go);
      box.appendChild(head);
      if (open) box.appendChild(lc.bodyEl(t, true));
      return box;
    }

    function draftEl() {
      var box = make("div", "lc-dcard lc-ddraft");
      var ta = make("textarea", "lc-textarea");
      ta.rows = 3;
      ta.placeholder = "A question or remark on the selected lines — becomes a discussion question";
      ta.setAttribute("data-key", "diffnew");
      box.appendChild(ta);
      var row = make("div", "lc-actions");
      row.appendChild(lc.button("Ask", "diff-ask", "primary"));
      row.appendChild(lc.button("Cancel", "diff-cancel"));
      row.appendChild(make("span", "lc-kbd", "Ctrl+Enter — send"));
      box.appendChild(row);
      return box;
    }

    function extraRow(el) {
      var tr = make("tr", "lc-dextra");
      var td = make("td");
      td.colSpan = 5;
      td.appendChild(el);
      tr.appendChild(td);
      return tr;
    }

    // ---- file list

    function iconBtn(text, act, title) {
      var b = make("button", "lc-ibtn", text);
      b.type = "button";
      b.setAttribute("data-act", act);
      b.title = title;
      return b;
    }

    // File buttons, as in VS Code: "↶" — discard working tree changes,
    // "+" or "−" — stage or unstage the file.
    function fileBtns(box, side) {
      if (!side) box.appendChild(iconBtn("↶", "discard-file", "Discard file changes"));
      box.appendChild(side ? iconBtn("−", "unstage-file", "Unstage file") :
        iconBtn("+", "stage-file", "Stage file"));
    }

    // Names in the tree are ordered as in VS Code: case-insensitive, numbers by value.
    // One collator for all comparisons: localeCompare with options creates one per call.
    var byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }).compare;

    // The files list of group side as rows of a tree, as in VS Code: in each
    // folder its folders go first, then its files, both by name; a folder
    // holding only one folder is one row "a/b". A row: kind — "dir" or
    // "file", key — the folder key (keyOf of its path with "/" at the end)
    // or the file key, up — the key of the folder the row is in, depth —
    // its nesting level, side, name, open — whether the folder is expanded,
    // f — the file of a file row. searching — the list is a search result:
    // all folders are expanded except those collapsed during this search.
    function treeRows(list, side, searching) {
      var closed = searching ? closedFound : closedDirs;
      var root = { dirs: {}, files: [] };
      list.forEach(function (f) {
        var parts = f.path.split("/"), node = root;
        for (var i = 0; i < parts.length - 1; i++)
          node = node.dirs[parts[i]] = node.dirs[parts[i]] ||
            { name: parts[i], path: parts.slice(0, i + 1).join("/"), dirs: {}, files: [] };
        node.files.push(f);
      });
      var rows = [];
      (function walk(node, up, depth) {
        Object.keys(node.dirs).sort(byName).forEach(function (k) {
          var dir = node.dirs[k], name = dir.name, subs;
          while (!dir.files.length && (subs = Object.keys(dir.dirs)).length === 1) {
            dir = dir.dirs[subs[0]];
            name += "/" + dir.name;
          }
          var key = keyOf(dir.path + "/", side);
          var open = !closed[key];
          rows.push({ kind: "dir", key: key, up: up, depth: depth, side: side, name: name, open: open });
          if (open) walk(dir, key, depth + 1);
        });
        node.files.slice().sort(function (a, b) { return byName(a.path, b.path); }).forEach(function (f) {
          rows.push({ kind: "file", key: keyOf(f.path, side), up: up, depth: depth, side: side,
            name: f.path.slice(f.path.lastIndexOf("/") + 1), f: f });
        });
      })(root, null, 0);
      return rows;
    }

    // A span of class cls with text s where the words of the search are
    // highlighted; words — lowercase.
    function marked(cls, s, words) {
      var box = make("span", cls), low = s.toLowerCase(), hit = [];
      words.forEach(function (w) {
        for (var at = low.indexOf(w); at >= 0; at = low.indexOf(w, at + 1))
          for (var k = at; k < at + w.length; k++) hit[k] = true;
      });
      for (var i = 0, j; i < s.length; i = j) {
        for (j = i + 1; j < s.length && !hit[j] === !hit[i]; j++);
        box.appendChild(hit[i] ? make("mark", "", s.slice(i, j)) : document.createTextNode(s.slice(i, j)));
      }
      return box;
    }

    // A tree row: indented by its nesting level, the chosen one is highlighted.
    function rowEl(r, act) {
      var row = make("div", "lc-file lc-tree-" + r.kind + (r.key === activeKey ? " lc-active" : ""));
      row.setAttribute("data-act", act);
      row.setAttribute("data-key", r.key);
      row.style.paddingLeft = 10 + r.depth * 16 + "px";
      return row;
    }

    // A folder row: the arrow and the name; a click collapses or expands it.
    function dirEl(r, words) {
      var row = rowEl(r, "tree-dir");
      row.appendChild(make("span", "lc-tog", r.open ? "▾" : "▸"));
      row.appendChild(marked("lc-fname", r.name, words));
      return row;
    }

    // A file row: the name, the "viewed" mark, the number of open questions
    // on the file, the file buttons and the status letter; a click goes to
    // the file's diff.
    function listFileEl(r, words) {
      var f = r.f;
      var d = r.side === staged ? fileOf(f.path) : null;
      var row = rowEl(r, "goto-file");
      if (r.side === staged) row.className += " lc-here";
      row.setAttribute("data-path", f.path);
      row.setAttribute("data-staged", r.side ? "1" : "0");
      row.title = f.path;
      row.appendChild(make("span", "lc-tog"));
      row.appendChild(marked("lc-fname", r.name, words));
      if (d && isReviewed(d)) row.appendChild(make("span", "lc-fseen", "✓"));
      var open = openTopics(f.path);
      if (open) {
        var c = make("span", "lc-fq", String(open));
        c.title = "Open questions on the file: " + open;
        row.appendChild(c);
      }
      fileBtns(row, r.side);
      var l = letter(f, r.side);
      row.appendChild(make("span", "lc-fst lc-fst-" + l, l));
      return row;
    }

    function listWords() {
      return listInput.value.toLowerCase().split(/\s+/).filter(Boolean);
    }

    // Re-renders the file list popup: the files of both groups whose paths
    // contain all words of the search, as trees. The chosen row stays chosen
    // while it is in the list, otherwise the first file is chosen. reveal —
    // scroll the list to the chosen row; otherwise the scroll position stays.
    function renderList(reveal) {
      listHead.textContent = "";
      listHead.appendChild(make("span", "lc-scm-branch", repo ? "⎇ " + repo.branch : ""));
      listHead.appendChild(iconBtn("×", "files", "Close the file list — Esc"));
      var top = listTree.scrollTop;
      listTree.textContent = "";
      if (!repo) {
        listTree.appendChild(make("p", "lc-hint", "Loading changes…"));
        return;
      }
      var words = listWords();
      var parts = groups().map(function (g) {
        var found = g.files.filter(function (f) {
          var p = f.path.toLowerCase();
          return words.every(function (w) { return p.indexOf(w) >= 0; });
        });
        return { g: g, found: found, rows: treeRows(found, g.staged, words.length > 0) };
      });
      listRows = [].concat.apply([], parts.map(function (p) { return p.rows; }));
      if (!listRows.some(function (r) { return r.key === activeKey; })) {
        var first = listRows.find(function (r) { return r.kind === "file"; });
        activeKey = first ? first.key : null;
      }
      parts.forEach(function (p) {
        var gh = make("div", "lc-group");
        gh.appendChild(make("span", "lc-group-title", p.g.title));
        if (p.g.files.length) gh.appendChild(p.g.staged ? iconBtn("−", "unstage-all", "Unstage all changes") :
          iconBtn("+", "stage-all", "Stage all changes"));
        gh.appendChild(make("span", "lc-count", words.length ? p.found.length + " of " + p.g.files.length :
          String(p.g.files.length)));
        listTree.appendChild(gh);
        p.rows.forEach(function (r) { listTree.appendChild(r.kind === "dir" ? dirEl(r, words) : listFileEl(r, words)); });
        if (!p.found.length) listTree.appendChild(make("div", "lc-file lc-none", p.g.files.length ? "No matches" : "No changes"));
      });
      listTree.scrollTop = top;
      var a = reveal && listTree.querySelector(".lc-active");
      if (a) a.scrollIntoView({ block: "nearest" });
    }

    // The path of the file whose diff is at the top of the window, under the toolbar.
    function fileInView() {
      var secs = lc.app.querySelectorAll(".lc-dfile");
      for (var i = 0; i < secs.length; i++)
        if (secs[i].getBoundingClientRect().bottom > 52) return secs[i].getAttribute("data-path");
      return null;
    }

    // The popup window of the file list. A press on the backdrop closes it,
    // a click on a row keeps the focus in the search field.
    function listEl() {
      listBox = make("div", "lc-flist-wrap");
      listBox.hidden = true;
      var box = make("div", "lc-flist");
      box.setAttribute("role", "dialog");
      listHead = box.appendChild(make("div", "lc-scm-repo"));
      listInput = box.appendChild(make("input", "lc-fsearch"));
      listInput.type = "text";
      listInput.placeholder = "Search files by path";
      listInput.spellcheck = false;
      listInput.autocomplete = "off";
      listTree = box.appendChild(make("div", "lc-ftree"));
      box.appendChild(make("div", "lc-hint lc-fkeys",
        "↑↓ — choose · Enter — open the file or fold the folder · ←→ — fold and unfold folders · Esc — close"));
      listBox.appendChild(box);
      listBox.addEventListener("mousedown", function (e) {
        if (e.target === listBox) setList(false);
      });
      listBox.addEventListener("click", function (e) {
        var b = e.target.closest("[data-act]");
        if (b) act(b.getAttribute("data-act"), b, e);
        if (listOpen) listInput.focus();
      });
      listInput.addEventListener("input", function () {
        closedFound = {};
        activeKey = null;
        renderList(true);
      });
      listInput.addEventListener("keydown", listKey);
      document.body.appendChild(listBox);
    }

    // Opens the file list with an empty search, the file at the top of the
    // window chosen, or closes it.
    function setList(open) {
      if (!listBox) listEl();
      listOpen = open;
      listBox.hidden = !open;
      if (!open) {
        listInput.blur();
        return;
      }
      listInput.value = "";
      closedFound = {};
      var p = fileInView();
      activeKey = p ? keyOf(p) : null;
      renderList(true);
      listInput.focus();
    }

    // Folds or unfolds the folder with key, choosing it; outside a search
    // the folder's state is remembered.
    function toggleDir(key) {
      var closed = listWords().length ? closedFound : closedDirs;
      if (closed[key]) delete closed[key];
      else closed[key] = true;
      if (closed === closedDirs && dirsKey) save(dirsKey, closedDirs);
      activeKey = key;
      renderList(true);
    }

    // Chooses the row with key: only the highlight moves, the list is not
    // re-rendered, so moving is fast on a page with many lines of diffs.
    function choose(key) {
      activeKey = key;
      var old = listTree.querySelector(".lc-active");
      if (old) old.classList.remove("lc-active");
      var row = listTree.querySelector('[data-key="' + CSS.escape(key) + '"]');
      if (!row) return;
      row.classList.add("lc-active");
      row.scrollIntoView({ block: "nearest" });
    }

    function gotoFile(side, path) {
      setList(false);
      showSide(side, path);
    }

    // Keys of the search field: ↑↓ choose a row, Enter opens the chosen file
    // or folds the chosen folder. With an empty field ← and → work as in a
    // tree: → unfolds a folder and then goes to its first row, ← folds a
    // folder and then goes to the folder the row is in.
    function listKey(e) {
      var i = -1;
      listRows.forEach(function (r, k) { if (r.key === activeKey) i = k; });
      var r = listRows[i];
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        var n = listRows.length;
        if (n) choose(listRows[i < 0 ? 0 : (i + (e.key === "ArrowDown" ? 1 : n - 1)) % n].key);
      } else if (e.key === "Enter" && r) {
        e.preventDefault();
        if (r.kind === "file") gotoFile(r.side, r.f.path);
        else toggleDir(r.key);
      } else if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && r && !listInput.value) {
        e.preventDefault();
        var right = e.key === "ArrowRight";
        if (r.kind === "dir" && r.open !== right) toggleDir(r.key);
        else if (right && r.kind === "dir" && listRows[i + 1] && listRows[i + 1].up === r.key) choose(listRows[i + 1].key);
        else if (!right && r.up) choose(r.up);
      }
    }

    // ---- file diff

    // The layout of diff d into table rows. lines — the rows: rows — the
    // indexes of diff lines the row shows, blk — the number of the change
    // block (others have -1). A block is a run of "-" and "+" lines; blocks —
    // the line indexes of each block, lineOf — the table row of each diff
    // line. Inline, a table row is one diff line; side by side, the lines of
    // a block go in pairs: the i-th removed on the left (del), the i-th added
    // on the right (add).
    function layoutOf(d) {
      var rows = d.rows, lines = [], blocks = [], lineOf = {};
      for (var i = 0; i < rows.length;) {
        if (rows[i].t !== "+" && rows[i].t !== "-") {
          lines.push({ rows: [i], blk: -1 });
          i++;
          continue;
        }
        var run = [], dels = [], adds = [];
        for (; i < rows.length && (rows[i].t === "+" || rows[i].t === "-"); i++) {
          run.push(i);
          (rows[i].t === "-" ? dels : adds).push(i);
        }
        var b = blocks.push(run) - 1;
        if (mode === "inline") run.forEach(function (k) { lines.push({ rows: [k], blk: b }); });
        else for (var k = 0; k < Math.max(dels.length, adds.length); k++)
          lines.push({ rows: [dels[k], adds[k]].filter(function (x) { return x != null; }), del: dels[k], add: adds[k], blk: b });
      }
      lines.forEach(function (l, n) { l.rows.forEach(function (k) { lineOf[k] = n; }); });
      return { lines: lines, blocks: blocks, lineOf: lineOf };
    }

    function numEl(num, cls) {
      var td = make("td", "lc-ln" + cls, String(num));
      td.setAttribute("data-act", "pick-line");
      td.title = "Select the line; Shift — up to this line";
      return td;
    }

    // The text of diff line r; without r — an empty place opposite a line of the other version.
    function codeEl(r, cls) {
      var td = make("td", "lc-code" + cls, r ? r.s : "");
      if (r && r.noeol) td.appendChild(make("span", "lc-noeol", "⊘ no newline at end of file"));
      return td;
    }

    // The middle column of a table row. In the first row of a change block —
    // the block buttons, as in VS Code: "+" — stage the block and "↶" —
    // discard it in the working tree, and in staged changes "−" — unstage the
    // block. They are bright on hover over the block.
    function midEl(line, first) {
      var td = make("td", "lc-mid");
      if (!first) return td;
      var acts = staged ? [["−", "unstage-block", "Unstage block"]] :
        [["+", "stage-block", "Stage block"], ["↶", "revert-block", "Discard block"]];
      acts.forEach(function (a) {
        var b = make("button", "lc-blkbtn lc-" + a[1], a[0]);
        b.type = "button";
        b.title = a[2];
        b.setAttribute("data-act", a[1]);
        b.setAttribute("data-blk", line.blk);
        td.appendChild(b);
      });
      return td;
    }

    function lineEl(d, lay, line, n) {
      var r = d.rows[line.rows[0]];
      var tr = make("tr", "lc-dr");
      tr.setAttribute("data-line", n);
      tr.setAttribute("data-rows", line.rows.join(","));
      if (r.t === "@") {
        tr.className += " lc-dr-hunk";
        var h = make("td", "lc-code", r.s);
        h.colSpan = 5;
        tr.appendChild(h);
        return tr;
      }
      var prev = lay.lines[n - 1];
      var first = line.blk >= 0 && !d.binary && (!prev || prev.blk !== line.blk);
      if (mode === "inline") {
        tr.className += " lc-dr-" + ({ "+": "add", "-": "del", " ": "ctx" })[r.t];
        tr.appendChild(numEl(r.t === "+" ? "" : r.o, ""));
        tr.appendChild(numEl(r.t === "-" ? "" : r.n, ""));
        tr.appendChild(midEl(line, first));
        tr.appendChild(make("td", "lc-sign", r.t === " " ? "" : r.t));
        tr.appendChild(codeEl(r, ""));
      } else {
        var del = line.blk < 0 ? r : line.del != null ? d.rows[line.del] : null;
        var add = line.blk < 0 ? r : line.add != null ? d.rows[line.add] : null;
        var dc = line.blk < 0 ? "" : del ? " lc-cdel" : " lc-cfill";
        var ac = line.blk < 0 ? "" : add ? " lc-cadd" : " lc-cfill";
        tr.appendChild(numEl(del ? del.o : "", dc));
        tr.appendChild(codeEl(del, dc));
        tr.appendChild(midEl(line, first));
        tr.appendChild(numEl(add ? add.n : "", ac));
        tr.appendChild(codeEl(add, ac));
      }
      return tr;
    }

    function qkind(r) {
      return { "+": "add", "-": "del" }[r.charAt(0)] || "ctx";
    }

    // The lines of diff d with discussions under them and questions on lines
    // that are no longer in the diff.
    function diffBody(d) {
      var body = make("div", "lc-dfile-body");
      d.info.forEach(function (line) { body.appendChild(make("div", "lc-dinfo", line)); });
      var lay = lays[d.path] = layoutOf(d);
      // Discussions and the new question field stand under the table row where their lines end.
      var at = {}, loose = [];
      fileTopics(d.path).forEach(function (t) {
        var i = placeOf(d, t.anchor);
        if (i < 0) loose.push(t);
        else (at[lay.lineOf[i]] = at[lay.lineOf[i]] || []).push(t);
      });
      var draftRow = draft && draft.file === d.path ? placeOf(d, draft) : -1;
      var draftAt = draftRow < 0 ? -1 : lay.lineOf[draftRow];
      if (loose.length) {
        var lb = make("div", "lc-dloose");
        lb.appendChild(make("div", "lc-hint", "Questions on lines that are not in this diff:"));
        loose.forEach(function (t) {
          var q = make("pre", "lc-dquote");
          (t.anchor.rows || []).forEach(function (r) { q.appendChild(make("div", "lc-dq lc-dq-" + qkind(r), r)); });
          var wrap = make("div", "lc-dloose-item");
          wrap.appendChild(make("div", "lc-src", lc.linesText(t.anchor)));
          wrap.appendChild(q);
          wrap.appendChild(cardEl(t));
          lb.appendChild(wrap);
        });
        body.appendChild(lb);
      }
      if (!d.rows.length) {
        body.appendChild(make("p", "lc-hint", d.binary ? "Binary file: lines are not shown." : "No line changes."));
        return body;
      }
      var table = make("table", "lc-dtable lc-dt-" + mode);
      table.setAttribute("data-path", d.path);
      var cols = make("colgroup");
      (mode === "inline" ? ["lc-c-ln", "lc-c-ln", "lc-c-mid", "lc-c-sign", "lc-c-code"] :
        ["lc-c-ln", "lc-c-code", "lc-c-mid", "lc-c-ln", "lc-c-code"])
        .forEach(function (c) { cols.appendChild(make("col", c)); });
      table.appendChild(cols);
      // Each change block is a separate tbody: hovering over it highlights the block buttons.
      var tb = null;
      lay.lines.forEach(function (line, n) {
        if (!tb || line.blk !== lay.lines[n - 1].blk) tb = table.appendChild(make("tbody", line.blk >= 0 ? "lc-blk" : ""));
        tb.appendChild(lineEl(d, lay, line, n));
        (at[n] || []).forEach(function (t) { tb.appendChild(extraRow(cardEl(t))); });
        if (n === draftAt) tb.appendChild(extraRow(draftEl()));
      });
      body.appendChild(table);
      if (draft && draft.file === d.path && draftAt < 0) body.appendChild(draftEl());
      return body;
    }

    // A file in the diff feed: a header with the collapse arrow, file buttons
    // and the "Viewed" mark, under it — the diff, if the file is not
    // collapsed. A viewed file is collapsed.
    function fileEl(d) {
      var fold = isFolded(d), seen = isReviewed(d);
      var f = (repo.files || []).find(function (x) { return x.path === d.path; });
      var sec = make("section", "lc-dfile" + (seen ? " lc-seen" : ""));
      sec.setAttribute("data-path", d.path);
      var head = make("div", "lc-dfile-head");
      head.setAttribute("data-act", "fold-file");
      head.setAttribute("data-key", "file:" + keyOf(d.path));
      head.appendChild(make("span", "lc-tog", fold ? "▸" : "▾"));
      if (f) {
        var l = letter(f, staged);
        head.appendChild(make("span", "lc-fst lc-fst-" + l, l));
      }
      head.appendChild(make("span", "lc-dpath", d.path));
      var open = openTopics(d.path);
      if (open) head.appendChild(make("span", "lc-fq", String(open)));
      if (reviewed[keyOf(d.path)] && !seen) head.appendChild(make("span", "lc-hint", "changed after viewing"));
      if (fold && !seen && d.rows.length > BIG) head.appendChild(make("span", "lc-hint", "large diff: " + d.rows.length + " lines"));
      var acts = make("span", "lc-dfile-acts");
      fileBtns(acts, staged);
      var rv = lc.button(seen ? "☑ Viewed" : "☐ Viewed", "review-file", "lc-small lc-reviewbtn" + (seen ? " lc-on" : ""));
      rv.title = seen ? "Clear the mark: the file expands" : "Mark as viewed: the file collapses";
      acts.appendChild(rv);
      head.appendChild(acts);
      sec.appendChild(head);
      if (!fold) sec.appendChild(diffBody(d));
      return sec;
    }

    function toolbarEl() {
      var tb = make("div", "lc-dtoolbar");
      var fl = lc.button("☰ Files", "files", "lc-small");
      fl.title = "File list of both groups with search — Ctrl+P";
      tb.appendChild(fl);
      var seg = make("span", "lc-seg");
      groups().forEach(function (g) {
        var b = lc.button(g.title + " · " + g.files.length, "diff-side", "lc-small" + (g.staged === staged ? " lc-on" : ""));
        b.setAttribute("data-side", g.staged ? "1" : "0");
        seg.appendChild(b);
      });
      tb.appendChild(seg);
      if (files && files.length) {
        var done = files.filter(isReviewed).length;
        tb.appendChild(make("span", "lc-hint", "Viewed: " + done + " of " + files.length));
      }
      var right = make("span", "lc-dtoolbar-right");
      var ms = make("span", "lc-seg");
      [["split", "Side by side"], ["inline", "Inline"]].forEach(function (m) {
        var b = lc.button(m[1], "diff-mode", "lc-small" + (mode === m[0] ? " lc-on" : ""));
        b.setAttribute("data-mode", m[0]);
        ms.appendChild(b);
      });
      right.appendChild(ms);
      right.appendChild(lc.button("Refresh", "diff-refresh", "lc-small"));
      tb.appendChild(right);
      return tb;
    }

    function el() {
      if (error && !repo) return make("p", "lc-hint", "Could not read the changes: " + error);
      if (!repo) return make("p", "lc-hint", "Loading changes…");
      var wrap = make("div", "lc-diff");
      wrap.appendChild(toolbarEl());
      if (error) wrap.appendChild(make("p", "lc-hint lc-err", error));
      lays = {};
      if (!files) wrap.appendChild(make("p", "lc-hint", "Loading diffs…"));
      else if (!files.length)
        wrap.appendChild(make("p", "lc-hint", staged ? "No staged changes." :
          "No changes: the working tree matches the index."));
      else files.forEach(function (d) { wrap.appendChild(fileEl(d)); });
      return wrap;
    }

    // After rendering: the open file list with the new data, focus in the new
    // question field, scrolling to the file or topic from the link, the
    // position of the bar above selected lines.
    function after() {
      if (listOpen) renderList(false);
      if (focusDraft) {
        var ta = lc.app.querySelector('textarea[data-key="diffnew"]');
        if (ta) {
          ta.focus();
          focusDraft = false;
        }
      }
      if (focusFile && files) {
        var sec = lc.app.querySelector('.lc-dfile[data-path="' + CSS.escape(focusFile) + '"]');
        if (sec) sec.scrollIntoView({ block: "start" });
        focusFile = null;
      }
      if (focusTopic && files && lc.topics().length) {
        var card = lc.app.querySelector('.lc-dcard[data-tid="' + focusTopic + '"]');
        var t = lc.topics().find(function (x) { return x.id === focusTopic; });
        var key = t && t.anchor && t.anchor.file && keyOf(t.anchor.file);
        if (card) {
          card.scrollIntoView({ block: "center" });
          focusTopic = null;
        } else if (key && fileOf(t.anchor.file) && folded[key] !== false) {
          // The topic is in a collapsed file: the file expands, scrolling happens after rendering.
          folded[key] = false;
          setTimeout(lc.render);
        } else {
          focusTopic = null;
        }
      }
      if (bar && !bar.hidden) showBar();
    }

    // ---- actions

    function git(op, body) {
      clearSelection();
      return lc.request(lc.API + "/git/" + op, body).then(refresh, function (e) {
        lc.failed(e);
        return refresh();
      });
    }

    // Switches the page to group side and, if path is given, to its file.
    function showSide(side, path) {
      if (path) {
        folded[keyOf(path, side)] = false;
        focusFile = path;
      }
      if (side === staged) {
        lc.render();
        return;
      }
      staged = side;
      files = null;
      lastLine = null;
      clearSelection();
      syncUrl();
      lc.render();
      refresh();
    }

    function act(name, node, e) {
      var holder = node.closest("[data-path]");
      var path = holder ? holder.getAttribute("data-path") : null;
      var d = path ? fileOf(path) : null;
      var blk = node.getAttribute("data-blk");
      switch (name) {
        case "files":
          setList(!listOpen);
          break;
        case "goto-file":
          gotoFile(node.getAttribute("data-staged") === "1", path);
          break;
        case "tree-dir":
          toggleDir(node.getAttribute("data-key"));
          break;
        case "diff-side":
          showSide(node.getAttribute("data-side") === "1");
          break;
        case "diff-refresh":
          shown = "";
          refresh();
          break;
        case "diff-mode":
          mode = node.getAttribute("data-mode");
          save(MODE_KEY, mode);
          clearSelection();
          lastLine = null;
          lc.render();
          break;
        case "fold-file":
          folded[keyOf(path)] = !isFolded(d);
          clearSelection();
          lc.render();
          break;
        case "review-file":
          if (isReviewed(d)) {
            delete reviewed[keyOf(path)];
            folded[keyOf(path)] = false;
          } else {
            reviewed[keyOf(path)] = d.hash;
            folded[keyOf(path)] = true;
          }
          save(REVIEW_KEY, reviewed);
          lc.render();
          break;
        case "stage-file":
          git("stage", { path: path });
          break;
        case "unstage-file":
          git("unstage", { path: path });
          break;
        case "discard-file":
          var st = holder.querySelector(".lc-fst");
          if (!window.confirm(st && st.textContent === "U"
            ? "Delete the new file " + path + "? It is not in git: it cannot be restored."
            : "Discard the changes of file " + path + "? The working tree returns to the index version; the edits cannot be restored.")) return;
          git("discard", { path: path });
          break;
        case "stage-all":
          git("stage", {});
          break;
        case "unstage-all":
          git("unstage", {});
          break;
        case "stage-block":
        case "unstage-block":
          git(name === "stage-block" ? "stage" : "unstage", { path: path, rows: lays[path].blocks[+blk], hash: d.hash });
          break;
        case "revert-block":
          if (!window.confirm("Discard the block in the working tree? Its lines return to the index version; the discarded edits cannot be restored.")) return;
          git("revert", { path: path, rows: lays[path].blocks[+blk], hash: d.hash });
          break;
        case "stage-rows":
        case "unstage-rows":
          if (!pick) return;
          git(name === "stage-rows" ? "stage" : "unstage",
            { path: pick.path, rows: changed(fileOf(pick.path), pick.idx), hash: pick.hash });
          break;
        case "pick-line":
          var n = +node.closest("tr").getAttribute("data-line");
          var from = e && e.shiftKey && lastLine && lastLine.path === path ? lastLine.n : n;
          selectLines(path, from, n);
          if (!(e && e.shiftKey)) lastLine = { path: path, n: n };
          showBar();
          break;
        case "comment-rows":
          if (!pick) return;
          draft = anchorOf(fileOf(pick.path), pick.idx);
          // The question draft moves to the new lines.
          var old = lc.draft("diffnew");
          if (old) lc.setDraft("diffnew", old.text);
          focusDraft = true;
          clearSelection();
          lc.render();
          break;
        case "diff-cancel":
          draft = null;
          lc.setDraft("diffnew", "");
          lc.render();
          break;
        case "diff-ask":
          var ta = lc.app.querySelector('textarea[data-key="diffnew"]');
          var text = ta ? ta.value.trim() : "";
          if (!text || !draft) return;
          var anchor = draft;
          draft = null;
          ta.value = "";
          lc.setDraft("diffnew", "");
          lc.post("/topics", { text: text, anchor: anchor }).then(function () {
            lc.toast("Question sent to Claude");
          }, function (err) {
            // An unsent question returns to the field from the draft.
            draft = anchor;
            lc.setDraft("diffnew", text);
            lc.render();
            lc.failed(err);
          });
          lc.render();
          break;
        case "card-toggle":
          var tid = node.closest("[data-tid]").getAttribute("data-tid");
          var t = lc.topics().find(function (x) { return x.id === tid; });
          cardOpen[tid] = !(cardOpen[tid] != null ? cardOpen[tid] : t && t.state === "open");
          lc.render();
          break;
      }
    }

    var selTimer = null;
    document.addEventListener("selectionchange", function () {
      clearTimeout(selTimer);
      selTimer = setTimeout(showBar, 120);
    });
    // Ctrl+P (⌘P), as in VS Code, opens and closes the file list, by the
    // physical key, so it works in any keyboard layout; Esc closes it.
    document.addEventListener("keydown", function (e) {
      if (e.code === "KeyP" && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        setList(!listOpen);
      } else if (e.key === "Escape" && listOpen) setList(false);
    });
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") refresh();
    });
    // Files change outside the page too: while the tab is visible, the changes are re-read.
    setInterval(function () {
      if (document.visibilityState === "visible") refresh();
    }, 4000);
    syncUrl();
    refresh();

    return { el: el, act: act, after: after, anchor: function () { return draft; } };
  };
})();
