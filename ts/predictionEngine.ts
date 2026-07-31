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
        // Strip leading/trailing punctuation from the word
        const cleanWord: string = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
        if (cleanWord.length < 2) {
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
        // Insert at terminal node, keep top 3 by confidence
        // Store the cleaned word as the completion text
        const cleanPrediction: Prediction = {
            text: cleanWord,
            source: prediction.source,
            confidence: prediction.confidence
        };
        node.completions.push(cleanPrediction);
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

        // TM matches: confidence = similarity / 100 (only ≥ 70%)
        for (const match of tmMatches) {
            if (match.similarity >= 70) {
                const targetText: string = match.target.replace(/<[^>]*>/g, '');
                const words: string[] = targetText.split(/\s+/);
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
                const targetText: string = segment.target.replace(/<[^>]*>/g, '');
                const words: string[] = targetText.split(/\s+/);
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

    predict(wordPrefix: string): Prediction | null {
        if (wordPrefix.length < 2) {
            return null;
        }
        return this.trie.lookup(wordPrefix);
    }

    addEntry(targetText: string, source: Prediction['source'], confidence: number): void {
        const cleanText: string = targetText.replace(/<[^>]*>/g, '');
        const words: string[] = cleanText.split(/\s+/);
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
