import { GreetingUseCaseConcrete } from "../../use-cases/implementations/greeting.usecase";
import { GreetingControllerConcrete } from "../implementations/input/http/greeting.controller";
import { IGreetingRepository } from "../../use-cases/interface/output/IGreetingRepo";

export class GreetingInject {
  private repo: IGreetingRepository | null = null;
  private useCase: GreetingUseCaseConcrete | null = null;
  private ctl: GreetingControllerConcrete | null = null;

  getRepo(): IGreetingRepository {
    if (!this.repo) {
      this.repo = new GreetingRepositoryConcrete();
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
