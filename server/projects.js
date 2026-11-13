import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { unzipSync, zipSync } from 'fflate';
import { planScaffold } from '../web/js/scaffold.js';
import { projectPath, StorageError } from './store.js';

const addon = ['plugin.cfg', 'plugin.gd', 'runner/gwe_runner.gd', 'runner/cli.gd', 'runner/runner_scene.gd', 'runner/runner.tscn'];
export async function prepareProject(name, files = new Map()) {
  const bridgeFiles = await Promise.all(addon.map(async (path) => ({
    path: `addons/web_editor_bridge/${path}`,
    bytes: await readFile(fileURLToPath(new URL(`../web/addon/web_editor_bridge/${path}`, import.meta.url))),
  })));
  const local = new Map([...files].map(([path, bytes]) => [path, { bytes }]));
  for (const file of planScaffold(local, { projectName: name, bridgeFiles, installBridge: true })) files.set(file.path, Buffer.from(file.bytes));
  return files;
}

export function importZip(bytes) {
  let total = 0;
  const archive = unzipSync(bytes, { filter: (file) => {
    total += file.originalSize;
    if (total > 512 * 1024 * 1024) throw new StorageError(413, 'archive_limit', '解压后的项目不能超过 512 MiB');
    return !file.name.endsWith('/');
  } });
  const configs = Object.keys(archive).filter((path) => path === 'project.godot' || path.endsWith('/project.godot'));
  if (configs.length !== 1) throw new StorageError(400, 'archive_project', 'ZIP 必须包含一个 Godot 项目');
  const prefix = configs[0].slice(0, -'project.godot'.length);
  const files = new Map();
  for (const [entry, content] of Object.entries(archive)) {
    if (!entry.startsWith(prefix)) continue;
    const path = entry.slice(prefix.length);
    if (path.split('/').some((part) => part === '.godot' || part === '.git')) continue;
    files.set(projectPath.parse(path), Buffer.from(content));
  }
  return files;
}

export function exportZip(store, snapshot) {
  return Buffer.from(zipSync(Object.fromEntries(snapshot.files.map((file) => [file.path, store.blob(file.hash)]))));
}
