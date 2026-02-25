const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function gzipFile(srcPath, destPath) {
  const data = fs.readFileSync(srcPath);
  const gz = zlib.gzipSync(data, { level: zlib.constants.Z_BEST_COMPRESSION });
  fs.writeFileSync(destPath, gz);
  console.log(`gzipped ${path.basename(srcPath)} -> ${path.basename(destPath)}`);
}

function gzipAllJsonInDistData() {
  const distDataDir = path.resolve(__dirname, '..', 'dist', 'data');
  if (!fs.existsSync(distDataDir)) {
    console.warn('dist/data directory not found; nothing to gzip');
    return;
  }
  const files = fs.readdirSync(distDataDir);
  files.forEach((f) => {
    if (!f.toLowerCase().endsWith('.json')) return;
    const src = path.join(distDataDir, f);
    const dest = src + '.gz';
    try {
      gzipFile(src, dest);
    } catch (err) {
      console.warn(`Failed to gzip ${f}:`, err.message || err);
    }
  });
}

gzipAllJsonInDistData();
