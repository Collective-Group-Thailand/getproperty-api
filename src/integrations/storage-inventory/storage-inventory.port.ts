import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { type FakeObjectStorage } from '@collective/integrations/storage';

export const STORAGE_INVENTORY = Symbol('STORAGE_INVENTORY');

export interface InventoryObject {
  /** getproperty's key (without `S3_KEY_PREFIX`). */
  key: string;
  sizeBytes: number;
}

/**
 * Lists what object storage really holds under a prefix (G1 nightly reconciliation, D-286). Separate from the shared
 * object-storage port (`@collective/integrations`), which has no listing: getproperty needs it only for this job.
 */
export interface StorageInventoryPort {
  list(prefix: string): AsyncIterable<InventoryObject>;
}

/** The in-memory stand-in: lists the fake object storage the rest of the app writes to. */
export class FakeStorageInventory implements StorageInventoryPort {
  constructor(private readonly storage: Pick<FakeObjectStorage, 'objects'>) {}

  async *list(prefix: string): AsyncIterable<InventoryObject> {
    for (const [key, value] of [...this.storage.objects.entries()].sort(([a], [b]) => a.localeCompare(b)))
      if (key.startsWith(prefix)) yield { key, sizeBytes: value.body.length };
    await Promise.resolve();
  }
}

/** S3 `ListObjectsV2` (1 000 keys per page) under the configured key prefix; needs `s3:ListBucket` on `t/*`. */
export class S3StorageInventory implements StorageInventoryPort {
  private readonly client: S3Client;

  constructor(
    private readonly options: {
      region: string;
      bucket: string;
      endpoint?: string;
      forcePathStyle: boolean;
      keyPrefix?: string;
    },
  ) {
    this.client = new S3Client({
      region: options.region,
      endpoint: options.endpoint,
      forcePathStyle: options.forcePathStyle,
      maxAttempts: 3,
    });
  }

  async *list(prefix: string): AsyncIterable<InventoryObject> {
    const keyPrefix = this.options.keyPrefix ?? '';
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.options.bucket,
          Prefix: `${keyPrefix}${prefix}`,
          ContinuationToken: token,
        }),
      );
      for (const o of page.Contents ?? [])
        if (o.Key) yield { key: o.Key.slice(keyPrefix.length), sizeBytes: Number(o.Size ?? 0) };
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }
}
