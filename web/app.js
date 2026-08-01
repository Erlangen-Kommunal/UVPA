// UVPA Dokumentensuche — Frontend
// Kernaufgabe: Dokumente schnell finden (FTS/BM25 + Metadaten-Filter) und den
// extrahierten Volltext sofort im Browser anzeigen. Das Beziehungsnetzwerk
// (Cytoscape) ist die Kontext-Ansicht dazu. Bewusst ohne KI — nur SQL.
//
// Datenquellen: graph.db (unverschlüsselt von Pages), Original-PDFs direkt
// aus dem öffentlichen GitHub-Repo (jsDelivr-CDN). Das Passwort-Gate ist
// bewusst nur eine Nutzungshürde (Hash-Vergleich), kein Datenschutz — die
// Dokumente sind amtlich öffentlich.

import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.33.1-dev57.0/+esm";

// Sichtbare App-Version (Fußzeile). Beim Ausliefern zusammen mit dem
// ?v=…-Cache-Parameter in index.html erhöhen, damit Version und
// tatsächlich geladener Code übereinstimmen.
const APP_VERSION = "v27 · 2026-07-30";
// Cache-Parameter für content/*.json — mit der App-Version mitziehen, damit
// geänderte Inhalte nicht aus dem Browser-Cache kommen.
const CONTENT_VERSION = "27";

