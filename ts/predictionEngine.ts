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

const GLOSSARY_CONFIDENCE: number = 0.95;
const FILE_BASE_CONFIDENCE: number = 0.80;
const MT_CONFIDENCE: number = 0.60;
const FILE_FREQUENCY_RANGE: number = 0.12;
const FILE_FREQUENCY_CAP: number = 0.92;
const SOURCE_BOOST_MAX: number = 0.10;
const SOURCE_BOOST_THRESHOLD: number = 0.50;
const BIGRAM_BOOST_MAX: number = 0.06;
const BIGRAM_BOOST_SATURATION: number = 3;
const BEST_MATCH_BONUS: number = 0.02;
const CONFIDENCE_CAP: number = 0.99;
const CANDIDATE_LIMIT: number = 8;
const MIN_WORD_LENGTH: number = 3;
const MIN_TRIGGER_CHARS: number = 2;

export interface Prediction {
    text: string;
    source: 'glossary' | 'tm' | 'file' | 'mt';
    confidence: number;
}

export interface PredictionContext {
    sourceText: string;
    previousWord?: string;
}

interface Candidate {
    key: string;
    prediction: Prediction;
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
        // Strip leading/trailing punctuation from the word
        const cleanWord: string = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
        // Skip words shorter than MIN_WORD_LENGTH for tm, file, and mt sources.
        // Glossary terms are always accepted, e.g. 2-char acronyms like "pH".
        if (prediction.source !== 'glossary' && cleanWord.length < MIN_WORD_LENGTH) {
            return;
        }
        if (cleanWord.length < MIN_TRIGGER_CHARS) {
            return;
        }
        let node: TrieNode = this.root;
        const key: string = cleanWord.toLowerCase();
        for (const ch of key) {
            if (!node.children.has(ch)) {
                node.children.set(ch, { children: new Map(), completions: [] });
            }
            node = node.children.get(ch) as TrieNode;
        }
        // Merge same word + source: keep the higher confidence. Without this, a
        // word whose confidence grows (frequency scoring) could be dropped by the
        // top-3 truncation before its stronger entry arrives.
        const existing: Prediction | undefined = node.completions.find(
            (c: Prediction): boolean => c.text === cleanWord && c.source === prediction.source
        );
        if (existing) {
            if (prediction.confidence > existing.confidence) {
                existing.confidence = prediction.confidence;
                node.completions.sort((a: Prediction, b: Prediction): number => b.confidence - a.confidence);
            }
            return;
        }
        node.completions.push({
            text: cleanWord,
            source: prediction.source,
            confidence: prediction.confidence
        });
        node.completions.sort((a: Prediction, b: Prediction): number => b.confidence - a.confidence);
        if (node.completions.length > 3) {
            node.completions.length = 3;
        }
    }

    collect(prefix: string, limit: number): Candidate[] {
        if (prefix.length < MIN_TRIGGER_CHARS) {
            return [];
        }
        let node: TrieNode = this.root;
        const key: string = prefix.toLowerCase();
        for (const ch of key) {
            if (!node.children.has(ch)) {
                return [];
            }
            node = node.children.get(ch) as TrieNode;
        }
        const found: Map<string, Candidate> = new Map();
        this.collectCandidates(node, found);
        // DFS order (completions first, then children in insertion order)
        return Array.from(found.values()).slice(0, limit);
    }

    private collectCandidates(node: TrieNode, found: Map<string, Candidate>): void {
        for (const c of node.completions) {
            const candidateKey: string = c.text.toLowerCase();
            const existing: Candidate | undefined = found.get(candidateKey);
            if (!existing || c.confidence > existing.prediction.confidence) {
                // Per-word merge across sources: keep the entry with the highest
                // base confidence; ties keep the DFS-first source.
                found.set(candidateKey, {
                    key: candidateKey,
                    prediction: { text: c.text, source: c.source, confidence: c.confidence }
                });
            }
        }
        for (const child of node.children.values()) {
            this.collectCandidates(child, found);
        }
    }

    clear(): void {
        this.root = { children: new Map(), completions: [] };
    }
}

export class PredictionEngine {

    trie: PrefixTrie;
    private frequency: Map<string, number>;
    private contextSources: string[][] = [];  // token arrays per source index
    private wordSources: Map<string, number[]> = new Map();  // word → source indices
    private bigrams: Map<string, Map<string, number>> = new Map();  // prev word → next word → count

    constructor() {
        this.trie = new PrefixTrie();
        this.frequency = new Map();
    }

