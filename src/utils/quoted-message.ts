/** A quote reference that cannot be resolved to a stored WhatsApp message. */
export class QuotedMessageResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuotedMessageResolutionError";
  }
}
