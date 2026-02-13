import { IVectorDB } from "../../use-cases/interface/output/IVectorize";
import { ProcessControllerConcrete } from "../implementations/input/http/process.controller";
import { IProcessUserRequest } from "../../use-cases/interface/input/IStoreData";
import { ProcessUserRequest } from "../../use-cases/implementations/process.usecase";

export class ProcessInject {
  private repo: IVectorDB | null = null;
  private useCase: IProcessUserRequest | null = null;
  private ctl: ProcessControllerConcrete | null = null;

  getRepo(): IVectorDB {
    if (!this.repo) {
      this.repo = new ProcessRepoConcrete();
    }

    return this.repo;
  }

  getUseCase(): IProcessUserRequest {
    if (!this.useCase) {
      this.useCase = new ProcessUserRequest(this.getRepo());
    }

    return this.useCase;
  }

  getCtl(): ProcessControllerConcrete {
    if (!this.ctl) {
      this.ctl = new ProcessControllerConcrete(this.getUseCase());
    }

    return this.ctl;
  }
}
