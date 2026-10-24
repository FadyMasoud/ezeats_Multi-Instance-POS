import swc from 'unplugin-swc';
import { defineWorkspace } from 'vitest/config';

// SWC (not esbuild) so NestJS decorator metadata is emitted and DI works inside tests.
const plugins = [swc.vite({ module: { type: 'es6' } })];

export default defineWorkspace([
  {
    plugins,
    test: {
      name: 'unit',
      include: ['apps/*/src/**/*.spec.ts'],
      environment: 'node',
    },
  },
  {
    plugins,
    test: {
      name: 'integration',
      include: ['tests/integration/**/*.int.spec.ts'],
      environment: 'node',
      globalSetup: ['tests/integration/global-setup.ts'],
      // All integration files share one real Postgres database, so they must run one at a time.
      // (`fileParallelism: false` is ignored inside a workspace project; a single fork is not.)
      pool: 'forks',
      poolOptions: { forks: { singleFork: true } },
      testTimeout: 60_000,
      hookTimeout: 60_000,
    },
  },
]);
