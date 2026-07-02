#!/usr/bin/env node

// Packages the built plugin (dist/) into a versioned .zip suitable for
// uploading in SuperProductivity: Settings > Plugins > Load Plugin.

const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const ROOT_DIR = path.join(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const MANIFEST_PATH = path.join(ROOT_DIR, 'src', 'manifest.json');

function packagePlugin() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error('manifest.json not found in src/');
  }
  if (!fs.existsSync(DIST_DIR)) {
    throw new Error('dist folder not found. Run "npm run build" first.');
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const outputFileName = `${manifest.id}-v${manifest.version}.zip`;
  const outputPath = path.join(ROOT_DIR, outputFileName);
  const output = fs.createWriteStream(outputPath);
  const archive = archiver('zip', { zlib: { level: 9 } });

  output.on('close', () => {
    console.log(
      `✅ Plugin packaged: ${outputFileName} (${(archive.pointer() / 1024).toFixed(2)} KB)`,
    );
    console.log(`   ${outputPath}`);
  });

  archive.on('error', (err) => {
    throw err;
  });

  archive.pipe(output);
  // Add all built files (plugin.js, manifest.json, index.html, icon.svg)
  // at the zip root (false = do not nest under a "dist" folder).
  archive.directory(DIST_DIR, false);

  return archive.finalize();
}

packagePlugin().catch((err) => {
  console.error('Packaging failed:', err);
  process.exit(1);
});
