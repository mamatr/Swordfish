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

    constructor() {
        this.trie = new PrefixTrie();
        this.frequency = new Map();
    }

    buildIndex(
        fileSegments: { target: string }[],
        tmMatches: Match[],
        glossaryTerms: Term[],
        mtMatch?: Match
    ): void {
        this.trie.clear();
        this.frequency.clear();

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
                const words: string[] = targetText.split(/\s+/);
                for (const word of words) {
                    this.trie.insert(word, {
                        text: word,
                        source: 'tm',
                        confidence: isBest ? match.similarity / 100 + BEST_MATCH_BONUS : match.similarity / 100
                    });
                }
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
                const words: string[] = targetText.split(/\s+/);
                for (const word of words) {
                    this.trie.insert(word, {
                        text: word,
                        source: 'file',
                        confidence: this.fileConfidence(word)
                    });
                }
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
        }
    }

    predict(wordPrefix: string, context?: PredictionContext): Prediction | null {
        if (wordPrefix.length < MIN_TRIGGER_CHARS) {
            return null;
        }
        // context is optional: re-ranking with sourceText/previousWord is added
        // in later tasks; for now every candidate scores its base confidence.
        const candidates: Candidate[] = this.trie.collect(wordPrefix, CANDIDATE_LIMIT);
        if (candidates.length === 0) {
            return null;
        }
        let best: Candidate | null = null;
        let bestScore: number = -1;
        for (const candidate of candidates) {
            const score: number = candidate.prediction.confidence;
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
    }
}
