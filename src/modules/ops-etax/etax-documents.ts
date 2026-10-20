import { type Tx } from '@database/prisma.service';

/**
 * The provider-signed PDFs of receipts / tax invoices (B6.2, D-215): subject id → signed PDF document id. Once a
 * document is signed, the signed PDF is the one a resident receives (the receipt row keeps our original, D-044).
 */
export async function signedPdfs(
  tx: Tx,
  subjectType: 'receipt' | 'tax_invoice',
  subjectIds: readonly string[],
): Promise<Map<string, string>> {
  if (!subjectIds.length) return new Map();
  const rows = await tx.etaxSubmission.findMany({
    where: {
      subjectType,
      subjectId: { in: [...subjectIds] },
      status: 'signed',
      signedPdfDocumentId: { not: null },
    },
    select: { subjectId: true, signedPdfDocumentId: true },
  });
  return new Map(rows.map((r) => [r.subjectId, r.signedPdfDocumentId!]));
}
