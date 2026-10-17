import { formatThb, thaiDate } from '@modules/ops-leases/thai-text';

import { type InvoiceView, type ReceiptView } from './document-views';

/**
 * LINE Flex Message builders (B4.3, D-011): invoice, receipt, payment reminder and deposit statement as bubbles; a
 * resident with several units gets a carousel (≤ 12 bubbles). Output follows the Messaging API Flex reference and is
 * checked by `validateFlexMessage` (tests). Buttons open the LIFF pages; the QR itself lives on the invoice page
 * (Flex images must be https URLs, never data URLs).
 */
export type FlexComponent = Record<string, unknown>;
export interface FlexBubble {
  type: 'bubble';
  size?: string;
  header?: FlexComponent;
  hero?: FlexComponent;
  body?: FlexComponent;
  footer?: FlexComponent;
  styles?: Record<string, unknown>;
}
export interface FlexCarousel {
  type: 'carousel';
  contents: FlexBubble[];
}
export interface FlexMessage {
  type: 'flex';
  altText: string;
  contents: FlexBubble | FlexCarousel;
}

export const BRAND = '#0B6E4F';
const MUTED = '#6B7280';
const WARN = '#B00000';
/** Messaging API limits used by the builders (and checked by the validator). */
export const FLEX_LIMITS = { altText: 1500, carouselBubbles: 12, buttonLabel: 40, uri: 1000 } as const;

const text = (t: string, extra: Record<string, unknown> = {}): FlexComponent => ({
  type: 'text',
  text: t.length ? t : ' ',
  wrap: true,
  ...extra,
});
const row = (label: string, value: string, extra: Record<string, unknown> = {}): FlexComponent => ({
  type: 'box',
  layout: 'horizontal',
  contents: [
    text(label, { size: 'sm', color: MUTED, flex: 3 }),
    text(value, { size: 'sm', align: 'end', flex: 4, ...extra }),
  ],
});
const sep = (): FlexComponent => ({ type: 'separator', margin: 'md' });
const button = (
  label: string,
  uri: string,
  style: 'primary' | 'secondary' | 'link' = 'primary',
): FlexComponent => ({
  type: 'button',
  style,
  height: 'sm',
  ...(style === 'primary' ? { color: BRAND } : {}),
  action: { type: 'uri', label: label.slice(0, FLEX_LIMITS.buttonLabel), uri: uri.slice(0, FLEX_LIMITS.uri) },
});
const baht = (v: string) => `${formatThb(v)} บาท`;

function header(title: string, subtitle: string): FlexComponent {
  return {
    type: 'box',
    layout: 'vertical',
    backgroundColor: BRAND,
    paddingAll: 'lg',
    contents: [
      text(title, { color: '#FFFFFF', weight: 'bold', size: 'lg' }),
      text(subtitle, { color: '#FFFFFF', size: 'xs' }),
    ],
  };
}

/** One invoice: lines (meter lines with registers and source), total, prior balance, due date, open/pay button. */
export function invoiceBubble(v: InvoiceView): FlexBubble {
  const lines = v.lines.flatMap((l) => {
    const out: FlexComponent[] = [row(l.description, formatThb(l.amount))];
    if (l.meter)
      out.push(
        text(
          `${l.meter.segments.map((s) => `${s.from} → ${s.to ?? '-'} (${s.toSource ?? '-'})`).join(', ')} = ${l.meter.units ?? '-'} × ${l.unitPrice ?? '-'}${l.meter.estimated ? ' · ประมาณการ' : ''}`,
          { size: 'xxs', color: l.meter.aboveCap ? WARN : MUTED },
        ),
      );
    return out;
  });
  return {
    type: 'bubble',
    size: 'mega',
    header: header(v.title, `${v.issuer.displayName} · ห้อง ${v.unitNo ?? '-'}`),
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        row('เลขที่', v.number),
        row('รอบบิล', `${thaiDate(v.period.start)} – ${thaiDate(v.period.end)}`),
        sep(),
        ...lines,
        sep(),
        row('รวม', baht(v.total), { weight: 'bold' }),
        ...(v.hasPrior ? [row('ค้างชำระยกมา', baht(v.priorBalance))] : []),
        row('ยอดที่ต้องชำระ', baht(v.amountDue), { weight: 'bold', color: BRAND }),
        row('ครบกำหนด', thaiDate(v.dueOn), { weight: 'bold' }),
        ...(v.hasEstimate
          ? [text('มีรายการประมาณการ จะปรับตามเลขมิเตอร์จริงในรอบถัดไป', { size: 'xxs', color: MUTED })]
          : []),
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [button('ดูใบแจ้งหนี้และชำระด้วย QR', v.link)],
    },
  };
}

