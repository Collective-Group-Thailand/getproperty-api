import { ComplianceScoreService } from '@core/compliance/compliance-score.service';
import { Injectable, type OnModuleInit } from '@nestjs/common';

/**
 * The invoice components of the monthly compliance score (B4.1.3, ADR-0007): invoices issued in the month with no
 * line above the utility cap ("within rate"), and above-cap lines that carry the owner's acknowledgement (D-021a).
 * Void invoices still count — they were issued.
 */
@Injectable()
export class InvoiceScoreSource implements OnModuleInit {
  constructor(private readonly score: ComplianceScoreService) {}

  onModuleInit(): void {
    this.score.registerSource(async (tx, tenantId, w) => {
      const issued = { tenantId, issuedAt: { gte: w.start, lt: w.end } };
      const [invoicesTotal, invoicesAboveCap, linesAboveCap, linesAboveCapAcknowledged] = await Promise.all([
        tx.invoice.count({ where: issued }),
        tx.invoice.count({ where: { ...issued, lines: { some: { aboveCap: true } } } }),
        tx.invoiceLine.count({ where: { tenantId, aboveCap: true, invoice: issued } }),
        tx.invoiceLine.count({
          where: { tenantId, aboveCap: true, complianceAcknowledgementId: { not: null }, invoice: issued },
        }),
      ]);
      return {
        invoicesTotal,
        invoicesWithinRate: invoicesTotal - invoicesAboveCap,
        linesAboveCap,
        linesAboveCapAcknowledged,
      };
    });
  }
}
