#!/usr/bin/env node
// The status bar of the live-comments discussion pages.
//
// Reads the Claude Code status line JSON on stdin and prints the bar as JSON:
// {"items": [...]}, each item made of the standard blocks text, chip, meter,
// dot, link, countdown and age. The blocks and their options are described in
// protocol.md of the statusbar skill of the live-comments plugin.
//
// This is the default bar of the plugin in JavaScript, run with Node. Your
// copy is ~/.config/live-comments/statusbar.js: change it, or ask Claude to
// change it (/live-comments:statusbar), and check it with check.py of the
// same skill.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

// Rate limit windows of the input: the key, the short name and the name in the tooltip.
const LIMITS = [["five_hour", "5h", "5-hour"], ["seven_day", "7d", "7-day"], ["spend_limit", "spend", "Spend"]];

// The value at path in data, or undefined if a key on the way is absent.
function get(data, ...keys) {
  for (const key of keys) data = data && typeof data === "object" ? data[key] : undefined;
  return data;
}

// Tokens in short: 950, 85.7k, 1M.
function tokens(n) {
  for (const [size, unit] of [[1e6, "M"], [1e3, "k"]]) if (n >= size) return +(n / size).toFixed(1) + unit;
  return String(n);
}

// A duration of ms milliseconds in short: 3d 4h, 2h 13m, 42m, <1m.
function span(ms) {
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(m / 1440);
  if (d) return `${d}d ${h % 24}h`;
  if (h) return `${h}h ${m % 60}m`;
  return m ? `${m}m` : "<1m";
}

// The local time of epoch seconds t: the time for today, the date and time for other days.
function when(t) {
  const d = new Date(t * 1000);
  const hm = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? hm :
    d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" }) + " " + hm;
}

// An item of the bar made of blocks; empty blocks (null, false, "") are left out.
function item(blocks, title, fill) {
  const it = { blocks: blocks.filter(Boolean) };
  if (title) it.title = title;
  if (fill) it.fill = true;
  return it;
}

// The model, its reasoning effort and fast mode.
function model(d) {
  const name = get(d, "model", "display_name") || get(d, "model", "id");
  if (!name) return null;
  const version = get(d, "version"), effort = get(d, "effort", "level");
  return item([
    { text: name, style: "strong" },
    effort && { chip: effort },
    get(d, "fast_mode") && { chip: "fast" },
  ], (get(d, "model", "id") || name) + (version ? ` · Claude Code ${version}` : ""));
}

// Input tokens in the context window: a meter, yellow from 60%, red from 85%.
function context(d) {
  const used = get(d, "context_window", "total_input_tokens");
  if (!used) return null;
  const size = get(d, "context_window", "context_window_size");
  let pct = get(d, "context_window", "used_percentage");
  if (pct == null && size) pct = used / size * 100;
  return item([
    { text: "Context" },
    pct != null && { meter: pct, warn: 60, bad: 85 },
    { text: tokens(used) + (size ? ` / ${tokens(size)}` : ""), style: "muted" },
  ], `Context window: ${used.toLocaleString("en-US")}` + (size ? ` of ${size.toLocaleString("en-US")}` : "") + " tokens");
}

// The rate limit windows: a meter, yellow from 70%, red from 90%, and the time until the reset.
// Without the status line the server requests them by itself; the tooltip says when.
function limits(d) {
  const checked = get(d, "live_comments", "limits_at");
  return LIMITS.filter(([key]) => get(d, "rate_limits", key, "used_percentage") != null).map(([key, short, name]) => {
    const pct = get(d, "rate_limits", key, "used_percentage"), resets = get(d, "rate_limits", key, "resets_at");
    return item([
      { text: short },
      { meter: pct, warn: 70, bad: 90 },
      resets && { countdown: resets, prefix: "↻ ", done: "reset" },
    ], `${name} limit: ${pct.toFixed(1)}% used` + (resets ? `, resets ${when(resets)}` : "") +
      (checked ? `, checked at ${when(checked)}` : ""));
  });
}

// The prompt cache: warm or cold, the hit ratio and the time until it goes cold.
function cache(d) {
  const c = get(d, "prompt_cache");
  if (!c || typeof c !== "object") return null;
  const warm = !!c.warm, hit = c.hit_ratio, expires = c.expires_at;
  const ratio = hit != null ? Math.round(hit * 100) + "%" : null;
  return item([
    { dot: warm ? "good" : "muted" },
    { text: "Cache" },
    ratio && { text: ratio, style: "strong" },
    warm && expires ? { countdown: expires, done: "cold" } : !warm && { text: "cold", style: "muted" },
  ], "Prompt cache " + (warm ? "warm" : "cold") + (c.ttl ? `, TTL ${c.ttl}` : "") +
    (ratio ? `, hit ratio ${ratio}` : "") + (warm && expires ? `, goes cold at ${when(expires)}` : ""));
}

// The session cost; the session time and the time of waiting for the API are in the tooltip.
function cost(d) {
  const usd = get(d, "cost", "total_cost_usd");
  if (usd == null) return null;
  const dur = get(d, "cost", "total_duration_ms"), api = get(d, "cost", "total_api_duration_ms");
  return item([{ text: `$${usd.toFixed(2)}`, style: "strong" }],
    "Session cost at list price" + (dur ? ` · session time ${span(dur)}` : "") +
    (api ? ` · waiting for the API ${span(api)}` : ""));
}

// Lines of code added and removed in the session.
function lines(d) {
  const added = get(d, "cost", "total_lines_added") || 0, removed = get(d, "cost", "total_lines_removed") || 0;
  if (!added && !removed) return null;
  return item([{ text: `+${added}`, style: "good" }, { text: `−${removed}`, style: "bad" }],
    "Lines of code changed in the session");
}

// The open pull request; its review state is in the tooltip.
function pullRequest(d) {
  const pr = get(d, "pr");
  if (!pr || !pr.number) return null;
  const state = (pr.review_state || "").replace(/_/g, " ");
  return item([{ link: `PR #${pr.number}`, href: pr.url || "" }], "Open pull request" + (state ? `: ${state}` : ""));
}

// The repository, and without it the working directory: the item takes the
// free space of the line, is cut first and pushes the next items to the right.
function place(d) {
  let cwd = get(d, "workspace", "current_dir") || get(d, "cwd") || "";
  const home = os.homedir();
  if (cwd === home || cwd.startsWith(home + path.sep)) cwd = "~" + cwd.slice(home.length);
  const repo = get(d, "workspace", "repo") || {};
  let block;
  if (repo.owner && repo.name) {
    const name = `${repo.owner}/${repo.name}`;
    block = { link: name, href: repo.host ? `https://${repo.host}/${name}` : "", style: "mono" };
  } else {
    block = { text: cwd, style: "mono" };
  }
  return item([block], cwd ? `Working directory: ${cwd}` : null, true);
}

// How long ago the bar changed; the tooltip says where the data come from — the status
// line or the session transcript — and when they changed.
function age(d) {
  const source = get(d, "live_comments", "source") === "transcript" ? "the session transcript" : "the status line";
  const at = get(d, "live_comments", "at");
  return item([{ age: true }], `Data from ${source}` + (at ? `, changed at ${when(at)}` : ""));
}

// The bar for the status line JSON d: the items from left to right.
function bar(d) {
  const items = [model(d), context(d), ...limits(d), cache(d), cost(d), lines(d), pullRequest(d), place(d), age(d)];
  return { items: items.filter(Boolean) };
}

process.stdout.write(JSON.stringify(bar(JSON.parse(fs.readFileSync(0, "utf8")))) + "\n");
