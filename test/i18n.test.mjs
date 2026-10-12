import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { english, translate, chooseLanguage } from '../ui/i18n.mjs';

test('interface defaults to English and remembers explicit language selection', () => {
  assert.equal(chooseLanguage(null), 'en');
  assert.equal(chooseLanguage('invalid'), 'en');
  assert.equal(chooseLanguage('en'), 'en');
  assert.equal(chooseLanguage('de'), 'de');
  assert.equal(translate('en', 'Scan vom {date}', {date: '12/10'}), 'Scan from 12/10');
  assert.equal(translate('de', 'Scan vom {date}', {date: '12.10.'}), 'Scan vom 12.10.');
});

test('API and image validation messages have English translations', () => {
  const sources = ['server.mjs','png.mjs'].map(name => readFileSync(new URL('../ui/'+name, import.meta.url), 'utf8')).join('\n');
  const messages = [...sources.matchAll(/(?:message: |job\.message = |error: |new Error\()'([^']+)'/g)].map(match=>match[1]);
  for (const message of messages) assert.ok(english[message], `Missing English translation: ${message}`);
  for (const message of ['Ungültiges Scanformat.', 'Unvollständiges Scanbild.']) assert.ok(english[message]);
});
