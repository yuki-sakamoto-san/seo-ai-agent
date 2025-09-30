// File: headings_scraper_single_location_v6.js
// Single-location SERP with SerpAPI parity + worldwide support + robust AIO + full headings.
// v6 (Docs-only): Deterministic feature statuses + auto-creates a Google Doc (no Google Sheets)

// Install: npm i playwright googleapis axios csv-writer

const fs = require('fs');
const axios = require('axios');
const { chromium } = require('playwright');
const { google } = require('googleapis');
const { createObjectCsvWriter } = require('csv-writer'); // only for optional local CSV debug

/** ====================== COUNTRY PRESETS ====================== **/
const PRESETS = {
  "Australia":   { google_domain: "google.com.au", gl: "au", hl: "en" },
  "New Zealand": { google_domain: "google.co.nz", gl: "nz", hl: "en" },
  "Singapore":   { google_domain: "google.com.sg", gl: "sg", hl: "en" },
  "Malaysia":    { google_domain: "google.com.my", gl: "my", hl: "en" },
  "India":       { google_domain: "google.co.in", gl: "in", hl: "en" },
  "Japan":       { google_domain: "google.co.jp", gl: "jp", hl: "ja" },
  "France":      { google_domain: "google.fr",    gl: "fr", hl: "fr" },
  "Germany":     { google_domain: "google.de",    gl: "de", hl: "de" },
  "United Kingdom": { google_domain: "google.co.uk", gl: "gb", hl: "en" },
  "United States":  { google_domain: "google.com",   gl: "us", hl: "en" },
  "Canada":         { google_domain: "google.ca",    gl: "ca", hl: "en" },
  "Ireland":        { google_domain: "google.ie",    gl: "ie", hl: "en" },
  "Spain":          { google_domain: "google.es",    gl: "es", hl: "es" },
  "Italy":          { google_domain: "google.it",    gl: "it", hl: "it" },
  "Netherlands":    { google_domain: "google.nl",    gl: "nl", hl: "nl" },
  "Sweden":         { google_domain: "google.se",    gl: "se", hl: "sv" },
  "Norway":         { google_domain: "google.no",    gl: "no", hl: "no" },
  "Denmark":        { google_domain: "google.dk",    gl: "dk", hl: "da" },
  "Finland":        { google_domain: "google.fi",    gl: "fi", hl: "fi" },
  "Austria":        { google_domain: "google.at",    gl: "at", hl: "de" },
  "Switzerland":    { google_domain: "google.ch",    gl: "ch", hl: "de" },
  "Belgium":        { google_domain: "google.be",    gl: "be", hl: "fr" },
  "United Arab Emirates": { google_domain: "google.ae",   gl: "ae", hl: "en" }, // or hl: "ar"
  "Israel":               { google_domain: "google.co.il", gl: "il", hl: "he" },
  "Türkiye":              { google_domain: "google.com.tr", gl: "tr", hl: "tr" },
  "Mexico":               { google_domain: "google.com.mx", gl: "mx", hl: "es" }
};

