import './load-env';
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { loadConfig } from './config';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = configureApp(await NestFactory.create(AppModule.forRoot(config)));
  await app.listen(config.port);
  Logger.log(`API ${config.instanceId} listening on :${config.port}`, 'Bootstrap');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
