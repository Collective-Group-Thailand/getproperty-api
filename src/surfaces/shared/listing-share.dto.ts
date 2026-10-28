import { ApiProperty } from '@nestjs/swagger';

import { ListingChannelName } from '../owner/leads.dto';

export class ShareKitLinkDto {
  @ApiProperty({ enum: ListingChannelName, enumName: 'ListingChannel', example: 'facebook_group' })
  channel!: ListingChannelName;

  @ApiProperty({
    example: 'https://app.getproperty.co/s/ab12cd34',
    description: 'The short link of this channel.',
  })
  url!: string;

  @ApiProperty({ type: 'integer', example: 37, description: 'Times the link was opened.' })
  clicks!: number;

  @ApiProperty({ type: 'integer', example: 3, description: 'Enquiries that came through this channel.' })
  enquiries!: number;

  @ApiProperty({ example: 'คอนโด 1 ห้องนอน ใกล้ BTS อารีย์\nค่าเช่า ฿15,000/เดือน · …' })
  captionTh!: string;

  @ApiProperty({ example: 'Sunny 1-bedroom condo near BTS Ari\nRent ฿15,000/month · …' })
  captionEn!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'https://line.me/R/share?text=…',
    description:
      'LINE only: opens LINE’s share picker with the Thai caption. Facebook is copy and download (D-268).',
  })
  shareUrl!: string | null;
}

export class ShareCardDto {
  @ApiProperty({ format: 'uuid', example: '0193f2a4-b1c2-7d3e-8f40-5a6b7c8d9e0f' })
  documentId!: string;

  @ApiProperty({
    example: 'https://storage.getproperty.test/…',
    description: 'Signed download link (10 minutes).',
  })
  url!: string;

  @ApiProperty({ type: 'integer', example: 1080 })
  width!: number;

  @ApiProperty({ type: 'integer', example: 1080 })
  height!: number;
}

export class ShareCardsDto {
  @ApiProperty({ type: ShareCardDto, description: 'Thai card (PNG).' })
  th!: ShareCardDto;

  @ApiProperty({ type: ShareCardDto, description: 'English card (PNG).' })
  en!: ShareCardDto;
}

export class ShareKitDto {
  @ApiProperty({ format: 'uuid', example: '0193f2a4-b1c2-7d3e-8f40-5a6b7c8d9e0a' })
  listingId!: string;

  @ApiProperty({ type: [ShareKitLinkDto], description: 'LINE, Facebook group, Marketplace, QR, plain link.' })
  links!: ShareKitLinkDto[];

  @ApiProperty({ type: ShareCardsDto })
  cards!: ShareCardsDto;

  @ApiProperty({
    type: [ShareCardDto],
    description:
      'G4 image bundle: the listing’s photos in order (1600 px WebP, signed 10 minutes) to download and post by hand in Facebook groups — groups are never automated (D-288).',
  })
  photos!: ShareCardDto[];
}

export class PublicShareUtmDto {
  @ApiProperty({ example: 'facebook_group' })
  source!: string;

  @ApiProperty({ example: 'share' })
  medium!: string;

  @ApiProperty({ example: 'listing' })
  campaign!: string;
}

export class PublicShareLinkDto {
  @ApiProperty({ example: 'condo-1br-0193f2a4b1', description: 'The listing to open (`/rent/{slug}`).' })
  slug!: string;

  @ApiProperty({ enum: ListingChannelName, enumName: 'ListingChannel', example: 'facebook_group' })
  channel!: ListingChannelName;

  @ApiProperty({ type: PublicShareUtmDto, description: 'Add to the listing URL as `utm_*`.' })
  utm!: PublicShareUtmDto;
}
