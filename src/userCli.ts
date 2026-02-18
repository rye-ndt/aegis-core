import "dotenv/config";
import readline from "readline";
import { USER_CLI_COMMANDS } from "./helpers/enums/userCliCommands.enum";
import { UserInject } from "./adapters/inject/user.di";
import type { IUserUseCase } from "./use-cases/interface/input/user.interface";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer.trim()));
  });
}

function printMenu(): void {
  console.log("\n=== User CLI ===");
  console.log(`1) ${USER_CLI_COMMANDS.REGISTER}`);
  console.log(`2) ${USER_CLI_COMMANDS.LOGIN}`);
  console.log(`3) ${USER_CLI_COMMANDS.LOGOUT}`);
  console.log(`4) ${USER_CLI_COMMANDS.REFRESH}`);
  console.log(`5) ${USER_CLI_COMMANDS.VERIFY_EMAIL}`);
  console.log(`6) ${USER_CLI_COMMANDS.EXIT}`);
}

function selectCommand(choice: string): USER_CLI_COMMANDS | null {
  switch (choice) {
    case "1":
      return USER_CLI_COMMANDS.REGISTER;
    case "2":
      return USER_CLI_COMMANDS.LOGIN;
    case "3":
      return USER_CLI_COMMANDS.LOGOUT;
    case "4":
      return USER_CLI_COMMANDS.REFRESH;
    case "5":
      return USER_CLI_COMMANDS.VERIFY_EMAIL;
    case "6":
      return USER_CLI_COMMANDS.EXIT;
    default:
      return null;
  }
}

async function handleRegister(userUseCase: IUserUseCase): Promise<void> {
  const fullName = await question("fullName: ");
  const userName = await question("userName: ");
  const password = await question("password: ");
  const dobInput = await question("dob (number): ");
  const email = await question("email: ");

  const dob = Number(dobInput);

  const user = await userUseCase.register({
    fullName,
    userName,
    password,
    dob,
    email,
  });

  console.log("\nRegistered user:");
  console.log(JSON.stringify(user, null, 2));
}

async function handleLogin(userUseCase: IUserUseCase): Promise<void> {
  const userName = await question("userName: ");
  const password = await question("password: ");

  const user = await userUseCase.login({
    userName,
    password,
  });

  console.log("\nLogin result:");
  console.log(JSON.stringify(user, null, 2));
}

async function handleLogout(userUseCase: IUserUseCase): Promise<void> {
  const token = await question("accessToken (bearer): ");
  await userUseCase.logout(token);
  console.log("Logged out.");
}

async function handleRefresh(userUseCase: IUserUseCase): Promise<void> {
  const token = await question("refreshToken: ");
  const user = await userUseCase.refresh(token);

  console.log("\nRefreshed tokens:");
  console.log(JSON.stringify(user, null, 2));
}

async function handleVerifyEmail(userUseCase: IUserUseCase): Promise<void> {
  const bearer = await question("bearerToken: ");
  const code = await question("verification code: ");
  const user = await userUseCase.verifyEmail(bearer, code);

  console.log("\nVerified user:");
  console.log(JSON.stringify(user, null, 2));
}

async function main(): Promise<void> {
  const userInject = new UserInject();
  const userUseCase = userInject.getUseCase();

  console.log("User CLI started.");

  // eslint-disable-next-line no-constant-condition
  while (true) {
    printMenu();
    const choice = await question("Select command (1-6): ");
    const cmd = selectCommand(choice);

    if (!cmd) {
      console.log("Invalid choice.");
      continue;
    }

    if (cmd === USER_CLI_COMMANDS.EXIT) {
      break;
    }

    try {
      if (cmd === USER_CLI_COMMANDS.REGISTER) {
        await handleRegister(userUseCase);
      } else if (cmd === USER_CLI_COMMANDS.LOGIN) {
        await handleLogin(userUseCase);
      } else if (cmd === USER_CLI_COMMANDS.LOGOUT) {
        await handleLogout(userUseCase);
      } else if (cmd === USER_CLI_COMMANDS.REFRESH) {
        await handleRefresh(userUseCase);
      } else if (cmd === USER_CLI_COMMANDS.VERIFY_EMAIL) {
        await handleVerifyEmail(userUseCase);
      }
    } catch (err) {
      console.error("Command failed:", err);
    }
  }

  rl.close();
}

main().catch((err) => {
  console.error("Unexpected error in CLI:", err);
  rl.close();
  process.exit(1);
});

