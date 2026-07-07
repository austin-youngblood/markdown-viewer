const { ipcRenderer } = require('electron');
const MarkdownIt = require('markdown-it');
const taskLists = require('markdown-it-task-lists');
const hljs = require('highlight.js');

// =========================================================================
// MARKDOWN-IT SETUP
// =========================================================================

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  breaks: false,
  highlight: (str, lang) => {
    if (lang === 'mermaid') {
      return `<pre class="mermaid-source"><code class="language-mermaid">${md.utils.escapeHtml(str)}</code></pre>`;
    }
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<pre class="hljs"><code class="language-${lang}">` +
          hljs.highlight(str, { language: lang, ignoreIllegals: true }).value + '</code></pre>';
      } catch (_e) {}
    }
    return `<pre class="hljs"><code${lang ? ` class="language-${lang}"` : ''}>` +
      md.utils.escapeHtml(str) + '</code></pre>';
  },
}).use(taskLists, { enabled: true, label: false });

// =========================================================================
// DOM REFERENCES
// =========================================================================

const editor = document.getElementById('editor');
const editorHighlight = document.getElementById('editor-highlight');
const preview = document.getElementById('preview');
const previewScroll = document.getElementById('preview-scroll');
const filepathEl = document.getElementById('filepath');
const statusEl = document.getElementById('status');
const editorPane = document.getElementById('editor-pane');
const tabBar = document.getElementById('tab-bar');
const findPanel = document.getElementById('find-panel');
const findInput = document.getElementById('find-input');
const replaceInput = document.getElementById('replace-input');
const findCounter = document.getElementById('find-counter');
const findCaseBtn = document.getElementById('find-case');
const findWordBtn = document.getElementById('find-word');
const findRegexBtn = document.getElementById('find-regex');
const findInSelBtn = document.getElementById('find-in-selection');
const findReplaceRow = document.getElementById('find-replace-row');
const insertToolbar = document.getElementById('insert-toolbar');
const popoverHost = document.getElementById('popover-host');
const insertMenuHost = document.getElementById('insert-menu-host');

// =========================================================================
// PERSISTED SETTINGS (mirrored from main)
// =========================================================================
// settings shape: { viewMode, readingMode, scrollSync, lineNumbers, recents[], favorites[] }
// Loaded once at startup, kept in sync via 'settings-changed' and
// 'view-setting-changed' broadcasts from main.

const settings = {
  viewMode: 'both',
  readingMode: false,
  scrollSync: false,
  lineNumbers: false,
  recents: [],
  favorites: [],
};

function applyViewMode(mode) {
  const cl = document.body.classList;
  cl.remove('view-editor-only', 'view-both', 'view-preview-only');
  if (mode === 'editor') cl.add('view-editor-only');
  else if (mode === 'preview') cl.add('view-preview-only');
  else cl.add('view-both');
}

function applyReadingMode(on) {
  document.body.classList.toggle('reading-mode', !!on);
}

function applyLineNumbers(on) {
  document.body.classList.toggle('line-numbers', !!on);
  if (on) updateLineNumbers();
}

function applyAllViewSettings() {
  applyViewMode(settings.viewMode);
  applyReadingMode(settings.readingMode);
  applyLineNumbers(settings.lineNumbers);
}

ipcRenderer.on('view-setting-changed', (_e, { key, value }) => {
  settings[key] = value;
  if (key === 'viewMode') applyViewMode(value);
  else if (key === 'readingMode') applyReadingMode(value);
  else if (key === 'lineNumbers') applyLineNumbers(value);
  // scrollSync needs no DOM change — the scroll handlers check the flag live.
});

ipcRenderer.on('settings-changed', (_e, patch) => {
  if (patch.recents) settings.recents = patch.recents;
  if (patch.favorites) settings.favorites = patch.favorites;
  refreshHomeIfVisible();
  renderTabBar();
});

ipcRenderer.on('file-open-failed', (_e, { filePath, reason }) => {
  if (reason === 'missing') {
    statusEl.textContent = `File not found, removed from recent: ${filePath}`;
    setTimeout(() => { statusEl.textContent = ''; }, 4000);
  }
});

// =========================================================================
// STATE
// =========================================================================

let mermaidReady = false;
let blockMap = [];      // [{ id, startChar, endChar, source }]
let lineOffsets = [];   // char offset of start of each line
let activePopover = null;
let activeInsertMenu = null;
let suppressBlockClickUntil = 0;

// ----- Multi-tab state -----
// Each tab carries its own filePath, title, modified flag, editor content/scroll/selection,
// and preview scroll position. The active tab's content lives in editor.value (and we
// sync it back to tab.content on switch / close / save).
const tabs = [];
let activeTabId = null;
let nextTabId = 1;
let isSwitchingTab = false;       // suppresses input handler's "mark modified" during programmatic swap

const HOME_TAB_ID = 'home';
function isHomeTab(t) {
  return !!t && t.id === HOME_TAB_ID;
}
function isHomeTabId(id) {
  return id === HOME_TAB_ID;
}
function documentTabs() {
  return tabs.filter(t => !isHomeTab(t));
}
function ensureHomeTab() {
  if (tabs.length === 0 || tabs[0].id !== HOME_TAB_ID) {
    const homeTab = {
      id: HOME_TAB_ID,
      filePath: null,
      title: 'Home',
      isModified: false,
      content: '',
      scrollTop: 0,
      selStart: 0,
      selEnd: 0,
      previewScrollTop: 0,
      backupId: null,
      isHome: true,
    };
    tabs.unshift(homeTab);
  }
}

function activeTab() {
  return tabs.find(t => t.id === activeTabId) || null;
}

function untitledTitle() {
  // Find a unique "Untitled-N" name
  let n = 1;
  const taken = new Set(tabs.filter(t => !t.filePath).map(t => t.title));
  while (taken.has(`Untitled-${n}`)) n++;
  return `Untitled-${n}`;
}

function makeTab({ filePath = null, content = '', title = null } = {}) {
  const fileName = filePath ? filePath.split(/[\\/]/).pop() : null;
  return {
    id: 'tab-' + (nextTabId++),
    filePath,
    title: title || fileName || untitledTitle(),
    isModified: false,
    content,
    scrollTop: 0,
    selStart: 0,
    selEnd: 0,
    previewScrollTop: 0,
    backupId: null, // assigned on first dirty edit; cleared when saved/discarded
  };
}

// =========================================================================
// AUTOSAVE / BACKUP RECOVERY
// =========================================================================
// Each dirty tab is mirrored to a JSON file under the app's userData/backups/
// dir. Writes are debounced 1.5s after the last edit. The backup is deleted on
// clean save and on tab close (whether the user kept or discarded the work) so
// only true survivors of a crash / hard quit trigger recovery on next launch.

const BACKUP_DEBOUNCE_MS = 1500;
const backupTimers = new Map(); // tabId -> setTimeout handle

function genBackupId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  return 'b-' + Math.random().toString(36).slice(2, 10) + '-' + Math.random().toString(36).slice(2, 10);
}

function scheduleBackup(tab) {
  if (!tab) return;
  if (!tab.backupId) tab.backupId = genBackupId();
  const existing = backupTimers.get(tab.id);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    backupTimers.delete(tab.id);
    const content = (tab.id === activeTabId) ? editor.value : tab.content;
    ipcRenderer.invoke('backup-write', {
      id: tab.backupId,
      filePath: tab.filePath,
      content,
      title: tab.title,
    }).catch(() => {});
  }, BACKUP_DEBOUNCE_MS);
  backupTimers.set(tab.id, timer);
}

function clearBackup(tab) {
  if (!tab) return;
  const timer = backupTimers.get(tab.id);
  if (timer) { clearTimeout(timer); backupTimers.delete(tab.id); }
  if (tab.backupId) {
    ipcRenderer.invoke('backup-delete', { id: tab.backupId }).catch(() => {});
    tab.backupId = null;
  }
}

const findState = {
  open: false,
  showReplace: false,
  query: '',
  replacement: '',
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  inSelection: false,
  selectionRange: null,
  matches: [],
  currentIndex: -1,
};

// =========================================================================
// HELPERS
// =========================================================================

function computeLineOffsets(text) {
  const offsets = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') offsets.push(i + 1);
  }
  return offsets;
}

function lineToChar(line) {
  if (line < 0) return 0;
  if (line >= lineOffsets.length) return editor.value.length;
  return lineOffsets[line];
}

// Programmatic edit that preserves the textarea's native undo history.
// Selects the [start, end) range and types `text` via execCommand, which
// records the change on the browser's undo stack. Returns true on success.
function applyEdit(start, end, text) {
  editor.focus();
  editor.setSelectionRange(start, end);
  const ok = document.execCommand('insertText', false, text);
  if (!ok) {
    // Fallback: undo will be lost but the edit still applies. execCommand
    // would have fired input → invalidated metrics; the fallback doesn't,
    // so do it ourselves.
    editor.value = editor.value.slice(0, start) + text + editor.value.slice(end);
    invalidateEditorLineMetrics();
  }
  // execCommand fires 'input' which would schedule a debounced render — we
  // call render() explicitly elsewhere, so cancel the pending timer here.
  clearTimeout(renderTimer);
  return ok;
}

// =========================================================================
// MERMAID
// =========================================================================

function initMermaid() {
  if (!mermaidReady && window.mermaid) {
    window.mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'loose' });
    mermaidReady = true;
  }
}

// =========================================================================
// RENDER WITH BLOCK MAP
// =========================================================================

function renderWithBlocks(src) {
  const env = {};
  const tokens = md.parse(src, env);
  lineOffsets = computeLineOffsets(src);
  blockMap = [];

  let html = '';
  let blockId = 0;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.level !== 0) continue;
    if (!tok.map) continue;

    let endIdx = i;
    if (tok.nesting === 1) {
      // Find matching close
      let depth = 1;
      endIdx = i + 1;
      while (endIdx < tokens.length && depth > 0) {
        if (tokens[endIdx].level === 0) {
          if (tokens[endIdx].nesting === 1) depth++;
          else if (tokens[endIdx].nesting === -1) depth--;
        }
        if (depth > 0) endIdx++;
      }
    }

    const [startLine, endLine] = tok.map;
    const startChar = lineToChar(startLine);
    const endChar = lineToChar(endLine);

    let source = src.slice(startChar, endChar);
    // Strip trailing newline from source (we re-add on save)
    if (source.endsWith('\n')) source = source.slice(0, -1);

    blockMap.push({ id: blockId, startChar, endChar, source, startLine, endLine });

    const blockTokens = tokens.slice(i, endIdx + 1);
    const blockHtml = md.renderer.render(blockTokens, md.options, env);
    html += `<div class="md-block" data-md-block-id="${blockId}">${blockHtml}</div>`;

    blockId++;
    i = endIdx;
  }
  return html;
}

async function render() {
  const src = editor.value;
  preview.innerHTML = renderWithBlocks(src);

  // KaTeX
  if (window.renderMathInElement) {
    try {
      window.renderMathInElement(preview, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '\\[', right: '\\]', display: true },
          { left: '\\(', right: '\\)', display: false },
          { left: '$', right: '$', display: false },
        ],
        ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
        throwOnError: false,
      });
    } catch (e) {
      console.warn('katex error', e);
    }
  }

  // Mermaid
  const mermaidBlocks = preview.querySelectorAll('pre.mermaid-source code.language-mermaid');
  if (mermaidBlocks.length > 0 && window.mermaid) {
    initMermaid();
    for (let i = 0; i < mermaidBlocks.length; i++) {
      const block = mermaidBlocks[i];
      const code = block.textContent;
      const container = document.createElement('div');
      container.className = 'mermaid-container';
      const id = `mermaid-${i}-${Math.floor(performance.now())}`;
      try {
        const { svg } = await window.mermaid.render(id, code);
        container.innerHTML = svg;
      } catch (e) {
        container.textContent = 'Mermaid error: ' + (e && e.message ? e.message : String(e));
        container.classList.add('mermaid-error');
      }
      block.closest('pre').replaceWith(container);
    }
  }

  renderPlusButtons();
  if (findState.open && findState.query) updateMatches();
}

// =========================================================================
// PLUS BUTTONS BETWEEN BLOCKS
// =========================================================================

function renderPlusButtons() {
  preview.querySelectorAll('.md-plus').forEach(el => el.remove());
  const blocks = preview.querySelectorAll('.md-block');
  blocks.forEach((b, i) => {
    const plus = document.createElement('div');
    plus.className = 'md-plus';
    plus.dataset.insertBefore = String(i);
    plus.innerHTML = '<button class="md-plus-btn" title="Insert here">+</button>';
    b.before(plus);
  });
  const endPlus = document.createElement('div');
  endPlus.className = 'md-plus md-plus-end';
  endPlus.dataset.insertBefore = String(blocks.length);
  endPlus.innerHTML = '<button class="md-plus-btn" title="Insert at end">+</button>';
  preview.appendChild(endPlus);
}

// =========================================================================
// FIND / REPLACE
// =========================================================================

function openFind(showReplace) {
  findState.open = true;
  findState.showReplace = showReplace;
  findPanel.classList.add('open');
  findReplaceRow.style.display = showReplace ? '' : 'none';
  // Prefill with current selection if any
  if (!findInput.value && editor.selectionStart !== editor.selectionEnd) {
    findInput.value = editor.value.slice(editor.selectionStart, editor.selectionEnd);
    findState.query = findInput.value;
  }
  findInput.focus();
  findInput.select();
  updateMatches({ flash: true });
}

function closeFind() {
  findState.open = false;
  findState.matches = [];
  findState.currentIndex = -1;
  findPanel.classList.remove('open');
  clearMatchFlash();
  updateHighlightOverlay();
  editor.focus();
}

function buildSearchRegex() {
  if (!findState.query) return null;
  let pattern = findState.regex
    ? findState.query
    : findState.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (findState.wholeWord) pattern = `\\b(?:${pattern})\\b`;
  let flags = 'g';
  if (!findState.caseSensitive) flags += 'i';
  try {
    return new RegExp(pattern, flags);
  } catch (_e) {
    return null;
  }
}

function updateMatches({ flash = false } = {}) {
  findState.matches = [];
  const re = buildSearchRegex();
  if (!re) {
    findCounter.textContent = '';
    findInput.classList.remove('error');
    if (findState.query && findState.regex) findInput.classList.add('error');
    updateHighlightOverlay();
    return;
  }
  findInput.classList.remove('error');
  let text = editor.value;
  let baseOffset = 0;
  if (findState.inSelection && findState.selectionRange) {
    text = editor.value.slice(findState.selectionRange[0], findState.selectionRange[1]);
    baseOffset = findState.selectionRange[0];
  }
  let m;
  let safety = 0;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) { re.lastIndex++; continue; }
    findState.matches.push({ start: baseOffset + m.index, end: baseOffset + m.index + m[0].length });
    if (++safety > 50000) break;
  }
  if (findState.matches.length === 0) {
    findState.currentIndex = -1;
  } else if (findState.currentIndex < 0 || findState.currentIndex >= findState.matches.length) {
    findState.currentIndex = 0;
  }
  updateFindCounter();
  updateHighlightOverlay();
  // Only scroll/flash on explicit navigation, not on every keystroke in the find input.
  if (flash && findState.currentIndex >= 0) flashMatch(findState.matches[findState.currentIndex]);
}

function updateFindCounter() {
  if (!findState.query) findCounter.textContent = '';
  else if (findState.matches.length === 0) findCounter.textContent = 'No results';
  else findCounter.textContent = `${findState.currentIndex + 1} of ${findState.matches.length}`;
}

function scrollEditorToOffset(pos) {
  // Scroll the textarea so the line containing `pos` is roughly centered,
  // WITHOUT changing the textarea's selection or stealing focus.
  const lineNo = (editor.value.slice(0, pos).match(/\n/g) || []).length;
  const cs = getComputedStyle(editor);
  const lineHeight = parseFloat(cs.lineHeight) || 22;
  const padTop = parseFloat(cs.paddingTop) || 0;
  const targetTop = padTop + lineNo * lineHeight - editor.clientHeight / 2;
  const newTop = Math.max(0, targetTop);
  editor.scrollTop = newTop;
  editorHighlight.scrollTop = newTop;
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Rebuild the highlight overlay behind the textarea. Wraps each match in a
// span; the current match gets an extra .match-current class for emphasis.
function updateHighlightOverlay() {
  if (!findState.open || findState.matches.length === 0) {
    editorHighlight.innerHTML = '';
    return;
  }
  const text = editor.value;
  const matches = findState.matches;
  let html = '';
  let pos = 0;
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    if (m.start > pos) html += escapeHtml(text.slice(pos, m.start));
    const cls = (i === findState.currentIndex) ? 'match-highlight match-current' : 'match-highlight';
    html += `<span class="${cls}">${escapeHtml(text.slice(m.start, m.end))}</span>`;
    pos = m.end;
  }
  if (pos < text.length) html += escapeHtml(text.slice(pos));
  // Append a trailing space so a final newline doesn't get collapsed by the browser.
  editorHighlight.innerHTML = html + ' ';
  editorHighlight.scrollTop = editor.scrollTop;
}

function flashMatch(match) {
  // Scroll editor passively (no selection change), scroll preview block, flash it.
  scrollEditorToOffset(match.start);
  const block = blockMap.find(b => match.start >= b.startChar && match.start < b.endChar);
  if (block) {
    const blockEl = preview.querySelector(`.md-block[data-md-block-id="${block.id}"]`);
    if (blockEl) {
      blockEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      clearMatchFlash();
      blockEl.classList.add('md-match-flash');
      setTimeout(() => blockEl.classList.remove('md-match-flash'), 1200);
    }
  }
}

function clearMatchFlash() {
  preview.querySelectorAll('.md-match-flash').forEach(el => el.classList.remove('md-match-flash'));
}

function findNext() {
  if (findState.matches.length === 0) return;
  findState.currentIndex = (findState.currentIndex + 1) % findState.matches.length;
  updateFindCounter();
  updateHighlightOverlay();
  flashMatch(findState.matches[findState.currentIndex]);
}

function findPrev() {
  if (findState.matches.length === 0) return;
  findState.currentIndex = (findState.currentIndex - 1 + findState.matches.length) % findState.matches.length;
  updateFindCounter();
  updateHighlightOverlay();
  flashMatch(findState.matches[findState.currentIndex]);
}

function applyReplacement(matched) {
  if (!findState.regex) return findState.replacement;
  const re = buildSearchRegex();
  if (!re) return findState.replacement;
  const singleRe = new RegExp(re.source, re.flags.replace('g', ''));
  return matched.replace(singleRe, findState.replacement);
}

function replaceCurrent() {
  if (findState.currentIndex < 0 || findState.matches.length === 0) return;
  const match = findState.matches[findState.currentIndex];
  const replacement = applyReplacement(editor.value.slice(match.start, match.end));
  const delta = replacement.length - (match.end - match.start);
  // Remember where focus was so applyEdit's editor.focus() doesn't strand us in the textarea.
  const focusedBefore = document.activeElement;
  applyEdit(match.start, match.end, replacement);
  if (findState.inSelection && findState.selectionRange) {
    findState.selectionRange[1] += delta;
  }
  markDirty();
  render();
  // Restore focus to whichever find-panel input the user was in.
  if (focusedBefore === replaceInput) replaceInput.focus();
  else findInput.focus();
}

function replaceAll() {
  if (findState.matches.length === 0) return;
  const count = findState.matches.length;
  // Build the full new text in one pass, then apply as a single undoable edit.
  let val = editor.value;
  let totalDelta = 0;
  for (let i = 0; i < findState.matches.length; i++) {
    const m = findState.matches[i];
    const adjStart = m.start + totalDelta;
    const adjEnd = m.end + totalDelta;
    const replacement = applyReplacement(val.slice(adjStart, adjEnd));
    val = val.slice(0, adjStart) + replacement + val.slice(adjEnd);
    totalDelta += replacement.length - (m.end - m.start);
  }
  const focusedBefore = document.activeElement;
  applyEdit(0, editor.value.length, val);
  if (findState.inSelection && findState.selectionRange) {
    findState.selectionRange[1] += totalDelta;
  }
  markDirty();
  render();
  findCounter.textContent = `Replaced ${count}`;
  if (focusedBefore === replaceInput) replaceInput.focus();
  else findInput.focus();
}

// Find input wiring
findInput.addEventListener('input', () => {
  findState.query = findInput.value;
  findState.currentIndex = -1;
  updateMatches(); // no flash — typing just refreshes the overlay
});
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (e.shiftKey) findPrev(); else findNext();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeFind();
  }
});
replaceInput.addEventListener('input', () => {
  findState.replacement = replaceInput.value;
});
replaceInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) replaceAll();
    else replaceCurrent();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeFind();
  }
});

function toggleFlag(key, btn) {
  if (key === 'inSelection') {
    if (!findState.inSelection) {
      if (editor.selectionStart !== editor.selectionEnd) {
        findState.inSelection = true;
        findState.selectionRange = [editor.selectionStart, editor.selectionEnd];
      } else {
        return;
      }
    } else {
      findState.inSelection = false;
      findState.selectionRange = null;
    }
    btn.classList.toggle('active', findState.inSelection);
  } else {
    findState[key] = !findState[key];
    btn.classList.toggle('active', findState[key]);
  }
  findState.currentIndex = -1;
  updateMatches({ flash: true });
}

findCaseBtn.addEventListener('click', () => toggleFlag('caseSensitive', findCaseBtn));
findWordBtn.addEventListener('click', () => toggleFlag('wholeWord', findWordBtn));
findRegexBtn.addEventListener('click', () => toggleFlag('regex', findRegexBtn));
findInSelBtn.addEventListener('click', () => toggleFlag('inSelection', findInSelBtn));

document.getElementById('find-next').addEventListener('click', findNext);
document.getElementById('find-prev').addEventListener('click', findPrev);
document.getElementById('find-replace').addEventListener('click', replaceCurrent);
document.getElementById('find-replace-all').addEventListener('click', replaceAll);
document.getElementById('find-close').addEventListener('click', closeFind);

// =========================================================================
// CLICK-TO-EDIT POPOVER
// =========================================================================

function showEditPopover(blockId, targetEl) {
  closeActivePopover();
  const block = blockMap[blockId];
  if (!block) return;

  const popover = document.createElement('div');
  popover.className = 'edit-popover';
  popover.innerHTML = `
    <textarea class="edit-popover-text" spellcheck="false"></textarea>
    <div class="edit-popover-buttons">
      <button class="popover-cancel">Cancel</button>
      <button class="popover-save">Save (Ctrl+Enter)</button>
    </div>
  `;
  popoverHost.appendChild(popover);
  const textarea = popover.querySelector('.edit-popover-text');
  textarea.value = block.source;
  const lineCount = block.source.split('\n').length;
  textarea.rows = Math.max(3, Math.min(20, lineCount + 1));

  positionPopover(popover, targetEl);
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);

  const save = () => {
    let inserted = textarea.value;
    if (!inserted.endsWith('\n')) inserted += '\n';
    closeActivePopover();
    applyEdit(block.startChar, block.endChar, inserted);
    markDirty();
    render();
  };
  const cancel = () => closeActivePopover();

  popover.querySelector('.popover-save').addEventListener('click', save);
  popover.querySelector('.popover-cancel').addEventListener('click', cancel);
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
  });

  activePopover = { el: popover, blockId };
}

function positionPopover(popover, targetEl) {
  const rect = targetEl.getBoundingClientRect();
  const w = Math.min(560, window.innerWidth - 40);
  let left = rect.left;
  if (left + w > window.innerWidth - 20) left = window.innerWidth - w - 20;
  if (left < 20) left = 20;
  let top = rect.bottom + 6;
  popover.style.position = 'fixed';
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
  popover.style.width = `${w}px`;
  // After layout, check if popover overflows bottom; if so position above
  requestAnimationFrame(() => {
    const pr = popover.getBoundingClientRect();
    if (pr.bottom > window.innerHeight - 40) {
      let above = rect.top - pr.height - 6;
      if (above < 20) above = 20;
      popover.style.top = `${above}px`;
    }
  });
}

function closeActivePopover() {
  if (activePopover) {
    activePopover.el.remove();
    activePopover = null;
  }
}

// Double-click on block opens edit popover (preserves text selection on single click)
preview.addEventListener('dblclick', (e) => {
  // Reading mode disables click-to-edit entirely (checkboxes still work via
  // the 'change' handler).
  if (settings.readingMode) return;
  if (e.target.closest('.md-plus')) return;
  if (e.target.closest('a')) return; // Don't trigger on links
  if (e.target.tagName === 'INPUT') return; // Don't trigger on task checkboxes
  const blockEl = e.target.closest('.md-block');
  if (!blockEl) return;
  const id = parseInt(blockEl.dataset.mdBlockId, 10);
  if (isNaN(id)) return;
  e.preventDefault();
  window.getSelection().removeAllRanges();
  showEditPopover(id, blockEl);
});

// Task list checkbox → toggle the corresponding marker in the source markdown.
// We don't pre-tag checkboxes with indices in the render; we count them at click
// time within the containing block and walk the block's source for the N-th `[ ]` or `[x]`.
const TASK_MARKER_RE = /^([ \t]*[-*+][ \t]+)\[([ xX])\]/gm;

preview.addEventListener('change', (e) => {
  const cb = e.target;
  if (!cb || cb.tagName !== 'INPUT' || cb.type !== 'checkbox') return;
  const blockEl = cb.closest('.md-block');
  if (!blockEl) return;
  const blockIdAttr = blockEl.dataset.mdBlockId;
  const blockId = parseInt(blockIdAttr, 10);
  if (isNaN(blockId)) return;
  const block = blockMap[blockId];
  if (!block) return;

  const allBoxes = Array.from(blockEl.querySelectorAll('input[type="checkbox"]'));
  const cbIdx = allBoxes.indexOf(cb);
  if (cbIdx < 0) return;

  // Walk the block's source and find the cbIdx-th task marker.
  TASK_MARKER_RE.lastIndex = 0;
  let m, hit = -1, found = 0;
  while ((m = TASK_MARKER_RE.exec(block.source)) !== null) {
    if (found === cbIdx) { hit = m.index + m[1].length; break; }
    found++;
  }
  if (hit < 0) return;

  // applyEdit() calls editor.focus() + setSelectionRange(), which would yank
  // the textarea scroll to the cursor position (and jumps to top if the
  // cursor was at offset 0 in some other tab). Capture editor and preview
  // scroll positions and the selection up front so we can restore both after
  // render() finishes. Selection too — focus restoration alone isn't enough
  // because the textarea will scroll to keep the caret visible.
  const savedEditorScroll = editor.scrollTop;
  const savedSelStart = editor.selectionStart;
  const savedSelEnd = editor.selectionEnd;
  const savedPreviewScroll = previewScroll.scrollTop;
  const savedFocus = document.activeElement;

  const newMarker = cb.checked ? '[x]' : '[ ]';
  let newSource = block.source.slice(0, hit) + newMarker + block.source.slice(hit + 3);
  if (!newSource.endsWith('\n')) newSource += '\n';
  applyEdit(block.startChar, block.endChar, newSource);
  markDirty();
  // render() rebuilds the preview innerHTML which would reset preview scroll
  // to 0; restore on the next frame after layout. Editor scroll is restored
  // immediately because applyEdit's setSelectionRange already happened.
  try { editor.setSelectionRange(savedSelStart, savedSelEnd); } catch (_e) {}
  editor.scrollTop = savedEditorScroll;
  editorHighlight.scrollTop = savedEditorScroll;
  if (savedFocus && savedFocus !== editor) {
    try { savedFocus.focus(); } catch (_e) {}
  }
  render().then(() => {
    previewScroll.scrollTop = savedPreviewScroll;
  });
});

// =========================================================================
// INSERT MENU + ELEMENT TEMPLATES
// =========================================================================

const elementTemplates = [
  { label: 'Heading 1',        kind: 'simple', template: '# Heading' },
  { label: 'Heading 2',        kind: 'simple', template: '## Heading' },
  { label: 'Heading 3',        kind: 'simple', template: '### Heading' },
  { label: 'Heading 4',        kind: 'simple', template: '#### Heading' },
  { label: 'Heading 5',        kind: 'simple', template: '##### Heading' },
  { label: 'Heading 6',        kind: 'simple', template: '###### Heading' },
  { label: 'Paragraph',        kind: 'simple', template: 'New paragraph.' },
  { label: 'Bulleted list',    kind: 'simple', template: '- Item 1\n- Item 2\n- Item 3' },
  { label: 'Numbered list',    kind: 'simple', template: '1. Item 1\n1. Item 2\n1. Item 3' },
  { label: 'Task list',        kind: 'simple', template: '- [ ] Task 1\n- [ ] Task 2\n- [x] Done task' },
  { label: 'Blockquote',       kind: 'simple', template: '> Quote text.' },
  { label: 'Horizontal rule',  kind: 'simple', template: '---' },
  { label: 'Code block',       kind: 'code' },
  { label: 'Table',            kind: 'table' },
  { label: 'Math (block)',     kind: 'simple', template: '$$\nE = mc^2\n$$' },
  { label: 'Mermaid diagram',  kind: 'simple', template: '```mermaid\ngraph LR\n  A --> B\n  B --> C\n```' },
  { label: 'Image',            kind: 'image' },
];

function showInsertMenu(x, y, insertPosition) {
  closeActiveInsertMenu();
  const menu = document.createElement('div');
  menu.className = 'insert-menu';

  elementTemplates.forEach(t => {
    const item = document.createElement('button');
    item.className = 'insert-menu-item';
    item.textContent = t.label;
    item.addEventListener('click', () => {
      closeActiveInsertMenu();
      handleInsert(t, insertPosition);
    });
    menu.appendChild(item);
  });

  insertMenuHost.appendChild(menu);
  menu.style.position = 'fixed';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  requestAnimationFrame(() => {
    const r = menu.getBoundingClientRect();
    if (r.right > window.innerWidth - 10) menu.style.left = `${window.innerWidth - r.width - 10}px`;
    if (r.bottom > window.innerHeight - 10) menu.style.top = `${Math.max(10, y - r.height - 10)}px`;
  });

  activeInsertMenu = menu;
  setTimeout(() => {
    document.addEventListener('mousedown', maybeCloseInsertMenuOnOutside);
  }, 0);
}

function maybeCloseInsertMenuOnOutside(e) {
  if (activeInsertMenu && !activeInsertMenu.contains(e.target)) {
    closeActiveInsertMenu();
  }
}

function closeActiveInsertMenu() {
  if (activeInsertMenu) {
    activeInsertMenu.remove();
    activeInsertMenu = null;
    document.removeEventListener('mousedown', maybeCloseInsertMenuOnOutside);
  }
}

async function handleInsert(template, insertChar) {
  let toInsert = '';
  if (template.kind === 'simple') {
    toInsert = template.template;
  } else if (template.kind === 'code') {
    const lang = await pickLanguage();
    if (lang === null) return;
    toInsert = '```' + lang + '\n\n```';
  } else if (template.kind === 'table') {
    const dims = await pickTableSize();
    if (!dims) return;
    toInsert = buildTable(dims.cols, dims.rows);
  } else if (template.kind === 'image') {
    const result = await ipcRenderer.invoke('pick-image');
    if (!result) return;
    const url = String(result).replace(/\\/g, '/');
    toInsert = `![](${url})`;
  }
  if (toInsert) insertAtChar(insertChar, toInsert);
}

function buildTable(cols, rows) {
  const header = '| ' + Array.from({length: cols}, (_, i) => `Col ${i+1}`).join(' | ') + ' |';
  const sep    = '|' + Array.from({length: cols}, () => '---').join('|') + '|';
  const dataRow= '| ' + Array.from({length: cols}, () => '   ').join(' | ') + ' |';
  const data   = Array.from({length: rows}, () => dataRow).join('\n');
  return header + '\n' + sep + '\n' + data;
}

function pickLanguage() {
  return new Promise(resolve => {
    const langs = ['text','js','ts','tsx','jsx','py','rb','go','rs','java','c','cpp','cs','sh','bash','powershell','sql','yaml','json','toml','html','css','md','diff','xml','dockerfile','makefile','php','swift','kotlin','scala','lua','r','perl'];
    const overlay = document.createElement('div');
    overlay.className = 'picker-overlay';
    overlay.innerHTML = `
      <div class="picker">
        <div class="picker-title">Choose language</div>
        <input class="picker-input" placeholder="Filter..." />
        <div class="picker-options"></div>
      </div>
    `;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('.picker-input');
    const opts = overlay.querySelector('.picker-options');
    function renderList(filter) {
      opts.innerHTML = '';
      const f = filter.toLowerCase().trim();
      const filtered = f ? langs.filter(l => l.includes(f)) : langs;
      filtered.forEach((l, i) => {
        const btn = document.createElement('button');
        btn.textContent = l;
        btn.addEventListener('click', () => { cleanup(); resolve(l); });
        if (i === 0) btn.classList.add('focused');
        opts.appendChild(btn);
      });
    }
    function cleanup() {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); cleanup(); resolve(null); }
    }
    renderList('');
    input.addEventListener('input', () => renderList(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const first = opts.querySelector('button');
        if (first) first.click();
      }
    });
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) { cleanup(); resolve(null); }
    });
    input.focus();
  });
}

function pickTableSize() {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'picker-overlay';
    overlay.innerHTML = `
      <div class="picker">
        <div class="picker-title">Table size</div>
        <div class="table-size-grid"></div>
        <div class="table-size-label">Hover then click</div>
      </div>
    `;
    document.body.appendChild(overlay);
    const grid = overlay.querySelector('.table-size-grid');
    const label = overlay.querySelector('.table-size-label');
    const maxCols = 8, maxRows = 8;
    for (let r = 0; r < maxRows; r++) {
      for (let c = 0; c < maxCols; c++) {
        const cell = document.createElement('div');
        cell.className = 'table-size-cell';
        cell.dataset.r = String(r);
        cell.dataset.c = String(c);
        grid.appendChild(cell);
      }
    }
    function cleanup() {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) {
      if (e.key === 'Escape') { cleanup(); resolve(null); }
    }
    document.addEventListener('keydown', onKey);
    grid.addEventListener('mousemove', (e) => {
      const cell = e.target.closest('.table-size-cell');
      if (!cell) return;
      const r = parseInt(cell.dataset.r) + 1;
      const c = parseInt(cell.dataset.c) + 1;
      label.textContent = `${c} × ${r}`;
      grid.querySelectorAll('.table-size-cell').forEach(el => {
        const cr = parseInt(el.dataset.r);
        const cc = parseInt(el.dataset.c);
        el.classList.toggle('hover', cr < r && cc < c);
      });
    });
    grid.addEventListener('click', (e) => {
      const cell = e.target.closest('.table-size-cell');
      if (!cell) return;
      const r = parseInt(cell.dataset.r) + 1;
      const c = parseInt(cell.dataset.c) + 1;
      cleanup();
      resolve({ rows: r, cols: c });
    });
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) { cleanup(); resolve(null); }
    });
  });
}

function insertAtChar(charPos, text) {
  // Pad with newlines so the inserted block becomes its own paragraph.
  let prefix = '';
  let suffix = '';
  if (charPos > 0 && editor.value[charPos - 1] !== '\n') prefix = '\n\n';
  else if (charPos > 1 && editor.value[charPos - 2] !== '\n') prefix = '\n';
  if (charPos < editor.value.length && editor.value[charPos] !== '\n') suffix = '\n\n';
  else if (!text.endsWith('\n')) suffix = '\n';

  applyEdit(charPos, charPos, prefix + text + suffix);
  markDirty();
  render();
}

// Plus button click → insert menu
preview.addEventListener('click', (e) => {
  const plusBtn = e.target.closest('.md-plus-btn');
  if (!plusBtn) return;
  e.stopPropagation();
  e.preventDefault();
  const plusEl = plusBtn.closest('.md-plus');
  const insertPosition = parseInt(plusEl.dataset.insertBefore, 10);
  const insertChar = insertPosition >= blockMap.length
    ? editor.value.length
    : blockMap[insertPosition].startChar;
  const rect = plusBtn.getBoundingClientRect();
  showInsertMenu(rect.left, rect.bottom + 4, insertChar);
});

// Toolbar button → insert at the editor's cursor position
insertToolbar.addEventListener('click', (e) => {
  const btn = e.target.closest('.toolbar-btn');
  if (!btn) return;
  if (btn.dataset.format) {
    applyFormat(btn.dataset.format);
    return;
  }
  const templateLabel = btn.dataset.template;
  const template = elementTemplates.find(t => t.label === templateLabel);
  if (!template) return;
  handleInsert(template, editor.selectionStart);
});

// =========================================================================
// INLINE FORMAT (bold/italic/underline/strike/code)
// =========================================================================
// Toggle model:
//   1. Peel recognized wrappers outward from the selection one layer at a
//      time. Runs of `*` are merged into a single "stars" layer with a count
//      — that's how bold (`**`) and italic (`*`) compose into `***` for
//      bold+italic without ever stripping each other.
//   2. Decide whether the requested format is already present anywhere in
//      the peeled chain (stars >= 2 → bold; stars odd → italic; matching
//      kind for the others). If yes, remove that contribution; if no, add
//      it at the innermost layer.
//   3. Rebuild the source from outside in and replace the entire peeled
//      span.
// Empty selection still falls back to the simple placeholder-wrap path —
// peeling there would do strange things to neighboring text.

const FORMAT_MARKERS = {
  bold:      { open: '**',  close: '**',   placeholder: 'bold text' },
  italic:    { open: '*',   close: '*',    placeholder: 'italic text' },
  underline: { open: '<u>', close: '</u>', placeholder: 'underlined text' },
  strike:    { open: '~~',  close: '~~',   placeholder: 'strikethrough' },
  code:      { open: '`',   close: '`',    placeholder: 'code' },
};

// Non-star markers, longest-open first so '~~' isn't shadowed by '`' etc.
const NON_STAR_MARKERS = [
  { kind: 'underline', open: '<u>', close: '</u>' },
  { kind: 'strike',    open: '~~',  close: '~~'   },
  { kind: 'code',      open: '`',   close: '`'    },
];

// Peel format layers outward from [start, end]. Returns the layer chain
// (innermost first) plus the outermost left/right boundaries reached.
function peelFormatLayers(v, start, end) {
  let left = start;
  let right = end;
  const layers = [];
  while (true) {
    let progress = false;

    // Try non-star markers (distinct openers — straightforward match).
    for (const m of NON_STAR_MARKERS) {
      if (left - m.open.length < 0) continue;
      if (v.slice(left - m.open.length, left) === m.open &&
          v.slice(right, right + m.close.length) === m.close) {
        layers.push({ kind: m.kind, open: m.open, close: m.close });
        left -= m.open.length;
        right += m.close.length;
        progress = true;
        break;
      }
    }
    if (progress) continue;

    // Star peel: collapse the full adjacent runs on each side into one
    // symmetric layer so `***` stays a single entity.
    let sL = 0, sR = 0;
    while (left - sL - 1 >= 0 && v[left - sL - 1] === '*') sL++;
    while (right + sR < v.length && v[right + sR] === '*') sR++;
    const s = Math.min(sL, sR);
    if (s > 0) {
      layers.push({ kind: 'stars', count: s });
      left -= s;
      right += s;
      continue;
    }
    break;
  }
  return { layers, outerLeft: left, outerRight: right };
}

function applyFormat(kind) {
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const v = editor.value;

  // Empty selection: keep the placeholder-wrap shortcut.
  if (start === end) {
    const m = FORMAT_MARKERS[kind];
    if (!m) return;
    applyEdit(start, end, m.open + m.placeholder + m.close);
    editor.setSelectionRange(start + m.open.length, start + m.open.length + m.placeholder.length);
    markDirty();
    render();
    return;
  }

  const { layers, outerLeft, outerRight } = peelFormatLayers(v, start, end);
  const selected = v.slice(start, end);
  const isStar = (kind === 'bold' || kind === 'italic');
  let removed = false;

  // Search outermost layer first so pressing the format key removes the
  // *outer* contribution — matches the user's mental model of "untangle the
  // wrapping I just added."
  for (let i = layers.length - 1; i >= 0; i--) {
    const L = layers[i];
    if (isStar) {
      if (L.kind !== 'stars') continue;
      if (kind === 'bold' && L.count >= 2) {
        L.count -= 2;
        if (L.count === 0) layers.splice(i, 1);
        removed = true;
        break;
      }
      if (kind === 'italic' && (L.count % 2 === 1)) {
        L.count -= 1;
        if (L.count === 0) layers.splice(i, 1);
        removed = true;
        break;
      }
    } else if (L.kind === kind) {
      layers.splice(i, 1);
      removed = true;
      break;
    }
  }

  if (!removed) {
    if (isStar) {
      const add = kind === 'bold' ? 2 : 1;
      // Merge into an existing innermost stars run if there is one.
      if (layers.length > 0 && layers[0].kind === 'stars') {
        layers[0].count += add;
      } else {
        layers.unshift({ kind: 'stars', count: add });
      }
    } else {
      const m = FORMAT_MARKERS[kind];
      layers.unshift({ kind, open: m.open, close: m.close });
    }
  }

  // Rebuild outer-first so markers nest in the same order as the peel chain.
  let leftStr = '', rightStr = '';
  for (let i = layers.length - 1; i >= 0; i--) {
    const L = layers[i];
    if (L.kind === 'stars') {
      const stars = '*'.repeat(L.count);
      leftStr += stars;
      rightStr = stars + rightStr;
    } else {
      leftStr += L.open;
      rightStr = L.close + rightStr;
    }
  }

  const newText = leftStr + selected + rightStr;
  applyEdit(outerLeft, outerRight, newText);
  editor.setSelectionRange(outerLeft + leftStr.length, outerLeft + leftStr.length + selected.length);
  markDirty();
  render();
}

// =========================================================================
// EDITOR EVENTS
// =========================================================================

let renderTimer;
editor.addEventListener('input', () => {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(render, 150);
  markDirty();
  invalidateEditorLineMetrics();
  updateLineNumbers();
  if (findState.open && findState.query) updateMatches();
});

// Keep the highlight overlay in lock-step with textarea scroll.
editor.addEventListener('scroll', () => {
  editorHighlight.scrollTop = editor.scrollTop;
  if (lineNumbersEl) lineNumbersEl.scrollTop = editor.scrollTop;
  syncPreviewScrollFromEditor();
});

// =========================================================================
// EDITOR KEYBOARD: Tab indent + list continuation
// =========================================================================

const INDENT = '  '; // 2 spaces, per user preference

// Parse a single line for a list-marker prefix. Returns:
//   { prefix, content, kind, num }   where prefix is indent + marker + space,
//                                    content is everything after,
//                                    kind is 'bullet' | 'numbered' | 'task',
//                                    num is the captured number (numbered only).
// Returns null if the line isn't a recognized list line.
function parseListLine(line) {
  // Task list FIRST so it isn't shadowed by the bullet matcher.
  let m = /^([ \t]*)([-*+])[ \t]+\[([ xX])\][ \t]?(.*)$/.exec(line);
  if (m) {
    const prefix = `${m[1]}${m[2]} [ ] `;
    return { prefix, content: m[4], kind: 'task' };
  }
  m = /^([ \t]*)(\d+)\.[ \t]+(.*)$/.exec(line);
  if (m) {
    const prefix = `${m[1]}${m[2]}. `;
    return { prefix, content: m[3], kind: 'numbered', num: parseInt(m[2], 10) };
  }
  m = /^([ \t]*)([-*+])[ \t]+(.*)$/.exec(line);
  if (m) {
    const prefix = `${m[1]}${m[2]} `;
    return { prefix, content: m[3], kind: 'bullet' };
  }
  return null;
}

// Find the [start, end) char range of the line containing `pos`.
function lineRangeAt(text, pos) {
  let start = pos;
  while (start > 0 && text[start - 1] !== '\n') start--;
  let end = pos;
  while (end < text.length && text[end] !== '\n') end++;
  return [start, end];
}

editor.addEventListener('keydown', (e) => {
  // Tab: indent at cursor or selection.
  if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    handleTabKey(e.shiftKey);
    return;
  }
  // Enter / Shift+Enter: list continuation / list exit / plain newline.
  if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    if (handleEnterKey(e.shiftKey)) {
      e.preventDefault();
    }
    return;
  }
});

