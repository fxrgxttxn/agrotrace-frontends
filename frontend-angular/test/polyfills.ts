import { ReadableStream, TransformStream, WritableStream } from 'node:stream/web';

// The Angular test transform runs MSW's interceptors inside the jsdom realm, which lacks the WHATWG stream globals Node
// itself has: give it Node's.
const g = globalThis as Record<string, unknown>;
g['TransformStream'] ??= TransformStream;
g['ReadableStream'] ??= ReadableStream;
g['WritableStream'] ??= WritableStream;
