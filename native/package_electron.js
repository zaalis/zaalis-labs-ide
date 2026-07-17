'use strict';

const fs = require('fs');
const path = require('path');
const packagerModule = require('@electron/packager');

const packager = packagerModule.packager || packagerModule.default || packagerModule;
const PRODUCT_NAME = 'zaalis IDE';
const EXECUTABLE_NAME = 'zaalis-ide';

function usage() {
  console.error('Usage: node native/package_electron.js <linux|darwin> <x64|arm64> <source-dist> <final-dist>');
  process.exit(1);
}

function copyDir(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

async function main() {
  const [platform, arch, sourceDistArg, finalDistArg] = process.argv.slice(2);
  if (!platform || !arch || !sourceDistArg || !finalDistArg) usage();

  const root = path.resolve(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const electronSource = path.join(root, 'native', 'electron');
  const sourceDist = path.resolve(root, sourceDistArg);
  const finalDist = path.resolve(root, finalDistArg);
  const buildOut = path.join(root, 'native', '.electron-build', `${platform}-${arch}`);
  const iconPath = platform === 'darwin'
    ? path.join(root, 'native', 'image', 'logo-zaalis.icns')
    : path.join(root, 'native', 'image', 'logo-zaalis.png');

  if (!fs.existsSync(sourceDist)) throw new Error(`Missing source dist: ${sourceDist}`);
  if (!fs.existsSync(iconPath)) throw new Error(`Missing Electron icon: ${iconPath}`);

  fs.rmSync(buildOut, { recursive: true, force: true });
  fs.rmSync(finalDist, { recursive: true, force: true });
  fs.mkdirSync(buildOut, { recursive: true });

  const packagedPaths = await packager({
    dir: electronSource,
    name: PRODUCT_NAME,
    platform,
    arch,
    out: buildOut,
    overwrite: true,
    executableName: EXECUTABLE_NAME,
    appVersion: pkg.version,
    buildVersion: pkg.version,
    appBundleId: 'fr.zaalis.ide',
    appCategoryType: 'public.app-category.developer-tools',
    icon: iconPath,
    asar: false,
    prune: true,
    quiet: true,
    extendInfo: platform === 'darwin' ? {
      CFBundleName: PRODUCT_NAME,
      CFBundleDisplayName: PRODUCT_NAME,
      CFBundleIdentifier: 'fr.zaalis.ide',
      NSHighResolutionCapable: true,
    } : undefined,
  });

  const packagedRoot = packagedPaths && packagedPaths[0]
    ? packagedPaths[0]
    : path.join(buildOut, `${PRODUCT_NAME}-${platform}-${arch}`);
  if (!fs.existsSync(packagedRoot)) {
    throw new Error(`Electron packager output not found: ${packagedRoot}`);
  }

  copyDir(packagedRoot, finalDist);

  const appResourceRoot = platform === 'darwin'
    ? path.join(finalDist, `${PRODUCT_NAME}.app`, 'Contents', 'Resources', 'app')
    : path.join(finalDist, 'resources', 'app');
  const bundleDir = path.join(appResourceRoot, 'bundle');

  fs.rmSync(bundleDir, { recursive: true, force: true });
  fs.mkdirSync(bundleDir, { recursive: true });

  copyFile(path.join(sourceDist, 'zaalis-server'), path.join(bundleDir, 'zaalis-server'));
  copyFile(path.join(sourceDist, 'bin', 'zaalis'), path.join(bundleDir, 'bin', 'zaalis'));
  if (fs.existsSync(path.join(sourceDist, 'node_modules'))) {
    copyDir(path.join(sourceDist, 'node_modules'), path.join(bundleDir, 'node_modules'));
  }
  copyDir(path.join(sourceDist, 'interface'), path.join(bundleDir, 'interface'));
  if (fs.existsSync(path.join(sourceDist, 'image'))) {
    copyDir(path.join(sourceDist, 'image'), path.join(bundleDir, 'image'));
  }
  copyFile(path.join(root, 'package.json'), path.join(bundleDir, 'package.json'));

  if (fs.existsSync(path.join(root, 'README_LINUX.md'))) {
    copyFile(path.join(root, 'README_LINUX.md'), path.join(bundleDir, 'README.txt'));
  } else if (fs.existsSync(path.join(root, 'README_MACOS.md'))) {
    copyFile(path.join(root, 'README_MACOS.md'), path.join(bundleDir, 'README.txt'));
  }

  const pngIcon = path.join(root, 'native', 'image', 'logo-zaalis.png');
  const icnsIcon = path.join(root, 'native', 'image', 'logo-zaalis.icns');
  if (fs.existsSync(pngIcon)) copyFile(pngIcon, path.join(bundleDir, 'image', 'logo-zaalis.png'));
  if (fs.existsSync(icnsIcon)) copyFile(icnsIcon, path.join(bundleDir, 'image', 'logo-zaalis.icns'));

  console.log(`Electron ${platform}-${arch} app written to ${finalDist}`);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