function handleTabKey(shifted) {
  const v = editor.value;
  const start = editor.selectionStart;
  const end = editor.selectionEnd;

  // Multi-line selection → block indent/outdent every line covered.
  // (Single-line selection still uses the block path so Shift+Tab can outdent.)
  const sel = v.slice(start, end);
  const isMultiLine = sel.includes('\n');
  if (start !== end && (isMultiLine || shifted)) {
    const [lineStart] = lineRangeAt(v, start);
    // End boundary: if selection ends exactly at a line start, don't grab the
    // next line. Otherwise extend to end of its line.
    let blockEnd = end;
    if (end > start && v[end - 1] !== '\n') {
      while (blockEnd < v.length && v[blockEnd] !== '\n') blockEnd++;
    }
    const block = v.slice(lineStart, blockEnd);
    let newBlock;
    if (shifted) {
      newBlock = block.replace(/^( {1,2}|\t)/gm, '');
    } else {
      newBlock = block.replace(/^/gm, INDENT);
    }
    applyEdit(lineStart, blockEnd, newBlock);
    const delta = newBlock.length - block.length;
    const newStart = Math.max(lineStart, start + (shifted ? -INDENT.length : INDENT.length));
    editor.setSelectionRange(newStart, end + delta);
    markDirty();
    render();
    return;
  }

  // Caret-only: outdent the current line on Shift+Tab.
  if (shifted) {
    const [lineStart] = lineRangeAt(v, start);
    const line = v.slice(lineStart, lineStart + INDENT.length);
    if (line === INDENT) {
      applyEdit(lineStart, lineStart + INDENT.length, '');
      const newPos = Math.max(lineStart, start - INDENT.length);
      editor.setSelectionRange(newPos, newPos);
      markDirty();
      render();
    } else if (v[lineStart] === '\t') {
      applyEdit(lineStart, lineStart + 1, '');
      const newPos = Math.max(lineStart, start - 1);
      editor.setSelectionRange(newPos, newPos);
      markDirty();
      render();
    }
    return;
  }

  // Caret-only insert: 2 spaces at cursor.
  applyEdit(start, end, INDENT);
  const newPos = start + INDENT.length;
  editor.setSelectionRange(newPos, newPos);
  markDirty();
  render();
}

