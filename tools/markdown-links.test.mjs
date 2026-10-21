import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectRelativeLinks, referencedDefinitions } from './markdown-links.mjs';
import { rewriteTranslationLinkLocales, PAIRS } from './bilingual-links.mjs';

const targets = (text) => collectRelativeLinks(text).map((link) => link.target);

test('links: balanced parentheses preserve the complete destination', () => {
  assert.deepEqual(targets('[x](docs/a(b).md)'), ['docs/a(b).md']);
});

test('links: titled reference definitions preserve exact offsets', () => {
  const text = `[x][ref]

[ref]: missing.md "title"
`;
  const links = collectRelativeLinks(text);
  assert.equal(links.length, 1);
  assert.equal(links[0].target, 'missing.md');
  assert.equal(text.slice(links[0].start, links[0].end), 'missing.md');
});

test('links: inline code and fenced examples are not live links', () => {
  const text = ['`[x](missing.md)`', '', '```md', '[x](missing.md)', '```', ''].join(String.fromCharCode(10));
  assert.deepEqual(targets(text), []);
});

test('links: shortcut references identify the used definition', () => {
  const text = `[ref]

[ref]: missing.md
`;
  assert.equal(referencedDefinitions(text).get('ref')?.target, 'missing.md');
});

test('locale: same basename in another directory is not this pair', () => {
  const text = `# Title

[English](README.en.md)

[x](other/README.en.md)
`;
  assert.equal(rewriteTranslationLinkLocales(text, PAIRS[0], 'README.md').content, text);
});

test('locale: an ordinary first body link is not a language switcher', () => {
  const text = `# Title

[x](README.en.md)
`;
  const result = rewriteTranslationLinkLocales(text, PAIRS[0], 'README.md');
  assert.equal(result.rewritten, 1);
  assert.ok(result.content.includes('[x](README.md)'));
});

test('locale: a switcher does not exempt another link on the same line', () => {
  const text = `# Title

[English](README.en.md) [x](README.en.md#details)
`;
  const result = rewriteTranslationLinkLocales(text, PAIRS[0], 'README.md');
  assert.equal(result.rewritten, 1);
  assert.ok(result.content.includes('[English](README.en.md)'));
  assert.ok(result.content.includes('[x](README.md#details)'));
});