/** A receipt (B4.4): what was paid, against which invoices, by what method. */
export function receiptBubble(v: ReceiptView): FlexBubble {
  return {
    type: 'bubble',
    size: 'kilo',
    header: header(v.title, v.issuer.displayName),
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        row('เลขที่', v.number),
        row('วันที่', thaiDate(v.issuedOn)),
        sep(),
        ...v.items.map((i) => row(i.reference ?? i.description, formatThb(i.amount))),
        sep(),
        row('รับชำระ', baht(v.total), { weight: 'bold', color: BRAND }),
        row('ชำระโดย', v.method),
      ],
    },
    footer: { type: 'box', layout: 'vertical', contents: [button('ดูใบเสร็จ', v.link, 'secondary')] },
  };
}

export interface ReminderItem {
  number: string;
  unitNo: string | null;
  issuerName: string;
  balance: string;
  dueOn: string;
  daysOverdue: number;
  link: string;
}

/** A payment reminder for one overdue invoice (D-045 light dunning: no threats, no penalties unless agreed). */
export function reminderBubble(r: ReminderItem): FlexBubble {
  return {
    type: 'bubble',
    size: 'kilo',
    header: header('แจ้งเตือนการชำระเงิน', `${r.issuerName} · ห้อง ${r.unitNo ?? '-'}`),
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        row('ใบแจ้งหนี้', r.number),
        row('ยอดค้างชำระ', baht(r.balance), { weight: 'bold', color: BRAND }),
        row('ครบกำหนด', thaiDate(r.dueOn)),
        row('เลยกำหนด', `${r.daysOverdue} วัน`),
        text('หากชำระแล้ว ขออภัยและขอบคุณค่ะ', { size: 'xxs', color: MUTED }),
      ],
    },
    footer: { type: 'box', layout: 'vertical', contents: [button('ชำระด้วย QR', r.link)] },
  };
}

export interface DepositStatementItem {
  number: string | null;
  unitNo: string;
  issuerName: string;
  depositHeld: string;
  deductionsTotal: string;
  utilitiesFinal: string;
  advanceRentUnused: string;
  refund: string;
  deadlineOn: string;
  link: string;
}

/** The deposit settlement statement (D-023): held, deductions, final utilities, unused advance rent, refund. */
export function depositStatementBubble(d: DepositStatementItem): FlexBubble {
  return {
    type: 'bubble',
    size: 'kilo',
    header: header('รายการคืนเงินประกัน', `${d.issuerName} · ห้อง ${d.unitNo}`),
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        ...(d.number ? [row('เลขที่', d.number)] : []),
        row('เงินประกัน', baht(d.depositHeld)),
        row('รายการหัก', baht(d.deductionsTotal)),
        row('ค่าสาธารณูปโภคงวดสุดท้าย', baht(d.utilitiesFinal)),
        ...(Number(d.advanceRentUnused) > 0 ? [row('คืนค่าเช่าล่วงหน้า', baht(d.advanceRentUnused))] : []),
        sep(),
        row('คืนเงิน', baht(d.refund), { weight: 'bold', color: BRAND }),
        row('ภายในวันที่', thaiDate(d.deadlineOn)),
      ],
    },
    footer: { type: 'box', layout: 'vertical', contents: [button('ดูรายละเอียด', d.link, 'secondary')] },
  };
}

/** One bubble, or a carousel for several (a resident with several units); at most 12 bubbles. */
export function flexMessage(altText: string, bubbles: FlexBubble[]): FlexMessage {
  if (!bubbles.length) throw new RangeError('a Flex message needs at least one bubble');
  return {
    type: 'flex',
    altText: altText.slice(0, FLEX_LIMITS.altText),
    contents:
      bubbles.length === 1
        ? bubbles[0]!
        : { type: 'carousel', contents: bubbles.slice(0, FLEX_LIMITS.carouselBubbles) },
  };
}

export const invoiceAltText = (v: InvoiceView) =>
  `ใบแจ้งหนี้ ${v.number} ห้อง ${v.unitNo ?? '-'} ยอด ${formatThb(v.amountDue)} บาท ครบกำหนด ${thaiDate(v.dueOn)}`;