// Returns true if we handled the key (caller preventDefaults).
function handleEnterKey(shifted) {
  const v = editor.value;
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  if (start !== end) return false; // selection: let default Enter replace it

  const [lineStart, lineEnd] = lineRangeAt(v, start);
  const line = v.slice(lineStart, lineEnd);
  const parsed = parseListLine(line);
  if (!parsed) return false; // not a list line — default Enter

  // Shift+Enter or Enter at column 0 (cursor before any marker text) → plain
  // newline that breaks out of the list.
  if (shifted || start === lineStart) {
    applyEdit(start, end, '\n');
    const newPos = start + 1;
    editor.setSelectionRange(newPos, newPos);
    markDirty();
    render();
    return true;
  }

  // Empty list item (marker but no text content) → strip the marker so the
  // next Enter on a fresh marker exits the list cleanly.
  //
  // Two things to be careful about here:
  //   1. execCommand('insertText', false, '') on a range selection is not
  //      reliable in Chromium — some builds treat it as a no-op that
  //      returns false, which routes applyEdit through its `editor.value = X`
  //      fallback, and setting `.value` in Chromium clamps the caret to
  //      the new length (i.e. to the *end* of the document, not lineStart).
  //      Use execCommand('delete') instead — canonical for range deletion,
  //      preserves undo, and lands the caret at the start of the deleted
  //      range deterministically.
  //   2. This edit shrinks the document. When the async render() replaces
  //      preview.innerHTML, the browser can clamp previewScroll.scrollTop
  //      to match the new (shorter) content, which fires a scroll event on
  //      previewScroll. If scroll-sync is on, that would yank the editor
  //      scroll — producing the "cursor jumped to the top of the doc"
  //      symptom. Suppress the sync across the render and pin the editor's
  //      scroll position explicitly.
  if (parsed.content.length === 0) {
    const savedScroll = editor.scrollTop;
    editor.focus();
    editor.setSelectionRange(lineStart, lineEnd);
    const ok = document.execCommand('delete');
    if (!ok) {
      editor.value = editor.value.slice(0, lineStart) + editor.value.slice(lineEnd);
      invalidateEditorLineMetrics();
    }
    editor.setSelectionRange(lineStart, lineStart);
    editor.scrollTop = savedScroll;
    editorHighlight.scrollTop = savedScroll;
    if (lineNumbersEl) lineNumbersEl.scrollTop = savedScroll;
    clearTimeout(renderTimer);
    isSyncingScroll = true;
    markDirty();
    updateLineNumbers();
    render().then(() => {
      editor.scrollTop = savedScroll;
      editorHighlight.scrollTop = savedScroll;
      if (lineNumbersEl) lineNumbersEl.scrollTop = savedScroll;
      requestAnimationFrame(() => { isSyncingScroll = false; });
    });
    return true;
  }

  // Continue the list with a fresh marker. Numbered lists repeat the same
  // number per the user's pick (CommonMark will renumber on render).
  applyEdit(start, end, '\n' + parsed.prefix);
  const newPos = start + 1 + parsed.prefix.length;
  editor.setSelectionRange(newPos, newPos);
  markDirty();
  render();
  return true;
}

