/*!
 * 自动连播助手 (Auto Video Player)
 * -----------------------------------------------------------------------------
 * 著作权所有 (c) 2026 胡昱晨 (hu_yu_chen)。保留所有权利。
 * 本文件为项目自检入口，MIT 授权，详见 LICENSE。禁止删除作者署名。
 * -----------------------------------------------------------------------------
 *
 * 回归总门禁：一条命令跑完所有自检。
 * 任何改动合入前必须 node tests/run-all.js 全绿，否则视为不合格。
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const files = fs.readdirSync(dir)
  .filter(f => /^selftest_.*\.js$/.test(f))
  .sort();

if (!files.length) {
  console.log('未找到任何自检文件');
  process.exit(1);
}

let totalPass = 0, totalFail = 0;
const failed = [];

console.log('自动连播助手 · 回归总门禁\n' + '='.repeat(48));

files.forEach(f => {
  const r = spawnSync(process.execPath, [path.join(dir, f)], { encoding: 'utf8' });
  const out = String(r.stdout || '');
  const m = out.match(/结果：(\d+) 通过 \/ (\d+) 失败/);
  const p = m ? parseInt(m[1], 10) : 0;
  const q = m ? parseInt(m[2], 10) : (r.status === 0 ? 0 : 1);
  totalPass += p; totalFail += q;
  const tag = q === 0 ? 'OK  ' : 'FAIL';
  console.log(tag + '  ' + f.padEnd(30) + p + ' 通过 / ' + q + ' 失败');
  if (q !== 0) {
    failed.push(f);
    out.split('\n').filter(l => /^FAIL/.test(l)).forEach(l => console.log('        ' + l));
    if (r.stderr) String(r.stderr).split('\n').slice(0, 3).forEach(l => l && console.log('        ' + l));
  }
});

console.log('='.repeat(48));
console.log('合计：' + totalPass + ' 通过 / ' + totalFail + ' 失败');

if (totalFail) {
  console.log('\n门禁未通过，涉及文件：' + failed.join(', '));
  if (failed.indexOf('selftest_whaty_frozen.js') >= 0) {
    console.log('注意：网梯平台已冻结，该用例失败意味着改动触碰了网梯逻辑，不得合入。');
  }
  process.exit(1);
}
console.log('全部通过，可以合入。');
