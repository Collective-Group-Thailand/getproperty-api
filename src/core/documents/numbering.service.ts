import { bangkokDate } from '@common/time/bangkok';
import { type Tx } from '@database/prisma.service';
import { type DocumentType } from '@generated/prisma/client';
import { Injectable } from '@nestjs/common';

/** Prefixes of the per-tenant series (D-050); B4.3 makes them tenant settings. */
export const SERIES_PREFIX: Partial<Record<DocumentType, string>> = {
  contract: 'CTR',
  deposit_receipt: 'DPR',
  deposit_statement: 'DPS',
  inspection_report: 'INS',
  invoice: 'INV',
  receipt: 'RCP',
  tax_invoice: 'TIV',
  receipt_tax_invoice: 'RTI',
  credit_note: 'CRN',
  debit_note: 'DBN',
};

/**
 * Gapless document numbers (schema-design §4.4, D-050): inside the transaction that makes the document final, the
 * series row of (tenant, type, Bangkok calendar year) is created if missing, locked `FOR UPDATE`, read and bumped;
 * a rollback consumes nothing. Format `PREFIX-YYYY-00042`. Platform series (tenant NULL) are B6.1's.
 */
@Injectable()
export class DocumentNumbering {
  async next(tx: Tx, tenantId: string, docType: DocumentType, at: Date): Promise<string> {
    const year = Number(bangkokDate(at).slice(0, 4));
    const prefix = SERIES_PREFIX[docType] ?? docType.toUpperCase().slice(0, 3);
    await tx.$executeRaw`
      INSERT INTO ops.document_series (tenant_id, doc_type, fiscal_year, prefix, next_number)
      VALUES (${tenantId}::uuid, ${docType}::ops.document_type, ${year}, ${prefix}, 1)
      ON CONFLICT (tenant_id, doc_type, fiscal_year) DO NOTHING`;
    const rows = await tx.$queryRaw<{ id: string; next_number: number; prefix: string; width: number }[]>`
      SELECT id, next_number, prefix, width FROM ops.document_series
       WHERE tenant_id = ${tenantId}::uuid AND doc_type = ${docType}::ops.document_type AND fiscal_year = ${year}
       FOR UPDATE`;
    const series = rows[0];
    if (!series) throw new Error(`document series ${docType}/${year} missing for tenant ${tenantId}`);
    await tx.$executeRaw`UPDATE ops.document_series SET next_number = next_number + 1 WHERE id = ${series.id}::uuid`;
    return `${series.prefix}-${year}-${String(series.next_number).padStart(series.width, '0')}`;
  }
}