// =========================================================================
// HOME TAB CONTENT
// =========================================================================
// Buttons + lists. The lists are mirrored from settings.{favorites,recents}
// which main keeps in sync via 'settings-changed' broadcasts.

const homeEl = document.getElementById('home');
const homeFavoritesUl = document.getElementById('home-favorites');
const homeRecentsUl = document.getElementById('home-recents');
const homeFavoritesSection = document.getElementById('home-favorites-section');
const homeRecentsSection = document.getElementById('home-recents-section');

function basenameOf(p) {
  return (p || '').split(/[\\/]/).pop() || p;
}

function renderHomeList(ul, items, opts) {
  ul.innerHTML = '';
  if (!items || items.length === 0) {
    const li = document.createElement('li');
    li.className = 'home-list-empty';
    li.textContent = opts.emptyText;
    ul.appendChild(li);
    return;
  }
  items.forEach(item => {
    const li = document.createElement('li');
    li.className = 'home-list-item';

    const main = document.createElement('button');
    main.className = 'home-list-main';
    main.title = item.path;
    main.innerHTML = `
      <span class="home-list-name"></span>
      <span class="home-list-path"></span>
    `;
    main.querySelector('.home-list-name').textContent = basenameOf(item.path);
    main.querySelector('.home-list-path').textContent = item.path;
    main.addEventListener('click', () => {
      ipcRenderer.invoke('open-path', item.path);
    });
    li.appendChild(main);

    const isFav = isFavoritePath(item.path);
    const star = document.createElement('button');
    star.className = 'home-list-star';
    star.classList.toggle('active', isFav);
    star.textContent = isFav ? '★' : '☆';
    star.title = isFav ? 'Remove from Favorites' : 'Pin to Favorites';
    star.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isFav) ipcRenderer.invoke('favorites-remove', item.path);
      else ipcRenderer.invoke('favorites-add', item.path);
    });
    li.appendChild(star);

    if (opts.allowRemove) {
      const remove = document.createElement('button');
      remove.className = 'home-list-remove';
      remove.textContent = '×';
      remove.title = 'Remove from Recent';
      remove.addEventListener('click', (e) => {
        e.stopPropagation();
        ipcRenderer.invoke('recents-remove', item.path);
      });
      li.appendChild(remove);
    }

    ul.appendChild(li);
  });
}