const $ = (id) => document.getElementById(id);
const status = (msg) => { $("statusbar").textContent = msg; };
const bootMsg = (msg) => { $("boot-msg").textContent = msg; };
const esc = (s) => String(s).replace(/'/g, "''");
const escHtml = (s) => String(s).replace(/[&<>"]/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// escHtml allein hält eine javascript:-URL nicht auf — sie enthält keines der
// escapten Zeichen. Daher vor jedem href zusätzlich das Schema prüfen.
const safeUrl = (url) => {
  if (!url) return "#";
  const trimmed = String(url).trim();
  return /^(https?:\/\/|mailto:|\/|#)/i.test(trimmed) ? trimmed : "#";
};
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const TYPE_NAMES = { EI: "Einladung", NI: "Niederschrift", SU: "Sitzungsunterlagen",
                     BL: "Beschluss", VO: "Beschlussvorlage", AN: "Anlage" };
const REGISTRY_BADGE = { plan: "PLAN", recht: "RECHT" };

// Ausgangstext der Leseansicht (steht in index.html) — wird zurückgeholt, wenn
// eine ganzseitige Ansicht die Leseansicht überschrieben hat.
const DOC_HINWEIS = $("doc-view").innerHTML;

// ── Zugangs-Gate (einfacher Frontend-Schutz, keine Verschlüsselung) ─────────
// Der Deploy-Workflow legt auth.json mit einem PBKDF2-Hash von SITE_PASSWORD
// ab. Fehlt auth.json (lokaler Dev-Modus), gibt es kein Gate.

async function pbkdf2Hex(password, saltHex, iterations) {
  const salt = Uint8Array.from(saltHex.match(/.{2}/g).map((b) => parseInt(b, 16)));
  const material = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" }, material, 256);
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function checkAuth() {
  let auth;
  try {
    const r = await fetch("auth.json");
    if (!r.ok) return;                       // Dev-Modus: kein Gate konfiguriert
    auth = await r.json();
  } catch { return; }
  if (sessionStorage.getItem("uvpa_auth") === auth.hash) return;

  $("boot").hidden = true;
  $("gate").hidden = false;
  $("gate-pw").focus();
  await new Promise((resolve) => {
    $("gate-form").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const hash = await pbkdf2Hex($("gate-pw").value, auth.salt, auth.iterations);
      if (hash === auth.hash) {
        sessionStorage.setItem("uvpa_auth", hash);
        $("gate").hidden = true;
        resolve();
      } else {
        $("gate-error").hidden = false;
        $("gate-pw").select();
      }
    });
  });
  $("boot").hidden = false;
}

async function loadDbBytes() {
  const r = await fetch("graph.db");
  if (!r.ok) throw new Error("graph.db nicht gefunden.");
  return new Uint8Array(await r.arrayBuffer());
}

// ── DuckDB-Wasm ──────────────────────────────────────────────────────────────

let conn;

async function initDb(bytes) {
  bootMsg("Starte DuckDB-Wasm …");
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  const workerUrl = URL.createObjectURL(new Blob(
    [`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" }));
  const db = new duckdb.AsyncDuckDB(
    new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), new Worker(workerUrl));
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);
  await db.registerFileBuffer("graph.db", bytes);
  await db.open({ path: "graph.db", query: { castBigIntToDouble: true } });
  conn = await db.connect();
  bootMsg("Lade Volltext-Index (FTS) …");
  await conn.query("LOAD fts");
}

async function q(sql) {
  const t = await conn.query(sql);
  return t.toArray().map((r) => r.toJSON());
}

// ── Suche + Ergebnisliste ────────────────────────────────────────────────────

let lastTerms = [];

function currentFilters() {
  return { year: $("f-year").value, type: $("f-type").value,
           ort: $("f-ort").value, sort: $("f-sort").value,
           thema: $("f-thema").value, antrag: $("f-antrag").value,
           beirat: $("f-beirat").value };
}

function filterConds(f) {
  const conds = [];
  if (f.year) conds.push(`year(n.date) = ${Number(f.year)}`);
  if (f.type === "AN") conds.push(`d.type_code = ''`);
  else if (f.type && f.type !== "PLAN" && f.type !== "RECHT")
    conds.push(`d.type_code = '${esc(f.type)}'`);
  if (f.ort) conds.push(
    `EXISTS (SELECT 1 FROM edges e WHERE e.source = d.node_id AND e.target = 'o:${esc(f.ort)}')`);
  // Beirat: über die Straßen, die das Dokument nennt. Eine Straße auf einer
  // Gebietsgrenze steht in beiraete unter beiden — wer nach Ost filtert, soll
  // die Kurt-Schumacher-Straße sehen, auch wenn sie knapp überwiegend in Süd liegt.
  if (f.beirat) conds.push(
    `EXISTS (SELECT 1 FROM document_streets ds JOIN streets st ON st.name = ds.street
             WHERE ds.doc_id = d.id AND ('|' || st.beiraete || '|') LIKE '%|${esc(f.beirat)}|%')`);
  if (f.thema) conds.push(`('|' || d.themen || '|') LIKE '%|${esc(f.thema)}|%'`);
  if (f.antrag) conds.push(
    `EXISTS (SELECT 1 FROM nodes an WHERE an.id = d.node_id AND an.antragsteller = '${esc(f.antrag)}')`);
  return conds;
}

/**
 * ORDER-BY-Klausel für die Dokumentenliste.
 * withScore=true im Suchmodus (dann ist "Relevanz" = BM25-Score s.score verfügbar);
 * im Browse-Modus (kein Suchbegriff) fällt "Relevanz" auf Datum zurück.
 */
function sortClause(sort, withScore) {
  // Titelsortierung case-insensitiv (lower) und leserlich: führende Nicht-
  // Buchstaben (Ziffern, Bindestriche, Aktenzeichen) werden gestrippt, damit
  // "Antrag …" nicht hinter "- …" oder "00.01 …" einsortiert wird. Titel ohne
  // jeden Buchstaben (reine Aktenzeichen/Zahlen) wandern ans Ende der A–Z-Liste,
  // statt Buchstaben-Titel zu verdrängen (hasAlpha = 0 zuletzt bei ASC).
  const titleKey = "regexp_replace(lower(d.title), '^[^a-zäöüß]+', '')";
  const hasAlpha = `(${titleKey} != '')`;
  switch (sort) {
    case "date":       return "n.date DESC, d.title";
    case "date-asc":   return "n.date ASC, d.title";
    case "title":      return `${hasAlpha} DESC, ${titleKey} ASC, d.title ASC`;
    case "title-desc": return `${hasAlpha} DESC, ${titleKey} DESC, d.title DESC`;
    default:           return withScore ? "s.score DESC" : "n.date DESC, d.title";
  }
}

async function runSearch() {
  const query = $("search-input").value.trim();
  const f = currentFilters();
  const conds = filterConds(f);
  lastTerms = query.split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}\/.\-]/gu, ""))
                   .filter((w) => w.length >= 3).slice(0, 8);

  // Pläne/Rechtsvorschriften haben kein Sitzungsdatum, keinen Stadtteil-Bezug
  // und keinen Antragsteller — bei diesen Filtern tauchen sie konsequent nicht
  // auf. Der Themen-Filter gilt dagegen auch für sie (Registry pflegt Themen).
  const registryKind = f.type === "PLAN" ? "plan" : f.type === "RECHT" ? "recht" : null;
  const includeRegistry =
    (!f.type || registryKind) && !f.year && !f.ort && !f.antrag && !f.beirat;
  const includeDocs = !registryKind;
  const registryThemaCond = f.thema
    ? `AND ('|' || p.themen || '|') LIKE '%|${esc(f.thema)}|%'` : "";
  let rows;
  if (query) {
    status(`Suche „${query}“ …`);
    conds.unshift("s.score IS NOT NULL");
    const order = sortClause(f.sort, true);
    rows = includeDocs ? await q(
      `SELECT d.id, 'doc' AS kind, d.title, d.type_code, d.node_id, d.pages,
              d.summary, n.label AS top_label, n.date::VARCHAR AS date, n.vorlage_nr, s.score
       FROM (SELECT id, fts_main_documents.match_bm25(id, '${esc(query)}') AS score
             FROM documents) s
       JOIN documents d ON d.id = s.id
       JOIN nodes n ON n.id = d.node_id
       WHERE ${conds.join(" AND ")}
       ORDER BY ${order} LIMIT 50`) : [];

    // Snippets nur für die Trefferliste berechnen (nicht über alle 5000 Texte)
    if (rows.length && lastTerms.length) {
      const ids = rows.map((r) => `'${esc(r.id)}'`).join(",");
      const w = esc(lastTerms[0].toLowerCase());
      const snips = await q(
        `SELECT id, substr(text, greatest(position('${w}' IN lower(text)) - 90, 1), 240) AS snip
         FROM documents WHERE id IN (${ids}) AND text IS NOT NULL`);
      const byId = Object.fromEntries(snips.map((s) => [s.id, s.snip]));
      for (const r of rows) r.snippet = byId[r.id];
    }

    if (includeRegistry) {
      const kindCond = registryKind ? `AND p.kind = '${esc(registryKind)}'` : "";
      const planRows = await q(
        `SELECT id, 'planfile' AS kind, pkind, title, plan_id, top_label, themen, score FROM (
           SELECT pf.rowid::VARCHAR AS id, p.kind AS pkind, pf.titel AS title, pf.plan_id,
                  p.title AS top_label, p.themen,
                  fts_main_plan_files.match_bm25(pf.rowid, '${esc(query)}') AS score
           FROM plan_files pf JOIN plans p ON p.id = pf.plan_id
           WHERE 1=1 ${kindCond} ${registryThemaCond}
         ) WHERE score IS NOT NULL ORDER BY score DESC LIMIT 15`);
      rows = [...rows, ...planRows].sort((a, b) => b.score - a.score);
    }
    renderResults(rows, `${rows.length} Treffer`);
    status(`${rows.length} Treffer für „${query}“.`);
  } else if (registryKind) {
    rows = (f.year || f.ort || f.antrag || f.beirat) ? [] : await q(
      `SELECT p.id, 'plan' AS kind, p.kind AS pkind, p.title AS top_label, p.themen, p.beschreibung
       FROM plans p WHERE p.kind = '${esc(registryKind)}' ${registryThemaCond} ORDER BY p.title`);
    // Beim Recht führt die Liste dieselbe Reihenfolge wie die Übersicht rechts:
    // erst die für den Ausschuss wichtigen Vorschriften, dann der Rest alphabetisch.
    if (registryKind === "recht")
      rows.sort((a, b) => (RECHT_RANG.get(a.id) ?? 99) - (RECHT_RANG.get(b.id) ?? 99));
    const label = registryKind === "recht" ? "Rechtsvorschriften" : "Pläne & Konzepte";
    renderResults(rows, `${rows.length} ${label}`);
    status((f.year || f.ort || f.antrag || f.beirat)
      ? `${label} haben kein Sitzungsjahr und keinen Stadtteil-, Beirats- oder Antragsteller-Bezug — diese Filter zurücksetzen, um sie zu sehen.`
      : `${rows.length} ${label} angezeigt.`);
  } else {
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    rows = await q(
      `SELECT d.id, 'doc' AS kind, d.title, d.type_code, d.node_id, d.pages,
              d.summary, n.label AS top_label, n.date::VARCHAR AS date, n.vorlage_nr
       FROM documents d JOIN nodes n ON n.id = d.node_id
       ${where} ORDER BY ${sortClause(f.sort, false)} LIMIT 50`);
    renderResults(rows, conds.length ? `${rows.length} Dokumente (gefiltert)` : "Neueste Dokumente");
    status(`${rows.length} Dokumente angezeigt.`);
  }
}

function renderResults(rows, title) {
  $("results-title").textContent = title;
  $("results-list").innerHTML = rows.map((r) => {
    const badge = REGISTRY_BADGE[r.pkind] ?? "PLAN";
    if (r.kind === "plan") return `
      <li data-kind="plan" data-plan="${escHtml(r.id)}">
        <div class="r-title"><span class="badge badge-plan">${badge}</span>${escHtml(r.top_label)}</div>
        <div class="r-meta">${r.themen ? escHtml(themenText(r.themen)) : ""}</div>
      </li>`;
    if (r.kind === "planfile") return `
      <li data-kind="planfile" data-file="${escHtml(r.id)}" data-plan-title="${escHtml(r.top_label)}"
          data-badge="${badge}" data-plan-id="${escHtml(r.plan_id)}">
        <div class="r-title"><span class="badge badge-plan">${badge}</span>${escHtml(r.title)}</div>
        <div class="r-meta">${escHtml(r.top_label ?? "")}${r.themen ? " · " + escHtml(themenText(r.themen)) : ""}${r.score != null ? ` · <strong>Score ${r.score.toFixed(2)}</strong>` : ""}</div>
      </li>`;
    return `
      <li data-kind="doc" data-doc="${escHtml(r.id)}">
        <div class="r-title"><span class="badge">${escHtml(r.type_code || "AN")}</span>${escHtml(r.title)}</div>
        <div class="r-meta">${r.date ?? ""}${r.vorlage_nr ? " · " + escHtml(r.vorlage_nr) : ""}
          · ${escHtml(shortLabel(r.top_label ?? "", 55))}${r.score != null ? ` · <strong>Score ${r.score.toFixed(2)}</strong>` : ""}</div>
        ${r.snippet ? `<div class="r-snippet">… ${highlight(escHtml(r.snippet))} …</div>`
          : r.summary ? `<div class="r-snippet">${escHtml(shortLabel(r.summary, 200))}</div>` : ""}
      </li>`;
  }).join("");
  for (const li of $("results-list").querySelectorAll("li"))
    li.addEventListener("click", () => {
      $("results-list").querySelector("li.active")?.classList.remove("active");
      li.classList.add("active");
      if (li.dataset.kind === "plan") openPlan(li.dataset.plan);
      else if (li.dataset.kind === "planfile")
        openPlanFile(li.dataset.file, li.dataset.planTitle, li.dataset.badge, li.dataset.planId);
      else openDoc(li.dataset.doc);
    });
}

function shortLabel(s, max = 70) {
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

/** Themen werden mit '|' gespeichert (Namen können Kommas enthalten) — Anzeige mit ', '. */
function themenText(s) {
  return String(s).replaceAll("|", ", ");
}

function highlight(escapedHtml) {
  if (!lastTerms.length) return escapedHtml;
  const re = new RegExp(`(${lastTerms.map(escRe).join("|")})`, "giu");
  return escapedHtml.replace(re, "<mark>$1</mark>");
}

// ── Dokument-Leseansicht ─────────────────────────────────────────────────────

// Original-PDFs kommen direkt aus dem öffentlichen GitHub-Repo. Wir holen die
// Bytes selbst und zeigen sie als Blob mit PDF-Content-Type im nativen
// Browser-Viewer — so funktioniert es unabhängig davon, welche Header die
// Quelle sendet. Nach dem Umzug zur Organisation nur REPO anpassen.
const REPO = "erlangen-kommunal/UVPA";
const PDF_SOURCES = [
  (p) => `https://cdn.jsdelivr.net/gh/${REPO}@main/${p}`,
  (p) => `https://raw.githubusercontent.com/${REPO}/main/${p}`,
];
let pdfBlobUrl = null;

/** msg darf einfaches HTML enthalten (z. B. einen Link) — Aufrufer escapt eigene Werte selbst. */
function notice(msg) {
  const el = $("doc-notice");
  el.innerHTML = msg;
  el.hidden = !msg;
}

// Ab dieser Größe wird nicht mehr automatisch geladen — ein HEAD-Request
// prüft vorab, damit bei sehr großen PDFs kein unnötiger Download anläuft.
const PDF_SIZE_WARN_BYTES = 12 * 1024 * 1024;

/** Bekannte Dateigröße per HEAD; null = unbekannt (Quelle liefert kein Content-Length). */
async function fetchDocPdfSize(path) {
  const p = encodeURI(path);
  for (const src of PDF_SOURCES) {
    try {
      const r = await fetch(src(p), { method: "HEAD" });
      if (r.ok) {
        const len = r.headers.get("content-length");
        return len ? Number(len) : null;
      }
    } catch { /* Quelle nicht erreichbar — nächste probieren */ }
  }
  return null;
}

/** PDF-Bytes laden; null = Datei nicht im Repository (oder offline). */
async function fetchDocPdf(path) {
  const p = encodeURI(path);
  for (const src of PDF_SOURCES) {
    try {
      const r = await fetch(src(p));
      if (r.ok) return new Uint8Array(await r.arrayBuffer());
    } catch { /* Quelle nicht erreichbar — nächste probieren */ }
  }
  return null;
}

async function showDocPdf(d) {
  notice("");
  status("Prüfe Dateigröße …");
  const size = await fetchDocPdfSize(d.path);
  if (size != null && size > PDF_SIZE_WARN_BYTES) {
    const sourceLabel = d.url ? "im Ratsinformationssystem öffnen" : "an der Originalquelle öffnen";
    const sourceUrl = d.url ?? d.quelle_url;
    notice(`Dieses PDF ist mit ${(size / 1048576).toFixed(1)} MB sehr groß und wird hier nicht ` +
      `automatisch geladen. Bitte das Original ${sourceUrl
        ? `<a href="${escHtml(safeUrl(sourceUrl))}" target="_blank" rel="noopener">${sourceLabel}</a>`
        : sourceLabel}.`);
    status(`PDF zu groß für die Inline-Anzeige (${(size / 1048576).toFixed(1)} MB).`);
    return;
  }

  status("Lade PDF …");
  const bytes = await fetchDocPdf(d.path);
  if (!bytes) {
    notice("Dieses PDF liegt nicht im Repository (z. B. übergroße Sitzungsunterlagen) " +
           "oder es besteht keine Internetverbindung — bitte das Original über den RIS-Link laden.");
    status("PDF nicht verfügbar.");
    return;
  }
  if (pdfBlobUrl) URL.revokeObjectURL(pdfBlobUrl);
  pdfBlobUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  $("doc-body").innerHTML =
    `<iframe class="pdf-frame" src="${pdfBlobUrl}" title="PDF-Ansicht"></iframe>`;
  $("btn-pdf").classList.add("active");
  $("btn-text")?.classList.remove("active");
  status(`PDF angezeigt (${(bytes.length / 1048576).toFixed(1)} MB).`);
}

/**
 * Beratungsfolge einer Vorlage als kompakte Liste.
 *
 * Eine einzelne Station sagt wenig — interessant wird es, wenn dieselbe Vorlage
 * durch mehrere Gremien läuft (Ausschuss empfiehlt, Stadtrat beschließt) oder
 * mehrfach vertagt wird. Deshalb wird der Abschnitt erst ab zwei Stationen
 * gezeigt und das eigene Gremium hervorgehoben.
 */
function beratungsfolgeHtml(rows) {
  if (!rows || rows.length < 2) return "";
  const items = rows.map((b) => {
    const uvpa = /Umwelt-,\s*Verkehrs-\s*und\s*Planungs/i.test(b.gremium || "");
    const datum = b.datum ? fmtDatum(b.datum) : "";
    const text = `${escHtml(b.gremium)}${b.top ? ` · TOP ${escHtml(b.top)}` : ""}` +
      (b.ergebnis ? ` — <strong>${escHtml(b.ergebnis)}</strong>` : "");
    const inner = b.url
      ? `<a href="${escHtml(safeUrl(b.url))}" target="_blank" rel="noopener">${text}</a>`
      : text;
    return `<li class="${uvpa ? "bf-eigen" : ""}"><span class="bf-datum">${escHtml(datum)}</span> ${inner}</li>`;
  }).join("");
  return `<details class="beratungsfolge"><summary>Beratungsfolge — ${rows.length} Stationen</summary>
    <ol class="bf-liste">${items}</ol>
    <p class="bf-quelle">Quelle: Ratsinformationssystem der Stadt Erlangen. Die Liste
      umfasst alle Gremien, die diese Vorlage behandelt haben — auch außerhalb des UVPA.</p>
  </details>`;
}

function fmtDatum(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split("-");
  return d && m && y ? `${d}.${m}.${y}` : String(iso);
}

async function openDoc(id) {
  const [d] = await q(
    `SELECT d.id, d.title, d.type_code, d.node_id, d.path, d.url, d.pages, d.text,
            d.summary, d.themen,
            n.label AS top_label, n.date::VARCHAR AS date, n.vorlage_nr
     FROM documents d JOIN nodes n ON n.id = d.node_id
     WHERE d.id = '${esc(id)}'`);
  if (!d) return;
  activateTab("doc");

  // Straßen, die der zugehörige TOP nennt — der Ortsbezug des Dokuments.
  // Sortiert nach Gewicht (Zahl der Dokumente des TOPs, die die Straße nennen).
  const streets = await q(
    `SELECT n.label AS name FROM edges e JOIN nodes n ON n.id = e.target
     WHERE e.source = '${esc(d.node_id)}' AND e.type = 'mentions_strasse'
     ORDER BY e.weight DESC, n.label LIMIT 20`);

  // Beratungsfolge: dieselbe Vorlage kann in mehreren Gremien laufen. Ältere
  // graph.db-Stände haben die Tabelle nicht — dann bleibt der Abschnitt weg.
  let beratungen = [];
  if (d.vorlage_nr) {
    try {
      beratungen = await q(
        `SELECT datum::VARCHAR AS datum, gremium, top, ergebnis, url
         FROM beratungen WHERE vorlage_nr = '${esc(d.vorlage_nr)}'
         ORDER BY datum, gremium`);
    } catch { /* Tabelle fehlt */ }
  }

  const tc = d.type_code || "AN";
  const html = `<div class="doc-head">
    <h3><span class="badge">${escHtml(tc)}</span>${escHtml(d.title)}</h3>
    <p class="meta">${TYPE_NAMES[tc] ?? tc} · ${d.date ?? ""}${d.pages ? ` · ${d.pages} Seiten` : ""}</p>
    <p class="meta">${escHtml(d.top_label)}${d.vorlage_nr ? " · Vorlage " + escHtml(d.vorlage_nr) : ""}</p>
    ${d.summary ? `<p class="doc-summary">${escHtml(d.summary)}</p>` : ""}
    ${d.themen ? `<p class="meta">Themen: ${escHtml(themenText(d.themen))}</p>` : ""}
    ${beratungsfolgeHtml(beratungen)}
    ${streets.length ? `<p class="doc-streets"><span class="lbl">Straßen:</span>` +
      streets.map((s) => `<button type="button" class="street-chip"
        data-street="${escHtml(s.name)}">${escHtml(s.name)}</button>`).join("") + `</p>` : ""}
    <div class="doc-actions">
      <button id="btn-text" class="active" type="button">Text</button>
      <button id="btn-pdf" type="button">PDF</button>
      <a href="${escHtml(safeUrl(d.url))}" target="_blank" rel="noopener"
         title="${escHtml(d.path)}">⬇ Original-PDF (RIS)</a>
      <button id="btn-context" type="button">⛬ Kontext im Netzwerk</button>
    </div>
  </div>
  <div id="doc-notice" class="notice" hidden></div>
  <div id="doc-body"></div>`;

  $("doc-view").innerHTML = html;
  renderDocText(d);
  $("btn-context").addEventListener("click", () => focusNode(d.node_id));
  for (const chip of $("doc-view").querySelectorAll("[data-street]"))
    chip.addEventListener("click", () => focusStreet(chip.dataset.street));
  $("btn-pdf").addEventListener("click", () => showDocPdf(d));
  $("btn-text").addEventListener("click", () => {
    renderDocText(d);
    $("btn-text").classList.add("active");
    $("btn-pdf").classList.remove("active");
  });
  $("panel-doc").scrollTop = 0;
  document.querySelector("#doc-body .doc-page mark")
    ?.scrollIntoView({ block: "center" });
}

/** Externer Plan/Konzept oder Rechtsvorschrift: Übersicht + Dateien + verknüpfte TOPs. */
async function openPlan(planId) {
  const [p] = await q(
    `SELECT id, kind, title, beschreibung, quelle_url, themen FROM plans WHERE id = '${esc(planId)}'`);
  if (!p) return;
  activateTab("doc");

  const files = await q(
    `SELECT rowid::VARCHAR AS id, titel, path, quelle_url, pages, (text IS NOT NULL) AS has_text
     FROM plan_files WHERE plan_id = '${esc(planId)}' ORDER BY titel`);
  // p.id hat die Form '{kind}:{registry-id}', der zugehörige Netzwerk-Knoten
  // nutzt dasselbe Suffix mit Kurzpräfix ('p:' | 'r:').
  const nodePrefix = p.kind === "recht" ? "r" : "p";
  const registryLocalId = p.id.slice(p.kind.length + 1);
  const relEdgeType = p.kind === "recht" ? "relates_to_recht" : "relates_to_plan";
  let related = await q(
    `SELECT n.label, n.date::VARCHAR AS date FROM edges e JOIN nodes n ON n.id = e.target
     WHERE e.source = '${nodePrefix}:${esc(registryLocalId)}' AND e.type = '${relEdgeType}'
     ORDER BY n.date DESC`);
  // Die Verknüpfungen entstehen im GraphBuilder über einen groben Stichwort-
  // abgleich (Titelanfang gegen TOP-Titel). Bei „Umwelt-, Verkehrs- und
  // Planungsbeirat (Satzung)“ bleibt davon „Umwelt“ übrig — das trifft jeden
  // zweiten Tagesordnungspunkt. Bei Rechtsvorschriften bleibt deshalb nur, was
  // die Vorschrift selbst betrifft: Der Titel muss sie beim Namen nennen und
  // die Rechtsform ansprechen (Änderung, Neuerlass, Aufhebung einer Satzung
  // oder Verordnung) — Personalien im Gremium etwa zählen nicht dazu.
  if (p.kind === "recht") {
    const kern = p.title.split("(")[0].trim().toLowerCase();
    related = related.filter((r) => {
      const label = r.label.toLowerCase();
      return label.includes(kern) && /satzung|verordnung/.test(label);
    });
  }

  const badge = REGISTRY_BADGE[p.kind] ?? "PLAN";
  const html = `
  ${p.kind === "recht" ? `<button type="button" id="btn-recht-uebersicht" class="crumb-back">‹ Übersicht „Satzung &amp; Recht“</button>` : ""}
  <div class="doc-head">
    <h3><span class="badge badge-plan">${badge}</span>${escHtml(p.title)}</h3>
    ${p.beschreibung ? `<p class="meta">${escHtml(p.beschreibung)}</p>` : ""}
    <p class="meta">${p.themen ? escHtml(themenText(p.themen)) : ""}</p>
    <div class="doc-actions">
      ${p.quelle_url ? `<a href="${escHtml(safeUrl(p.quelle_url))}" target="_blank" rel="noopener">🔗 Quelle (Stadt Erlangen)</a>` : ""}
    </div>
  </div>
  <div id="doc-notice" class="notice" hidden></div>
  <div id="doc-body">
    ${files.length ? `<div class="doc-page"><p class="doc-page-nr">Dokumente</p><ul class="plan-files">` +
      files.map((f) => `<li>
          <a href="#" data-plan-file="${escHtml(f.id)}">${escHtml(f.titel)}</a>
          ${f.pages ? `<span class="meta"> · ${f.pages} S.</span>` : ""}
          ${f.quelle_url ? ` · <a href="${escHtml(safeUrl(f.quelle_url))}" target="_blank" rel="noopener">Original</a>` : ""}
        </li>`).join("") + `</ul></div>` : ""}
    ${related.length ? `<div class="doc-page"><p class="doc-page-nr">${p.kind === "recht"
      ? "Beratungen zu dieser Vorschrift" : "Verknüpfte Tagesordnungspunkte"} (${related.length})</p><ul class="plan-files">` +
      related.map((r) => `<li>${r.date ?? ""} — ${escHtml(shortLabel(r.label, 90))}</li>`).join("") + `</ul></div>` : ""}
    ${p.kind === "recht" ? `<p class="quelle">Weitere Vorschriften im
      <a href="${STADTRECHT_AZ_URL}" target="_blank" rel="noopener">Erlanger Stadtrecht (A–Z)</a>.</p>` : ""}
  </div>`;

  $("doc-view").innerHTML = html;
  for (const a of $("doc-view").querySelectorAll("[data-plan-file]"))
    a.addEventListener("click", (ev) => { ev.preventDefault(); openPlanFile(a.dataset.planFile, p.title, badge, p.id); });
  $("btn-recht-uebersicht")?.addEventListener("click", () => renderRechtUebersicht());
}

async function openPlanFile(fileId, planTitle, badge = "PLAN", planId = null) {
  // Nicht-numerische IDs (manipulierte URL) abfangen statt NaN ins SQL zu geben
  const [f] = Number.isInteger(Number(fileId)) ? await q(
    `SELECT titel, path, quelle_url, pages, text FROM plan_files WHERE rowid = ${Number(fileId)}`) : [];
  if (!f) return;
  const html = `
  ${planId ? `<button type="button" id="btn-back-plan" class="crumb-back">‹ Übersicht „${escHtml(shortLabel(planTitle, 40))}“</button>` : ""}
  <div class="doc-head">
    <h3><span class="badge badge-plan">${badge}</span>${escHtml(f.titel)}</h3>
    <p class="meta">${escHtml(planTitle)}${f.pages ? ` · ${f.pages} Seiten` : ""}</p>
    <div class="doc-actions">
      <button id="btn-text" class="active" type="button">Text</button>
      ${f.path ? `<button id="btn-pdf" type="button">PDF</button>` : ""}
      ${f.quelle_url ? `<a href="${escHtml(safeUrl(f.quelle_url))}" target="_blank" rel="noopener">⬇ Original</a>` : ""}
    </div>
  </div>
  <div id="doc-notice" class="notice" hidden></div>
  <div id="doc-body"></div>`;
  $("doc-view").innerHTML = html;
  renderDocText(f);
  if (f.path) $("btn-pdf").addEventListener("click", () => showDocPdf(f));
  if (planId) $("btn-back-plan").addEventListener("click", () => openPlan(planId));
  $("btn-text").addEventListener("click", () => {
    renderDocText(f);
    $("btn-text").classList.add("active");
    $("btn-pdf")?.classList.remove("active");
  });
  $("panel-doc").scrollTop = 0;
}

// ── Satzung & Recht ──────────────────────────────────────────────────────────
//
// Eigene, ganzseitige Ansicht (body.mode-recht blendet Trefferliste und
// Filterleiste aus): Rechtsvorschriften haben kein Sitzungsjahr, keinen
// Stadtteil und keinen Antragsteller — von der Filterleiste bleibt nur das
// Thema übrig, und das steht als einziges Suchelement über der Liste.
//
// recht/registry.json erfasst das Ortsrecht mit Ausschussbezug alphabetisch.
// Welche Vorschriften die Beratungen tatsächlich prägen, steht dagegen hier:
// RECHT_WICHTIG bestimmt Reihenfolge und Kurztext (aus dem Satzungstext selbst:
// Langtitel und Paragraphenfolge). Alles Übrige folgt darunter, am Ende der
// Link ins gesamte Erlanger Stadtrecht.
const STADTRECHT_AZ_URL = "https://erlangen.de/themenseite/recht/stadtrecht-a-z";

const RECHT_WICHTIG = [
  ["recht:uvpa-beiratssatzung", "Stadtrecht 235.00",
   "Der Beirat berät Stadtrat und Verwaltung in allen Angelegenheiten des Ausschusses und gibt " +
   "zu dessen Gutachten und Beschlüssen Empfehlungen ab."],
  ["recht:orts-und-stadtteilbeiraete", "Stadtrecht 140.00",
   "Welche Orts- und Stadtteilbeiräte es gibt und welche Gebiete sie vertreten — Fassung ab " +
   "01.05.2026 mit Gebietsplan."],
  ["recht:baumschutzverordnung", "Stadtrecht 023.00",
   "Schutz des Baumbestands: Verbote, Befreiungen, Ausgleichszahlungen und Ersatzpflanzungen."],
  ["recht:gruenanlagensatzung", "Stadtrecht 075.00",
   "Benutzung der öffentlichen Grünanlagen: Verhalten, Ausnahmen, Benutzungssperren."],
  ["recht:landschaftsschutzverordnung", "Stadtrecht 113.00",
   "Schutz der Landschaftsräume mit Verboten und Erlaubnispflicht; die Karte grenzt die " +
   "Gebiete ab."],
  ["recht:sondernutzungssatzung", "Stadtrecht 192.00",
   "Nutzung der Straße über den Gemeingebrauch hinaus — Außengastronomie, Werbeanlagen, " +
   "Baustellen: Erlaubnispflicht und Ausnahmen."],
  ["recht:strassenreinigungsverordnung", "Stadtrecht 211.00",
   "Reinhaltung der Straßen und Sicherung der Gehbahnen im Winter — Umfang der Anliegerpflicht."],
  ["recht:erschliessungsbeitragssatzung", "Stadtrecht 057.00",
   "Erschließungsbeiträge nach dem BauGB: beitragsfähiger Aufwand, Verteilung, Gemeindeanteil."],
  ["recht:milieuschutz-hertleinstrasse", "Stadtrecht 130.00",
   "Erhaltungssatzung nach § 172 BauGB für die Östliche Hertleinstraße — Rückbau und " +
   "Nutzungsänderung genehmigungspflichtig."],
  ["recht:milieuschutz-jaminstrasse", "Stadtrecht 130.10",
   "Zweite Erhaltungssatzung dieser Art, für das Wohngebiet um die Jaminstraße."],
];

/** Rang (auch für die Trefferliste beim Typ-Filter): kuratierte Einträge zuerst. */
const RECHT_RANG = new Map(RECHT_WICHTIG.map(([id], i) => [id, i]));
const RECHT_KURZ = new Map(RECHT_WICHTIG.map(([id, tag, kurz]) => [id, { tag, kurz }]));

/** Themen stehen mit '|' getrennt in einer Spalte — hier als Liste. */
function themenListe(s) {
  return String(s ?? "").split("|").map((t) => t.trim()).filter(Boolean);
}

let rechtRows = null;          // Registry-Zeilen, einmal geladen
let rechtThema = "";           // aktives Thema des einzigen Suchelements

async function renderRechtUebersicht() {
  document.body.classList.add("mode-seite", "mode-recht");
  await activateTab("doc");
  if (!rechtRows) {
    rechtRows = await q(
      `SELECT * FROM (
         SELECT id, title, beschreibung, themen,
                (SELECT count(*) FROM plan_files pf WHERE pf.plan_id = plans.id)::INT AS n
         FROM plans WHERE kind = 'recht') ORDER BY title`);
    // Kuratierte Reihenfolge zuerst, der Rest bleibt alphabetisch.
    rechtRows.sort((a, b) => (RECHT_RANG.get(a.id) ?? 99) - (RECHT_RANG.get(b.id) ?? 99));
  }
  const themen = [...new Set(rechtRows.flatMap((r) => themenListe(r.themen)))].sort();
  const passt = (r) => !rechtThema || themenListe(r.themen).includes(rechtThema);
  const wichtig = rechtRows.filter((r) => RECHT_RANG.has(r.id) && passt(r));
  const weitere = rechtRows.filter((r) => !RECHT_RANG.has(r.id) && passt(r));

  const karte = (r) => {
    const kuratiert = RECHT_KURZ.get(r.id);
    const meta = [kuratiert?.tag, `${r.n} Dokument${r.n === 1 ? "" : "e"}`].filter(Boolean);
    return `<li data-plan="${escHtml(r.id)}">
      <div class="r-title"><span class="badge badge-plan">RECHT</span>${escHtml(r.title)}</div>
      <div class="r-desc">${escHtml(kuratiert?.kurz ?? r.beschreibung ?? "")}</div>
      <div class="r-meta">${escHtml(meta.join(" · "))}</div>
    </li>`;
  };

  $("doc-view").innerHTML = `
    <button type="button" id="btn-start" class="crumb-back">‹ Startseite</button>
    <h2 class="section-title">⚖️ Satzung &amp; Recht</h2>
    <p class="section-intro">Die Satzung für den Umwelt-, Verkehrs- und Planungsbeirat und das
      Erlanger Stadtrecht, das die Beratungen des Ausschusses prägt.</p>
    <div class="recht-filter">
      <label for="recht-thema">Thema</label>
      <select id="recht-thema">
        <option value="">alle</option>
        ${themen.map((t) => `<option value="${escHtml(t)}"${t === rechtThema ? " selected" : ""}>${escHtml(t)}</option>`).join("")}
      </select>
      <span class="recht-anzahl">${wichtig.length + weitere.length} von ${rechtRows.length}</span>
    </div>
    ${wichtig.length ? `<h3 class="sub-head">Wichtig für die Ausschussarbeit</h3>
      <ul class="reg-list">${wichtig.map(karte).join("")}</ul>` : ""}
    ${weitere.length ? `<h3 class="sub-head">Weiteres Ortsrecht mit Ausschussbezug</h3>
      <ul class="reg-list">${weitere.map(karte).join("")}</ul>` : ""}
    ${wichtig.length + weitere.length === 0
      ? `<p class="hint">Zu diesem Thema ist keine Rechtsvorschrift erfasst.</p>` : ""}
    <p class="quelle">Das vollständige Ortsrecht — auch alles, was hier nicht erfasst ist —
      führt die Stadt Erlangen im Verzeichnis
      <a href="${STADTRECHT_AZ_URL}" target="_blank" rel="noopener">Erlanger Stadtrecht (A–Z)</a>.</p>`;

  $("btn-start").addEventListener("click", zeigeStart);
  for (const li of $("doc-view").querySelectorAll("li[data-plan]"))
    li.addEventListener("click", () => openPlan(li.dataset.plan));
  $("recht-thema").addEventListener("change", (ev) => {
    rechtThema = ev.target.value;
    renderRechtUebersicht();
  });
  $("panel-doc").scrollTop = 0;
  status(`${wichtig.length + weitere.length} Rechtsvorschriften`
    + (rechtThema ? ` zum Thema „${rechtThema}“.` : "."));
}

function renderDocText(d) {
  notice("");
  if (d.text) {
    const pages = d.text.split("\f");
    $("doc-body").innerHTML = pages.map((p, i) => `
      <div class="doc-page">
        ${pages.length > 1 ? `<p class="doc-page-nr">Seite ${i + 1} / ${pages.length}</p>` : ""}${highlight(escHtml(p.trim()))}
      </div>`).join("");
  } else {
    $("doc-body").innerHTML = `<p class="hint">Für dieses Dokument liegt kein
      extrahierter Text vor (vermutlich gescannt oder Datei nicht im Repository).
      Über den PDF-Button lässt sich das Original meist direkt anzeigen.</p>`;
  }
}

// ── Netzwerk-Ansicht (Kontext) ───────────────────────────────────────────────

// "plan" und "recht" teilen sich die 7. Farbe (violett) — beide sind externe
// kuratierte Quellen; sieben unterscheidbare Farben sprengen die Palette
// (siehe dataviz-Skill: >4 Slots im All-Pairs-Kontext), daher trägt hier die
// Form die Unterscheidung, nicht die Farbe.
const COLORS = { top: "#2a78d6", session: "#008300", ort: "#e87ba4", vorlage: "#eda100", bplan: "#1baf7a", plan: "#4a3aa7", recht: "#4a3aa7" };
const SHAPES = { top: "ellipse", session: "round-rectangle", ort: "triangle", vorlage: "diamond", bplan: "hexagon", plan: "star", recht: "rectangle" };

let cy = null;

function initCy() {
  cy = cytoscape({
    container: $("cy"),
    wheelSensitivity: 0.25,
    style: [
      { selector: "node", style: {
          label: "data(short)",
          "font-size": 8, color: "#52514e",
          "text-wrap": "wrap", "text-max-width": 110,
          "text-valign": "bottom", "text-margin-y": 4,
          width: 18, height: 18,
          "background-color": (el) => COLORS[el.data("type")] ?? "#898781",
          shape: (el) => SHAPES[el.data("type")] ?? "ellipse",
          "border-width": 1, "border-color": "rgba(11,11,11,0.25)",
      }},
      { selector: 'node[type="session"]', style: { width: 26, height: 18 } },
      { selector: 'node[type="top"]', style: { width: 22, height: 22 } },
      { selector: "node:selected", style: { "border-width": 3, "border-color": "#0b0b0b" } },
      { selector: "edge", style: {
          "curve-style": "bezier", width: 1,
          "line-color": "#c3c2b7", opacity: 0.8,
      }},
      { selector: 'edge[type="mentions_ort"], edge[type="mentions_bplan"]', style: {
          "line-style": "dotted", opacity: 0.55 } },
      { selector: 'edge[type="references_vorlage"]', style: { "line-style": "dashed" } },
      { selector: 'edge[type="thread"]', style: {
          "line-color": "#eb6834", width: 3, opacity: 0.95 } },
      { selector: 'edge[type="relates_to_plan"], edge[type="relates_to_recht"]', style: {
          "line-color": "#4a3aa7", "line-style": "dashed", width: 2, opacity: 0.85 } },
    ],
  });
  // Klick im Graphen → Dokumente dieses Knotens in der Ergebnisliste
  cy.on("tap", "node", async (ev) => {
    const id = ev.target.id();
    const type = ev.target.data("type");
    if (type === "plan" || type === "recht") {
      await expandNode(id);
      return openPlan(`${type}:${id.slice(2)}`);
    }
    await expandNode(id);
    const rows = await q(
      `SELECT d.id, 'doc' AS kind, d.title, d.type_code, d.node_id, d.pages,
              n.label AS top_label, n.date::VARCHAR AS date, n.vorlage_nr
       FROM documents d JOIN nodes n ON n.id = d.node_id
       WHERE d.node_id = '${esc(id)}' ORDER BY d.title`);
    if (rows.length) {
      renderResults(rows, `Dokumente: ${shortLabel(ev.target.data("label"), 40)}`);
      status(`${rows.length} Dokument(e) zu „${shortLabel(ev.target.data("label"), 60)}“.`);
    } else {
      status(`„${shortLabel(ev.target.data("label"), 60)}“ — keine direkten Dokumente; Nachbarn geladen.`);
    }
  });
}

function addElements(nodeRows, edgeRows) {
  const els = [];
  for (const n of nodeRows) {
    if (cy.getElementById(n.id).length) continue;
    els.push({ group: "nodes", data: {
      id: n.id, type: n.type, label: n.label, short: shortLabel(n.label),
    }});
  }
  for (const e of edgeRows) {
    const eid = `${e.source}->${e.target}:${e.type}`;
    if (cy.getElementById(eid).length) continue;
    els.push({ group: "edges", data: {
      id: eid, source: e.source, target: e.target, type: e.type, weight: e.weight,
    }});
  }
  if (els.length) cy.add(els);
  cy.layout({ name: "cose", animate: false, padding: 30,
              nodeRepulsion: 40_000, idealEdgeLength: 60 }).run();
}

async function fetchNodesByIds(ids) {
  if (!ids.length) return [];
  const list = ids.map((i) => `'${esc(i)}'`).join(",");
  return q(`SELECT id, type, label FROM nodes WHERE id IN (${list})`);
}

/** Übersicht: alle roten Fäden (gleiche Vorlage über mehrere Sitzungen). */
async function showOverview() {
  const threads = await q("SELECT source, target, type, weight FROM edges WHERE type='thread'");
  const topIds = [...new Set(threads.flatMap((e) => [e.source, e.target]))];
  const sessEdges = topIds.length
    ? await q(`SELECT source, target, type, weight FROM edges
               WHERE type='in_session' AND source IN (${topIds.map((i) => `'${esc(i)}'`).join(",")})`)
    : [];
  const allIds = [...new Set([...topIds, ...sessEdges.map((e) => e.target)])];
  addElements(await fetchNodesByIds(allIds), [...threads, ...sessEdges]);
}

/** 1-Hop-Nachbarschaft eines Knotens nachladen + Kantenschluss. */
async function expandNode(id) {
  const neighborEdges = await q(
    `SELECT source, target, type, weight FROM edges
     WHERE source = '${esc(id)}' OR target = '${esc(id)}'
     ORDER BY weight DESC LIMIT 150`);
  const ids = [...new Set([id, ...neighborEdges.flatMap((e) => [e.source, e.target])])];
  addElements(await fetchNodesByIds(ids), neighborEdges);
  const visible = cy.nodes().map((n) => n.id());
  const list = visible.map((i) => `'${esc(i)}'`).join(",");
  addElements([], await q(
    `SELECT source, target, type, weight FROM edges
     WHERE source IN (${list}) AND target IN (${list})`));
}

/** Vom Dokument in den Netzwerk-Tab springen und den Knoten fokussieren. */
async function focusNode(nodeId) {
  activateTab("net");
  await expandNode(nodeId);
  const node = cy.getElementById(nodeId);
  cy.elements().unselect();
  node.select();
  cy.animate({ center: { eles: node }, zoom: 1.2, duration: 300 });
}

// ── Karten-Ansicht (Tempo 30 + Ortsbezug der Dokumente) ──────────────────────

// Amtliche Kartengrundlage des Bundes und der Länder, ohne Schlüssel nutzbar.
// Graue Variante, damit die Tempo-Linien und nicht der Untergrund dominieren.
const TILE_URL = "https://sgx.geodatenzentrum.de/wmts_basemapde/tile/1.0.0/" +
  "de_basemapde_web_raster_grau/default/GLOBAL_WEBMERCATOR/{z}/{y}/{x}.png";
const TILE_ATTR = '© <a href="https://basemap.de" target="_blank" rel="noopener">basemap.de/BKG</a> · ' +
  '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>-Mitwirkende';

// Offene WMS-Dienste der Bayerischen Vermessungsverwaltung, beide CC BY 4.0 und
// kostenfrei. Anders als der BayernAtlas (X-Frame-Options: DENY) sind sie direkt
// einbettbar: EPSG:3857 wird unterstützt, CORS-Header werden gesendet.
const BY_DOP_URL = "https://geoservices.bayern.de/od/wms/dop/v1/dop40";
const BY_ALKIS_URL = "https://geoservices.bayern.de/od/wms/alkis/v1/parzellarkarte";
const BY_ATTR = '© <a href="https://geoservices.bayern.de" target="_blank" rel="noopener">Bayerische Vermessungsverwaltung</a>';
const FLURSTUECKE_AB_ZOOM = 16;

// Farbrollen gespiegelt aus style.css (:root). Leaflet braucht die Werte als
// Zeichenkette; die Begründung der Palette steht dort.
const ROAD_STYLE = {
  t30:    { color: "#6da7ec", weight: 2 },
  t20:    { color: "#2a78d6", weight: 2 },
  living: { color: "#104281", weight: 2 },
  cond:   { color: "#eb6834", weight: 2, dashArray: "5 8" },
};
const ROAD_LABEL = {
  t30: "Tempo 30", t20: "Tempo 20",
  living: "Verkehrsberuhigter Bereich", cond: "Nur zeitweise begrenzt",
};
const POI_LABEL = {
  school: "Schule", kindergarten: "Kindergarten",
  social: "Soziale Einrichtung", playground: "Spielplatz",
};

let map = null;
let roadGeo = null;              // Rohdaten, für den Neuaufbau beim Umschalten des Filters
let roadLayer = null;
let beiratLayer = null;
let streetDocs = new Map();      // Straßenname → Zahl der Dokumente
let streetBeirat = new Map();    // Straßenname → Beirat/Beiräte (für das Popup)
const streetLayers = new Map();  // Straßenname → Leaflet-Layer (eine Straße hat viele Abschnitte)
let onlyDocs = false;

/** Geodatei laden — im Deploy neben der Seite, im lokalen Dev eine Ebene höher. */
async function loadGeo(name) {
  for (const url of [`geo/${name}`, `../geo/${name}`]) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch { /* nächster Pfad */ }
  }
  return null;
}

function roadStyle(feature) {
  const p = feature.properties;
  const base = ROAD_STYLE[p.cls] ?? ROAD_STYLE.t30;
  // Straßen mit Ausschussbezug tragen mehr Gewicht — Betonung über die
  // Strichstärke, nicht über eine weitere Farbe.
  const has = p.name && streetDocs.has(p.name);
  return { ...base, weight: has ? base.weight + 2.5 : base.weight,
           opacity: has ? 0.95 : 0.55 };
}

function roadPopup(props) {
  const el = document.createElement("div");
  el.className = "map-pop";
  const name = props.name;
  const count = name ? streetDocs.get(name) ?? 0 : 0;
  const bei = name ? streetBeirat.get(name) : null;
  el.innerHTML = `
    <strong>${escHtml(name ?? "Straße ohne Namen")}</strong>
    <div class="mp-meta">${escHtml(ROAD_LABEL[props.cls] ?? props.cls)}${
      props.cond ? ` · ${escHtml(props.cond)}` : ""}</div>
    ${bei ? `<div class="mp-meta">${escHtml(bei.split("|").join(" · "))}</div>` : ""}
    ${name ? `<button type="button"${count ? "" : " disabled"}>${
      count ? `${count} Dokument${count === 1 ? "" : "e"} anzeigen`
            : "Keine Ausschussdokumente"}</button>` : ""}`;
  el.querySelector("button:not([disabled])")
    ?.addEventListener("click", () => openStreet(name));
  return el;
}

function buildRoadLayer() {
  if (roadLayer) map.removeLayer(roadLayer);
  streetLayers.clear();
  roadLayer = L.geoJSON(roadGeo, {
    filter: (f) => !onlyDocs || (f.properties.name && streetDocs.has(f.properties.name)),
    style: roadStyle,
    onEachFeature: (f, layer) => {
      layer.bindPopup(() => roadPopup(f.properties));
      const name = f.properties.name;
      if (name) {
        const list = streetLayers.get(name);
        if (list) list.push(layer);
        else streetLayers.set(name, [layer]);
      }
    },
  }).addTo(map);
}

async function initMap() {
  if (typeof L === "undefined") {
    $("map").innerHTML = '<p class="hint" style="padding:1rem">Die Kartenbibliothek ' +
      "konnte nicht geladen werden (keine Verbindung zum CDN).</p>";
    return;
  }
  // preferCanvas: gut 3.000 Linienzüge als SVG-Elemente würden das Layout
  // spürbar bremsen — auf Canvas gezeichnet bleibt die Karte flüssig.
  map = L.map("map", { center: [49.5897, 11.0040], zoom: 13, preferCanvas: true,
                       maxBounds: [[49.45, 10.80], [49.72, 11.22]], minZoom: 11 });

  // Grau als Standard, damit das Tempo-Netz und nicht der Untergrund trägt.
  // Luftbild und Flurstücke kommen als amtliche WMS-Dienste der Bayerischen
  // Vermessungsverwaltung (CC BY 4.0) direkt herein — sie liefern EPSG:3857 und
  // CORS-Header. Der BayernAtlas selbst wäre nicht einbettbar (X-Frame-Options).
  const grundkarten = {
    "basemap.de (grau)": L.tileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTR }),
    "OpenStreetMap": L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>-Mitwirkende',
    }),
    "Luftbild (amtlich, 40 cm)": L.tileLayer.wms(BY_DOP_URL, {
      layers: "by_dop40c", format: "image/jpeg", maxZoom: 20,
      attribution: BY_ATTR + " — DOP40 (CC BY 4.0)",
    }),
  };
  const FLURSTUECKE = "Flurstücke (ALKIS)";
  const overlays = {
    [FLURSTUECKE]: L.tileLayer.wms(BY_ALKIS_URL, {
      layers: "by_alkis_parzellarkarte_umr_gelb", format: "image/png",
      transparent: true, maxZoom: 20,
      attribution: BY_ATTR + " — ALKIS-Parzellarkarte (CC BY 4.0)",
    }),
  };
  grundkarten["basemap.de (grau)"].addTo(map);
  L.control.layers(grundkarten, overlays).addTo(map);
  // Der Umring ist für große Maßstäbe gezeichnet; weiter draußen bleibt er leer
  // und der eingeschaltete Layer sähe ohne Hinweis defekt aus.
  map.on("overlayadd", (e) => {
    if (e.name === FLURSTUECKE && map.getZoom() < FLURSTUECKE_AB_ZOOM) {
      status(`„${FLURSTUECKE}“ ist eingeschaltet, wird aber erst ab Zoomstufe ${FLURSTUECKE_AB_ZOOM} gezeichnet — bitte näher heranzoomen.`);
    }
  });

  status("Lade Geodaten …");
  try {
    const st = await q("SELECT name, doc_count, beiraete FROM streets");
    streetDocs = new Map(st.filter((r) => r.doc_count > 0).map((r) => [r.name, r.doc_count]));
    streetBeirat = new Map(st.filter((r) => r.beiraete).map((r) => [r.name, r.beiraete]));
  } catch { /* ältere graph.db ohne streets-Tabelle — Karte bleibt ohne Betonung */ }

  // Beiratsgebiete als Umriss: neutrale Tinte, keine Füllung — sie sollen den
  // Blick auf das Tempo-Netz nicht einfärben, nur den Zuschnitt zeigen.
  const beiraete = await loadGeo("beiraete.geojson");
  if (beiraete) {
    beiratLayer = L.geoJSON(beiraete, {
      interactive: false,
      style: { color: "#52514e", weight: 2, opacity: 0.95, dashArray: "7 5", fill: false },
      onEachFeature: (f, layer) => layer.bindTooltip(f.properties.name, {
        permanent: true, direction: "center", className: "beirat-label" }),
    }).addTo(map);
  }

  const [roads, pois] = await Promise.all([
    loadGeo("tempo30.geojson"), loadGeo("einrichtungen.geojson")]);
  if (!roads) {
    status("Geodaten nicht gefunden — tools/fetch_geodata.py erzeugt geo/tempo30.geojson.");
    return;
  }

  roadGeo = roads;
  buildRoadLayer();

  if (pois) {
    const poiLayer = L.geoJSON(pois, {
      pointToLayer: (f, latlng) => L.circleMarker(latlng, {
        radius: 3, fillColor: "#52514e", fillOpacity: 0.75,
        color: "#fcfcfb", weight: 1,   // heller Ring: trennt überlappende Punkte
      }),
      onEachFeature: (f, layer) => layer.bindPopup(
        `<div class="map-pop"><strong>${escHtml(f.properties.name ?? "")}</strong>` +
        `<div class="mp-meta">${escHtml(POI_LABEL[f.properties.kind] ?? "")}</div></div>`),
    });
    // Über der ganzen Stadt sind 500 Punkte eine Nebelwand und verdecken das
    // Straßennetz, um das es geht. Sie erscheinen erst, wenn man hineinzoomt
    // und die Nachbarschaft einer einzelnen Einrichtung beurteilen kann.
    const POI_MIN_ZOOM = 14;
    const syncPois = () => {
      const show = map.getZoom() >= POI_MIN_ZOOM;
      if (show && !map.hasLayer(poiLayer)) map.addLayer(poiLayer);
      else if (!show && map.hasLayer(poiLayer)) map.removeLayer(poiLayer);
    };
    map.on("zoomend", syncPois);
    syncPois();
  }

  $("map-only-docs").addEventListener("change", (ev) => {
    onlyDocs = ev.target.checked;
    buildRoadLayer();
    status(onlyDocs ? "Karte zeigt nur Straßen mit Ausschussdokumenten."
                    : "Karte zeigt das gesamte Tempo-30-Netz.");
  });

  await initStrassenListe();

  status(`Karte: ${roads.features.length} Straßenabschnitte, ` +
         `${pois ? pois.features.length : 0} Einrichtungen, ` +
         `${streetDocs.size} Straßen mit Ausschussdokumenten.`);
}

// ── Straßenverzeichnis (Suche + Liste unter der Karte) ───────────────────────
//
// Gegenstück zur Karte: Wer den Straßennamen kennt, soll ihn nicht erst auf
// dem Stadtplan suchen müssen. Grundlage ist das amtliche Straßenverzeichnis
// (geo/strassen.json), gruppiert nach Stadtteilbeirat — das ist die Einheit,
// in der über den Stadtteil geredet wird. Ein Klick zeigt die Dokumente zur
// Straße und hebt sie auf der Karte hervor.

let strassenVerzeichnis = null;
let strasseHighlight = null;

async function initStrassenListe() {
  if (strassenVerzeichnis !== null) return;
  const data = await loadGeo("strassen.json");
  strassenVerzeichnis = data ?? false;
  const box = $("strassen-liste-box");
  if (!data) {
    box.innerHTML = `<p class="hint">Das Straßenverzeichnis fehlt — es entsteht mit
      <code>python tools/fetch_geodata.py</code> als <code>geo/strassen.json</code>.</p>`;
    return;
  }

  // Nach Beirat gruppieren; Straßen ohne Zuordnung sammeln sich in einer
  // eigenen Gruppe, statt stillschweigend zu verschwinden.
  const gruppen = new Map();
  for (const s of data.strassen) {
    const beiraete = s.beiraete?.length ? s.beiraete : ["ohne Beiratszuordnung"];
    for (const b of beiraete) {
      if (!gruppen.has(b)) gruppen.set(b, []);
      gruppen.get(b).push(s);
    }
  }
  const sortiert = [...gruppen.entries()].sort((a, b) => b[1].length - a[1].length);
  const mitDok = data.strassen.filter((s) => streetDocs.has(s.name)).length;

  box.innerHTML = `<details id="strassen-details">
    <summary><strong>${data.strassen.length} Straßen</strong> im Stadtgebiet${
      mitDok ? ` · ${mitDok} in Ausschussdokumenten` : ""}</summary>
    <div id="strassen-liste">
      ${sortiert.map(([beirat, liste]) => `
        <section class="bezirk" data-beirat="${escHtml(beirat)}">
          <h4>${escHtml(beirat)} <span class="anz">${liste.length}</span></h4>
          <div class="street-chips">
            ${liste.map((s) => {
              const n = streetDocs.get(s.name) ?? 0;
              const grenz = (s.beiraete?.length ?? 0) > 1;
              return `<button type="button" class="chip-street" data-street="${escHtml(s.name)}"
                data-docs="${n}"
                title="${escHtml(grenz ? "Grenzlage, auch in: " + s.beiraete.filter((x) => x !== beirat).join(", ")
                                       : beirat)}${n ? ` · in ${n} Dokument${n === 1 ? "" : "en"}` : ""}">
                ${escHtml(s.name)}${grenz ? ' <span class="grenz">↔</span>' : ""}
                ${n ? `<span class="anzahl">${n}</span>` : ""}
              </button>`;
            }).join("")}
          </div>
        </section>`).join("")}
    </div>
    <p class="quelle">Straßenverzeichnis: ${escHtml(data.quelle ?? "Stadt Erlangen")}
      ${data.stand ? ` · Stand ${escHtml(data.stand)}` : ""}</p>
  </details>`;

  for (const btn of box.querySelectorAll(".chip-street")) {
    btn.addEventListener("click", () => {
      box.querySelector(".chip-street.active")?.classList.remove("active");
      btn.classList.add("active");
      zeigeStrasse(btn.dataset.street);
    });
  }

  const filter = $("strassen-filter");
  const nurDok = $("nur-dokumente");
  const zaehlen = () => {
    const qv = filter.value.trim().toLowerCase();
    const nur = nurDok.checked;
    const sichtbar = new Set();
    for (const sec of box.querySelectorAll(".bezirk")) {
      let inSec = 0;
      for (const btn of sec.querySelectorAll(".chip-street")) {
        const treffer = (!qv || btn.dataset.street.toLowerCase().includes(qv))
                        && (!nur || btn.dataset.docs !== "0");
        btn.hidden = !treffer;
        if (treffer) { inSec++; sichtbar.add(btn.dataset.street); }
      }
      sec.hidden = inSec === 0;
    }
    $("strassen-count").textContent = (qv || nur)
      ? `${sichtbar.size} von ${data.strassen.length}` : `${data.strassen.length} Straßen`;
    // Beim Suchen die Liste aufklappen, sonst sieht man die Treffer nicht.
    if (qv || nur) $("strassen-details").open = true;
  };
  filter.addEventListener("input", zaehlen);
  nurDok.addEventListener("change", zaehlen);
  filter.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter") return;
    ev.preventDefault();
    box.querySelector(".bezirk:not([hidden]) .chip-street:not([hidden])")?.click();
  });
  zaehlen();
}

