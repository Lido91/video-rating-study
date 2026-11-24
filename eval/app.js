(() => {
  "use strict";

  const cfg = window.STUDY_CONFIG || {};
  const library = window.STUDY_VIDEOS || {};
  const parts = (cfg.parts || []).filter((p) => p && p.id && p.question && Array.isArray(library[p.id]));
  const survey = (cfg.survey || []).filter((q) => q && q.id && q.text);
  const demo = !cfg.scriptUrl;
  const studyId = cfg.studyId || "study";

  // Every clip a rater can be shown, by the id that is saved (its file name).
  const clipById = new Map();
  for (const part of parts) {
    for (const item of library[part.id]) {
      const ids = Array.isArray(item.versions) ? item.versions : [item.id];
      for (const id of ids) if (id) clipById.set(id, { part: part.id, key: item.clip || item.id, sentence: item.sentence || "" });
    }
  }

  const RATER_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
  const PREFIX = `vrs:${studyId}`;
  const QUEUE_KEY = `${PREFIX}:queue`;   // rows waiting to be sent to the sheet
  const LOCAL_KEY = `${PREFIX}:local`;   // demo mode: rows kept in the browser
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
  function show(name, step) {
    for (const s of document.querySelectorAll(".screen")) s.hidden = s.id !== `screen-${name}`;
    if (step) setStep(step);
    window.scrollTo(0, 0);
  }

  function setStep(step) {
    const items = [...document.querySelectorAll("#steps li")];
    const at = items.findIndex((li) => li.dataset.step === step);
    items.forEach((li, i) => {
      li.classList.toggle("done", at >= 0 && i < at);
      li.classList.toggle("current", i === at);
      if (i === at) li.setAttribute("aria-current", "step");
      else li.removeAttribute("aria-current");
    });
  }

  function showMessage(title, body) {
    $("message-title").textContent = title;
    $("message-body").textContent = body;
    show("message");
  }

  function paragraphs(text, container) {
    container.textContent = "";
    for (const chunk of String(text || "").split(/\n\s*\n/)) {
      if (!chunk.trim()) continue;
      const p = document.createElement("p");
      p.textContent = chunk.trim();
      container.append(p);
    }
  }

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
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

  // The clips of one part for one rater, in a shuffled order. For clips that come in several
  // versions (the two avatars in either order), the versions are dealt out in turn, so each
  // rater sees each order about equally often; which order comes first depends on the rater.
  function planPart(part, raterId) {
    const items = shuffled(library[part.id], `${studyId}:${raterId}:${part.id}`);
    const offset = hash(`${studyId}:${raterId}:${part.id}:side`) % 2;
    return items.map((item, i) => {
      const versions = Array.isArray(item.versions) ? item.versions : [item.id];
      return { part: part.id, key: item.clip || item.id, id: versions[(i + offset) % versions.length] };
    });
  }

  // Keep a returning rater's saved plan; drop clips that were removed and add any new ones.
  function buildPlan(raterId, saved) {
    const plan = [];
    for (const part of parts) {
      const fresh = planPart(part, raterId);
      const kept = (saved || []).filter((e) => e.part === part.id && clipById.has(e.id) && clipById.get(e.id).part === part.id);
      const keys = new Set(kept.map((e) => e.key));
      plan.push(...kept, ...fresh.filter((e) => !keys.has(e.key)));
    }
    return plan;
  }

  // ---------- saving ----------
  let queue = store.get(QUEUE_KEY, []);
  let flushing = false;
  let retryTimer = null;
  let retryDelay = 2000;

  function record(rows) {
    if (demo) {
      store.set(LOCAL_KEY, store.get(LOCAL_KEY, []).concat(rows));
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
      const attempted = new Set();
      for (;;) {
        const batch = queue.filter((r) => !attempted.has(r.submission_id)).slice(0, 50);
        if (!batch.length) break;
        batch.forEach((r) => attempted.add(r.submission_id));
        const rows = batch.filter((r) => r.kind !== "participant");
        const participants = batch.filter((r) => r.kind === "participant");
        // No custom headers: a text/plain POST avoids a CORS preflight, which Apps Script can't answer.
        // A request that hangs (seen on the first call to a new deployment) is given up after 20 s and
        // retried; the Sheet skips rows it already has, so a retry never duplicates them.
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), 20000);
        let data;
        try {
          const res = await fetch(cfg.scriptUrl, { method: "POST", body: JSON.stringify({ rows, participants }), signal: abort.signal });
          data = await res.json();
        } finally {
          clearTimeout(timer);
        }
        if (!data.ok) throw new Error(data.error || "Save failed");
        if (data.rejected) console.warn(`${data.rejected} row(s) were rejected by the sheet`, data.errors);
        const saved = new Set(rows.map((r) => r.submission_id));
        if (participants.length && data.participants_saved !== undefined) {
          participants.forEach((p) => saved.add(p.submission_id));
        }
        queue = queue.filter((r) => !saved.has(r.submission_id));
        store.set(QUEUE_KEY, queue);
      }
      if (queue.length) throw new Error("Some answers are still waiting to be saved");
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
    const box = $("save-status");
    if (demo) box.textContent = "Demo mode: your answers are stored in this browser only.";
    else if (queue.length) box.textContent = "Saving your answers… please keep this page open.";
    else box.textContent = "All your answers have been saved. You can close this page.";
  }

  window.addEventListener("online", flush);
  window.addEventListener("beforeunload", (e) => {
    if (!demo && queue.length) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  // ---------- video loading ----------
  // Each clip is downloaded fully before it can be played, so buffering never interrupts
  // playback. The next clip is fetched in the background while the current one is answered.
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
        // e.g. opened from file:// — stream the file directly instead.
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

  const srcOf = (id) => `videos/${id}`;

  // ---------- welcome ----------
  let state = null;   // { raterId, sessionId, plan, done, surveyAnswers, partsSeen }
  let trial = null;   // the clip on screen

  function minutesFor(clips) {
    return Math.max(5, Math.ceil((clips * 27) / 60 / 5) * 5);
  }

  function renderWelcome() {
    const title = cfg.title || "Video Study";
    document.title = title;
    $("brand-title").textContent = title;
    $("study-title").textContent = title;
    paragraphs(cfg.intro, $("intro"));

    const total = parts.reduce((n, p) => n + library[p.id].length, 0);
    $("welcome-eyebrow").textContent = `Research study · about ${minutesFor(total)} minutes`;

    const cards = $("part-cards");
    cards.textContent = "";
    parts.forEach((part, i) => {
      const card = el("div", "part-card");
      card.append(
        el("span", "part-num", `Part ${i + 1}`),
        el("strong", "part-name", part.name || part.id),
        el("span", "part-summary", part.summary || ""),
        el("span", "part-clips", `${library[part.id].length} clips`),
      );
      cards.append(card);
    });

    const notes = $("notes");
    notes.textContent = "";
    for (const n of cfg.notes || []) notes.append(el("li", "", n));

    const params = new URLSearchParams(location.search);
    $("rater-id").value = params.get("id") || params.get("PROLIFIC_PID") || params.get("pid") || params.get("participant") || "";
    $("consent-text").textContent = cfg.consent || "I agree to take part in this study.";
    show("welcome", "welcome");
  }

  $("start-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const err = $("start-error");
    const raterId = $("rater-id").value.trim();
    if (!RATER_RE.test(raterId)) {
      err.textContent = "Please enter a participant ID using letters, numbers, - or _ (up to 64 characters).";
      $("rater-id").focus();
      return;
    }
    if (!$("consent").checked) {
      err.textContent = "Please tick the consent box to continue.";
      return;
    }
    err.textContent = "";

    const saved = store.get(raterKey(raterId), null);
    const plan = buildPlan(raterId, saved && saved.plan);
    const ids = new Set(plan.map((e) => e.id));
    state = {
      raterId,
      sessionId: saved ? saved.sessionId : uuid(),
      plan,
      done: saved ? (saved.done || []).filter((id) => ids.has(id)) : [],
      surveyAnswers: (saved && saved.surveyAnswers) || null,
      partsSeen: (saved && saved.partsSeen) || [],
    };
    saveState();
    const unanswered = survey.some((q) => !state.surveyAnswers || !(q.id in state.surveyAnswers));
    if (unanswered) showSurvey();
    else next();
  });

  function saveState() {
    store.set(raterKey(state.raterId), state);
  }

  // ---------- background questions ----------
  function showSurvey() {
    const box = $("survey-questions");
    const previous = state.surveyAnswers || {};
    box.textContent = "";
    survey.forEach((q, qi) => {
      const set = el("fieldset", "survey-q");
      const legend = el("legend");
      legend.append(el("span", "q-num", String(qi + 1)), el("span", "", q.text));
      set.append(legend);
      const list = el("div", "survey-options");
      (q.options || []).forEach((opt, oi) => {
        const value = String(typeof opt === "object" ? opt.value : opt);
        const label = el("label", "radio-row");
        const input = document.createElement("input");
        input.type = "radio";
        input.name = `s${qi}`;
        input.value = value;
        input.id = `s${qi}-${oi}`;
        input.checked = previous[q.id] === value;
        label.append(input, el("span", "", String(typeof opt === "object" ? opt.label || opt.value : opt)));
        list.append(label);
      });
      set.append(list);
      box.append(set);
    });
    $("survey-error").textContent = "";
    show("survey", "survey");
  }

  $("survey-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const answers = {};
    for (let qi = 0; qi < survey.length; qi++) {
      const field = $("survey-form").elements[`s${qi}`];
      const value = field ? String(field.value || "").trim() : "";
      if (!value) {
        $("survey-error").textContent = "Please answer every question to continue.";
        const set = $("survey-questions").children[qi];
        if (set) set.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      answers[survey[qi].id] = value;
    }
    record([{
      kind: "participant",
      study_id: studyId,
      rater_id: state.raterId,
      session_id: state.sessionId,
      submission_id: uuid(),
      client_time: new Date().toISOString(),
      answers,
    }]);
    state.surveyAnswers = answers;
    saveState();
    next();
  });

  // ---------- flow ----------
  const partById = (id) => parts.find((p) => p.id === id);
  const partNumber = (id) => parts.findIndex((p) => p.id === id) + 1;
  const tones = (n) => Array.from({ length: n }, (_, i) => (i === 0 ? "real" : ["a", "b", "c"][i - 1] || "c"));
  const optionTone = (opt) => (opt.value === "A" ? "a" : opt.value === "B" ? "b" : "");

  function next() {
    const remaining = state.plan.filter((e) => !state.done.includes(e.id));
    if (!remaining.length) return finish();
    const entry = remaining[0];
    if (!state.partsSeen.includes(entry.part)) showPart(partById(entry.part));
    else showTrial(entry, remaining[1]);
  }

  function sketch(part, box) {
    box.textContent = "";
    box.style.setProperty("--panels", part.panels.length);
    const t = tones(part.panels.length);
    part.panels.forEach((name, i) => {
      const cell = el("div", `sketch-cell tone-${t[i]}`);
      const art = el("div", "sketch-art");
      art.innerHTML = i === 0
        ? '<svg viewBox="0 0 40 40"><circle cx="20" cy="13" r="6"/><path d="M8 38c0-8 5-14 12-14s12 6 12 14z"/></svg>'
        : '<svg viewBox="0 0 40 40"><circle cx="20" cy="12" r="5"/><path d="M13 38V25c0-4 3-7 7-7s7 3 7 7v13M13 23l-5 6M27 23l5 6" fill="none" stroke-width="3" stroke-linecap="round"/></svg>';
      cell.append(art, el("span", "sketch-name", name));
      box.append(cell);
    });
  }

  function showPart(part) {
    const n = partNumber(part.id);
    const count = library[part.id].length;
    $("part-eyebrow").textContent = `Part ${n} of ${parts.length}`;
    $("part-title").textContent = part.name || part.id;
    sketch(part, $("part-sketch"));
    paragraphs(part.instructions, $("part-instructions"));
    $("part-count").textContent = `${count} clips · about ${minutesFor(count)} minutes`;
    $("part-start").textContent = "";
    $("part-start").append(`Begin Part ${n} `, Object.assign(el("span", "", "→"), { ariaHidden: "true" }));
    $("part-start").onclick = () => {
      state.partsSeen.push(part.id);
      saveState();
      next();
    };
    show("part", part.id);
    // Start downloading the first clip while the instructions are read.
    const first = state.plan.find((e) => e.part === part.id && !state.done.includes(e.id));
    if (first) fetchVideo(srcOf(first.id));
  }

  // ---------- trial ----------
  function renderPanels(part) {
    const labels = $("panel-labels");
    const dividers = $("dividers");
    labels.textContent = "";
    dividers.textContent = "";
    const t = tones(part.panels.length);
    $("viewer").style.setProperty("--panels", part.panels.length);
    part.panels.forEach((name, i) => {
      const tag = el("span", `panel-label tone-${t[i]}`);
      tag.append(el("span", "swatch"), el("span", "", name));
      labels.append(tag);
      if (i) dividers.append(Object.assign(el("span"), { style: `left:${(100 * i) / part.panels.length}%` }));
    });
  }

  function renderOptions(q) {
    const box = $("options");
    box.textContent = "";
    box.className = `options ${q.scale ? "scale" : "choice"}`;
    box.style.setProperty("--n", q.options.length);
    q.options.forEach((opt, i) => {
      const b = el("button", `option ${optionTone(opt) ? `tone-${optionTone(opt)}` : ""}`);
      b.type = "button";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", "false");
      b.dataset.index = i;
      if (q.scale) {
        b.append(el("span", "option-num", opt.value), el("span", "option-label", opt.label));
      } else {
        if (optionTone(opt)) b.append(el("span", "swatch"));
        b.append(el("span", "option-label", opt.label));
        const key = (opt.keys && opt.keys[0]) || "";
        if (key) b.append(el("kbd", "", key.toUpperCase()));
      }
      b.addEventListener("click", () => choose(i));
      box.append(b);
    });
    $("key-hint").textContent = q.scale
      ? `Keys ${q.options[0].value}–${q.options[q.options.length - 1].value} to rate · Enter for next`
      : `Keys ${q.options.map((o) => ((o.keys && o.keys[0]) || "").toUpperCase()).filter(Boolean).join(" / ")} to answer · Enter for next`;
  }

  function setOverlay(mode, text, progress) {
    const o = $("overlay");
    o.hidden = mode === "hidden";
    o.dataset.mode = mode;
    o.disabled = mode !== "ready";
    $("overlay-text").textContent = text || "";
    $("overlay-fill").style.width = `${Math.round((progress || 0) * 100)}%`;
  }

  function showTrial(entry, upcoming) {
    if (trial) releaseVideo(srcOf(trial.entry.id));
    player.removeAttribute("src");
    player.load();
    const part = partById(entry.part);
    const inPart = state.plan.filter((e) => e.part === entry.part);
    const position = inPart.filter((e) => state.done.includes(e.id)).length + 1;
    const info = clipById.get(entry.id) || {};
    trial = {
      entry,
      part,
      q: part.question,
      index: state.done.length + 1,
      plays: 0,
      stalls: 0,
      inPlay: false,
      playing: false,
      watched: false,
      failed: false,
      ready: false,
      answer: null,
      endedAt: 0,
      shownAt: Date.now(),
    };

    $("part-chip").textContent = `Part ${partNumber(part.id)} · ${part.name}`;
    $("progress-text").textContent = `Clip ${position} of ${inPart.length}`;
    $("progress-fill").style.width = `${((position - 1) / inPart.length) * 100}%`;
    $("sentence").textContent = info.sentence ? `“${info.sentence}”` : "";
    $("stage").classList.toggle("no-sentence", !info.sentence);
    renderPanels(part);
    $("question-text").textContent = part.question.text;
    renderOptions(part.question);
    $("answer").classList.add("locked");
    $("next-btn").disabled = true;
    $("play-btn").disabled = true;
    $("play-label").textContent = "Replay";
    setOverlay("loading", "Loading…", 0);
    show("trial", part.id);
    updateHint();

    const current = trial;
    const fetched = fetchVideo(srcOf(entry.id));
    const ticker = setInterval(() => {
      if (current !== trial || current.ready) return clearInterval(ticker);
      setOverlay("loading", `Loading… ${Math.round(fetched.progress * 100)}%`, fetched.progress);
    }, 150);

    fetched.promise.then((url) => {
      clearInterval(ticker);
      if (current !== trial) return;
      current.url = new URL(url, location.href).href;
      player.src = url;
      player.load();
      // Some browsers won't buffer before a tap, so enable Play after a short wait regardless.
      const enable = () => {
        if (current !== trial || current.ready || current.failed) return;
        current.ready = true;
        setOverlay("ready", "Play clip");
        updateHint();
      };
      player.addEventListener("loadeddata", enable, { once: true });
      setTimeout(enable, 2500);
      if (upcoming) fetchVideo(srcOf(upcoming.id));
    });
  }

  function play() {
    const t = trial;
    if (!t || !t.ready || t.failed || t.inPlay) return;
    t.plays += 1;
    t.inPlay = true;
    t.playing = false;
    setOverlay("hidden");
    $("play-btn").disabled = true;
    $("play-label").textContent = "Playing…";
    player.currentTime = 0;
    const attempt = (t.playAttempt = (t.playAttempt || 0) + 1);
    player.play().catch((err) => {
      console.warn("Playback failed:", err);
      if (!t.inPlay || t.playAttempt !== attempt) return;
      t.inPlay = false;
      t.plays -= 1;
      if (!t.watched) setOverlay("ready", "Play clip");
      else $("play-btn").disabled = false;
      $("play-label").textContent = "Replay";
    });
    updateHint();
  }

  $("overlay").addEventListener("click", play);
  $("play-btn").addEventListener("click", play);

  // The browser can pause a clip before it ends, e.g. when the rater switches tabs.
  // Let them watch it again from the start; the interrupted play doesn't count.
  player.addEventListener("pause", () => {
    const t = trial;
    if (!t || !t.inPlay || player.ended) return;
    t.inPlay = false;
    t.plays -= 1;
    if (!t.watched) setOverlay("ready", "Play from the start");
    else $("play-btn").disabled = false;
    $("play-label").textContent = "Replay";
    updateHint();
  });

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
      $("answer").classList.remove("locked");
    }
    $("play-btn").disabled = false;
    $("play-label").textContent = "Replay";
    updateHint();
  });
  player.addEventListener("error", () => {
    if (!trial || !trial.url || player.src !== trial.url) return;
    console.error("Video error", trial.entry.id, player.error);
    trial.failed = true;
    setOverlay("error", "This clip can't be played in your browser.");
    updateHint();
  });

  function choose(i) {
    const t = trial;
    if (!t || (cfg.requireFullWatch !== false && !t.watched)) return;
    t.answer = t.q.options[i].value;
    for (const b of document.querySelectorAll("#options .option")) {
      b.setAttribute("aria-checked", String(Number(b.dataset.index) === i));
    }
    updateHint();
  }

  function updateHint() {
    const t = trial;
    if (!t) return;
    const watched = t.watched || cfg.requireFullWatch === false;
    if (!watched && cfg.requireFullWatch === false) $("answer").classList.remove("locked");
    $("next-btn").disabled = !t.failed && !(watched && t.answer !== null);
    let hint = "";
    if (t.failed) hint = "Click Next to skip this clip.";
    else if (!t.ready) hint = "";
    else if (!t.plays && !t.watched) hint = "Press Play (or Space) to watch the clip.";
    else if (!watched) hint = "You can answer once the clip finishes.";
    else if (t.answer === null) hint = "Replay as often as you like, then answer below.";
    else hint = "Ready: press Next (or Enter).";
    $("trial-hint").textContent = hint;
  }

  $("next-btn").addEventListener("click", () => {
    const t = trial;
    if (!t || $("next-btn").disabled) return;
    $("next-btn").disabled = true;
    const base = {
      study_id: studyId,
      rater_id: state.raterId,
      session_id: state.sessionId,
      video_id: t.entry.id,
      question: t.q.id,
      options: t.q.options.map((o) => o.value).join("|"),
      trial_index: t.index,
      plays: Math.max(0, t.plays),
      stalls: t.stalls,
      video_seconds: Number.isFinite(player.duration) ? Math.round(player.duration * 100) / 100 : 0,
      response_ms: Date.now() - (t.endedAt || t.shownAt),
      screen: `${screen.width}x${screen.height}`,
      client_time: new Date().toISOString(),
      submission_id: uuid(),
    };
    record([t.failed ? { ...base, choice: "", note: "playback_error" } : { ...base, choice: t.answer, note: "" }]);
    state.done.push(t.entry.id);
    saveState();
    next();
  });

  // Keyboard: an option's keys answer, Space plays or replays, Enter goes on.
  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (!$("screen-part").hidden && e.key === "Enter") {
      e.preventDefault();
      $("part-start").click();
      return;
    }
    if ($("screen-trial").hidden || !trial) return;
    if (e.key === "Enter") {
      if (!$("next-btn").disabled) {
        e.preventDefault();
        $("next-btn").click();
      }
      return;
    }
    if (e.key === " ") {
      e.preventDefault();
      play();
      return;
    }
    const key = e.key.toLowerCase();
    const i = trial.q.options.findIndex((o) => (o.keys || [String(o.value).toLowerCase()]).includes(key));
    if (i >= 0) choose(i);
  });

  // ---------- done ----------
  function finish() {
    if (trial) releaseVideo(srcOf(trial.entry.id));
    trial = null;
    player.removeAttribute("src");
    player.load();
    if (cfg.completionCode) {
      $("completion-code").textContent = cfg.completionCode;
      $("code-box").hidden = false;
    }
    $("download-btn").hidden = !demo;
    updateSaveStatus();
    show("done", "done");
    flush();
  }

  const CSV_COLUMNS = ["study_id", "rater_id", "video_id", "question", "choice", "options", "trial_index", "plays",
    "stalls", "video_seconds", "response_ms", "note", "screen", "session_id", "client_time", "submission_id"];

  $("download-btn").addEventListener("click", () => {
    const rows = store.get(LOCAL_KEY, []).filter((r) => r.rater_id === state.raterId && r.kind !== "participant");
    const background = state.surveyAnswers || {};
    const columns = CSV_COLUMNS.concat(survey.map((q) => q.id));
    const esc = (v) => {
      const s = v === null || v === undefined ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [columns.join(",")]
      .concat(rows.map((r) => columns.map((c) => esc(c in r ? r[c] : background[c])).join(",")))
      .join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `answers-${state.raterId}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  // ---------- start ----------
  if (demo) $("demo-banner").hidden = false;

  // Answers given while the page ran in demo mode (before a Sheet was connected) are sent now.
  // The Sheet ignores rows it already has, so this is safe to repeat.
  if (!demo) {
    const local = store.get(LOCAL_KEY, []);
    if (local.length) {
      const queued = new Set(queue.map((r) => r.submission_id));
      queue = queue.concat(local.filter((r) => r && r.submission_id && !queued.has(r.submission_id)));
      store.set(QUEUE_KEY, queue);
      store.set(LOCAL_KEY, []);
    }
  }

  if (new URLSearchParams(location.search).has("reset")) {
    // For testing: forget progress on this device (unsent answers are kept).
    try {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith(PREFIX) && key !== QUEUE_KEY) localStorage.removeItem(key);
      }
    } catch { /* ignore */ }
  }

  if (!parts.length || !clipById.size) {
    showMessage("Study not set up", "No clips found: run make_eval_videos.py (see README).");
  } else {
    renderWelcome();
  }
  flush();
})();
