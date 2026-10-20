/**
 * `tools/bilingual-links.mjs` 的行为测试 —— 双语互链「查」与「修」的分离。
 *
 * ## 这个改动在修什么
 *
 * 原来只有一个入口（改写），它接在 `npm run check` 链里且**没有任何参数**，
 * 于是**每次跑门禁都会往仓库里写盘**。
 *
 * 后果是实测出来的：只要工作区原本就是脏的，随后 `verify.yml` 末尾那条
 * `git status --porcelain` 断言就会红，而报错写的是「某个门禁在仓库里留下了
 * 改动」—— 它指的其实是**别人的**未提交改动（本地重放 CI 时就会遇到）。
 * 排查方向完全错。
 *
 * 门禁的职责是**判断**，写盘是**修**，两者不能是同一个按钮。
 *
 * ## 为什么每条用例都要连消息一起断言
 *
 * 只断言退出码是不够的：一道「文件缺失就红」的实现，同样能让「指错语言」
 * 那条用例（期望 1）通过。所以每条都断言失败消息里**是哪一类原因**。
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  checkTranslationLinkLocales,
  fixTranslationLinkLocales,
  main
} from './bilingual-links.mjs';

const ZH = `# 项目

[English](README.en.md) | **中文**

## 安装

见 [许可](LICENSE)。

## 致谢

链接见 [本仓库](https://github.com/dhicoc/dsh-agent-notes)。
`;

const EN = `# Project

[\u4e2d\u6587](README.md) | **English**

## Install

See [license](LICENSE).

## Credits

See [this repository](https://github.com/dhicoc/dsh-agent-notes).
`;

/**
 * 造一对临时文档，跑一段断言，然后整目录删掉。
 *
 * @param {Record<string, string>} files 文件名 → 内容。
 * @param {(dir: string) => void} body 断言体。
 */
function withPair(files, body) {
  const dir = mkdtempSync(join(tmpdir(), 'bilingual-links-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content, 'utf8');
    }
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 跑 `main` 并收集它打印的内容。
 *
 * @param {string[]} argv 参数。
 * @param {string} root 仓库根。
 * @returns {{ code: number, out: string }} 退出码与全部输出。
 */
function run(argv, root) {
  const chunks = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args) => chunks.push(args.join(' '));
  console.error = (...args) => chunks.push(args.join(' '));
  try {
    return { code: main(argv, root), out: chunks.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
  }
}

test('双语互链: 真仓库两份 README 没有指错语言的链', () => {
  const result = checkTranslationLinkLocales();
  assert.equal(result.missing.length, 0, '两份 README 都该在');
  assert.equal(result.violations, 0);
  assert.deepEqual(result.findings, []);
});

test('双语互链: --check 在真仓库返回 0', () => {
  const { code, out } = run(['--check'], join(import.meta.dirname, '..'));
  assert.equal(code, 0, out);
  assert.match(out, /双语互链正确/);
});

test('双语互链: 指错语言时 --check 返回 1,且消息说明是指错语言', () => {
  /* 正文里又指了一次英文版 —— 那不是语言切换器（切换器在更上面那行）。 */
  const zhBad = ZH + '\n另见 [英文版](README.en.md)。\n';
  withPair({ 'README.md': zhBad, 'README.en.md': EN }, (dir) => {
    const { code, out } = run(['--check'], dir);
    assert.equal(code, 1, out);
    assert.match(out, /指错语言/);
    assert.match(out, /README\.en\.md → README\.md/);
  });
});

test('双语互链: --check 一个字节都不写', () => {
  const zhBad = ZH + '\n另见 [英文版](README.en.md)。\n';
  withPair({ 'README.md': zhBad, 'README.en.md': EN }, (dir) => {
    const path = join(dir, 'README.md');
    const before = { mtime: statSync(path).mtimeMs, text: readFileSync(path, 'utf8') };
    const { code } = run(['--check'], dir);
    assert.equal(code, 1);
    assert.equal(readFileSync(path, 'utf8'), before.text, '内容必须没变');
    assert.equal(statSync(path).mtimeMs, before.mtime, 'mtime 必须没变（没写过的证据）');
  });
});

test('双语互链: 同一输入 fix 之后 --check 变绿（两个模式判据一致）', () => {
  const zhBad = ZH + '\n另见 [英文版](README.en.md)。\n';
  withPair({ 'README.md': zhBad, 'README.en.md': EN }, (dir) => {
    assert.equal(run(['--check'], dir).code, 1, '修之前必须红');
    const fixed = run([], dir);
    assert.equal(fixed.code, 0, fixed.out);
    assert.match(fixed.out, /已改写 1 条/);
    assert.equal(run(['--check'], dir).code, 0, '修之后必须绿');
  });
});

test('双语互链: 语言切换器那行不算指错语言', () => {
  withPair({ 'README.md': ZH, 'README.en.md': EN }, (dir) => {
    const { code, out } = run(['--check'], dir);
    assert.equal(code, 0, out);
  });
});

test('双语互链: 指向本对以外的链接不算违规', () => {
  const zh = ZH + '\n见 [其他](OTHER.md) 与 [外链](https://example.com/a)。\n';
  const en = EN + '\nSee [other](OTHER.md) and [external](https://example.com/a).\n';
  withPair({ 'README.md': zh, 'README.en.md': en }, (dir) => {
    const { code, out } = run(['--check'], dir);
    assert.equal(code, 0, out);
  });
});

test('双语互链: 一对文件少一个必须变红（空集合不许恒绿）', () => {
  /* 只有中文版：英文版不见了，「没有指错语言的链」就是恒真命题。
     这一类「空集合恒绿」本仓库反复栽过 —— vendored 三脚本在空笔记树上
     exit 0，直接接 CI 就是一条恒绿门禁。 */
  withPair({ 'README.md': ZH }, (dir) => {
    const { code, out } = run(['--check'], dir);
    assert.equal(code, 1, out);
    assert.match(out, /缺失/);
    assert.match(out, /README\.en\.md/);
    /* 对照：只缺文件这一条原因，不该同时报「指错语言」。 */
    assert.doesNotMatch(out, /指错语言/);
  });
});

test('双语互链: 扫描结果是只读的，不产生新文件', () => {
  withPair({ 'README.md': ZH, 'README.en.md': EN }, (dir) => {
    const result = fixTranslationLinkLocales(dir);
    assert.deepEqual(result.changed, [], '本来就对，不该有任何文件被写');
    assert.equal(result.rewritten, 0);
  });
});