/**
 * Straße auf der Karte hervorheben und die Dokumente dazu anzeigen.
 * Die Geometrie kommt aus den bereits gezeichneten Layern (streetLayers) —
 * eine Straße besteht dort aus vielen Abschnitten.
 */
function zeigeStrasse(name) {
  const layers = streetLayers.get(name);
  const treffer = $("strassen-treffer");
  const anzahl = streetDocs.get(name) ?? 0;

  if (strasseHighlight) { map.removeLayer(strasseHighlight); strasseHighlight = null; }
  if (layers?.length) {
    const gruppe = L.featureGroup(layers.map((l) => L.geoJSON(l.toGeoJSON(), {
      style: { color: "#eb6834", weight: 7, opacity: 0.95 } })));
    strasseHighlight = gruppe.addTo(map);
    map.fitBounds(gruppe.getBounds(), { padding: [40, 40], maxZoom: 17 });
  }

  treffer.innerHTML = `<div class="treffer-box">
    <h4>${escHtml(name)}</h4>
    ${anzahl
      ? `<p class="t-intro">In ${anzahl} Ausschussdokument${anzahl === 1 ? "" : "en"} genannt —
           <button type="button" id="strasse-docs" class="link-btn">Dokumente in der Liste anzeigen</button></p>`
      : `<p class="t-intro">In den vorliegenden Ausschussdokumenten nicht genannt.</p>`}
    ${layers?.length ? "" : `<p class="t-intro">Kein Tempo-30-Abschnitt hinterlegt —
      die Karte zeigt nur Tempo-30-, Tempo-20- und verkehrsberuhigte Straßen.</p>`}
  </div>`;
  $("strasse-docs")?.addEventListener("click", () => openStreet(name));
  status(anzahl ? `„${name}“ — ${anzahl} Ausschussdokument(e).`
                : `„${name}“ — keine Ausschussdokumente.`);
}

