'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const runtime=require('../platform-runtime');
test('packaged data paths preserve Windows and isolate macOS/Linux user stores',()=>{
 assert.equal(runtime.dataDir('C:\\app',true,'win32',{LOCALAPPDATA:'C:\\Users\\sample\\AppData\\Local'},'C:\\Users\\sample'),'C:\\Users\\sample\\AppData\\Local\\zaalis\\server-data');
 assert.equal(runtime.dataDir('/app',true,'darwin',{},'/Users/sample'),'/Users/sample/Library/Application Support/zaalis/server-data');
 assert.equal(runtime.dataDir('/app',true,'linux',{XDG_DATA_HOME:'/data'},'/home/sample'),'/data/zaalis/server-data');
 assert.equal(runtime.dataDir('/app',false,'linux',{},'/home/sample'),'/app/server-data');
});
test('POSIX PATH preserves custom tools and adds Homebrew without duplicates',()=>{
 const env=runtime.environment('darwin',{PATH:'/bin:/custom:/bin',EXAMPLE:'kept'},'/Users/sample');assert.equal(env.EXAMPLE,'kept');assert.equal(env.PATH.split(':').filter(p=>p==='/bin').length,1);assert.ok(env.PATH.includes('/opt/homebrew/bin'));
 assert.equal(runtime.environment('win32',{PATH:'C:\\Tools;C:\\Windows'}).PATH,'C:\\Tools;C:\\Windows');
});
test('GGUF variants and assets target the current platform and architecture',()=>{
 assert.equal(runtime.normalizeEngine('cuda','darwin'),'metal');assert.equal(runtime.normalizeEngine('cpu','darwin'),'cpu');assert.equal(runtime.normalizeEngine('metal','linux'),'vulkan');assert.equal(runtime.normalizeEngine('rocm','win32','cuda'),'cuda');
 assert.match(runtime.engineAssets('b9690','metal','darwin','arm64')[0],/macos-arm64\.tar\.gz$/);assert.match(runtime.engineAssets('b9690','rocm','linux','x64')[0],/ubuntu-rocm-7\.2-x64\.tar\.gz$/);assert.throws(()=>runtime.engineAssets('b9690','cpu','linux','arm64'),/x64/);
});
test('updater selects compatible assets and refuses a package from another OS',()=>{
 assert.equal(runtime.updateAsset('zaalis-macos-arm64.dmg','darwin','arm64'),true);assert.equal(runtime.updateAsset('zaalis-macos-x64.dmg','darwin','arm64'),false);assert.equal(runtime.updateAsset('zaalis-linux-x64.deb','linux'),true);
 assert.equal(runtime.updateExtension('https://github.com/a/b/releases/download/v1/app.AppImage','linux'),'.AppImage');assert.throws(()=>runtime.updateExtension('https://github.com/a/b/app.exe','darwin'),/plateforme/);
});
test('Linux updater quotes paths and preserves interactive fallback',()=>{
 const script=runtime.linuxUpdateScript("/tmp/package's file.deb",'/tmp/work/runner.sh','/tmp/work/log','/opt/zaalis/zaalis-ide');assert.ok(script.includes("package'\\''s file.deb"));assert.ok(script.includes('pkexec env DEBIAN_FRONTEND=noninteractive'));assert.ok(script.includes('xdg-open'));assert.ok(!script.includes('\r'));assert.ok(script.includes('setsid'));
 const image=runtime.linuxUpdateScript('/tmp/app.AppImage','/tmp/runner','/tmp/log','/opt/app.AppImage','/opt/app.AppImage');assert.ok(image.includes("cp -f '/tmp/app.AppImage' '/opt/app.AppImage'"));assert.ok(!image.includes('pkexec'));
});
