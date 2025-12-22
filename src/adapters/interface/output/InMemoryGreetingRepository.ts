import { Greeting } from '../../../core/entities/Greeting';
import { IGreetingRepository } from '../../../use-cases/interface/output/IGreetingRepository';


export class GreetingRepoConcrete implements IGreetingRepository {
  async getDefaultGreeting(): Promise<Greeting> {
    return new Greeting('Hello, World!');
  }

  async getGreetingByName(name: string): Promise<Greeting> {
    return new Greeting(`Hello, ${name}!`);
  }
}
