import { ApiProperty } from '@nestjs/swagger';

export enum EnvironmentBadge {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

/** Build and environment information for the admin console header (`admin.system.info`). */
export class SystemInfoDto {
  @ApiProperty({ example: '0.1.0', description: 'API version (package.json)' })
  version!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '9fceb02d',
    description: 'Short git commit of the build, when known',
  })
  commit!: string | null;

  @ApiProperty({
    enum: EnvironmentBadge,
    enumName: 'EnvironmentBadge',
    example: EnvironmentBadge.Development,
  })
  environment!: EnvironmentBadge;

  @ApiProperty({ example: true, description: '`true` when data stores or integrations are in-memory fakes' })
  fakes!: boolean;

  @ApiProperty({
    format: 'date-time',
    example: '2026-11-01T00:15:00+07:00',
    description: 'Server time in Asia/Bangkok',
  })
  serverTime!: string;
}
