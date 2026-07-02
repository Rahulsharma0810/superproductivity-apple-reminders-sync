#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT_DIR = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT_DIR, 'src');

const watchDirs = [
  path.join(SRC_DIR, 'background'),
  path.join(SRC_DIR, 'shared'),
  path.join(SRC_DIR, 'ui'),
];

const watchFiles = [path.join(SRC_DIR, 'manifest.json')];

let buildTimeout = null;
let isBuilding = false;

function log(message, color = '') {
  const colors = {
    cyan: '\x1b[36m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    reset: '\x1b[0m',
  };

  const prefix = color ? colors[color] : '';
  const suffix = color ? colors.reset : '';
  const timestamp = new Date().toLocaleTimeString();

  console.log(`[${timestamp}] ${prefix}${message}${suffix}`);
}

async function runBuild() {
  if (isBuilding) {
    log('Build already in progress, queuing next build...', 'yellow');
    return;
  }

  isBuilding = true;
  log('Building plugin...', 'cyan');

  try {
    execSync('npm run build', { cwd: ROOT_DIR, stdio: 'inherit' });
    log('✓ Build complete', 'green');
  } catch (error) {
    log(`✗ Build failed: ${error.message}`, 'red');
  } finally {
    isBuilding = false;
  }
}

function scheduleBuild() {
  if (buildTimeout) {
    clearTimeout(buildTimeout);
  }

  buildTimeout = setTimeout(() => {
    runBuild();
  }, 300);
}

function watchFile(filePath) {
  fs.watch(filePath, (eventType) => {
    if (eventType === 'change') {
      log(`File changed: ${path.relative(ROOT_DIR, filePath)}`, 'yellow');
      scheduleBuild();
    }
  });
}

function watchDirectory(dirPath) {
  if (!fs.existsSync(dirPath)) {
    log(`Directory not found: ${dirPath}`, 'red');
    return;
  }

  fs.watch(dirPath, (eventType, filename) => {
    if (filename && (filename.endsWith('.ts') || filename.endsWith('.js'))) {
      log(
        `File changed: ${path.join(path.relative(ROOT_DIR, dirPath), filename)}`,
        'yellow',
      );
      scheduleBuild();
    }
  });

  fs.readdirSync(dirPath).forEach((file) => {
    const filePath = path.join(dirPath, file);
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      watchDirectory(filePath);
    } else if (file.endsWith('.ts') || file.endsWith('.js')) {
      watchFile(filePath);
    }
  });
}

function startWatcher() {
  log('Starting file watcher for sync-reminders plugin...', 'cyan');
  log(
    `Watching directories: ${watchDirs.map((d) => path.relative(ROOT_DIR, d)).join(', ')}`,
    'cyan',
  );

  runBuild().then(() => {
    watchDirs.forEach((dir) => {
      watchDirectory(dir);
    });

    watchFiles.forEach((file) => {
      if (fs.existsSync(file)) {
        watchFile(file);
      }
    });

    const indexHtml = path.join(SRC_DIR, 'ui', 'index.html');
    if (fs.existsSync(indexHtml)) {
      watchFile(indexHtml);
    }

    log('Watching for changes... (Press Ctrl+C to exit)', 'green');
  });
}

process.on('SIGINT', () => {
  log('\nStopping watcher...', 'yellow');
  process.exit(0);
});

startWatcher();
