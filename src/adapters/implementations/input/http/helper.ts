import { IncomingMessage } from "http";

export function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve(body ? (JSON.parse(body) as T) : ({} as T));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}
