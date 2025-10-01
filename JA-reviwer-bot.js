#!/usr/bin/env node
// Minimal URL fetch tool for Gemini function-calling
// One file, production-friendly basics: readability extraction, caching, auth, robust errors.

import express from "express";
import fetch from "node-fetch";
import { JSDOM } from "jsdom";
import { Readability } from "readability-node";

const PORT = process.env.PORT || 8080;
const API_TOKEN = process.env.API_TOKEN || "";        // Optional: require Authorization: Bearer <API_TOKEN>
const MAX_CHARS = Number(process.env.MAX_CHARS || 200000);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 5 * 60 * 1000); // 5 minutes
const USER_AGENT = process.env.USER_AGENT || "JP-Tone-Checker/1.0 (+https://example.com)";

// ---- tiny in-memory cache (LRU-ish) ----
const cache = new Map();
/** @param {string} key @param {any} val @param {number} ttlMs */
function setCache(key, val, ttlMs = CACHE_TTL_MS) {
  const now = Date.now();
  cache.set(key, { val, exp: now + ttlMs });
  // prevent unbounded growth
  if (cache.size > 500) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
}
function getCache(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.exp) {
    cache.delete(key);
    return null;
  }
  return hit.val;
}

// ---- helpers ----
function cleanText(s) {
  if (!s) return "";
  return s
    .replace(/\r/g, "")
    .replace(/\t/g, " ")
    .replace(/\u00a0/g, " ")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_CHARS);
}

function extractWithReadability(dom) {
  const reader = new Readability(dom.window.document);
  const article = reader.parse();
  return {
    text: article?.textContent || "",
    title: article?.title || dom.window.document.title || null
  };
}

function extractBySelector(dom, selector) {
  const node = dom.window.document.querySelector(selector);
  if (!node) return "";
  return node.textContent || "";
}

function removeBoilerplate(dom) {
  const doc = dom.window.document;
  ["script","style","noscript","iframe"].forEach(sel => {
    doc.querySelectorAll(sel).forEach(n => n.remove());
  });
  return dom;
}

// ---- server ----
const app = express();
app.use(express.json({ limit: "1mb" }));

// Optional: simple auth
app.use((req, res, next) => {
  if (!API_TOKEN) return next();
  const auth = req.headers.authorization || "";
  if (auth === `Bearer ${API_TOKEN}`) return next();
  return res.status(401).json({ ok: false, error: "unauthorized" });
});

/**
 * POST /tool/fetch_url
 * body: { url: string, selector?: string }
 * - url: required
 * - selector: optional CSS selector to target main content if you know it
 */
app.post("/tool/fetch_url", async (req, res) => {
  try {
    const { url, selector } = req.body || {};
    if (!url || typeof url !== "string") {
      return res.status(400).json({ ok: false, error: "missing_or_invalid_url" });
    }
    const cacheKey = JSON.stringify([url, selector || ""]);
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    const resp = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT, "Accept": "text/html,*/*;q=0.9" },
      // NOTE: if you need proxy or special TLS, configure here
    }).catch(e => ({ ok: false, status: 0, error: e }));

    if (!resp || !resp.ok) {
      const code = resp?.status || 502;
      const msg = resp?.status ? `http_status_${resp.status}` : `request_error:${resp?.error?.message || "fetch_failed"}`;
      const out = { ok: false, error: msg };
      setCache(cacheKey, out, 15_000);
      return res.status(code).json(out);
    }

    const ctype = resp.headers.get("content-type") || "";
    if (!ctype.includes("text/html")) {
      const out = { ok: false, error: `unsupported_content_type:${ctype}` };
      setCache(cacheKey, out, 60_000);
      return res.status(415).json(out);
    }

    const html = await resp.text();
    const dom = new JSDOM(html, { url });
    const lang = dom.window.document.documentElement.getAttribute("lang") || null;

    removeBoilerplate(dom);

    let text = "";
    let meta_title = null;

    if (selector && typeof selector === "string") {
      text = extractBySelector(dom, selector);
      meta_title = dom.window.document.title || null;
    }

    if (!text || text.trim().length < 40) {
      const art = extractWithReadability(dom);
      meta_title = meta_title || art.title || null;
      text = art.text || dom.window.document.body.textContent || "";
    }

    text = cleanText(text);
    if (!text || text.length < 40) {
      const out = { ok: false, error: "no_readable_text_extracted" };
      setCache(cacheKey, out, 60_000);
      return res.status(422).json(out);
    }

    const out = {
      ok: true,
      url,
      meta_title: meta_title || null,
      lang,
      char_count: text.length,
      word_count: text.split(/\s+/).filter(Boolean).length,
      text
    };
    setCache(cacheKey, out);
    return res.json(out);
  } catch (e) {
    return res.status(500).json({ ok: false, error: `server_error:${e.message}` });
  }
});

app.get("/healthz", (_, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`URL fetch tool running: http://localhost:${PORT}`);
  if (API_TOKEN) console.log("Auth: Bearer token required");
});