/** Alle Dokumente, die eine bestimmte Straße nennen — in die Trefferliste. */
async function openStreet(name) {
  // Über document_streets, nicht über die TOP-Kanten: ein Tagesordnungspunkt
  // hat oft viele Anlagen, von denen nur eine die Straße wirklich nennt.
  const rows = await q(
    `SELECT d.id, 'doc' AS kind, d.title, d.type_code, d.node_id, d.pages,
            d.summary, n.label AS top_label, n.date::VARCHAR AS date, n.vorlage_nr
     FROM document_streets ds
     JOIN documents d ON d.id = ds.doc_id
     JOIN nodes n ON n.id = d.node_id
     WHERE ds.street = '${esc(name)}'
     ORDER BY n.date DESC, d.title LIMIT 300`);
  showResultList();
  renderResults(rows, `Dokumente: ${name}`);
  status(`${rows.length} Dokument(e) nennen „${name}“.`);
}

/** Von einem Straßen-Chip in der Dokumentansicht auf die Karte springen. */
async function focusStreet(name) {
  await activateTab("map");
  const layers = streetLayers.get(name);
  if (!layers?.length) {
    status(`„${name}“ liegt nicht im Tempo-30-Netz — auf der Karte sind nur ` +
           "Straßen mit Tempo 30/20, verkehrsberuhigte Bereiche und zeitliche Begrenzungen.");
    return;
  }
  const bounds = layers.reduce((b, l) => b.extend(l.getBounds()), L.latLngBounds(
    layers[0].getBounds()));
  map.fitBounds(bounds, { padding: [40, 40], maxZoom: 17 });
  layers[0].openPopup();
  status(`„${name}“ auf der Karte.`);
}

