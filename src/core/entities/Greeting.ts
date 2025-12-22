/**
 * Greeting Entity - Core Domain Object
 * 
 * This is a pure domain entity with no external dependencies.
 * It represents the core business concept of a greeting.
 */
export class Greeting {
  private readonly message: string;
  private readonly createdAt: Date;

  constructor(message: string) {
    this.message = message;
    this.createdAt = new Date();
  }

  getMessage(): string {
    return this.message;
  }

  getCreatedAt(): Date {
    return this.createdAt;
  }

  toJSON(): { message: string; createdAt: string } {
    return {
      message: this.message,
      createdAt: this.createdAt.toISOString(),
    };
  }
}
