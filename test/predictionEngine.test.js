/*******************************************************************************
 * Unit tests for PredictionEngine
 *
 * Run: node --test test/predictionEngine.test.js
 *******************************************************************************/

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PredictionEngine } from '../js/predictionEngine.js';

describe('PredictionEngine', () => {

    describe('predict()', () => {

        it('returns null when the index is empty', () => {
            const engine = new PredictionEngine();
            engine.buildIndex([], [], []);
            assert.equal(engine.predict('hello'), null);
        });

        it('returns null for prefix shorter than 2 characters', () => {
            const engine = new PredictionEngine();
            engine.buildIndex([], [], [{ srcLang: 'en', tgtLang: 'es', source: 'cat', target: 'gato', origin: 'test' }]);
            assert.equal(engine.predict('g'), null);
        });

        it('returns a match for a 2+ character prefix', () => {
            const engine = new PredictionEngine();
            engine.buildIndex([], [], [{ srcLang: 'en', tgtLang: 'es', source: 'cat', target: 'gato', origin: 'test' }]);
            const result = engine.predict('ga');
            assert.notEqual(result, null);
            assert.equal(result.text, 'gato');
            assert.equal(result.source, 'glossary');
        });

        it('returns null for a non-matching prefix', () => {
            const engine = new PredictionEngine();
            engine.buildIndex([], [], [{ srcLang: 'en', tgtLang: 'es', source: 'cat', target: 'gato', origin: 'test' }]);
            assert.equal(engine.predict('zz'), null);
        });

        it('preserves original casing in the result', () => {
            const engine = new PredictionEngine();
            engine.buildIndex([], [], [{ srcLang: 'en', tgtLang: 'es', source: 'Save', target: 'Guardar', origin: 'test' }]);
            // lookup is case-insensitive
            const result = engine.predict('gu');
            assert.equal(result.text, 'Guardar');
        });

        it('returns the completion when prefix partially matches', () => {
            const engine = new PredictionEngine();
            engine.buildIndex([], [], [{ srcLang: 'en', tgtLang: 'es', source: 'translation', target: 'traducción', origin: 'test' }]);
            const result = engine.predict('tra');
            assert.equal(result.text, 'traducción');
        });
    });

    describe('priority ordering', () => {

        it('glossary beats TM beats file beats MT', () => {
            const engine = new PredictionEngine();
            // glossary: 0.95
            const glossary = [{ srcLang: 'en', tgtLang: 'es', source: 'hello', target: 'hola', origin: 'gloss' }];
            // TM: 0.85
            const tm = [{ project: 'p', file: 'f', unit: 'u', segment: 's', type: 'tm', matchId: '1', similarity: 85, fuzzy: 0, srcLang: 'en', tgtLang: 'es', source: 'hello', target: 'buenos', origin: 'tm' }];
            // file: 0.80
            const file = [{ target: 'saludos' }];
            // When all compete, glossary should win
            engine.buildIndex(file, tm, glossary);
            const result = engine.predict('ho');
            assert.equal(result.text, 'hola');
            assert.equal(result.source, 'glossary');
        });

        it('TM beats file when no glossary match', () => {
            const engine = new PredictionEngine();
            const glossary = [{ srcLang: 'en', tgtLang: 'es', source: 'goodbye', target: 'adiós', origin: 'gloss' }];
            const tm = [{ project: 'p', file: 'f', unit: 'u', segment: 's', type: 'tm', matchId: '1', similarity: 90, fuzzy: 0, srcLang: 'en', tgtLang: 'es', source: 'hello', target: 'hola', origin: 'tm' }];
            const file = [];
            engine.buildIndex(file, tm, glossary);
            const result = engine.predict('ho');
            assert.equal(result.text, 'hola');
            assert.equal(result.source, 'tm');
        });

        it('filters TM matches below 70% similarity', () => {
            const engine = new PredictionEngine();
            const tm = [{ project: 'p', file: 'f', unit: 'u', segment: 's', type: 'tm', matchId: '1', similarity: 65, fuzzy: 0, srcLang: 'en', tgtLang: 'es', source: 'hello', target: 'hola', origin: 'tm' }];
            engine.buildIndex([], tm, []);
            assert.equal(engine.predict('ho'), null);
        });

        it('MT match is included when provided (lowest priority)', () => {
            const engine = new PredictionEngine();
            const mt = { project: 'p', file: 'f', unit: 'u', segment: 's', type: 'mt', matchId: '1', similarity: 100, fuzzy: 0, srcLang: 'en', tgtLang: 'es', source: 'hello', target: 'hola', origin: 'mt' };
            engine.buildIndex([], [], [], mt);
            const result = engine.predict('ho');
            assert.equal(result.text, 'hola');
            assert.equal(result.source, 'mt');
        });
    });

    describe('best-match weight', () => {

        it('words from the best TM match outrank the same word from a weaker match', () => {
            const engine = new PredictionEngine();
            const best = [{ project: 'p', file: 'f', unit: 'u', segment: 's', type: 'tm', matchId: '1', similarity: 95, fuzzy: 0, srcLang: 'en', tgtLang: 'es', source: 'hello', target: 'puerta casa', origin: 'tm' }];
            const other = [{ project: 'p', file: 'f', unit: 'u', segment: 's', type: 'tm', matchId: '2', similarity: 80, fuzzy: 0, srcLang: 'en', tgtLang: 'es', source: 'world', target: 'puerta pueblo', origin: 'tm' }];
            engine.buildIndex([], [...best, ...other], []);
            // Shared word: best match gets 95/100 + 0.02 = 0.97, weaker gets 0.80
            const result = engine.predict('pu');
            assert.equal(result.text, 'puerta');
            assert.equal(result.source, 'tm');
            assert.equal(result.confidence, 0.95 + 0.02);
            assert.ok(result.confidence > 0.80);
            // Word only present in the non-best match keeps similarity / 100
            const weaker = engine.predict('pueb');
            assert.equal(weaker.text, 'pueblo');
            assert.equal(weaker.confidence, 0.80);
        });

        it('builds the index without TM matches without crashing', () => {
            const engine = new PredictionEngine();
            engine.buildIndex([{ target: 'ventana' }], [], []);
            const result = engine.predict('ve');
            assert.notEqual(result, null);
            assert.equal(result.text, 'ventana');
            assert.equal(result.source, 'file');
            assert.equal(result.confidence, 0.80);
        });
    });

    describe('HTML stripping', () => {

        it('strips HTML tags from target text before tokenizing', () => {
            const engine = new PredictionEngine();
            const glossary = [{ srcLang: 'en', tgtLang: 'es', source: 'bold text', target: 'texto <b>negrita</b> aquí', origin: 'gloss' }];
            engine.buildIndex([], [], glossary);
            // Should match "negrita", not "<b>negrita</b>"
            const result = engine.predict('ne');
            assert.equal(result.text, 'negrita');
        });
    });

    describe('addEntry()', () => {

        it('adds a new entry to the trie incrementally', () => {
            const engine = new PredictionEngine();
            engine.buildIndex([], [], []);
            assert.equal(engine.predict('bo'), null);

            engine.addEntry('bonjour', 'file', 0.80);
            const result = engine.predict('bo');
            assert.notEqual(result, null);
            assert.equal(result.text, 'bonjour');
        });

        it('strips HTML from added entries', () => {
            const engine = new PredictionEngine();
            engine.buildIndex([], [], []);
            engine.addEntry('<i>italic</i> word', 'file', 0.80);
            const result = engine.predict('it');
            assert.equal(result.text, 'italic');
        });
    });

    describe('clear()', () => {

        it('empties the trie so predictions return null', () => {
            const engine = new PredictionEngine();
            const glossary = [{ srcLang: 'en', tgtLang: 'es', source: 'cat', target: 'gato', origin: 'gloss' }];
            engine.buildIndex([], [], glossary);
            assert.notEqual(engine.predict('ga'), null);

            engine.clear();
            assert.equal(engine.predict('ga'), null);
        });
    });

    describe('multi-word target text', () => {

        it('each word is individually searchable', () => {
            const engine = new PredictionEngine();
            const glossary = [{ srcLang: 'en', tgtLang: 'es', source: 'save as', target: 'guardar como archivo', origin: 'gloss' }];
            engine.buildIndex([], [], glossary);
            assert.equal(engine.predict('co').text, 'como');
            assert.equal(engine.predict('ar').text, 'archivo');
            assert.equal(engine.predict('gu').text, 'guardar');
        });
    });

    describe('short words', () => {

        it('words shorter than 2 characters are not inserted', () => {
            const engine = new PredictionEngine();
            const glossary = [{ srcLang: 'en', tgtLang: 'es', source: 'to', target: 'a', origin: 'gloss' }];
            engine.buildIndex([], [], glossary);
            // "a" is 1 character, should not be in trie
            assert.equal(engine.predict('a'), null);
        });
    });

    describe('idempotent rebuilds', () => {

        it('rebuilding the index clears old data', () => {
            const engine = new PredictionEngine();
            engine.buildIndex([], [], [{ srcLang: 'en', tgtLang: 'es', source: 'hello', target: 'hola', origin: 'gloss' }]);
            assert.equal(engine.predict('ho').text, 'hola');

            // Rebuild with different data
            engine.buildIndex([], [], [{ srcLang: 'en', tgtLang: 'es', source: 'goodbye', target: 'adiós', origin: 'gloss' }]);
            assert.equal(engine.predict('ho'), null);
            assert.equal(engine.predict('ad').text, 'adiós');
        });
    });

    describe('candidate collection', () => {

        it('predict() with no context behaves exactly like before (best base confidence wins)', () => {
            const engine = new PredictionEngine();
            // glossary 0.95 beats TM 0.90 for the same prefix
            const glossary = [{ srcLang: 'en', tgtLang: 'es', source: 'hello', target: 'hola', origin: 'gloss' }];
            const tm = [{ project: 'p', file: 'f', unit: 'u', segment: 's', type: 'tm', matchId: '1', similarity: 90, fuzzy: 0, srcLang: 'en', tgtLang: 'es', source: 'hello', target: 'hora', origin: 'tm' }];
            engine.buildIndex([], tm, glossary);
            const result = engine.predict('ho');
            assert.equal(result.text, 'hola');
            assert.equal(result.source, 'glossary');
            assert.equal(result.confidence, 0.95);
        });

        it('collect() returns distinct words, limited to the limit param', () => {
            const engine = new PredictionEngine();
            const glossary = [
                { srcLang: 'en', tgtLang: 'es', source: 'a', target: 'hola', origin: 'gloss' },
                { srcLang: 'en', tgtLang: 'es', source: 'b', target: 'hora', origin: 'gloss' },
                { srcLang: 'en', tgtLang: 'es', source: 'c', target: 'hoyo', origin: 'gloss' }
            ];
            engine.buildIndex([], [], glossary);
            // Same word from a second source must still count once
            engine.addEntry('hola', 'file', 0.80);
            const limited = engine.trie.collect('ho', 2);
            assert.equal(limited.length, 2);
            const all = engine.trie.collect('ho', 10);
            assert.equal(all.length, 3);
            // Distinct by lowercase key
            const keys = all.map((c) => c.key).sort();
            assert.deepEqual(keys, ['hola', 'hora', 'hoyo']);
        });

        it('predict() accepts an optional context param without breaking', () => {
            const engine = new PredictionEngine();
            const glossary = [{ srcLang: 'en', tgtLang: 'es', source: 'cat', target: 'gato', origin: 'gloss' }];
            engine.buildIndex([], [], glossary);
            const withSourceText = engine.predict('ga', { sourceText: 'the cat sat' });
            assert.equal(withSourceText.text, 'gato');
            assert.equal(withSourceText.confidence, 0.95);
            const withPreviousWord = engine.predict('ga', { sourceText: 'the cat sat', previousWord: 'the' });
            assert.equal(withPreviousWord.text, 'gato');
            assert.equal(withPreviousWord.source, 'glossary');
        });
    });

    describe('source-context boost', () => {

        it('word from a TM match whose source overlaps the current source beats a same-confidence word without overlap', () => {
            const engine = new PredictionEngine();
            // Same base confidence (both 80% + best-match bonus 0.02 = 0.82);
            // only the source overlap differs.
            const overlapping = [{ project: 'p', file: 'f', unit: 'u', segment: 's', type: 'tm', matchId: '1', similarity: 80, fuzzy: 0, srcLang: 'en', tgtLang: 'es', source: 'open the file', target: 'archivo', origin: 'tm' }];
            const unrelated = [{ project: 'p', file: 'f', unit: 'u', segment: 's', type: 'tm', matchId: '2', similarity: 80, fuzzy: 0, srcLang: 'en', tgtLang: 'es', source: 'close the window', target: 'arena', origin: 'tm' }];
            engine.buildIndex([], [...overlapping, ...unrelated], []);
            // Context overlaps 'open the file' fully (3/3 -> maxOverlap 1.0 ->
            // full SOURCE_BOOST_MAX 0.10); 'arena' shares only 'the' (1/3).
            const result = engine.predict('ar', { sourceText: 'open the file' });
            assert.equal(result.text, 'archivo');
            assert.equal(result.source, 'tm');
            // 0.80 + 0.02 bonus + 0.10 boost = 0.92, under the 0.99 cap
            assert.equal(result.confidence, 80 / 100 + 0.02 + 0.10);
            assert.ok(result.confidence > 0.90);
        });

        it('word with no source overlap gets no boost (same base confidence)', () => {
            const engine = new PredictionEngine();
            const tm = [{ project: 'p', file: 'f', unit: 'u', segment: 's', type: 'tm', matchId: '1', similarity: 80, fuzzy: 0, srcLang: 'en', tgtLang: 'es', source: 'totally unrelated words here', target: 'puerta', origin: 'tm' }];
            engine.buildIndex([], tm, []);
            const base = engine.predict('pu');
            const withContext = engine.predict('pu', { sourceText: 'xyz zzz qqq' });
            assert.equal(withContext.text, 'puerta');
            assert.equal(withContext.confidence, base.confidence);
            // A file segment without source text also gets no boost
            const engine2 = new PredictionEngine();
            engine2.buildIndex([{ target: 'ventana' }], [], []);
            const base2 = engine2.predict('ve');
            const withContext2 = engine2.predict('ve', { sourceText: 'xyz zzz qqq' });
            assert.equal(withContext2.confidence, base2.confidence);
        });

        it('glossary words never receive source boost', () => {
            const engine = new PredictionEngine();
            const glossary = [{ srcLang: 'en', tgtLang: 'es', source: 'cat sat on mat', target: 'gato', origin: 'gloss' }];
            engine.buildIndex([], [], glossary);
            // Perfect overlap, but glossary candidates are exempt
            const result = engine.predict('ga', { sourceText: 'cat sat on mat' });
            assert.equal(result.text, 'gato');
            assert.equal(result.source, 'glossary');
            assert.equal(result.confidence, 0.95);
        });
    });

    describe('frequency scoring', () => {

        it('a file word seen once gets FILE_BASE_CONFIDENCE (0.80)', () => {
            const engine = new PredictionEngine();
            engine.buildIndex([{ target: 'saludos' }], [], []);
            const result = engine.predict('sa');
            assert.notEqual(result, null);
            assert.equal(result.text, 'saludos');
            assert.equal(result.source, 'file');
            // n=1 -> 0.80 + 0.12 * (1 - 1/1) = 0.80
            assert.equal(result.confidence, 0.80);
        });

        it('a file word seen 5 times beats a file word seen once', () => {
            const engine = new PredictionEngine();
            const file = [
                { target: 'puerta' },
                { target: 'puerta' },
                { target: 'puerta' },
                { target: 'puerta' },
                { target: 'puerta' },
                { target: 'pueblo' }
            ];
            engine.buildIndex(file, [], []);
            const result = engine.predict('pu');
            assert.equal(result.text, 'puerta');
            assert.equal(result.source, 'file');
            // n=5 -> 0.80 + 0.12 * (1 - 1/5) = 0.896
            assert.equal(result.confidence, 0.80 + 0.12 * (1 - 1 / 5));
            assert.ok(result.confidence > 0.80);
        });

        it('a file word seen 50 times reaches near-cap confidence, capped at FILE_FREQUENCY_CAP (0.92)', () => {
            const engine = new PredictionEngine();
            const file = [];
            for (let i = 0; i < 50; i++) {
                file.push({ target: 'transparente' });
            }
            engine.buildIndex(file, [], []);
            const result = engine.predict('tr');
            assert.equal(result.text, 'transparente');
            assert.equal(result.source, 'file');
            // n=50 -> 0.80 + 0.12 * (1 - 1/50) = 0.9176, below the 0.92 cap
            assert.equal(result.confidence, 0.80 + 0.12 * (1 - 1 / 50));
            assert.ok(result.confidence <= 0.92);
            assert.ok(Math.abs(result.confidence - 0.92) < 0.01);
        });
    });
});