// ── Andere Gremien ───────────────────────────────────────────────────────────
// Was der UVPA berät, entscheidet oft der Stadtrat, und Bauthemen laufen
// parallel im Bauausschuss. gremien_tops.json (tools/fetch_gremien_tops.py)
// hält deren Tagesordnungen — bewusst nur Metadaten, keine Dokumente: die
// Volltexte des Bauausschusses allein wären ein Vielfaches dieses Repos.
// Die Datei liegt neben index.html und nicht in der graph.db, weil sie ohne
// Volltextindex auskommt und der Abschnitt zum Blättern gedacht ist.

let fremdeTops = null;
let gremienFilter = { gremium: "", jahr: "", nurUvpa: false };

async function ladeFremdeTops() {
  if (fremdeTops !== null) return fremdeTops;
  try {
    const r = await fetch("gremien_tops.json");
    if (r.ok) return (fremdeTops = await r.json());
  } catch { /* Datei fehlt */ }
  return (fremdeTops = false);
}

/**
 * Vorlagen, die auch im UVPA lagen.
 *
 * beratungsfolge.json ist genau danach indiziert: Schlüssel sind die kvonr aller
 * Vorlagen, die im UVPA behandelt wurden. Ein Tagesordnungspunkt des Stadtrats
 * mit derselben kvonr ist also nachweislich dieselbe Sache — kein Ratespiel über
 * Titelähnlichkeit.
 */
