/**
 * 项目副本检测与同步的测试。
 *
 * 为什么单独测：项目里的 `.agents/skills/agent-notes/` 被项目 git 跟踪，
 * 插件擅自改写会在用户仓库里制造未提交改动。所以这里的核心契约是
 * **只在不一致时才提示、只在显式 --yes 时才落盘**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  BUNDLED_SKILL_DIR,
  PROJECT_SKILL_REL,
  buildDriftHint,
  inspectProjectSkillCopy,
  syncProjectSkillCopy,
  projectUsesNotes
} from '../lib/project-skill.js';
import { POLICY_MARKERS, buildPolicyText } from '../lib/policy.js';

/** 造一个带项目副本的临时项目目录。 */
function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'an-proj-'));
  const target = join(dir, PROJECT_SKILL_REL);
  /* 必须先建父目录：`cpSync` **不会**为深层目标递归创建父级，路径中间的
     `.agents/skills/` 不存在时它会直接 ENOENT。
     本机常年通过、实测偶发红过一次
     （`cp ENOENT ...\an-proj-xxx\.agents\skills\agent-notes`）——
     这类「本机能过」的缺陷最难查，所以显式补上。 */
  mkdirSync(dirname(target), { recursive: true });
  cpSync(BUNDLED_SKILL_DIR, target, { recursive: true });
  return { dir, target };
}

