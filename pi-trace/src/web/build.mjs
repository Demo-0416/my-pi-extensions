/**
 * pi-trace 前端构建：host.tsx → dist/（ESM bundle + 懒加载 grammar chunks）。
 *
 * CSS Modules 插件（自写，~60 行）：
 *   .module.css → 类名加 `dsh-<file>-` 前缀，导出 proxy 对象，运行时注入 <style>
 *   普通 .css（katex）→ 原样注入
 * 不引入运行时 CSS-in-JS 依赖，bundle 自包含。
 */
import { build, context } from 'esbuild'
import { readFileSync, mkdirSync, rmSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const watch = process.argv.includes('--watch')

/** 保护 :global(...) 段，返回 [占位后 css, 还原函数]。 */
function protectGlobals(css) {
  const globals = []
  const protectedCss = css.replace(/:global\(([^)]+)\)/g, (_m, inner) => {
    globals.push(inner)
    return `\u0000${globals.length - 1}\u0000`
  })
  return [protectedCss, (text) => text.replace(/\u0000(\d+)\u0000/g, (_m, i) => globals[Number(i)])]
}

/** 类名选择器 → dsh-<file>-<class>；vendored CSS 无 content 点号/url，安全。 */
function scopeClasses(css, filebase) {
  const classes = new Set()
  const scoped = css.replace(/\.(-?[a-zA-Z_][a-zA-Z0-9_-]*)/g, (_m, name) => {
    classes.add(name)
    return `.dsh-${filebase}-${name}`
  })
  const map = Object.fromEntries(
    [...classes].map((c) => [c, `dsh-${filebase}-${c}`]),
  )
  return [scoped, map]
}

const injectStyle = (css, dataset) => `
if (typeof document !== 'undefined') {
  const style = document.createElement('style');
  style.dataset.piTraceCss = ${JSON.stringify(dataset)};
  style.textContent = ${JSON.stringify(css)};
  document.head.appendChild(style);
}
`

const cssModulesPlugin = {
  name: 'pi-trace-css-modules',
  setup(build) {
    build.onLoad({ filter: /\.css$/ }, (args) => {
      const source = readFileSync(args.path, 'utf8')
      if (!args.path.endsWith('.module.css')) {
        const js = `${injectStyle(source, basename(args.path))}\nexport default {};\n`
        return { contents: js, loader: 'js', resolveDir: dirname(args.path) }
      }
      const filebase = basename(args.path, '.module.css').replace(/[^a-zA-Z0-9_-]/g, '_')
      const [protectedCss, restore] = protectGlobals(source)
      const [scoped, map] = scopeClasses(protectedCss, filebase)
      const css = restore(scoped)
      const js = `const css = ${JSON.stringify(map)};\n${injectStyle(css, filebase)}\nexport default css;\n`
      return { contents: js, loader: 'js', resolveDir: dirname(args.path) }
    })
  },
}

const options = {
  absWorkingDir: here,
  entryPoints: [resolve(here, 'host.tsx')],
  outdir: resolve(here, 'dist'),
  bundle: true,
  format: 'esm',
  splitting: true,
  jsx: 'automatic',
  target: 'es2020',
  sourcemap: false,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [cssModulesPlugin],
}

// Drop obsolete hashed chunks from earlier builds before packaging.
if (!watch) rmSync(resolve(here, 'dist'), { recursive: true, force: true })
mkdirSync(resolve(here, 'dist'), { recursive: true })

if (watch) {
  const ctx = await context(options)
  await ctx.watch()
  console.log('pi-trace web: watching…')
} else {
  await build(options)
  console.log('pi-trace web: build done → dist/')
}