let uvpaVorlagen = null;
async function ladeUvpaVorlagen() {
  if (uvpaVorlagen) return uvpaVorlagen;
  try {
    const r = await fetch("beratungsfolge.json");
    uvpaVorlagen = r.ok ? new Set(Object.keys(await r.json())) : new Set();
  } catch { uvpaVorlagen = new Set(); }
  return uvpaVorlagen;
}

async function renderFremdeGremien() {
  const daten = await ladeFremdeTops();
  const ziel = $("gremien-view");
  if (!daten) {
    ziel.innerHTML = `<p class="hint">Die Tagesordnungen der anderen Gremien fehlen —
      sie entstehen mit <code>tools/fetch_gremien_tops.py</code> und werden beim
      Deploy neben die Seite kopiert.</p>`;
    return;
  }
  await ladeUvpaVorlagen();

  const alle = daten.tops.filter((t) => !t.routine);
  // Seit der Kommunalwahl 2026 liefert fetch_gremien_tops.py mehrere Perioden;
  // `wahlperiode` (Einzahl) bleibt als Fallback für ältere gremien_tops.json.
  const perioden = (daten.wahlperioden || (daten.wahlperiode ? [daten.wahlperiode] : []))
    .map((p) => p.label).filter(Boolean).join(" und ");
  const jahre = [...new Set(alle.map((t) => (t.datum || "").slice(0, 4)))].sort().reverse();
  const gremien = Object.values(daten.gremien);

  const gefiltert = alle.filter((t) =>
    (!gremienFilter.gremium || t.gremium === gremienFilter.gremium) &&
    (!gremienFilter.jahr || (t.datum || "").startsWith(gremienFilter.jahr)) &&
    (!gremienFilter.nurUvpa || (t.kvonr && uvpaVorlagen.has(t.kvonr))));

  ziel.innerHTML = `<div class="gremien-kopf">
    <p class="hint">Tagesordnungspunkte aus ${escHtml(gremien.join(" und "))} der
      Wahlperiode${perioden.includes(" und ") ? "n" : ""} ${escHtml(perioden)}. Erfasst sind Titel,
      Beschluss und Vorlagennummer — <strong>keine Dokumente</strong>. Für den Volltext
      führt der Link ins Ratsinformationssystem.
      Wiederkehrende Formalpunkte (Anfragen, Mitteilungen) sind ausgeblendet.</p>
    <div class="gremien-filter">
      <label>Gremium <select id="gf-gremium">
        <option value="">alle</option>
        ${gremien.map((g) => `<option${g === gremienFilter.gremium ? " selected" : ""}>${escHtml(g)}</option>`).join("")}
      </select></label>
      <label>Jahr <select id="gf-jahr">
        <option value="">alle</option>
        ${jahre.map((j) => `<option${j === gremienFilter.jahr ? " selected" : ""}>${escHtml(j)}</option>`).join("")}
      </select></label>
      <label><input type="checkbox" id="gf-uvpa"${gremienFilter.nurUvpa ? " checked" : ""}>
        Nur mit Bezug zum UVPA</label>
    </div>
  </div>
  <div id="gremien-liste"></div>
  <p class="ml-credit">Quelle: ${escHtml(daten.quelle || "Ratsinformationssystem der Stadt Erlangen")}
    · Stand ${escHtml(daten.stand || "")}</p>`;

  $("gremien-liste").innerHTML = gefiltert.length
    ? gefiltert.slice(0, 400).map(gremienEintrag).join("") +
      (gefiltert.length > 400
        ? `<p class="hint">… ${gefiltert.length - 400} weitere. Filter enger stellen.</p>` : "")
    : `<p class="hint">Keine Einträge für diese Auswahl.</p>`;

  $("gf-gremium").addEventListener("change", (e) => {
    gremienFilter.gremium = e.target.value; renderFremdeGremien();
  });
  $("gf-jahr").addEventListener("change", (e) => {
    gremienFilter.jahr = e.target.value; renderFremdeGremien();
  });
  $("gf-uvpa").addEventListener("change", (e) => {
    gremienFilter.nurUvpa = e.target.checked; renderFremdeGremien();
  });

  status(`${gefiltert.length} Tagesordnungspunkte aus ${gremien.length} Gremien` +
    (gremienFilter.nurUvpa ? " mit Bezug zum UVPA." : "."));
}

