import ts from 'typescript';

export const START_MARKER = '// >>> GENERATED SCHEMA ALIASES (pnpm gen) — do not edit by hand';
export const END_MARKER = '// <<< GENERATED SCHEMA ALIASES';

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

const GLOBAL_SHADOW_NAMES = new Set(['Date', 'Notification', 'Health']);

function aliasName(schemaName) {
  return GLOBAL_SHADOW_NAMES.has(schemaName) ? `Api${schemaName}` : schemaName;
}

export function renderAliasBlock(names) {
  const lines = names.map((name) => `export type ${aliasName(name)} = Schemas['${name}'];`);
  return [START_MARKER, ...lines, END_MARKER].join('\n');
}

export function spliceAliasBlock(indexSource, block) {
  const start = indexSource.indexOf(START_MARKER);
  const end = indexSource.indexOf(END_MARKER);
  if (start === -1 || end === -1 || end < start) {
    throw new Error('could not find alias markers in src/index.ts');
  }
  return indexSource.slice(0, start) + block + indexSource.slice(end + END_MARKER.length);
}
