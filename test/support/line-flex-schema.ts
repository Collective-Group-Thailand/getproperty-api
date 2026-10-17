import Ajv, { type ErrorObject } from 'ajv';

/**
 * JSON Schema of the LINE Flex Message (Messaging API reference, "Flex Message" — message object, containers
 * bubble/carousel, components box/text/span/button/image/icon/separator/filler, uri/postback/message actions),
 * transcribed for the properties the builders may use; unknown properties are refused so a typo fails the test.
 * Size limits: a bubble ≤ 30 KB, a carousel ≤ 50 KB and ≤ 12 bubbles, altText ≤ 1,500 characters, a button label
 * ≤ 40 characters, a uri ≤ 1,000 characters. // UNVERIFIED against live provider: LINE publishes no machine-readable
 * schema; this mirrors the reference pages (2026-10).
 */
const SIZE = {
  anyOf: [
    { enum: ['none', 'xs', 'sm', 'md', 'lg', 'xl', 'xxl'] },
    { type: 'string', pattern: '^\\d+(\\.\\d+)?px$' },
  ],
};
const TEXT_SIZE = {
  anyOf: [
    { enum: ['xxs', 'xs', 'sm', 'md', 'lg', 'xl', 'xxl', '3xl', '4xl', '5xl'] },
    { type: 'string', pattern: '^\\d+(\\.\\d+)?px$' },
  ],
};
const COLOR = { type: 'string', pattern: '^#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$' };
const FLEX = { type: 'integer', minimum: 0 };
const URI = { type: 'string', maxLength: 1000, pattern: '^(https?://|line://|tel:)' };

const ACTION = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'uri'],
      properties: {
        type: { const: 'uri' },
        label: { type: 'string', maxLength: 40 },
        uri: URI,
        altUri: { type: 'object', properties: { desktop: URI }, additionalProperties: false },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'data'],
      properties: {
        type: { const: 'postback' },
        label: { type: 'string', maxLength: 40 },
        data: { type: 'string', maxLength: 300 },
        displayText: { type: 'string', maxLength: 300 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'text'],
      properties: {
        type: { const: 'message' },
        label: { type: 'string', maxLength: 40 },
        text: { type: 'string', maxLength: 300 },
      },
    },
  ],
};

const COMMON = {
  flex: FLEX,
  margin: SIZE,
  position: { enum: ['relative', 'absolute'] },
  offsetTop: { type: 'string' },
  offsetBottom: { type: 'string' },
  offsetStart: { type: 'string' },
  offsetEnd: { type: 'string' },
  action: ACTION,
};

