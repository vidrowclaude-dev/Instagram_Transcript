/* Reel Vault dashboard: vanilla JS, no build step. */
(() => {
  "use strict";

  const $app = document.getElementById("app");
  const $viewer = document.getElementById("viewer");
  let CONFIG = null;
  let cleanup = [];

  // ---------- helpers ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtNum = (n) => {
    if (n == null) return "–";
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M";
    if (n >= 1e4) return Math.round(n / 1e3) + "K";
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
    return String(n);
  };
  const fmtDur = (s) => (s == null ? "" : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`);
  const fmtDate = (iso) => (iso ? new Date(iso + (iso.endsWith("Z") ? "" : "Z")).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "–");
  const fmtWhen = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "");
  const fmtBytes = (b) => {
    if (!b) return "0 MB";
    const u = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
    return (b / 1024 ** i).toFixed(i >= 3 ? 1 : 0) + " " + u[i];
  };
  const ts = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

  const STATUS_LABEL = {
    previewing: "Looking up videos", ready: "Ready to download", queued: "Queued", running: "Running",
    cooling_down: "Cooling down", completed: "Completed", completed_with_errors: "Completed with errors",
    failed: "Failed", cancelled: "Cancelled",
  };
  const REASON_LABEL = {
    private: "Private account", not_found: "Not found or removed", rate_limited: "Rate-limited",
    login_required: "Needs a login session", no_audio: "No audio", not_a_video: "Not a video",
    download_failed: "Download failed", transcription_failed: "Transcription failed",
    engine_not_configured: "Engine not set up", invalid_input: "Invalid link", no_videos: "No videos", error: "Error",
  };
  const MODE_LABEL = { download: "Download only", download_transcribe: "Download + transcribe", transcribe: "Transcribe only" };
  const ACTIVE = new Set(["previewing", "queued", "running", "cooling_down"]);

  async function api(path, opts = {}) {
    const init = { ...opts, headers: { ...(opts.headers || {}) } };
    if (opts.json !== undefined) {
      init.body = JSON.stringify(opts.json);
      init.headers["Content-Type"] = "application/json";
      init.method = init.method || "POST";
    }
    const r = await fetch(path, init);
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!r.ok) {
      const d = data && data.detail;
      const msg = (d && (d.message || (typeof d === "string" ? d : null))) || `Request failed (${r.status})`;
      throw new Error(msg);
    }
    return data;
  }

  let toastTimer;
  function toast(msg) {
    document.querySelector(".toast")?.remove();
    const el = document.createElement("div");
    el.className = "toast";
    el.setAttribute("role", "status");
    el.textContent = msg;
    document.body.appendChild(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), 3200);
  }

  async function config(force = false) {
    if (!CONFIG || force) CONFIG = await api("/api/config");
    return CONFIG;
  }

  // ---------- router ----------
  const routes = [
    [/^#?\/?$/, "new", viewNew],
    [/^#\/jobs$/, "jobs", viewJobs],
    [/^#\/job\/([\w-]+)$/, "jobs", viewJob],
    [/^#\/search$/, "search", viewSearch],
    [/^#\/settings$/, "settings", viewSettings],
  ];

  async function route() {
    cleanup.forEach((fn) => fn());
    cleanup = [];
    const hash = location.hash.split("?")[0] || "#/";
    for (const [re, nav, fn] of routes) {
      const m = hash.match(re);
      if (m) {
        document.querySelectorAll("[data-nav]").forEach((a) => (a.dataset.nav === nav ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
        try { await fn(...m.slice(1)); } catch (e) { $app.innerHTML = `<div class="notice bad"><span class="dot"></span><div>${esc(e.message)}</div></div>`; }
        return;
      }
    }
    location.hash = "#/";
  }
  window.addEventListener("hashchange", route);

  // ---------- New job ----------
  async function viewNew() {
    const cfg = await config();
    document.title = "Reel Vault";
    $app.innerHTML = `
      <h1>Pull videos from Instagram</h1>
      <p class="lede">Paste a profile link, an @handle, or Reel links (one per line). You'll see every video first and pick what to download.</p>
      <form id="new" class="compose" novalidate>
        <div>
          <label class="sr-only" for="inputs">Profiles or links</label>
          <textarea id="inputs" class="paste" placeholder="https://www.instagram.com/brandname/&#10;@anotherbrand&#10;https://www.instagram.com/reel/C9xYz.../" required></textarea>
          <div id="form-error"></div>
          <div class="compose-actions">
            <button class="btn primary" type="submit" id="go">Find videos</button>
            <span class="muted small">Nothing downloads until you confirm the list.</span>
          </div>
          <div class="notice" style="margin-top:18px"><span class="dot"></span><div>${esc(cfg.rate_limit_warning)} ${cfg.cookies.valid ? "" : 'For more reach, add your session in <a href="#/settings">Settings</a>.'}</div></div>
          ${cfg.demo_mode ? `<div class="notice info" style="margin-top:10px"><span class="dot"></span><div>Demo mode is on. Try <code>@demo_brand</code>, <code>@demo_private</code> or <code>@demo_missing</code>.</div></div>` : ""}
        </div>
        <div class="panel filters">
          <h2>Filters</h2>
          <div>
            <div class="field small muted" style="font-weight:600;margin-bottom:6px">Content</div>
            <div class="seg" role="radiogroup" aria-label="Content type">
              <label><input type="radio" name="content_type" value="reels" checked><span>Reels only</span></label>
              <label><input type="radio" name="content_type" value="all_videos"><span>All video posts</span></label>
            </div>
          </div>
          <div class="row2">
            <label class="field">From<input type="date" name="date_from"></label>
            <label class="field">To<input type="date" name="date_to"></label>
          </div>
          <div class="row2">
            <label class="field">Latest<input type="number" name="latest_n" min="1" placeholder="All"></label>
            <label class="field">Min views<input type="number" name="min_views" min="0" step="1000" placeholder="Any"></label>
          </div>
          <div>
            <div class="field small muted" style="font-weight:600;margin-bottom:6px">Sort</div>
            <div class="seg" role="radiogroup" aria-label="Sort">
              <label><input type="radio" name="sort" value="newest" checked><span>Newest</span></label>
              <label><input type="radio" name="sort" value="most_viewed"><span>Most viewed</span></label>
            </div>
          </div>
          <p class="small muted" style="margin:0">Sorting by views reads the whole profile (up to 600 posts), so it's slower.</p>
        </div>
      </form>`;
    const form = document.getElementById("new");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const btn = document.getElementById("go");
      const errBox = document.getElementById("form-error");
      errBox.innerHTML = "";
      const inputs = document.getElementById("inputs").value.trim();
      if (!inputs) {
        errBox.innerHTML = `<p class="small" style="color:var(--bad);margin:8px 0 0">Paste at least one profile or Reel link.</p>`;
        return;
      }
      btn.disabled = true;
      btn.textContent = "Starting…";
      try {
        const filters = Object.fromEntries([...fd.entries()].filter(([, v]) => v !== ""));
        const { job_id } = await api("/api/jobs/preview", { json: { inputs, filters } });
        location.hash = `#/job/${job_id}`;
      } catch (err) {
        errBox.innerHTML = `<p class="small" style="color:var(--bad);margin:8px 0 0">${esc(err.message)}</p>`;
        btn.disabled = false;
        btn.textContent = "Find videos";
      }
    });
    document.getElementById("inputs").focus();
  }

  // ---------- Job ----------
  async function viewJob(jobId) {
    const cfg = await config();
    let job = await api(`/api/jobs/${jobId}`);
    const picked = new Set(job.videos.filter((v) => v.selected).map((v) => v.shortcode));
    let shellFor = null; // status bucket the shell was built for

    const es = new EventSource(`/api/jobs/${jobId}/events`);
    es.onmessage = (ev) => { job = JSON.parse(ev.data); render(); };
    es.addEventListener("gone", () => { es.close(); location.hash = "#/jobs"; });
    cleanup.push(() => es.close());
    let ticker = setInterval(() => renderCooldown(), 1000);
    cleanup.push(() => clearInterval(ticker));

    function bucket(j) {
      if (j.status === "previewing") return "previewing";
      if (j.status === "ready") return "ready:" + j.videos.length;
      if (j.status === "failed" && !j.videos.length) return "empty";
      return "run:" + j.videos.length;
    }

    function render() {
      document.title = `${job.title} · Reel Vault`;
      const b = bucket(job);
      if (b !== shellFor) { buildShell(); shellFor = b; }
      patch();
    }

    function buildShell() {
      const choosing = job.status === "ready";
      $app.innerHTML = `
        <div class="job-head">
          <div>
            <h1 id="job-title">${esc(job.title)}</h1>
            <div class="status-line"><span class="pill" id="pill"></span><span id="job-msg"></span></div>
          </div>
          <div class="job-actions" id="job-actions"></div>
        </div>
        <div id="job-notices"></div>
        ${job.status === "previewing" ? previewingBlock() : job.videos.length ? `
        <div class="strip-wrap" ${choosing ? "hidden" : ""}>
          <div class="strip" id="strip" role="img" aria-label="Progress per video"></div>
          <div class="counts" id="counts"></div>
        </div>
        <div class="layout">
          <section>
            <div class="grid-tools">
              <div class="muted small" id="pick-count"></div>
              ${choosing ? `<div style="display:flex;gap:6px">
                <button class="btn sm ghost" id="pick-all" type="button">Select all</button>
                <button class="btn sm ghost" id="pick-none" type="button">Clear</button></div>` : ""}
            </div>
            <div class="sheet" id="sheet"></div>
          </section>
          <aside class="side" id="side"></aside>
        </div>` : `<div class="empty"><h2>No videos to show</h2><p>${esc(job.error || "Nothing matched.")}</p><p><a class="btn" href="#/">Try another link</a></p></div>`}`;

      const sheet = document.getElementById("sheet");
      if (sheet) {
        sheet.innerHTML = (choosing ? job.videos : job.videos.filter((v) => v.selected)).map(frameHTML).join("");
        sheet.addEventListener("click", (e) => {
          const pick = e.target.closest(".pick");
          const fr = e.target.closest(".frame");
          if (!fr) return;
          if (pick) return; // handled by change
          const v = job.videos.find((x) => x.id === +fr.dataset.id);
          if (job.status === "ready") { togglePick(v.shortcode); return; }
          if (v.has_video || v.has_transcript) openViewer(v.id);
          else if (v.status === "failed") toast(v.fail_detail || REASON_LABEL[v.fail_reason] || "Failed");
          else toast("Not downloaded yet");
        });
        sheet.addEventListener("change", (e) => {
          if (e.target.matches(".pick input")) togglePick(e.target.dataset.sc, e.target.checked);
        });
        sheet.addEventListener("keydown", (e) => {
          if ((e.key === "Enter" || e.key === " ") && e.target.classList.contains("frame")) { e.preventDefault(); e.target.click(); }
        });
      }
      document.getElementById("pick-all")?.addEventListener("click", () => { job.videos.forEach((v) => picked.add(v.shortcode)); patch(); });
      document.getElementById("pick-none")?.addEventListener("click", () => { picked.clear(); patch(); });
      const side = document.getElementById("side");
      if (side) { side.innerHTML = choosing ? optionsPanel(cfg) : summaryPanel(); wireSide(side); }
    }

    function previewingBlock() {
      return `<div class="empty" style="border-style:solid;background:var(--surface)">
        <h2>Reading the profile…</h2>
        <p>Instagram lists 12 posts per request, with a pause between each, so big profiles take a minute. You can leave this page; the lookup keeps going.</p>
      </div>`;
    }

    function frameHTML(v) {
      const choosing = job.status === "ready";
      return `<div class="frame" tabindex="0" role="button" data-id="${v.id}" data-sc="${esc(v.shortcode)}" data-status="${v.status}" aria-label="${esc((v.caption || v.shortcode).slice(0, 80))}">
        <div class="shot">
          ${v.has_thumbnail ? `<img loading="lazy" alt="" src="/api/videos/${v.id}/thumb" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'noimg',textContent:'No preview'}))">` : `<div class="noimg">No preview</div>`}
          ${choosing ? `<span class="pick"><input type="checkbox" data-sc="${esc(v.shortcode)}" aria-label="Select ${esc(v.shortcode)}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>` : ""}
          ${v.is_paid_partnership ? `<span class="tag" title="Paid partnership">Paid</span>` : ""}
          ${v.duration ? `<span class="dur">${fmtDur(v.duration)}</span>` : ""}
          <span class="state"></span>
        </div>
        <div class="meta">
          <div class="nums"><span>${fmtNum(v.views)} views</span><span class="muted">${fmtNum(v.likes)} ♥</span></div>
          <div class="muted">${fmtDate(v.posted_at)}</div>
          <div class="cap">${esc(v.caption || "")}</div>
          <div class="why" data-why></div>
        </div>
      </div>`;
    }

    function togglePick(sc, on) {
      const want = on === undefined ? !picked.has(sc) : on;
      want ? picked.add(sc) : picked.delete(sc);
      patch();
    }

    function optionsPanel(c) {
      const engines = c.engines.map((e) => `<option value="${e.id}" ${e.id === c.default_engine ? "selected" : ""} ${e.ready ? "" : "disabled"}>${esc(e.label)}${e.ready ? "" : " (not set up)"}</option>`).join("");
      const models = c.whisper_models.map((m) => `<option ${m === c.default_model ? "selected" : ""}>${m}</option>`).join("");
      return `<form class="panel opts" id="start-form">
        <h2>What to get</h2>
        <div class="radio-list">
          <label><input type="radio" name="mode" value="download" checked><span>Download only<small>MP4, thumbnail, caption, metadata</small></span></label>
          <label><input type="radio" name="mode" value="download_transcribe"><span>Download + transcribe<small>Everything, plus .txt, .srt and .json transcripts</small></span></label>
          <label><input type="radio" name="mode" value="transcribe"><span>Transcribe only<small>Videos are deleted once transcribed</small></span></label>
        </div>
        <div id="tx-opts" hidden style="display:grid;gap:12px">
          <label class="field">Engine<select name="engine">${engines}</select></label>
          <label class="field" id="model-field">Whisper model<select name="model">${models}</select></label>
          <label class="field">Language<select name="language">
            <option value="auto">Detect automatically</option>
            <option value="hinglish">Hinglish (Hindi + English mix)</option>
            <option value="hi">Hindi</option>
            <option value="en">English</option>
          </select></label>
          <div>
            <div class="small muted" style="font-weight:600;margin-bottom:6px">Hindi written as</div>
            <div class="seg">
              <label><input type="radio" name="script" value="roman" checked><span>Hinglish</span></label>
              <label><input type="radio" name="script" value="native"><span>देवनागरी</span></label>
            </div>
          </div>
          <label class="field">Hook length (seconds)<input type="number" name="hook_seconds" min="1" max="15" step="0.5" value="${c.hook_seconds}"></label>
        </div>
        <div id="start-error"></div>
        <button class="btn primary" type="submit" id="start-btn">Download</button>
      </form>`;
    }

    function summaryPanel() {
      const o = job.options || {};
      const tx = job.mode !== "download";
      return `<div class="panel">
        <h3>${esc(MODE_LABEL[job.mode] || "")}</h3>
        ${tx ? `<p class="small muted" style="margin:0 0 12px">${esc((o.engine || "").replace("_", "-"))}${o.engine === "faster_whisper" ? " " + esc(o.model || "") : ""} · ${esc(o.language === "auto" ? "auto language" : o.language || "")} · ${o.script === "roman" ? "Hinglish" : "Devanagari"}</p>` : ""}
        <div style="display:grid;gap:8px" id="downloads"></div>
      </div>
      <div class="panel small muted" id="filters-used"></div>`;
    }

    function wireSide(side) {
      const form = side.querySelector("#start-form");
      if (form) {
        const sync = () => {
          const mode = form.mode.value;
          form.querySelector("#tx-opts").hidden = mode === "download";
          form.querySelector("#model-field").hidden = form.engine.value !== "faster_whisper";
          form.querySelector("#start-btn").textContent = { download: "Download", download_transcribe: "Download and transcribe", transcribe: "Transcribe" }[mode] + ` ${picked.size} video${picked.size === 1 ? "" : "s"}`;
        };
        form.addEventListener("change", sync);
        sync();
        form._sync = sync;
        form.addEventListener("submit", async (e) => {
          e.preventDefault();
          const btn = form.querySelector("#start-btn");
          const err = form.querySelector("#start-error");
          err.innerHTML = "";
          if (!picked.size) { err.innerHTML = `<p class="small" style="color:var(--bad);margin:0">Select at least one video.</p>`; return; }
          btn.disabled = true;
          try {
            await api(`/api/jobs/${jobId}/start`, { json: {
              shortcodes: [...picked], mode: form.mode.value, engine: form.engine.value, model: form.model.value,
              language: form.language.value, script: form.script.value, hook_seconds: +form.hook_seconds.value || null,
            } });
          } catch (ex) {
            err.innerHTML = `<p class="small" style="color:var(--bad);margin:0">${esc(ex.message)}</p>`;
            btn.disabled = false;
          }
        });
      }
    }

    function renderCooldown() {
      const el = document.getElementById("cooldown-left");
      if (!el || !job.cooldown_until) return;
      const left = Math.max(0, Math.round((new Date(job.cooldown_until) - Date.now()) / 1000));
      el.textContent = left ? `Retrying in ${ts(left)}.` : "Retrying now…";
    }

    function patch() {
      const pill = document.getElementById("pill");
      if (pill) { pill.className = `pill ${job.status}`; pill.textContent = STATUS_LABEL[job.status] || job.status; }
      const msg = document.getElementById("job-msg");
      if (msg) msg.textContent = job.status === "ready" ? `${job.videos.length} found` : (job.message || "");

      // notices
      const notices = [];
      if (job.status === "cooling_down") notices.push(`<div class="notice"><span class="dot"></span><div><b>Instagram is rate-limiting.</b> ${esc(job.message || "")} <span id="cooldown-left"></span> Nothing is lost; finished videos stay finished.</div></div>`);
      if (job.status === "failed" && job.error && job.videos.length) notices.push(`<div class="notice bad"><span class="dot"></span><div>${esc(job.error)}</div></div>`);
      (job.input_errors || []).forEach((e) => notices.push(`<div class="notice bad"><span class="dot"></span><div><b>${esc(e.raw)}</b>: ${esc(e.message)}${e.reason === "login_required" || e.reason === "private" ? ' <a href="#/settings">Add your session</a>' : ""}</div></div>`));
      const nbox = document.getElementById("job-notices");
      if (nbox) { nbox.className = notices.length ? "errors" : ""; nbox.innerHTML = notices.join(""); renderCooldown(); }

      // actions
      const act = document.getElementById("job-actions");
      if (act) {
        const btns = [];
        if (ACTIVE.has(job.status)) btns.push(`<button class="btn" data-act="cancel">Cancel</button>`);
        if (["completed", "completed_with_errors", "failed", "cancelled"].includes(job.status) && job.mode && job.counts.selected) {
          if (job.counts.failed || job.status === "cancelled" || job.status === "failed") btns.push(`<button class="btn" data-act="rerun">${job.status === "cancelled" ? "Resume" : "Retry failed"}</button>`);
        }
        if (job.status === "failed" && !job.videos.length) btns.push(`<button class="btn" data-act="refresh">Look up again</button>`);
        if (!ACTIVE.has(job.status)) btns.push(`<button class="btn ghost danger" data-act="delete">Delete</button>`);
        act.innerHTML = btns.join("");
        act.onclick = async (e) => {
          const a = e.target.closest("[data-act]")?.dataset.act;
          if (!a) return;
          try {
            if (a === "cancel") await api(`/api/jobs/${jobId}/cancel`, { method: "POST" });
            if (a === "rerun") await api(`/api/jobs/${jobId}/rerun`, { json: { only_failed: true } });
            if (a === "refresh") await api(`/api/jobs/${jobId}/refresh-preview`, { method: "POST" });
            if (a === "delete") {
              if (!confirm("Delete this job and the files only it uses? Files shared with other jobs are kept.")) return;
              const r = await api(`/api/jobs/${jobId}`, { method: "DELETE" });
              toast(`Deleted. Freed ${fmtBytes(r.freed_bytes)}.`);
              location.hash = "#/jobs";
            }
          } catch (ex) { toast(ex.message); }
        };
      }

      // strip + counts
      const strip = document.getElementById("strip");
      if (strip) {
        const sel = job.videos.filter((v) => v.selected);
        const activeIdx = ACTIVE.has(job.status) ? sel.findIndex((v) => v.status === "pending" || v.status === "downloaded" || v.status === "transcribed") : -1;
        if (strip.children.length !== sel.length) strip.innerHTML = sel.map(() => "<i></i>").join("");
        sel.forEach((v, i) => { strip.children[i].className = i === activeIdx ? "active" : v.status; strip.children[i].title = `${v.shortcode}: ${v.status}`; });
        const c = job.counts;
        const tx = job.mode !== "download";
        document.getElementById("counts").innerHTML =
          `<span><b>${c.selected}</b>selected</span>` +
          (job.mode !== "transcribe" ? `<span><b>${c.downloaded}</b>downloaded</span>` : "") +
          (tx ? `<span><b>${c.transcribed}</b>transcribed</span>` : "") +
          `<span><b>${c.failed}</b>failed</span>`;
      }

      // frames
      const sheet = document.getElementById("sheet");
      if (sheet) {
        job.videos.forEach((v) => {
          const fr = sheet.querySelector(`.frame[data-id="${v.id}"]`);
          if (!fr) return;
          fr.dataset.status = v.status;
          const on = job.status === "ready" ? picked.has(v.shortcode) : v.selected;
          fr.classList.toggle("off", !on);
          const cb = fr.querySelector(".pick input");
          if (cb) cb.checked = on;
          const why = fr.querySelector("[data-why]");
          why.textContent = v.status === "failed" ? (REASON_LABEL[v.fail_reason] || "Failed") : v.fail_reason === "no_audio" ? "No audio" : "";
          if (v.has_thumbnail && !fr.querySelector("img") && fr.querySelector(".noimg") && v.status === "done") {
            fr.querySelector(".noimg").outerHTML = `<img alt="" src="/api/videos/${v.id}/thumb?t=1">`;
          }
        });
        const pc = document.getElementById("pick-count");
        if (pc) pc.textContent = job.status === "ready" ? `${picked.size} of ${job.videos.length} selected. Click a frame to toggle it.` : `${job.counts.selected} videos. Click one to watch it and read its transcript.`;
        document.getElementById("start-form")?._sync?.();
      }

      // downloads
      const dl = document.getElementById("downloads");
      if (dl) {
        const ready = !ACTIVE.has(job.status) && job.counts.done + job.counts.failed > 0;
        dl.innerHTML = ready ? `
          <a class="btn primary" href="/api/jobs/${jobId}/zip" download>Download ZIP</a>
          <a class="btn" href="/api/jobs/${jobId}/metadata.csv" download>metadata.csv</a>
          ${job.mode !== "download" ? `<a class="btn" href="/api/jobs/${jobId}/transcripts.csv" download>transcripts.csv</a>` : ""}
          <p class="small muted" style="margin:4px 0 0">The ZIP has videos, thumbnails, captions, transcripts and both CSVs. Big jobs take a moment to pack.</p>`
          : `<p class="small muted" style="margin:0">Downloads appear here when the job finishes.</p>`;
      }
      const fu = document.getElementById("filters-used");
      if (fu) {
        const f = job.filters || {};
        const parts = [f.content_type === "all_videos" ? "All video posts" : "Reels only"];
        if (f.date_from || f.date_to) parts.push(`${f.date_from || "…"} to ${f.date_to || "today"}`);
        if (f.latest_n) parts.push(`latest ${f.latest_n}`);
        if (f.min_views) parts.push(`${fmtNum(f.min_views)}+ views`);
        parts.push(f.sort === "most_viewed" ? "most viewed first" : "newest first");
        fu.innerHTML = `<b style="color:var(--ink)">Filters</b><br>${esc(parts.join(", "))}<br><span>Started ${esc(fmtWhen(job.created_at))}</span>`;
      }
    }

    render();
  }

  // ---------- Viewer ----------
  async function openViewer(videoId) {
    const v = await api(`/api/videos/${videoId}`);
    const segs = v.segments || [];
    $viewer.innerHTML = `
      <div class="viewer-body">
        <div class="viewer-media">
          ${v.has_video ? `<video id="player" controls playsinline preload="metadata" poster="/api/videos/${v.id}/thumb" src="/api/videos/${v.id}/file"></video>`
            : `<img alt="" src="/api/videos/${v.id}/thumb">`}
        </div>
        <div class="viewer-text">
          <div class="viewer-head">
            <div>
              <h2 id="viewer-title">@${esc(v.handle)}</h2>
              <div class="small muted">${fmtDate(v.posted_at)} · ${fmtNum(v.views)} views · ${fmtNum(v.likes)} likes${v.duration ? " · " + fmtDur(v.duration) : ""}</div>
            </div>
            <button class="btn sm ghost" id="close-viewer" aria-label="Close">Close</button>
          </div>
          ${v.hook ? `<div class="hook"><b>Hook</b>: ${esc(v.hook)}</div>` : ""}
          <div class="segments" id="segs">
            ${segs.length ? segs.map((s, i) => `<button class="seg-row" data-i="${i}" data-t="${s.start}"><time>${ts(s.start)}</time><span>${esc(s.text)}</span></button>`).join("")
              : `<p class="muted" style="padding:8px">${v.video_deleted ? "" : "No transcript yet. "}${esc(v.caption || "")}</p>`}
          </div>
          <div class="viewer-foot">
            <a href="${esc(v.url)}" target="_blank" rel="noopener">Open on Instagram</a>
            ${v.has_transcript ? `<span class="muted">Transcript:</span>
              <a href="/api/videos/${v.id}/transcript.txt" download>.txt</a>
              <a href="/api/videos/${v.id}/transcript.srt" download>.srt</a>
              <a href="/api/videos/${v.id}/transcript.json" download>.json</a>
              <span class="muted">${esc(v.transcript_language || "")} · ${esc(v.transcript_engine || "")}</span>` : ""}
            ${v.video_deleted ? `<span class="muted">Video removed after transcription</span>` : ""}
          </div>
        </div>
      </div>`;
    $viewer.showModal();
    const player = document.getElementById("player");
    const rows = [...$viewer.querySelectorAll(".seg-row")];
    $viewer.querySelector("#segs").addEventListener("click", (e) => {
      const row = e.target.closest(".seg-row");
      if (!row || !player) return;
      player.currentTime = +row.dataset.t + 0.01;
      player.play().catch(() => {});
    });
    if (player && rows.length) {
      player.addEventListener("timeupdate", () => {
        const t = player.currentTime;
        let cur = -1;
        segs.forEach((s, i) => { if (t >= s.start && t < (s.end || s.start + 2)) cur = i; });
        rows.forEach((r, i) => r.classList.toggle("now", i === cur));
        if (cur >= 0) rows[cur].scrollIntoView({ block: "nearest" });
      });
    }
    $viewer.querySelector("#close-viewer").onclick = () => $viewer.close();
  }
  $viewer.addEventListener("close", () => { $viewer.querySelector("video")?.pause(); $viewer.innerHTML = ""; });
  $viewer.addEventListener("click", (e) => { if (e.target === $viewer) $viewer.close(); });

  // ---------- Jobs ----------
  async function viewJobs() {
    document.title = "Jobs · Reel Vault";
    const [jobs, st] = await Promise.all([api("/api/jobs"), api("/api/storage")]);
    $app.innerHTML = `
      <h1>Jobs</h1>
      <p class="lede">Everything you've pulled. Files are shared across jobs, so a Reel downloaded twice is only stored once.</p>
      <div class="panel storage">
        <div><div class="big">${fmtBytes(st.total_bytes)}</div><div class="small muted">used in ${esc(st.data_dir)}</div></div>
        <div><div class="big">${fmtBytes(st.disk_free_bytes)}</div><div class="small muted">free on disk</div></div>
        <div style="margin-left:auto;display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn" id="clear-cache">Clear cache and old ZIPs (${fmtBytes(st.cache_bytes + st.exports_bytes)})</button>
          <button class="btn danger" id="clear-old">Delete all but the last 10 jobs</button>
        </div>
      </div>
      ${jobs.length ? `<div class="panel tbl-wrap" style="padding:6px 10px"><table class="table">
        <thead><tr><th>Job</th><th>Status</th><th class="hide-sm">Mode</th><th>Videos</th><th class="hide-sm">Size</th><th class="hide-sm">Started</th><th></th></tr></thead>
        <tbody>${jobs.map((j) => {
          const size = st.jobs.find((x) => x.job_id === j.id)?.bytes || 0;
          const c = j.counts;
          return `<tr>
            <td><a class="title" href="#/job/${j.id}">${esc(j.title)}</a></td>
            <td><span class="pill ${j.status}">${esc(STATUS_LABEL[j.status] || j.status)}</span></td>
            <td class="hide-sm muted">${j.status === "ready" || j.status === "previewing" ? "–" : esc(MODE_LABEL[j.mode] || "")}</td>
            <td>${c.selected}${c.failed ? ` <span style="color:var(--bad)">(${c.failed} failed)</span>` : ""}</td>
            <td class="hide-sm muted">${fmtBytes(size)}</td>
            <td class="hide-sm muted">${esc(fmtWhen(j.created_at))}</td>
            <td style="text-align:right;white-space:nowrap">
              ${["completed", "completed_with_errors"].includes(j.status) ? `<a class="btn sm" href="/api/jobs/${j.id}/zip" download>ZIP</a>` : ""}
              ${["completed", "completed_with_errors", "failed", "cancelled"].includes(j.status) ? `<button class="btn sm" data-rerun="${j.id}">Re-run</button>` : ""}
            </td></tr>`;
        }).join("")}</tbody></table></div>`
        : `<div class="empty"><h2>No jobs yet</h2><p>Paste a profile link to make your first one.</p><p><a class="btn primary" href="#/">New job</a></p></div>`}`;
    $app.onclick = async (e) => {
      const id = e.target.closest("[data-rerun]")?.dataset.rerun;
      if (id) {
        try { await api(`/api/jobs/${id}/rerun`, { json: { only_failed: false } }); location.hash = `#/job/${id}`; } catch (ex) { toast(ex.message); }
      }
    };
    cleanup.push(() => ($app.onclick = null));
    document.getElementById("clear-cache").onclick = async () => {
      const r = await api("/api/storage/clear-cache", { method: "POST" });
      toast(`Freed ${fmtBytes(r.freed_bytes)}`);
      viewJobs();
    };
    document.getElementById("clear-old").onclick = async () => {
      if (!confirm("Delete every finished job except the 10 most recent, with the files only they use?")) return;
      const r = await api("/api/storage/clear-old?keep_last=10", { method: "POST" });
      toast(`Deleted ${r.deleted_jobs} jobs, freed ${fmtBytes(r.freed_bytes)}`);
      viewJobs();
    };
  }

  // ---------- Search ----------
  async function viewSearch() {
    document.title = "Search · Reel Vault";
    const q0 = new URLSearchParams(location.hash.split("?")[1] || "").get("q") || "";
    $app.innerHTML = `
      <h1>Search transcripts</h1>
      <p class="lede">Find every Reel in your library that says something: a hook, a product name, a phrase. Captions and handles are searched too.</p>
      <form id="sform" style="display:flex;gap:8px;max-width:640px;margin-bottom:20px">
        <label class="sr-only" for="q">Search</label>
        <input id="q" type="search" placeholder="e.g. paisa bachana, free trial, skincare" value="${esc(q0)}" minlength="2">
        <button class="btn primary" type="submit">Search</button>
      </form>
      <div id="sres"></div>`;
    const run = async (q) => {
      const box = document.getElementById("sres");
      if (!q || q.length < 2) { box.innerHTML = ""; return; }
      const r = await api(`/api/search?q=${encodeURIComponent(q)}`);
      const term = q.split(/\s+/)[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const hl = (s) => esc(s).replace(new RegExp(term, "gi"), (m) => `<mark>${m}</mark>`);
      box.innerHTML = r.results.length ? `<p class="small muted">${r.results.length} result${r.results.length === 1 ? "" : "s"} from ${r.library_transcripts} transcribed Reels.</p>
        <div class="results">${r.results.map((v) => `<button class="result" data-id="${v.id}">
          <div class="shot"><img loading="lazy" alt="" src="/api/videos/${v.id}/thumb" onerror="this.remove()"></div>
          <div><div><b>@${esc(v.handle)}</b> <span class="small muted">${fmtDate(v.posted_at)} · ${fmtNum(v.views)} views</span></div>
          <div class="small">${hl(v.snippet)}</div></div></button>`).join("")}</div>`
        : `<div class="empty"><h2>No matches for “${esc(q)}”</h2><p>Only transcribed Reels and captions are searched. Try fewer words.</p></div>`;
    };
    document.getElementById("sform").onsubmit = (e) => {
      e.preventDefault();
      const q = document.getElementById("q").value.trim();
      history.replaceState(null, "", `#/search?q=${encodeURIComponent(q)}`);
      run(q).catch((ex) => toast(ex.message));
    };
    document.getElementById("sres").onclick = (e) => { const b = e.target.closest(".result"); if (b) openViewer(+b.dataset.id); };
    if (q0) run(q0);
    document.getElementById("q").focus();
  }

  // ---------- Settings ----------
  async function viewSettings() {
    document.title = "Settings · Reel Vault";
    const cfg = await config(true);
    const ck = cfg.cookies;
    $app.innerHTML = `
      <h1>Settings</h1>
      <p class="lede">Your Instagram session, transcription engines and rate limits.</p>
      <div class="settings">
        <section class="panel">
          <h2>Instagram session</h2>
          <p class="muted" style="margin-top:0">Public profiles work without this. Adding your own browser session lets Reel Vault see what your account can see and makes rate limits less strict. Your password is never asked for or stored.</p>
          <div class="notice ${ck.valid ? "info" : ck.present ? "bad" : ""}" style="margin-bottom:14px"><span class="dot"></span><div>${esc(ck.message)}${ck.expires ? ` Session expires ${esc(fmtWhen(ck.expires))}.` : ""}</div></div>
          <form id="ckform" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
            <label class="btn" for="ckfile">Choose cookies.txt</label>
            <input id="ckfile" type="file" accept=".txt,text/plain" class="sr-only">
            ${ck.present ? `<button class="btn ghost danger" type="button" id="ckdel">Remove session</button>` : ""}
            <span class="small muted" id="ckname"></span>
          </form>
          <h3 style="margin-top:18px">How to export cookies.txt from Chrome</h3>
          <ol class="steps small">
            <li>Log in to instagram.com in Chrome. A secondary account is safer than your main one.</li>
            <li>Install a cookies.txt exporter extension (for example "Get cookies.txt LOCALLY").</li>
            <li>With an instagram.com tab open, click the extension and export cookies for this site.</li>
            <li>Upload the file here. Only instagram.com cookies are kept.</li>
          </ol>
        </section>
        <section class="panel">
          <h2>Transcription engines</h2>
          <table class="table"><tbody>${cfg.engines.map((e) => `<tr><td><b>${esc(e.label)}</b>${e.id === cfg.default_engine ? ' <span class="pill completed">Default</span>' : ""}</td>
            <td>${e.ready ? '<span style="color:var(--ok);font-weight:600">Ready</span>' : `<span class="muted">${esc(e.note || "Not set up")}</span>`}</td></tr>`).join("")}</tbody></table>
          <p class="small muted" style="margin-bottom:0">API keys live in the <code>.env</code> file on the server, not in the browser. Restart after changing them.</p>
        </section>
        <section class="panel">
          <h2>Rate limits</h2>
          <p style="margin-top:0">${cfg.rate_limits.min_delay}–${cfg.rate_limits.max_delay}s random pause between Instagram requests, ${cfg.rate_limits.concurrency} downloads at a time. Job queue: ${esc(cfg.queue === "rq" ? "Redis worker" : "built-in (no Redis)")}.</p>
          <div class="notice"><span class="dot"></span><div>${esc(cfg.rate_limit_warning)}</div></div>
        </section>
      </div>`;
    const file = document.getElementById("ckfile");
    file.onchange = async () => {
      if (!file.files[0]) return;
      document.getElementById("ckname").textContent = `Uploading ${file.files[0].name}…`;
      const fd = new FormData();
      fd.append("file", file.files[0]);
      try { const r = await api("/api/settings/cookies", { method: "POST", body: fd }); toast(r.message); }
      catch (ex) { toast(ex.message); }
      viewSettings();
    };
    const del = document.getElementById("ckdel");
    if (del) del.onclick = async () => { await api("/api/settings/cookies", { method: "DELETE" }); toast("Session removed"); viewSettings(); };
  }

  route();
})();