function renderHome() {
  renderHomeList(homeFavoritesUl, settings.favorites, {
    emptyText: 'No favorites yet. Pin from Recent or click the ☆ on a tab.',
    allowRemove: false,
  });
  renderHomeList(homeRecentsUl, settings.recents, {
    emptyText: 'No recent documents yet.',
    allowRemove: true,
  });
}

function refreshHomeIfVisible() {
  if (document.body.classList.contains('home-active')) renderHome();
}

document.getElementById('home-new').addEventListener('click', () => {
  createNewTab();
});
document.getElementById('home-open').addEventListener('click', () => {
  ipcRenderer.invoke('show-open-dialog');
});

// =========================================================================
// EDITOR LINE-METRICS MEASURER
// =========================================================================
// Translates between source-line indices and pixel offsets in the editor.
// The textarea uses pre-wrap, so a single source line can take 1+ visual
// rows depending on width. Both the line-numbers gutter and scroll sync
// need accurate per-line heights — the gutter to align numbers with the
// FIRST visual row of each wrapped line, sync to map scrollTop to a
// concrete source line.
//
// The measurer is a hidden div with identical font / width / wrap rules to
// the editor's content area. Each source line is one <div>; we read
// offsetHeight from each and build a cumulative offset table.

let editorMeasurer = null;
let editorLineMetricsCache = null; // { offsets, heights }

function ensureEditorMeasurer() {
  if (editorMeasurer) return editorMeasurer;
  editorMeasurer = document.createElement('div');
  editorMeasurer.id = 'editor-line-measurer';
  editorMeasurer.style.cssText = [
    'position: absolute',
    'visibility: hidden',
    'top: 0',
    'left: -99999px',
    'pointer-events: none',
    'white-space: pre-wrap',
    'word-wrap: break-word',
    'overflow-wrap: break-word',
  ].join('; ');
  document.body.appendChild(editorMeasurer);
  return editorMeasurer;
}

function invalidateEditorLineMetrics() {
  editorLineMetricsCache = null;
}

// offsets[i] = y-pixel offset of source line i from the top of editor
// content (excluding the textarea's padding-top). heights[i] is the wrapped
// height of source line i. offsets has length lines+1; offsets[lines] is
// the total content height.
function getEditorLineMetrics() {
  if (editorLineMetricsCache) return editorLineMetricsCache;
  const m = ensureEditorMeasurer();
  const cs = getComputedStyle(editor);
  const padL = parseFloat(cs.paddingLeft) || 0;
  const padR = parseFloat(cs.paddingRight) || 0;
  const contentW = editor.clientWidth - padL - padR;
  m.style.width = Math.max(0, contentW) + 'px';
  m.style.fontFamily = cs.fontFamily;
  m.style.fontSize = cs.fontSize;
  m.style.fontWeight = cs.fontWeight;
  m.style.lineHeight = cs.lineHeight;
  m.style.letterSpacing = cs.letterSpacing;
  m.style.tabSize = cs.tabSize;
  m.style.MozTabSize = cs.tabSize;

  const lines = editor.value.split('\n');
  let html = '';
  for (let i = 0; i < lines.length; i++) {
    // Empty source line still needs measurable height — use &nbsp; so the
    // line box keeps its line-height.
    const safe = lines[i].length === 0
      ? '&nbsp;'
      : lines[i]
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
    html += `<div class="lm-row">${safe}</div>`;
  }
  m.innerHTML = html;

  const rows = m.children;
  const heights = new Array(lines.length);
  const offsets = new Array(lines.length + 1);
  offsets[0] = 0;
  for (let i = 0; i < rows.length; i++) {
    heights[i] = rows[i].offsetHeight;
    offsets[i + 1] = offsets[i] + heights[i];
  }
  editorLineMetricsCache = { offsets, heights };
  return editorLineMetricsCache;
}

// =========================================================================
// LINE NUMBERS GUTTER
// =========================================================================
// Each source line gets one <div> in the gutter whose height matches its
// wrapped height in the editor. The number anchors to the top of that cell,
// so wrapped lines display the number on the FIRST visual row — matches the
// convention used by VS Code and Obsidian.

let lineNumbersEl = null;
function ensureLineNumbersEl() {
  if (lineNumbersEl) return lineNumbersEl;
  lineNumbersEl = document.createElement('div');
  lineNumbersEl.id = 'editor-line-numbers';
  const wrap = document.getElementById('editor-wrap');
  if (wrap) wrap.prepend(lineNumbersEl);
  return lineNumbersEl;
}
function updateLineNumbers() {
  if (!settings.lineNumbers) return;
  const el = ensureLineNumbersEl();
  const { heights } = getEditorLineMetrics();
  // innerHTML in one shot is far faster than per-cell createElement for
  // multi-thousand-line docs.
  let html = '';
  for (let i = 0; i < heights.length; i++) {
    html += `<div class="editor-ln" style="height:${heights[i]}px">${i + 1}</div>`;
  }
  el.innerHTML = html;
  el.scrollTop = editor.scrollTop;
}