const schema = {
  $id: 'line-flex',
  definitions: {
    text: {
      type: 'object',
      additionalProperties: false,
      required: ['type'],
      properties: {
        type: { const: 'text' },
        text: { type: 'string', minLength: 1 },
        contents: { type: 'array', items: { $ref: '#/definitions/span' } },
        size: TEXT_SIZE,
        align: { enum: ['start', 'end', 'center'] },
        gravity: { enum: ['top', 'bottom', 'center'] },
        wrap: { type: 'boolean' },
        lineSpacing: { type: 'string' },
        maxLines: { type: 'integer', minimum: 0 },
        weight: { enum: ['regular', 'bold'] },
        color: COLOR,
        style: { enum: ['normal', 'italic'] },
        decoration: { enum: ['none', 'underline', 'line-through'] },
        adjustMode: { const: 'shrink-to-fit' },
        scaling: { type: 'boolean' },
        ...COMMON,
      },
    },
    span: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'text'],
      properties: {
        type: { const: 'span' },
        text: { type: 'string' },
        size: TEXT_SIZE,
        color: COLOR,
        weight: { enum: ['regular', 'bold'] },
        style: { enum: ['normal', 'italic'] },
        decoration: { enum: ['none', 'underline', 'line-through'] },
      },
    },
    separator: {
      type: 'object',
      additionalProperties: false,
      required: ['type'],
      properties: { type: { const: 'separator' }, margin: SIZE, color: COLOR },
    },
    filler: {
      type: 'object',
      additionalProperties: false,
      required: ['type'],
      properties: { type: { const: 'filler' }, flex: FLEX },
    },
    image: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'url'],
      properties: {
        type: { const: 'image' },
        url: { type: 'string', maxLength: 2000, pattern: '^https://' },
        size: { type: 'string' },
        aspectRatio: { type: 'string', pattern: '^\\d+:\\d+$' },
        aspectMode: { enum: ['fit', 'cover'] },
        backgroundColor: COLOR,
        align: { enum: ['start', 'end', 'center'] },
        gravity: { enum: ['top', 'bottom', 'center'] },
        animated: { type: 'boolean' },
        ...COMMON,
      },
    },
    button: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'action'],
      properties: {
        type: { const: 'button' },
        style: { enum: ['primary', 'secondary', 'link'] },
        color: COLOR,
        height: { enum: ['sm', 'md'] },
        gravity: { enum: ['top', 'bottom', 'center'] },
        adjustMode: { const: 'shrink-to-fit' },
        scaling: { type: 'boolean' },
        ...COMMON,
      },
    },
    box: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'layout', 'contents'],
      properties: {
        type: { const: 'box' },
        layout: { enum: ['horizontal', 'vertical', 'baseline'] },
        contents: { type: 'array', items: { $ref: '#/definitions/component' } },
        backgroundColor: COLOR,
        borderColor: COLOR,
        borderWidth: { type: 'string' },
        cornerRadius: { type: 'string' },
        width: { type: 'string' },
        maxWidth: { type: 'string' },
        height: { type: 'string' },
        maxHeight: { type: 'string' },
        spacing: SIZE,
        paddingAll: SIZE,
        paddingTop: SIZE,
        paddingBottom: SIZE,
        paddingStart: SIZE,
        paddingEnd: SIZE,
        justifyContent: {
          enum: ['flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly'],
        },
        alignItems: { enum: ['flex-start', 'center', 'flex-end'] },
        ...COMMON,
      },
    },
    component: {
      oneOf: [
        { $ref: '#/definitions/box' },
        { $ref: '#/definitions/text' },
        { $ref: '#/definitions/button' },
        { $ref: '#/definitions/image' },
        { $ref: '#/definitions/separator' },
        { $ref: '#/definitions/filler' },
      ],
    },
    bubble: {
      type: 'object',
      additionalProperties: false,
      required: ['type'],
      properties: {
        type: { const: 'bubble' },
        size: { enum: ['nano', 'micro', 'deca', 'hecto', 'kilo', 'mega', 'giga'] },
        direction: { enum: ['ltr', 'rtl'] },
        header: { $ref: '#/definitions/box' },
        hero: { oneOf: [{ $ref: '#/definitions/box' }, { $ref: '#/definitions/image' }] },
        body: { $ref: '#/definitions/box' },
        footer: { $ref: '#/definitions/box' },
        styles: { type: 'object' },
        action: ACTION,
      },
    },
    carousel: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'contents'],
      properties: {
        type: { const: 'carousel' },
        contents: { type: 'array', minItems: 1, maxItems: 12, items: { $ref: '#/definitions/bubble' } },
      },
    },
  },
  type: 'object',
  additionalProperties: false,
  required: ['type', 'altText', 'contents'],
  properties: {
    type: { const: 'flex' },
    altText: { type: 'string', minLength: 1, maxLength: 1500 },
    contents: { oneOf: [{ $ref: '#/definitions/bubble' }, { $ref: '#/definitions/carousel' }] },
  },
};

const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

/** Errors of a Flex message against the schema and the size limits (empty = valid). */
export function validateFlexMessage(message: unknown): string[] {
  const errors: string[] = [];
  if (!validate(message))
    errors.push(...(validate.errors ?? []).map((e: ErrorObject) => `${e.instancePath} ${e.message ?? ''}`));
  const contents = (message as { contents?: { type?: string; contents?: unknown[] } }).contents;
  const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8');
  if (contents?.type === 'bubble' && size(contents) > 30 * 1024) errors.push('bubble larger than 30 KB');
  if (contents?.type === 'carousel') {
    if (size(contents) > 50 * 1024) errors.push('carousel larger than 50 KB');
    for (const b of contents.contents ?? []) if (size(b) > 30 * 1024) errors.push('bubble larger than 30 KB');
  }
  return errors;
}
