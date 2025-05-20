import {Global, Module} from '@nestjs/common';
import {TencentCosController} from './tencent-cos.controller';
import {TencentCosService} from './tencent-cos.service';

@Global()
@Module({
  controllers: [TencentCosController],
  providers: [TencentCosService],
  exports: [TencentCosService],
})
export class TencentCosModule {}
