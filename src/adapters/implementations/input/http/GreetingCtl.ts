import { IncomingMessage, ServerResponse } from 'http';
import { IGreetingUseCase } from '../../../../use-cases/interface/input/IGreetingUseCase';

export class GreetingControllerConcrete {
  constructor(private readonly greetingUseCase: IGreetingUseCase) { }


  async handleGetGreeting(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const greeting = await this.greetingUseCase.getGreeting();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(greeting.toJSON()));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal Server Error' }));
    }
  }


  async handleGetPersonalizedGreeting(
    _req: IncomingMessage,
    res: ServerResponse,
    name: string
  ): Promise<void> {
    try {
      const greeting = await this.greetingUseCase.getPersonalizedGreeting(name);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(greeting.toJSON()));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal Server Error' }));
    }
  }
}
