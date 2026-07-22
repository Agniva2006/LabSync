/**
 * Setup script to install TensorFlow and Face-API, and create a cross-platform
 * stub for '@tensorflow/tfjs-node' to bypass the complex C++ compiler requirement on Windows.
 * Run: node scripts/setup_tensorflow.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const pkgPath = path.join(__dirname, '../package.json');
const pkgBakPath = path.join(__dirname, '../package.json.bak');

console.log('⏳ Bypassing native compile to install TensorFlow.js and Face-API...');

try {
  // 1. Backup package.json
  const pkgData = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  fs.writeFileSync(pkgBakPath, JSON.stringify(pkgData, null, 2));

  // 2. Temporarily strip canvas and sharp
  const targetDeps = { ...pkgData.dependencies };
  delete targetDeps['canvas'];
  delete targetDeps['sharp'];
  
  const tempPkgData = {
    ...pkgData,
    dependencies: targetDeps,
    scripts: {
      ...pkgData.scripts,
      postinstall: 'echo "Skipping native postinstall"'
    }
  };
  fs.writeFileSync(pkgPath, JSON.stringify(tempPkgData, null, 2));

  // 3. Install tfjs and face-api
  console.log('📦 Running npm install for @tensorflow/tfjs and @vladmandic/face-api...');
  execSync('npm install @tensorflow/tfjs@4.11.0 @vladmandic/face-api@1.7.13 --no-audit --no-fund', {
    stdio: 'inherit',
    cwd: path.join(__dirname, '..')
  });

  // 4. Create the @tensorflow/tfjs-node directory stub
  const stubDir = path.join(__dirname, '../node_modules/@tensorflow/tfjs-node');
  if (!fs.existsSync(stubDir)) {
    fs.mkdirSync(stubDir, { recursive: true });
  }

  // 5. Write the index.js file redirecting to tfjs
  const stubFile = path.join(stubDir, 'index.js');
  fs.writeFileSync(stubFile, 'module.exports = require("@tensorflow/tfjs");\n', 'utf8');

  console.log('✅ Successfully created cross-platform @tensorflow/tfjs-node stub.');

} catch (error) {
  console.error('❌ Setup failed:', error.message);
} finally {
  // 6. Restore original package.json
  if (fs.existsSync(pkgBakPath)) {
    fs.copyFileSync(pkgBakPath, pkgPath);
    fs.unlinkSync(pkgBakPath);
    console.log('🔄 Restored original package.json.');
  }
}
