import { resolve } from 'node:path';
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { config as loadDotenv } from 'dotenv';
import { FakePosModule } from './app.module';
import { loadPosConfig } from './pos-config';

loadDotenv({ path: resolve(__dirname, '..', '..', '..', '.env') });

async function main(): Promise<void> {
  const config = loadPosConfig();
  const app = await NestFactory.create(FakePosModule.forRoot(config), {
    logger: ['error', 'warn', 'log'],
  });
  app.enableShutdownHooks();
  await app.listen(config.port);
  Logger.log(
    `fake POS listening on :${config.port} failures=${JSON.stringify(config.failures)}`,
    'FakePos',
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
