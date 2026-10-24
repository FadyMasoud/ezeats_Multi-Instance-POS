import { DynamicModule, Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { POS_CONFIG, PosConfig } from './pos-config';
import { PosStore } from './pos-store';

@Module({})
export class FakePosModule {
  static forRoot(config: PosConfig): DynamicModule {
    return {
      module: FakePosModule,
      controllers: [OrdersController],
      providers: [{ provide: POS_CONFIG, useValue: config }, PosStore],
    };
  }
}
