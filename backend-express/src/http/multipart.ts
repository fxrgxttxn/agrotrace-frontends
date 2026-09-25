/**
 * `multipart/form-data` uploads with exactly one file part `file` (contract ImageUpload / LogoUpload / ProtocolUpload /
 * ImportUpload: `required: [file]`, `additionalProperties: false`). The body is streamed through busboy; the file's
 * bytes are counted while they arrive and the limit is inclusive (spec 8.6: size ≤ maxBytes is accepted) — past it
 * the rest is read and discarded, so the client always gets the answer, and the whole request is capped at the
 * gateway's body limit.
 *
 * Problems, in this order: 400 VALIDATION for the form (`errors.file: [validation.required]` — no file part, an
 * empty one or not a multipart body at all; `validation.duplicate` — a second `file`; `validation.unknownField` —
 * any other part; `_root: [validation.invalid]` — a malformed multipart body), then 413 FILE_TOO_LARGE
 * `{maxBytes}`. The file name is kept only as `originalName` (never used for the type or the storage key).
 */
import type { Request } from 'express';
import busboy from 'busboy';
import { AppProblem, JSON_BODY_LIMIT_BYTES, validationProblem } from './problem.js';

export interface UploadedFile {
  /** The part's filename as sent (UTF-8). */
  filename: string;
  bytes: Buffer;
}

const FIELD = 'file';

export async function readFileUpload(req: Request, maxBytes: number): Promise<UploadedFile> {
  const type = (req.headers['content-type'] ?? '').toLowerCase();
  if (!type.startsWith('multipart/form-data')) {
    // A JSON body was already consumed by express.json; anything else is left for Node to discard.
    throw validationProblem({ [FIELD]: ['validation.required'] });
  }

  const errors: Record<string, string[]> = {};
  const addError = (field: string, key: string) => {
    const list = (errors[field] ??= []);
    if (!list.includes(key)) list.push(key);
  };
  let file: UploadedFile | null = null;
  const chunks: Buffer[] = [];
  let tooLarge = false;

  let parser: busboy.Busboy;
  try {
    parser = busboy({
      headers: req.headers,
      defParamCharset: 'utf8',
      // One byte past the limit is enough to know the file is too large (the limit itself is inclusive).
      limits: { fileSize: maxBytes + 1, parts: 20, fields: 20, fieldSize: 64 * 1024, headerPairs: 50 },
    });
  } catch {
    // Missing or malformed boundary.
    throw validationProblem({ _root: ['validation.invalid'] });
  }

  await new Promise<void>((resolve, reject) => {
    let total = 0;
    let settled = false;
    const fail = (p: AppProblem) => {
      if (settled) return;
      settled = true;
      req.unpipe(parser);
      req.resume();
      reject(p);
    };
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      // A body beyond the gateway limit (only possible by calling the backend directly) is not read to its end.
      if (total > JSON_BODY_LIMIT_BYTES)
        fail(
          new AppProblem(413, 'FILE_TOO_LARGE', { params: { maxBytes }, headers: { Connection: 'close' } }),
        );
    });

    parser.on('file', (name, stream, info) => {
      if (name !== FIELD) {
        addError(name, 'validation.unknownField');
        stream.resume();
        return;
      }
      if (file !== null) {
        addError(FIELD, 'validation.duplicate');
        stream.resume();
        return;
      }
      file = { filename: info.filename ?? '', bytes: Buffer.alloc(0) };
      let size = 0;
      stream.on('data', (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) tooLarge = true;
        else chunks.push(c);
      });
      // busboy stops at maxBytes + 1 and discards the rest of the part.
      stream.on('limit', () => {
        tooLarge = true;
      });
    });
    parser.on('field', (name) => {
      addError(name, name === FIELD ? 'validation.required' : 'validation.unknownField');
    });
    parser.on('partsLimit', () => addError('_root', 'validation.invalid'));
    parser.on('fieldsLimit', () => addError('_root', 'validation.invalid'));
    parser.on('error', () => fail(validationProblem({ _root: ['validation.invalid'] })));
    parser.on('close', () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    req.on('aborted', () => fail(validationProblem({ _root: ['validation.invalid'] })));
    req.pipe(parser);
  });

  const got = file as UploadedFile | null;
  if (got !== null) got.bytes = Buffer.concat(chunks);
  if (got !== null && errors[FIELD]?.includes('validation.required')) {
    // A text part named `file` next to a real file part: the text part is the extra one.
    errors[FIELD] = errors[FIELD]!.filter((k) => k !== 'validation.required');
    addError(FIELD, 'validation.duplicate');
  }
  if (got === null || (got.bytes.length === 0 && !tooLarge)) addError(FIELD, 'validation.required');
  if (Object.keys(errors).length > 0) throw validationProblem(errors);
  if (tooLarge) throw new AppProblem(413, 'FILE_TOO_LARGE', { params: { maxBytes } });
  return got!;
}
