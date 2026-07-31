# Typing Prediction from Translation Resources

**Date:** 2026-07-31
**Status:** Design approved

## Overview

Add real-time single-word typing prediction to the Swordfish translation editor. As the translator types in a target segment, a grayed-out ghost text completion appears at the cursor. The translator accepts it with Tab or Enter. Predictions are sourced from glossary terms, TM matches, previously translated segments in the current file, and optionally MT output.

## Motivation

- Translators currently must look at side panels (TM matches, glossary terms) to find terminology while typing, breaking flow
- No real-time assistance in the editing surface itself
- Terminology consistency suffers when translators type from memory rather than using approved glossary terms

## Interaction Model

- **Single-word ghost text** appears inline after the cursor as the user types
- Ghost text only appears after ≥ 2 characters have been typed for the current word
- **Tab** or **Enter** accepts the ghost text and inserts the completion
- **Escape** dismisses the ghost without inserting
- **Backspace** recomputes prediction
- **Arrow keys** (moving cursor away) hide the ghost until typing resumes
- Accepting a full TM match (fills entire target) clears ghost and leaves the index unchanged

### Ghost text lifecycle

```
User types 'c'       → no prediction (< 2 chars)
User types 'cl'      → ghost: [clic] (from glossary term "clic")
User types 'cli'     → ghost: [clic] (same match)
User types 'clic'    → ghost hidden (word boundary reached, exact match)
User types 'clic '   → ghost hidden (at word boundary)
User types 'clic e'  → ghost: [en] (from TM target)
User presses Tab     → "en" inserted, cursor after it
```

## Priority & Weighting

Predictions compete by weighted score. When multiple sources produce the same completion, the higher-scoring source wins.

| Source | Base confidence | Rationale |
|---|---|---|
| Glossary term | 0.95 | Curated, preferred terminology |
| TM match | similarity / 100 | Provenance-tested translations |
| File segment (previous translation) | 0.80 | Context-relevant, from the same document |
| MT output | 0.60 | Useful but least authoritative |

### Boosts

| Factor | Value | Condition |
|---|---|---|
| Source context boost | +0.10 | Token overlap ≥ 50% between the current source segment and the TM/glossary entry's source text |
| Recency boost | +0.05 | Same completion was used in an adjacent segment |

### MT inclusion rule

MT output is included in the prediction index **only if it has already been fetched** for the current segment (via the existing "Get Machine Translations" button). No automatic MT fetch is triggered by the prediction engine.

## Architecture

### New file: `ts/predictionEngine.ts`

A standalone class with no Electron dependencies — pure TypeScript, testable in isolation.

```
PredictionEngine
├── buildIndex(fileSegments, tmMatches, glossaryTerms, mtMatch?)
├── predict(wordPrefix: string, sourceContext: string): Prediction | null
├── addEntry(targetText: string, source: string, confidence: number)
├── clear()
└── (internal) trie: PrefixTrie
```

**`PrefixTrie`** — Private inner data structure. Keys are lowercased target-language tokens. Each node stores up to 3 ranked completions (one word each) with source and confidence. Only 1-grams are stored at leaf level; the trie is structured so completions for a given prefix are the terminal words reachable from that node.

**`Prediction`** type:
```ts
interface Prediction {
    text: string;          // the completion text (single word, original casing)
    source: 'glossary' | 'tm' | 'file' | 'mt';
    confidence: number;    // 0–1
}
```

### Modified: `ts/translation.ts`

Minimal, additive changes to reduce merge conflicts with upstream:

| Integration point | Lines | What changes |
|---|---|---|
| Import block | +1 | `import { PredictionEngine } from "./predictionEngine.js";` |
| Class field | +2 | `predictionEngine: PredictionEngine;` declaration + instantiation in constructor |
| `selectRow()` | +1 | Clear the prediction engine on row change |
| `setMatches()` | +3 | After splitting TM/MT matches, call `this.updatePredictionIndex()` |
| `setTerms()` | +3 | After setting terms, call `this.updatePredictionIndex()` |
| `updatePredictionIndex()` (new private method) | ~12 | Gathers current TM matches, MT matches, glossary terms, and file segments; calls `predictionEngine.buildIndex()` |
| Target cell `keyup` | +4 | Attach prediction input listener alongside existing `changeListener` |
| Target cell `keydown` | +6 | Tab/Enter/Escape handlers for ghost text |
| Ghost render helper | ~15 | Self-contained `renderGhost()` and `clearGhost()` methods |

**Total footprint: ~45 lines.** No existing methods are modified — only additive hooks.

### Data flow

