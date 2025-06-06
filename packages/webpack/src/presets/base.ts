import { basename, normalize, resolve } from 'pathe'
// @ts-expect-error missing types
import TimeFixPlugin from 'time-fix-plugin'
import type { Configuration } from 'webpack'
import { logger } from '@nuxt/kit'
// @ts-expect-error missing types
import FriendlyErrorsWebpackPlugin from '@nuxt/friendly-errors-webpack-plugin'
import escapeRegExp from 'escape-string-regexp'
import { joinURL } from 'ufo'
import type { NuxtOptions } from '@nuxt/schema'
import { isTest } from 'std-env'
import { defu } from 'defu'
import type { WarningFilter } from '../plugins/warning-ignore'
import WarningIgnorePlugin from '../plugins/warning-ignore'
import type { WebpackConfigContext } from '../utils/config'
import { applyPresets, fileName } from '../utils/config'
import { RollupCompatDynamicImportPlugin } from '../plugins/rollup-compat-dynamic-import'

import { WebpackBarPlugin, builder, webpack } from '#builder'

export async function base (ctx: WebpackConfigContext) {
  await applyPresets(ctx, [
    baseAlias,
    baseConfig,
    basePlugins,
    baseResolve,
    baseTranspile,
  ])
}

function baseConfig (ctx: WebpackConfigContext) {
  ctx.config = defu({}, {
    name: ctx.name,
    entry: { app: [resolve(ctx.options.appDir, ctx.options.experimental.asyncEntry ? 'entry.async' : 'entry')] },
    module: { rules: [] },
    plugins: [],
    externals: [],
    optimization: {
      ...ctx.userConfig.optimization,
      minimizer: [],
    },
    experiments: {
      ...ctx.userConfig.experiments,
    },
    mode: ctx.isDev ? 'development' : 'production',
    cache: getCache(ctx),
    output: getOutput(ctx),
    stats: statsMap[ctx.nuxt.options.logLevel] ?? statsMap.info,
    ...ctx.config,
  } satisfies Configuration)
}

function basePlugins (ctx: WebpackConfigContext) {
  ctx.config.plugins ||= []

  // Add timefix-plugin before other plugins
  if (ctx.options.dev) {
    if (ctx.nuxt.options.builder !== '@nuxt/rspack-builder') {
      ctx.config.plugins.push(new TimeFixPlugin())
    }
  }

  // User plugins
  ctx.config.plugins.push(...(ctx.userConfig.plugins || []))

  // Ignore empty warnings
  if (ctx.nuxt.options.builder !== '@nuxt/rspack-builder') {
    ctx.config.plugins.push(new WarningIgnorePlugin(getWarningIgnoreFilter(ctx)))
  }

  // Provide env via DefinePlugin
  ctx.config.plugins.push(new webpack.DefinePlugin(getEnv(ctx)))

  // Friendly errors
  if (ctx.isServer || (ctx.isDev && ctx.userConfig.friendlyErrors)) {
    ctx.config.plugins.push(
      new FriendlyErrorsWebpackPlugin({
        clearConsole: false,
        reporter: 'consola',
        logLevel: 'ERROR', // TODO
      }),
    )
  }

  if (ctx.nuxt.options.webpack.profile) {
    // Webpackbar
    const colors = {
      client: 'green',
      server: 'orange',
      modern: 'blue',
    }
    ctx.config.plugins.push(new WebpackBarPlugin({
      name: ctx.name,
      color: colors[ctx.name as keyof typeof colors],
      reporters: ['stats'],
      // @ts-expect-error TODO: this is a valid option for Webpack.ProgressPlugin and needs to be declared for WebpackBar
      stats: !ctx.isDev,
      reporter: {
        reporter: {
          change: (_, { shortPath }) => {
            if (!ctx.isServer) {
              ctx.nuxt.callHook(`${builder}:change`, shortPath)
            }
          },
          done: (_, { stats }) => {
            if (stats.hasErrors()) {
              ctx.nuxt.callHook(`${builder}:error`)
            } else {
              logger.success(`Finished building ${stats.compilation.name ?? 'Nuxt app'}`)
            }
          },
          allDone: () => {
            ctx.nuxt.callHook(`${builder}:done`)
          },
          progress: ({ webpackbar }) => {
            ctx.nuxt.callHook(`${builder}:progress`, webpackbar.statesArray)
          },
        },
      },
    }))
  }

  // Emit explicit dynamic import statements for rollup compatibility
  if (ctx.isServer && !ctx.isDev) {
    ctx.config.plugins.push(new RollupCompatDynamicImportPlugin())
  }
}

