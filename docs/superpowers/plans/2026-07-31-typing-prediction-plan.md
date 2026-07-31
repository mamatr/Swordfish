# Typing Prediction from Translation Resources — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add real-time single-word ghost text prediction to the translation editor, sourced from glossary terms, TM matches, previously translated segments, and MT output.

**Architecture:** A new standalone `PredictionEngine` class (prefix trie) is instantiated per TranslationView. On segment selection and match/term arrival, the trie is rebuilt. On each keystroke in the target cell, the word fragment at cursor is extracted and looked up in the trie. A match renders as an inert `<span class="ghost-prediction">` after the cursor. Tab accepts it.

**Tech Stack:** TypeScript, vanilla DOM, Electron IPC (existing), CSS custom properties

## Global Constraints

- No existing methods in `translation.ts` are modified — only additive hooks
- `ts/predictionEngine.ts` has zero Electron dependencies (pure TypeScript, testable in isolation)
- Ghost text triggers only after ≥ 2 characters typed
- Glossary > TM > file segments > MT priority order
- MT only included if already fetched (no automatic MT calls)
- Single-word prediction only
- Feature gated behind `enableTypingPrediction` preference (default `true`), checked via `TranslationView.enablePrediction` static flag

---

## File Structure

| File | Purpose |
|---|---|
| `ts/predictionEngine.ts` (create) | PrefixTrie + PredictionEngine classes |
| `ts/translation.ts` (modify) | Integration hooks: build index, handle keystrokes, render ghost |
| `ts/preferences.ts` (modify) | Add `enableTypingPrediction` field to Preferences interface |
| `ts/preferencesDialog.ts` (modify) | Add checkbox toggle in Preferences dialog |
| `css/dark.css` (modify) | Ghost text style (dark theme) |
| `css/light.css` (modify) | Ghost text style (light theme) |
| `css/highcontrast.css` (modify) | Ghost text style (high contrast theme) |

---

### Task 1: Create the PredictionEngine

**Files:**
- Create: `ts/predictionEngine.ts`

**Interfaces:**
- Produces: `Prediction`, `PredictionEngine`, `PrefixTrie` — used by Task 3

- [ ] **Step 1: Write `ts/predictionEngine.ts`**

