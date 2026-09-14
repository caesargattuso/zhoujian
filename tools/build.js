#!/usr/bin/env node
/*
 * 一键打包 Windows 便携版。
 *
 *   node tools/build.js                # 输出到 release/
 *   node tools/build.js --out=dist-out # 指定输出目录
 *   node tools/build.js --no-kill      # 不动正在运行的实例
 *
 * 处理了两件在国内网络 + 非管理员 Windows 上必踩的事：
 *   1. 镜像：electron 与 electron-builder 的二进制默认从 GitHub 拉，这里改走 npmmirror
 *   2. winCodeSign 解压失败：包里 darwin/ 下有 .dylib 符号链接，
 *      非管理员账户建不了 symlink，7za 会退非零码导致构建中止。
 *      这里预先把缓存解压好（排除 darwin），让 electron-builder 直接复用。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const argOf = (k, d) => { const a = argv.find(x => x.startsWith('--' + k + '=')); return a ? a.split('=')[1] : d; };
const OUT = argOf('out', 'release');
const CACHE = path.join(ROOT, '.builder-cache');
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/* ── 1. 结束残留实例（否则 win-unpacked 里的文件会被锁住） ── */
if (!argv.includes('--no-kill')) {
  for (const name of ['ZhouJian.exe', 'electron.exe', 'app-builder.exe', '7za.exe']) {
    const r = spawnSync('taskkill', ['/IM', name, '/F'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    if (r.status === 0) console.log('已结束 ' + name);
  }
  sleep(1200);
}

/* ── 2. 准备 winCodeSign 缓存 ── */
function ensureWinCodeSign() {
  const dir = path.join(CACHE, 'winCodeSign');
  const target = path.join(dir, 'winCodeSign-2.6.0');
  if (fs.existsSync(path.join(target, 'rcedit-x64.exe'))) { console.log('winCodeSign 缓存已就绪'); return; }
  const zips = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^winCodeSign-2\.6\.0.*\.7z$/.test(f)) : [];
  if (!zips.length) { console.log('winCodeSign 缓存缺失，交给 electron-builder 自行下载'); return; }
  const sevenZip = path.join(ROOT, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');
  if (!fs.existsSync(sevenZip)) { console.log('找不到 7za.exe，跳过缓存预热'); return; }
  fs.mkdirSync(target, { recursive: true });
  console.log('预热 winCodeSign 缓存（排除 darwin 符号链接）…');
  try {
    execFileSync(sevenZip, ['x', path.join(dir, zips[0]), '-o' + target, '-x!darwin', '-y', '-bd', '-snl-'],
      { encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { /* 符号链接警告可忽略，下面检查关键文件 */ }
  console.log(fs.existsSync(path.join(target, 'rcedit-x64.exe')) ? '  缓存就绪' : '  预热失败，构建可能仍会尝试下载');
}
ensureWinCodeSign();

/* ── 3. 打包 ── */
const env = Object.assign({}, process.env, {
  ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npmmirror.com/mirrors/electron-builder-binaries/',
  ELECTRON_BUILDER_CACHE: CACHE,
  USE_HARD_LINKS: 'false',              // 跨盘/受限环境下硬链接容易失败
  CSC_IDENTITY_AUTO_DISCOVERY: 'false'  // 不做代码签名
});
delete env.ELECTRON_RUN_AS_NODE;

const cli = path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js');
if (!fs.existsSync(cli)) { console.log('未安装依赖，请先 npm install'); process.exit(1); }

console.log('开始打包，输出到 ' + OUT + '/ …');
try {
  const out = execFileSync(process.execPath,
    [cli, '--win', 'portable', '--x64', '--publish', 'never', '--config.directories.output=' + OUT],
    { cwd: ROOT, env, encoding: 'utf8', timeout: 1800000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  console.log(out);
} catch (e) {
  console.log('打包失败 code=' + e.status);
  console.log((((e.stdout || '') + (e.stderr || '')).toString()).slice(-4000));
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const artifact = path.join(ROOT, OUT, '周笺-' + pkg.version + '-便携版.exe');
console.log('\n完成：' + artifact);
if (fs.existsSync(artifact)) console.log('体积：' + (fs.statSync(artifact).size / 1048576).toFixed(1) + 'MB');