function baseAlias (ctx: WebpackConfigContext) {
  ctx.alias = {
    '#app': ctx.options.appDir,
    [basename(ctx.nuxt.options.dir.assets)]: resolve(ctx.nuxt.options.srcDir, ctx.nuxt.options.dir.assets),
    ...ctx.options.alias,
    ...ctx.alias,
  }
  if (ctx.isClient) {
    ctx.alias['nitro/runtime'] = resolve(ctx.nuxt.options.buildDir, 'nitro.client.mjs')
    // TODO: remove in v5
    ctx.alias['#internal/nitro'] = resolve(ctx.nuxt.options.buildDir, 'nitro.client.mjs')
    ctx.alias['nitropack/runtime'] = resolve(ctx.nuxt.options.buildDir, 'nitro.client.mjs')
  }
}

function baseResolve (ctx: WebpackConfigContext) {
  // Prioritize nested node_modules in webpack search path (#2558)
  // TODO: this might be refactored as default modulesDir?
  const webpackModulesDir = ['node_modules'].concat(ctx.options.modulesDir)

  ctx.config.resolve = {
    extensions: ['.wasm', '.mjs', '.js', '.ts', '.json', '.vue', '.jsx', '.tsx'],
    alias: ctx.alias,
    modules: webpackModulesDir,
    fullySpecified: false,
    ...ctx.config.resolve,
  }

  ctx.config.resolveLoader = {
    modules: webpackModulesDir,
    ...ctx.config.resolveLoader,
  }
}

function baseTranspile (ctx: WebpackConfigContext) {
  const transpile = [
    /\.vue\.js/i, // include SFCs in node_modules
    /consola\/src/,
    /vue-demi/,
    /(^|\/)nuxt\/(src\/|dist\/)?(app|[^/]+\/runtime)($|\/)/,
  ]

  for (let pattern of ctx.options.build.transpile) {
    if (typeof pattern === 'function') {
      const result = pattern(ctx)
      if (result) { pattern = result }
    }
    if (typeof pattern === 'string') {
      transpile.push(new RegExp(escapeRegExp(normalize(pattern))))
    } else if (pattern instanceof RegExp) {
      transpile.push(pattern)
    }
  }

  // TODO: unique
  ctx.transpile = [...transpile, ...ctx.transpile]
}

function getCache (ctx: WebpackConfigContext): Configuration['cache'] {
  if (!ctx.options.dev) {
    return false
  }

  // TODO: Disable for nuxt internal dev due to inconsistencies
  // return {
  //   name: ctx.name,
  //   type: 'filesystem',
  //   cacheDirectory: resolve(ctx.options.rootDir, 'node_modules/.cache/webpack'),
  //   managedPaths: [
  //     ...ctx.options.modulesDir
  //   ],
  //   buildDependencies: {
  //     config: [
  //       ...ctx.options._nuxtConfigFiles
  //     ]
  //   }
  // }
}

function getOutput (ctx: WebpackConfigContext): Configuration['output'] {
  return {
    path: resolve(ctx.options.buildDir, 'dist', ctx.isServer ? 'server' : joinURL('client', ctx.options.app.buildAssetsDir)),
    filename: fileName(ctx, 'app'),
    chunkFilename: fileName(ctx, 'chunk'),
    publicPath: joinURL(ctx.options.app.baseURL, ctx.options.app.buildAssetsDir),
  }
}

function getWarningIgnoreFilter (ctx: WebpackConfigContext): WarningFilter {
  const filters: WarningFilter[] = [
    // Hide warnings about plugins without a default export (#1179)
    warn => warn.name === 'ModuleDependencyWarning' &&
      warn.message.includes('export \'default\'') &&
      warn.message.includes('nuxt_plugin_'),
    ...(ctx.userConfig.warningIgnoreFilters || []),
  ]

  return warn => !filters.some(ignoreFilter => ignoreFilter(warn))
}

function getEnv (ctx: WebpackConfigContext) {
  const _env: Record<string, string | boolean> = {
    'process.env.NODE_ENV': JSON.stringify(ctx.config.mode),
    '__NUXT_VERSION__': JSON.stringify(ctx.nuxt._version),
    '__NUXT_ASYNC_CONTEXT__': ctx.options.experimental.asyncContext,
    'process.env.VUE_ENV': JSON.stringify(ctx.name),
    'process.dev': ctx.options.dev,
    'process.test': isTest,
    'process.browser': ctx.isClient,
    'process.client': ctx.isClient,
    'process.server': ctx.isServer,
    'import.meta.dev': ctx.options.dev,
    'import.meta.test': isTest,
    'import.meta.browser': ctx.isClient,
    'import.meta.client': ctx.isClient,
    'import.meta.server': ctx.isServer,
  }

  if (ctx.userConfig.aggressiveCodeRemoval) {
    _env['typeof process'] = JSON.stringify(ctx.isServer ? 'object' : 'undefined')
    _env['typeof window'] = _env['typeof document'] = JSON.stringify(!ctx.isServer ? 'object' : 'undefined')
  }

  return _env
}

const statsMap: Record<NuxtOptions['logLevel'], Configuration['stats']> = {
  silent: 'none',
  info: 'normal',
  verbose: 'verbose',
}