    buildIndex(
        fileSegments: { target: string; source?: string }[],
        tmMatches: Match[],
        glossaryTerms: Term[],
        mtMatch?: Match
    ): void {
        this.trie.clear();
        this.frequency.clear();
        this.contextSources = [];
        this.wordSources = new Map();
        this.bigrams = new Map();

        // Glossary terms: confidence 0.95
        for (const term of glossaryTerms) {
            const targetText: string = term.target.replace(/<[^>]*>/g, '');
            const words: string[] = targetText.split(/\s+/);
            for (const word of words) {
                this.trie.insert(word, {
                    text: word,
                    source: 'glossary',
                    confidence: 0.95
                });
            }
            // Multi-word glossary terms contribute bigrams like any other source
            this.recordBigrams(words);
        }

        // TM matches: confidence = similarity / 100 (only ≥ 70%).
        // Words from the best TM match get BEST_MATCH_BONUS on top, so the
        // strongest match's words outrank the same word from weaker matches.
        let bestSim: number = 0;
        for (const match of tmMatches) {
            if (match.similarity > bestSim) {
                bestSim = match.similarity;
            }
        }
        for (const match of tmMatches) {
            if (match.similarity >= 70) {
                const isBest: boolean = match.similarity === bestSim;
                const targetText: string = match.target.replace(/<[^>]*>/g, '');
                const sourceIndex: number = this.registerSource(match.source);
                const words: string[] = targetText.split(/\s+/);
                for (const word of words) {
                    this.trie.insert(word, {
                        text: word,
                        source: 'tm',
                        confidence: isBest ? match.similarity / 100 + BEST_MATCH_BONUS : match.similarity / 100
                    });
                    if (sourceIndex >= 0) {
                        this.recordWordSource(word, sourceIndex);
                    }
                }
                this.recordBigrams(words);
            }
        }

        // Previously translated file segments: frequency-weighted confidence.
        // First pass: count every file-segment word occurrence.
        for (const segment of fileSegments) {
            if (segment.target) {
                const targetText: string = segment.target.replace(/<[^>]*>/g, '');
                const words: string[] = targetText.split(/\s+/);
                for (const word of words) {
                    this.countWord(word);
                }
            }
        }
        // Second pass: insert each word with the frequency-weighted confidence.
        for (const segment of fileSegments) {
            if (segment.target) {
                const targetText: string = segment.target.replace(/<[^>]*>/g, '');
                const sourceIndex: number = this.registerSource(segment.source ?? '');
                const words: string[] = targetText.split(/\s+/);
                for (const word of words) {
                    this.trie.insert(word, {
                        text: word,
                        source: 'file',
                        confidence: this.fileConfidence(word)
                    });
                    if (sourceIndex >= 0) {
                        this.recordWordSource(word, sourceIndex);
                    }
                }
                this.recordBigrams(words);
            }
        }

        // MT match if present: confidence 0.60
        if (mtMatch && mtMatch.target) {
            const targetText: string = mtMatch.target.replace(/<[^>]*>/g, '');
            const words: string[] = targetText.split(/\s+/);
            for (const word of words) {
                this.trie.insert(word, {
                    text: word,
                    source: 'mt',
                    confidence: 0.60
                });
            }
            this.recordBigrams(words);
        }
    }

    predict(wordPrefix: string, context?: PredictionContext): Prediction | null {
        if (wordPrefix.length < MIN_TRIGGER_CHARS) {
            return null;
        }
        const candidates: Candidate[] = this.trie.collect(wordPrefix, CANDIDATE_LIMIT);
        if (candidates.length === 0) {
            return null;
        }
        // When context is provided, candidates whose source text overlaps the
        // current segment's source get a boost (glossary words never do).
        // When the context also carries the previous word, candidates that
        // frequently follow it in the indexed targets get a bigram boost.
        const contextTokens: string[] = context ? this.tokenizeSource(context.sourceText) : [];
        const previousWord: string = context?.previousWord?.toLowerCase().trim() ?? '';
        const bigramRow: Map<string, number> | undefined = previousWord.length > 0 ? this.bigrams.get(previousWord) : undefined;
        let best: Candidate | null = null;
        let bestScore: number = -1;
        for (const candidate of candidates) {
            const base: number = candidate.prediction.confidence;
            let boost: number = context ? this.sourceBoost(candidate, contextTokens) : 0;
            if (bigramRow && candidate.prediction.source !== 'glossary') {
                const count: number | undefined = bigramRow.get(candidate.key);
                if (count && count > 0) {
                    boost += BIGRAM_BOOST_MAX * Math.min(1, count / BIGRAM_BOOST_SATURATION);
                }
            }
            const score: number = context ? Math.min(base + boost, CONFIDENCE_CAP) : base;
            if (score > bestScore) {
                best = candidate;
                bestScore = score;
            }
        }
        return best ? { text: best.prediction.text, source: best.prediction.source, confidence: bestScore } : null;
    }

    addEntry(targetText: string, source: Prediction['source'], confidence: number): void {
        const cleanText: string = targetText.replace(/<[^>]*>/g, '');
        const words: string[] = cleanText.split(/\s+/);
        for (const word of words) {
            if (source === 'file') {
                // For file entries the frequency formula wins: bump the word's
                // count and re-insert with the updated confidence (merge-on-insert
                // keeps the higher value). The confidence parameter is ignored.
                this.countWord(word);
                this.trie.insert(word, {
                    text: word,
                    source: 'file',
                    confidence: this.fileConfidence(word)
                });
            } else {
                this.trie.insert(word, {
                    text: word,
                    source: source,
                    confidence: confidence
                });
            }
        }
        // Keep the bigram map in sync with incrementally added targets
        this.recordBigrams(words);
    }

