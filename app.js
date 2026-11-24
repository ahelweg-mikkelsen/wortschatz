"use strict";

const STORAGE_KEY = "wortschatz";
const SYNC_URL = "https://wortschatz-sync.ahelwegmikkelsen.workers.dev/sync";
const SYNC_DELAY_MILLISECONDS = 4000;
const SYNC_INTERVAL_MILLISECONDS = 5 * 60 * 1000;
const BATCH_SIZE = 5;
const TIMES_EACH_ITEM = 4;
const DRAWS_SCHEDULED_AHEAD = 3;
const LEAD_IN_SECONDS = 0.5;
const WEIGHT_STEP_RANGE = [-3, 3];
const LEVELS = [1, 2, 3, 4, 5];
const DEFAULT_SETTINGS = {
  level: 1,
  batchesInARow: 10,
  speed: 1,
  pauseSeconds: 2,
  translationPauseSeconds: 3,
  danishFirst: true,
  showDanish: false,
  showGerman: false,
  showTenseHint: true,
  drillLevel: 1,
  drillThinkingPauseSeconds: 3,
  drillPauseSeconds: 1.5,
};

const ICONS = {
  play: '<svg viewBox="0 0 24 24" width="1em" height="1em"><path fill="currentColor" d="M7 4.5v15l13-7.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" width="1em" height="1em"><path fill="currentColor" d="M6 4h4.5v16H6zM13.5 4H18v16h-4.5z"/></svg>',
  replay: '<svg viewBox="0 0 24 24" width="1em" height="1em"><path fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" d="M5 12a7 7 0 1 0 2.3-5.2M5 4v4.5h4.5"/></svg>',
  previous: '<svg viewBox="0 0 24 24" width="1em" height="1em"><path fill="currentColor" d="M6 5h2.5v14H6zM19 5v14L9 12z"/></svg>',
  next: '<svg viewBox="0 0 24 24" width="1em" height="1em"><path fill="currentColor" d="M15.5 5H18v14h-2.5zM5 5v14l10-7z"/></svg>',
  down: '<svg viewBox="0 0 24 24" width="1em" height="1em"><path fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" d="M6 9.5l6 6 6-6"/></svg>',
  up: '<svg viewBox="0 0 24 24" width="1em" height="1em"><path fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" d="M6 14.5l6-6 6 6"/></svg>',
  clock: '<svg viewBox="0 0 24 24" width="1em" height="1em"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4v3.5H8M12 8v4.5l3 2"/></svg>',
};

function readStorage() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? {};
  } catch {
    return {};
  }
}

const storedState = readStorage();
const state = {
  tab: "sentences",
  settings: { ...DEFAULT_SETTINGS, ...storedState.settings },
  tracked: storedState.tracked ?? {},
  unsyncedIDs: new Set(storedState.unsyncedIDs ?? Object.keys(storedState.tracked ?? {})),
  syncKey: storedState.syncKey ?? "",
  syncStatus: "",
  repetitionQuery: "",
  categoryQuery: "",
  sentences: [],
  words: [],
  sentenceByID: new Map(),
  round: null,
  isTextRevealed: false,
  loadError: null,
};

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ settings: state.settings, tracked: state.tracked, unsyncedIDs: [...state.unsyncedIDs], syncKey: state.syncKey }));
  } catch {}
}

