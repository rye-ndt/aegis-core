import { GreetingUseCaseConcrete } from '../../use-cases/implementations/GreetingUseCase';
import { GreetingControllerConcrete } from '../implementations/input/http/GreetingCtl';
import { GreetingRepoConcrete } from '../implementations/output/GreetingRepo';

export class GreetingInject {
  private repo: GreetingRepoConcrete | null = null;
  private useCase: GreetingUseCaseConcrete | null = null;
  private ctl: GreetingControllerConcrete | null = null;

  getRepo(): GreetingRepoConcrete {
    if (!this.repo) {
      this.repo = new GreetingRepoConcrete();
    }

    return this.repo;
  }

  getUseCase(): GreetingUseCaseConcrete {
    if (!this.useCase) {
      this.useCase = new GreetingUseCaseConcrete(this.getRepo());
    }

    return this.useCase;
  }

  getCtl(): GreetingControllerConcrete {
    if (!this.ctl) {
      this.ctl = new GreetingControllerConcrete(this.getUseCase());
    }

    return this.ctl;
  }
}
