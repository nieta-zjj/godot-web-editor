import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { unzipSync } from 'fflate';
import { readFile, writeFile } from 'node:fs/promises';

export const VERSION = '4.7.2';
const SHA256 = '5e6904f3b8b6ac642a3ad3893396427c3a31581e5345a3fdc93b3c64575232a4';
const root = fileURLToPath(new URL('../', import.meta.url));
const cache = join(root, '.cache');
const zip = join(cache, `Godot_v${VERSION}-stable_web_editor.zip`);
const directory = join(cache, 'engine');
const files = ['godot.editor.js', 'godot.editor.wasm', 'godot.editor.audio.worklet.js', 'godot.editor.audio.position.worklet.js', 'favicon.png'];

await mkdir(cache, { recursive: true });
if (!(await access(zip).then(() => true, () => false))) {
  const response = await fetch(`https://github.com/godotengine/godot/releases/download/${VERSION}-stable/Godot_v${VERSION}-stable_web_editor.zip`);
  if (!response.ok) throw new Error(`Godot 下载失败：${response.status}`);
  await pipeline(response.body, createWriteStream(`${zip}.part`));
  await rename(`${zip}.part`, zip);
}
const hash = createHash('sha256');
for await (const chunk of createReadStream(zip)) hash.update(chunk);
if (hash.digest('hex') !== SHA256) throw new Error('Godot 发行包校验失败，请删除损坏的缓存文件');
const archive = unzipSync(await readFile(zip), { filter: (entry) => files.includes(entry.name) });
await mkdir(directory, { recursive: true });
for (const name of files) {
  if (!archive[name]) throw new Error(`Godot 发行包缺少 ${name}`);
  await writeFile(join(directory, name), archive[name]);
}
console.log(`Godot ${VERSION} 引擎已准备完成：${directory}`);