function escapeHTML(text) {
  return String(text).replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

function formatSeconds(seconds) {
  return `${seconds.toLocaleString("da-DK", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`;
}

function formatPercent(fraction) {
  return `${Math.round(fraction * 100)} %`;
}

function shuffled(items) {
  const copy = [...items];
  copy.forEach((_, index) => {
    const swapIndex = index + Math.floor(Math.random() * (copy.length - index));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  });
  return copy;
}

function weightOfStep(weightStep) {
  return 2 ** weightStep;
}

function weightedDraw(pool, weightSteps, excludedIDs) {
  const candidates = pool.filter((item) => !excludedIDs.has(item.id));
  if (candidates.length === 0) return null;
  const weights = candidates.map((item) => weightOfStep(weightSteps[item.id] ?? 0));
  let remainingThreshold = Math.random() * weights.reduce((total, weight) => total + weight, 0);
  return candidates.find((_, index) => (remainingThreshold -= weights[index]) < 0) ?? candidates[candidates.length - 1];
}

function shuffleBag(pool, timesEach) {
  for (;;) {
    const remainingDraws = new Map(pool.map((item) => [item, timesEach]));
    const drawOrder = [];
    for (;;) {
      const options = [...remainingDraws]
        .filter(([item, count]) => count > 0 && item !== drawOrder[drawOrder.length - 1])
        .flatMap(([item, count]) => Array(count).fill(item));
      if (options.length === 0) break;
      const nextItem = options[Math.floor(Math.random() * options.length)];
      drawOrder.push(nextItem);
      remainingDraws.set(nextItem, remainingDraws.get(nextItem) - 1);
    }
    if (drawOrder.length === pool.length * timesEach) return drawOrder;
  }
}

const silenceURLs = new Map();

function silenceURL(seconds) {
  if (!silenceURLs.has(seconds)) {
    const sampleRate = 8000;
    const sampleCount = Math.round(seconds * sampleRate);
    const buffer = new ArrayBuffer(44 + sampleCount);
    const view = new DataView(buffer);
    const writeText = (offset, text) => [...text].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
    writeText(0, "RIFF");
    view.setUint32(4, 36 + sampleCount, true);
    writeText(8, "WAVE");
    writeText(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate, true);
    view.setUint16(32, 1, true);
    view.setUint16(34, 8, true);
    writeText(36, "data");
    view.setUint32(40, sampleCount, true);
    new Uint8Array(buffer, 44).fill(128);
    silenceURLs.set(seconds, URL.createObjectURL(new Blob([buffer], { type: "audio/wav" })));
  }
  return silenceURLs.get(seconds);
}

const audio = new Audio();
audio.preload = "auto";

class Round {
  constructor({ kind, title, pool, isEndless, weightSteps, danishFirst, pauseSeconds, translationPauseSeconds, onItemLearned, onWeightStepChanged }) {
    Object.assign(this, { kind, title, pool, isEndless, weightSteps: { ...weightSteps }, danishFirst, pauseSeconds, translationPauseSeconds, onItemLearned, onWeightStepChanged });
    const drawOrderByBatch = isEndless
      ? [Array.from({ length: Math.min(DRAWS_SCHEDULED_AHEAD, pool.length) }).reduce((draws) => [...draws, weightedDraw(pool, this.weightSteps, new Set(draws.map((item) => item.id)))], [])]
      : Array.from({ length: Math.ceil(pool.length / BATCH_SIZE) }, (_, batch) => shuffleBag(pool.slice(batch * BATCH_SIZE, (batch + 1) * BATCH_SIZE), TIMES_EACH_ITEM));
    this.drawOrder = drawOrderByBatch.flat();
    this.batchOfDraw = drawOrderByBatch.flatMap((batchDrawOrder, batch) => Array(batchDrawOrder.length).fill(batch));
    this.currentDraw = 0;
    this.isPlaying = false;
    this.isFinished = false;
    this.playbackError = null;
    this.generation = 0;
    this.segmentQueue = [];
  }

  get batchCount() {
    return this.batchOfDraw[this.batchOfDraw.length - 1] + 1;
  }

  get currentBatch() {
    return this.batchOfDraw[this.currentDraw];
  }

  get drawInCurrentBatch() {
    return this.currentDraw - this.batchOfDraw.indexOf(this.currentBatch);
  }

  get drawsInCurrentBatch() {
    return this.batchOfDraw.filter((batch) => batch === this.currentBatch).length;
  }

  get currentItem() {
    return this.drawOrder[this.currentDraw];
  }

  get currentWeightStep() {
    return this.weightSteps[this.currentItem.id] ?? 0;
  }

  changeCurrentWeightStep(stepChange) {
    const newWeightStep = Math.min(Math.max(this.currentWeightStep + stepChange, WEIGHT_STEP_RANGE[0]), WEIGHT_STEP_RANGE[1]);
    this.weightSteps[this.currentItem.id] = newWeightStep;
    this.onWeightStepChanged?.(this.currentItem, newWeightStep);
  }

  audioDirectory() {
    return this.kind === "drill" ? "ordlyd" : "lyd";
  }

  segmentsOfDraw(drawIndex) {
    const item = this.drawOrder[drawIndex];
    const directory = this.audioDirectory();
    return [
      ...(this.danishFirst ? [`${directory}/da/${item.id}.mp3`, silenceURL(this.translationPauseSeconds)] : []),
      `${directory}/de/${item.id}.mp3`,
      silenceURL(this.pauseSeconds),
    ];
  }

  prefetchAfter(drawIndex) {
    this.drawOrder.slice(drawIndex + 1, drawIndex + DRAWS_SCHEDULED_AHEAD).forEach((item) => {
      ["da", "de"].forEach((language) => fetch(`${this.audioDirectory()}/${language}/${item.id}.mp3`).catch(() => {}));
    });
  }

  start() {
    this.restartPlayback(0);
  }

  restartPlayback(firstDraw) {
    this.generation += 1;
    this.currentDraw = firstDraw;
    this.isFinished = false;
    this.isPlaying = true;
    this.segmentQueue = [silenceURL(LEAD_IN_SECONDS), ...this.segmentsOfDraw(firstDraw)];
    this.prefetchAfter(firstDraw);
    this.playNextSegment(this.generation);
    publishNowPlaying();
  }

  playNextSegment(generation) {
    if (generation !== this.generation) return;
    const segmentURL = this.segmentQueue.shift();
    if (segmentURL === undefined) {
      this.advancePastCurrentDraw(generation);
      return;
    }
    audio.src = segmentURL;
    audio.defaultPlaybackRate = state.settings.speed;
    audio.playbackRate = state.settings.speed;
    audio.onended = () => this.playNextSegment(generation);
    audio.onerror = () => {
      this.playbackError = `Kunne ikke afspille ${segmentURL}`;
      render();
      this.playNextSegment(generation);
    };
    if (this.isPlaying) audio.play().catch((error) => this.reportPlayFailure(error));
  }

  reportPlayFailure(error) {
    if (error.name === "AbortError") return;
    this.isPlaying = false;
    this.playbackError = error.name === "NotAllowedError" ? "Tryk på afspil for at starte lyden." : `${error.message}`;
    render();
  }

  advancePastCurrentDraw(generation) {
    const finishedDraw = this.currentDraw;
    this.recordCompletion(finishedDraw);
    if (finishedDraw + 1 < this.drawOrder.length) {
      this.currentDraw = finishedDraw + 1;
      this.segmentQueue = this.segmentsOfDraw(this.currentDraw);
      this.prefetchAfter(this.currentDraw);
      state.isTextRevealed = false;
      this.playNextSegment(generation);
      publishNowPlaying();
    } else {
      this.finishRound();
    }
    render();
  }

  recordCompletion(drawIndex) {
    const completedItem = this.drawOrder[drawIndex];
    if (!this.drawOrder.slice(drawIndex + 1).includes(completedItem)) this.onItemLearned?.(completedItem);
    const nextItem = this.isEndless ? weightedDraw(this.pool, this.weightSteps, new Set(this.drawOrder.map((item) => item.id))) : null;
    if (nextItem) {
      this.drawOrder.push(nextItem);
      this.batchOfDraw.push(0);
    }
  }

  finishRound() {
    this.isFinished = true;
    this.isPlaying = false;
    audio.pause();
    publishNowPlaying();
  }

  togglePlayback() {
    if (this.isFinished) {
      this.restartPlayback(0);
    } else if (this.isPlaying) {
      audio.pause();
      this.isPlaying = false;
    } else {
      this.isPlaying = true;
      this.playbackError = null;
      audio.play().catch((error) => this.reportPlayFailure(error));
    }
    publishNowPlaying();
  }

  rewindToPreviousDraw() {
    this.restartPlayback(this.isFinished ? this.drawOrder.length - 1 : Math.max(this.currentDraw - 1, 0));
  }

  skipToNextDraw() {
    const skippedDraw = this.currentDraw;
    this.recordCompletion(skippedDraw);
    if (skippedDraw + 1 < this.drawOrder.length) {
      this.restartPlayback(skippedDraw + 1);
    } else {
      this.generation += 1;
      this.finishRound();
    }
  }

  markCurrentItemLearned() {
    const learnedItem = this.currentItem;
    const keptDraws = this.drawOrder.map((item, index) => index <= this.currentDraw || item !== learnedItem);
    this.batchOfDraw = this.batchOfDraw.filter((_, index) => keptDraws[index]);
    this.drawOrder = this.drawOrder.filter((_, index) => keptDraws[index]);
    this.skipToNextDraw();
  }

  stop() {
    this.generation += 1;
    this.isPlaying = false;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  }

  nowPlayingTitle() {
    return this.isEndless
      ? `${this.title} · træk ${this.currentDraw + 1} af ${this.pool.length}`
      : `Pulje ${this.currentBatch + 1} af ${this.batchCount} · træk ${this.drawInCurrentBatch + 1} af ${this.drawsInCurrentBatch}`;
  }
}

function publishNowPlaying() {
  const round = state.round;
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.metadata = round ? new MediaMetadata({ title: round.nowPlayingTitle(), artist: "5K Wortschatz", album: round.title }) : null;
  navigator.mediaSession.playbackState = round?.isPlaying ? "playing" : "paused";
}

function registerMediaSessionActions() {
  if (!("mediaSession" in navigator)) return;
  const actions = {
    play: () => state.round && !state.round.isPlaying && state.round.togglePlayback(),
    pause: () => state.round?.isPlaying && state.round.togglePlayback(),
    previoustrack: () => state.round?.rewindToPreviousDraw(),
    nexttrack: () => state.round && !state.round.isFinished && state.round.skipToNextDraw(),
  };
  Object.entries(actions).forEach(([action, handler]) => {
    try {
      navigator.mediaSession.setActionHandler(action, () => {
        handler();
        state.isTextRevealed = false;
        render();
      });
    } catch {}
  });
}

function trackedEntry(sentenceID) {
  state.tracked[sentenceID] ??= { roundsHeard: 0, lastHeard: Date.now(), weightStep: 0, weightChanged: 0 };
  state.unsyncedIDs.add(sentenceID);
  scheduleSync();
  return state.tracked[sentenceID];
}

function heardSentenceIDs() {
  return new Set(Object.entries(state.tracked).filter(([, entry]) => entry.roundsHeard > 0).map(([sentenceID]) => sentenceID));
}

function trackedWeightSteps() {
  return Object.fromEntries(Object.entries(state.tracked).map(([sentenceID, entry]) => [sentenceID, entry.weightStep ?? 0]));
}

function sentenceMatches(sentence, query) {
  const lowercaseQuery = query.toLocaleLowerCase("de");
  return sentence.target_lemmas.some((lemma) => lemma.toLocaleLowerCase("de") === lowercaseQuery) || sentence.de.toLocaleLowerCase("de").includes(lowercaseQuery);
}

function wordMatchesCategories(word, query) {
  return query.toLocaleLowerCase("da").split(/[\s,]+/).filter(Boolean).every((term) => word.kategorier.includes(term));
}

function repetitionSentences() {
  const query = state.repetitionQuery.trim();
  const sentences = [...heardSentenceIDs()].map((sentenceID) => state.sentenceByID.get(sentenceID)).filter(Boolean);
  return query ? sentences.filter((sentence) => sentenceMatches(sentence, query)) : sentences;
}

function unheardSentencesFromLevel() {
  const heardIDs = heardSentenceIDs();
  const level = state.settings.level;
  const unheardSentences = state.sentences.filter((sentence) => !heardIDs.has(sentence.id) && sentence.level >= level);
  return [...shuffled(unheardSentences.filter((sentence) => sentence.level === level)), ...shuffled(unheardSentences.filter((sentence) => sentence.level > level))];
}

function drillWords() {
  const query = state.categoryQuery.trim();
  return query ? state.words.filter((word) => wordMatchesCategories(word, query)) : state.words.filter((word) => word.level === state.settings.drillLevel);
}

function sentenceRoundCallbacks() {
  return {
    onItemLearned: (sentence) => {
      const entry = trackedEntry(sentence.id);
      entry.roundsHeard += 1;
      entry.lastHeard = Date.now();
      persist();
    },
    onWeightStepChanged: (sentence, weightStep) => {
      const entry = trackedEntry(sentence.id);
      entry.weightStep = weightStep;
      entry.weightChanged = Date.now();
      persist();
    },
  };
}

function beginRound(round) {
  state.round = round;
  state.isTextRevealed = false;
  round.start();
  render();
}

function startNewSentences() {
  const unheardSentences = unheardSentencesFromLevel();
  const batchCount = Math.min(state.settings.batchesInARow, Math.floor(unheardSentences.length / BATCH_SIZE));
  if (batchCount === 0) return;
  beginRound(new Round({
    kind: "sentences",
    title: "Nye sætninger",
    pool: unheardSentences.slice(0, batchCount * BATCH_SIZE),
    isEndless: false,
    weightSteps: trackedWeightSteps(),
    danishFirst: state.settings.danishFirst,
    pauseSeconds: state.settings.pauseSeconds,
    translationPauseSeconds: state.settings.translationPauseSeconds,
    ...sentenceRoundCallbacks(),
  }));
}

function startRepetition() {
  const sentences = repetitionSentences();
  if (sentences.length === 0) return;
  const query = state.repetitionQuery.trim();
  beginRound(new Round({
    kind: "sentences",
    title: query ? `Repetition · ${query}` : "Repetition",
    pool: sentences,
    isEndless: true,
    weightSteps: trackedWeightSteps(),
    danishFirst: state.settings.danishFirst,
    pauseSeconds: state.settings.pauseSeconds,
    translationPauseSeconds: state.settings.translationPauseSeconds,
    ...sentenceRoundCallbacks(),
  }));
}

function startDrill() {
  const words = drillWords();
  if (words.length === 0) return;
  beginRound(new Round({
    kind: "drill",
    title: "Terpe",
    pool: words,
    isEndless: true,
    weightSteps: {},
    danishFirst: true,
    pauseSeconds: state.settings.drillPauseSeconds,
    translationPauseSeconds: state.settings.drillThinkingPauseSeconds,
  }));
}

function quitRound() {
  state.round?.stop();
  state.round = null;
  publishNowPlaying();
  render();
}

const STEPPERS = {
  batchesInARow: { minimum: 1, maximum: 20, step: 1 },
  pauseSeconds: { minimum: 0.5, maximum: 6, step: 0.5 },
  translationPauseSeconds: { minimum: 1, maximum: 10, step: 0.5 },
  drillThinkingPauseSeconds: { minimum: 1, maximum: 10, step: 0.5 },
  drillPauseSeconds: { minimum: 0.5, maximum: 6, step: 0.5 },
};

function stepperRow(label, setting, isDisabled = false) {
  const { minimum, maximum } = STEPPERS[setting];
  const value = state.settings[setting];
  return `<div class="row${isDisabled ? " disabled" : ""}"><span>${label}</span><div class="stepper">
    <button data-action="step" data-setting="${setting}" data-direction="-1" ${value <= minimum ? "disabled" : ""}>−</button>
    <button data-action="step" data-setting="${setting}" data-direction="1" ${value >= maximum ? "disabled" : ""}>+</button>
  </div></div>`;
}

function switchRow(label, setting) {
  return `<div class="row"><span>${label}</span><button class="switch${state.settings[setting] ? " on" : ""}" data-action="toggle" data-setting="${setting}" aria-label="${label}"></button></div>`;
}

function speedRow() {
  return `<div class="row slider-row"><div class="label"><span>Hastighed</span><span class="value" data-speed-label>${formatPercent(state.settings.speed)}</span></div>
    <input type="range" min="0.6" max="1" step="0.05" value="${state.settings.speed}" data-input="speed"></div>`;
}

function levelButtons(selectedLevel, setting, describe) {
  return `<div class="levels">${LEVELS.map((level) => `<button class="level${level === selectedLevel ? " active" : ""}" data-action="level" data-setting="${setting}" data-level="${level}">Niveau ${level}<small>${describe(level)}</small></button>`).join("")}</div>`;
}

function renderSentencesTab() {
  const heardIDs = heardSentenceIDs();
  const unheardCount = unheardSentencesFromLevel().length;
  const repetitionCount = repetitionSentences().length;
  const query = state.repetitionQuery.trim();
  const settings = state.settings;
  return `
  <div class="section"><h2>Nye sætninger</h2><div class="card">
    <div class="row">${levelButtons(settings.level, "level", (level) => `${state.sentences.filter((sentence) => sentence.level === level && !heardIDs.has(sentence.id)).length} tilbage`)}</div>
    ${stepperRow(`Puljer i træk: ${settings.batchesInARow}`, "batchesInARow")}
    <button class="start" data-action="start-new" ${unheardCount < BATCH_SIZE ? "disabled" : ""}>Start ${settings.batchesInARow} × ${BATCH_SIZE} nye sætninger</button>
  </div></div>
  <div class="section"><h2>Repetition</h2><div class="card">
    <div class="row"><span>Hørte sætninger</span><span class="value">${heardIDs.size} af ${state.sentences.length}</span></div>
    <div class="row"><input type="text" id="repetition-query" placeholder="Søg på tysk ord" autocomplete="off" autocapitalize="off" spellcheck="false" value="${escapeHTML(state.repetitionQuery)}" data-input="repetitionQuery"></div>
    ${query ? `<div class="row"><span>Matchende sætninger</span><span class="value">${repetitionCount}</span></div>` : ""}
    <button class="start" data-action="start-repetition" ${repetitionCount === 0 ? "disabled" : ""}>Start repetition</button>
  </div></div>
  <div class="section"><h2>Synkronisering</h2><div class="card">
    <div class="row"><input type="text" id="sync-key" placeholder="Nøgle, fx abcd-efgh-jkmn" autocomplete="off" autocapitalize="off" spellcheck="false" value="${escapeHTML(state.syncKey)}" data-input="syncKey"></div>
    ${state.syncStatus ? `<div class="row"><span>Status</span><span class="value">${escapeHTML(state.syncStatus)}</span></div>` : ""}
  </div></div>
  <div class="section"><h2>Afspilning</h2><div class="card">
    ${speedRow()}
    ${stepperRow(`Pause ${formatSeconds(settings.pauseSeconds)}`, "pauseSeconds")}
    ${switchRow("Dansk før tysk", "danishFirst")}
    ${stepperRow(`Oversættelsespause ${formatSeconds(settings.translationPauseSeconds)}`, "translationPauseSeconds", !settings.danishFirst)}
    ${switchRow("Vis dansk tekst", "showDanish")}
    ${switchRow("Vis tysk tekst som hjælp", "showGerman")}
    ${switchRow("Vis tidshint", "showTenseHint")}
  </div></div>`;
}

function renderDrillTab() {
  const query = state.categoryQuery.trim();
  const wordCount = drillWords().length;
  const settings = state.settings;
  return `
  <div class="section"><h2>Ord</h2><div class="card">
    <div class="row${query ? " disabled" : ""}">${levelButtons(settings.drillLevel, "drillLevel", (level) => `${state.words.filter((word) => word.level === level).length} ord`)}</div>
    <div class="row"><input type="text" id="category-query" placeholder="Kategori, fx verber, hankøn, natur" autocomplete="off" autocapitalize="off" spellcheck="false" value="${escapeHTML(state.categoryQuery)}" data-input="categoryQuery"></div>
    ${query ? `<div class="row"><span>Ord i kategorien</span><span class="value">${wordCount}</span></div>` : ""}
    <button class="start" data-action="start-drill" ${wordCount === 0 ? "disabled" : ""}>Start terpning</button>
  </div></div>
  <div class="section"><h2>Afspilning</h2><div class="card">
    ${speedRow()}
    ${stepperRow(`Tænkepause ${formatSeconds(settings.drillThinkingPauseSeconds)}`, "drillThinkingPauseSeconds")}
    ${stepperRow(`Pause efter tysk ${formatSeconds(settings.drillPauseSeconds)}`, "drillPauseSeconds")}
    ${switchRow("Vis dansk tekst", "showDanish")}
    ${switchRow("Vis tysk tekst som hjælp", "showGerman")}
  </div></div>`;
}

function renderHome() {
  return `<div class="home">
    <div class="tabs">
      <button class="tab${state.tab === "sentences" ? " active" : ""}" data-action="tab" data-tab="sentences">Sætninger</button>
      <button class="tab${state.tab === "drill" ? " active" : ""}" data-action="tab" data-tab="drill">Terpe</button>
    </div>
    <h1>${state.tab === "drill" ? "Terpe" : "5K Wortschatz"}</h1>
    ${state.loadError ? `<p class="error">${escapeHTML(state.loadError)}</p>` : state.tab === "drill" ? renderDrillTab() : renderSentencesTab()}
  </div>`;
}

function renderSentenceCard(sentence) {
  const { showDanish, showGerman, showTenseHint } = state.settings;
  const revealed = state.isTextRevealed;
  return `<div class="item">
    ${showDanish || revealed ? `<div class="da">${escapeHTML(sentence.da)}</div>` : ""}
    ${showTenseHint && sentence.tidshint ? `<div class="hint">${ICONS.clock}Tysk: ${escapeHTML(sentence.tidshint)}</div>` : ""}
    ${showGerman || revealed ? `<div class="de">${escapeHTML(sentence.de)}</div>` : ""}
    ${!(showGerman && showDanish) && !revealed ? `<button class="reveal" data-action="reveal">Vis tekst</button>` : ""}
  </div>`;
}

function renderWordCard(word) {
  const { showDanish, showGerman } = state.settings;
  const revealed = state.isTextRevealed;
  return `<div class="item">
    ${showDanish || revealed ? `<div class="word-da">${escapeHTML(word.da_visning)}</div>` : ""}
    ${showGerman || revealed ? `<div class="word-de">${escapeHTML(word.de_visning)}</div>${word.synonymer ? `<div class="synonyms">${escapeHTML(word.synonymer)}</div>` : ""}` : ""}
    ${!(showGerman && showDanish) && !revealed ? `<button class="reveal" data-action="reveal">Vis ord</button>` : ""}
  </div>`;
}

function weightLabel(weightStep) {
  return weightStep >= 0 ? `Hyppighed ×${2 ** weightStep}` : `Hyppighed ×1/${2 ** -weightStep}`;
}

function renderSummary(round) {
  return `<div class="summary">${round.pool.map((sentence) => `<div>
    <p>${escapeHTML(sentence.da)}</p><p class="de">${escapeHTML(sentence.de)}</p><p class="lemmas">${escapeHTML(sentence.target_lemmas.join(" · "))}</p>
  </div>`).join("")}</div>`;
}

function renderPlayer() {
  const round = state.round;
  const isSentenceRound = round.kind === "sentences";
  const [drawNumber, drawTotal] = round.isEndless ? [round.currentDraw + 1, round.pool.length] : [round.drawInCurrentBatch + 1, round.drawsInCurrentBatch];
  const playIcon = round.isFinished ? ICONS.replay : round.isPlaying ? ICONS.pause : ICONS.play;
  return `<div class="player">
    <div class="player-bar"><span></span><span class="title">${escapeHTML(round.title)}</span><button class="quit" data-action="quit">Afslut</button></div>
    ${!round.isEndless && round.batchCount > 1 ? `<div class="batch">Pulje ${round.currentBatch + 1} af ${round.batchCount}</div>` : ""}
    <div class="counter">${drawNumber} / ${drawTotal}</div>
    <div class="progress"><div style="width:${(100 * drawNumber) / drawTotal}%"></div></div>
    ${round.isFinished && isSentenceRound
      ? renderSummary(round)
      : `${isSentenceRound ? renderSentenceCard(round.currentItem) : renderWordCard(round.currentItem)}
        ${isSentenceRound ? `<div class="weight">
          <button class="round-button" data-action="weight" data-direction="-1" aria-label="Sjældnere" ${round.currentWeightStep <= WEIGHT_STEP_RANGE[0] ? "disabled" : ""}>${ICONS.down}</button>
          <span>${weightLabel(round.currentWeightStep)}</span>
          <button class="round-button" data-action="weight" data-direction="1" aria-label="Oftere" ${round.currentWeightStep >= WEIGHT_STEP_RANGE[1] ? "disabled" : ""}>${ICONS.up}</button>
        </div>` : ""}
        ${isSentenceRound && !round.isEndless ? `<div class="learned-wrap"><button class="learned" data-action="learned">✓ Indøvet</button></div>` : ""}`}
    ${round.playbackError ? `<p class="error">${escapeHTML(round.playbackError)}</p>` : ""}
    <div class="controls">
      <button class="round-button" data-action="previous" aria-label="Forrige">${ICONS.previous}</button>
      <button class="play" data-action="play" aria-label="Afspil eller pause">${playIcon}</button>
      <button class="round-button" data-action="next" aria-label="Næste" ${round.isFinished ? "disabled" : ""}>${ICONS.next}</button>
    </div>
    <div class="card">${speedRow()}</div>
  </div>`;
}

function render() {
  const focusedID = document.activeElement?.id;
  const selection = focusedID ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
  document.getElementById("app").innerHTML = state.round ? renderPlayer() : renderHome();
  const refocused = focusedID && document.getElementById(focusedID);
  if (refocused) {
    refocused.focus();
    refocused.setSelectionRange(...selection);
  }
}

const CLICK_ACTIONS = {
  tab: (target) => { state.tab = target.dataset.tab; },
  level: (target) => { state.settings[target.dataset.setting] = Number(target.dataset.level); persist(); },
  toggle: (target) => { state.settings[target.dataset.setting] = !state.settings[target.dataset.setting]; persist(); },
  step: (target) => {
    const setting = target.dataset.setting;
    const { minimum, maximum, step } = STEPPERS[setting];
    state.settings[setting] = Math.min(Math.max(state.settings[setting] + step * Number(target.dataset.direction), minimum), maximum);
    persist();
  },
  "start-new": startNewSentences,
  "start-repetition": startRepetition,
  "start-drill": startDrill,
  quit: quitRound,
  reveal: () => { state.isTextRevealed = true; },
  weight: (target) => state.round.changeCurrentWeightStep(Number(target.dataset.direction)),
  learned: () => { state.isTextRevealed = false; state.round.markCurrentItemLearned(); },
  play: () => state.round.togglePlayback(),
  previous: () => { state.isTextRevealed = false; state.round.rewindToPreviousDraw(); },
  next: () => { state.isTextRevealed = false; state.round.skipToNextDraw(); },
};

document.addEventListener("click", (event) => {
  const target = event.target.closest("[data-action]");
  if (!target || target.disabled) return;
  CLICK_ACTIONS[target.dataset.action](target);
  render();
});

document.addEventListener("input", (event) => {
  const field = event.target.dataset.input;
  if (field === "speed") {
    state.settings.speed = Number(event.target.value);
    audio.playbackRate = state.settings.speed;
    audio.defaultPlaybackRate = state.settings.speed;
    document.querySelectorAll("[data-speed-label]").forEach((label) => { label.textContent = formatPercent(state.settings.speed); });
    persist();
  } else if (field === "syncKey") {
    state.syncKey = event.target.value.trim().toLowerCase();
    persist();
    scheduleSync();
  } else if (field) {
    state[field] = event.target.value;
    render();
  }
});

async function loadData() {
  try {
    const [sentences, words] = await Promise.all(["saetninger.json", "ord.json"].map((path) => fetch(path).then((response) => {
      if (!response.ok) throw new Error(`${path}: ${response.status}`);
      return response.json();
    })));
    state.sentences = sentences;
    state.words = words;
    state.sentenceByID = new Map(sentences.map((sentence) => [sentence.id, sentence]));
  } catch (error) {
    state.loadError = `Kunne ikke indlæse data (${error.message}).`;
  }
  render();
}

let syncTimer = null;
let isSyncing = false;

function scheduleSync(delay = SYNC_DELAY_MILLISECONDS) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(synchronize, delay);
}