/** ====================== CLI ====================== **/
function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (const a of args) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  if (!out.query) throw new Error('Missing --query');
  if (out.country && PRESETS[out.country]) {
    const p = PRESETS[out.country];
    out.google_domain = out.google_domain || p.google_domain;
    out.gl = out.gl || p.gl;
    out.hl = out.hl || p.hl;
  }
  if (!out.location) throw new Error('Missing --location (e.g., "Australia", "Japan", or a city string)");
  out.google_domain = out.google_domain || 'google.com';
  out.gl = out.gl || 'us';
  out.hl = out.hl || 'en';
  if (!out.apiKey) throw new Error('Missing --apiKey');
  out.num = Math.min(100, parseInt(out.num || '10', 10));
  out.safe = out.safe || 'off';
  out.lr = out.lr || '';
  out.maxUnique = parseInt(out.maxUnique || String(out.num), 10);
  out.verifySerpWithPlaywright = String(out.verifySerpWithPlaywright || 'false').toLowerCase() === 'true';
  out.aioProbeAlways = String(out.aioProbeAlways || 'false').toLowerCase() === 'true';
  out.aioProbeHlFallback = out.aioProbeHlFallback || 'en';
  out.includeHidden = String(out.includeHidden || 'true').toLowerCase() === 'true';
  out.headingLike = String(out.headingLike || 'true').toLowerCase() === 'true';
  out.respectNoindex = String(out.respectNoindex || 'false').toLowerCase() === 'true';
  out.extraWaitMs = parseInt(out.extraWaitMs || '2000', 10);
  out.scrollSteps = parseInt(out.scrollSteps || '16', 10);
  out.scrollStepPx = parseInt(out.scrollStepPx || '950', 10);
  out.retryIfFewHeadings = parseInt(out.retryIfFewHeadings || '2', 10);

  // Deterministic feature status mode + policy toggle
  out.featureMode = (out.featureMode || 'hybrid').toLowerCase(); // hybrid | api | html
  out.signalsAsConfirmed = String(out.signalsAsConfirmed || 'false').toLowerCase() === 'true';

  // Google Docs auth & placement
  out.serviceAccountKey = out.serviceAccountKey || process.env.SERVICE_ACCOUNT_KEY; // path to JSON file
  out.folderId = out.folderId || ''; // optional; default = My Drive
  const today = new Date().toISOString().slice(0,10);
  out.docTitle = out.docTitle || `SEO Content Brief – ${out.query} – ${out.country || out.gl} – ${today}`;

  // Optional local debug artifacts
  out.writeCsvLocal = String(out.writeCsvLocal || 'false').toLowerCase() === 'true';

  return out;
}

/** ====================== Helpers ====================== **/
function hasAioInSerpapiData(d) {
  if (!d || typeof d !== 'object') return false;
  if (d.ai_overview && Object.keys(d.ai_overview).length) return true;
  if (d.ai_overview_results && Object.keys(d.ai_overview_results).length) return true;
  if (d.search_information && (d.search_information.ai_overview || d.search_information.ai_overview_is_available)) return true;
  if (d.knowledge_graph && d.knowledge_graph.ai_overview) return true;
  return false;
}