```typescript
/*******************************************************************************
 * Copyright (c) 2007-2026 Maxprograms.
 *
 * This program and the accompanying materials
 * are made available under the terms of the Eclipse Public License 1.0
 * which accompanies this distribution, and is available at
 * https://www.eclipse.org/org/documents/epl-v10.html
 *
 * Contributors:
 *     Maxprograms - initial API and implementation
 *******************************************************************************/

import { Match } from "./match.js";
import { Term } from "./term.js";

export interface Prediction {
    text: string;
    source: 'glossary' | 'tm' | 'file' | 'mt';
    confidence: number;
}

interface TrieNode {
    children: Map<string, TrieNode>;
    completions: Prediction[];
}

class PrefixTrie {

    root: TrieNode;

    constructor() {
        this.root = { children: new Map(), completions: [] };
    }

    insert(word: string, prediction: Prediction): void {
        if (word.length < 2) {
            return;
        }
        let node: TrieNode = this.root;
        const key: string = word.toLowerCase();
        for (const ch of key) {
            if (!node.children.has(ch)) {
                node.children.set(ch, { children: new Map(), completions: [] });
            }
            node = node.children.get(ch) as TrieNode;
        }
        // Insert at terminal node, keep top 3 by confidence
        node.completions.push(prediction);
        node.completions.sort((a: Prediction, b: Prediction): number => b.confidence - a.confidence);
        if (node.completions.length > 3) {
            node.completions.length = 3;
        }
    }

    lookup(prefix: string): Prediction | null {
        if (prefix.length < 2) {
            return null;
        }
        let node: TrieNode = this.root;
        const key: string = prefix.toLowerCase();
        for (const ch of key) {
            if (!node.children.has(ch)) {
                return null;
            }
            node = node.children.get(ch) as TrieNode;
        }
        return this.findBestCompletion(node);
    }

    private findBestCompletion(node: TrieNode): Prediction | null {
        let best: Prediction | null = null;
        for (const c of node.completions) {
            if (!best || c.confidence > best.confidence) {
                best = c;
            }
        }
        for (const child of node.children.values()) {
            const childBest: Prediction | null = this.findBestCompletion(child);
            if (childBest && (!best || childBest.confidence > best.confidence)) {
                best = childBest;
            }
        }
        return best;
    }

    clear(): void {
        this.root = { children: new Map(), completions: [] };
    }
}

export class PredictionEngine {

    trie: PrefixTrie;

    constructor() {
        this.trie = new PrefixTrie();
    }

    buildIndex(
        fileSegments: { target: string }[],
        tmMatches: Match[],
        glossaryTerms: Term[],
        mtMatch?: Match
    ): void {
        this.trie.clear();

        // Glossary terms: confidence 0.95
        for (const term of glossaryTerms) {
            const words: string[] = term.target.split(/\s+/);
            for (const word of words) {
                this.trie.insert(word, {
                    text: word,
                    source: 'glossary',
                    confidence: 0.95
                });
            }
        }

        // TM matches: confidence = similarity / 100 (only ≥ 70%)
        for (const match of tmMatches) {
            if (match.similarity >= 70) {
                const words: string[] = match.target.split(/\s+/);
                for (const word of words) {
                    this.trie.insert(word, {
                        text: word,
                        source: 'tm',
                        confidence: match.similarity / 100
                    });
                }
            }
        }

        // Previously translated file segments: confidence 0.80
        for (const segment of fileSegments) {
            if (segment.target) {
                const words: string[] = segment.target.split(/\s+/);
                for (const word of words) {
                    this.trie.insert(word, {
                        text: word,
                        source: 'file',
                        confidence: 0.80
                    });
                }
            }
        }

        // MT match if present: confidence 0.60
        if (mtMatch && mtMatch.target) {
            const words: string[] = mtMatch.target.split(/\s+/);
            for (const word of words) {
                this.trie.insert(word, {
                    text: word,
                    source: 'mt',
                    confidence: 0.60
                });
            }
        }
    }

    predict(wordPrefix: string): Prediction | null {
        if (wordPrefix.length < 2) {
            return null;
        }
        return this.trie.lookup(wordPrefix);
    }

    addEntry(targetText: string, source: Prediction['source'], confidence: number): void {
        const words: string[] = targetText.split(/\s+/);
        for (const word of words) {
            this.trie.insert(word, {
                text: word,
                source: source,
                confidence: confidence
            });
        }
    }

    clear(): void {
        this.trie.clear();
    }
}
```

- [ ] **Step 2: Compile the TypeScript**

```bash
cd /Users/mamat/Labs/Swordfish && npx tsc --noEmit ts/predictionEngine.ts 2>&1
```

