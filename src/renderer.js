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
  };
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
    // Fallback: undo will be lost but the edit still applies.
    editor.value = editor.value.slice(0, start) + text + editor.value.slice(end);
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

    blockMap.push({ id: blockId, startChar, endChar, source });

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

  const newMarker = cb.checked ? '[x]' : '[ ]';
  let newSource = block.source.slice(0, hit) + newMarker + block.source.slice(hit + 3);
  if (!newSource.endsWith('\n')) newSource += '\n';
  applyEdit(block.startChar, block.endChar, newSource);
  markDirty();
  render();
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
  const templateLabel = btn.dataset.template;
  const template = elementTemplates.find(t => t.label === templateLabel);
  if (!template) return;
  handleInsert(template, editor.selectionStart);
});

// =========================================================================
// EDITOR EVENTS
// =========================================================================

let renderTimer;
editor.addEventListener('input', () => {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(render, 150);
  markDirty();
  if (findState.open && findState.query) updateMatches();
});

// Keep the highlight overlay in lock-step with textarea scroll.
editor.addEventListener('scroll', () => {
  editorHighlight.scrollTop = editor.scrollTop;
});

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
  // AND no edits). Once a tab has a file path, opening another file creates a
  // new tab instead of replacing it.
  const t = activeTab();
  if (t && !t.filePath && !t.isModified) {
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
  notifyTabList();
});

// New window can be opened with a set of tabs pre-loaded (used by detach).
ipcRenderer.on('init-tabs', (_e, initial) => {
  if (!Array.isArray(initial) || initial.length === 0) return;
  tabs.length = 0;
  activeTabId = null;
  initial.forEach(t => {
    const tab = makeTab({ filePath: t.filePath, content: t.content || '' });
    tab.isModified = !!t.isModified;
    tabs.push(tab);
  });
  activeTabId = tabs[0].id;
  isSwitchingTab = true;
  editor.value = tabs[0].content;
  isSwitchingTab = false;
  filepathEl.textContent = tabs[0].filePath || tabs[0].title;
  statusEl.textContent = tabs[0].isModified ? '• unsaved' : '';
  renderTabBar();
  notifyTabList();
  render();
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
  if (!t) return;
  let filePath = t.filePath;
  const isNewPath = !filePath;
  if (!filePath) {
    filePath = await ipcRenderer.invoke('save-as-dialog', { suggestedName: t.title });
    if (!filePath) return;
    t.filePath = filePath;
    t.title = filePath.split(/[\\/]/).pop();
    filepathEl.textContent = filePath;
  }
  await ipcRenderer.invoke('save-file', { filePath, content: editor.value });
  t.isModified = false;
  renderTabBar();
  if (isNewPath) notifyTabList();
  statusEl.textContent = 'saved';
  setTimeout(() => { statusEl.textContent = ''; }, 1500);
}
ipcRenderer.on('menu-save', saveCurrent);

ipcRenderer.on('menu-save-as', async () => {
  const t = activeTab();
  if (!t) return;
  const filePath = await ipcRenderer.invoke('save-as-dialog', { suggestedName: t.title });
  if (!filePath) return;
  t.filePath = filePath;
  t.title = filePath.split(/[\\/]/).pop();
  filepathEl.textContent = filePath;
  await ipcRenderer.invoke('save-file', { filePath, content: editor.value });
  t.isModified = false;
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
  } else if (e.key === 'Escape') {
    if (activeInsertMenu) closeActiveInsertMenu();
    else if (activePopover) closeActivePopover();
    else if (findState.open) closeFind();
  }
});

// =========================================================================
// TAB BAR + TAB OPERATIONS
// =========================================================================

function renderTabBar() {
  tabBar.innerHTML = '';
  tabs.forEach(tab => {
    const el = document.createElement('div');
    el.className = 'tab' + (tab.id === activeTabId ? ' active' : '');
    el.dataset.tabId = tab.id;
    el.title = tab.filePath || tab.title;

    if (tab.isModified) {
      const dot = document.createElement('span');
      dot.className = 'tab-modified-dot';
      el.appendChild(dot);
    }
    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = tab.title;
    el.appendChild(title);

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
  // Save outgoing tab's state
  if (activeTabId) {
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
  });
}

async function closeTab(tabId) {
  const idx = tabs.findIndex(t => t.id === tabId);
  if (idx < 0) return;
  const tab = tabs[idx];

  if (tab.id === activeTabId) tab.content = editor.value;

  if (tab.isModified) {
    const ok = await ipcRenderer.invoke('confirm-discard', { title: tab.title });
    if (!ok) return;
  }

  tabs.splice(idx, 1);
  notifyTabList();

  if (tabs.length === 0) {
    // Close the window when the last tab goes away.
    ipcRenderer.invoke('close-window');
    return;
  }
  if (tab.id === activeTabId) {
    activeTabId = null;
    const newIdx = Math.min(idx, tabs.length - 1);
    switchToTab(tabs[newIdx].id);
  } else {
    renderTabBar();
  }
}

function cycleTab(dir) {
  if (tabs.length < 2) return;
  const idx = tabs.findIndex(t => t.id === activeTabId);
  const len = tabs.length;
  const newIdx = ((idx + dir) % len + len) % len;
  switchToTab(tabs[newIdx].id);
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
  const tabEl = e.target.closest('.tab');
  if (!tabEl) return;

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
  const routed = await ipcRenderer.invoke('detach-tab', {
    tab: {
      filePath: tab.filePath,
      content: tab.content,
      isModified: tab.isModified,
    },
    screenX, screenY,
  });
  if (!routed) return; // main didn't accept (shouldn't happen, but be safe)

  tabs.splice(idx, 1);
  notifyTabList();
  if (tabs.length === 0) {
    ipcRenderer.invoke('close-window');
    return;
  }
  if (tab.id === activeTabId) {
    activeTabId = null;
    switchToTab(tabs[Math.min(idx, tabs.length - 1)].id);
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

// Seed the first tab. If sample-on-startup is off, the tab is just an empty Untitled.
const loadSample = localStorage.getItem('loadSample') !== 'off';
const seedTab = makeTab({ content: loadSample ? sample : '' });
tabs.push(seedTab);
activeTabId = seedTab.id;
editor.value = seedTab.content;
filepathEl.textContent = seedTab.title;
renderTabBar();
render();
