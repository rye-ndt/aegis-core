export class MissingFieldsError extends Error {
  constructor(
    public readonly missingFields: string[],
    public readonly prompt: string,
  ) {
    super(prompt);
    this.name = 'MissingFieldsError';
  }
}

export class InvalidFieldError extends Error {
  constructor(
    public readonly field: string,
    public readonly prompt: string,
  ) {
    super(prompt);
    this.name = 'InvalidFieldError';
  }
}

export class ConversationLimitError extends Error {
  constructor() {
    super(
      "I wasn't able to collect all the required information after 10 messages. " +
        'Please start over with a complete request, e.g. "Swap 100 USDC for AVAX" or "Send 5 RON to 0xabc...".',
    );
    this.name = 'ConversationLimitError';
  }
}
