import { type Readable } from 'node:stream';

export const VIRUS_SCAN = Symbol('VIRUS_SCAN');

export interface ScanResult {
  clean: boolean;
  /** Signature name when infected. */
  signature?: string;
}

export interface VirusScanPort {
  readonly mode: 'fake' | 'real';
  scan(stream: Readable): Promise<ScanResult>;
}
