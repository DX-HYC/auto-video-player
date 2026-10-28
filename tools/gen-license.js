/*!
 * 自动连播助手 (Auto Video Player) · 授权码生成器（作者工具，不随扩展分发）
 * -----------------------------------------------------------------------------
 * 著作权所有 (c) 2026 胡昱晨 (hu_yu_chen)。保留所有权利。
 * 详见 LICENSE。本工具由插件作者在本地运行，用于向买家签发授权码。
 *
 * 用法（在项目根目录或任意目录运行，路径以实际为准）：
 *   node tools/gen-license.js --days 365 --customer CUST-001
 *   node tools/gen-license.js --days 30 --customer 张三 --note "试用"
 *   node tools/gen-license.js --forever --customer 李四
 *
 * v2.1.1 起授权为「程序级」：不绑定域名、不绑定平台，签出的授权码在任何网站
 * 都能使用，激活后全部功能可用。--domain 参数已废弃（传入会被忽略并提示）。
 *
 * 参数：
 *   --days      授权天数，从今天起算。默认 365。与 --forever 二选一。
 *   --forever   永久有效（授权码里不带过期时间）。
 *   --customer  客户编号或姓名，写进授权码，便于售后溯源。建议必填。
 *   --note      备注，写进授权码（如渠道、订单号）。
 *   --secret    覆盖签名密钥。仅在你轮换密钥后使用；默认用 license.js 内置密钥。
 *   --no-verify 跳过生成后的自检（不建议）。
 *
 * 输出：分组显示的授权码 + 授权摘要 + 可直接转发给买家的话术。
 * -----------------------------------------------------------------------------
 */
'use strict';

const path = require('path');
const L = require(path.join(__dirname, '..', 'license.js'));

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (key === 'forever' || key === 'no-verify' || key === 'help') { out[key] = true; continue; }
    if (next === undefined || next.startsWith('--')) { out[key] = ''; continue; }
    out[key] = next;
    i++;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('用法: node tools/gen-license.js [--days 365] [--forever] --customer <客户号> [--note 备注]');
    console.log('示例: node tools/gen-license.js --days 365 --customer CUST-001');
    process.exit(0);
  }
  if (args.domain) {
    console.log('提示：v2.1.1 起授权为程序级（不绑定域名/平台），--domain 已忽略。');
  }

  let expire = 0;
  let expireText = '永久有效';
  if (!args.forever) {
    const days = Math.max(1, parseInt(args.days || '365', 10) || 365);
    expire = Math.floor(Date.now() / 1000) + days * 86400;
    expireText = L.fmtDate(expire) + '（' + days + ' 天）';
  }

  const customer = String(args.customer || '').trim();
  if (!customer) {
    console.error('✗ 建议填写 --customer（客户编号/姓名），写进授权码便于售后溯源');
    process.exit(1);
  }

  const secret = args.secret || L.SIGN_SECRET;
  const key = L.makeKey({
    expire: expire,
    customer: customer,
    note: String(args.note || '').trim()
  }, secret);

  // 生成后自检：用同一密钥重新校验，防止"签完自己都不认"
  if (!args['no-verify']) {
    const st = L.verifyLicense(key, '', Date.now());
    if (!st.ok) {
      console.error('✗ 自检失败（不该发生）：' + st.msg);
      process.exit(1);
    }
  }

  console.log('');
  console.log('════════════════════════════════════════════');
  console.log(' 授权码（请连同下方说明一起发给买家）');
  console.log('════════════════════════════════════════════');
  console.log('');
  console.log('  ' + L.prettyKey(key));
  console.log('');
  console.log('────────────────────────────────────────────');
  console.log('  授权类型：程序级授权（全部功能 · 不绑定网站）');
  console.log('  有效期至：' + expireText);
  console.log('  客户编号：' + customer + (args.note ? '（' + args.note + '）' : ''));
  if (args.secret) console.log('  ⚠️ 本次使用了自定义密钥，买家必须安装用同一密钥打包的版本');
  console.log('────────────────────────────────────────────');
  console.log('');
  console.log('【转发给买家的话术】');
  console.log('  您的授权码：' + L.prettyKey(key));
  console.log('  使用方法：安装插件后打开学习网站，页面右下角会弹出');
  console.log('  「🔒 插件未授权」卡片，把授权码粘贴进去点「激活」即可；');
  console.log('  也可以点浏览器工具栏的扩展图标，在弹窗顶部输入激活。');
  console.log('  授权不绑定网站，激活后全部功能可用；并随 Chrome/Edge 账号同步，');
  console.log('  换电脑登录同一账号即可免再激活。');
  console.log('');
}

main();
