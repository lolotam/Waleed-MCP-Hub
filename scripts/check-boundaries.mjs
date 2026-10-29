import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { builtinModules } from 'node:module';
import ts from 'typescript';

const builtins = new Set(
  builtinModules.flatMap((name) => [name, `node:${name}`]),
);
async function walk(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await walk(path)));
    else if (/\.[cm]?[jt]sx?$/.test(entry.name)) result.push(path);
  }
  return result;
}
const files = [
  ...(await walk('apps/web/src')),
  ...(await walk('packages/contracts/src')),
];
for (const file of files) {
  const source = await readFile(file, 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      checkImport(node.moduleSpecifier.text);
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      if (!node.arguments[0] || !ts.isStringLiteral(node.arguments[0]))
        throw new Error(`Nonliteral browser import: ${file}`);
      checkImport(node.arguments[0].text);
    }
    if (
      ts.isIdentifier(node) &&
      ['process', 'Buffer', 'require'].includes(node.text)
    )
      throw new Error(`Node global in browser-safe source: ${file}`);
    ts.forEachChild(node, visit);
  }
  function checkImport(name) {
    if (
      builtins.has(name) ||
      name.includes('hub-core') ||
      /(?:^|\/)server(?:\/|$)/.test(name)
    )
      throw new Error(
        `Backend import in browser-safe source: ${relative('.', file)} -> ${name}`,
      );
  }
  visit(ast);
}
console.info(`Browser boundary check passed (${files.length} source files).`);

// P4's private preview layer cannot grow an execution/network/persistence path
// accidentally. Future apply adapters belong outside this data-only module.
const importFiles = await walk('packages/hub-core/src/imports');
const allowedImports = new Set([
  'node:crypto',
  'node:path',
  'jsonc-parser',
  '@waleed/contracts',
  '../errors.js',
  './normalize.js',
]);
for (const file of importFiles) {
  const ast = ts.createSourceFile(
    file,
    await readFile(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      !allowedImports.has(node.moduleSpecifier.text)
    )
      throw new Error(
        `Effectful/unreviewed dependency in import preview: ${file}`,
      );
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    )
      throw new Error(`Dynamic dependency in import preview: ${file}`);
    if (
      ts.isIdentifier(node) &&
      ['process', 'fetch', 'require', 'eval', 'Function'].includes(node.text)
    )
      throw new Error(`Effectful global in import preview: ${file}`);
    ts.forEachChild(node, visit);
  }
  visit(ast);
}
console.info(
  `Data-only import boundary check passed (${importFiles.length} source files).`,
);
