import { Greeting } from '../../core/entities/Greeting';
import { IGreetingUseCase } from '../interface/input/IGreetingUseCase';
import { IGreetingRepository } from '../interface/output/IGreetingRepo';

/**
 * Greeting Use Case Implementation
 * 
 * This class implements the business logic for greeting operations.
 * It depends on abstractions (ports) rather than concrete implementations.
 */
export class GreetingUseCaseConcrete implements IGreetingUseCase {
  constructor(private readonly greetingRepository: IGreetingRepository) { }

  async getGreeting(): Promise<Greeting> {
    return this.greetingRepository.getDefaultGreeting();
  }

  async getPersonalizedGreeting(name: string): Promise<Greeting> {
    return this.greetingRepository.getGreetingByName(name);
  }
}
