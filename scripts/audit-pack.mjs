#!/usr/bin/env node
/**
 * audit-pack.mjs — npm 发布包内容审计（零依赖，可整体复制到其他套件插件仓库复用）。
 *
 * 动机：dsh 只加载 package.json 入口指向的构建产物（lib/*.js + esbuild 客户端 bundle +
 * cordis.patch.yml + presets/**）。files 白名单一旦漏项，包"装得上、跑不了"，而且只在
 * 运行时才爆。本脚本把这类残废包拦在 CI / 发布之前。
 *
 * 用法：
 *   node scripts/audit-pack.mjs                     # dry-run：审计 npm pack --dry-run 清单（CI 每次 PR 跑）
 *   node scripts/audit-pack.mjs <file.tgz>          # 审计真实 tarball（release 发布前跑）
 *   node scripts/audit-pack.mjs <file.tgz> --tag vX.Y.Z  # 额外校验 tag 与 package.json version 一致
 *
 * 规则 = 默认规则 + package.json `dsh.releaseAudit` 扩展：
 *   必含：main/exports 解析出的全部入口文件、dsh.bundle.patch 指向的文件、
 *         releaseAudit.require 列出的路径（"dir/" 结尾 = 该前缀下至少一个文件）；
 *   禁止：src|tests|test|__tests__|node_modules|.github|.git 目录、.ts/.tsx 源码
 *         （.d.ts 除外）、releaseAudit.forbid 里的正则。
 *
 * 复用到其他插件仓库：复制本文件到该仓库 scripts/ 下即可跑；包特有产物（如 dsh-twin
 * 的 presets/）在该仓库 package.json 的 dsh.releaseAudit.require 里声明。生命周期脚本
 * 一律 --ignore-scripts 跳过——build/test 由 workflow 显式步骤负责，不重复执行。
 *
 * @module scripts/audit-pack
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

// ---- 参数解析：第一个位置参数是 tarball（缺省 = dry-run），--tag <v> 可选 ----
let tarball
let tag
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--tag') tag = argv[++i]
  else if (tarball === undefined) tarball = argv[i]
}

// ---- 取发布文件清单 ----
function dryRunFiles() {
  // npm 在 Windows 上是 npm.cmd，须经 shell 调起；--dry-run 不落盘，--ignore-scripts 不触发生命周期
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'],
    { encoding: 'utf8', shell: process.platform === 'win32' })
  const parsed = JSON.parse(out)
  const info = Array.isArray(parsed) ? parsed[0] : parsed
  return (info.files ?? []).map((f) => f.path.replace(/^\.\//, ''))
}
function tarballFiles(path) {
  const out = execFileSync('tar', ['-tzf', path], { encoding: 'utf8' })
  // npm tarball 的根目录固定是 package/，剥掉才能与 package.json 的相对路径对齐
  return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    .filter((s) => !s.endsWith('/'))
    .map((s) => s.replace(/^package\//, ''))
    .filter((s) => s !== '')
}
const files = tarball ? tarballFiles(tarball) : dryRunFiles()
const fileSet = new Set(files)

// ---- 规则 ----
const problems = []
const FORBIDDEN_DIRS = new Set(['src', 'tests', 'test', '__tests__', 'node_modules', '.github', '.git'])

/** main + exports（含各 condition 分支）解析出的全部入口文件路径。 */
function entryFiles(man) {
  const found = new Set()
  if (typeof man.main === 'string') found.add(man.main)
  const walk = (node) => {
    if (typeof node === 'string') found.add(node)
    else if (node && typeof node === 'object') for (const v of Object.values(node)) walk(v)
  }
  if (man.exports) walk(man.exports)
  return [...found].map((p) => p.replace(/^\.\//, ''))
}

const required = entryFiles(pkg)
if (typeof pkg.dsh?.bundle?.patch === 'string') required.push(pkg.dsh.bundle.patch)
for (const req of pkg.dsh?.releaseAudit?.require ?? []) required.push(req)

for (const req of required) {
  const ok = req.endsWith('/') ? files.some((f) => f.startsWith(req)) : fileSet.has(req)
  if (!ok) problems.push(`缺少必含项：${req}`)
}

for (const f of files) {
  if (f.split('/').some((seg) => FORBIDDEN_DIRS.has(seg))) {
    problems.push(`包含禁止目录（发布包只该有构建产物与声明文件）：${f}`)
  } else if (f.endsWith('.tsx') || (f.endsWith('.ts') && !f.endsWith('.d.ts'))) {
    problems.push(`包含 TS 源码：${f}`)
  } else {
    for (const re of pkg.dsh?.releaseAudit?.forbid ?? []) {
      if (new RegExp(re).test(f)) { problems.push(`命中自定义禁止规则 /${re}/：${f}`); break }
    }
  }
}

if (tag !== undefined) {
  const expected = tag.replace(/^v/, '')
  if (pkg.version !== expected) {
    problems.push(`tag ${tag} 与 package.json version ${pkg.version} 不一致（先 bump 版本再打 tag）`)
  }
}

// ---- 报告（收集全部问题再一次性输出，退出码 1 = 不通过）----
const mode = tarball ? `tarball ${tarball}` : 'npm pack --dry-run'
if (problems.length > 0) {
  console.error(`[audit-pack] FAIL（${mode}，共 ${files.length} 个文件）`)
  for (const p of problems) console.error(`[audit-pack]   - ${p}`)
  process.exit(1)
}
console.log(`[audit-pack] PASS：${mode}，${files.length} 个文件，必含 ${required.length} 项与禁含规则全部满足`)