function mergedEntry(localEntry, remoteEntry) {
  const remoteWeightIsNewer = (remoteEntry.weightChanged ?? 0) > (localEntry?.weightChanged ?? 0);
  return {
    roundsHeard: Math.max(localEntry?.roundsHeard ?? 0, remoteEntry.roundsHeard),
    lastHeard: Math.max(localEntry?.lastHeard ?? 0, remoteEntry.lastHeard),
    weightStep: remoteWeightIsNewer ? remoteEntry.weightStep : localEntry?.weightStep ?? 0,
    weightChanged: Math.max(localEntry?.weightChanged ?? 0, remoteEntry.weightChanged ?? 0),
  };
}

function setSyncStatus(syncStatus) {
  state.syncStatus = syncStatus;
  if (!state.round) render();
}

async function synchronize() {
  if (!state.syncKey || isSyncing) return;
  isSyncing = true;
  const sentChanges = [...state.unsyncedIDs].filter((sentenceID) => state.tracked[sentenceID]).map((sentenceID) => ({
    id: sentenceID,
    roundsHeard: state.tracked[sentenceID].roundsHeard,
    lastHeard: Math.round(state.tracked[sentenceID].lastHeard),
    weightStep: state.tracked[sentenceID].weightStep ?? 0,
    weightChanged: Math.round(state.tracked[sentenceID].weightChanged ?? 0),
  }));
  try {
    const response = await fetch(SYNC_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${state.syncKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ changes: sentChanges }),
    });
    if (response.status === 401) throw new Error("forkert nøgle");
    if (!response.ok) throw new Error(`server ${response.status}`);
    const { entries } = await response.json();
    sentChanges.filter((change) => JSON.stringify(mergedEntry(state.tracked[change.id], change)) === JSON.stringify(mergedEntry(change, change))).forEach((change) => state.unsyncedIDs.delete(change.id));
    entries.forEach((remoteEntry) => { state.tracked[remoteEntry.id] = mergedEntry(state.tracked[remoteEntry.id], remoteEntry); });
    persist();
    setSyncStatus(`Synkroniseret kl. ${new Date().toLocaleTimeString("da-DK", { hour: "2-digit", minute: "2-digit" })} · ${heardSentenceIDs().size} hørte`);
  } catch (error) {
    setSyncStatus(`Ikke synkroniseret: ${error.message}`);
  } finally {
    isSyncing = false;
  }
}

function adoptSyncKeyFromAddress() {
  const syncKey = new URLSearchParams(location.hash.slice(1)).get("noegle");
  if (!syncKey) return;
  state.syncKey = syncKey.trim().toLowerCase();
  persist();
  history.replaceState(null, "", location.pathname);
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") scheduleSync(0);
});

adoptSyncKeyFromAddress();
registerMediaSessionActions();
loadData().then(() => scheduleSync(0));
setInterval(() => scheduleSync(0), SYNC_INTERVAL_MILLISECONDS);
