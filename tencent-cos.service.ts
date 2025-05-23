import {HttpException, HttpStatus, Injectable} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {PrismaService} from '@framework/prisma/prisma.service';
import {generateUuid} from '@framework/utilities/random.util';
import {extname} from 'path';
import * as COS from 'cos-nodejs-sdk-v5';

const COS_PATH = 'newbie-cos-path';

@Injectable()
export class TencentCosService {
  private readonly cos: COS;
  private readonly region: string;
  private readonly bucket: string;
  private readonly baseParams: COS.PutObjectParams;
  private readonly baseGetParams: COS.GetObjectParams;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService
  ) {
    this.region = this.config.getOrThrow<string>(
      'microservices.tencent-cos.region'
    );
    this.bucket = this.config.getOrThrow<string>(
      'microservices.tencent-cos.bucket'
    );

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
      Bucket: this.config.getOrThrow<string>(
        'microservices.tencent-cos.bucket'
      ),
      Region: this.region,
    };
    this.baseGetParams = {
      Key: COS_PATH,
      Bucket: this.config.getOrThrow<string>(
        'microservices.tencent-cos.bucket'
      ),
      Region: this.region,
    };
  }

  async createBucket(bucketName: string) {
    return await this.cos.putBucket({Bucket: bucketName, Region: this.region});
  }

  async deleteBucket(bucketName: string) {
    return await this.cos.deleteBucket({
      Bucket: bucketName,
      Region: this.region,
    });
  }

  async getObject(key: string) {
    return await this.cos.getObject({
      Bucket: this.bucket,
      Region: this.region,
      Key: key,
    });
  }

  async putObject(params: {key: string; body: Buffer | string}) {
    return await this.cos.putObject({
      Bucket: this.bucket,
      Region: this.region,
      Key: params.key,
      Body: params.body,
    });
  }

  async createFolder(params: {
    bucket?: string;
    name: string;
    parentId?: string;
  }) {
    let key = params.name;
    if (params.parentId) {
      key = (await this.getFilePathString(params.parentId)) + '/' + params.name;
    }

    const output = await this.cos.putObject({
      Bucket: params.bucket ?? this.bucket,
      Region: this.region,
      Key: key + '/',
      Body: '',
    });

    return await this.prisma.cosFile.create({
      data: {
        name: params.name,
        type: 'Folder',
        cosBucket: params.bucket ?? this.bucket,
        cosKey: key,
        cosResponse: output as object,
        parentId: params.parentId,
      },
    });
  }

  async uploadFile(params: {
    file: Express.Multer.File;
    bucket?: string;
    parentId?: string;
    path?: string;
  }) {
    // [step 1] Generate key.
    let cosKey: string;
    if (params.parentId) {
      cosKey =
        (await this.getFilePathString(params.parentId)) +
        `/${generateUuid()}${extname(params.file.originalname)}`;
    } else if (params.path) {
      cosKey = `${params.path}/${generateUuid()}${extname(params.file.originalname)}`;
    } else {
      cosKey = `${generateUuid()}${extname(params.file.originalname)}`;
    }

    // [step 2] Put file to AWS S3.
    const output = await this.cos.putObject({
      Bucket: params.bucket ?? this.bucket,
      Region: this.region,
      Key: cosKey,
      Body: params.file.buffer,
    });
    if (output.statusCode !== 200) {
      throw new HttpException('Upload Failed', HttpStatus.BAD_REQUEST);
    }

    // [step 3] Create a record.
    await this.prisma.cosFile.create({
      data: {
        name: params.file.originalname,
        type: params.file.mimetype,
        size: params.file.size,
        cosBucket: params.bucket ?? this.bucket,
        cosKey: cosKey,
        cosResponse: output as object,
        parentId: params.parentId,
      },
    });

    return {url: output.Location};
  }

  async deleteFile(fileId: string) {
    const file = await this.prisma.cosFile.findFirstOrThrow({
      where: {id: fileId},
    });

    try {
      await this.cos.deleteObject({
        Bucket: file.cosBucket,
        Region: this.region,
        Key: file.cosKey,
      });
      await this.deleteFileInDatabaseRecursively(fileId);
    } catch (error) {
      // TODO (developer) - Handle exception
      throw error;
    }
  }

  async deleteFolder(fileId: string) {
    const file = await this.prisma.cosFile.findFirstOrThrow({
      where: {id: fileId},
    });

    try {
      await this.deleteFolderInCosRecursively({
        bucket: file.cosBucket,
        key: file.cosKey,
      });
      await this.deleteFileInDatabaseRecursively(fileId);
    } catch (error) {
      // TODO (developer) - Handle exception
      throw error;
    }
  }

  /** Get a signed URL to access an S3 object for signedUrlExpiresIn seconds */
  async getSignedDownloadUrl(params: {bucket?: string; key: string}) {
    return new Promise((resolve, reject) => {
      this.cos.getObjectUrl(
        {
          Bucket: params.bucket ?? this.bucket,
          Region: this.region,
          Key: params.key,
          Sign: true,
          Expires: 3600,
        },
        (err, data) => {
          if (err) {
            reject(
              new HttpException(
                'Get Signed Download URL Failed',
                HttpStatus.BAD_REQUEST
              )
            );
          }
          resolve({url: data.Url});
        }
      );
    });
  }

  async getFilePath(fileId: string) {
    const path: object[] = [];

    // [step 1] Get current file.
    const file = await this.prisma.s3File.findFirstOrThrow({
      where: {id: fileId},
      select: {id: true, name: true, type: true, parentId: true},
    });
    path.push(file);

    // [step 2] Get parent file.
    if (file.parentId) {
      path.push(...(await this.getFilePath(file.parentId)));
    } else {
      // Do nothing.
    }

    return path;
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

  /**
   * Remove directories and their contents recursively
   */
  private async deleteFolderInCosRecursively(params: {
    bucket: string;
    key: string;
  }) {
    try {
      // [step 1] List objects
      const listResponse = await this.cos.getBucket({
        Bucket: params.bucket,
        Region: this.region,
        Prefix: params.key + '',
      });
      if (!listResponse.Contents || listResponse.Contents.length === 0) {
        return;
      }

      // [step 2] Delete objects
      const deleteResponse = await this.cos.deleteMultipleObject({
        Bucket: params.bucket,
        Region: this.region,
        Objects: listResponse.Contents.map(content => {
          return {Key: content.Key};
        }),
      });
      if (deleteResponse.statusCode !== 200) {
        throw new HttpException('Delete Folder Failed', HttpStatus.BAD_REQUEST);
      } else {
        if (listResponse.IsTruncated) {
          await this.deleteFolderInCosRecursively(params);
        }
      }
    } catch (error) {
      // TODO (developer) - Handle exception
      throw error;
    }
  }

  /**
   * Remove directories and their contents recursively
   */
  private async deleteFileInDatabaseRecursively(fileId: string) {
    // [step 1] Delete file.
    await this.prisma.cosFile.delete({where: {id: fileId}});

    // [step 2] Delete files in the folder.
    const filesInFolder = await this.prisma.cosFile.findMany({
      where: {parentId: fileId},
      select: {id: true},
    });

    for (let i = 0; i < filesInFolder.length; i++) {
      await this.deleteFileInDatabaseRecursively(filesInFolder[i].id);
    }
  }

  private async getFilePathString(fileId: string) {
    let path = '';

    // [step 1] Get current file.
    const file = await this.prisma.s3File.findFirstOrThrow({
      where: {id: fileId},
      select: {id: true, name: true, type: true, parentId: true},
    });
    path = file.name;

    // [step 2] Get parent file.
    if (file.parentId) {
      path = (await this.getFilePathString(file.parentId)) + '/' + path;
    } else {
      // Do nothing.
    }

    return path;
  }
}
