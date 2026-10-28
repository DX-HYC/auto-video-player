// 静态自检：商业授权体系（license.js 算法单测 + content.js 集成断言）
// 覆盖：SHA-256 标准向量 / base32 往返 / 授权码生成-校验全路径 /
//       程序级授权（任何域名均放行、旧带域名码同样全站有效）/ 篡改 / 过期 /
//       永久 / 格式错误 / content.js 授权闸门与"无特征不启动"的源码级断言
const fs = require('fs');
const path = require('path');
const L = require(path.join(__dirname, '..', 'license.js'));
const src = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = got === want;
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name + ' → ' + got + '（期望 ' + want + '）');
  ok ? pass++ : fail++;
}
function checkTrue(name, cond) { check(name, !!cond, true); }

const SECRET = L.SIGN_SECRET;
const enc = (s) => new TextEncoder().encode(s);
const hex = (b) => Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
const NOW = Date.now();

console.log('== SHA-256 实现正确性（FIPS 180-4 标准向量） ==');
check('sha256("abc")', hex(L.sha256(enc('abc'))),
  'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
check('sha256("")', hex(L.sha256(new Uint8Array(0))),
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
check('sha256(56字节)', hex(L.sha256(enc('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))),
  '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');

console.log('\n== base32 往返 ==');
{
  const bytes = enc('{"v":1,"x":0,"c":"CUST-001","n":""}');
  const rt = L.b32ToBytes(L.bytesToB32(bytes));
  check('base32 往返长度', rt.length, bytes.length);
  check('base32 往返内容', hex(rt), hex(bytes));
}

console.log('\n== 程序级授权全路径（v2.1.1：不绑定域名/平台） ==');
{
  const exp = Math.floor(NOW / 1000) + 365 * 86400;
  const key = L.makeKey({ expire: exp, customer: 'CUST-001', note: '测试' }, SECRET);

  // 核心语义：同一授权码在任意网站都有效
  check('有效码 · jxnu.edu.cn', L.verifyLicense(key, 'zjpt-web.jxnu.edu.cn', NOW).ok, true);
  check('有效码 · webtrn.cn（网梯）', L.verifyLicense(key, 'www.webtrn.cn', NOW).ok, true);
  check('有效码 · 任意第三方网站', L.verifyLicense(key, 'bilibili.com', NOW).ok, true);
  check('有效码 · 无域名上下文（popup 预检）', L.verifyLicense(key, '', NOW).ok, true);
  check('有效码 · payload 不含域名字段', L.verifyLicense(key, 'jxnu.edu.cn', NOW).payload.h, undefined);
  check('有效码 · 客户号解析', L.verifyLicense(key, 'jxnu.edu.cn', NOW).payload.c, 'CUST-001');
  check('有效码 · 有效期解析', L.verifyLicense(key, 'jxnu.edu.cn', NOW).payload.x, exp);
  check('有效码 · 输入容错（小写+空格+连字符）',
    L.verifyLicense(key.toLowerCase().replace(/(.{5})/g, '$1 '), 'jxnu.edu.cn', NOW).ok, true);
  check('有效码 · normalizeKey 去杂质',
    L.normalizeKey(' avp1f-ch7c8-ht64p ') === L.normalizeKey('AVP1FCH7C8HT64P'), true);

  // 旧版（v2.1.1 之前）签发的"带域名"授权码：签名仍有效，且不再受域名限制
  const legacy = L.makeKey({ domains: 'jxnu.edu.cn', expire: exp, customer: 'OLD-001' }, SECRET);
  check('旧带域名码 · 原绑定域名仍有效', L.verifyLicense(legacy, 'jxnu.edu.cn', NOW).ok, true);
  check('旧带域名码 · 换到其他网站也有效（不再域限）', L.verifyLicense(legacy, 'example.com', NOW).ok, true);

  // 篡改 payload 一个字符 → 签名必须失配
  const bad = key.slice(0, 30) + (key[30] === 'A' ? 'B' : 'A') + key.slice(31);
  check('篡改授权码', L.verifyLicense(bad, 'jxnu.edu.cn', NOW).reason, 'signature');

  // 伪造：用错误密钥签的码
  const forged = L.makeKey({ expire: exp, customer: 'HACK', note: '' }, 'wrong-secret');
  check('错误密钥伪造', L.verifyLicense(forged, 'jxnu.edu.cn', NOW).reason, 'signature');

  // 过期
  const expired = L.makeKey({ expire: Math.floor(NOW / 1000) - 10, customer: 'CUST-002' }, SECRET);
  const st = L.verifyLicense(expired, 'jxnu.edu.cn', NOW);
  check('过期码', st.reason, 'expired');
  check('过期码 · 提示含续期引导', /续期/.test(st.msg), true);

  // 永久
  const forever = L.makeKey({ expire: 0, customer: 'CUST-002' }, SECRET);
  check('永久码 · 5 年后仍有效', L.verifyLicense(forever, 'jxnu.edu.cn', NOW + 5 * 365 * 86400 * 1000).ok, true);

  // 格式错误
  check('空授权码', L.verifyLicense('', 'jxnu.edu.cn', NOW).reason, 'format');
  check('无前缀', L.verifyLicense('XXXXXYYYYYZZZZZ', 'jxnu.edu.cn', NOW).reason, 'format');
  check('过短', L.verifyLicense('AVP1ABC', 'jxnu.edu.cn', NOW).reason, 'format');
  check('垃圾串', L.verifyLicense('你好世界测试测试', 'jxnu.edu.cn', NOW).reason, 'format');

  // 版本过旧：手搓 v=2 payload + 正确签名
  const oldBody = L.bytesToB32(enc(JSON.stringify({ v: 2, x: 0, c: 'X', n: '' })));
  const oldSig = L.bytesToB32(L.hmacSha256(enc(SECRET), enc(oldBody)).slice(0, 10));
  check('版本过旧', L.verifyLicense('AVP1' + oldBody + oldSig, 'jxnu.edu.cn', NOW).reason, 'version');

  // reasonText 必须带上作者联系方式（"提示用户联系我授权"的硬要求）
  const txt = L.reasonText(L.verifyLicense('', 'jxnu.edu.cn', NOW));
  check('未授权提示含作者名', /胡昱晨/.test(txt), true);
  check('未授权提示含联系方式字段', /联系/.test(txt), true);
}

console.log('\n== content.js 集成断言 ==');
check('manifest · license.js 是第一个 content script',
  manifest.content_scripts[0].js[0], 'license.js');
checkTrue('manifest · content_scripts 不再含 <all_urls>',
  JSON.stringify(manifest.content_scripts).indexOf('all_urls') < 0);
checkTrue('manifest · host_permissions 不再含 <all_urls>',
  JSON.stringify(manifest.host_permissions).indexOf('all_urls') < 0);
check('manifest · 版本', manifest.version, '2.1.2');

checkTrue('授权闸门：init 里先 checkLicense 再 boot',
  /if \(shouldEarlyExit\(\)\)[\s\S]*?checkLicense\(\(\) => \{[\s\S]*?if \(!licenseState \|\| !licenseState\.ok\)[\s\S]*?showLicenseOverlay\(\);[\s\S]*?boot\(\);/.test(src));
checkTrue('未授权只显示提示卡（不启动）',
  /log\('未授权，插件不工作：'[\s\S]*?showLicenseOverlay\(\);[\s\S]*?return;/.test(src));
checkTrue('激活入口 tryActivate 写入 storage 并启动',
  /chrome\.storage\.sync\.set\(\{ licenseKey: licenseKey \}[\s\S]*?if \(!fullStarted\) boot\(\);/.test(src));
checkTrue('授权失效时停手（enterStandby）+ 重新提示',
  /function recheckLicense\(\)[\s\S]*?if \(fullStarted\) enterStandby\('授权失效'\);[\s\S]*?showLicenseOverlay\(\);/.test(src));
checkTrue('授权模块缺失时按未授权处理（商业策略不因缺文件失效）',
  /reason: 'missing'/.test(src));

console.log('\n== 程序级授权在 content.js 的落地 ==');
checkTrue('verifyCurrentLicense 不传域名（程序级授权）',
  /return APLicense\.verifyLicense\(licenseKey, '', Date\.now\(\)\);/.test(src));
checkTrue('tryActivate 不传域名（程序级授权）',
  /function tryActivate\(raw\) \{[\s\S]*?APLicense\.verifyLicense\(raw, '', Date\.now\(\)\)/.test(src));
checkTrue('提示卡已移除"复制域名给作者"行（不再需要域名信息）',
  src.indexOf('ap-lic-host') < 0 && src.indexOf('ap-lic-copy') < 0);
checkTrue('提示卡保留作者联系方式展示',
  /ap-lic-author[\s\S]*?联系方式/.test(src));

console.log('\n== 启动状态机：无播放内容不建面板 ==');
checkTrue('boot 分支：有特征 startFull / 无特征 startProbe',
  /function boot\(\) \{\s*if \(fullStarted\) return;\s*if \(hasPlaybackHints\(\)\) \{ startFull\(\); return; \}\s*startProbe\(\);\s*\}/.test(src));
checkTrue('hasPlaybackHints 覆盖 video / 画布播放器 / 目录 / 白名单 iframe',
  /function hasPlaybackHints\(\)[\s\S]*?iframe\[src\][\s\S]*?isKnownIframeSrc/.test(src));
checkTrue('8 秒无特征进入待命',
  /setTimeout\(\(\) => \{ if \(!fullStarted\) enterStandby\(\); \}, PROBE_WINDOW\);/.test(src));
checkTrue('待命保留观察器（之后出现播放内容自动唤醒）',
  /probeMo = new MutationObserver\(\(\) => \{[\s\S]*?if \(hasPlaybackHints\(\)\) startFull\(\);/.test(src));
checkTrue('enterStandby 清定时器/看门狗/面板',
  /function enterStandby\(reason\) \{[\s\S]*?tickTimers\.forEach[\s\S]*?watchdogPingTimer[\s\S]*?mainMo\.disconnect[\s\S]*?apUnregister/.test(src));
checkTrue('startFull 全部定时器纳入 tickTimers（可被统一清理）',
  /tickTimers\.push\(infoTimer\);[\s\S]*?tickTimers\.push\(setInterval\(scanVideos, 2000\)\);/.test(src));

console.log('\n== 待命守卫：standby 后任何通道都不得复活扫描 ==');
checkTrue('看门狗消息在待命期被忽略',
  /apWatchdog'\) \{[\s\S]*?if \(!fullStarted\) return false;/.test(src));
checkTrue('恢复可见在待命期不扫描',
  /visibilitychange[\s\S]*?if \(!fullStarted\) return;\s*setTimeout/.test(src));
checkTrue('window load 回调在待命期不扫描',
  /window\.addEventListener\('load'[\s\S]*?if \(!fullStarted\) return;\s*scanVideos\(\);/.test(src));
checkTrue('SPA 路由变化在待命期不重新扫描',
  /const onChange = \(\) => \{\s*\/\/ 待命期间不响应路由变化[\s\S]*?if \(!fullStarted\) return;/.test(src));

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
