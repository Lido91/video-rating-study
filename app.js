(() => {
  "use strict";

  const cfg = window.STUDY_CONFIG || {};
  const videos = (window.STUDY_VIDEOS || []).filter((v) => v && v.id && v.src);
  const videoById = new Map(videos.map((v) => [v.id, v]));
  const choices = (cfg.choices || ["A", "B", "C"]).map(String);
  const questions = (cfg.questions || []).filter((q) => q && q.id && q.text);
  // 0 (or unset) means unlimited replays.
  const maxPlays = Number(cfg.maxPlays) > 0 ? Math.floor(Number(cfg.maxPlays)) : Infinity;
  const demo = !cfg.scriptUrl;

  const RATER_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
  const PREFIX = `vrs:${cfg.studyId || "study"}`;
  const QUEUE_KEY = `${PREFIX}:queue`;   // rows waiting to be sent to the sheet
  const LOCAL_KEY = `${PREFIX}:local`;   // demo mode: rows kept in the browser
  const ANON_KEY = `${PREFIX}:anon`;
  const raterKey = (id) => `${PREFIX}:rater:${id}`;

  const $ = (id) => document.getElementById(id);
  const player = $("player");

  // ---------- storage ----------
  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(key);
        return v ? JSON.parse(v) : fallback;
      } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode etc. */ }
    },
  };

  // ---------- helpers ----------
  function show(name) {
    for (const s of document.querySelectorAll(".screen")) s.hidden = s.id !== `screen-${name}`;
    window.scrollTo(0, 0);
  }

  function showMessage(title, body) {
    $("message-title").textContent = title;
    $("message-body").textContent = body;
    show("message");
  }

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }

  // Seeded shuffle: the same rater always gets the same order, even after a reload.
  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  function seededRandom(seed) {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffled(list, seedText) {
    const rand = seededRandom(hash(seedText));
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function buildOrder(raterId, savedOrder) {
    const ids = videos.map((v) => v.id);
    const fresh = cfg.randomizeOrder === false ? ids : shuffled(ids, `${cfg.studyId}:${raterId}`);
    if (!savedOrder) return fresh;
    // Keep the saved order; drop videos that were removed and append any new ones.
    const kept = savedOrder.filter((id) => videoById.has(id));
    return kept.concat(fresh.filter((id) => !kept.includes(id)));
  }

  // ---------- saving ----------
  let queue = store.get(QUEUE_KEY, []);
  let flushing = false;
  let retryTimer = null;
  let retryDelay = 2000;

  function record(rows) {
    if (demo) {
      const local = store.get(LOCAL_KEY, []);
      store.set(LOCAL_KEY, local.concat(rows));
      console.info("[demo] answer rows", rows);
      return;
    }
    queue = queue.concat(rows);
    store.set(QUEUE_KEY, queue);
    flush();
  }

  async function flush() {
    if (demo || flushing || !queue.length) return updateSaveStatus();
    flushing = true;
    clearTimeout(retryTimer);
    try {
      while (queue.length) {
        const batch = queue.slice(0, 50);
        // No custom headers: a text/plain POST avoids a CORS preflight, which Apps Script can't answer.
        const res = await fetch(cfg.scriptUrl, { method: "POST", body: JSON.stringify({ rows: batch }) });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "Save failed");
        if (data.rejected) console.warn(`${data.rejected} row(s) were rejected by the sheet`, data.errors);
        const sent = new Set(batch.map((r) => r.submission_id));
        queue = queue.filter((r) => !sent.has(r.submission_id));
        store.set(QUEUE_KEY, queue);
      }
      retryDelay = 2000;
    } catch (err) {
      console.warn("Could not save answers yet, will retry:", err);
      retryTimer = setTimeout(flush, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 60000);
    } finally {
      flushing = false;
      updateSaveStatus();
    }
  }

  function updateSaveStatus() {
    const el = $("save-status");
    if (demo) el.textContent = "Demo mode: your answers are stored in this browser only.";
    else if (queue.length) el.textContent = "Saving your answers… please keep this page open.";
    else el.textContent = "All your answers have been saved. You can close this page.";
  }

  window.addEventListener("online", flush);
  window.addEventListener("beforeunload", (e) => {
    if (!demo && queue.length) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  // ---------- video loading ----------
  // Each video is downloaded fully before it can be played, so buffering never
  // interrupts playback (stalls would bias the judgement). The next video is
  // fetched in the background while the current one is being answered.
  const loaded = new Map(); // src -> { progress, promise<url> }

  function fetchVideo(src) {
    if (loaded.has(src)) return loaded.get(src);
    const entry = { progress: 0 };
    entry.promise = (async () => {
      try {
        const res = await fetch(src);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const type = res.headers.get("content-type") || "";
        const total = Number(res.headers.get("content-length")) || 0;
        let blob;
        if (res.body && total) {
          const reader = res.body.getReader();
          const chunks = [];
          let got = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            got += value.length;
            entry.progress = got / total;
          }
          blob = new Blob(chunks, type ? { type } : undefined);
        } else {
          blob = await res.blob();
        }
        entry.progress = 1;
        return URL.createObjectURL(blob);
      } catch (err) {
        // e.g. opened from file:// — fall back to streaming the file directly.
        console.warn(`Streaming ${src} instead of preloading:`, err);
        entry.progress = 1;
        return src;
      }
    })();
    loaded.set(src, entry);
    return entry;
  }

  function releaseVideo(src) {
    const entry = loaded.get(src);
    if (!entry) return;
    loaded.delete(src);
    entry.promise.then((url) => { if (url.startsWith("blob:")) URL.revokeObjectURL(url); });
  }

  // ---------- welcome ----------
  let state = null;   // { raterId, sessionId, order, done }
  let trial = null;   // the video currently on screen

  function paragraphs(text, container) {
    container.textContent = "";
    for (const chunk of String(text || "").split(/\n\s*\n/)) {
      if (!chunk.trim()) continue;
      const p = document.createElement("p");
      p.textContent = chunk.trim();
      container.append(p);
    }
  }

  function renderWelcome() {
    document.title = cfg.title || "Video Comparison Study";
    $("study-title").textContent = cfg.title || "Video Comparison Study";
    paragraphs(cfg.instructions, $("instructions"));

    const params = new URLSearchParams(location.search);
    const fromUrl = params.get("id") || params.get("PROLIFIC_PID") || params.get("pid") || params.get("participant") || "";
    if (cfg.askRaterId === false) $("rater-field").hidden = true;
    else $("rater-id").value = fromUrl;
    if (cfg.consent) $("consent-text").textContent = cfg.consent;
    else $("consent-field").hidden = true;

    show("welcome");
  }

  $("start-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const err = $("start-error");
    let raterId;
    if (cfg.askRaterId === false) {
      raterId = store.get(ANON_KEY, null);
      if (!raterId) {
        raterId = `anon-${uuid().replace(/-/g, "").slice(0, 12)}`;
        store.set(ANON_KEY, raterId);
      }
    } else {
      raterId = $("rater-id").value.trim();
      if (!RATER_RE.test(raterId)) {
        err.textContent = "Please enter a participant ID using letters, numbers, - or _ (up to 64 characters).";
        $("rater-id").focus();
        return;
      }
    }
    if (cfg.consent && !$("consent").checked) {
      err.textContent = "Please tick the consent box to continue.";
      return;
    }
    err.textContent = "";

    const saved = store.get(raterKey(raterId), null);
    state = {
      raterId,
      sessionId: saved ? saved.sessionId : uuid(),
      order: buildOrder(raterId, saved && saved.order),
      done: saved ? saved.done.filter((id) => videoById.has(id)) : [],
    };
    saveState();
    nextTrial();
  });

  function saveState() {
    store.set(raterKey(state.raterId), state);
  }

  // ---------- trial ----------
  function renderQuestions(locked) {
    const box = $("questions");
    box.textContent = "";
    questions.forEach((q, qi) => {
      const wrap = document.createElement("div");
      wrap.className = "question" + (locked ? " locked" : "");
      const p = document.createElement("p");
      p.id = `q${qi}-label`;
      p.textContent = q.text;
      const row = document.createElement("div");
      row.className = "choices";
      row.setAttribute("role", "radiogroup");
      row.setAttribute("aria-labelledby", p.id);
      row.style.setProperty("--n", choices.length);
      choices.forEach((label, i) => {
        const input = document.createElement("input");
        input.type = "radio";
        input.name = `q${qi}`;
        input.id = `q${qi}-${i}`;
        input.value = label;
        input.disabled = locked;
        input.addEventListener("change", () => choose(qi, i));
        const lab = document.createElement("label");
        lab.htmlFor = input.id;
        lab.textContent = label;
        row.append(input, lab);
      });
      wrap.append(p, row);
      box.append(wrap);
    });
  }

  function choose(qi, i) {
    if (!trial || trial.locked) return;
    const input = document.getElementById(`q${qi}-${i}`);
    if (!input || input.disabled) return;
    input.checked = true;
    trial.answers[questions[qi].id] = choices[i];
    updateNext();
  }

  function unlock() {
    trial.locked = false;
    for (const el of document.querySelectorAll(".question")) el.classList.remove("locked");
    for (const el of document.querySelectorAll(".question input")) el.disabled = false;
  }

  function updateNext() {
    const answered = questions.every((q) => trial.answers[q.id] !== undefined);
    const watched = trial.watched || !cfg.requireFullWatch;
    $("next-btn").disabled = !trial.failed && !(answered && watched);
    let hint = "";
    if (trial.failed) hint = "This video can't be played in your browser. Click Next to skip it.";
    else if (!trial.ready) hint = "";
    else if (!trial.plays) hint = "Press Play to watch the video.";
    else if (!watched) hint = "You can answer once the video finishes.";
    else if (!answered) hint = questions.length > 1 ? "Answer every question to continue." : `Choose ${choices.slice(0, -1).join(", ")} or ${choices[choices.length - 1]} to continue.`;
    $("trial-hint").textContent = hint;
  }

  function setPlayButton(label, enabled) {
    $("play-btn").textContent = label;
    $("play-btn").disabled = !enabled;
  }

  function nextTrial() {
    player.removeAttribute("src");
    player.load();
    if (trial) releaseVideo(trial.video.src);
    const remaining = state.order.filter((id) => !state.done.includes(id));
    if (!remaining.length) return finish();

    const video = videoById.get(remaining[0]);
    const position = state.done.length + 1;
    const total = state.order.length;
    trial = {
      video,
      position,
      plays: 0,
      stalls: 0,
      playing: false,
      watched: false,
      failed: false,
      ready: false,
      locked: !!cfg.requireFullWatch,
      answers: {},
      endedAt: 0,
      shownAt: Date.now(),
    };

    $("progress-text").textContent = `Video ${position} of ${total}`;
    $("progress-fill").style.width = `${((position - 1) / total) * 100}%`;
    renderQuestions(trial.locked);
    $("next-btn").disabled = true;
    setPlayButton("Loading…", false);
    show("trial");
    updateNext();

    const current = trial;
    const entry = fetchVideo(video.src);
    const ticker = setInterval(() => {
      if (current !== trial || current.ready) return clearInterval(ticker);
      setPlayButton(`Loading… ${Math.round(entry.progress * 100)}%`, false);
    }, 200);

    entry.promise.then((url) => {
      clearInterval(ticker);
      if (current !== trial) return;
      current.url = new URL(url, location.href).href;
      player.src = url;
      player.load();
      // Some mobile browsers won't buffer before a tap, so enable Play after a short wait regardless.
      const enable = () => {
        if (current !== trial || current.ready || current.failed) return;
        current.ready = true;
        setPlayButton("▶ Play", true);
        updateNext();
      };
      player.addEventListener("canplaythrough", enable, { once: true });
      setTimeout(enable, 2500);

      const next = remaining[1] && videoById.get(remaining[1]);
      if (next) fetchVideo(next.src);
    });
  }

  $("play-btn").addEventListener("click", () => {
    const t = trial;
    if (!t || !t.ready || t.plays >= maxPlays) return;
    t.plays += 1;
    t.playing = false;
    t.inPlay = true;
    setPlayButton("Playing…", false);
    player.currentTime = 0;
    player.play().catch((err) => {
      console.warn("Playback failed:", err);
      t.inPlay = false;
      t.plays -= 1;
      setPlayButton("▶ Play", true);
    });
    updateNext();
  });

  // The browser can pause a video before it ends, e.g. when the rater switches tabs.
  // Let them watch it again from the start; the interrupted play doesn't count.
  player.addEventListener("pause", () => {
    const t = trial;
    if (!t || !t.inPlay || player.ended) return;
    t.inPlay = false;
    t.plays -= 1;
    setPlayButton("▶ Play from start", true);
    updateNext();
  });

  // Block the right-click menu, which would otherwise offer "Show controls" (seeking, speed).
  player.addEventListener("contextmenu", (e) => e.preventDefault());
  player.addEventListener("playing", () => { if (trial) trial.playing = true; });
  player.addEventListener("waiting", () => { if (trial && trial.playing) trial.stalls += 1; });
  player.addEventListener("ended", () => {
    const t = trial;
    if (!t) return;
    t.playing = false;
    t.inPlay = false;
    if (!t.watched) {
      t.watched = true;
      t.endedAt = Date.now();
      unlock();
    }
    const left = maxPlays - t.plays;
    if (left === Infinity) setPlayButton("↻ Replay", true);
    else setPlayButton(left > 0 ? `↻ Replay (${left} left)` : "No replays left", left > 0);
    updateNext();
  });
  player.addEventListener("error", () => {
    if (!trial || !trial.url || player.src !== trial.url) return;
    console.error("Video error", trial.video.src, player.error);
    trial.failed = true;
    setPlayButton("Video unavailable", false);
    updateNext();
  });

  $("next-btn").addEventListener("click", () => {
    if (!trial || $("next-btn").disabled) return;
    $("next-btn").disabled = true;
    const t = trial;
    const base = {
      study_id: cfg.studyId || "study",
      rater_id: state.raterId,
      session_id: state.sessionId,
      video_id: t.video.id,
      options: choices.join("|"),
      trial_index: t.position,
      plays: t.plays,
      stalls: t.stalls,
      video_seconds: Number.isFinite(player.duration) ? Math.round(player.duration * 100) / 100 : 0,
      response_ms: Date.now() - (t.endedAt || t.shownAt),
      screen: `${screen.width}x${screen.height}`,
      client_time: new Date().toISOString(),
    };
    const rows = t.failed
      ? [{ ...base, submission_id: uuid(), question: questions[0].id, choice: "", note: "playback_error" }]
      : questions.map((q) => ({ ...base, submission_id: uuid(), question: q.id, choice: t.answers[q.id], note: "" }));
    record(rows);
    state.done.push(t.video.id);
    saveState();
    nextTrial();
  });

  // Keyboard: a choice's letter (or 1, 2, 3…) picks it in single-question studies; Enter goes next.
  document.addEventListener("keydown", (e) => {
    if ($("screen-trial").hidden || !trial || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "Enter" && !$("next-btn").disabled) {
      e.preventDefault();
      $("next-btn").click();
      return;
    }
    if (questions.length !== 1) return;
    let i = choices.findIndex((c) => c.toLowerCase() === e.key.toLowerCase());
    if (i < 0 && /^[1-9]$/.test(e.key)) i = Number(e.key) - 1;
    if (i >= 0 && i < choices.length) choose(0, i);
  });

  // ---------- done ----------
  function finish() {
    trial = null;
    if (cfg.completionCode) {
      $("completion-code").textContent = cfg.completionCode;
      $("code-box").hidden = false;
    }
    $("download-btn").hidden = !demo;
    updateSaveStatus();
    show("done");
    flush();
  }

  const CSV_COLUMNS = ["study_id", "rater_id", "video_id", "question", "choice", "options", "trial_index", "plays",
    "stalls", "video_seconds", "response_ms", "note", "screen", "session_id", "client_time", "submission_id"];

  $("download-btn").addEventListener("click", () => {
    const rows = store.get(LOCAL_KEY, []).filter((r) => r.rater_id === state.raterId);
    const esc = (v) => {
      const s = v === null || v === undefined ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [CSV_COLUMNS.join(",")].concat(rows.map((r) => CSV_COLUMNS.map((c) => esc(r[c])).join(","))).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `answers-${state.raterId}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  // ---------- start ----------
  if (demo) $("demo-banner").hidden = false;

  if (new URLSearchParams(location.search).has("reset")) {
    // For testing: forget progress on this device (unsent answers are kept).
    try {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith(PREFIX) && key !== QUEUE_KEY) localStorage.removeItem(key);
      }
    } catch { /* ignore */ }
  }

  if (!videos.length) {
    showMessage("No videos yet", "Add video files to the videos/ folder and run make_video_list.py (see README).");
  } else if (!questions.length || choices.length < 2) {
    showMessage("Study not configured", "config.js needs at least one question and at least two choices.");
  } else {
    renderWelcome();
  }
  flush();
})();