```
selectRow()
  └─> predictionEngine.clear()  (clear previous segment's index)
  └─> IPC send: 'get-matches'
  └─> IPC send: 'get-terms'

(IPC responses arrive asynchronously to Main.ts, forwarded to TranslationView)

setMatches(arg)
  └─> split matches into this.tmMatches / this.mtMatches
  └─> this.updatePredictionIndex()

setTerms(arg)
  └─> this.termsPanel.setTerms(arg.terms)
  └─> this.updatePredictionIndex()

updatePredictionIndex()
  └─> gather: tmMatches.matches, mtMatches.matches, termsPanel.terms, file segments
  └─> predictionEngine.buildIndex(fileSegments, tmMatches, glossaryTerms, mtMatch?)
  └─> ready

keystroke in contentEditable target cell
  └─> extractWordAtCursor()
  └─> if fragment.length < 2 → clearGhost()
  └─> predictionEngine.predict(fragment, sourceSegmentText)
  └─> if match → renderGhost(prediction.text)
  └─> if no match → clearGhost()

Tab/Enter (ghost visible)
  └─> insert completion text at cursor
  └─> clearGhost()

Escape (ghost visible)
  └─> clearGhost()
```

## Trie Construction

### Insertion by source

| Source | What is inserted |
|---|---|
| Glossary terms | Target term as 1-gram. For multi-word terms, each word is inserted individually with its position in the phrase tracked, allowing completions to continue naturally. |
| TM matches (similarity ≥ 70%) | Target text, single words extracted |
| Previously translated segments (same file) | Target text, single words extracted |
| MT match (if present) | MT target text, single words extracted |

### Case handling

- Trie keys are **lowercased**
- Completions store **original casing** from the source
- Typing "haga" matches "Haga" and inserts "Haga"

## Ghost Text Rendering

The target cell is `contentEditable`. Ghost text is an inert span inserted after the cursor:

```html
<span class="ghost-prediction" contenteditable="false">completion</span>
```

### CSS

```css
.ghost-prediction {
    color: #999;
    font-style: italic;
    user-select: none;
    pointer-events: none;
}
```

- `contenteditable="false"` prevents the user from editing the ghost directly
- `user-select: none` and `pointer-events: none` ensure it behaves as visual-only
- On accept: remove the ghost span, insert its text content as plain text at cursor position
- On any keystroke that changes the prefix: remove old ghost, recompute

## State Updates

| Event | Action |
|---|---|
| Translator accepts a TM match | Add accepted target text to trie (it becomes a "previous translation") |
| Translator confirms a segment (Ctrl+Enter) | Add target text to trie for this file's future predictions |
| Translator inserts a glossary term | Bump that term's confidence in the trie |
| MT result arrives (manual fetch) | Insert MT target into trie at low priority |
| Segment deselected (moving to another row) | `predictionEngine.clear()` — release memory |

## Performance

### Data bounds (per segment)

| Resource | Typical count | Tokenized entries |
|---|---|---|
| Glossary terms (language pair) | 100–5,000 | ~10,000 1-grams |
| TM matches | 5–10 | ~50 entries |
| Previously translated segments (same file) | 50–500 | ~2,000 entries |
| MT match (if present) | 1 | ~10 entries |

**Worst case:** ~15,000 trie nodes. Lookup time < 1ms per keystroke. Memory released on segment deselect.

### Optimizations

- Trie cleared on segment deselect — no persistent memory cost
- Glossary terms filtered to the target language only
- Debounce keystroke processing at 50ms (filters rapid typing bursts without perceptible lag)

## Merge Safety

`predictionEngine.ts` is a new file — zero merge conflicts.

Changes to `translation.ts` are:
- All additive — no existing logic modified
- Placed at natural extension points (imports, constructor, event wiring)
- Small enough to re-apply in seconds if upstream moves things around

## Testing

### Unit tests (PredictionEngine)

- Empty index returns null for any prefix
- Single glossary term: prefix match returns it, non-matching prefix returns null
- Multiple sources compete correctly by confidence score
- Source context boost: same completion scores higher when source tokens match
- `addEntry()` updates the trie for incremental learning
- `clear()` empties the trie
- Case-insensitive lookup preserves original casing in result

### Integration tests

- Selecting a row builds the index and `predict()` returns results
- Typing < 2 characters shows no ghost
- Typing a matching prefix renders ghost text
- Tab inserts the completion into the contentEditable
- Escape dismisses ghost without modifying content
- Confirming a segment updates predictions for the next segment in the same file

## Preferences

The feature is gated behind a user preference:

- **`enableTypingPrediction`** — boolean, default `true`
- Toggle in the Preferences dialog (Translation section)
- When disabled, no ghost text is rendered and prediction computation is skipped
- Stored alongside all other preferences, loaded on app start

When the preference changes, an IPC message updates a static flag on `TranslationView` so all open translation tabs pick up the change immediately.

## Out of Scope

- Multi-word phrase prediction
- Automatic MT fetching triggered by the prediction engine
- Dropdown/popup with multiple ranked suggestions (future enhancement)
- Persistent prediction model across sessions
- Prediction for source-language editing
