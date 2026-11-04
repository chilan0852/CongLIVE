import { mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';

export async function register({ hooks, logger, dataDir }) {
  const outputDir = path.join(dataDir, 'plugins', 'stream-audit');
  const outputFile = path.join(outputDir, 'events.ndjson');
  await mkdir(outputDir, { recursive: true });

  const record = async (event, payload = {}) => {
    const row = {
      at: new Date().toISOString(),
      event,
      streamId: payload.stream?.id ?? null,
      title: payload.stream?.title ?? null,
      userId: payload.user?.id ?? payload.stream?.userId ?? null,
      username: payload.user?.username ?? payload.stream?.username ?? null,
    };
    await appendFile(outputFile, `${JSON.stringify(row)}\n`, { encoding: 'utf8', mode: 0o600 });
    logger.info(`[stream-audit] ${event} stream=${row.streamId ?? 'unknown'}`);
  };

  hooks.on('stream.created', (payload) => record('stream.created', payload));
  hooks.on('stream.published', (payload) => record('stream.published', payload));
  hooks.on('stream.unpublished', (payload) => record('stream.unpublished', payload));
}