function gremienEintrag(t) {
  const strassen = (t.strassen || []).slice(0, 4)
    .map((s) => `<span class="gr-strasse">${escHtml(s)}</span>`).join("");
  return `<div class="gr-eintrag">
    <div class="gr-kopf">
      <span class="gr-datum">${escHtml(t.datum || "")}</span>
      <span class="gr-gremium">${escHtml(t.gremium)}</span>
      ${t.top ? `<span class="gr-nr">TOP ${escHtml(t.top)}</span>` : ""}
      ${t.kvonr && uvpaVorlagen?.has(t.kvonr)
        ? `<span class="gr-uvpa" title="Dieselbe Vorlage lag auch im UVPA">auch im UVPA</span>` : ""}
    </div>
    <a class="gr-titel" href="${escHtml(safeUrl(t.url))}" target="_blank" rel="noopener">${escHtml(t.titel)}</a>
    ${t.beschluss ? `<div class="gr-beschluss">${escHtml(t.beschluss)}</div>` : ""}
    ${strassen ? `<div class="gr-marker">${strassen}</div>` : ""}
  </div>`;
}

// ── Ämter & Zuständigkeiten ──────────────────────────────────────────────────
//
// Der Ausschuss beschließt, ausgeführt wird in den Fachämtern. Der Tab erklärt
// den Aufbau der Stadtverwaltung (Oberbürgermeister → acht Referate →
// Fachämter mit Amtsnummer) nach dem Geschäftsverteilungsplan und beantwortet
// die praktische Frage, wer für ein Anliegen zuständig ist. Bewusst ohne
// Durchwahlen — dafür verlinkt die Seite die Ämter-Suche der Stadt.

let aemterData = null;

/** content/<name>.json laden; im lokalen Dev liegt content/ eine Ebene höher. */
async function loadContent(name) {
  for (const url of [`content/${name}.json?v=${CONTENT_VERSION}`,
                     `../content/${name}.json?v=${CONTENT_VERSION}`]) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch { /* nächster Pfad */ }
  }
  return null;
}

