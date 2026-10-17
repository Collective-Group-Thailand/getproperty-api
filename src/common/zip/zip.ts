import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

/**
 * A minimal ZIP writer (PKWARE APPNOTE 6.3: local file headers, deflate or store, central directory, UTF-8 names —
 * general purpose bit 11) for the document archives (B4.3). Entries are small (PDFs), so the archive is built in
 * memory; no ZIP64 (≤ 65,535 entries, < 4 GiB). Timestamps are fixed (1980-01-01) so equal input gives equal bytes.
 */
export interface ZipEntry {
  name: string;
  data: Buffer;
}

export function zip(entries: ZipEntry[]): Buffer {
  if (entries.length > 0xffff) throw new RangeError('too many zip entries');
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const deflated = deflateRawSync(e.data);
    const stored = deflated.length >= e.data.length;
    const body = stored ? e.data : deflated;
    const method = stored ? 0 : 8;
    const crc = crc32(e.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** Reads back the entries of an archive written by `zip` (tests, archive checks). */
export function unzip(archive: Buffer): ZipEntry[] {
  const endAt = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endAt < 0) throw new RangeError('not a zip archive');
  const count = archive.readUInt16LE(endAt + 10);
  let p = archive.readUInt32LE(endAt + 16);
  const out: ZipEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    const method = archive.readUInt16LE(p + 10);
    const size = archive.readUInt32LE(p + 20);
    const nameLen = archive.readUInt16LE(p + 28);
    const extra = archive.readUInt16LE(p + 30);
    const comment = archive.readUInt16LE(p + 32);
    const localAt = archive.readUInt32LE(p + 42);
    const name = archive.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const localName = archive.readUInt16LE(localAt + 26);
    const localExtra = archive.readUInt16LE(localAt + 28);
    const start = localAt + 30 + localName + localExtra;
    const body = archive.subarray(start, start + size);
    out.push({ name, data: method === 8 ? inflateRawSync(body) : Buffer.from(body) });
    p += 46 + nameLen + extra + comment;
  }
  return out;
}