const AIO_TEXT_PATTERNS = [
  /ai overview/i, /overview from ai/i, /generated by ai/i,
  /aperçu (?:par|de) l['’]ia/i, /généré par l['’]ia/i, /vue d['’]ensemble de l['’]ia/i,
  /ki[- ]?(?:übersicht|überblick)/i, /durch ki erstellt/i, /von ki generiert/i,
  /ai[ 　]?概要/i, /ai[ 　]?による概要/i, /ai[ 　]?によって生成/i,
  /resumen de ia/i, /descripción general de ia/i, /generado por ia/i,
  /panoramica (?:ia|dell['’]ia)/i, /generat[ao] dall['’]ia/i,
  /ai[- ]?overzicht/i, /gegenereerd door ai/i
];

/** ====================== Deterministic Feature Status ====================== **/
const FeatureStatus = Object.freeze({
  CONFIRMED: 'Confirmed',
  PROBABLE: 'Probable',
  ABSENT: 'Not detected'
});

const FeatureConfidence = Object.freeze({
  [FeatureStatus.CONFIRMED]: 1.0,
  [FeatureStatus.PROBABLE]: 0.6,
  [FeatureStatus.ABSENT]: 0.0
});

function combineFeatureStatus({ mode, api=false, html=false, htmlSignals={}, signalsAsConfirmed=false }) {
  if (mode === 'api')  return api  ? FeatureStatus.CONFIRMED : FeatureStatus.ABSENT;
  if (mode === 'html') return html ? FeatureStatus.CONFIRMED : FeatureStatus.ABSENT;
  if (api || html) return FeatureStatus.CONFIRMED;
  const hasSignals = !!(htmlSignals && (htmlSignals.AIOverviewLabel || htmlSignals.AIOverviewText || htmlSignals.genAiNetworkSeen));
  if (signalsAsConfirmed && hasSignals) return FeatureStatus.CONFIRMED;
  return hasSignals ? FeatureStatus.PROBABLE : FeatureStatus.ABSENT;
}

/** ====================== SerpAPI ====================== **/
async function serpapiSingle({ query, location, google_domain, gl, hl, apiKey, num, safe, lr, aioProbeAlways, aioProbeHlFallback }) {
  const params = {
    engine: 'google',
    q: query,
    location,
    google_domain,
    gl,
    hl,
    num,
    device: 'desktop',
    safe,
    no_cache: true,
    api_key: apiKey
  };
  if (lr) params.lr = lr;
  const { data } = await axios.get('https://serpapi.com/search.json', { params, timeout: 60000 });
  const urls = (data.organic_results || []).map(r => r.link).filter(Boolean);
  const features = {
    FeaturedSnippet: !!(data.answer_box || data.featured_snippet),
    KnowledgePanel: !!data.knowledge_graph,
    PeopleAlsoAsk: !!(data.related_questions || data.people_also_ask),
    ImagePack: !!data.inline_images,
    Video: !!(data.inline_videos || data.video_results),
    AIOverview: hasAioInSerpapiData(data)
  };
  let aioProbeUsed = false;
  if (!features.AIOverview && (aioProbeAlways || hl.toLowerCase() !== 'en')) {
    const probeParams = {
      engine: 'google_ai_overview',
      q: query,
      location,
      google_domain,
      gl,
      hl: (hl.toLowerCase() === 'en' ? 'en' : aioProbeHlFallback),
      api_key: apiKey
    };
    try {
      const { data: aio } = await axios.get('https://serpapi.com/search.json', { params: probeParams, timeout: 45000 });
      if (aio && aio.ai_overview && Object.keys(aio.ai_overview).length) features.AIOverview = true;
      aioProbeUsed = true;
    } catch {}
  }
  const google_url = data?.search_metadata?.google_url || null;
  return { urls, features, raw: data, google_url, aioProbeUsed };
}

/** ====================== HTML verify (optional) ====================== **/
async function verifyOnHtml({ query, google_url, google_domain, gl, hl, extraWaitMs }) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: hl,
    extraHTTPHeaders: { 'Accept-Language': hl },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();
  const url = google_url || `https://www.${google_domain}/search?q=${encodeURIComponent(query)}&hl=${encodeURIComponent(hl)}&gl=${gl}&num=10&pws=0`;
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  try {
    const consent = page.locator('button:has-text("I agree"), button:has-text("Accept all"), button:has-text("Accept")').first();
    if (await consent.isVisible({ timeout: 2000 })) await consent.click();
  } catch {}

  let genAiNetworkSeen = false;
  page.on('request', req => {
    const u = req.url();
    if (/genai|searchgenai|unified_qa|\/_\/SearchGenAI|_batchexecute/i.test(u) && /google\./i.test(u)) genAiNetworkSeen = true;
  });

  await page.evaluate(async () => {
    await new Promise(res => {
      let y = 0, dir = 1, steps = 0;
      const step = () => {
        window.scrollBy(0, 700 * dir);
        y += 700 * dir;
        steps++;
        if (y > 2800) dir = -1;
        if (steps < 14) setTimeout(step, 160);
        else res();
      };
      step();
    });
  });
  if (extraWaitMs) await page.waitForTimeout(parseInt(extraWaitMs,10));

  const features = await page.evaluate((AIO_RX_SRC) => {
    const AIO_RX = AIO_RX_SRC.map(s => new RegExp(s.source, s.flags));
    const textHasAio = () => {
      const t = (document.body.innerText || '').toLowerCase();
      return AIO_RX.some(r => r.test(t));
    };
    return {
      FeaturedSnippet: !!document.querySelector('[data-attrid="wa:/description"], [data-attrid="kc:/webanswers:wa"]'),
      KnowledgePanel: !!document.querySelector('#kp-wp-tab-overview, [data-attrid="title"]'),
      PeopleAlsoAsk: !!document.querySelector('div[aria-label*="People also ask"], div[jsname="Cpkphb"]'),
      Video: !!document.querySelector('g-scrolling-carousel a[href*="youtube.com"], a[href*="watch?v="]'),
      ImagePack: !!document.querySelector('g-scrolling-carousel img, div[data-hveid][data-ved] img'),
      AIOverviewLabel: !!document.querySelector('div[aria-label*="AI Overview" i], div[aria-label*="Overview from AI" i]'),
      AIOverviewText: textHasAio()
    };
  }, AIO_TEXT_PATTERNS);

  const out = {
    FeaturedSnippet: features.FeaturedSnippet,
    KnowledgePanel: features.KnowledgePanel,
    PeopleAlsoAsk: features.PeopleAlsoAsk,
    Video: features.Video,
    ImagePack: features.ImagePack,
    AIOverview: features.AIOverviewLabel || features.AIOverviewText || genAiNetworkSeen,
    Signals: { AIOverviewLabel: features.AIOverviewLabel, AIOverviewText: features.AIOverviewText, genAiNetworkSeen }
  };
  await context.close();
  await browser.close();
  return { url, features: out };
}