    /**
     * Tokenizes source text for overlap scoring: lowercase, whitespace-split,
     * strips surrounding punctuation from each token, drops tokens shorter
     * than MIN_WORD_LENGTH, and de-duplicates.
     */
    private tokenizeSource(text: string): string[] {
        const tokens: string[] = [];
        for (const raw of text.toLowerCase().split(/\s+/)) {
            const clean: string = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
            if (clean.length >= MIN_WORD_LENGTH && !tokens.includes(clean)) {
                tokens.push(clean);
            }
        }
        return tokens;
    }

    /**
     * Stores the tokenized source text of a TM match or file segment and
     * returns its index in contextSources, or -1 when the source has no
     * usable tokens.
     */
    private registerSource(source: string): number {
        const tokens: string[] = this.tokenizeSource(source);
        if (tokens.length === 0) {
            return -1;
        }
        this.contextSources.push(tokens);
        return this.contextSources.length - 1;
    }

    /**
     * Links a target word to the source index it came from. Uses the same
     * cleaning and minimum-length rules as PrefixTrie.insert so that
     * wordSources keys always match collected candidate keys.
     */
    private recordWordSource(word: string, sourceIndex: number): void {
        const cleanWord: string = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
        const key: string = cleanWord.toLowerCase();
        if (key.length < MIN_TRIGGER_CHARS) {
            return;
        }
        const indices: number[] | undefined = this.wordSources.get(key);
        if (indices) {
            if (!indices.includes(sourceIndex)) {
                indices.push(sourceIndex);
            }
        } else {
            this.wordSources.set(key, [sourceIndex]);
        }
    }

    /**
     * Source-overlap boost for one candidate: the max over all sources that
     * produced the word of |contextTokens ∩ sourceTokens| / |contextTokens|,
     * scaled by SOURCE_BOOST_MAX, reaching full boost at or above
     * SOURCE_BOOST_THRESHOLD overlap. Glossary candidates are never boosted.
     */
    private sourceBoost(candidate: Candidate, contextTokens: string[]): number {
        if (candidate.prediction.source === 'glossary') {
            return 0;
        }
        if (contextTokens.length === 0) {
            return 0;
        }
        const indices: number[] | undefined = this.wordSources.get(candidate.key);
        if (!indices || indices.length === 0) {
            return 0;
        }
        let maxOverlap: number = 0;
        for (const index of indices) {
            const sourceTokens: string[] = this.contextSources[index];
            let intersection: number = 0;
            for (const token of contextTokens) {
                if (sourceTokens.includes(token)) {
                    intersection++;
                }
            }
            const overlap: number = intersection / Math.max(1, contextTokens.length);
            if (overlap > maxOverlap) {
                maxOverlap = overlap;
            }
        }
        return SOURCE_BOOST_MAX * Math.min(1, maxOverlap / SOURCE_BOOST_THRESHOLD);
    }

    /**
     * Records consecutive word pairs of a target text in the bigram map.
     * Each pair is cleaned with the same rules as PrefixTrie.insert so that
     * bigram keys always match collected candidate keys.
     */
    private recordBigrams(words: string[]): void {
        for (let i: number = 0; i < words.length - 1; i++) {
            const cleanPrev: string = words[i].replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').toLowerCase();
            const cleanNext: string = words[i + 1].replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').toLowerCase();
            if (cleanPrev.length < MIN_TRIGGER_CHARS || cleanNext.length < MIN_TRIGGER_CHARS) {
                continue;
            }
            let row: Map<string, number> | undefined = this.bigrams.get(cleanPrev);
            if (!row) {
                row = new Map();
                this.bigrams.set(cleanPrev, row);
            }
            row.set(cleanNext, (row.get(cleanNext) ?? 0) + 1);
        }
    }

    /**
     * Counts one occurrence of a word in the frequency map. Uses the same
     * cleaning and minimum-length rules as PrefixTrie.insert so that counted
     * keys always match inserted words.
     */
    private countWord(word: string): void {
        const cleanWord: string = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
        if (cleanWord.length < MIN_TRIGGER_CHARS) {
            return;
        }
        const key: string = cleanWord.toLowerCase();
        this.frequency.set(key, (this.frequency.get(key) ?? 0) + 1);
    }

    /**
     * Frequency-weighted confidence for a file word:
     * min(0.80 + 0.12 * (1 - 1/count), 0.92)
     * One occurrence -> 0.80; confidence rises with count and is clamped at
     * FILE_FREQUENCY_CAP.
     */
    private fileConfidence(word: string): number {
        const cleanWord: string = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
        const key: string = cleanWord.toLowerCase();
        const count: number = this.frequency.get(key) ?? 1;
        const weighted: number = FILE_BASE_CONFIDENCE + FILE_FREQUENCY_RANGE * (1 - 1 / count);
        return Math.min(weighted, FILE_FREQUENCY_CAP);
    }

    clear(): void {
        this.trie.clear();
        this.frequency.clear();
        this.contextSources = [];
        this.wordSources = new Map();
        this.bigrams = new Map();
    }
}