// Width changes (window resize, view-mode toggle, splitter) invalidate the
// wrap points, so the metrics cache must be cleared. ResizeObserver fires
// after layout — no need to debounce.
if (typeof ResizeObserver !== 'undefined') {
  const ro = new ResizeObserver(() => {
    invalidateEditorLineMetrics();
    if (settings.lineNumbers) updateLineNumbers();
  });
  ro.observe(editor);
}

// =========================================================================
// SCROLL SYNC — block-anchored, bidirectional
// =========================================================================
// Naive ratio sync (scrollTop/maxScrollTop) drifts because raw markdown and
// rendered HTML have different content densities. Instead we map source-line
// position to the corresponding preview block (via blockMap, which knows
// each block's startLine..endLine and renders into .md-block elements with a
// data-md-block-id attribute). Within a block, we keep the proportional
// position so partial scroll through a multi-line code block / paragraph
// still tracks.
//
// Wrapping is handled by getEditorLineMetrics() — both directions translate
// between pixel offset and source line using the per-line height table, so
// scrolling stays accurate even when soft-wraps multiply the effective
// height of a single source line.

let isSyncingScroll = false;

// Find the source line at the top of the editor viewport (0-based). Uses
// the line-metrics table so soft-wraps are accounted for.
function editorScrollTopToSourceLine() {
  const cs = getComputedStyle(editor);
  const padT = parseFloat(cs.paddingTop) || 0;
  const y = Math.max(0, editor.scrollTop - padT);
  const { offsets } = getEditorLineMetrics();
  // Binary search for the largest i where offsets[i] <= y.
  let lo = 0, hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= y) lo = mid; else hi = mid - 1;
  }
  // Fractional progress within line `lo`.
  const lineH = (offsets[lo + 1] ?? offsets[lo]) - offsets[lo];
  const within = lineH > 0 ? (y - offsets[lo]) / lineH : 0;
  return { line: lo, within };
}

// Convert a source-line position back to a target scrollTop in the editor.
function sourceLineToEditorScrollTop(line, within = 0) {
  const cs = getComputedStyle(editor);
  const padT = parseFloat(cs.paddingTop) || 0;
  const { offsets } = getEditorLineMetrics();
  const idx = Math.max(0, Math.min(line, offsets.length - 2));
  const lineH = offsets[idx + 1] - offsets[idx];
  return padT + offsets[idx] + within * lineH;
}

// Find the block whose source-line range covers `line`. Falls back to the
// nearest neighbour when the line sits between blocks (e.g. blank lines).
function blockForLine(line) {
  if (blockMap.length === 0) return null;
  for (let i = 0; i < blockMap.length; i++) {
    const b = blockMap[i];
    if (line < b.endLine) {
      // Either inside b, or in a gap before b (blank line). Use b either way.
      return b;
    }
  }
  return blockMap[blockMap.length - 1];
}