/** ====================== Headings extraction ====================== **/
async function extractHeadingsInFrame(frame, opts) {
  return await frame.evaluate(({ includeHidden, headingLike }) => {
    function normalize(t){ return (t || '').replace(/\s+/g,' ').trim(); }
    function visible(el) {
      if (includeHidden) return true;
      const cs = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
    }
    function* deepRoots(root = document) {
      yield root;
      const walker = document.createNodeIterator(root, NodeFilter.SHOW_ELEMENT);
      let node;
      while ((node = walker.nextNode())) {
        if (node.shadowRoot && node.shadowRoot.mode === 'open') yield* deepRoots(node.shadowRoot);
      }
    }
    const out = { h1:[], h2:[], h3:[], h4:[], h5:[], h6:[] };
    const seen = new Set();
    const push = (key, el) => {
      if (!visible(el)) return;
      const text = normalize(el.innerText || el.textContent);
      if (!text) return;
      const sig = key + '|' + text;
      if (seen.has(sig)) return;
      seen.add(sig);
      out[key].push(text);
    };
    for (const root of deepRoots()) ['h1','h2','h3','h4','h5','h6'].forEach(tag => root.querySelectorAll(tag).forEach(el => push(tag, el)));
    for (const root of deepRoots()) root.querySelectorAll('[role="heading"]').forEach(el => {
      let lv = parseInt(el.getAttribute('aria-level'),10);
      if (!Number.isFinite(lv) || lv < 1 || lv > 6) lv = 2;
      push(`h${lv}`, el);
    });
    if (headingLike) {
      for (const root of deepRoots()) {
        const walker = document.createNodeIterator(root, NodeFilter.SHOW_ELEMENT);
        let node;
        while ((node = walker.nextNode())) {
          const el = node;
          if (['H1','H2','H3','H4','H5','H6'].includes(el.tagName)) continue;
          const cs = getComputedStyle(el);
          const fwRaw = cs.getPropertyValue('font-weight');
          const fw = parseInt(fwRaw,10);
          const heavy = Number.isFinite(fw) ? fw >= 600 : /bold|bolder/i.test(fwRaw);
          const size = parseFloat(cs.getPropertyValue('font-size')) || 0;
          const idc = (el.id + ' ' + el.className).toLowerCase();
          const semantic = /title|heading|headline|section-title/.test(idc);
          if (!(heavy && size >= 18) && !semantic) continue;
          let lv = 5;
          if (size >= 30) lv = 1;
          else if (size >= 24) lv = 2;
          else if (size >= 20) lv = 3;
          else if (size >= 18) lv = 4;
          push(`h${lv}`, el);
        }
      }
    }
    return out;
  }, opts);
}

function mergeHeadings(a, b) {
  const out = { h1:[], h2:[], h3:[], h4:[], h5:[], h6:[] };
  for (const k of Object.keys(out)) out[k] = [...(a[k]||[]), ...(b[k]||[])];
  return out;
}