test('project-skill: 副本与内置一致时不提示', () => {
  const { dir } = makeProject();
  try {
    const info = inspectProjectSkillCopy(dir);
    assert.equal(info.present, true, '应当识别出副本存在');
    assert.equal(info.behind, false, '完全一致时不得报落后');
    assert.equal(buildDriftHint(info), undefined, '一致时必须不产生提示');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('project-skill: 没有副本时不提示，也不误报', () => {
  const dir = mkdtempSync(join(tmpdir(), 'an-noproj-'));
  try {
    const info = inspectProjectSkillCopy(dir);
    assert.equal(info.present, false, '没有副本');
    assert.equal(info.behind, false, '没有副本不等于落后');
    assert.equal(buildDriftHint(info), undefined, '没有副本时不该提示');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('project-skill: 内容被改 / 文件缺失都算落后，并给出可问用户的提示', () => {
  const { dir, target } = makeProject();
  try {
    const skill = join(target, 'SKILL.md');
    const original = readFileSync(skill, 'utf8');
    writeFileSync(skill, `${original}\n篡改\n`, 'utf8');
    /* 再删一个文件，覆盖 missing 分支。 */
    rmSync(join(target, 'templates', 'proposed.md'), { force: true });

    const info = inspectProjectSkillCopy(dir);
    assert.equal(info.present, true);
    assert.equal(info.behind, true, '有差异时必须报落后');
    assert.ok(info.changed.includes('SKILL.md'), 'SKILL.md 应计入 changed');
    assert.ok(info.missing.includes('templates/proposed.md'), '删除的文件应计入 missing');

    const hint = buildDriftHint(info);
    assert.equal(typeof hint, 'string', '落后时必须产生提示');
    /* 提示要能让模型知道「去问用户」而不是自己改。 */
    assert.match(hint, /问/, '提示必须要求先问用户');
    assert.match(hint, /sync-skill/, '提示必须给出命令名');
    assert.match(hint, /\d+ 个文件/, '提示应给出规模');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('project-skill: 项目多出来的文件不算落后，且不会被删', () => {
  const { dir, target } = makeProject();
  try {
    const extra = join(target, 'references', 'local-only.md');
    writeFileSync(extra, '# 项目自己的东西\n', 'utf8');

    const info = inspectProjectSkillCopy(dir);
    /* 失败时把具体差异打出来。这条测试在 CI 上偶发失败过：
       behind=true 意味着「内置副本与刚拷出来的项目副本不一致」——
       而 makeProject 是 cpSync 自同一目录，正常绝不该不一致。
       真出现时，第一现场信息（哪些文件不同）比一句断言值有用得多。 */
    assert.equal(
      info.behind, false,
      `多出文件不算落后。changed=${JSON.stringify(info.changed)} `
        + `missing=${JSON.stringify(info.missing)} extra=${JSON.stringify(info.extra)}`
    );
    assert.ok(info.extra.includes('references/local-only.md'), '应记进 extra');

    syncProjectSkillCopy(dir, {});
    assert.ok(existsSync(extra), '同步不得删除项目自己加的文件');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('project-skill: dryRun 不写盘，--yes 才真写', () => {
  const { dir, target } = makeProject();
  try {
    const skill = join(target, 'SKILL.md');
    writeFileSync(skill, '# 旧内容\n', 'utf8');

    const preview = syncProjectSkillCopy(dir, { dryRun: true });
    assert.ok(preview.written.includes('SKILL.md'), '预览应列出待写文件');
    assert.equal(readFileSync(skill, 'utf8'), '# 旧内容\n', '预览绝不能写盘');

    const applied = syncProjectSkillCopy(dir, {});
    assert.ok(applied.written.includes('SKILL.md'), '落盘应列出已写文件');
    assert.equal(
      readFileSync(skill, 'utf8'),
      readFileSync(join(BUNDLED_SKILL_DIR, 'SKILL.md'), 'utf8'),
      '落盘后必须与内置版本逐字相同'
    );
    /* 写完之后再查一次，应当已经一致。 */
    assert.equal(inspectProjectSkillCopy(dir).behind, false, '同步后不应再报落后');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('policy: 带提示时规范仍完整，只是追加一段', () => {
  const base = buildPolicyText();
  for (const marker of POLICY_MARKERS) {
    assert.ok(base.includes(marker), `基础规范必须含判据 ${marker}`);
  }
  const withHint = buildPolicyText('# 落后提示\n去问用户。');
  assert.ok(withHint.startsWith(base), '追加提示不得改动原有规范');
  assert.ok(withHint.includes('去问用户'), '提示应被附加');
  assert.equal(buildPolicyText(undefined), base, '无提示时与原规范完全一致');
  assert.equal(buildPolicyText('   '), base, '空白提示等同于无提示');
});

test('policy: 明确交代两份副本的关系，并禁止编造 README/升级路径', () => {
  /* 回归测试：实测模型在项目里初始化笔记后会声称
     「升级方式写在副本 README 里」—— 但项目副本里根本没有 README，
     SKILL.md 也没有这套说法，是模型自己编的。
     注入文本必须把机制讲清楚，否则它会继续编。 */
  const text = buildPolicyText();
  assert.match(text, /没有 README/, '必须明说副本里没有 README');
  assert.match(text, /sync-skill/, '必须给出真实的升级命令');
  assert.match(text, /插件内置那份会自动更新/, '必须说明内置那份不用手工升级');
  assert.match(text, /别编造/, '必须明确禁止编造文件名或升级路径');
  /* 原有判据一个字都不能丢。 */
  for (const marker of POLICY_MARKERS) {
    assert.ok(text.includes(marker), `规范必须含 ${marker}`);
  }
});

/** 建立真正的技能安装文件，而不是用空目录冒充安装。 */
function writeNoteSkill(root, rel, name = 'agent-notes') {
  const dir = join(root, ...rel.split('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), [
    '---', 'name: ' + name, 'description: decision notes', '---', '', '# Notes', ''
  ].join('\n'));
}

/** 只建旧项目的笔记与脚本配套，不安装项目技能。 */
function writeExistingNote(root, rel = '.agents/notes') {
  const dir = join(root, ...rel.split('/'), 'implemented', 'bug-fix');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '2026-11-19-existing.md'), [
    '# Agent Note: 既有项目的决定', '', 'Status: implemented', '',
    '## Problem', '旧项目没有项目 skill。', '', '## Decision', '展示既有笔记。', '',
    '## Alternatives considered', '无', '', '## Consequences', '不改写项目文件。', ''
  ].join('\n'));
}

test('projectUsesNotes: 已有真实笔记的 notes-scripts 项目即使没有 skill 也显示', () => {
  const root = mkdtempSync(join(tmpdir(), 'an-existing-'));
  try {
    mkdirSync(join(root, '.agents', 'notes-scripts'), { recursive: true });
    writeExistingNote(root);
    assert.equal(existsSync(join(root, '.agents', 'skills')), false);
    assert.equal(projectUsesNotes(root), true, '旧式配套不能因没有项目 skill 而丢掉看板');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('projectUsesNotes: 空目录、任意 Markdown 和翻译旁挂不能冒充真实笔记', () => {
  const root = mkdtempSync(join(tmpdir(), 'an-empty-notes-'));
  try {
    const dir = join(root, '.agents', 'notes', 'implemented', 'bug-fix');
    mkdirSync(dir, { recursive: true });
    assert.equal(projectUsesNotes(root), false, '空笔记目录不是接入证据');
    writeFileSync(join(dir, 'README.md'), '# 使用说明\n');
    writeFileSync(join(dir, '2026-11-19-random.md'), '# 随手记录\n');
    assert.equal(projectUsesNotes(root), false, '无关内容不会多出 tab');
    writeFileSync(join(dir, '2026-11-19-sidecar.zh.md'), '# Agent Note: translation\n\nStatus: implemented\n');
    assert.equal(projectUsesNotes(root), false, '翻译旁挂不算独立笔记');
    assert.equal(projectUsesNotes(undefined), false);
    assert.equal(projectUsesNotes(''), false);
    assert.equal(projectUsesNotes('.'), false, '不能退回宿主进程目录');
    assert.equal(projectUsesNotes(join(root, 'missing')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('projectUsesNotes: 技能身份来自 SKILL.md，不猜目录名的 notes 子串', () => {
  const root = mkdtempSync(join(tmpdir(), 'an-skill-identity-'));
  try {
    mkdirSync(join(root, '.agents', 'skills', 'agent-notes'), { recursive: true });
    assert.equal(projectUsesNotes(root), false, '空壳不能冒充技能');
    writeNoteSkill(root, '.agents/skills/agent-notes', 'meeting-notes');
    writeNoteSkill(root, '.agents/skills/meeting-notes', 'meeting-notes');
    assert.equal(projectUsesNotes(root), false, '别的笔记技能不是决策笔记');
    writeNoteSkill(root, '.agents/skills/agent-notes');
    assert.equal(projectUsesNotes(root), true);
    rmSync(join(root, '.agents'), { recursive: true, force: true });
    writeNoteSkill(root, '.agents/skills/write-notes-like-deepseek', 'write-notes-like-deepseek');
    assert.equal(projectUsesNotes(root), true, '上游旧名按身份识别');
    rmSync(join(root, '.agents'), { recursive: true, force: true });
    writeNoteSkill(root, '.claude/skills/agent-notes');
    assert.equal(projectUsesNotes(root), true, '项目级 Claude 技能也支持');
    rmSync(join(root, '.claude'), { recursive: true, force: true });
    writeNoteSkill(root, 'skills/agent-notes', 'write-notes-like-deepseek');
    assert.equal(projectUsesNotes(root), true, '本插件的包布局仍支持');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('projectUsesNotes: 子目录继承所属仓库的笔记，但不越过嵌套仓库边界', () => {
  const root = mkdtempSync(join(tmpdir(), 'an-adoption-root-'));
  try {
    mkdirSync(join(root, '.git'));
    const child = join(root, 'src', 'ui');
    mkdirSync(child, { recursive: true });
    writeExistingNote(root);
    assert.equal(projectUsesNotes(child), true);
    const nested = join(root, 'vendor', 'other');
    mkdirSync(join(nested, '.git'), { recursive: true });
    assert.equal(projectUsesNotes(nested), false, '嵌套仓库不能借用父项目的笔记');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('projectUsesNotes: 复用看板的配置/工作树笔记根，不把单独 notesRoot 当成存在证据', () => {
  const root = mkdtempSync(join(tmpdir(), 'an-custom-notes-'));
  try {
    const notesRoot = join(root, 'custom-notes');
    const roots = () => [notesRoot];
    assert.equal(projectUsesNotes(root, roots), false);
    writeExistingNote(root, 'custom-notes');
    assert.equal(projectUsesNotes(root), false, '没有扫描无关子目录');
    assert.equal(projectUsesNotes(root, roots), true, '配置根里有真实笔记时展示');
    writeExistingNote(root);
    assert.equal(projectUsesNotes(root, () => []), false, '以看板实际读取的根为准，不另猜默认目录');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
