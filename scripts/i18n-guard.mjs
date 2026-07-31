import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '..')
const appPath = resolve(root, 'src/web/App.tsx')
const i18nPath = resolve(root, 'src/web/i18n.tsx')

function sourceFile(path) {
  return ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )
}

const i18nSource = sourceFile(i18nPath)
const messageKeys = new Set()
function collectMessageKeys(node) {
  if (
    ts.isVariableDeclaration(node)
    && ts.isIdentifier(node.name)
    && node.name.text === 'messageTable'
    && node.initializer
    && ts.isObjectLiteralExpression(node.initializer)
  ) {
    for (const property of node.initializer.properties) {
      if (
        ts.isPropertyAssignment(property)
        && (ts.isStringLiteral(property.name) || ts.isNoSubstitutionTemplateLiteral(property.name))
      ) {
        messageKeys.add(property.name.text)
      }
    }
  }
  ts.forEachChild(node, collectMessageKeys)
}
collectMessageKeys(i18nSource)

const translatablePropertyNames = new Set([
  'label',
  'shortLabel',
  'description',
  'detail',
  'actionLabel',
  'title',
  'subtitle',
  'eyebrow',
  'hint',
  'confirmLabel',
  'placeholder',
  'aria-label',
])
const intentionallyUniversal = new Set([
  'Web Gateway',
  'DeepSeek Web Gateway',
  'API base URL',
  'HttpOnly · SameSite Strict',
  'Chat2API Session Connector',
])
const missing = new Map()
const appSource = sourceFile(appPath)

function lineNumber(node) {
  return appSource.getLineAndCharacterOfPosition(node.getStart(appSource)).line + 1
}

function looksUserFacing(value) {
  return /[ÇĞİÖŞÜçğıöşü]/.test(value)
    || /[.!?]$/.test(value)
    || (/^[A-ZİÖÜÇĞŞ]/.test(value) && value.includes(' '))
}

function checkValue(node, rawValue) {
  const value = rawValue.replace(/\s+/g, ' ').trim()
  if (
    !value
    || !looksUserFacing(value)
    || messageKeys.has(value)
    || intentionallyUniversal.has(value)
  ) {
    return
  }
  missing.set(value, lineNumber(node))
}

function inspectApp(node) {
  if (ts.isJsxText(node)) checkValue(node, node.getText(appSource))
  if (ts.isStringLiteral(node)) {
    const parent = node.parent
    if (
      ts.isJsxAttribute(parent)
      && ts.isIdentifier(parent.name)
      && translatablePropertyNames.has(parent.name.text)
    ) {
      checkValue(node, node.text)
    } else if (ts.isPropertyAssignment(parent)) {
      const name = ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name)
        ? parent.name.text
        : ''
      if (translatablePropertyNames.has(name)) checkValue(node, node.text)
    } else if (ts.isConditionalExpression(parent) || ts.isReturnStatement(parent)) {
      checkValue(node, node.text)
    } else if (
      ts.isCallExpression(parent)
      && ts.isIdentifier(parent.expression)
      && ['setError', 'setNotice'].includes(parent.expression.text)
    ) {
      checkValue(node, node.text)
    }
  }
  ts.forEachChild(node, inspectApp)
}
inspectApp(appSource)

if (missing.size > 0) {
  for (const [message, line] of missing) {
    process.stderr.write(`- untranslated admin message at App.tsx:${line}: ${message}\n`)
  }
  process.exit(1)
}

process.stdout.write(`I18n guard passed with ${messageKeys.size} translated source messages.\n`)
