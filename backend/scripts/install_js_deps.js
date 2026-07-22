/**
 * Helper script to install only the pure JS dependencies first,
 * bypassing the compilation errors of 'canvas' and 'sharp' on Windows.
 * Run: node scripts/install_js_deps.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const pkgPath = path.join(__dirname, '../package.json');
const pkgBakPath = path.join(__dirname, '../package.json.bak');

console.log('🔄 Bypassing native compilation: Backing up package.json...');

try {
  // 1. Backup package.json
  const pkgData = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  fs.writeFileSync(pkgBakPath, JSON.stringify(pkgData, null, 2));

  // 2. Remove native modules that require compilation on Windows
  const targetDeps = { ...pkgData.dependencies };
  delete targetDeps['canvas'];
  delete targetDeps['sharp'];
  delete targetDeps['@tensorflow/tfjs'];
  delete targetDeps['@vladmandic/face-api'];

  const tempPkgData = {
    ...pkgData,
    dependencies: targetDeps,
    scripts: {
      ...pkgData.scripts,
      postinstall: 'echo "Skipping native postinstall"'
    }
  };

  fs.writeFileSync(pkgPath, JSON.stringify(tempPkgData, null, 2));
  console.log('📦 Created temporary package.json with pure JS dependencies.');

  // 3. Run npm install
  console.log('⏳ Running npm install...');
  execSync('npm install --no-audit --no-fund', { stdio: 'inherit', cwd: path.join(__dirname, '..') });
  console.log('✅ npm install completed successfully.');

} catch (error) {
  console.error('❌ Installation helper failed:', error.message);
} finally {
  // 4. Restore original package.json
  if (fs.existsSync(pkgBakPath)) {
    fs.copyFileSync(pkgBakPath, pkgPath);
    fs.unlinkSync(pkgBakPath);
    console.log('🔄 Restored original package.json.');
  }
}
