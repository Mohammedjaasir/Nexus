'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..', '..');
const RENDERER = path.join(ROOT, 'src', 'renderer', 'src');
const SHARED = path.join(ROOT, 'src', 'shared');
const ENTRY = path.join(RENDERER, 'main.tsx');
const ALIASES = [['@/', RENDERER], ['@shared/', SHARED]];          // '@brand/' is assets: not followed

const PERSONAS = ['Michael', 'Dwight', 'Jim', 'Pam', 'Ryan', 'Creed', 'Oscar', 'Kevin', 'Angela',
  'Stanley', 'Andy', 'Toby', 'Meredith', 'Phyllis', 'Kelly'];
// prose:true rules skip single-token literals (ids, keys, channels, paths): 'god', 'floor', 'hive:send'.
const RULES = [
  { rule: 'brand', prose: false, re: /munder|dunder|mifflin/i },
  { rule: 'persona', prose: false, re: new RegExp(`\\b(${PERSONAS.join('|')}|${PERSONAS.map((p) => p.toUpperCase()).join('|')})\\b`) },
  { rule: 'lead', prose: true, re: /\b(god|boss)\b|\byour clone\b|\bclone of you\b|\bclone nodes?\b|\bclone's\b/i },
  { rule: 'office', prose: true, re: /\b(office|floor|floors|hire|hires|hired|hive|cubicle|scranton)\b|command center|ask me board|pixel office/i }
];
const RETIRED = new Set(['components/SpritePortrait.tsx', 'components/OfficeThemePicker.tsx',
  'components/RealtimeMichaelToggle.tsx', 'components/MichaelBooting.tsx', 'components/AgentCard.tsx',
  'components/AgentStrip.tsx', 'scene/office/OfficeFloor.tsx']);
const COPY_ATTRS = new Set(['aria-label', 'title', 'placeholder', 'alt', 'aria-description', 'aria-placeholder']);
const IMAGE_RE = /\.(png|jpe?g|gif|svg|webp|ico)$/i;
const SKIP_ATTRS = new Set(['className', 'class', 'key', 'id', 'htmlFor', 'data-testid', 'role', 'type', 'name']);

function resolveImport(fromFile, spec) {
  let base = null;
  for (const [prefix, dir] of ALIASES) if (spec.startsWith(prefix)) base = path.join(dir, spec.slice(prefix.length));
  if (!base && spec.startsWith('.')) base = path.resolve(path.dirname(fromFile), spec);
  if (!base) return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (/\.tsx?$/.test(c) && fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}
function parse(file, text) {
  return ts.createSourceFile(file, text ?? fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}
function runtimeImports(sf) {
  const out = [];
  const visit = (n) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && !n.importClause?.isTypeOnly) out.push(n.moduleSpecifier.text);
    if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) && !n.isTypeOnly) out.push(n.moduleSpecifier.text);
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) out.push(n.arguments[0].text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
function reachableFrom(entries) {
  const seen = new Set();
  const stack = [...entries];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const spec of runtimeImports(parse(f))) {
      const r = resolveImport(f, spec);
      if (r && !seen.has(r)) stack.push(r);
    }
  }
  return seen;
}
function copyItems(file, text) {
  const out = [];
  const visit = (n) => {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n) || ts.isLiteralTypeNode(n)) return;
    if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(n.expression) && n.expression.text === 'require'))) return;
    if (ts.isJsxAttribute(n) && COPY_ATTRS.has(n.name.getText()) && n.initializer && ts.isStringLiteral(n.initializer)) { out.push({ text: n.initializer.text, copy: true }); return; }
    if (ts.isJsxAttribute(n) && SKIP_ATTRS.has(n.name.getText())) return;
    if (ts.isPropertyAssignment(n) && (ts.isStringLiteral(n.name))) { visit(n.initializer); return; }   // keys are not copy
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push({ text: n.text, copy: false });
    else if (ts.isTemplateExpression(n)) { out.push({ text: n.head.text, copy: false }); for (const s of n.templateSpans) out.push({ text: s.literal.text, copy: false }); }
    else if (ts.isJsxText(n)) { const t = n.text.replace(/\s+/g, ' ').trim(); if (t) out.push({ text: t, copy: true }); }
    ts.forEachChild(n, visit);
  };
  visit(parse(file, text));
  return out;
}
function copyStrings(file, text) { return copyItems(file, text).map((i) => i.text); }
function assetImports(file) {
  return runtimeImports(parse(file)).filter((spec) => spec.startsWith('@brand/') || IMAGE_RE.test(spec));
}
function scanText(s, isCopy) {
  const prose = isCopy === true || /\s/.test(s.trim());
  const hits = [];
  for (const r of RULES) {
    if (r.prose && !prose) continue;
    const m = s.match(r.re);
    if (m) hits.push({ rule: r.rule, match: m[0] });
  }
  return hits;
}
function relName(file, base) {
  if (base) return path.relative(base, file).split(path.sep).join('/');
  if (file.startsWith(SHARED)) return 'shared/' + path.relative(SHARED, file).split(path.sep).join('/');
  return path.relative(RENDERER, file).split(path.sep).join('/');
}
function scanFiles(files, base) {
  const leaks = [];
  for (const f of files) {
    const rel = relName(f, base);
    if (RETIRED.has(rel)) leaks.push({ file: rel, rule: 'visual', text: '<reachable>' });
    for (const spec of assetImports(f)) leaks.push({ file: rel, rule: 'visual', text: spec });
    for (const it of copyItems(f)) for (const h of scanText(it.text, it.copy)) leaks.push({ file: rel, rule: h.rule, text: it.text });
  }
  return leaks;
}
function applyAllowlist(leaks, allow) {
  return leaks.filter((l) => !allow.some((a) => a.file === l.file && a.rule === l.rule && (a.exact ? l.text === a.contains : l.text.includes(a.contains))));
}
function groupByFile(leaks) {
  const out = {};
  for (const l of leaks) (out[l.file] ??= []).push({ rule: l.rule, text: l.text.length > 160 ? l.text.slice(0, 160) : l.text });
  for (const k of Object.keys(out)) out[k].sort((a, b) => (a.rule + a.text).localeCompare(b.rule + b.text));
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}
function printReport() {
  const allow = require('../nexus-identity-leaks.json').allowlist;
  console.log(JSON.stringify(groupByFile(applyAllowlist(scanFiles(reachableFrom([ENTRY])), allow)), null, 2));
}
if (require.main === module) printReport();
module.exports = { ENTRY, RULES, assetImports, copyItems, reachableFrom, copyStrings, scanText, scanFiles, relName, applyAllowlist, groupByFile, printReport };
