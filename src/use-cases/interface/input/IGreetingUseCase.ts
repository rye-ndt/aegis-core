import { Greeting } from "../../../core/entities/Greeting";

/**
 * Primary Port - Greeting Use Case Interface
 *
 * This is a "driving" port that defines what the application can do.
 * Controllers (adapters) will use this interface to invoke business logic.
 */
export interface IGreetingUseCase {
  /**
   * Get the default greeting
   */
  getGreeting(): Promise<Greeting>;

  /**
   * Get a personalized greeting
   */
  getPersonalizedGreeting(name: string): Promise<Greeting>;
}