async function renderAemter() {
  const box = $("aemter-view");
  if (aemterData === null) {
    status("Lade Ämterstruktur …");
    aemterData = await loadContent("aemter") ?? false;
  }
  if (!aemterData) {
    box.innerHTML = `<p class="hint">Die Ämterstruktur fehlt — sie liegt in
      <code>content/aemter.json</code> und wird beim Deploy mitkopiert.</p>`;
    status("Ämterdaten nicht gefunden.");
    return;
  }
  const data = aemterData;
  // Für den UVPA einschlägige Referate hervorheben (Planen/Bauen, Umwelt,
  // öffentlicher Raum) — die übrigen bleiben sichtbar, nur ohne Betonung.
  const schwerpunkt = new Set(data.schwerpunkt_referate || []);

  const amtLabel = (a) =>
    `<span class="amt-name">${escHtml(a.name)}</span>`
    + (a.nr ? `<span class="amt-nr">${escHtml(a.nr)}</span>` : "")
    + (a.leitung ? `<span class="amt-leitung">${escHtml(a.leitung)}</span>` : "");

  const referateGrid = data.referate.map((r, idx) => {
    const nrs = r.aemter.map((a) => a.nr).filter(Boolean).join(", ");
    const wichtig = schwerpunkt.has(r.referat);
    return `<button type="button" data-ref-card="ref-card-${idx}"
      class="org-card org-card-ref${wichtig ? " org-card-schwerpunkt" : ""}"
      title="Zu ${escHtml(r.referat)} springen">
      <div class="org-ref-tag">${escHtml(r.referat)}${
        wichtig ? '<span class="org-ref-star" title="für den UVPA besonders einschlägig">★</span>' : ""}</div>
      <div class="org-ref-title">${escHtml(r.bereich)}</div>
      <div class="org-ref-leitung">${escHtml(r.leitung)}</div>
      ${nrs ? `<div class="org-ref-aemter">Ämter: ${escHtml(nrs)}</div>` : ""}
    </button>`;
  }).join("");

  box.innerHTML = `
    <button type="button" class="crumb-back" data-start>‹ Startseite</button>
    <h2 class="section-title">🏢 Ämter &amp; Zuständigkeiten</h2>
    ${data.intro ? `<p class="section-intro">${escHtml(data.intro)}</p>` : ""}
    <div class="map-actions">
      <a class="btn-primary" href="${escHtml(safeUrl(data.aemter_uebersicht_url))}"
         target="_blank" rel="noopener">Ämter-Suche, Kontakt &amp; Öffnungszeiten ↗</a>
    </div>

    ${data.relevant?.length ? `
      <section class="amt-schnelluebersicht">
        <h3 class="sub-head">Schnellübersicht: Wer ist wofür zuständig?</h3>
        <ul class="zust-list">${data.relevant.map((r) => `<li>
          <span class="z-thema">${escHtml(r.thema)}</span>
          <span class="z-amt">${escHtml(r.amt)}</span></li>`).join("")}</ul>
      </section>` : ""}

    <div class="orgchart-container">
      <h3 class="orgchart-title">📊 Organigramm der Stadtverwaltung Erlangen</h3>
      <div class="orgchart">
        <div class="org-node-top">
          <div class="org-card org-card-ob">
            <div class="org-role">Oberbürgermeister</div>
            <div class="org-name">${escHtml(data.referate[0]?.leitung?.split(" (")[0] ?? "")}</div>
            <div class="org-sub">Leitung der Stadtverwaltung Erlangen</div>
          </div>
        </div>
        <div class="org-tree-line"></div>
        <div class="org-referate-grid">${referateGrid}</div>
      </div>
    </div>

    <section class="amt-structure">
      <h3 class="sub-head">Aufbau der Stadtverwaltung — die Referate im Detail</h3>
      <div class="cards">
        ${data.referate.map((r, idx) => `<div class="card ref-card${
          schwerpunkt.has(r.referat) ? " ref-card-schwerpunkt" : ""}" id="ref-card-${idx}">
          <span class="c-tag">${escHtml(r.referat)}</span>
          <div class="c-title">${escHtml(r.bereich)}</div>
          <div class="c-zust">${escHtml(r.leitung)}</div>
          <ul class="amt-list">${r.aemter.map((a) => `<li>${amtLabel(a)}</li>`).join("")}</ul>
        </div>`).join("")}
      </div>
    </section>

    ${data.stand ? `<p class="quelle">Quelle: Geschäftsverteilungsplan der Stadt Erlangen ·
      ${escHtml(data.stand)}</p>` : ""}`;

  box.querySelector("[data-start]").addEventListener("click", zeigeStart);

  // Klick auf eine Organigramm-Kachel springt zur zugehörigen Detailkarte.
  box.querySelector(".org-referate-grid")?.addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-ref-card]");
    const target = btn && $(btn.getAttribute("data-ref-card"));
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    target.classList.add("ref-card-highlight");
    setTimeout(() => target.classList.remove("ref-card-highlight"), 1800);
  });

  const n = data.referate.reduce((s, r) => s + r.aemter.length, 0);
  status(`${data.referate.length} Referate mit ${n} Ämtern und Einrichtungen.`);
}

// ── Tabs ─────────────────────────────────────────────────────────────────────

const TABS = ["doc", "net", "map", "gremien", "aemter"];

async function activateTab(which) {
  for (const t of TABS) {
    $(`tab-${t}`).classList.toggle("active", t === which);
    $(`panel-${t}`).hidden = t !== which;
  }
  // Auf Mobil den Viewer in den Vordergrund holen (Liste weicht).
  document.body.classList.add("show-viewer");
  if (which === "net") {
    if (!cy) { initCy(); showOverview(); }
    else cy.resize();
  } else if (which === "map") {
    if (!map) await initMap();
    else map.invalidateSize();
  } else if (which === "gremien") {
    await renderFremdeGremien();
  } else if (which === "aemter") {
    await renderAemter();
  }
}

/** Mobil: zurück zur Trefferliste (Viewer weicht). Auf Desktop wirkungslos. */
function showResultList() {
  document.body.classList.remove("show-viewer");
}

// ── Startseite ───────────────────────────────────────────────────────────────
// Die Kacheln sind die erste Ansicht: body.show-start blendet Filterleiste und
// Zwei-Spalten-Ansicht aus. Jede Kachel nennt in data-ziel ihr Ziel — entweder
// einen Tab, die Suche oder die Suche mit vorgewähltem Dokumenttyp.

// Zusammenfassung des Bestands; steht in der Fußzeile, solange die Startseite
// zu sehen ist. Wird nach dem Laden mit den echten Zahlen überschrieben.
let startStatus = "Bereit.";

function zeigeStart() {
  document.body.classList.add("show-start");
  verlasseSeitenModus();
  showResultList();
  status(startStatus);
}

async function oeffneKachel(ziel) {
  document.body.classList.remove("show-start");
  // „Satzung & Recht“ und „Ämter & Zuständigkeiten“ sind in sich geschlossene
  // Inhaltsseiten: ganzseitig, ohne Trefferliste, Filter, Tabs und Suche.
  // Zurück geht es über das Logo zur Startseite.
  if (ziel === "recht") return await renderRechtUebersicht();
  if (ziel === "aemter") {
    document.body.classList.add("mode-seite");
    return await activateTab("aemter");
  }
  verlasseSeitenModus();
  if (ziel === "suche" || ziel.startsWith("typ:")) {
    if (ziel.startsWith("typ:")) {
      $("f-type").value = ziel.slice(4);
      await runSearch();
    }
    await activateTab("doc");
    showResultList();          // Mobil: Trefferliste vor den Viewer holen
    $("search-input").focus();
    return;
  }
  await activateTab(ziel);
}

/** Zurück zur normalen Zwei-Spalten-Ansicht mit Trefferliste, Filtern und Tabs. */
function verlasseSeitenModus() {
  // Die Recht-Übersicht liegt in der Leseansicht — beim Verlassen wieder den
  // Ausgangstext zeigen, sonst stünde sie neben der Trefferliste weiter da.
  if (document.body.classList.contains("mode-recht")) $("doc-view").innerHTML = DOC_HINWEIS;
  document.body.classList.remove("mode-seite", "mode-recht");
}

// ── Filter füllen ────────────────────────────────────────────────────────────

async function populateFilters() {
  const years = await q(
    "SELECT DISTINCT year(date)::INT AS y FROM nodes WHERE type='session' ORDER BY y DESC");
  $("f-year").insertAdjacentHTML("beforeend",
    years.map((r) => `<option value="${r.y}">${r.y}</option>`).join(""));
  const orte = await q("SELECT label FROM nodes WHERE type='ort' ORDER BY label");
  $("f-ort").insertAdjacentHTML("beforeend",
    orte.map((r) => `<option value="${escHtml(r.label)}">${escHtml(r.label)}</option>`).join(""));

  // Themen aus Dokumenten UND Registry (Pläne/Recht) — zeigt nur real Vorhandenes
  const themen = await q(
    `SELECT DISTINCT trim(t) AS thema FROM (
       SELECT unnest(string_split(themen, '|')) AS t FROM documents WHERE themen IS NOT NULL
       UNION ALL
       SELECT unnest(string_split(themen, '|')) AS t FROM plans WHERE themen IS NOT NULL AND themen != ''
     ) WHERE trim(t) != '' ORDER BY thema`);
  $("f-thema").insertAdjacentHTML("beforeend",
    themen.map((r) => `<option value="${escHtml(r.thema)}">${escHtml(r.thema)}</option>`).join(""));

  const antrag = await q(
    "SELECT DISTINCT antragsteller AS a FROM nodes WHERE antragsteller IS NOT NULL ORDER BY 1");
  $("f-antrag").insertAdjacentHTML("beforeend",
    antrag.map((r) => `<option value="${escHtml(r.a)}">${escHtml(r.a)}</option>`).join(""));

  // Orts- und Stadtteilbeiräte aus der Straßenzuordnung (Tabelle streets).
  // Ältere graph.db ohne diese Spalten: Filter bleibt leer und wirkungslos.
  try {
    const beiraete = await q(
      `SELECT DISTINCT trim(b) AS beirat FROM (
         SELECT unnest(string_split(beiraete, '|')) AS b FROM streets
         WHERE beiraete IS NOT NULL AND beiraete != ''
       ) WHERE trim(b) != '' ORDER BY beirat`);
    $("f-beirat").insertAdjacentHTML("beforeend",
      beiraete.map((r) => `<option value="${escHtml(r.beirat)}">${escHtml(r.beirat)}</option>`).join(""));
  } catch { /* Spalte fehlt — Beiratsfilter bleibt ohne Einträge */ }
}

// ── Boot ─────────────────────────────────────────────────────────────────────

$("version").textContent = APP_VERSION;

try {
  await checkAuth();
  bootMsg("Lade Datenbank …");
  const bytes = await loadDbBytes();
  await initDb(bytes);
  await populateFilters();

  // Suche/Filter führen auf Mobil zurück zur Trefferliste (sonst bliebe der
  // Viewer im Vordergrund und die neuen Treffer wären unsichtbar).
  // Die Kopfzeilensuche steht auch auf der Startseite — eine Suche verlässt
  // sie daher immer, sonst bliebe das Ergebnis hinter den Kacheln verborgen.
  // Suche, Filter und ein Klick auf einen Tab verlassen eine ganzseitige
  // Inhaltsansicht; ein Klick auf eine Vorschrift darin (openPlan) nicht.
  $("search-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    document.body.classList.remove("show-start");
    verlasseSeitenModus();
    showResultList();
    runSearch();
  });
  for (const id of ["f-thema", "f-antrag", "f-year", "f-type", "f-ort", "f-beirat", "f-sort"])
    $(id).addEventListener("change", () => { verlasseSeitenModus(); showResultList(); runSearch(); });
  for (const t of TABS)
    $(`tab-${t}`).addEventListener("click", () => { verlasseSeitenModus(); activateTab(t); });
  $("mobile-back").addEventListener("click", showResultList);

  for (const kachel of document.querySelectorAll(".tile"))
    kachel.addEventListener("click", (ev) => {
      ev.preventDefault();
      oeffneKachel(kachel.dataset.ziel);
    });
  $("home-link").addEventListener("click", (ev) => { ev.preventDefault(); zeigeStart(); });

  await runSearch();   // Startansicht: neueste Dokumente
  $("boot").hidden = true;

  const [meta] = await q(
    `SELECT (SELECT count(*) FROM documents)::INT AS d,
            (SELECT count(*) FROM documents WHERE text IS NOT NULL)::INT AS t,
            (SELECT count(*) FROM nodes)::INT AS n`);
  startStatus = `Bereit — ${meta.d} Dokumente (${meta.t} mit Volltext), ${meta.n} Knoten. `
    + `Wählen Sie einen Bereich oder suchen Sie oben.`;
  status(startStatus);
} catch (err) {
  bootMsg(`Fehler: ${err.message}`);
  console.error(err);
}
