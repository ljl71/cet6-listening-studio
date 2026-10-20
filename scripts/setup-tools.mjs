import { mkdir, stat, writeFile, readdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const runtime = path.join(root, 'runtime');
await mkdir(runtime, { recursive: true });

async function download(url, destination) {
  try { if ((await stat(destination)).size > 1000) return; } catch {}
  console.log(`下载 ${new URL(url).hostname} → ${path.basename(destination)}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(600000), headers: { 'User-Agent': 'CET6-Local-Study/0.1' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  const part = `${destination}.part`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(part));
  const { rename } = await import('node:fs/promises');
  await rename(part, destination);
  const bytes = await readFile(destination);
  await writeFile(`${destination}.source.json`, JSON.stringify({ url: response.url, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), downloadedAt: new Date().toISOString() }, null, 2));
  console.log(`已下载 ${path.basename(destination)} (${(bytes.length / 1048576).toFixed(1)} MB)`);
}

function expand(archive, destination) {
  const python = process.env.CET6_PYTHON || path.join(process.env.USERPROFILE, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe');
  const script = 'import sys,zipfile,pathlib; z=zipfile.ZipFile(sys.argv[1]); target=pathlib.Path(sys.argv[2]).resolve(); assert all(pathlib.Path(target, x.filename).resolve().is_relative_to(target) for x in z.infolist()), "Unsafe archive path"; z.extractall(target)';
  execFileSync(python, ['-c', script, archive, destination], { stdio: 'inherit', windowsHide: true });
}

async function find(name, directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.name.toLowerCase() === name.toLowerCase()) return full;
    if (entry.isDirectory()) { const nested = await find(name, full); if (nested) return nested; }
  }
}

const mode = process.argv[2] || 'ffmpeg';
if (mode === 'ffmpeg') {
  const archive = path.join(runtime, 'ffmpeg-essentials.zip');
  const destination = path.join(runtime, 'ffmpeg');
  let ffmpeg = await find('ffmpeg.exe', runtime);
  if (!ffmpeg) {
    await download('https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip', archive);
    expand(archive, destination);
    ffmpeg = await find('ffmpeg.exe', destination);
  }
  const ffprobe = await find('ffprobe.exe', destination);
  await writeFile(path.join(runtime, 'media-tools.json'), JSON.stringify({ ffmpeg, ffprobe }, null, 2));
  console.log(JSON.stringify({ ffmpeg, ffprobe }));
} else if (mode === 'whisper' || mode === 'whisper-tiny') {
  const destination = path.join(runtime, 'whisper');
  let whisper = await find('whisper-cli.exe', runtime);
  if (!whisper) {
    const response = await fetch('https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest', { headers: { 'User-Agent': 'CET6-Local-Study/0.1' } });
    if (!response.ok) throw new Error(`Whisper release HTTP ${response.status}`);
    let release = await response.json();
    if (!release.assets.some(x => x.name === 'whisper-bin-x64.zip')) {
      const list = await fetch('https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=30', { headers: { 'User-Agent': 'CET6-Local-Study/0.1' } });
      if (!list.ok) throw new Error(`Whisper releases HTTP ${list.status}`);
      release = (await list.json()).find(x => !x.prerelease && /^v/.test(x.tag_name) && x.assets.some(a => a.name === 'whisper-bin-x64.zip'));
    }
    const asset = release?.assets.find(x => x.name === 'whisper-bin-x64.zip');
    if (!asset) throw new Error('官方发行版缺少 whisper-bin-x64.zip');
    const archive = path.join(runtime, asset.name);
    await download(asset.browser_download_url, archive);
    expand(archive, destination);
    whisper = await find('whisper-cli.exe', destination);
  }
  const modelName = mode === 'whisper-tiny' ? 'tiny.en' : 'base.en';
  const model = path.join(runtime, `ggml-${modelName}.bin`);
  await download(`https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${modelName}.bin`, model);
  await writeFile(path.join(runtime, mode === 'whisper-tiny' ? 'speech-tools-tiny.json' : 'speech-tools.json'), JSON.stringify({ whisper, model }, null, 2));
  console.log(JSON.stringify({ whisper, model }));
} else throw new Error('用法: node scripts/setup-tools.mjs ffmpeg|whisper|whisper-tiny');
