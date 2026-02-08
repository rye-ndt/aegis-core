import { Greeting } from '../../../core/entities/Greeting';

/**
 * Secondary Port - Greeting Repository Interface
 *
 * This is a "driven" port that defines what the application needs.
 * Infrastructure adapters will implement this interface.
 */
export interface IGreetingRepository {
  /**
   * Get the default greeting template
   */
  getDefaultGreeting(): Promise<Greeting>;

  /**
   * Get a greeting template by name
   */
  getGreetingByName(name: string): Promise<Greeting>;
}
