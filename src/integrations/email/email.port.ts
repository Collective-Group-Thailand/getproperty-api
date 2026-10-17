export const EMAIL = Symbol('EMAIL');

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface EmailPort {
  readonly mode: 'fake' | 'real';
  send(message: EmailMessage): Promise<{ providerMessageId: string }>;
}