// Element + scroll-relative pixel position of a preview block.
function previewBlockGeom(blockId) {
  const el = preview.querySelector(`.md-block[data-md-block-id="${blockId}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const sr = previewScroll.getBoundingClientRect();
  return {
    el,
    top: r.top - sr.top + previewScroll.scrollTop,
    height: r.height,
  };
}

function syncPreviewScrollFromEditor() {
  if (!settings.scrollSync || isSyncingScroll) return;
  if (blockMap.length === 0) return;
  const { line, within: lineWithin } = editorScrollTopToSourceLine();
  const block = blockForLine(line);
  if (!block) return;
  const lineCount = Math.max(1, block.endLine - block.startLine);
  const inBlock = (line >= block.startLine && line < block.endLine);
  // Progress through the block: 0 at start, 1 at end. For lines in a gap
  // before the block, clamp to 0.
  const blockProgress = inBlock
    ? Math.min(1, ((line - block.startLine) + lineWithin) / lineCount)
    : 0;
  const geom = previewBlockGeom(block.id);
  if (!geom) return;
  const target = geom.top + blockProgress * geom.height;
  isSyncingScroll = true;
  previewScroll.scrollTop = Math.max(0, target);
  requestAnimationFrame(() => { isSyncingScroll = false; });
}

function syncEditorScrollFromPreview() {
  if (!settings.scrollSync || isSyncingScroll) return;
  if (blockMap.length === 0) return;
  const previewTop = previewScroll.scrollTop;
  // Find the block whose vertical span covers previewTop.
  const sr = previewScroll.getBoundingClientRect();
  let chosen = null;
  let progress = 0;
  for (let i = 0; i < blockMap.length; i++) {
    const el = preview.querySelector(`.md-block[data-md-block-id="${blockMap[i].id}"]`);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    const top = r.top - sr.top + previewTop;
    const bottom = top + r.height;
    if (bottom > previewTop) {
      chosen = blockMap[i];
      progress = r.height > 0
        ? Math.max(0, Math.min(1, (previewTop - top) / r.height))
        : 0;
      break;
    }
  }
  if (!chosen) chosen = blockMap[blockMap.length - 1];
  const lineCount = Math.max(1, chosen.endLine - chosen.startLine);
  const targetLine = chosen.startLine + Math.floor(progress * lineCount);
  const within = (progress * lineCount) - Math.floor(progress * lineCount);
  const newScroll = sourceLineToEditorScrollTop(targetLine, within);
  isSyncingScroll = true;
  editor.scrollTop = newScroll;
  editorHighlight.scrollTop = newScroll;
  if (lineNumbersEl) lineNumbersEl.scrollTop = newScroll;
  requestAnimationFrame(() => { isSyncingScroll = false; });
}
previewScroll.addEventListener('scroll', syncEditorScrollFromPreview);

// =========================================================================
// IPC + KEYBOARD
// =========================================================================

function pathsEqual(a, b) {
  if (!a || !b) return false;
  // Case-insensitive comparison on Windows; case-sensitive elsewhere.
  return navigator.platform.startsWith('Win') ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function findTabByPath(filePath) {
  return tabs.find(t => pathsEqual(t.filePath, filePath)) || null;
}

function notifyTabList() {
  const paths = tabs.map(t => t.filePath).filter(Boolean);
  ipcRenderer.send('tab-list-changed', paths);
}

ipcRenderer.on('file-loaded', (_e, { filePath, content }) => {
  // Same-window dedup: if this file is already open in a tab, switch to it.
  const existing = findTabByPath(filePath);
  if (existing) {
    switchToTab(existing.id);
    return;
  }
  // Reuse the active tab ONLY if it's an untouched Untitled tab (no file path
  // AND no edits AND not Home). Home isn't a document and Untitled-N with
  // edits should preserve its work.
  const t = activeTab();
  if (t && !isHomeTab(t) && !t.filePath && !t.isModified) {
    t.filePath = filePath;
    t.title = filePath.split(/[\\/]/).pop();
    t.content = content;
    isSwitchingTab = true;
    editor.value = content;
    isSwitchingTab = false;
    filepathEl.textContent = filePath;
    statusEl.textContent = '';
    closeFind();
    renderTabBar();
    render();
  } else {
    createNewTab({ filePath, content });
  }
  notifyTabList();
});

// Cross-window dedup: main asked us to focus a tab that already has this file.
ipcRenderer.on('focus-tab', (_e, filePath) => {
  const existing = findTabByPath(filePath);
  if (existing) switchToTab(existing.id);
});

// Receive a tab dragged in from another window.
ipcRenderer.on('add-tab', (_e, tabData) => {
  // If a tab with this file is already in this window, just focus it.
  if (tabData.filePath) {
    const existing = findTabByPath(tabData.filePath);
    if (existing) {
      switchToTab(existing.id);
      return;
    }
  }
  const tab = createNewTab({ filePath: tabData.filePath, content: tabData.content || '' });
  if (tabData.isModified) {
    tab.isModified = true;
    renderTabBar();
  }
  if (tabData.backupId) tab.backupId = tabData.backupId;
  notifyTabList();
});

// New window can be opened with a set of tabs pre-loaded (used by detach
// across windows, and by crash recovery at app startup).
ipcRenderer.on('init-tabs', (_e, initial) => {
  if (!Array.isArray(initial) || initial.length === 0) return;
  tabs.length = 0;
  activeTabId = null;
  ensureHomeTab();
  initial.forEach(t => {
    const tab = makeTab({ filePath: t.filePath, content: t.content || '', title: t.title || null });
    tab.isModified = !!t.isModified;
    if (t.backupId) tab.backupId = t.backupId;
    tabs.push(tab);
  });
  const firstDoc = documentTabs()[0];
  if (!firstDoc) {
    // Shouldn't happen — init-tabs is only sent with a non-empty list — but
    // be defensive and land on Home.
    activeTabId = HOME_TAB_ID;
    document.body.classList.add('home-active');
    filepathEl.textContent = 'Home';
    renderTabBar();
    renderHome();
    notifyTabList();
    return;
  }
  activeTabId = firstDoc.id;
  document.body.classList.remove('home-active');
  isSwitchingTab = true;
  editor.value = firstDoc.content;
  isSwitchingTab = false;
  filepathEl.textContent = firstDoc.filePath || firstDoc.title;
  statusEl.textContent = firstDoc.isModified ? '• unsaved' : '';
  renderTabBar();
  notifyTabList();
  render();
});

// Window-close coordinator. Main intercepts the close event and asks us to
// walk every dirty tab with a Save / Don't Save / Cancel dialog. We commit
// the user's choices before signaling main to actually close. Reentry guard
// keeps a spammed close button from launching multiple walkers in parallel.
let closeWalkInProgress = false;
async function prepareForClose() {
  const dirty = tabs.filter(t => t.isModified);
  for (const tab of dirty) {
    switchToTab(tab.id);
    const choice = await ipcRenderer.invoke('confirm-save-discard-cancel', { title: tab.title });
    if (choice === 'cancel') return false;
    if (choice === 'save') {
      const ok = await saveCurrent();
      if (!ok) return false; // user canceled Save As, or write failed
    } else {
      // 'discard' — drop the backup so it doesn't reappear next launch
      clearBackup(tab);
      tab.isModified = false;
    }
  }
  return true;
}
ipcRenderer.on('attempt-window-close', async () => {
  if (closeWalkInProgress) return;
  closeWalkInProgress = true;
  let ok = false;
  try { ok = await prepareForClose(); } finally { closeWalkInProgress = false; }
  ipcRenderer.send('window-close-decision', ok);
});

ipcRenderer.on('toggle-editor', () => {
  editorPane.classList.toggle('hidden');
});

// Toolbar position: 'top' (default, horizontal above the editor textarea) or
// 'left' (vertical strip left of the editor). Persisted across restarts.
function applyToolbarPosition(pos) {
  if (pos === 'left') editorPane.classList.add('toolbar-left');
  else editorPane.classList.remove('toolbar-left');
  localStorage.setItem('toolbarPosition', pos);
}
applyToolbarPosition(localStorage.getItem('toolbarPosition') || 'top');

ipcRenderer.on('menu-toolbar-position', (_e, pos) => applyToolbarPosition(pos));

// View → Load Sample on Startup checkbox state.
ipcRenderer.on('menu-load-sample', (_e, enabled) => {
  localStorage.setItem('loadSample', enabled ? 'on' : 'off');
});

ipcRenderer.on('menu-find', () => openFind(false));
ipcRenderer.on('menu-replace', () => openFind(true));

async function saveCurrent() {
  const t = activeTab();
  if (!t || isHomeTab(t)) return false;
  let filePath = t.filePath;
  const isNewPath = !filePath;
  if (!filePath) {
    filePath = await ipcRenderer.invoke('save-as-dialog', { suggestedName: t.title });
    if (!filePath) return false;
    t.filePath = filePath;
    t.title = filePath.split(/[\\/]/).pop();
    filepathEl.textContent = filePath;
  }
  try {
    await ipcRenderer.invoke('save-file', { filePath, content: editor.value });
  } catch (_e) {
    return false;
  }
  t.isModified = false;
  clearBackup(t);
  renderTabBar();
  if (isNewPath) notifyTabList();
  statusEl.textContent = 'saved';
  setTimeout(() => { statusEl.textContent = ''; }, 1500);
  return true;
}
ipcRenderer.on('menu-save', saveCurrent);

ipcRenderer.on('menu-save-as', async () => {
  const t = activeTab();
  if (!t || isHomeTab(t)) return;
  const filePath = await ipcRenderer.invoke('save-as-dialog', { suggestedName: t.title });
  if (!filePath) return;
  t.filePath = filePath;
  t.title = filePath.split(/[\\/]/).pop();
  filepathEl.textContent = filePath;
  await ipcRenderer.invoke('save-file', { filePath, content: editor.value });
  t.isModified = false;
  clearBackup(t);
  renderTabBar();
  notifyTabList();
  statusEl.textContent = 'saved';
  setTimeout(() => { statusEl.textContent = ''; }, 1500);
});

ipcRenderer.on('menu-new-tab',   () => createNewTab());
ipcRenderer.on('menu-close-tab', () => { const t = activeTab(); if (t) closeTab(t.id); });
ipcRenderer.on('menu-next-tab',  () => cycleTab(1));
ipcRenderer.on('menu-prev-tab',  () => cycleTab(-1));

document.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  const mod = e.ctrlKey || e.metaKey;
  if (mod && k === 's') {
    e.preventDefault();
    saveCurrent();
  } else if (mod && k === 'f') {
    e.preventDefault();
    openFind(false);
  } else if (mod && k === 'h') {
    e.preventDefault();
    openFind(true);
  } else if (mod && k === 't') {
    e.preventDefault();
    createNewTab();
  } else if (mod && k === 'w') {
    e.preventDefault();
    const t = activeTab();
    if (t) closeTab(t.id);
  } else if (mod && e.key === 'Tab') {
    e.preventDefault();
    cycleTab(e.shiftKey ? -1 : 1);
  } else if (mod && !e.shiftKey && !e.altKey && k === 'b' && document.activeElement === editor) {
    e.preventDefault();
    applyFormat('bold');
  } else if (mod && !e.shiftKey && !e.altKey && k === 'i' && document.activeElement === editor) {
    e.preventDefault();
    applyFormat('italic');
  } else if (mod && !e.shiftKey && !e.altKey && k === 'u' && document.activeElement === editor) {
    e.preventDefault();
    applyFormat('underline');
  } else if (e.key === 'Escape') {
    if (activeInsertMenu) closeActiveInsertMenu();
    else if (activePopover) closeActivePopover();
    else if (findState.open) closeFind();
  }
});

// =========================================================================
// TAB BAR + TAB OPERATIONS
// =========================================================================

function isFavoritePath(filePath) {
  if (!filePath) return false;
  const want = filePath.toLowerCase();
  return settings.favorites.some(f => (f.path || '').toLowerCase() === want);
}

function renderTabBar() {
  tabBar.innerHTML = '';
  tabs.forEach(tab => {
    const el = document.createElement('div');
    el.className = 'tab' + (tab.id === activeTabId ? ' active' : '');
    if (isHomeTab(tab)) el.classList.add('tab-home');
    el.dataset.tabId = tab.id;
    el.title = tab.filePath || tab.title;

    if (isHomeTab(tab)) {
      const icon = document.createElement('span');
      icon.className = 'tab-home-icon';
      icon.textContent = '⌂';
      el.appendChild(icon);
      const title = document.createElement('span');
      title.className = 'tab-title';
      title.textContent = 'Home';
      el.appendChild(title);
      tabBar.appendChild(el);
      return;
    }

    if (tab.isModified) {
      const dot = document.createElement('span');
      dot.className = 'tab-modified-dot';
      el.appendChild(dot);
    }
    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = tab.title;
    el.appendChild(title);

    // Star toggle — appears only when the tab has a saved file path.
    if (tab.filePath) {
      const star = document.createElement('button');
      star.className = 'tab-fav-btn';
      const isFav = isFavoritePath(tab.filePath);
      star.classList.toggle('active', isFav);
      star.textContent = isFav ? '★' : '☆';
      star.title = isFav ? 'Remove from Favorites' : 'Add to Favorites';
      star.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isFav) ipcRenderer.invoke('favorites-remove', tab.filePath);
        else ipcRenderer.invoke('favorites-add', tab.filePath);
      });
      el.appendChild(star);
    }

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.textContent = '×';
    close.title = 'Close (Ctrl+W)';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(tab.id);
    });
    el.appendChild(close);

    tabBar.appendChild(el);
  });

  const addBtn = document.createElement('button');
  addBtn.className = 'tab-add';
  addBtn.textContent = '+';
  addBtn.title = 'New tab (Ctrl+T)';
  addBtn.addEventListener('click', () => createNewTab());
  tabBar.appendChild(addBtn);
}

function markDirty() {
  const t = activeTab();
  if (!t) return;
  if (!t.isModified) {
    t.isModified = true;
    renderTabBar();
  }
  statusEl.textContent = '• unsaved';
  scheduleBackup(t);
}

function createNewTab(opts = {}) {
  const tab = makeTab(opts);
  tabs.push(tab);
  switchToTab(tab.id);
  notifyTabList();
  return tab;
}

function switchToTab(tabId) {
  if (activeTabId === tabId) {
    renderTabBar();
    return;
  }
  // Save outgoing tab's state (skip home — it has no editable state)
  if (activeTabId && !isHomeTabId(activeTabId)) {
    const cur = activeTab();
    if (cur) {
      cur.content = editor.value;
      cur.scrollTop = editor.scrollTop;
      cur.selStart = editor.selectionStart;
      cur.selEnd = editor.selectionEnd;
      cur.previewScrollTop = previewScroll.scrollTop;
    }
  }
  // Close transient UI tied to the old tab
  if (findState.open) closeFind();
  closeActivePopover();
  closeActiveInsertMenu();

  const next = tabs.find(t => t.id === tabId);
  if (!next) return;
  activeTabId = tabId;

  // Home swaps the document UI out for the Home view.
  if (isHomeTab(next)) {
    document.body.classList.add('home-active');
    filepathEl.textContent = 'Home';
    statusEl.textContent = '';
    renderTabBar();
    renderHome();
    return;
  }
  document.body.classList.remove('home-active');

  isSwitchingTab = true;
  editor.value = next.content;
  isSwitchingTab = false;

  filepathEl.textContent = next.filePath || next.title;
  statusEl.textContent = next.isModified ? '• unsaved' : '';
  renderTabBar();

  render().then(() => {
    editor.scrollTop = next.scrollTop;
    editorHighlight.scrollTop = next.scrollTop;
    try { editor.setSelectionRange(next.selStart, next.selEnd); } catch (_e) {}
    previewScroll.scrollTop = next.previewScrollTop;
    updateLineNumbers();
  });
}

async function closeTab(tabId) {
  // Home is non-closable. Ctrl+W on Home is a no-op.
  if (isHomeTabId(tabId)) return;
  const idx = tabs.findIndex(t => t.id === tabId);
  if (idx < 0) return;
  const tab = tabs[idx];

  if (tab.id === activeTabId) tab.content = editor.value;

  if (tab.isModified) {
    const ok = await ipcRenderer.invoke('confirm-discard', { title: tab.title });
    if (!ok) return;
  }

  clearBackup(tab);
  tabs.splice(idx, 1);
  notifyTabList();

  // Home is always present. If no document tabs remain, switch to Home rather
  // than closing the window.
  if (documentTabs().length === 0) {
    if (tab.id === activeTabId) {
      activeTabId = null;
      switchToTab(HOME_TAB_ID);
    } else {
      renderTabBar();
    }
    return;
  }
  if (tab.id === activeTabId) {
    activeTabId = null;
    // Pick the document tab that took our spot, or the previous one. Clamp
    // to documentTabs since Home occupies index 0.
    const newIdx = Math.min(idx, tabs.length - 1);
    const candidate = tabs[newIdx];
    switchToTab(isHomeTab(candidate) ? documentTabs()[0].id : candidate.id);
  } else {
    renderTabBar();
  }
}

function cycleTab(dir) {
  // Cycle only within document tabs — Ctrl+Tab shouldn't drop the user onto
  // Home unless they have no documents open.
  const docs = documentTabs();
  if (docs.length === 0) {
    switchToTab(HOME_TAB_ID);
    return;
  }
  if (docs.length < 2 && !isHomeTabId(activeTabId)) return;
  const idx = docs.findIndex(t => t.id === activeTabId);
  const len = docs.length;
  // From Home, dir=+1 goes to first document; dir=-1 goes to last.
  const startIdx = idx < 0 ? (dir > 0 ? -1 : 0) : idx;
  const newIdx = ((startIdx + dir) % len + len) % len;
  switchToTab(docs[newIdx].id);
}

// Tab body clicks → switch. We use a short time-window flag set when a drag
// completes (instead of inspecting live dragState) so a stuck dragState can
// never permanently block tab switching.
let suppressClickUntil = 0;

tabBar.addEventListener('click', (e) => {
  if (e.target.closest('.tab-close')) return;
  if (e.target.closest('.tab-add')) return;
  const tabEl = e.target.closest('.tab');
  if (!tabEl) return;
  if (performance.now() < suppressClickUntil) return;
  switchToTab(tabEl.dataset.tabId);
});

// =========================================================================
// TAB DRAG — reorder within window + detach to new/other window
// =========================================================================
// Design:
//   - pointerdown records intent but does NOT capture the pointer (otherwise
//     click delivery can break in certain edge cases).
//   - On the first pointermove past a 5px threshold we promote to a real drag
//     and *then* call setPointerCapture so events keep flowing if the cursor
//     leaves the window (needed for cross-window drop / out-of-window detach).
//   - pointerup decides reorder vs detach. pointercancel cleans up if the
//     browser yanks the drag (window blur, devtools, etc.).

let dragState = null;
const DRAG_START_THRESHOLD_PX = 5;
const DETACH_THRESHOLD_PX = 50;

function cleanupDrag() {
  if (!dragState) return;
  const { tabEl, ghost, pointerId, captured } = dragState;
  if (ghost) ghost.remove();
  if (tabEl) tabEl.classList.remove('dragging');
  document.body.classList.remove('tab-detaching');
  tabBar.querySelectorAll('.tab').forEach(el => {
    el.classList.remove('drag-over-left', 'drag-over-right');
  });
  if (captured && tabEl) {
    try { tabEl.releasePointerCapture(pointerId); } catch (_e) {}
  }
  dragState = null;
}

tabBar.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  if (e.target.closest('.tab-close')) return;
  if (e.target.closest('.tab-add')) return;
  if (e.target.closest('.tab-fav-btn')) return;
  const tabEl = e.target.closest('.tab');
  if (!tabEl) return;
  // Home is non-draggable — no detach, no reorder.
  if (tabEl.classList.contains('tab-home')) return;

  // Stale leftover from a previous interaction? Wipe it.
  if (dragState) cleanupDrag();

  dragState = {
    tabId: tabEl.dataset.tabId,
    tabEl,
    startX: e.clientX,
    startY: e.clientY,
    pointerId: e.pointerId,
    moved: false,
    captured: false,
    ghost: null,
  };
});

document.addEventListener('pointermove', (e) => {
  if (!dragState) return;
  const dx = e.clientX - dragState.startX;
  const dy = e.clientY - dragState.startY;
  if (!dragState.moved && Math.abs(dx) < DRAG_START_THRESHOLD_PX && Math.abs(dy) < DRAG_START_THRESHOLD_PX) return;

  if (!dragState.moved) {
    dragState.moved = true;
    dragState.tabEl.classList.add('dragging');
    const tab = tabs.find(t => t.id === dragState.tabId);
    const ghost = document.createElement('div');
    ghost.className = 'tab-drag-ghost';
    ghost.textContent = (tab && tab.title) || 'Tab';
    document.body.appendChild(ghost);
    dragState.ghost = ghost;
    document.body.classList.add('tab-detaching');
    // Capture now so we keep getting events if the cursor leaves the window.
    try {
      dragState.tabEl.setPointerCapture(dragState.pointerId);
      dragState.captured = true;
    } catch (_e) {}
  }

  if (dragState.ghost) {
    dragState.ghost.style.left = (e.clientX + 12) + 'px';
    dragState.ghost.style.top  = (e.clientY + 12) + 'px';
  }

  tabBar.querySelectorAll('.tab').forEach(el => {
    el.classList.remove('drag-over-left', 'drag-over-right');
  });

  const tabBarRect = tabBar.getBoundingClientRect();
  const inTabBar = e.clientY >= tabBarRect.top && e.clientY <= tabBarRect.bottom;
  if (inTabBar) {
    let target = null;
    for (const el of document.elementsFromPoint(e.clientX, e.clientY)) {
      const t = el.closest && el.closest('.tab');
      if (t && t.dataset.tabId !== dragState.tabId) { target = t; break; }
    }
    if (target) {
      const rect = target.getBoundingClientRect();
      const middle = rect.left + rect.width / 2;
      target.classList.add(e.clientX < middle ? 'drag-over-left' : 'drag-over-right');
    }
  }
});

document.addEventListener('pointerup', async (e) => {
  if (!dragState) return;
  const { tabId, moved } = dragState;
  const tabBarRect = tabBar.getBoundingClientRect();
  const inTabBar = e.clientY >= tabBarRect.top && e.clientY <= tabBarRect.bottom;
  const inWindow = e.clientX >= 0 && e.clientX <= window.innerWidth &&
                   e.clientY >= 0 && e.clientY <= window.innerHeight;

  cleanupDrag();

  if (!moved) return;
  suppressClickUntil = performance.now() + 150; // swallow the synthesized click

  if (inTabBar && inWindow) {
    // Reorder within this window
    let target = null;
    for (const el of document.elementsFromPoint(e.clientX, e.clientY)) {
      const t = el.closest && el.closest('.tab');
      if (t && t.dataset.tabId !== tabId) { target = t; break; }
    }
    if (target) {
      const fromIdx = tabs.findIndex(t => t.id === tabId);
      const [dragged] = tabs.splice(fromIdx, 1);
      let toIdx = tabs.findIndex(t => t.id === target.dataset.tabId);
      const rect = target.getBoundingClientRect();
      if (e.clientX >= rect.left + rect.width / 2) toIdx++;
      // Keep Home pinned at index 0 — clamp the drop position.
      if (toIdx < 1) toIdx = 1;
      tabs.splice(toIdx, 0, dragged);
      renderTabBar();
    }
    return;
  }

  // Outside the tab bar — either detach to a new window or merge into another window.
  // The decision (other window's tab bar vs. nowhere) is made in main where we
  // have access to all windows' screen bounds.
  const farFromTabBar = !inWindow
    || e.clientY > tabBarRect.bottom + DETACH_THRESHOLD_PX
    || e.clientY < tabBarRect.top - DETACH_THRESHOLD_PX
    || e.clientX < -DETACH_THRESHOLD_PX
    || e.clientX > window.innerWidth + DETACH_THRESHOLD_PX;
  if (farFromTabBar) {
    await detachTabToNewWindow(tabId, e.screenX, e.screenY);
  }
});

document.addEventListener('pointercancel', () => {
  if (dragState) cleanupDrag();
});

// Resetting on blur catches the case where the OS yanks input focus mid-drag.
window.addEventListener('blur', () => {
  if (dragState) cleanupDrag();
});

async function detachTabToNewWindow(tabId, screenX, screenY) {
  const idx = tabs.findIndex(t => t.id === tabId);
  if (idx < 0) return;

  const tab = tabs[idx];
  if (tab.id === activeTabId) {
    tab.content = editor.value;
    tab.scrollTop = editor.scrollTop;
    tab.selStart = editor.selectionStart;
    tab.selEnd = editor.selectionEnd;
    tab.previewScrollTop = previewScroll.scrollTop;
  }

  // Ask main to route the tab: into another window if the cursor was over one,
  // otherwise into a fresh new window.
  // Flush any pending backup write so the new window can resume from a
  // consistent file rather than racing with the debounced writer.
  const pending = backupTimers.get(tab.id);
  if (pending) clearTimeout(pending);
  backupTimers.delete(tab.id);
  const routed = await ipcRenderer.invoke('detach-tab', {
    tab: {
      filePath: tab.filePath,
      content: tab.content,
      isModified: tab.isModified,
      backupId: tab.backupId, // carries ownership of the backup to the new window
    },
    screenX, screenY,
  });
  if (!routed) return; // main didn't accept (shouldn't happen, but be safe)

  // NOTE: do NOT clearBackup() here — the receiving window now owns it.
  tabs.splice(idx, 1);
  notifyTabList();
  if (documentTabs().length === 0) {
    if (tab.id === activeTabId) {
      activeTabId = null;
      switchToTab(HOME_TAB_ID);
    } else {
      renderTabBar();
    }
    return;
  }
  if (tab.id === activeTabId) {
    activeTabId = null;
    const candidate = tabs[Math.min(idx, tabs.length - 1)];
    switchToTab(isHomeTab(candidate) ? documentTabs()[0].id : candidate.id);
  } else {
    renderTabBar();
  }
}

// =========================================================================
// AUTO-UPDATE INDICATOR
// =========================================================================

const updateIndicator = document.getElementById('update-indicator');
const updateText = document.getElementById('update-text');
const updateInstallBtn = document.getElementById('update-install');

function showUpdateState(state, info = {}) {
  switch (state) {
    case 'checking':
      // Don't reveal anything — silent check.
      return;
    case 'available':
      updateIndicator.classList.remove('hidden');
      updateText.textContent = `Downloading v${info.version}…`;
      updateInstallBtn.classList.add('hidden');
      return;
    case 'downloading':
      updateIndicator.classList.remove('hidden');
      updateText.textContent = `Downloading update… ${info.percent || 0}%`;
      updateInstallBtn.classList.add('hidden');
      return;
    case 'ready':
      updateIndicator.classList.remove('hidden');
      updateText.textContent = `Update v${info.version} ready`;
      updateInstallBtn.classList.remove('hidden');
      updateInstallBtn.dataset.version = info.version || '';
      return;
    case 'none':
      // If a manual "Check for updates" was requested, briefly show "No updates".
      if (updateCheckRequestedAt && Date.now() - updateCheckRequestedAt < 10000) {
        updateIndicator.classList.remove('hidden');
        updateText.textContent = 'No updates available';
        updateInstallBtn.classList.add('hidden');
        setTimeout(() => updateIndicator.classList.add('hidden'), 3000);
      } else {
        updateIndicator.classList.add('hidden');
      }
      return;
    case 'error':
      // Stay silent on automatic errors; surface only if user just asked.
      if (updateCheckRequestedAt && Date.now() - updateCheckRequestedAt < 10000) {
        updateIndicator.classList.remove('hidden');
        updateText.textContent = 'Update check failed';
        updateInstallBtn.classList.add('hidden');
        setTimeout(() => updateIndicator.classList.add('hidden'), 5000);
      }
      return;
  }
}

let updateCheckRequestedAt = 0;
ipcRenderer.on('update-check-requested', () => { updateCheckRequestedAt = Date.now(); });
ipcRenderer.on('update-status', (_e, payload) => showUpdateState(payload.state, payload));

updateInstallBtn.addEventListener('click', async () => {
  // Confirm with the user — quitAndInstall closes everything.
  const ok = window.confirm('Install update and restart Markdown Viewer now? Unsaved changes will be lost.');
  if (!ok) return;
  await ipcRenderer.invoke('update-install-now');
});

// =========================================================================
// INITIAL TAB
// =========================================================================

const sample = `# Welcome to Markdown Viewer

A live-preview Markdown editor with **GFM**, syntax highlighting, math, and Mermaid.

Double-click any block in the preview to edit it inline. Hover between blocks to insert new ones. Use the toolbar above the preview to append blocks at the end.

## Find & Replace

Press **Ctrl+F** to open Find, **Ctrl+H** for Find + Replace. Toggle case, whole word, regex, or search-within-selection.

## Code

\`\`\`js
function greet(name) {
  return \`Hello, \${name}!\`;
}
\`\`\`

## Math

Inline: $E = mc^2$ and $\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$

$$\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}$$

## Diagram

\`\`\`mermaid
graph LR
  A[Open file] --> B[Edit]
  B --> C[Live preview]
  C --> D[Save]
\`\`\`

## Table

| Feature | Status |
|---------|--------|
| Tables  | works  |
| Tasks   | works  |
| Math    | works  |

> Open a file with **Ctrl+O**. Toggle the editor pane with **Ctrl+E**. Save with **Ctrl+S**.
`;

// Pull persisted settings from main and apply view modes/reading mode/etc.
// before any rendering so the user never sees a flash of the wrong layout.
async function bootstrapSettings() {
  try {
    const s = await ipcRenderer.invoke('settings-get');
    if (s) {
      Object.assign(settings, {
        viewMode: s.viewMode || 'both',
        readingMode: !!s.readingMode,
        scrollSync: !!s.scrollSync,
        lineNumbers: !!s.lineNumbers,
        recents: s.recents || [],
        favorites: s.favorites || [],
      });
    }
  } catch (_e) {}
  applyAllViewSettings();
  // Tabs may have been seeded via init-tabs IPC by now — re-render so star
  // states match the just-loaded favorites list.
  renderTabBar();
  refreshHomeIfVisible();
}

ensureHomeTab();

// Sample doc is only created if the user has it enabled AND no other tabs
// were seeded (init-tabs / file-loaded would push their own).
const loadSample = localStorage.getItem('loadSample') !== 'off';
if (loadSample) {
  const seedTab = makeTab({ content: sample });
  tabs.push(seedTab);
  activeTabId = seedTab.id;
  editor.value = seedTab.content;
  filepathEl.textContent = seedTab.title;
  document.body.classList.remove('home-active');
  renderTabBar();
  render();
} else {
  // No sample — show Home as the active tab.
  activeTabId = HOME_TAB_ID;
  document.body.classList.add('home-active');
  filepathEl.textContent = 'Home';
  renderTabBar();
  renderHome();
}

bootstrapSettings();
