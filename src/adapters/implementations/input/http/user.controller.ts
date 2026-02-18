import { IncomingMessage, ServerResponse } from "http";
import {
  ILoginUserRequest,
  IRegisterUserRequest,
  IVerifyEmailRequest,
} from "../../../../use-cases/interface/input/userHttp.interface";
import {
  ILoginUser,
  IRegisterUser,
  IUserUseCase,
} from "../../../../use-cases/interface/input/user.interface";
import { readJsonBody } from "./helper";

export class UserControllerConcrete {
  constructor(private readonly userUseCase: IUserUseCase) {}

  private getAccessToken(req: IncomingMessage): string {
    const authHeader = req.headers.authorization || req.headers.Authorization;
    if (typeof authHeader !== "string") return "";
    const [scheme, token] = authHeader.split(" ");
    if (scheme?.toLowerCase() !== "bearer" || !token) return "";
    return token;
  }

  async handleRegister(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await readJsonBody<IRegisterUserRequest>(req);

      const input: IRegisterUser = {
        fullName: body.fullName,
        userName: body.userName,
        password: body.password,
        dob: body.dob,
        email: body.email,
      };

      const user = await this.userUseCase.register(input);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(user));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal Server Error" }));
    }
  }

  async handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await readJsonBody<ILoginUserRequest>(req);

      const input: ILoginUser = {
        userName: body.userName,
        password: body.password,
      };

      const user = await this.userUseCase.login(input);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(user));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal Server Error" }));
    }
  }

  async handleLogout(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const accessToken = this.getAccessToken(req);
      await this.userUseCase.logout(accessToken);

      res.writeHead(204).end();
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal Server Error" }));
    }
  }

  async handleRefresh(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const refreshToken = this.getAccessToken(req);
      const user = await this.userUseCase.refresh(refreshToken);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(user));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal Server Error" }));
    }
  }

  async handleVerifyEmail(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      const bearerToken = this.getAccessToken(req);
      const body = await readJsonBody<IVerifyEmailRequest>(req);

      const user = await this.userUseCase.verifyEmail(bearerToken, body.code);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(user));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal Server Error" }));
    }
  }
}