Expected: no errors (may warn about unused types from imports, that's OK at this stage).

- [ ] **Step 3: Commit**

```bash
git add ts/predictionEngine.ts
git commit -m "feat: add PredictionEngine for typing prediction

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Add ghost text CSS to all themes

**Files:**
- Modify: `css/dark.css`
- Modify: `css/light.css`
- Modify: `css/highcontrast.css`

**Interfaces:**
- Consumes: CSS class `.ghost-prediction` — rendered by Task 3

- [ ] **Step 1: Add `.ghost-prediction` to `css/dark.css`**

Append to the end of the file:

```css
.ghost-prediction {
	color: var(--gray110);
	font-style: italic;
	user-select: none;
	pointer-events: none;
}
```

- [ ] **Step 2: Add `.ghost-prediction` to `css/light.css`**

Append to the end of the file:

```css
.ghost-prediction {
	color: var(--gray90);
	font-style: italic;
	user-select: none;
	pointer-events: none;
}
```

- [ ] **Step 3: Add `.ghost-prediction` to `css/highcontrast.css`**

Append to the end of the file:

```css
.ghost-prediction {
	color: var(--gray130);
	font-style: italic;
	user-select: none;
	pointer-events: none;
}
```

- [ ] **Step 4: Commit**

```bash
git add css/dark.css css/light.css css/highcontrast.css
git commit -m "feat: add ghost-prediction CSS class to all themes

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Integrate PredictionEngine into TranslationView

**Files:**
- Modify: `ts/translation.ts`

**Interfaces:**
- Consumes: `PredictionEngine` from Task 1, `.ghost-prediction` CSS from Task 2
- Produces: working inline ghost text prediction on keystroke

- [ ] **Step 1: Add the import**

Add after the existing import block (after line 23, `import { TmMatches } from "./tmMatches.js";`):

```typescript
import { Prediction, PredictionEngine } from "./predictionEngine.js";
```

- [ ] **Step 2: Add static flag and class field**

Add after the existing static fields (after line 74, after `static readonly MIN_SUBPANEL_HEIGHT: number = 40;`):

```typescript
    static enablePrediction: boolean = true;
```

Add after line 150 (`termsPanel: TermsPanel | undefined;`):

```typescript
    predictionEngine: PredictionEngine;
```

- [ ] **Step 3: Instantiate in constructor**

Add after line 176 (`this.sourceTags = new Map<string, string>();`):

```typescript
        this.predictionEngine = new PredictionEngine();
```

- [ ] **Step 4: Add IPC listener for preference changes**

In the constructor, add after `this.predictionEngine = new PredictionEngine();` (after the line added in Step 3):

```typescript
        ipcRenderer.on('set-enable-prediction', (event: IpcRendererEvent, arg: boolean) => {
            TranslationView.enablePrediction = arg;
        });
```

This is already imported at the top of the file (`import { ipcRenderer, IpcRendererEvent } from "electron";`), so no new import is needed.

- [ ] **Step 5: Clear prediction engine in `selectRow()`**

In the `selectRow()` method (line 2370), add after `this.currentContent = this.currentCell.innerHTML;` (after line 2396):

```typescript
        this.predictionEngine.clear();
        this.clearGhost();
```

- [ ] **Step 6: Add `this.updatePredictionIndex()` call in `setMatches()`**

In the `setMatches()` method (line 2623), add after the `}` that closes the `for` loop splitting matches (after line 2644, before the `if (max > 0...)` line):

```typescript
        this.updatePredictionIndex();
```

- [ ] **Step 7: Add `this.updatePredictionIndex()` call in `setTerms()`**

In the `setTerms()` method (line 2650), add after `this.termsPanel?.setTerms(terms);`:

```typescript
        this.updatePredictionIndex();
```

- [ ] **Step 8: Add the `updatePredictionIndex()` private method**

Add a new private method after `setTerms()` (after line 2652). Insert before `setTarget()`:

```typescript
    updatePredictionIndex(): void {
        // Gather TM matches
        let tmMatchList: Match[] = [];
        if (this.tmMatches) {
            for (const match of this.tmMatches.matches.values()) {
                tmMatchList.push(match);
            }
        }

        // Gather glossary terms
        let glossaryTerms: Term[] = [];
        if (this.termsPanel) {
            glossaryTerms = this.termsPanel.terms;
        }

        // Gather previously translated segments from the current file
        let fileSegments: { target: string }[] = [];
        if (this.currentId.file) {
            const rows: HTMLCollectionOf<HTMLTableRowElement> = this.tbody.getElementsByTagName('tr');
            for (let i: number = 0; i < rows.length; i++) {
                const row: HTMLTableRowElement = rows[i];
                if (row.getAttribute('data-file') !== this.currentId.file) {
                    continue;
                }
                const targetCell: HTMLTableCellElement = row.getElementsByClassName('target')[0] as HTMLTableCellElement;
                if (targetCell && targetCell.textContent && targetCell.textContent.trim() !== '') {
                    fileSegments.push({ target: targetCell.textContent.trim() });
                }
            }
        }

        // Gather MT match if any
        let mtMatch: Match | undefined = undefined;
        if (this.mtMatches && this.mtMatches.matches.size > 0) {
            mtMatch = this.mtMatches.matches.values().next().value;
        }

        this.predictionEngine.buildIndex(fileSegments, tmMatchList, glossaryTerms, mtMatch);
    }
```

- [ ] **Step 9: Wire up the prediction input handler in `selectRow()`**

In `selectRow()`, replace the line:
```typescript
        this.currentCell.addEventListener('keyup', () => this.changeListener());
```
(at line 2391) with:
```typescript
        this.currentCell.addEventListener('keyup', (event: KeyboardEvent) => {
            this.changeListener();
            this.handlePredictionInput(event);
        });
```

- [ ] **Step 10: Add ghost text handler methods**

Add the following new private methods. Insert before `changeListener()` (before line 2352):

```typescript
    handlePredictionInput(event: KeyboardEvent): void {
        if (!TranslationView.enablePrediction) {
            return;
        }
        // Don't predict on navigation keys
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' ||
            event.key === 'ArrowUp' || event.key === 'ArrowDown' ||
            event.key === 'Home' || event.key === 'End') {
            this.clearGhost();
            return;
        }

        const fragment: string = this.extractWordAtCursor();
        if (fragment.length < 2) {
            this.clearGhost();
            return;
        }

        const prediction: Prediction | null = this.predictionEngine.predict(fragment);
        if (prediction) {
            this.renderGhost(prediction.text);
        } else {
            this.clearGhost();
        }
    }

    extractWordAtCursor(): string {
        const selection: Selection | null = window.getSelection();
        if (!selection || !selection.rangeCount) {
            return '';
        }

        const range: Range = selection.getRangeAt(0);
        if (!this.currentCell || !this.currentCell.contains(range.startContainer)) {
            return '';
        }

        // Walk backward from cursor collecting text until whitespace or tag boundary
        let text: string = '';
        let node: Node | null = range.startContainer;
        let offset: number = range.startOffset;

        // Get text before cursor in the current text node
        if (node.nodeType === Node.TEXT_NODE && node.textContent) {
            text = node.textContent.substring(0, offset);
        }

        // Walk to previous text nodes within the target cell
        while (node && node !== this.currentCell) {
            if (node.previousSibling) {
                node = node.previousSibling;
                if (node.nodeType === Node.TEXT_NODE && node.textContent) {
                    text = node.textContent + text;
                } else if (node.nodeType === Node.ELEMENT_NODE) {
                    // Hit a tag or span — stop
                    break;
                }
            } else {
                node = node.parentNode;
                if (node === this.currentCell) {
                    break;
                }
            }
        }

        // Extract the last contiguous non-whitespace fragment
        const match: RegExpMatchArray | null = text.match(/(\S+)$/);
        return match ? match[1] : '';
    }

    renderGhost(completion: string): void {
        this.clearGhost();

        const selection: Selection | null = window.getSelection();
        if (!selection || !selection.rangeCount) {
            return;
        }

        const range: Range = selection.getRangeAt(0);
        if (!this.currentCell || !this.currentCell.contains(range.startContainer)) {
            return;
        }

        const ghostSpan: HTMLSpanElement = document.createElement('span');
        ghostSpan.className = 'ghost-prediction';
        ghostSpan.contentEditable = 'false';
        ghostSpan.textContent = completion;

        // Insert ghost span at cursor position
        range.collapse(false);
        range.insertNode(ghostSpan);

        // Move cursor back before the ghost span
        const newRange: Range = document.createRange();
        newRange.setStartBefore(ghostSpan);
        newRange.collapse(true);
        selection.removeAllRanges();
        selection.addRange(newRange);
    }

    clearGhost(): void {
        if (!this.currentCell) {
            return;
        }
        const ghosts: NodeListOf<HTMLSpanElement> = this.currentCell.querySelectorAll('.ghost-prediction');
        ghosts.forEach((g: HTMLSpanElement) => g.remove());
    }
```

- [ ] **Step 11: Add Tab handler to accept ghost text**

In `selectRow()`, add a `keydown` event listener on the target cell alongside the `keyup` listener (after the `keyup` listener added in Step 9). This needs to be added at the end of `selectRow()`, before the closing `}` of the method (after the `this.currentCell.focus();` call at line 2424):

```typescript
        this.currentCell.addEventListener('keydown', (event: KeyboardEvent) => {
            if (event.key === 'Tab') {
                const ghost: HTMLSpanElement | null = this.currentCell?.querySelector('.ghost-prediction') as HTMLSpanElement | null;
                if (ghost) {
                    event.preventDefault();
                    ghost.remove();
                    // Insert the completion text at cursor
                    const sel: Selection | null = window.getSelection();
                    if (sel && sel.rangeCount) {
                        const r: Range = sel.getRangeAt(0);
                        r.insertNode(document.createTextNode(ghost.textContent || ''));
                        r.collapse(false);
                        sel.removeAllRanges();
                        sel.addRange(r);
                    }
                }
            }
            if (event.key === 'Escape') {
                const ghost: HTMLSpanElement | null = this.currentCell?.querySelector('.ghost-prediction') as HTMLSpanElement | null;
                if (ghost) {
                    event.preventDefault();
                    ghost.remove();
                }
            }
        });
```

- [ ] **Step 12: Compile and verify no type errors**

```bash
cd /Users/mamat/Labs/Swordfish && npx tsc --noEmit 2>&1
```

Expected: no errors.

- [ ] **Step 13: Run the app and smoke test**

```bash
cd /Users/mamat/Labs/Swordfish && npm start
```

Manual smoke test:
1. Open a project with translated segments and glossary terms
2. Click into a target segment cell
3. Type 2+ characters that match a glossary term or previous translation
4. Verify ghost text appears as gray italic after the cursor
5. Press Tab — verify ghost text is accepted and inserted
6. Press Escape while ghost is visible — verify ghost disappears
7. Move to a different segment — verify ghost cleared, predictions update for new segment

- [ ] **Step 14: Commit**

```bash
git add ts/translation.ts
git commit -m "feat: integrate PredictionEngine into translation editor

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Add enableTypingPrediction preference

**Files:**
- Modify: `ts/preferences.ts`
- Modify: `ts/preferencesDialog.ts`

**Interfaces:**
- Produces: `enableTypingPrediction` boolean preference — consumed by Task 3's static flag

- [ ] **Step 1: Add field to Preferences interface**

In `ts/preferences.ts`, add after line 102 (`pageRows: number;`):

```typescript
    enableTypingPrediction: boolean;
```

- [ ] **Step 2: Add checkbox in Preferences dialog**

In `ts/preferencesDialog.ts`, add the checkbox after the existing checkboxes in the Translation section. Find the `caseSensitiveMatches` checkbox block (around line 1130) and add after its `row` div. Locate the row div that follows `caseSensitiveMatches` and insert a new row before it:

```typescript
        let predRow: HTMLDivElement = document.createElement('div');
        predRow.classList.add('row');
        predRow.classList.add('middle');
        rowsHolder.appendChild(predRow);

        this.enablePredictionCheck = document.createElement('input');
        this.enablePredictionCheck.type = 'checkbox';
        this.enablePredictionCheck.id = 'enablePrediction';
        predRow.appendChild(this.enablePredictionCheck);

        let predLabel: HTMLLabelElement = document.createElement('label');
        predLabel.innerText = 'Enable Typing Prediction';
        predLabel.setAttribute('for', 'enablePrediction');
        predLabel.style.marginTop = '4px';
        predRow.appendChild(predLabel);
```

- [ ] **Step 3: Add field declaration**

In `preferencesDialog.ts`, add after line 43 (`autoConfirm: HTMLInputElement = document.createElement('input');`):

```typescript
    enablePredictionCheck: HTMLInputElement = document.createElement('input');
```

- [ ] **Step 4: Load preference value**

In `preferencesDialog.ts`, find the block where checkboxes are loaded from preferences (around line 249-254). Add after `this.autoConfirm.checked = preferences.autoConfirm;`:

```typescript
        this.enablePredictionCheck.checked = preferences.enableTypingPrediction;
```

- [ ] **Step 5: Save preference value**

In `preferencesDialog.ts`, find the block where preferences are saved (around line 509-514). Add after `autoConfirm: this.autoConfirm.checked,`:

```typescript
            enableTypingPrediction: this.enablePredictionCheck.checked,
```

- [ ] **Step 6: Compile and verify**

```bash
cd /Users/mamat/Labs/Swordfish && npx tsc --noEmit 2>&1
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add ts/preferences.ts ts/preferencesDialog.ts
git commit -m "feat: add enableTypingPrediction preference toggle

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Add segment-confirmation update to prediction index

**Files:**
- Modify: `ts/translation.ts`

**Interfaces:**
- Consumes: `PredictionEngine.addEntry()` from Task 1

- [ ] **Step 1: Update index when segment is confirmed**

Find the `setTarget()` method (line 2654). This is called when a segment's target text is updated (including via accepting TM/MT matches). Add after `targetCell.innerHTML = arg.target;` (after line 2665):

```typescript
                if (arg.target && arg.target.trim() !== '') {
                    this.predictionEngine.addEntry(arg.target, 'file', 0.80);
                }
```

- [ ] **Step 2: Compile and verify**

```bash
cd /Users/mamat/Labs/Swordfish && npx tsc --noEmit 2>&1
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add ts/translation.ts
git commit -m "feat: update prediction index on segment confirmation

Co-Authored-By: Claude <noreply@anthropic.com>"
```
