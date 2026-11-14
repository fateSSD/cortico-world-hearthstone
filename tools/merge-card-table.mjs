/**
 * 把重新生成的卡表合并进旧卡表：**旧条目一个字不动，只补旧表里没有的 id。**
 *
 * 为什么需要这一步（2026-11-06 实测）：
 *
 *   1. `build-card-table.mjs` 的摘要是从卡面文本按关键词提炼的，质量取决于 HearthstoneJSON
 *      的 `mechanics` 字段。同一个 API 换了一版数据之后，`VAC_915`「大力扣杀」的摘要从
 *      `伤害4(仅随从) 随机给友方+4/+4` 退化成了 `伤害4随机随从 +4/+4` —— **后者是错的**，
 *      她会照着念「这牌伤害随机随从」，而它其实是打到随从身上、另外给友方加身材。
 *      直接覆盖等于把以前修好的摘要全部打回原形。
 *
 *   2. 反过来，新版本数据里确实有旧表没有的牌（这次是要补衍生 token，
 *      比如 `TIME_009t2`「梅卡托克的光环」）。
 *
 * 所以：**加，不改**。卡面数值（费用/身材）偶尔会因为平衡调整变化，那时候才需要
 * 手工挑几条覆盖 —— 那属于人工判断，不该由脚本顺手做掉。
 *
 *   node tools/merge-card-table.mjs <旧表> <新表> <输出>
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [oldPath, freshPath, outPath] = process.argv.slice(2);
if (!oldPath || !freshPath || !outPath) {
  console.error('用法: node tools/merge-card-table.mjs <旧表> <新表> <输出>');
  process.exit(1);
}

const oldData = JSON.parse(readFileSync(oldPath, 'utf8'));
const freshData = JSON.parse(readFileSync(freshPath, 'utf8'));
const oldCards = oldData.cards ?? {};
const freshCards = freshData.cards ?? {};

const merged = { ...oldCards };
let added = 0;
let kept = 0;
for (const [id, row] of Object.entries(freshCards)) {
  if (merged[id]) {
    kept += 1;
    continue;
  }
  merged[id] = row;
  added += 1;
}
const onlyOld = Object.keys(oldCards).filter((id) => !freshCards[id]).length;

// 键排序，让人翻文件时能按 id 找 —— 顺序不影响读取，只是好看。
const sorted = {};
for (const id of Object.keys(merged).sort()) sorted[id] = merged[id];

const payload = {
  source: freshData.source ?? oldData.source,
  note: freshData.note ?? oldData.note,
  cards: sorted,
};

const json = JSON.stringify(payload);
writeFileSync(outPath, json, 'utf8');
console.log(
  `合并完成:保留 ${kept} 张 / 新增 ${added} 张 / 只在旧表里 ${onlyOld} 张(也保留)`
  + `| 共 ${Object.keys(sorted).length} 张,${(json.length / 1024).toFixed(0)} KB → ${outPath}`,
);
