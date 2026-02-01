import path from 'node:path';
import fsp from 'node:fs/promises';

export async function atomicSwapDirs(opts: {
  htmlDir: string;
  stagingDir: string;
  archiveDir: string;
  id: string;
}): Promise<{ archivedPath: string }> {
  const { htmlDir, stagingDir, archiveDir, id } = opts;

  await fsp.mkdir(path.dirname(htmlDir), { recursive: true });
  await fsp.mkdir(archiveDir, { recursive: true });

  try {
    const st = await fsp.stat(htmlDir);
    if (!st.isDirectory()) throw new Error(`${htmlDir} is not a directory`);
  } catch {
    await fsp.mkdir(htmlDir, { recursive: true });
  }

  const backupDir = path.join(path.dirname(htmlDir), `.html-backup-${id}`);
  const archivedPath = path.join(archiveDir, id);

  try {
    await fsp.rename(htmlDir, backupDir);
    await fsp.rename(stagingDir, htmlDir);
    await fsp.rename(backupDir, archivedPath);
    return { archivedPath };
  } catch (e) {
    try {
      const failedDir = path.join(path.dirname(htmlDir), `.html-failed-${id}`);
      try { await fsp.rename(htmlDir, failedDir); } catch {}
      try { await fsp.rename(backupDir, htmlDir); } catch {}
      try { await fsp.rm(failedDir, { recursive: true, force: true }); } catch {}
    } catch {}
    throw e;
  }
}
