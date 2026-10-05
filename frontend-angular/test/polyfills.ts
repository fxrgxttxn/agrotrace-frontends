import { ReadableStream, TransformStream, WritableStream } from 'node:stream/web';

const g = globalThis as Record<string, unknown>;
g['TransformStream'] ??= TransformStream;
g['ReadableStream'] ??= ReadableStream;
g['WritableStream'] ??= WritableStream;
