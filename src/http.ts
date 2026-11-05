import { AimHarderError } from './errors.js';

/** Read a bounded (1 MiB) response body as JSON, or as text when requested. */
export async function readResponse(response: Response, textOnly = false): Promise<unknown> {
  if (!response.body) throw new AimHarderError('INVALID_RESPONSE');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1_048_576) throw new AimHarderError('INVALID_RESPONSE');
      chunks.push(value);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    return textOnly ? text : JSON.parse(text) as unknown;
  } catch {
    void reader.cancel().catch(() => undefined);
    throw new AimHarderError('INVALID_RESPONSE');
  } finally {
    reader.releaseLock();
  }
}
