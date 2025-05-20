import {
  Get,
  Post,
  Body,
  Query,
  Controller,
  UploadedFile,
  ParseFilePipe,
  UseInterceptors,
  MaxFileSizeValidator,
} from '@nestjs/common';
import {TencentCosService} from './tencent-cos.service';
import {Express} from 'express';
import {FileInterceptor} from '@nestjs/platform-express';
import {ApiTags, ApiBearerAuth, ApiBody} from '@nestjs/swagger';

@ApiTags('Cos')
@ApiBearerAuth()
@Controller('cos')
export class TencentCosController {
  constructor(private readonly cos: TencentCosService) {}

  @Post('')
  @ApiBody({
    description: "The 'file' is required in request body.",
    examples: {
      a: {
        summary: '1. Upload',
        value: {
          file: {},
        },
      },
    },
  })
  @UseInterceptors(FileInterceptor('file'))
  async uploadFile(
    @UploadedFile(
      new ParseFilePipe({
        validators: [new MaxFileSizeValidator({maxSize: 10 * 1024 * 1024})],
      })
    )
    file: Express.Multer.File
  ): Promise<any> {
    let key = '';
    const {mimetype, buffer, originalname} = file;
    const path = process.env.STORE_PATH as string;

    if (mimetype.includes('video')) {
      key = `${path}/video/${Date.now()}-${originalname}`;
    }
    if (mimetype.includes('audio')) {
      key = `${path}/audio/${Date.now()}-${originalname}`;
    }
    if (mimetype.includes('pdf')) {
      key = `${path}/pdf/${Date.now()}-${originalname}`;
    }
    if (
      mimetype.includes('png') ||
      mimetype.includes('jpg') ||
      mimetype.includes('jpeg')
    ) {
      key = `${path}/image/${Date.now()}-${originalname}`;
    }
    return await this.cos.create(buffer, key);
  }

  @Get('')
  async getFile(@Query('key') key: string) {
    return await this.cos.get(key);
  }

  @Post('preview')
  async getFilePreview(@Body() {key}: {key: string}) {
    return await this.cos.preview(key);
  }

  @Post('delete')
  async deleteFile(@Body() {key}: {key: string}): Promise<any> {
    return await this.cos.remove(key);
  }

  @Post('initMultipartUpload')
  async initMultipartUpload(@Body() body: {fileName: string}) {
    const path = process.env.STORE_PATH as string;
    const key = `${path}/large/${Date.now()}-${body.fileName}`;
    const {UploadId} = await this.cos.initMultipartUpload(key);

    return {
      key,
      uploadId: UploadId,
    };
  }

  @Post('uploadPart')
  @UseInterceptors(
    FileInterceptor('chunk', {
      limits: {fileSize: 1024 * 1024 * 10},
    })
  )
  async uploadPart(
    @UploadedFile()
    chunk: Express.Multer.File,
    @Body() body: {uploadId: string; key: string; partNumber: string}
  ) {
    const {key, uploadId, partNumber} = body;
    const {ETag} = await this.cos.uploadPart(
      key,
      uploadId,
      parseInt(partNumber),
      chunk.buffer
    );
    return {
      eTag: ETag,
      partNumber: partNumber,
    };
  }

  @Post('completeMultipartUpload')
  async completeMultipartUpload(
    @Body()
    body: {
      key: string;
      uploadId: string;
      parts: {PartNumber: number; ETag: string}[];
    }
  ) {
    const {key, uploadId, parts} = body;
    const {Location} = await this.cos.completeMultipartUpload(
      key,
      uploadId,
      parts
    );

    return {
      key,
      location: Location,
    };
  }

  /* End */
}
