import {HttpException, HttpStatus, Injectable} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import * as COS from 'cos-nodejs-sdk-v5';

const COS_BUCKET = 'newbie-cos-bucket-001';
const COS_PATH = 'newbie-cos-path';

@Injectable()
export class TencentCosService {
  private readonly cos: COS;
  private readonly baseParams: COS.PutObjectParams;
  private readonly baseGetParams: COS.GetObjectParams;

  constructor(private readonly config: ConfigService) {
    this.cos = new COS({
      SecretId: this.config.getOrThrow<string>(
        'microservices.tencent-cos.secretId'
      ),
      SecretKey: this.config.getOrThrow<string>(
        'microservices.tencent-cos.secretKey'
      ),
    });
    this.baseParams = {
      Body: Buffer.alloc(0),
      Key: COS_PATH,
      Bucket: COS_BUCKET,
      Region: this.config.getOrThrow<string>(
        'microservices.tencent-cos.region'
      ),
    };
    this.baseGetParams = {
      Key: COS_PATH,
      Bucket: COS_BUCKET,
      Region: this.config.getOrThrow<string>(
        'microservices.tencent-cos.region'
      ),
    };
  }

  async create(
    buffer: Buffer,
    key: string
  ): Promise<{url: string; key: string}> {
    const params = Object.assign(this.baseParams, {
      Body: buffer,
      Key: key,
    });

    try {
      const rsp = await this.cos.putObject(params);
      const {Location} = rsp;

      return {url: Location, key};
    } catch (error) {
      await this.remove(key);
      throw new HttpException('Upload File Failed', HttpStatus.BAD_REQUEST);
    }
  }

  async get(key: string) {
    const params = Object.assign(this.baseGetParams, {
      Key: key,
    });
    const res = await this.cos.getObject(params);

    return res;
  }

  async preview(key: string) {
    const params = Object.assign(this.baseGetParams, {
      Key: key,
      Sign: true,
      Expires: 3600,
    });

    return new Promise((resolve, reject) => {
      this.cos.getObjectUrl(params, (err, data) => {
        if (err) {
          reject(new HttpException('Preview Failed', HttpStatus.BAD_REQUEST));
        }
        resolve({url: data.Url});
      });
    });
  }

  async remove(key: string) {
    const params = Object.assign(this.baseParams, {
      Key: key,
    });
    const res = await this.cos.deleteObject(params);

    return res;
  }

  async initMultipartUpload(key: string) {
    const {Bucket, Region} = this.baseParams;

    return await this.cos.multipartInit({
      Bucket,
      Region,
      Key: key,
    });
  }

  async uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: Buffer
  ) {
    const {Bucket, Region} = this.baseParams;

    return await this.cos.multipartUpload({
      Bucket,
      Region,
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
      Body: body,
    });
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: {PartNumber: number; ETag: string}[]
  ) {
    const {Bucket, Region} = this.baseParams;

    return this.cos.multipartComplete({
      Bucket,
      Region,
      Key: key,
      Parts: parts,
      UploadId: uploadId,
    });
  }
}