async function renderAndExtract(url, hl, opts) {
  const { extraWaitMs, scrollSteps, scrollStepPx, includeHidden, headingLike, respectNoindex, retryIfFewHeadings } = opts;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: hl,
    extraHTTPHeaders: { 'Accept-Language': hl, Referer: 'https://www.google.com/' },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();
  await page.route('**/*', route => {
    const headers = { ...route.request().headers(), Referer: 'https://www.google.com/', 'Accept-Language': hl };
    route.continue({ headers });
  });
  let ok = false;
  try {
    const resp = await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    const status = resp ? resp.status() : 0;
    if (status && status < 400) ok = true;
  } catch {}
  if (!ok) { await context.close(); await browser.close(); return null; }

  if (respectNoindex) {
    const robots = await page.locator('meta[content*="noindex" i]').first();
    if (await robots.count()) { await context.close(); await browser.close(); return null; }
  }

  await page.waitForLoadState('networkidle', { timeout: 20000 });
  await page.evaluate(async ({ scrollSteps, scrollStepPx }) => {
    await new Promise(res => {
      let steps = 0;
      const step = () => {
        window.scrollBy(0, scrollStepPx);
        steps++;
        if (steps < scrollSteps) setTimeout(step, 110);
        else res();
      };
      step();
    });
  }, { scrollSteps, scrollStepPx });
  if (extraWaitMs) await page.waitForTimeout(extraWaitMs);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));

  const frames = page.frames();
  let merged = { h1:[], h2:[], h3:[], h4:[], h5:[], h6:[] };
  for (const f of frames) {
    try {
      const sameOrigin = await f.evaluate(() => true);
      if (!sameOrigin) continue;
      const h = await extractHeadingsInFrame(f, { includeHidden, headingLike });
      merged = mergeHeadings(merged, h);
    } catch {}
  }

  const total = merged.h1.length + merged.h2.length + merged.h3.length + merged.h4.length + merged.h5.length + merged.h6.length;
  if (total < retryIfFewHeadings) {
    await page.evaluate(async ({ scrollSteps, scrollStepPx }) => {
      await new Promise(res => {
        let steps = 0;
        const step = () => {
          window.scrollBy(0, scrollStepPx);
          steps++;
          if (steps < Math.max(10, Math.floor(scrollSteps * 1.2))) setTimeout(step, 140);
          else res();
        };
        step();
      });
    }, { scrollSteps, scrollStepPx });
    await page.waitForTimeout(extraWaitMs + 500);
    try {
      const h2 = await extractHeadingsInFrame(page.mainFrame(), { includeHidden, headingLike });
      merged = mergeHeadings(merged, h2);
    } catch {}
  }

  const meta = await page.evaluate(() => {
    const metaDesc = document.querySelector('meta[name="description"]');
    return { title: document.title || '', description: metaDesc?.getAttribute('content') || '' };
  });

  await context.close();
  await browser.close();
  return { url, meta, headings: merged };
}

/** ====================== Brief Composer ====================== **/
function uniqKeepOrder(arr) {
  const seen = new Set(); const out = [];
  for (const s of arr.map(x => (x||'').trim()).filter(Boolean)) if (!seen.has(s)) { seen.add(s); out.push(s); }
  return out;
}

function pickTopThemes(pages, limit=7) {
  // Simple scoring: H1 weight 3, H2 weight 2, H3 weight 1
  const score = new Map();
  for (const p of pages) {
    (p.headings.h1||[]).forEach(h=> score.set(h,(score.get(h)||0)+3));
    (p.headings.h2||[]).forEach(h=> score.set(h,(score.get(h)||0)+2));
    (p.headings.h3||[]).forEach(h=> score.set(h,(score.get(h)||0)+1));
  }
  return [...score.entries()].sort((a,b)=>b[1]-a[1]).slice(0,limit).map(([t])=>t);
}

function detectIntentFromThemes(themes) {
  const t = themes.join(' ').toLowerCase();
  if (/(buy|price|pricing|compare|best|software|solution|platform|vendor|quote|demo)/.test(t)) return 'Transactional';
  if (/(what|how|guide|meaning|definition|vs|types|examples|faq)/.test(t)) return 'Informational';
  if (/(login|portal|homepage|brand|official)/.test(t)) return 'Navigational';
  return 'Informational';

