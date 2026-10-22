/**
 * 提交前的快速门禁 —— 由 `tools/install-hooks.mjs` 写进 `.githooks/commit-msg`。
 *
 * ## 为什么是「快速」子集而不是全部
 *
 * `npm run check` 里有 12 步，其中 `npm test`（283 个用例）单独就要 34 秒，
 * `gate:fault-injection` 还要起多个子进程。全部塞进钩子会让**每次提交都等
 * 半分钟以上**，而大多数提交只改了文档 —— 为不需要的检查付这个代价，
 * 结果是人开始用 `--no-verify`，门禁就此失效。
 *
 * 所以这里取**快且必要**的子集（判据只依赖当前文件内容、毫秒级完成）：
 * 字符完整性、Markdown 链接、双语结构、归属声明、发版记账、门禁对齐，
 * 外加两道需要提交信息的门禁（覆盖、supersession）。
 *
 * ## 为什么这三道必须在钩子里
 *
 * 它们是实测中**真实漏过**的：
 *
 *   - 字符完整性：写长篇中文笔记时 U+FFFD 反复出现。门禁一直在、本地也一直
 *     拦住了，但**靠人记得跑**。实测 5 次乱码里每一次都是「门禁红了但我没
 *     跑」，而不是「门禁没发现」。把它放进钩子，就从「记得跑」变成「跑不掉」。
 *   - 门禁对齐：接不进 CI 的门禁等于没有（上一轮的真实缺陷）。
 *   - Markdown 链接：归档笔记后入站链接没人修，钩子是最后一道即时反馈。
 *
 * ## 为什么仍然要 CI 兜底
 *
 * 钩子可被 `--no-verify` 绕过（这是设计取舍，为了让 `Note-Skip:` 合法出口
 * 不被堵死）。所以 CI 是权威，钩子只是**即时反馈** —— 它把「本地全绿、
 * CI 变红」这类需要来回排查一轮的问题，提前到提交那一刻。
 */
export const HOOK_BODY = `#!/bin/sh
# 由 tools/install-hooks.mjs 生成，请勿手改（改那个脚本）。
#
# 提交前的快速门禁。任一失败即拦下。
#
# 为什么是子集而不是全跑 npm run check：那里面含 283 个用例（约 34 秒），
# 每次提交都等这么久，人就会转去 --no-verify —— 门禁就此失效。
# 这里是「快且必要」的那部分；完整套件仍由 CI 兜底（权威那道）。
#
# ⚠️ 这些都是**即时反馈**。CI 才是权威：钩子可被 git commit --no-verify
#    绕过（那是为了让 Note-Skip 合法出口不被堵死）。
set -e

echo "▸ 字符完整性（U+FFFD 会静默破坏中文）"
node tools/text-integrity.mjs

echo "▸ Markdown 链接"
node tools/md-links.mjs

echo "▸ 双语文档结构"
node tools/bilingual-docs.mjs

echo "▸ 第三方归属声明"
node tools/notices.mjs --check

echo "▸ 发版记账"
node tools/release-check.mjs

echo "▸ 门禁对齐（CI 是否漏了本地门禁）"
node tools/ci-alignment.mjs

echo "▸ 覆盖门禁：该写笔记的改动必须同批带笔记"
node tools/notes-coverage.mjs --message-file "$1"

echo "▸ supersession：新增笔记必须声明与既有笔记的关系"
node tools/notes-supersession.mjs
`;
