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
});
