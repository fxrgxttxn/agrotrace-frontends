// Pure helpers shared by scripts/gen-aliases.mjs (the codegen CLI step of `pnpm gen`) and
// test/schema-freshness.test.ts (which re-derives the alias block and asserts it is unchanged).
import ts from 'typescript';

export const START_MARKER = '// >>> GENERATED SCHEMA ALIASES (pnpm gen) — do not edit by hand';
export const END_MARKER = '// <<< GENERATED SCHEMA ALIASES';

/**
 * Reads `interface components { schemas: { Foo: ...; Bar: ...; } }` out of an openapi-typescript
 * schema.d.ts source string and returns the top-level schema names, in file order.
 */
export function extractSchemaNames(schemaSource) {
  const sourceFile = ts.createSourceFile('schema.d.ts', schemaSource, ts.ScriptTarget.ES2022, true);

  let schemasLiteral;
  const visit = (node) => {
    if (schemasLiteral) return;
    if (ts.isInterfaceDeclaration(node) && node.name.text === 'components') {
      for (const member of node.members) {
        if (
          ts.isPropertySignature(member) &&
          ts.isIdentifier(member.name) &&
          member.name.text === 'schemas' &&
          member.type &&
          ts.isTypeLiteralNode(member.type)
        ) {
          schemasLiteral = member.type;
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (!schemasLiteral) {
    throw new Error('could not find `interface components { schemas: {...} }` in schema.d.ts');
  }

  const names = [];
  for (const member of schemasLiteral.members) {
    if (ts.isPropertySignature(member) && ts.isIdentifier(member.name)) {
      names.push(member.name.text);
    }
  }
  return names;
}

// R61 (minor): a handful of contract schema names collide with well-known JS/DOM globals — Date
// and Notification are real global identifiers (`Date`, `window.Notification`); Health is included
// per the controller's ruling even though it isn't. Aliasing these as `Api<Name>` means a consumer
// who does `import type { Date } from '@agrotrace/api-client'` never silently shadows the global
// `Date` in that file. Kept as an explicit, reviewable list rather than a runtime `typeof
// globalThis[name]` check, which would vary between Node (codegen time) and the browser (usage
// time) and so could not be deterministic.
const GLOBAL_SHADOW_NAMES = new Set(['Date', 'Notification', 'Health']);

function aliasName(schemaName) {
  return GLOBAL_SHADOW_NAMES.has(schemaName) ? `Api${schemaName}` : schemaName;
}

/** Renders the marker-delimited block of `export type X = Schemas['X'];` aliases (prefixed with
 * `Api` for names in {@link GLOBAL_SHADOW_NAMES}). */
export function renderAliasBlock(names) {
  const lines = names.map((name) => `export type ${aliasName(name)} = Schemas['${name}'];`);
  return [START_MARKER, ...lines, END_MARKER].join('\n');
}

/** Replaces the marker-delimited block inside an index.ts source string. Throws if markers are missing. */
export function spliceAliasBlock(indexSource, block) {
  const start = indexSource.indexOf(START_MARKER);
  const end = indexSource.indexOf(END_MARKER);
  if (start === -1 || end === -1 || end < start) {
    throw new Error('could not find alias markers in src/index.ts');
  }
  return indexSource.slice(0, start) + block + indexSource.slice(end + END_MARKER.length);
}
